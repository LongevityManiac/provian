/**
 * Burn-to-present CLI verbs — signed challenges, the pre-burn requester
 * check, and the replay-safe verifier.
 *
 * requester side: challenge, verify, requester-key
 * presenter side: check-challenge, respond, present
 *
 * Every presenter path verifies the challenge BEFORE any burn and prints one of
 * Requester: <identity> — VERIFIED
 * Requester: <audience> — UNVERIFIED (unsigned challenge)
 * A SIGNED challenge that is invalid, expired, or addressed to another presenter
 * is REFUSED (exit non-zero) and nothing is burned (Unknown = Block).
 *
 * All protocol logic lives in @provian/agent-sdk — envelope verification
 * (`verifyChallengeEnvelope` / `CommonsInstitutions.checkChallengeBeforeBurn`), the burn +
 * present sequence (`CommonsInstitutions.respondToChallenge`), and the presentation
 * verifier (`verifyPresentationToken`, which enforces predicates-require-
 * reputation, presenter binding, the challenge deadline, and accept-once). This
 * module only parses flags, prints the requester line, and asks for confirmation.
 *
 * Human-readable lines go to stderr (deps.log); stdout stays the one JSON result
 * the bin prints, so the output can be piped.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve as resolvePath } from 'path';
import { createInterface } from 'readline';
import {
  CommonsInstitutions,
  createFileSeenStore,
  generateRequesterKey,
  isSignedChallenge,
  issuePresentationChallenge,
  normalizePredicateRequests,
  parseChallengeEnvelope,
  requesterWellKnownDocument,
  signDomainChallenge,
  verifyChallengeEnvelope,
  verifyPresentationToken,
  deriveAddressFromPrivateKey,
  loadCredentials,
  peFactFromStore,
  openLocalArchiveKeeper,
  resolveLocalPeStore,
  normalizeDisclosureRequests,
  findDisclosureRecords,
  CHALLENGE_MIN_TTL_SECONDS,
  CHALLENGE_MAX_TTL_SECONDS,
  REQUESTER_WELL_KNOWN_PATH,
  type CommonsInstitutionsConfig,
  type ChallengeEnvelope,
  type ChallengeVerdict,
  type FetchRequesterKeys,
  type ArchivedPeSource,
  type LocalPeStoreResolution,
  type PeFact,
  type PredicateRequest,
  type PresentationTier,
  type CanonicalDisclosureRequest,
  type DisclosureAnswerInput,
  type PeStore,
} from '@provian/agent-sdk';
import { loadCommonsInstitutionsConfig, missingCredentialsError } from './commons-institutions-commands';
import { resolveSovereignPrivateKey } from './sovereign-key-intake';

type CommandResult = Record<string, unknown>;
type Flags = Record<string, string | boolean>;
type Lists = Record<string, string[]>;

const DEFAULT_RELAY_URL = 'https://api.provian.ai';
/** Default kid for a domain requester key (`provian requester-key`, `provian challenge --domain`). */
export const DEFAULT_REQUESTER_KID = 'k1';

// ---------------------------------------------------------------------------
// Injectable seams (tests drive these; production uses the defaults)
// ---------------------------------------------------------------------------

export interface PresentationCliDeps {
  /** Build the CommonsInstitutions client from the env credentials. */
  makeInstitutions: (cfg: CommonsInstitutionsConfig) => CommonsInstitutions;
  /** Human-readable lines (the requester line, prompts' context). Default: stderr. */
  log: (line: string) => void;
  /** Ask a yes/no question. Only called when `isInteractive()` is true. */
  confirm: (question: string) => Promise<boolean>;
  /** True when a prompt can be answered (a TTY on stdin). */
  isInteractive: () => boolean;
  /** Home directory — the default seen-store lives at ~/.provian/presentations-seen.json. */
  homeDir: () => string;
  /** Domain-requester key source (default: the SDK's SSRF-guarded well-known fetch). */
  fetchRequesterKeys?: FetchRequesterKeys;
  /** fetch used for the Provian JWKS (default: global fetch). */
  fetchFn?: typeof fetch;
  /** stdin for --from-stdin key intake. */
  stdin?: NodeJS.ReadableStream;
  /** The presentation verifier (default: the SDK's verifyPresentationToken). */
  verifyToken: typeof verifyPresentationToken;
  /** This machine's PE store — a pe_fact carries the PE and its proof from it (the relay keeps no PE). */
  openPeStore: () => LocalPeStoreResolution;
  /**
   * This machine's paid PE Archive : a PE dropped here after its day was confirmed
   * in the Archive is pulled back, opened with the agent's key on this machine, and presented like a
   * local one. Opened only when such a PE is named. Default: from ~/.provian/credentials.
   */
  openArchive?: () => Promise<ArchivedPeSource | null>;
}

async function promptConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((r) => rl.question(question, r));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export function defaultPresentationDeps(): PresentationCliDeps {
  return {
    makeInstitutions: (cfg) => new CommonsInstitutions(cfg),
    log: (line) => console.error(line),
    confirm: promptConfirm,
    isInteractive: () => Boolean(process.stdin.isTTY),
    homeDir: () => homedir(),
    verifyToken: verifyPresentationToken,
    openPeStore: () => resolveLocalPeStore({ deviceId: loadCredentials()?.deviceId ?? null }),
    openArchive: openLocalArchiveKeeper,
  };
}

function withDefaults(deps?: Partial<PresentationCliDeps>): PresentationCliDeps {
  return { ...defaultPresentationDeps(), ...(deps ?? {}) };
}

function relayUrl(): string {
  return process.env.PROVIAN_RELAY_URL || DEFAULT_RELAY_URL;
}

function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function requireStr(flags: Flags, key: string, usage: string): string {
  const v = str(flags, key);
  if (v === undefined) throw new Error(`Missing --${key}. ${usage}`);
  return v;
}

function fail(err: unknown, extra: CommandResult = {}): CommandResult {
  return { status: 'error', ...extra, ...burnHandle(err), error: (err as Error).message };
}

/**
 * a burn that was broadcast but not presented (BurnNotPresentedError) — print its handle so
 * the operator resumes with --burn-tx instead of burning again.
 */
export function burnHandle(err: unknown): CommandResult {
  const e = err as { code?: string; txHash?: string; burnId?: string; amountAtomic?: string };
  if (e?.code !== 'BURN_NOT_PRESENTED' || !e.txHash) return {};
  return {
    burned: true,
    burn_tx: e.txHash,
    burn_id: e.burnId,
    burn_amount_atomic: e.amountAtomic,
    resume: `re-run with --burn-tx ${e.txHash} --burn-amount-atomic ${e.amountAtomic} — do not burn again`,
  };
}

// ---------------------------------------------------------------------------
// Predicate flags (item 4)
// ---------------------------------------------------------------------------

const FIELD = '([A-Za-z0-9_.-]+)';
const NUMBER_RE = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const COMPARISON_RE = new RegExp(`^\\s*${FIELD}\\s*(>=|<=|==|=|>|<)\\s*(\\S+)\\s*$`);
const MEMBERSHIP_RE = new RegExp(`^\\s*${FIELD}(?:\\s+|\\s*=\\s*)in:\\s*\\{([^}]*)\\}\\s*$`);
const OP_MAP: Record<string, PredicateRequest['op']> = { '>=': 'gte', '>': 'gt', '<=': 'lte', '<': 'lt', '=': 'eq', '==': 'eq' };

function parseNumber(tok: string, expr: string): number {
  const t = tok.trim();
  if (!NUMBER_RE.test(t)) throw new Error(`predicate "${expr}": "${t}" is not a number`);
  return Number(t);
}

/**
 * Parse one `--predicate` expression:
 *   work.total>=10   work.total>10   work.total<=10   work.total<10   work.total=10
 *   'standing.adverse_events in:{0}'   (membership in a numeric set)
 */
export function parsePredicateExpression(expr: string): PredicateRequest {
  const m = MEMBERSHIP_RE.exec(expr);
  if (m) {
    const items = m[2].split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    if (items.length === 0) throw new Error(`predicate "${expr}": in:{…} needs at least one number`);
    return { field: m[1], op: 'in', set: items.map((i) => parseNumber(i, expr)) };
  }
  const c = COMPARISON_RE.exec(expr);
  if (c) {
    if (c[3].startsWith('in:')) throw new Error(`predicate "${expr}": write membership as '<field> in:{a,b}'`);
    return { field: c[1], op: OP_MAP[c[2]], threshold: parseNumber(c[3], expr) };
  }
  throw new Error(`predicate "${expr}" is not understood — use <field><op><number> with op one of >= > <= < =, or '<field> in:{a,b}'`);
}

/** Read a flag value that is inline JSON or `@<path>` to a JSON file. */
export function readJsonArg(value: string, flagName: string): unknown {
  const text = value.startsWith('@') ? readFileSync(value.slice(1), 'utf8') : value;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`--${flagName} is not valid JSON${value.startsWith('@') ? ` (file ${value.slice(1)})` : ''}`);
  }
}

/**
 * Every predicate the caller named: `--predicates-json '[…]'` (or `@file`) first,
 * then each `--predicate <expr>` in order. Validated by the SDK's
 * normalizePredicateRequests (fail-closed: one malformed entry refuses them all).
 */
/**
 * 2026-10-10: the requester-named disclosure requests: `--disclosures-json '[…]'` (or `@file`).
 * Validated by the SDK's normalizeDisclosureRequests (fail-closed).
 */
export function collectDisclosures(flags: Flags): CanonicalDisclosureRequest[] {
  const json = str(flags, 'disclosures-json');
  if (json === undefined) return [];
  const parsed = readJsonArg(json, 'disclosures-json');
  if (!Array.isArray(parsed)) throw new Error('--disclosures-json must be a JSON array of {kind:pe, output_digest, issuer?, fields?, content?} | {kind:witness, issuer?|signer?, limit?, fields?, content?}');
  const normalized = normalizeDisclosureRequests(parsed);
  if (normalized === null) {
    throw new Error('disclosure requests are malformed (a pe request names a 64-hex output_digest; a witness request names an issuer or signer; limit 1..50; fields are dotted paths; content is description|intent|artifacts|fact_tier; at most 16)');
  }
  return normalized;
}

/**
 * 2026-10-10: the presenter's answers to a challenge's disclosure requests. Without `--disclose`
 * every request is DECLINED (signed as declined); `--disclose` elects every request, `--disclose
 * <n>[,<n>…]` elects by 0-based index; elected requests are answered from this machine's PE store.
 */
export async function collectDisclosureAnswers(flags: Flags, env: ChallengeEnvelope | undefined, deps: PresentationCliDeps): Promise<DisclosureAnswerInput[] | undefined> {
  const asked = env?.disclosures ?? [];
  if (asked.length === 0) return undefined;
  const flag = flags.disclose;
  const elected = new Set<number>();
  if (flag === true || flag === 'all' || flag === '') asked.forEach((_, i) => elected.add(i));
  else if (typeof flag === 'string') {
    for (const tok of flag.split(',')) {
      const n = Number(tok.trim());
      if (!Number.isInteger(n) || n < 0 || n >= asked.length) throw new Error(`--disclose names request #${tok.trim()}, but the challenge names ${asked.length} (0..${asked.length - 1})`);
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
      if (!opened.ok) throw new Error(`Cannot disclose: ${opened.detail}`);
      store = opened.store;
      archive = deps.openArchive ? ((await deps.openArchive()) ?? undefined) : undefined;
    }
    const found = await findDisclosureRecords(store, asked[i], archive);
    out.push({ request: asked[i], election: 'disclosed', records: found.records });
  }
  return out;
}

export function collectPredicates(flags: Flags, lists: Lists = {}): PredicateRequest[] {
  const out: PredicateRequest[] = [];
  const json = str(flags, 'predicates-json');
  if (json !== undefined) {
    const parsed = readJsonArg(json, 'predicates-json');
    if (!Array.isArray(parsed)) throw new Error('--predicates-json must be a JSON array of {field, op, threshold|set}');
    out.push(...(parsed as PredicateRequest[]));
  }
  const exprs = lists.predicate ?? (typeof flags.predicate === 'string' ? [flags.predicate] : []);
  for (const e of exprs) out.push(parsePredicateExpression(e));
  const normalized = normalizePredicateRequests(out);
  if (normalized === null) {
    throw new Error('predicates are malformed (each needs a field, op gte|gt|lte|lt|eq with a numeric threshold, or op in with a non-empty numeric set; at most 64)');
  }
  return normalized;
}

/** `--pe <pe_id>[:<pe_hash>]` (repeatable) → the tokens, syntax-checked. */
export function collectPeTokens(flags: Flags, lists: Lists = {}): string[] {
  const raw = lists.pe ?? (typeof flags.pe === 'string' ? [flags.pe] : []);
  return raw.map((entry) => {
    const token = entry.trim();
    const i = token.lastIndexOf(':');
    const peId = i === -1 ? token : token.slice(0, i);
    const hash = i === -1 ? null : token.slice(i + 1).toLowerCase();
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(peId) || (hash !== null && !/^(0x)?[0-9a-f]{64}$/.test(hash))) {
      throw new Error(`--pe "${entry}" must be <pe_id> or <pe_id>:<pe_hash> (a PE in this machine's store)`);
    }
    return hash === null ? peId : `${peId}:${hash.replace(/^0x/, '')}`;
  });
}

/**
 * PE meter: the relay keeps no PE, so a pe_fact carries the PE itself and its two-hop inclusion
 * proof, both from THIS machine's store. A PE not held here, not batched, or whose day is not yet
 * anchored on Base cannot be presented, and is refused before anything is burned or signed.
 */
export async function resolvePeFacts(tokens: readonly string[], deps: Pick<PresentationCliDeps, 'openPeStore' | 'openArchive'>): Promise<PeFact[]> {
  if (tokens.length === 0) return [];
  const opened = deps.openPeStore();
  if (!opened.ok) throw new Error(`Cannot present PEs: ${opened.detail}`);
  const facts: PeFact[] = [];
  let archive: ArchivedPeSource | undefined;
  for (const token of tokens) {
    const peId = token.split(':')[0];
    if (archive === undefined && deps.openArchive && (await opened.store.findPe(peId)) === null && (await opened.store.findArchived?.(peId))) {
      archive = (await deps.openArchive()) ?? undefined;
    }
    const r = await peFactFromStore(opened.store, token, archive);
    if (!r.ok) throw new Error(`Cannot present: ${r.detail}`);
    facts.push(r.fact);
  }
  return facts;
}

function parseTtl(flags: Flags): number | undefined {
  const raw = str(flags, 'ttl');
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < CHALLENGE_MIN_TTL_SECONDS || n > CHALLENGE_MAX_TTL_SECONDS) {
    throw new Error(`--ttl must be a whole number of seconds from ${CHALLENGE_MIN_TTL_SECONDS} to ${CHALLENGE_MAX_TTL_SECONDS}`);
  }
  return n;
}

function parseTier(flags: Flags): PresentationTier | undefined {
  const t = flags.tier;
  if (t === undefined) return undefined;
  if (t === 'reputation' || t === 'pe_fact') return t;
  throw new Error('--tier must be reputation or pe_fact');
}

/**
 * Parse `--challenge-json` (inline JSON or @file). Accepts the bare wire
 * envelope or the object `provian challenge` prints (whose `challenge` field is
 * the envelope). Structural only — the caller verifies it.
 */
export function parseChallengeArg(value: string): ChallengeEnvelope {
  let obj = readJsonArg(value, 'challenge-json');
  if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
    const inner = (obj as Record<string, unknown>).challenge;
    if (typeof inner === 'object' && inner !== null && !Array.isArray(inner)) obj = inner;
  }
  const env = parseChallengeEnvelope(obj);
  if (!env) throw new Error('--challenge-json is not a well-formed challenge ({audience, challenge, predicates?} or a signed provian-challenge-v1 envelope)');
  return env;
}

// ---------------------------------------------------------------------------
// The requester line (A.3) — printed on every presenter path before any burn
// ---------------------------------------------------------------------------

export function requesterLine(v: ChallengeVerdict): string {
  switch (v.status) {
    case 'verified':
      return v.requester.type === 'wallet'
        ? `Requester: ${v.requester.id} (${v.requester.address}) — VERIFIED`
        : `Requester: ${v.requester.id} — VERIFIED`;
    case 'unverified':
      return `Requester: ${v.envelope.audience} — UNVERIFIED (unsigned challenge)`;
    case 'expired':
      return `Requester: ${v.requester.id} — REFUSED (challenge expired; nothing burned)`;
    case 'not_addressed':
      return `Requester: ${v.requester.id} — REFUSED (challenge is addressed to a different presenter; nothing burned)`;
    default:
      return `Requester: ${v.envelope?.audience ?? 'unknown'} (claimed) — REFUSED (invalid signed challenge: ${v.reason}; nothing burned)`;
  }
}

function isChallengeRefused(err: unknown): err is Error & { verdict: ChallengeVerdict; declined: boolean } {
  return typeof err === 'object' && err !== null
    && ((err as { code?: string }).code === 'CHALLENGE_REFUSED' || (err as Error).name === 'ChallengeRefusedError')
    && typeof (err as { verdict?: unknown }).verdict === 'object';
}

function refusalResult(err: Error & { verdict: ChallengeVerdict; declined: boolean }, deps: PresentationCliDeps, declineNote?: string): CommandResult {
  const v = err.verdict;
  const line = requesterLine(v);
  if (err.declined) {
    return {
      status: 'error',
      refused: true,
      declined: true,
      burned: false,
      requester: line,
      verdict: v.status,
      error: declineNote ?? 'Declined — nothing was burned.',
    };
  }
  deps.log(line);
  return {
    status: 'error',
    refused: true,
    burned: false,
    requester: line,
    verdict: v.status,
    ...(v.status === 'invalid' ? { reason: v.reason } : {}),
    error: `${line}`,
  };
}

// ---------------------------------------------------------------------------
// provian challenge — issue a SIGNED challenge (requester step 1)
// ---------------------------------------------------------------------------

export async function cmdPresentationChallenge(flags: Flags, lists: Lists = {}, depsIn?: Partial<PresentationCliDeps>): Promise<CommandResult> {
  if (flags.help) {
    printPresentationHelp();
    return null as unknown as CommandResult;
  }
  const deps = withDefaults(depsIn);
  try {
    const predicates = collectPredicates(flags, lists);
    const disclosures = collectDisclosures(flags);
    const ttlSeconds = parseTtl(flags);
    const presenter = str(flags, 'presenter');
    const audience = str(flags, 'audience');
    const unsigned = flags.unsigned === true;
    const domainRaw = str(flags, 'domain');
    const keyFile = str(flags, 'key-file');

    let env: ChallengeEnvelope;
    let signer: string;
    if (domainRaw !== undefined || keyFile !== undefined) {
      if (unsigned) throw new Error('--unsigned cannot be combined with --domain/--key-file');
      if (domainRaw === undefined || keyFile === undefined) {
        throw new Error('Domain signing needs both --domain <host> and --key-file <pem> (make one with: provian requester-key --domain <host> --out <path>)');
      }
      const domain = domainRaw.toLowerCase();
      if (audience !== undefined && audience !== domain) throw new Error('A domain-signed challenge\'s audience is the domain itself (drop --audience)');
      const kid = str(flags, 'kid') ?? DEFAULT_REQUESTER_KID;
      const privateKeyPem = readFileSync(keyFile, 'utf8');
      env = issuePresentationChallenge({ requester: { domain, kid, privateKeyPem }, predicates, ...(disclosures.length > 0 ? { disclosures } : {}), presenter, ttlSeconds });
      signer = `${domain} — SIGNED (domain key ${kid}; presenters verify it at https://${domain}${REQUESTER_WELL_KNOWN_PATH})`;
    } else if (unsigned) {
      const aud = audience ?? process.env.PROVIAN_AGENT_WALLET_ID;
      if (!aud) throw new Error('An --unsigned challenge needs --audience <your-id>');
      env = issuePresentationChallenge({ audience: aud, predicates, ...(disclosures.length > 0 ? { disclosures } : {}), presenter, ttlSeconds });
      signer = 'UNSIGNED — presenters will see this challenge as UNVERIFIED (anyone could have issued it)';
    } else {
      const cfg = loadCommonsInstitutionsConfig();
      if (!cfg) {
        return {
          ...missingCredentialsError(),
          error: `${String(missingCredentialsError().error)} Or sign as a domain with --domain <host> --key-file <pem> (no Provian account), or pass --unsigned.`,
        };
      }
      const bank = deps.makeInstitutions(cfg);
      env = await bank.issuePresentationChallenge({ predicates, ...(disclosures.length > 0 ? { disclosures } : {}), presenter, ttlSeconds, ...(audience !== undefined ? { audience } : {}) });
      signer = `${cfg.walletId}${env.requester?.address ? ` (${env.requester.address})` : ''} — SIGNED (wallet-signed by the Provian relay)`;
    }

    const signed = isSignedChallenge(env);
    deps.log(`Challenge: ${signer}`);
    if (flags['envelope-only'] === true) return env as unknown as CommandResult;
    return {
      status: 'ok',
      signed,
      requester: signer,
      expires_at: env.expiresAt ?? null,
      next: 'Hand the "challenge" object (the wire envelope) to the presenter over any channel; keep it for: provian verify --token <token> --challenge-json <this JSON>',
      challenge: env,
    };
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------------------
// provian check-challenge — the pre-burn verdict, no burn (presenter)
// ---------------------------------------------------------------------------

export async function cmdCheckChallenge(flags: Flags, _lists: Lists = {}, depsIn?: Partial<PresentationCliDeps>): Promise<CommandResult> {
  if (flags.help) {
    printPresentationHelp();
    return null as unknown as CommandResult;
  }
  const deps = withDefaults(depsIn);
  try {
    const env = parseChallengeArg(requireStr(flags, 'challenge-json', 'Usage: provian check-challenge --challenge-json <json|@file> [--as <your-address>]'));
    let presenterAddress = str(flags, 'as');
    if (presenterAddress === undefined && process.env.PROVIAN_AGENT_PRIVATE_KEY) {
      presenterAddress = deriveAddressFromPrivateKey(process.env.PROVIAN_AGENT_PRIVATE_KEY);
    }
    const verdict = await verifyChallengeEnvelope(env, {
      relayUrl: relayUrl(),
      ...(deps.fetchRequesterKeys ? { fetchRequesterKeys: deps.fetchRequesterKeys } : {}),
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      ...(presenterAddress ? { presenterAddress } : {}),
    });
    const line = requesterLine(verdict);
    deps.log(line);
    const refused = verdict.status === 'invalid' || verdict.status === 'expired' || verdict.status === 'not_addressed';
    const predicates = env.predicates ?? [];
    return {
      status: refused ? 'error' : 'ok',
      verdict: verdict.status,
      ...(verdict.status === 'invalid' ? { reason: verdict.reason } : {}),
      requester: line,
      audience: env.audience,
      predicates,
      disclosures: env.disclosures ?? [],
      tier: predicates.length > 0 || (env.disclosures ?? []).length > 0 ? 'reputation (the challenge names predicates / disclosure requests)' : 'pe_fact or reputation',
      expires_at: env.expiresAt ?? null,
      addressed_to: env.presenter ?? null,
      ...(env.presenter && !presenterAddress ? { note: 'The challenge names a presenter; pass --as <your-address> (or set PROVIAN_AGENT_PRIVATE_KEY) to check it is you.' } : {}),
      burned: false,
      ...(refused ? { error: line } : {}),
    };
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------------------
// provian respond — verify → requester line → confirm → burn → present
// ---------------------------------------------------------------------------

export async function cmdRespond(flags: Flags, lists: Lists = {}, depsIn?: Partial<PresentationCliDeps>): Promise<CommandResult> {
  if (flags.help) {
    printPresentationHelp();
    return null as unknown as CommandResult;
  }
  const deps = withDefaults(depsIn);
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const env = parseChallengeArg(requireStr(flags, 'challenge-json', 'Usage: provian respond --challenge-json <json|@file> [--tier reputation|pe_fact] [--pe <pe_id>]... [--yes]'));
    const tierFlag = parseTier(flags);
    const peTokens = collectPeTokens(flags, lists);
    const predicates = env.predicates ?? [];
    const askedDisclosures = env.disclosures ?? [];
    const tier: PresentationTier = tierFlag ?? (predicates.length > 0 || askedDisclosures.length > 0 ? 'reputation' : 'pe_fact');
    if (tier === 'pe_fact' && predicates.length > 0) {
      throw new Error('This challenge names predicates, which only the reputation tier answers — drop --tier pe_fact.');
    }
    if (tier === 'pe_fact' && askedDisclosures.length > 0) {
      throw new Error('This challenge names disclosure requests, which only the reputation tier answers — drop --tier pe_fact.');
    }
    if (tier === 'pe_fact' && peTokens.length === 0) {
      throw new Error('A pe_fact presentation presents specific PEs: pass --pe <pe_id> (repeatable; a PE in this machine\'s store — `provian pes`), or --tier reputation.');
    }
    const peFacts = await resolvePeFacts(peTokens, deps);
    const disclosures = await collectDisclosureAnswers(flags, env, deps);
    const rpcUrl = str(flags, 'rpc-url') ?? (process.env.PROVIAN_BASE_RPC_URL || '');
    if (!rpcUrl) throw new Error('Set --rpc-url (or PROVIAN_BASE_RPC_URL) — a Base RPC to broadcast the burn.');
    // resume: a burn already broadcast for this (printed by an earlier run) — present it, never burn again.
    const burnTxHash = str(flags, 'burn-tx');
    const burnTxAmount = str(flags, 'burn-amount-atomic');
    if (burnTxHash && !burnTxAmount) throw new Error('--burn-tx needs --burn-amount-atomic');
    if (burnTxAmount && !/^[1-9][0-9]*$/.test(burnTxAmount)) throw new Error('--burn-amount-atomic must be a positive atomic integer');

    const fromStdin = flags['from-stdin'] === true || flags['from-stdin'] === 'true';
    const privateKeyHex = await resolveSovereignPrivateKey(flags, deps.stdin);
    if (!privateKeyHex) {
      throw new Error('Set PROVIAN_AGENT_PRIVATE_KEY (or pass --from-stdin and pipe the key) — the sovereign key that burns and signs. It is never accepted on argv.');
    }
    const yes = flags.yes === true;
    const canPrompt = !fromStdin && deps.isInteractive();
    let declineNote: string | undefined;
    let line = '';

    const bank = deps.makeInstitutions(cfg);
    try {
      const out = await bank.respondToChallenge(env, {
        privateKeyHex,
        rpcUrl,
        tier,
        ...(burnTxHash && burnTxAmount ? { burnTx: { txHash: burnTxHash, amountAtomic: burnTxAmount } } : {}),
        ...(!burnTxHash && burnTxAmount ? { burnAmountAtomic: burnTxAmount } : {}),
        ...(peFacts.length > 0 ? { peFacts } : {}),
        ...(disclosures ? { disclosures } : {}),
        ...(deps.fetchRequesterKeys ? { fetchRequesterKeys: deps.fetchRequesterKeys } : {}),
        // Called with an ACCEPTABLE verdict (verified / unverified) BEFORE the burn.
        onRequester: async (verdict) => {
          line = requesterLine(verdict);
          deps.log(line);
          if (yes) return true;
          if (!canPrompt) {
            declineNote = 'Confirmation required before burning PVT: re-run with --yes (a non-interactive shell or --from-stdin cannot answer the prompt). Nothing was burned.';
            return false;
          }
          const ok = await deps.confirm(`Burn PVT (the ${tier} floor) and present to this requester? [y/N] `);
          if (!ok) declineNote = 'Declined at the prompt — nothing was burned.';
          return ok;
        },
      });
      return {
        status: 'ok',
        requester: line || requesterLine(out.requesterVerdict),
        verdict: out.requesterVerdict.status,
        tier: out.tier,
        token: out.token,
        presentation_id: out.burnId,
        burn_id: out.burnId,
        burn_tx: out.txHash,
        burn_amount_atomic: out.burnAmountAtomic,
        ...(disclosures ? { disclosures: disclosures.map((d) => ({ request: d.request, election: d.election, records: (d.records ?? []).length })) } : {}),
      };
    } catch (err) {
      if (isChallengeRefused(err)) return refusalResult(err, deps, declineNote);
      throw err;
    }
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------------------
// provian present — present against an existing burn (verifies first)
// ---------------------------------------------------------------------------

export async function cmdPresent(flags: Flags, lists: Lists = {}, depsIn?: Partial<PresentationCliDeps>): Promise<CommandResult> {
  if (flags.help) {
    printPresentationHelp();
    return null as unknown as CommandResult;
  }
  const deps = withDefaults(depsIn);
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const privateKeyHex = await resolveSovereignPrivateKey(flags, deps.stdin);
    if (!privateKeyHex) {
      return { status: 'error', error: 'Set PROVIAN_AGENT_PRIVATE_KEY (or pass --from-stdin and pipe the key) — the sovereign key that signs the presentation binding. It is never accepted on argv.' };
    }
    const burnId = requireStr(flags, 'burn-id', 'Usage: provian present --burn-id <id> --challenge-json <json|@file> [--tier pe_fact|reputation] [--pe <pe_id>]...');
    const envRaw = str(flags, 'challenge-json');
    const env = envRaw !== undefined ? parseChallengeArg(envRaw) : undefined;
    const audienceFlag = str(flags, 'audience');
    const challengeFlag = str(flags, 'challenge');
    if (env) {
      if (audienceFlag !== undefined && audienceFlag !== env.audience) throw new Error('--audience does not match the challenge envelope');
      if (challengeFlag !== undefined && challengeFlag !== env.challenge) throw new Error('--challenge does not match the challenge envelope');
    }
    const audience = env?.audience ?? requireStr(flags, 'audience', 'Pass --challenge-json <envelope> (preferred), or --audience + --challenge for a legacy unsigned challenge');
    const challenge = env?.challenge ?? requireStr(flags, 'challenge', 'The challenge the requester issued');
    const predicates = env?.predicates ?? [];
    const askedDisclosures = env?.disclosures ?? [];
    const tier: PresentationTier = parseTier(flags) ?? (predicates.length > 0 || askedDisclosures.length > 0 ? 'reputation' : 'pe_fact');
    if (tier === 'pe_fact' && predicates.length > 0) {
      throw new Error('This challenge names predicates, which only the reputation tier answers — drop --tier pe_fact.');
    }
    if (tier === 'pe_fact' && askedDisclosures.length > 0) {
      throw new Error('This challenge names disclosure requests, which only the reputation tier answers — drop --tier pe_fact.');
    }
    const disclosures = await collectDisclosureAnswers(flags, env, deps);
    const peTokens = collectPeTokens(flags, lists);
    if (tier === 'pe_fact' && peTokens.length === 0) {
      throw new Error('A pe_fact presentation presents specific PEs: pass --pe <pe_id> (repeatable; a PE in this machine\'s store — `provian pes`), or --tier reputation.');
    }
    const peFacts = await resolvePeFacts(peTokens, deps);

    const bank = deps.makeInstitutions(cfg);
    // Verify BEFORE presenting (presenting consumes the burn). Refused → throws, nothing consumed.
    const probe: ChallengeEnvelope = env ?? { audience, challenge };
    let verdict: ChallengeVerdict;
    try {
      verdict = await bank.checkChallengeBeforeBurn(probe, {
        privateKeyHex,
        ...(deps.fetchRequesterKeys ? { fetchRequesterKeys: deps.fetchRequesterKeys } : {}),
      });
    } catch (err) {
      if (isChallengeRefused(err)) return refusalResult(err, deps);
      throw err;
    }
    const line = requesterLine(verdict);
    deps.log(line);

    const out = await bank.present({
      privateKeyHex,
      tier,
      burnId,
      audience,
      challenge,
      ...(tier === 'pe_fact' ? { peFacts } : { disclosure: { redact: [], predicates: [...predicates] }, ...(disclosures ? { disclosures } : {}) }),
      ...(env && isSignedChallenge(env) ? { challengeEnvelope: env, requesterVerdict: verdict } : {}),
    });
    return { status: 'ok', requester: line, verdict: verdict.status, tier: out.tier, token: out.token, presentation_id: burnId, ...(disclosures ? { disclosures: disclosures.map((d) => ({ request: d.request, election: d.election, records: (d.records ?? []).length })) } : {}) };
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------------------
// provian verify — trustless, accept-once, on-chain by default (requester step 2)
// ---------------------------------------------------------------------------

export function defaultSeenStorePath(deps: Pick<PresentationCliDeps, 'homeDir'>): string {
  return join(deps.homeDir(), '.provian', 'presentations-seen.json');
}

export async function cmdVerifyPresentation(flags: Flags, lists: Lists = {}, depsIn?: Partial<PresentationCliDeps>): Promise<CommandResult> {
  if (flags.help) {
    printPresentationHelp();
    return null as unknown as CommandResult;
  }
  const deps = withDefaults(depsIn);
  try {
    const token = requireStr(flags, 'token', 'Usage: provian verify --token <token> --challenge-json <the challenge you issued> (or --audience <id> --challenge <nonce>)');
    const envRaw = str(flags, 'challenge-json');
    const env = envRaw !== undefined ? parseChallengeArg(envRaw) : undefined;
    const audience = str(flags, 'audience');
    const challenge = str(flags, 'challenge');
    if (!env && (audience === undefined || challenge === undefined)) {
      throw new Error('Pass --challenge-json <the challenge you issued>, or both --audience and --challenge.');
    }
    const predicates = collectPredicates(flags, lists);
    const expectedPresenter = str(flags, 'expected-presenter');
    const acceptOnce = flags['accept-again'] !== true;
    const seenPath = str(flags, 'seen-store') ?? defaultSeenStorePath(deps);
    const requireOnchain = flags['no-onchain'] !== true;
    const rpcUrl = str(flags, 'rpc-url') ?? (process.env.PROVIAN_BASE_RPC_URL || undefined);

    const result = await deps.verifyToken(token, {
      ...(env ? { challenge: env } : {}),
      ...(audience !== undefined ? { expectedAudience: audience } : {}),
      ...(challenge !== undefined ? { expectedChallenge: challenge } : {}),
      ...(predicates.length > 0 ? { expectedPredicates: predicates } : {}),
      ...(expectedPresenter !== undefined ? { expectedPresenter } : {}),
      jwksUrl: `${relayUrl()}/v1/present/jwks`,
      ...(rpcUrl ? { rpcUrl } : {}),
      requireOnchain,
      acceptOnce,
      ...(acceptOnce ? { seenStore: createFileSeenStore(seenPath) } : {}),
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
    });
    if (!result.valid) {
      return {
        status: 'error',
        valid: false,
        reason: result.reason,
        error: result.reason === 'replayed'
          ? `presentation refused: replayed — this presentation was already accepted (seen-store ${seenPath}); pass --accept-again to re-check without the replay guard`
          : `presentation refused: ${result.reason}`,
      };
    }
    return {
      status: 'ok',
      valid: true,
      presentation_id: result.presentationId,
      tier: result.tier,
      presenter_address: result.presenterAddress,
      sub: result.sub,
      requester: result.requester,
      challenge_expires_at: result.challengeExpiresAt,
      onchain_checked: result.onchainChecked,
      ...(result.predicates ? { predicates: result.predicates } : {}),
      ...(result.standing ? { standing: result.standing } : {}),
      accepted_once: acceptOnce,
      ...(acceptOnce ? { seen_store: seenPath } : { note: '--accept-again: the replay guard was OFF for this check' }),
      ...(!requireOnchain ? { onchain_note: '--no-onchain: the pe_fact anchor was NOT checked on Base' } : {}),
    };
  } catch (err) {
    return fail(err, { valid: false });
  }
}

// ---------------------------------------------------------------------------
// provian requester-key — a domain requester's Ed25519 key (no Provian account)
// ---------------------------------------------------------------------------

export async function cmdRequesterKey(flags: Flags, _lists: Lists = {}, depsIn?: Partial<PresentationCliDeps>): Promise<CommandResult> {
  if (flags.help) {
    printPresentationHelp();
    return null as unknown as CommandResult;
  }
  const deps = withDefaults(depsIn);
  try {
    const domain = requireStr(flags, 'domain', 'Usage: provian requester-key --domain <host> [--kid k1] --out <path>').toLowerCase();
    const out = resolvePath(requireStr(flags, 'out', 'Where to write the private key (PEM, mode 0600)'));
    const kid = str(flags, 'kid') ?? DEFAULT_REQUESTER_KID;
    const force = flags.force === true;
    if (existsSync(out) && !force) throw new Error(`${out} already exists — refusing to overwrite a key (pass --force to replace it)`);

    const key = generateRequesterKey({ kid });
    // Validate the domain with the SDK's own rule by signing a throwaway challenge BEFORE
    // anything is written (throws on a non-hostname).
    const now = Math.floor(Date.now() / 1000);
    signDomainChallenge({ domain, kid, privateKeyPem: key.privateKeyPem, challenge: '0'.repeat(64), issuedAt: now, expiresAt: now + 900 });

    mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
    writeFileSync(out, key.privateKeyPem, { mode: 0o600, flag: force ? 'w' : 'wx' });
    chmodSync(out, 0o600); // an overwritten file keeps its old mode; pin it.
    const doc = requesterWellKnownDocument([key.publicJwk]);
    const publishAt = `https://${domain}${REQUESTER_WELL_KNOWN_PATH}`;
    deps.log(`Publish this at ${publishAt} (application/json, no redirects):`);
    deps.log(JSON.stringify(doc, null, 2));
    return {
      status: 'ok',
      domain,
      kid,
      key_file: out,
      key_file_mode: '0600',
      publish_at: publishAt,
      well_known_document: doc,
      next: `provian challenge --domain ${domain} --key-file ${out} --kid ${kid}`,
    };
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export function printPresentationHelp(): void {
  console.log(`Burn-to-present — the counterparty trust loop.

The requester asks with a SIGNED challenge; the presenter checks who is asking,
then proves by burning PVT; the requester verifies (once).

Most requesters are gates and counterparties Provian does not run; they need no
Provian account and do not register with Provian. Provian proves the presentation
is real; the gate decides what it grants, how long it trusts the presenter, and
when it asks again. One presentation opens the relationship, not one per transaction.

REQUESTER
  provian challenge [--predicate <expr>]... [--predicates-json <json|@file>]
                    [--presenter <0x address>] [--ttl <seconds>]
      Issue a challenge and print it as JSON. Hand the "challenge" object (the wire
      envelope) to the presenter over any channel. It is SIGNED:
        default                      wallet-signed by the Provian relay (needs agent
                                     credentials: PROVIAN_API_KEY/SECRET/AGENT_WALLET_ID);
                                     the audience is your wallet id
        --domain <host> --key-file <pem> [--kid k1]
                                     domain-signed locally with your own key — no
                                     Provian account (make the key with requester-key)
        --unsigned --audience <id>   UNSIGNED — presenters see it as UNVERIFIED
      --presenter addresses it to one presenter; --ttl 60..604800 (default 900).
      --envelope-only prints just the wire envelope.

  provian requester-key --domain <host> [--kid k1] --out <path> [--force]
      Generate a domain requester's Ed25519 key. Writes the private PEM with mode
      0600 and prints the document to publish at
      https://<host>/.well-known/provian-requester.json (to rotate, publish the new
      key beside the old one).

  provian verify --token <token> --challenge-json <json|@file>
                 [--expected-presenter <0x address|wallet id>] [--predicate <expr>]...
                 [--rpc-url <Base RPC>] [--no-onchain] [--accept-again]
      Verify a presentation. TRUSTLESS, no credentials. --challenge-json (the
      challenge you issued) fills audience, challenge, predicates, presenter,
      deadline and requester; or pass --audience + --challenge (+ --predicate).
      ACCEPTS ONCE: a presentation already accepted is refused "replayed"
      (remembered in ~/.provian/presentations-seen.json; --seen-store <path> to
      move it, --accept-again to disable). pe_fact is checked ON-CHAIN on Base by
      default (--rpc-url, default https://mainnet.base.org; --no-onchain opts out).
      Predicates are answered only by the reputation tier. Prints presentation_id,
      requester, predicate results, and standing. Exits non-zero when refused.

PRESENTER (every path verifies the challenge BEFORE any burn)
  provian check-challenge --challenge-json <json|@file> [--as <your 0x address>]
      Show who is asking — no burn:
        Requester: <identity> — VERIFIED
        Requester: <audience> — UNVERIFIED (unsigned challenge)
      A signed challenge that is invalid, expired, or addressed to someone else is
      REFUSED (exit non-zero).

  provian respond --challenge-json <json|@file> [--tier reputation|pe_fact]
                  [--pe <pe_id>]... --rpc-url <Base RPC> [--yes]
      verify → print the requester → confirm (skip with --yes) → burn the tier
      floor → present. Prints the token, presentation_id, and the burn tx. Tier
      defaults to reputation when the challenge names predicates, else pe_fact
      (which needs --pe). Refusals exit non-zero and never burn.
      --pe names a PE in THIS machine's store (\`provian pes\`): the relay keeps no
      PE, so the presentation carries the PE and its proof into the day's root on
      Base. Only a PE whose day is anchored can be presented.

  provian present --burn-id <id> --challenge-json <json|@file>
                  [--tier pe_fact|reputation] [--pe <pe_id>]...
      Present against a burn you already made (provian burn). Verifies the
      challenge first. Legacy: --audience + --challenge instead of --challenge-json
      (shown UNVERIFIED).

  respond / present sign with the sovereign key from PROVIAN_AGENT_PRIVATE_KEY or
  --from-stdin (never argv) and need agent credentials.

PREDICATES (--predicate, repeatable; quote them in the shell)
  'work.total>=10'  'work.total>10'  'work.total<=10'  'work.total<10'  'work.total=10'
  'standing.adverse_events in:{0}'   (membership in a numeric set)
  maps to ops gte, gt, lte, lt, eq, in. Or --predicates-json
  '[{"field":"work.total","op":"gte","threshold":10}]' (or @file).

The presentation binds to the exact (audience, challenge) you issued and is
accepted once, so it can never be replayed to another requester or moment.`);
}
