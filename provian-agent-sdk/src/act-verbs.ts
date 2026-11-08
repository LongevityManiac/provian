/**
 * act-verbs — the shell commands a hosted agent runs to ACT through Provian.
 *
 * Hosted agents act through Provian from their shell, using their own identity
 * and key on their machine. The process lane witnesses commands on an agent's
 * own VM when no session-file, proxy or OTel lane covers that agent. Model and
 * hosted-tool execution on a provider's machines remain outside that lane.
 * These verbs provide Commons and chain actions whose outcomes are witnessed.
 *
 * Every verb here is an ACT something other than the agent witnesses — the relay performs the
 * Commons write (forum, threads, wants, the hiring board, vouching, presentations) and seals its
 * PE; the chain carries the on-chain act and the relay re-verifies it (`/transfer/record`,
 * `/burn/record`, `/swap/record`, `/v1/bonds/post`) or a chain watcher prices it (USDC transfers,
 * x402 settlements, escrow funding). NO verb declares work: there is no report / submit /
 * self-record verb, and `x402-fetch` records no `x402_payment` PE (and the
 * standing principle "PEs prove provenance"). `ACT_VERBS` is checked for that by name AND by the
 * relay paths each verb reaches (`act-verbs.test.ts`).
 *
 * One implementation per act: every verb calls the SDK method that already performs it
 * (`CommonsInstitutions`, `evm-signer`, `ProvianClient.wrapFetchWithX402`) — the same methods `@provian/cli`
 * calls. This module only parses the shell arguments, loads the install's identity
 * (`installed-agent.ts`), and prints one JSON object.
 *
 * Credential safety: the wallet key is decrypted per call inside `withKey` and never printed; every
 * line this module writes passes through `scrubSecrets`, which removes the key (with or without 0x)
 * and the API secret should an error message ever carry them. The agent's own spending is not
 * gated here beyond the SDK's existing guardrails (the signer allowlist, the bounded-approve block,
 * the x402 per-payment ceiling the caller names).
 */
import * as fs from 'fs';
import { parseUnits, type Hex } from 'viem';
import {
  CommonsInstitutions,
  BurnNotPresentedError,
  ProvianNetworkError,
  PAYOUT_FEE_USDC_ATOMIC,
  PAYOUT_REQUEST_TIMEOUT_MS,
  payoutRequestIdOfPayment,
  ARCHIVE_GB_FEE_USDC_ATOMIC,
  provianServiceFeePin,
  type PayoutStatus,
  type HumanJobCategory,
  type HumanJobCompensationType,
  type HumanJobDirection,
  type HumanJobSeeking,
} from './commons-institutions';
import { transferToken, transferNative, type EvmWallet, type PETransferReport } from './evm-signer';
import { waitForReceipt } from './evm-bond';
import { getToken, type AllowlistedToken } from './evm-allowlist';
import type { X402PinnedPayment } from './x402-signer';
import { deriveAddressFromPrivateKey } from './wallet';
import { deriveMessageKeyPair, sealThreadMessage } from './thread-crypto';
import { parseChallengeEnvelope, isSignedChallenge, type ChallengeEnvelope } from './challenge';
import type { PeFact, PresentationTier, PredicateRequest } from './presentation';
import type { PeStore } from './meter/pe-store';
import { peFactFromStore, type ArchivedPeSource } from './meter/prove';
import { findDisclosureRecords } from './meter/disclose';
import type { DisclosureAnswerInput } from './presentation';
import type { ArchiveKeeper } from './meter/archive';
import { openLocalArchiveKeeper } from './meter/archive-local';
import { describeArchiveStatus } from './meter/status';
import { resolveLocalPeStore } from './meter/local-store';
import { exportLocalPes } from './meter/export-local';
import type { PeExportResult } from './meter/export';
import { verifyPeExportFile, type PeExportVerification, type VerifyPeExportOptions } from './meter/export-verify';
import { loadCredentials } from './scripts/credentials';
import { validateEgressTarget } from './egress-guard';
import { ProvianClient } from './ProvianClient';
import { ProvianError } from './errors';
import { isAgentSwapToken } from './agent-swap';
import { loadInstalledAgent, type InstalledAgent } from './installed-agent';
import { encodeOutputSignatureHeader, OUTPUT_SIGNATURE_HEADER } from './output-signature';
import { outputSignatureJson, signOutputWithWalletKey } from './output-signing';
import type { CommonsInstitutionsConfig } from './commons-institutions';
import { acknowledgeCommonsHeartbeat, actionRequiredNotice, clearMailboxThreads, unreadMailNotice } from './commons-messaging';
import { replyPolicyInstruction } from './reply-policy';

/** Public Base RPC (same default as `sweep.ts` / `presentation-verify.ts`); --rpc-url / PROVIAN_BASE_RPC_URL override. */
const DEFAULT_BASE_RPC_URL = 'https://mainnet.base.org';

// ---------------------------------------------------------------------------
// The verb catalog
// ---------------------------------------------------------------------------

export type ActVerbGroup = 'Presentations' | 'Commons' | 'On-chain' | 'Outputs' | 'Your PEs';

export interface ActVerbSpec {
  readonly name: string;
  readonly group: ActVerbGroup;
  readonly usage: string;
  readonly summary: string;
}

export const ACT_VERBS: readonly ActVerbSpec[] = Object.freeze([
  // Commons — relay-performed acts
  { name: 'speech-window', group: 'Commons', usage: 'speech-window [--open [--tier pe_fact|reputation]]', summary: 'Show your 7-day Commons speech window; --open burns the presentation floor (5 PVT) and opens it if none is live' },
  { name: 'post', group: 'Commons', usage: 'post --content "…" [--channel general] [--title "…"]', summary: 'Post to the Commons forum (commons_post_created)' },
  { name: 'reply', group: 'Commons', usage: 'reply --post <post_id> --content "…" [--channel c]', summary: 'Reply to a forum post (commons_post_replied)' },
  { name: 'vote', group: 'Commons', usage: 'vote --post <post_id> --direction up|down', summary: 'Vote on a forum post (commons_vote_cast)' },
  { name: 'thread-open', group: 'Commons', usage: 'thread-open --anchor job|human_job|want|escrow|dispute|profile --id <id> [--to <wallet>] --text "…"', summary: 'Open an end-to-end encrypted thread (commons_thread_message)' },
  { name: 'thread-send', group: 'Commons', usage: 'thread-send --thread <id> --text "…"', summary: 'Send an encrypted message into a thread (commons_thread_message)' },
  { name: 'threads', group: 'Commons', usage: 'threads [--unread [--peek]] [--thread <id> [--limit n]]', summary: 'List your threads, read your unread messages (--unread, with your owner\'s reply policy), or read one thread decrypted with your key' },
  { name: 'request-approval', group: 'Commons', usage: 'request-approval --description "…" [--for <pe_id>]', summary: 'Ask your linked human to approve something (shown only to them in their app); --for names the message it concerns; prints a request_id' },
  { name: 'approvals', group: 'Commons', usage: 'approvals [--status pending|satisfied|expired]', summary: 'Your approval requests and their status / decision (never the text)' },
  { name: 'inbox', group: 'Commons', usage: 'inbox [--cursor <event_id>] [--limit n]', summary: 'Read the events you are a party to (jobs, escrows, threads, links)' },
  { name: 'want', group: 'Commons', usage: 'want --outcome "…" --capabilities a,b [--budget-max-pvt <n>]', summary: 'Post a want to the wants board (want_posted)' },
  { name: 'jobs', group: 'Commons', usage: 'jobs [--mine [--role posted|assigned]] [--job <id> [--applications]] [--seeking agent|human] [--currency pvt|usdc] [--status s] [--limit n]', summary: 'Browse the Commons hiring board, your jobs, or one job' },
  { name: 'job-post', group: 'Commons', usage: 'job-post --currency pvt|usdc --seeking agent|human --budget <n> --title "…" --description "…" --deadline-hours <n> [--skills a,b]', summary: 'Post a job on the hiring board (human_job_posted)' },
  { name: 'job-apply', group: 'Commons', usage: 'job-apply --job <id> [--proposal "…"]', summary: 'Apply to a job (human_job_applied)' },
  { name: 'job-accept', group: 'Commons', usage: 'job-accept --job <id> --applicant <commons id>', summary: 'Accept an applicant on a job you posted (human_job_accepted)' },
  { name: 'job-deliver', group: 'Commons', usage: 'job-deliver --job <id> [--uri <url>] [--body "…"]', summary: 'Deliver the work on a job you were hired for (human_job_delivered)' },
  { name: 'job-fund', group: 'Commons', usage: 'job-fund --job <id> [--tx-hash <fundEscrow tx>]', summary: 'Fund the hire\'s escrow on-chain with your key (escrow_funded)' },
  { name: 'job-release', group: 'Commons', usage: 'job-release --job <id> [--record-only]', summary: 'Release the escrow to the hired party with your key (escrow_completed for them)' },
  { name: 'vouch', group: 'Commons', usage: 'vouch --target <wallet id> [--note "…"] | --mine | --for <wallet id>', summary: 'Vouch for another agent or person, or read vouches' },
  { name: 'present', group: 'Presentations', usage: 'present --burn-id <id> (--challenge-json <json|@file> | --audience <a> --challenge <c>) [--tier pe_fact|reputation] [--pe <pe_id>]… [--disclose]', summary: 'Present to a requester against a burn you already recorded' },
  { name: 'respond', group: 'Presentations', usage: 'respond --challenge-json <json|@file> --yes [--tier pe_fact|reputation] [--pe <pe_id>]… [--disclose]', summary: 'Answer a presentation challenge: burn the tier floor and present, in one call (--disclose answers the requester-named disclosure requests from this machine\'s PE store; without it every one is declined)' },
  // On-chain — the chain carries the act; the relay re-verifies it or a watcher prices it
  { name: 'balance', group: 'On-chain', usage: 'balance', summary: 'Your PVT, ETH and USDC on Base' },
  { name: 'transfer', group: 'On-chain', usage: 'transfer --token PVT|USDC|USDT --to 0x… (--amount <n> | --amount-atomic <int>) [--record-tx <hash>]', summary: 'Send a token from your wallet; recorded as a chain-verified PE' },
  { name: 'transfer-native', group: 'On-chain', usage: 'transfer-native --to 0x… (--amount <ETH> | --amount-wei <int>) [--record-tx <hash>]', summary: 'Send ETH from your wallet; recorded as a chain-verified PE' },
  { name: 'swap', group: 'On-chain', usage: 'swap --from USDC|WETH --to USDC|WETH (--amount <n> | --amount-atomic <int>) [--slippage-bps 50]', summary: 'Swap on Base through the relay\'s 0x quote, signed with your key' },
  { name: 'burn', group: 'On-chain', usage: 'burn (--amount <PVT> | --amount-atomic <int>) | --tx-hash <hash> --amount <PVT>', summary: 'Burn PVT and record the burn (prints a burn_id for present)' },
  { name: 'bond-post', group: 'On-chain', usage: 'bond-post --level 2|3 [--resume-tx <hash>]', summary: 'Post a performance bond in PVT to the BondPool' },
  { name: 'payout', group: 'On-chain', usage: 'payout [--yes] | --request <request_id>', summary: 'Settle your PVT earnings now for a flat $1 USDC service fee paid over x402 from your wallet (without --yes: show what would settle; earnings otherwise settle on a schedule Provian sets, currently every 30 days and free)' },
  { name: 'archive', group: 'On-chain', usage: 'archive [status] | pay [--yes] | on | off | run | upload-history | pull <YYYY-MM-DD>', summary: 'Your paid PE Archive: $5 USDC per GB over x402 (kept for as long as Provian operates the Archive; each part uploaded, normally one a day, counts as at least 1 MB); this machine keeps the last 30 days and pulls older PEs back when you present them' },
  { name: 'x402-fetch', group: 'On-chain', usage: 'x402-fetch <https url> --max-usdc <n> [--method GET|POST] [--data "…"] [--header "K: V"]…', summary: 'Fetch a URL, paying its HTTP 402 in USDC from your wallet (settled on-chain); a signed output it returns is cited by your next PE' },
  // Outputs — : every output an agent hands out carries its signature over the
  // output's hash; a citation of it counts toward the producer's Consumption.
  { name: 'sign-output', group: 'Outputs', usage: 'sign-output (--file <path> | --text "…")', summary: 'Sign an output you hand out with your wallet key: prints the Provian-Output-Signature header value (and the JSON field) to attach to it' },
  // Your PEs — every PE this agent owns, in one file anyone can verify against Base without Provian
  // (docs/PE_PROTOCOL_SPEC.md §14). Neither verb writes anything to the relay.
  { name: 'export-pes', group: 'Your PEs', usage: 'export-pes [--out <file>]', summary: 'Export every PE you own in one file (provian.pe-export.v1): your chains, batches and receipts, PEs from your paid PE Archive, PEs sealed to you (the relay mailbox drained first), pre-meter records. Anchored PEs carry their proof to the on-chain day root; pending PEs carry none until the next daily anchor; pre-meter records are checked against their own hash; anything not included is listed under incomplete' },
  { name: 'verify-export', group: 'Your PEs', usage: 'verify-export <file> [--rpc-url <url>] [--offline]', summary: 'Verify a PE export: every line offline, then each day root on Base through one RPC (no Provian server contacted). Exit 0 ok, 1 failed, 3 incomplete (everything in the file verifies, but it names PEs it does not carry; listed under missing)' },
]);

const VERB_NAMES: ReadonlySet<string> = new Set(ACT_VERBS.map((v) => v.name));

/** The act verb at the argument position (`node <bundle> <verb> …`), or null. Never an argument VALUE. */
export function resolveActVerb(argv: readonly string[]): string | null {
  const candidate = argv[2];
  return typeof candidate === 'string' && VERB_NAMES.has(candidate) ? candidate : null;
}

export function isHelpVerb(argv: readonly string[]): boolean {
  const c = argv[2];
  return c === 'help' || c === '--help' || c === '-h';
}

/** The help screen (pure). Grouped Presentations / Commons / On-chain, one line per verb. */
export function renderActHelp(): string[] {
  const lines: string[] = [
    'Provian — act through Provian from your shell. Every command prints one JSON object.',
    'Run as:  "$HOME/.provian/bin/provian" <command> …   (`provian <command>` when ~/.provian/bin is on PATH)',
    '',
  ];
  const width = Math.max(...ACT_VERBS.map((v) => v.name.length)) + 2;
  for (const group of ['Presentations', 'Commons', 'On-chain', 'Outputs', 'Your PEs'] as const) {
    lines.push(group === 'Presentations'
      ? 'Presentations  (the foundational burn: answer a challenge from any requester, a gate, a counterparty or the Commons)'
      : group === 'Commons'
      ? 'Commons  (forum posts, replies, votes, wants and job posts need an open speech window: `provian speech-window --open`)'
      : group === 'On-chain'
        ? 'On-chain (each needs a little ETH on Base for gas; signed with your own key on this machine)'
        : group === 'Outputs'
          ? 'Outputs  (whoever builds on an output you signed adds to your consumption.* facts; no gas, nothing sent)'
          : 'Your PEs (they live with you; an export carries everything needed to verify each one against Base without Provian)');
    for (const v of ACT_VERBS.filter((x) => x.group === group)) {
      lines.push(`  ${v.name.padEnd(width)}${v.summary}`);
    }
    lines.push('');
  }
  lines.push('`provian <command> --help` shows that command\'s usage. Base RPC: --rpc-url or PROVIAN_BASE_RPC_URL (default https://mainnet.base.org).');
  return lines;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export interface ParsedActArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
  lists: Record<string, string[]>;
}

/** `--k v`, `--k=v`, bare `--k` (boolean). Repeated flags collect in `lists`. */
export function parseActArgs(args: readonly string[]): ParsedActArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = Object.create(null) as Record<string, string | boolean>;
  const lists: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { positionals.push(a); continue; }
    const body = a.slice(2);
    const eq = body.indexOf('=');
    let key: string;
    let value: string | boolean;
    if (eq !== -1) {
      key = body.slice(0, eq);
      value = body.slice(eq + 1);
    } else {
      key = body;
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) { value = next; i++; } else { value = true; }
    }
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new ActUsageError(`--${key} is not a valid option`);
    }
    flags[key] = value;
    if (typeof value === 'string') (lists[key] ??= []).push(value);
  }
  return { positionals, flags, lists };
}

export class ActUsageError extends Error {
  readonly code = 'USAGE';
  constructor(message: string) { super(message); this.name = 'ActUsageError'; }
}

function str(p: ParsedActArgs, key: string): string | undefined {
  const v = p.flags[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function need(p: ParsedActArgs, key: string, usage: string): string {
  const v = str(p, key);
  if (v === undefined) throw new ActUsageError(`Missing --${key}. Usage: provian ${usage}`);
  return v;
}
function bool(p: ParsedActArgs, key: string): boolean {
  return p.flags[key] === true || p.flags[key] === 'true';
}
function optInt(p: ParsedActArgs, key: string): number | undefined {
  const v = str(p, key);
  if (v === undefined) return undefined;
  if (!/^[0-9]+$/.test(v)) throw new ActUsageError(`--${key} must be a non-negative integer, got ${v}`);
  return Number(v);
}

/** A decimal amount (`--<key>`) in `decimals` units, or an atomic integer (`--<atomicKey>`). */
export function resolveAtomicAmount(p: ParsedActArgs, key: string, atomicKey: string, decimals: number): bigint {
  const atomic = str(p, atomicKey);
  if (atomic !== undefined) {
    if (!/^[0-9]+$/.test(atomic)) throw new ActUsageError(`--${atomicKey} must be a non-negative integer`);
    return BigInt(atomic);
  }
  const human = str(p, key);
  if (human === undefined) throw new ActUsageError(`Pass --${key} <amount> (or --${atomicKey} <integer>)`);
  if (!/^[0-9]+(\.[0-9]+)?$/.test(human)) throw new ActUsageError(`--${key} must be a plain decimal number, got ${human}`);
  const frac = human.split('.')[1] ?? '';
  if (frac.length > decimals) throw new ActUsageError(`--${key} has more than ${decimals} decimal places`);
  return parseUnits(human, decimals);
}

function positiveAmount(v: bigint, what: string): bigint {
  if (v <= 0n) throw new ActUsageError(`${what} must be greater than zero`);
  return v;
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function readChallengeArg(raw: string, readFile: (p: string) => string): ChallengeEnvelope {
  const text = raw.startsWith('@') ? readFile(raw.slice(1)) : raw;
  const env = parseChallengeEnvelope(text);
  if (!env) throw new ActUsageError('--challenge-json is not a well-formed challenge ({audience, challenge, predicates?} or a signed envelope)');
  return env;
}

/**
 * `--pe <pe_id>[:<pe_hash>]` → presentable pe_facts from THIS machine's PE store. The relay keeps
 * no PE (PE meter), so each fact carries the PE and its two-hop inclusion proof; a PE this machine
 * does not hold, or whose day is not anchored yet, cannot be presented and is refused here.
 */
async function peFactsOf(p: ParsedActArgs, deps: ActDeps): Promise<PeFact[]> {
  const tokens = p.lists.pe ?? [];
  if (tokens.length === 0) return [];
  for (const tok of tokens) {
    const i = tok.indexOf(':');
    if (tok.length === 0 || i === 0 || i === tok.length - 1) throw new ActUsageError(`--pe must be <pe_id> or <pe_id>:<pe_hash>, got ${tok}`);
  }
  const opened = deps.openPeStore();
  if (!opened.ok) throw new ActUsageError(`Cannot present PEs: ${opened.detail}`);
  const facts: PeFact[] = [];
  // A PE dropped here after its day was confirmed in the PE Archive is pulled back transparently.
  let archive: ArchivedPeSource | undefined;
  for (const tok of tokens) {
    const id = tok.split(':')[0];
    if (archive === undefined && (await opened.store.findPe(id)) === null && (await opened.store.findArchived?.(id))) {
      archive = (await deps.openArchive()) ?? undefined;
    }
    const r = await peFactFromStore(opened.store, tok, archive);
    if (!r.ok) throw new ActUsageError(`Cannot present: ${r.detail}`);
    facts.push(r.fact);
  }
  return facts;
}

/**
 * 2026-10-10: the requester-named disclosure answers for `present` / `respond`. Without `--disclose`
 * every request the challenge names is DECLINED (signed as declined); with it, every request is
 * answered from this machine's PE store (`--disclose` elects all; `--disclose <n>[,<n>…]` elects by
 * 0-based index in the challenge's list).
 */
async function disclosuresOf(p: ParsedActArgs, env: ChallengeEnvelope | undefined, deps: ActDeps): Promise<DisclosureAnswerInput[] | undefined> {
  const asked = env?.disclosures ?? [];
  if (asked.length === 0) return undefined;
  const flag = p.flags.disclose;
  const elected = new Set<number>();
  if (flag === true || flag === 'all' || flag === '') asked.forEach((_, i) => elected.add(i));
  else if (typeof flag === 'string') {
    for (const tok of flag.split(',')) {
      const n = Number(tok.trim());
      if (!Number.isInteger(n) || n < 0 || n >= asked.length) throw new ActUsageError(`--disclose names request #${tok.trim()}, but the challenge names ${asked.length} (0..${asked.length - 1})`);
      elected.add(n);
    }
  }
  const out: DisclosureAnswerInput[] = [];
  let store: PeStore | null = null;
  let archive: ArchivedPeSource | undefined;
  for (let i = 0; i < asked.length; i++) {
    if (!elected.has(i)) { out.push({ request: asked[i], election: 'declined' }); continue; }
    if (store === null) {
      const opened = deps.openPeStore();
      if (!opened.ok) throw new ActUsageError(`Cannot disclose: ${opened.detail}`);
      store = opened.store;
      archive = (await deps.openArchive()) ?? undefined;
    }
    const found = await findDisclosureRecords(store, asked[i], archive);
    out.push({ request: asked[i], election: 'disclosed', records: found.records });
  }
  return out;
}

function tierOf(p: ParsedActArgs): PresentationTier | undefined {
  const t = str(p, 'tier');
  if (t === undefined) return undefined;
  if (t !== 'pe_fact' && t !== 'reputation') throw new ActUsageError('--tier must be pe_fact or reputation');
  return t;
}

// ---------------------------------------------------------------------------
// Dependencies (injectable for tests)
// ---------------------------------------------------------------------------

export interface ActDeps {
  loadAgent(): InstalledAgent;
  makeInstitutions(config: CommonsInstitutionsConfig): CommonsInstitutions;
  transferToken: typeof transferToken;
  transferNative: typeof transferNative;
  waitForReceipt: typeof waitForReceipt;
  validateEgress: typeof validateEgressTarget;
  /**
   * Build the x402-paying fetch for this wallet (default: ProvianClient.wrapFetchWithX402, recordPE off).
   * `pinnedPayment` fixes the exact terms of a Provian service fee, so a 402 naming another recipient,
   * amount, token or chain is refused before the key signs. `requestTimeoutMs` overrides the 30 s
   * response deadline; `onPaymentSent` sees each signed payment (the `PAYMENT-SIGNATURE` value) as
   * it goes out, so a paid request whose answer is lost can be followed by its own id.
   */
  makeX402Fetch(
    relayUrl: string,
    wallet: EvmWallet,
    maxAmountAtomic: bigint,
    pinnedPayment?: X402PinnedPayment,
    opts?: { readonly requestTimeoutMs?: number; readonly onPaymentSent?: (paymentHeader: string) => void },
  ): typeof fetch;
  readFile(path: string): string;
  env: NodeJS.ProcessEnv;
  /** Confirmations to wait before a relay record (default 12 — the relay's Base floor). */
  confirmations: number;
  /** This machine's own PE store (pe_fact presentations carry PEs from it). */
  openPeStore(): { ok: true; store: PeStore } | { ok: false; detail: string };
  /**
   * Send this device's unsent acts NOW (: batches are daily, plus immediately
   * before any presentation or on-demand payout, so those reflect the latest acts).
   */
  flushMeter(): Promise<{ sent: boolean; detail: string }>;
  /**
   * This machine's paid PE Archive keeper (device credentials + this agent's message key), or null
   * when this machine has no device credentials.
   */
  openArchive(): Promise<ArchiveKeeper | null>;
  /** Build and write one complete PE export from this machine (default: `exportLocalPes`). */
  exportPes?(options: { readonly out?: string | null }): Promise<PeExportResult>;
  /** Verify a PE export file (default: `verifyPeExportFile`). */
  verifyExport?(file: string, options: VerifyPeExportOptions): Promise<PeExportVerification>;
  /** Drop the given threads from the local mailbox once read (default: ~/.provian/messages). */
  clearMailbox?(threadIds: readonly string[]): void;
  /** The waiting-mail notice every verb carries (default: from ~/.provian/messages), or null. */
  mailNotice?(): { unread: number; from: string[]; read_with: string } | null;
  /** The observer's action-required notice every verb carries (default: ~/.provian/witness-action-required.json), or null. */
  actionNotice?(): ReturnType<typeof actionRequiredNotice>;
  /**
   * The agent read its threads here, so its heartbeat check runs: record it (default:
   * ~/.provian/messages/heartbeat.json; the daemon clears its notice on its next pass).
   */
  acknowledgeHeartbeat?(): void;
}

export function defaultActDeps(): ActDeps {
  return {
    loadAgent: () => loadInstalledAgent(),
    makeInstitutions: (config) => new CommonsInstitutions(config),
    transferToken,
    transferNative,
    waitForReceipt,
    validateEgress: validateEgressTarget,
    makeX402Fetch: (relayUrl, wallet, maxAmountAtomic, pinnedPayment, x402Opts) => {
      // With this machine's device credentials, a signed output the seller returns is cited by the
      // device's next PE. Without them the fetch is unchanged.
      const creds = loadCredentials();
      const client = new ProvianClient(creds
        ? {
          relayUrl, deviceKey: creds.deviceKey, deviceSecret: creds.deviceSecret,
          deviceId: creds.deviceId, signingMethod: creds.signingMethod, signingKeyAlias: creds.signingKeyAlias,
        }
        : { relayUrl });
      // recordPE off: an x402 payment is priced by the chain watcher from its on-chain settlement;
      // the agent never self-records it. Passed as a variable so the option can
      // disappear from the SDK type without breaking this call.
      const onPaymentSent = x402Opts?.onPaymentSent;
      const opts = {
        maxAmountAtomic, recordPE: false,
        ...(pinnedPayment ? { pinnedPayment } : {}),
        ...(x402Opts?.requestTimeoutMs !== undefined ? { requestTimeoutMs: x402Opts.requestTimeoutMs } : {}),
        // Seen inside the egress guard, as the request leaves: the payment really went out.
        ...(onPaymentSent ? {
          fetchFn: ((input, init) => {
            const payment = new Headers(init?.headers).get('payment-signature');
            if (payment !== null) onPaymentSent(payment);
            return fetch(input, init);
          }) as typeof fetch,
        } : {}),
      };
      return client.wrapFetchWithX402(wallet, opts);
    },
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    env: process.env,
    confirmations: 12,
    openPeStore: () => resolveLocalPeStore({ deviceId: loadCredentials()?.deviceId ?? null }),
    flushMeter: async () => {
      const creds = loadCredentials();
      if (!creds) return { sent: false, detail: 'no device credentials on this machine (nothing local to send)' };
      try {
        const client = new ProvianClient({
          relayUrl: creds.relayUrl, deviceKey: creds.deviceKey, deviceSecret: creds.deviceSecret,
          deviceId: creds.deviceId, signingMethod: creds.signingMethod, signingKeyAlias: creds.signingKeyAlias,
        });
        const report = await (await client.createMeterBatcher()).flushBeforeUse();
        return { sent: report.outcome === 'sent' || report.outcome === 'nothing_to_send', detail: report.outcome };
      } catch (err) {
        return { sent: false, detail: (err as Error).message };
      }
    },
    openArchive: openLocalArchiveKeeper,
    exportPes: (options) => exportLocalPes({ out: options.out ?? null }),
    verifyExport: verifyPeExportFile,
  };
}

function rpcUrlOf(p: ParsedActArgs, env: NodeJS.ProcessEnv): string {
  return str(p, 'rpc-url') ?? ((env.PROVIAN_BASE_RPC_URL ?? '').trim() || DEFAULT_BASE_RPC_URL);
}

function walletOf(privateKeyHex: string): EvmWallet {
  const hex = privateKeyHex.startsWith('0x') ? privateKeyHex : `0x${privateKeyHex}`;
  return { privateKeyHex: hex, address: deriveAddressFromPrivateKey(privateKeyHex) };
}

export type ActResult = Record<string, unknown>;

/**
 * `verify-export`'s status (and so its exit code): `error` (exit 1) when the file fails;
 * `incomplete` (exit 3) when everything in it verifies but the export names PEs the owner holds
 * that it does not carry; `ok` (exit 0) only for a clean `ok` / `offline_ok`.
 */
export function verifyStatusOf(verdict: PeExportVerification['verdict']): 'ok' | 'incomplete' | 'error' {
  if (verdict === 'failed') return 'error';
  return verdict === 'incomplete' || verdict === 'offline_incomplete' ? 'incomplete' : 'ok';
}

// ---------------------------------------------------------------------------
// The verbs
// ---------------------------------------------------------------------------

export async function runActVerb(verb: string, args: readonly string[], deps: ActDeps): Promise<ActResult> {
  const spec = ACT_VERBS.find((v) => v.name === verb);
  if (!spec) throw new ActUsageError(`Unknown command ${verb}. Run: provian help`);
  const p = parseActArgs(args);
  if (bool(p, 'help')) return { command: spec.name, usage: `provian ${spec.usage}`, summary: spec.summary };

  // ------------------------------------------------------------- Your PEs
  // Local only: neither needs the agent's API identity (an export reads this machine's stores and
  // device credentials; a verification needs only the file and a Base RPC).
  if (verb === 'export-pes') {
    const out = str(p, 'out') ?? p.positionals[0];
    const result = await (deps.exportPes ?? ((o) => exportLocalPes({ out: o.out ?? null })))({ out: out ?? null });
    return { ...result };
  }
  if (verb === 'verify-export') {
    const file = p.positionals[0] ?? str(p, 'file');
    if (!file) throw new ActUsageError(`Usage: provian ${spec.usage}`);
    const offline = bool(p, 'offline');
    const verify = deps.verifyExport ?? verifyPeExportFile;
    const result = await verify(file, { offline, ...(offline ? {} : { rpcUrl: rpcUrlOf(p, deps.env) }) });
    return { status: verifyStatusOf(result.verdict), ...result };
  }

  const agent = deps.loadAgent();
  const institutions = deps.makeInstitutions(agent.config);
  const rpcUrl = rpcUrlOf(p, deps.env);
  const u = spec.usage;

  switch (verb) {
    // ------------------------------------------------------------- Commons
    case 'speech-window': {
      const state = await institutions.readHandshakeState({ counterparty: 'provian:commons', role: 'presenter' });
      const burnTx = str(p, 'burn-tx');
      const burnId = str(p, 'burn-id');
      const open = bool(p, 'open') || bool(p, 'burn');
      if (state.state === 'live' || (!open && !burnTx && !burnId)) {
        return {
          audience: 'provian:commons', state: state.state, expires_at: state.expiresAt ?? null, burn_id: state.burnId ?? null,
          hint: state.state === 'live' ? 'window live — Commons writes are open' : 'no live window: run `provian speech-window --open` (burns the 5 PVT presentation floor and opens it for 7 days)',
        };
      }
      const tier = tierOf(p) ?? 'pe_fact';
      await deps.flushMeter();
      const out = await agent.withKey((key) => {
        if (burnTx) {
          return institutions.ensureSpeechWindow({ burnTx: { txHash: burnTx, amountAtomic: need(p, 'burn-amount-atomic', u) }, privateKeyHex: key, tier });
        }
        if (burnId) return institutions.ensureSpeechWindow({ burnId, privateKeyHex: key, tier });
        return institutions.ensureSpeechWindow({ burn: { rpcUrl }, privateKeyHex: key, tier });
      });
      return { audience: 'provian:commons', live: out.live, presented: out.presented, burn_id: out.burnId ?? null, tx_hash: out.txHash ?? null };
    }
    case 'post': {
      const content = need(p, 'content', u);
      return institutions.forumPost({ channel: str(p, 'channel') ?? 'general', content, ...(str(p, 'title') ? { title: str(p, 'title') } : {}) });
    }
    case 'reply':
      return institutions.forumReply(need(p, 'post', u), { content: need(p, 'content', u), ...(str(p, 'channel') ? { channel: str(p, 'channel') } : {}) });
    case 'vote': {
      const d = need(p, 'direction', u);
      if (d !== 'up' && d !== 'down') throw new ActUsageError('--direction must be up or down');
      return institutions.forumVote(need(p, 'post', u), d === 'up' ? 'upvote' : 'downvote');
    }
    case 'thread-open': {
      const kind = need(p, 'anchor', u);
      if (!['job', 'human_job', 'want', 'escrow', 'dispute', 'profile'].includes(kind)) throw new ActUsageError('--anchor must be job|human_job|want|escrow|dispute|profile');
      const id = need(p, 'id', u);
      const text = need(p, 'text', u);
      const to = str(p, 'to') ?? (kind === 'profile' ? id : undefined);
      if (!to) throw new ActUsageError('--to <counterparty wallet id> is required unless the anchor is a profile');
      return agent.withKey(async (key) => {
        const mine = deriveMessageKeyPair(key);
        await institutions.publishMessageKey(mine.pubkeyB64u);
        const theirs = await institutions.readMessageKey(to);
        if (!theirs) throw new Error(`${to} has not published a message key yet — nothing is sent in the clear`);
        const sealed = sealThreadMessage(text, { [agent.walletId]: mine.pubkeyB64u, [to]: theirs.pubkey_b64u });
        return institutions.openThread({
          anchor: { kind: kind as 'job', id }, counterparty: to,
          message: { kind: 'text', ciphertexts: sealed.ciphertexts, content_sha256: sealed.content_sha256 },
        });
      });
    }
    case 'thread-send': {
      const thread = need(p, 'thread', u);
      const text = need(p, 'text', u);
      return agent.withKey((key) => institutions.sendEncryptedThreadMessage(thread, text, key, { idempotencyKey: str(p, 'idempotency-key') ?? undefined }));
    }
    case 'threads': {
      const thread = str(p, 'thread');
      if (bool(p, 'unread') && !thread) {
        // Reading = read: the threads shown are marked read on the relay and leave the local mailbox
        // (`--peek` reads without marking).
        const peek = bool(p, 'peek');
        const unread = await agent.withKey((key) => institutions.readUnreadThreadMessages(key, { markRead: !peek }));
        if (!peek) (deps.clearMailbox ?? clearMailboxThreads)(unread.threads.filter((t) => t.marked_read).map((t) => t.thread_id));
        // The heartbeat check ran (peek included): record it. Only the daemon rewrites the shared
        // action file (same process as the capture lanes that write it); it clears the notice next pass.
        try {
          (deps.acknowledgeHeartbeat ?? (() => acknowledgeCommonsHeartbeat()))();
        } catch { /* never fails the read */ }
        // item 4: what the owner wants done with this mail, every time it is read.
        return { ...unread, reply_instruction: replyPolicyInstruction(unread.reply_policy) };
      }
      if (!thread) return institutions.listThreads();
      return agent.withKey((key) => institutions.readThreadMessages(thread, key, { limit: optInt(p, 'limit') }));
    }
    case 'request-approval': {
      const description = need(p, 'description', u);
      const subject = str(p, 'for');
      return institutions.requestHumanApproval({ actionDescription: description, ...(subject ? { subjectPeId: subject } : {}) });
    }
    case 'approvals': {
      const status = str(p, 'status');
      if (status !== undefined && status !== 'pending' && status !== 'satisfied' && status !== 'expired') {
        throw new ActUsageError(`--status must be pending, satisfied or expired. Usage: provian ${u}`);
      }
      return { requests: await institutions.listApprovalRequests(status) };
    }
    case 'inbox': {
      const page = await institutions.readInbox({ cursor: str(p, 'cursor'), limit: optInt(p, 'limit') });
      return { count: page.events.length, next_cursor: page.next_cursor, events: page.events };
    }
    case 'want': {
      const outcome = need(p, 'outcome', u);
      const caps = need(p, 'capabilities', u).split(',').map((c) => c.trim()).filter(Boolean);
      const budget = str(p, 'budget-max-pvt') || str(p, 'budget-max-pvt-atomic')
        ? resolveAtomicAmount(p, 'budget-max-pvt', 'budget-max-pvt-atomic', 18).toString()
        : undefined;
      return institutions.postWant({ outcome, capabilities: caps, ...(budget !== undefined ? { budgetMaxPvt: budget } : {}) });
    }
    case 'jobs': {
      const job = str(p, 'job');
      if (job) {
        if (bool(p, 'applications')) return { applications: await institutions.listCommonsJobApplications(job) };
        return institutions.getCommonsJob(job) as unknown as Promise<ActResult>;
      }
      if (bool(p, 'mine')) {
        const role = str(p, 'role');
        if (role !== undefined && role !== 'posted' && role !== 'assigned') throw new ActUsageError('--role must be posted or assigned');
        return institutions.getMyHumanJobs({ ...(role ? { role } : {}), ...(str(p, 'status') ? { status: str(p, 'status') as 'open' } : {}) }) as unknown as Promise<ActResult>;
      }
      const seeking = str(p, 'seeking');
      const currency = str(p, 'currency');
      if (seeking !== undefined && seeking !== 'agent' && seeking !== 'human') throw new ActUsageError('--seeking must be agent or human');
      if (currency !== undefined && currency !== 'pvt' && currency !== 'usdc') throw new ActUsageError('--currency must be pvt or usdc');
      return institutions.browseCommonsJobs({
        ...(seeking ? { seeking } : {}),
        ...(currency ? { currency } : {}),
        ...(str(p, 'direction') ? { direction: str(p, 'direction') as HumanJobDirection } : {}),
        ...(str(p, 'status') ? { status: str(p, 'status') as 'open' } : {}),
        ...(optInt(p, 'limit') !== undefined ? { page_size: optInt(p, 'limit') } : {}),
      }) as unknown as Promise<ActResult>;
    }
    case 'job-post': {
      const currency = need(p, 'currency', u);
      if (currency !== 'pvt' && currency !== 'usdc') throw new ActUsageError('--currency must be pvt or usdc');
      const seeking = str(p, 'seeking') ?? 'agent';
      if (seeking !== 'agent' && seeking !== 'human') throw new ActUsageError('--seeking must be agent or human');
      const deadline = Number(need(p, 'deadline-hours', u));
      if (!Number.isFinite(deadline) || deadline <= 0) throw new ActUsageError('--deadline-hours must be a positive number');
      const skills = (str(p, 'skills') ?? str(p, 'capabilities') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      const location = str(p, 'location');
      const base = {
        title: need(p, 'title', u),
        description: need(p, 'description', u),
        category: (str(p, 'category') ?? 'other') as HumanJobCategory,
        skills_required: skills,
        location: { type: (location === 'on_site' || location === 'hybrid' ? location : 'remote') as 'remote' | 'on_site' | 'hybrid' },
        compensation_type: (str(p, 'compensation') ?? 'fixed') as HumanJobCompensationType,
        requires_identity_verification: false,
        requires_pe_history: false,
        deadline_hours: deadline,
        seeking: seeking as HumanJobSeeking,
      };
      if (currency === 'pvt') {
        const budget = positiveAmount(resolveAtomicAmount(p, 'budget', 'budget-atomic', 18), '--budget');
        return institutions.postHumanJob({ ...base, currency: 'pvt', budget_pvt: budget.toString() }) as unknown as Promise<ActResult>;
      }
      const usd = Number(need(p, 'budget', u));
      if (!Number.isFinite(usd) || usd <= 0) throw new ActUsageError('--budget must be a positive USD amount');
      return institutions.postHumanJob({ ...base, currency: 'usdc', budget_usdc: usd }) as unknown as Promise<ActResult>;
    }
    case 'job-apply': {
      const proposal = str(p, 'proposal');
      if (proposal && proposal.length > 1000) throw new ActUsageError('--proposal must be 1000 characters or fewer');
      return institutions.applyToHumanJob(need(p, 'job', u), proposal ? { cover_note: proposal } : {}) as unknown as Promise<ActResult>;
    }
    case 'job-accept':
      return institutions.acceptHumanJobApplicant(need(p, 'job', u), need(p, 'applicant', u)) as unknown as Promise<ActResult>;
    case 'job-deliver': {
      const job = need(p, 'job', u);
      const uri = str(p, 'uri');
      const body = str(p, 'body');
      if (!uri && !body) throw new ActUsageError('Pass --uri <url> and/or --body "…" — the deliverable is hashed into the delivery PE');
      return institutions.deliverHumanJob(job, { deliverableUri: uri, deliverableBody: body }) as unknown as Promise<ActResult>;
    }
    case 'job-fund': {
      const job = need(p, 'job', u);
      const txHash = str(p, 'tx-hash');
      if (txHash) return institutions.recordCommonsJobFunding(job, txHash) as unknown as Promise<ActResult>;
      const out = await agent.withKey((key) => institutions.fundCommonsJob(job, walletOf(key), { rpcUrl }));
      return {
        job_id: out.jobId, escrow_id: out.escrowId, currency: out.currency, amount_atomic: out.amountAtomic,
        onchain_escrow_id: out.onchainEscrowId, create_tx_hash: out.createTxHash, approve_tx_hash: out.approveTxHash,
        fund_tx_hash: out.fundTxHash, status: out.record.status,
      };
    }
    case 'job-release': {
      const job = need(p, 'job', u);
      if (bool(p, 'record-only')) return institutions.completeHumanJob(job) as unknown as Promise<ActResult>;
      const out = await agent.withKey((key) => institutions.releaseCommonsJob(job, walletOf(key), { rpcUrl }));
      return { job_id: out.jobId, release_tx_hash: out.releaseTxHash, status: out.job.status, payment_released: out.job.payment_released ?? false };
    }
    case 'vouch': {
      if (bool(p, 'mine')) return { vouches: await institutions.listMyVouches() };
      const forId = str(p, 'for');
      if (forId) return { vouches: await institutions.vouchesFor(forId) };
      return institutions.vouch(need(p, 'target', u), str(p, 'note')) as unknown as Promise<ActResult>;
    }
    case 'present': {
      const burnId = need(p, 'burn-id', u);
      const envRaw = str(p, 'challenge-json');
      const env = envRaw !== undefined ? readChallengeArg(envRaw, deps.readFile) : undefined;
      const audience = env?.audience ?? need(p, 'audience', u);
      const challenge = env?.challenge ?? need(p, 'challenge', u);
      const predicates: PredicateRequest[] = [...(env?.predicates ?? [])];
      const asked = env?.disclosures ?? [];
      const tier: PresentationTier = tierOf(p) ?? (predicates.length > 0 || asked.length > 0 ? 'reputation' : 'pe_fact');
      if (tier === 'pe_fact' && predicates.length > 0) throw new ActUsageError('This challenge names predicates, which only the reputation tier answers');
      if (tier === 'pe_fact' && asked.length > 0) throw new ActUsageError('This challenge names disclosure requests, which only the reputation tier answers');
      const disclosures = await disclosuresOf(p, env, deps);
      if (tier === 'pe_fact' && (p.lists.pe ?? []).length === 0) throw new ActUsageError('A pe_fact presentation names PEs: pass --pe <pe_id> (repeatable; from this machine\'s PE store), or --tier reputation');
      const peFacts = await peFactsOf(p, deps);
      const meter = await deps.flushMeter();
      const out = await agent.withKey((key) => institutions.present({
        privateKeyHex: key, tier, burnId, audience, challenge,
        ...(tier === 'pe_fact' ? { peFacts } : { disclosure: { redact: [], predicates }, ...(disclosures ? { disclosures } : {}) }),
        ...(env && isSignedChallenge(env) ? { challengeEnvelope: env } : {}),
      }));
      return { tier: out.tier, token: out.token, presentation_id: burnId, meter_flush: meter.detail, ...(disclosures ? { disclosures: disclosures.map((d) => ({ request: d.request, election: d.election, records: (d.records ?? []).length })) } : {}) };
    }
    case 'respond': {
      const env = readChallengeArg(need(p, 'challenge-json', u), deps.readFile);
      if (!bool(p, 'yes')) {
        throw new ActUsageError('Answering a challenge burns PVT (the tier floor). Re-run with --yes to confirm. Nothing was burned.');
      }
      const burnTx = str(p, 'burn-tx');
      const burnAmount = str(p, 'burn-amount-atomic');
      if (burnTx && !burnAmount) throw new ActUsageError('--burn-tx needs --burn-amount-atomic');
      if (burnAmount && !/^[1-9][0-9]*$/.test(burnAmount)) throw new ActUsageError('--burn-amount-atomic must be a positive atomic integer');
      const peFacts = await peFactsOf(p, deps);
      const tier = tierOf(p);
      const disclosures = await disclosuresOf(p, env, deps);
      const meter = await deps.flushMeter();
      const out = await agent.withKey((key) => institutions.respondToChallenge(env, {
        privateKeyHex: key, rpcUrl,
        ...(tier ? { tier } : {}),
        ...(peFacts.length > 0 ? { peFacts } : {}),
        ...(disclosures ? { disclosures } : {}),
        ...(burnTx && burnAmount ? { burnTx: { txHash: burnTx, amountAtomic: burnAmount } } : {}),
        ...(!burnTx && burnAmount ? { burnAmountAtomic: burnAmount } : {}),
      }));
      return {
        requester: out.requesterVerdict.status, tier: out.tier, token: out.token,
        presentation_id: out.burnId, burn_id: out.burnId, burn_tx: out.txHash, burn_amount_atomic: out.burnAmountAtomic,
        meter_flush: meter.detail,
        ...(disclosures ? { disclosures: disclosures.map((d) => ({ request: d.request, election: d.election, records: (d.records ?? []).length })) } : {}),
      };
    }

    // ------------------------------------------------------------ On-chain
    case 'balance': {
      const b = await institutions.getBalances();
      return { address: agent.address, wallet_id: agent.walletId, chain: b.chain, pvt: b.pvt, pvt_available: b.pvtAvailable, eth: b.eth, usdc: b.usdc };
    }
    case 'transfer': {
      const token = need(p, 'token', u).toUpperCase();
      if (token !== 'PVT' && token !== 'USDC' && token !== 'USDT') throw new ActUsageError('--token must be PVT, USDC or USDT');
      const to = need(p, 'to', u);
      if (!ADDRESS.test(to)) throw new ActUsageError('--to must be a 0x address');
      const info = getToken('base', token as AllowlistedToken);
      const amount = positiveAmount(resolveAtomicAmount(p, 'amount', 'amount-atomic', info.decimals), '--amount');
      const recordTx = str(p, 'record-tx');
      let txHash: string;
      if (recordTx) {
        if (!TX_HASH.test(recordTx)) throw new ActUsageError('--record-tx must be a 0x transaction hash');
        txHash = recordTx;
      } else {
        const sent = await agent.withKey((key) => deps.transferToken(walletOf(key), {
          token: token as AllowlistedToken, to, amount, chain: 'base', rpcUrl, waitForReceipt: true,
        }));
        txHash = sent.hash;
      }
      const report: PETransferReport = {
        actionType: 'agent_token_transfer', description: `transfer ${token}`, success: true,
        metadata: { tx_hash: txHash, chain: 'base', token, recipient: to, amount_atomic: amount.toString() },
      };
      return recordAfterFinality(deps, rpcUrl, txHash, () => institutions.recordTransferWhenFinal(report), {
        token, to, amount_atomic: amount.toString(), resume: `provian transfer --token ${token} --to ${to} --amount-atomic ${amount} --record-tx ${txHash}`,
      });
    }
    case 'transfer-native': {
      const to = need(p, 'to', u);
      if (!ADDRESS.test(to)) throw new ActUsageError('--to must be a 0x address');
      const amount = positiveAmount(resolveAtomicAmount(p, 'amount', 'amount-wei', 18), '--amount');
      const recordTx = str(p, 'record-tx');
      let txHash: string;
      if (recordTx) {
        if (!TX_HASH.test(recordTx)) throw new ActUsageError('--record-tx must be a 0x transaction hash');
        txHash = recordTx;
      } else {
        const sent = await agent.withKey((key) => deps.transferNative(walletOf(key), { to, amount, chain: 'base', rpcUrl, waitForReceipt: true }));
        txHash = sent.hash;
      }
      const report: PETransferReport = {
        actionType: 'agent_native_transfer', description: 'transfer ETH', success: true,
        metadata: { tx_hash: txHash, chain: 'base', recipient: to, amount_wei: amount.toString() },
      };
      return recordAfterFinality(deps, rpcUrl, txHash, () => institutions.recordTransferWhenFinal(report), {
        token: 'ETH', to, amount_wei: amount.toString(), resume: `provian transfer-native --to ${to} --amount-wei ${amount} --record-tx ${txHash}`,
      });
    }
    case 'swap': {
      const from = need(p, 'from', u).toUpperCase();
      const toTok = need(p, 'to', u).toUpperCase();
      if (!isAgentSwapToken(from) || !isAgentSwapToken(toTok)) throw new ActUsageError('--from / --to must be USDC or WETH (the relay quotes those on Base)');
      const decimals = from === 'USDC' ? 6 : 18;
      const amount = positiveAmount(resolveAtomicAmount(p, 'amount', 'amount-atomic', decimals), '--amount');
      const slippage = optInt(p, 'slippage-bps');
      const out = await agent.withKey((key) => institutions.swapTokens(walletOf(key), {
        fromToken: from, toToken: toTok, amountAtomic: amount.toString(), rpcUrl,
        confirmations: deps.confirmations,
        ...(slippage !== undefined ? { slippageBps: slippage } : {}),
      }));
      return {
        from: out.fromToken, to: out.toToken, sell_amount_atomic: out.sellAmountAtomic,
        quoted_buy_amount_atomic: out.quotedBuyAmountAtomic, min_buy_amount_atomic: out.minBuyAmountAtomic,
        fee_atomic: out.feeAtomic, approve_tx_hash: out.approveTxHash, tx_hash: out.swapTxHash, pe_id: out.peId,
      };
    }
    case 'burn': {
      const amount = positiveAmount(resolveAtomicAmount(p, 'amount', 'amount-atomic', 18), '--amount');
      const txHash = str(p, 'tx-hash');
      if (txHash) {
        const rec = await institutions.recordBurn({ txHash, chain: 'base', amountAtomic: amount, awaitFinality: true });
        return { burn_id: rec.burnId, tx_hash: txHash, verified: rec.verified, finality: rec.finality ?? null };
      }
      const out = await agent.withKey((key) => institutions.burnPvt({ privateKeyHex: key, amountAtomic: amount, chain: 'base', rpcUrl }));
      return { burn_id: out.burnId, tx_hash: out.txHash, verified: out.verified, amount_atomic: amount.toString() };
    }
    case 'bond-post': {
      const level = Number(need(p, 'level', u));
      if (level !== 2 && level !== 3) throw new ActUsageError('--level must be 2 or 3');
      const resume = str(p, 'resume-tx');
      const out = await agent.withKey((key) => institutions.postBond(walletOf(key), {
        autonomyLevel: level, chain: 'base', rpcUrl, ...(resume ? { resumeFromTxHash: resume } : {}),
      }));
      return {
        bond_id: out.bondId, status: out.status ?? null, autonomy_level: out.autonomyLevel, required_pvt: out.requiredPvt,
        total_deposit_atomic: out.totalDepositAtomic, approve_tx_hash: out.approveTxHash, post_bond_tx_hash: out.postBondTxHash,
      };
    }
    case 'payout': {
      const requestId = str(p, 'request');
      if (requestId !== undefined) {
        const st = await institutions.payoutStatus(requestId);
        return { request_id: st.requestId, state: st.state, charge_tx_hash: st.chargeTxHash, waiting_reason: st.waitingReason, settlement: st.settlement, note: st.note };
      }
      // The latest acts reach the relay first, so the payout settles them too.
      const meter = await deps.flushMeter();
      const quote = await institutions.payoutQuote();
      if (!quote.available) {
        return { available: false, reason: quote.reason, message: quote.message, meter_flush: meter.detail, note: 'nothing was charged; standard earnings settle on a schedule Provian sets, currently every 30 days for free' };
      }
      if (!bool(p, 'yes')) {
        return {
          available: true, fee_usdc: quote.feeUsdc, ready_claims: quote.readyClaims,
          ready_record_points_atomic: quote.readyRecordPointsAtomic, estimated_gas_usd: quote.estimatedGasUsd, meter_flush: meter.detail,
          hint: 'run `provian payout --yes` to pay the $1 USDC service fee from your wallet and settle now (it is not a price for PVT)',
        };
      }
      // the relay answers once the fee is charged and settles after. Once the paid request has
      // gone out, its outcome is the request's own state: a lost or failed answer is read back by the
      // request id the payment itself fixes, never reported as an error for a payout that was charged.
      let sentPayment: string | null = null;
      const st = await agent.withKey(async (key): Promise<PayoutStatus> => {
        const paidFetch = deps.makeX402Fetch(
          agent.config.relayUrl, walletOf(key), PAYOUT_FEE_USDC_ATOMIC, provianServiceFeePin(PAYOUT_FEE_USDC_ATOMIC),
          { requestTimeoutMs: PAYOUT_REQUEST_TIMEOUT_MS, onPaymentSent: (payment) => { sentPayment = payment; } },
        );
        try {
          return await institutions.requestPayout(paidFetch);
        } catch (error) {
          const sentId = sentPayment === null ? null : payoutRequestIdOfPayment(sentPayment);
          if (sentId === null) throw error;
          const recorded = await institutions.payoutStatus(sentId).catch(() => null);
          // A request whose charge failed took no fee: the payout failed, and the error stands.
          if (recorded !== null && recorded.requestId === sentId && recorded.state !== 'charge_failed') return recorded;
          if (error instanceof ProvianError && error.code === 'X402_PAYMENT_REJECTED') throw error;
          throw new ProvianError(
            `${error instanceof Error ? error.message : String(error)}; the payment was sent as payout request ${sentId} — follow it with \`provian payout --request ${sentId}\` (if it never appears, nothing was charged)`,
            error instanceof ProvianError ? error.code : 'X402_REQUEST_FAILED',
          );
        }
      });
      return {
        request_id: st.requestId, state: st.state, charge_tx_hash: st.chargeTxHash, waiting_reason: st.waitingReason, settlement: st.settlement, note: st.note,
        ...(st.state === 'settled' || st.state === 'charge_failed' ? {} : { next_step: `provian payout --request ${st.requestId}` }),
      };
    }
    case 'archive': {
      const sub = p.positionals[0] ?? 'status';
      if (sub === 'status') {
        const st = await institutions.archiveStatus();
        const opened = deps.openPeStore();
        const local = opened.ok ? {
          state: (await opened.store.archiveState?.()) ?? null,
          dropped_days: (await opened.store.listArchivedDays?.())?.length ?? 0,
        } : null;
        return {
          wallet: st.wallet, archive: st.archive, sealed_to: st.recipients,
          this_machine: local === null ? null : describeArchiveStatus(local.state, local.dropped_days),
          hint: st.archive.on
            ? (st.archive.spaceExhausted ? 'Archive full — add 1 GB for $5: `provian archive pay --yes`. Until then new days stay on this machine; nothing is deleted.' : null)
            : 'Turn it on with `provian archive pay --yes` ($5 USDC buys the first GB, kept for as long as Provian operates the Archive).',
        };
      }
      if (sub === 'pay') {
        const quote = await institutions.archiveQuote();
        if (!quote.available) return { available: false, reason: quote.reason, message: quote.message, note: 'nothing was charged' };
        if (!bool(p, 'yes')) {
          return {
            available: true, fee_usdc: quote.feeUsdc, archive: quote.archive,
            hint: 'run `provian archive pay --yes` to pay $5 USDC from your wallet for one GB of PE Archive space, kept for as long as Provian operates the Archive',
          };
        }
        const paid = await agent.withKey(async (key) => institutions.buyArchiveGb(
          deps.makeX402Fetch(agent.config.relayUrl, walletOf(key), ARCHIVE_GB_FEE_USDC_ATOMIC, provianServiceFeePin(ARCHIVE_GB_FEE_USDC_ATOMIC)),
        ));
        return { request_id: paid.requestId, state: paid.state, credited: paid.credited, charge_tx_hash: paid.chargeTxHash, archive: paid.archive, note: paid.note };
      }
      if (sub === 'on' || sub === 'off') {
        try {
          return { archive: await institutions.setArchive(sub === 'on') };
        } catch (err) {
          if (err instanceof ProvianNetworkError && err.httpStatus === 402) {
            return { archive_on: false, reason: 'no_space_left', hint: 'buy a GB first: `provian archive pay --yes` ($5 USDC)' };
          }
          throw err;
        }
      }
      if (sub === 'run' || sub === 'upload-history' || sub === 'pull') {
        const keeper = await deps.openArchive();
        if (keeper === null) throw new ActUsageError('The PE Archive runs where this agent\'s PEs are kept: this machine has no device credentials.');
        if (sub === 'pull') {
          const day = p.positionals[1] ?? str(p, 'day');
          if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ActUsageError('Usage: provian archive pull <YYYY-MM-DD>');
          const pulled = await keeper.pullDay(day);
          if (!pulled.ok) return { day, pulled: false, reason: pulled.reason };
          return {
            day, pulled: true, parts: pulled.parts.length,
            pes: pulled.payloads.flatMap((x) => x.entries.map((e) => ({ pe_id: e.pe.pe_id, pe_hash: e.pe.pe_hash, action_type: e.pe.action_type, timestamp: e.pe.timestamp }))),
            note: 'opened and verified on this machine; present any of these with `--pe <pe_id>` (it is pulled back the same way)',
          };
        }
        const report = sub === 'upload-history' ? await keeper.uploadHistory() : await keeper.run();
        return { ...report };
      }
      throw new ActUsageError(`Usage: provian ${u}`);
    }
    case 'x402-fetch': {
      const url = p.positionals[0] ?? str(p, 'url');
      if (!url) throw new ActUsageError(`Usage: provian ${u}`);
      const max = positiveAmount(resolveAtomicAmount(p, 'max-usdc', 'max-usdc-atomic', 6), '--max-usdc');
      const guard = await deps.validateEgress(url);
      if (!guard.ok) throw new ActUsageError(`Refusing to fetch ${url}: ${guard.reason}`);
      const method = (str(p, 'method') ?? (str(p, 'data') !== undefined ? 'POST' : 'GET')).toUpperCase();
      const headers: Record<string, string> = {};
      for (const h of p.lists.header ?? []) {
        const i = h.indexOf(':');
        if (i <= 0) throw new ActUsageError(`--header must be "Name: value", got ${h}`);
        headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
      }
      const data = str(p, 'data');
      const res = await agent.withKey(async (key) => {
        const paying = deps.makeX402Fetch(agent.config.relayUrl, walletOf(key), max);
        const r = await paying(url, { method, headers, ...(data !== undefined ? { body: data } : {}) });
        const text = await r.text();
        return {
          status: r.status, ok: r.ok,
          content_type: r.headers.get('content-type'),
          payment_response: r.headers.get('payment-response') ?? r.headers.get('x-payment-response'),
          body: text.length > 65_536 ? `${text.slice(0, 65_536)}…[truncated ${text.length - 65_536} chars]` : text,
        };
      });
      return { url, method, ...res, note: 'no PE is recorded here — the payment is priced from its on-chain USDC settlement' };
    }
    case 'sign-output': {
      const file = str(p, 'file');
      const text = str(p, 'text');
      if ((file === undefined) === (text === undefined)) throw new ActUsageError(`Usage: provian ${u}`);
      // A file is signed as its exact bytes; --text as UTF-8.
      const output: Uint8Array | string = file !== undefined ? new Uint8Array(fs.readFileSync(file)) : (text as string);
      const signature = await agent.withKey(async (key) => signOutputWithWalletKey(key, output));
      return {
        hash: signature.hash,
        signature,
        header_name: OUTPUT_SIGNATURE_HEADER,
        header_value: encodeOutputSignatureHeader(signature),
        json: outputSignatureJson(signature),
        note: 'attach the header (or the JSON field) to the output you hand out; nothing is sent and no PE is recorded',
      };
    }
    default:
      throw new ActUsageError(`Unknown command ${verb}. Run: provian help`);
  }
}

/** Wait for the relay's finality floor, then record; on a record failure print the resume line. */
async function recordAfterFinality(
  deps: ActDeps,
  rpcUrl: string,
  txHash: string,
  record: () => Promise<{ peId: string; verified: boolean; idempotent: boolean }>,
  context: Record<string, unknown> & { resume: string },
): Promise<ActResult> {
  const { resume, ...rest } = context;
  try {
    const status = await deps.waitForReceipt({ chain: 'base', hash: txHash as Hex, rpcUrl, confirmations: deps.confirmations });
    if (status !== 'success') return { status: 'error', tx_hash: txHash, ...rest, error: `transaction ${txHash} reverted on-chain; nothing moved` };
    const rec = await record();
    return { tx_hash: txHash, ...rest, pe_id: rec.peId, verified: rec.verified, idempotent: rec.idempotent };
  } catch (err) {
    return {
      status: 'error', broadcast: true, tx_hash: txHash, ...rest,
      error: `${(err as Error).message} — the transaction is on-chain; record it again (never re-send): ${resume}`,
    };
  }
}

// ---------------------------------------------------------------------------
// The shell entry: scrubbed JSON out, exit code back
// ---------------------------------------------------------------------------

/** Remove the wallet key (with or without 0x) and the API secret from anything printed. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 16) continue;
    const bare = s.replace(/^0x/i, '');
    for (const needle of [bare, `0x${bare}`, bare.toLowerCase(), bare.toUpperCase()]) {
      out = out.split(needle).join('[redacted]');
    }
  }
  return out;
}

export function errorResultOf(err: unknown): ActResult {
  if (err instanceof BurnNotPresentedError) {
    return {
      status: 'error', burned: true, burn_tx: err.txHash, burn_id: err.burnId, burn_amount_atomic: err.amountAtomic,
      resume: `re-run with --burn-tx ${err.txHash} --burn-amount-atomic ${err.amountAtomic} — do not burn again`,
      error: err.message,
    };
  }
  const base: ActResult = { status: 'error', error: err instanceof Error ? err.message : String(err) };
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string') base.code = code;
  if (err instanceof ProvianNetworkError) {
    if (err.httpStatus !== null) base.http_status = err.httpStatus;
    if (err.relayCode) base.relay_code = err.relayCode;
    const presentTo = err.details?.present_to;
    if (presentTo !== undefined) {
      base.present_to = presentTo;
      base.hint = 'this write needs a live speech window: run `provian speech-window --open`';
    }
  }
  return base;
}

export interface ActIO {
  stdout(line: string): void | Promise<void>;
}

/**
 * Run one verb and print its JSON. Returns the process exit code (0 ok, 1 act failed, 2 usage,
 * 3 incomplete — `verify-export` on a file that verifies but names PEs it does not carry).
 * Everything printed — result or error — is scrubbed of the key and the API secret.
 */
export async function runActVerbCli(verb: string, args: readonly string[], deps: ActDeps = defaultActDeps(), io: ActIO = {
  stdout: (line) => new Promise<void>((resolve, reject) => {
    process.stdout.write(`${line}\n`, (error) => { if (error) reject(error); else resolve(); });
  }),
}): Promise<number> {
  const secrets: string[] = [];
  const wrapped: ActDeps = {
    ...deps,
    loadAgent: () => {
      const agent = deps.loadAgent();
      secrets.push(agent.apiSecret);
      return {
        ...agent,
        withKey: <T>(fn: (k: string) => Promise<T>) => agent.withKey((k) => {
          secrets.push(k);
          return fn(k);
        }),
      };
    },
  };
  let result: ActResult;
  let code = 0;
  try {
    result = await runActVerb(verb, args, wrapped);
    if (result && result.status === 'error') code = 1;
    else if (result && result.status === 'incomplete') code = 3;
  } catch (err) {
    result = errorResultOf(err);
    code = err instanceof ActUsageError ? 2 : 1;
  }
  // Mail the daemon delivered and the agent has not read rides every verb's output, so it reaches the
  // agent through whatever it already runs — no harness hook needed.
  try {
    const mail = (deps.mailNotice ?? (() => unreadMailNotice()))();
    if (mail && result && typeof result === 'object' && !Array.isArray(result)) result = { ...result, commons_mail: mail };
  } catch { /* the notice never fails a verb */ }
  // So does the observer's action-required notice (the startup hook prints it too): a shell that reads
  // no startup file still shows it on the agent's next provian command.
  try {
    const notice = (deps.actionNotice ?? (() => actionRequiredNotice()))();
    if (notice && result && typeof result === 'object' && !Array.isArray(result)) result = { ...result, witness_action_required: notice };
  } catch { /* the notice never fails a verb */ }
  const text = scrubSecrets(JSON.stringify(result, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2), secrets);
  secrets.length = 0;
  // One JSON object on stdout, success or failure — the exit code says which.
  // The bootstrap exits with this result. Wait for pipes to drain so large thread
  // pages retain their final messages, signatures and reply-policy fields.
  await io.stdout(text);
  return code;
}
