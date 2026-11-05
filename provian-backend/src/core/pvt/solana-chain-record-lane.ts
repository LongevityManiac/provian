/**
 * THE SOLANA CHAIN-RECORD LANE: chain-verified Solana sends, receives from a counterparty the
 * recipient has dealt with, and swaps mint at the financial base under the per-actor daily
 * ceilings, for people and agents alike, in SOL and the wallet's Solana tokens (an unknown mint never
 * mints; a swap runs through Jupiter, or a Mayan order for a cross-chain swap). A first receive from a
 * stranger records only. The Solana counterpart of `chain-record-watcher.ts` (the Base lane).
 *
 * WHO IS WATCHED. Every address in `solana_proven_addresses` (`external-address/solana-link.ts`, the
 * one Solana authority): a person's or an agent's, the Provian wallet's own native Solana address
 * (the app proves it automatically) or an external one. Its owner is resolved through the same
 * resolver the x402 facilitator lane uses (`resolveFacilitatorSolanaIdentity`), and only a
 * transaction in a slot STRICTLY after the proof's `proven_at_slot` counts for it.
 *
 * DISCOVERY — a pointer, never evidence. For each watched address, `getSignaturesForAddress` at
 * `finalized` over the address itself AND every SPL token account it owns (a token receive into an
 * existing token account does not name the owner in the transaction). Each scanned account keeps a
 * cursor (`low_slot`: every signature at or below it is done). A pass reads newest-first, page by
 * page, from the finalized slot both legs have reached down to the cursor or the landing time,
 * each leg on its own; the pass state persists, so a long history is read over several cycles and
 * never re-read. The UNION of the two legs' signatures is queued, so one operator alone cannot hide
 * a transaction; a failed leg stops the account's pass for this cycle without advancing anything.
 * Every unit of work is bounded per cycle (watched addresses, token accounts, pages, queued
 * signatures, a wall-clock budget): Cloud Run throttles CPU after the response, so nothing runs in
 * the background. Watched addresses are visited in rotation across cycles.
 *
 * VERIFICATION. Each queued (signature, address) observation is leased, the whole transaction is
 * re-read on BOTH legs (`readAgreedSolanaTransaction`: `finalized`, projected, byte-identical or
 * thrown), and must have `meta.err === null`, a block time at or after
 * `SOLANA_COMMERCE_CUT_LINE_MS`, and a slot past the address's proof. The act is derived from that
 * agreed projection alone (`solana-chain-record-derive.ts`): nothing anyone submitted is read.
 *
 * MINT-ONCE.
 * - within the lane: one observation per (signature, address), one act per transaction per address,
 *   a deterministic PE id per (action type, address, canonical event) — two signers of one
 *   transaction (an OTC swap) are separate actors and never collide — and the block time as the PE
 *   time, so a replay returns the sealed PE;
 * - the unchanged financial-settlement claim, keyed (base58 address, `solana:<sig>:<ix>`), both as
 *   exact bytes (`financial-settlement-mint-claim.ts`);
 * - across lanes: a transaction whose fee payer is Provian's x402 facilitator is that lane's
 *   settlement. Its buyer's act is `x402_payment` under a DIFFERENT claim (payer, signature), so
 *   before emitting this lane reads the facilitator's pointer and the PE it sealed for this
 *   address: a missing or pending pointer waits, a minted (or still minting) act means this lane
 *   emits nothing, and only an act sealed at zero (or no act for this address) lets it emit. A
 *   refused pointer emits nothing here.
 *
 * FENCES — none is re-implemented. The emitted act goes through `recordPEAccrual` exactly as the
 * Base lane's does (`awaitAccrual`). The same-owner fence reads EVM registries, so a counterparty
 * that is itself a proven Provian Solana identity is handed to it as its owner's live EVM address,
 * exactly as the facilitator lane does: a transfer between two Solana addresses of one owner (the
 * native and a proven external one), or to an agent linked to the same person, seals record_only. A
 * stranger is handed over as its raw base58 address, which the counterparty-pair store, receive
 * authorship and the daily ceilings all key exactly (never lowercased). Novelty decay, the
 * Provian-service-fee rule, the daily ceilings (`send` 25 with the verified-counterparty identity
 * requirement, `swap` 25, `receive` 50) and, at settlement, the epoch ceilings apply unchanged.
 */

import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { AgentBankDeps } from '../agent-bank/types';
import { generatePE } from '../agent-bank/pe-utils';
import { readActRow } from '../meter/act-row-store';
import { resolvableOrigin, chainWatcherWitness } from '../provenance/origin-capture';
import { relayObservationWitness, RELAY_WITNESS_CHAIN_WATCHER } from './relay-observation-witness';
import { isSolanaAddress, isSolanaSignature } from '../external-address/solana-keys';
import {
  SOLANA_PROVEN_ADDRESSES_COLLECTION,
  isSolanaProvenAddressRecord,
  provianSolanaServiceWallets,
  type SolanaProvenAddressRecord,
} from '../external-address/solana-link';
import {
  buildSolanaRpcLegs,
  readAgreedSolanaTransaction,
  readSolanaFinalizedSlotFloor,
  readSolanaSignaturesPage,
  readSolanaTokenAccountsUnion,
  solanaVerifierEndpointConfig,
  type SolanaAgreedTransaction,
  type SolanaRpcLegs,
  type SolanaSignaturePointer,
} from '../onchain/solana-economic-discovery';
import {
  deriveSolanaChainRecordAct,
  solanaFeePayer,
  type SolanaChainRecordAct,
  type SolanaChainRecordDerivation,
} from './solana-chain-record-derive';
import {
  FACILITATOR_SETTLEMENTS_COLLECTION,
  resolveFacilitatorSolanaIdentity,
  type FacilitatorActResult,
  type FacilitatorSolanaIdentity,
} from './x402-facilitator-lane';
import {
  FACILITATOR_SOLANA_NETWORK,
  facilitatorSettlementId,
  facilitatorSolanaFeeWallet,
} from './x402-facilitator-settlement';

// =============================================================================
// CONSTANTS
// =============================================================================

export const SOLANA_CHAIN_RECORD_OBSERVATIONS_COLLECTION = 'solana_chain_record_observations';
export const SOLANA_CHAIN_RECORD_CURSORS_COLLECTION = 'solana_chain_record_cursors';
export const SOLANA_CHAIN_RECORD_STATE_COLLECTION = 'solana_chain_record_state';
export const SOLANA_CHAIN_RECORD_ROTATION_DOC = 'rotation';
export const SOLANA_CHAIN_RECORD_OBSERVATION_SCHEMA = 'solana-chain-record-observation/v1';
export const SOLANA_CHAIN_RECORD_CURSOR_SCHEMA = 'solana-chain-record-cursor/v1';

/**
 * The landing of this lane. A Solana transaction whose block time is before this instant never
 * mints here; no record sealed before the lane existed is repriced. PLACEHOLDER: set to the actual
 * deploy instant when the lane lands.
 */
export const SOLANA_COMMERCE_CUT_LINE_MS = Date.UTC(2026, 9, 29, 0, 0, 0);

/** An observation that never becomes final (or whose cross-lane witness never appears) closes, unminted. */
export const SOLANA_CHAIN_RECORD_OBSERVATION_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
/** A signature neither leg can find an hour after it was queued is not coming. */
export const SOLANA_CHAIN_RECORD_NOT_FOUND_HORIZON_MS = 60 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
const TERMINAL_NEXT_ATTEMPT_MS = Number.MAX_SAFE_INTEGER;
const RETRY_MS = 2 * 60 * 1000;
const MAX_RETRY_MS = 30 * 60 * 1000;

/** Per-cycle bounds. Every one is a ceiling on work, never on what can mint. */
export const SOLANA_CHAIN_RECORD_LIMITS = Object.freeze({
  /** Watched addresses visited per cycle (in rotation). */
  ownersPerCycle: 15,
  /** Token accounts scanned per watched address per cycle (a window that rotates across cycles). */
  tokenAccountsPerOwner: 24,
  /** `getSignaturesForAddress` pages per leg per scanned account per cycle. */
  pagesPerLeg: 3,
  pageSize: 100,
  /** New observations queued per cycle (no further page is read once reached). */
  queuedPerCycle: 400,
  /** Observations drained per cycle. */
  drainBatch: 40,
  /** Wall-clock budget for discovery, then for the drain (no new unit starts past it). */
  discoveryBudgetMs: 45_000,
  drainBudgetMs: 60_000,
});

/** Facilitator-act statuses under which that PE minted, or will (the Base lane's set). */
const FACILITATOR_ACT_MINTING: ReadonlySet<string> = new Set([
  'eligible', 'minting', 'minted', 'beneficiary_pending', 'deferred',
  'genesis_epoch_deferred', 'epoch_headroom_deferred', 'settlement_retry_deferred',
  'corroborated_duplicate',
]);
/**
 * Facilitator-act statuses that are terminal and minted nothing, where this lane may still derive
 * the transaction's act for the address (the facilitator lane could not price it as a payment).
 */
const FACILITATOR_ACT_ZERO_TERMINAL: ReadonlySet<string> = new Set([
  'record_only', 'skipped_no_output', 'x402_unverified',
]);
/**
 * Facilitator-act statuses refused by a ceiling or an eligibility rule. The refusal stands for the
 * whole transaction: this lane never re-derives it as a send under another ceiling.
 */
const FACILITATOR_ACT_REFUSED: ReadonlySet<string> = new Set(['farm_capped', 'ineligible']);

type Env = NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;

// =============================================================================
// TYPES
// =============================================================================

/** The discovery reads (production: the two operator legs). Absent = discovery is skipped. */
export interface SolanaChainRecordDiscovery {
  readonly finalizedSlotFloor: () => Promise<number>;
  readonly tokenAccounts: (owner: string) => Promise<string[]>;
  readonly signaturesPage: (
    leg: 0 | 1,
    account: string,
    page: { readonly before: string | null; readonly limit: number },
  ) => Promise<SolanaSignaturePointer[]>;
}

export interface SolanaChainRecordEmitInput {
  readonly identity: FacilitatorSolanaIdentity;
  readonly act: SolanaChainRecordAct;
  readonly tx: SolanaAgreedTransaction & { readonly blockTimeMs: number };
  /** What the same-owner fence and the pair store read for the counterparty. */
  readonly counterpartyFenceAddress: string;
  /** A receive's fee payer, when it is another Provian identity: its owner's EVM address. */
  readonly signerFenceAddress: string | null;
}

export interface SolanaChainRecordDeps {
  readonly db: Firestore;
  readonly env?: Env;
  /** Throws when the lane cannot run (the RPC legs are not configured); the cycle then skips. */
  readonly assertConfigured?: () => void;
  readonly readTransaction: (signature: string) => Promise<SolanaAgreedTransaction | null>;
  readonly discovery?: SolanaChainRecordDiscovery;
  /** Defaults to `resolveFacilitatorSolanaIdentity`. */
  readonly resolveIdentity?: (db: Firestore, address: string) => Promise<FacilitatorSolanaIdentity | null>;
  readonly emitActPE: (input: SolanaChainRecordEmitInput) => Promise<{ readonly peId: string }>;
  /** The cycle's logical now (leases, retries, horizons). */
  readonly now?: () => number;
  /** The wall clock the budgets read. */
  readonly clock?: () => number;
}

export interface SolanaChainRecordLimits {
  readonly ownersPerCycle: number;
  readonly tokenAccountsPerOwner: number;
  readonly pagesPerLeg: number;
  readonly pageSize: number;
  readonly queuedPerCycle: number;
  readonly drainBatch: number;
  readonly discoveryBudgetMs: number;
  readonly drainBudgetMs: number;
}

export interface SolanaDiscoveryReport {
  owners: number;
  accounts: number;
  pages: number;
  queued: number;
  passes_completed: number;
  errors: number;
  wrapped: boolean;
  outcomes: Array<{ address: string; outcome: string }>;
}

export interface SolanaDrainReport {
  leased: number;
  emitted: number;
  by_type: { send: number; swap: number; receive: number };
  no_act: number;
  refused: number;
  waiting: number;
  errors: number;
  outcomes: Array<{ id: string; outcome: string }>;
}

export type SolanaChainRecordCycleReport =
  | { readonly skipped: string }
  | { readonly discovery: SolanaDiscoveryReport | { readonly skipped: string }; readonly drain: SolanaDrainReport };

// =============================================================================
// IDS
// =============================================================================

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** One observation per (signature, watched address). Exact bytes: base58 is case-sensitive. */
export function solanaChainRecordObservationId(signature: string, address: string): string {
  return `solobs_${sha256(`solana:${signature}:${address}`)}`;
}

export function solanaChainRecordCursorId(owner: string, account: string): string {
  return `solcur_${sha256(`${owner}:${account}`)}`;
}

/**
 * The deterministic act PE id, per (action type, actor address, canonical event). The address is
 * part of the key because several addresses can sign one Solana transaction and each derives its
 * own act on the same instruction; the action type keeps a sender's send and a recipient's
 * receive of one transfer apart.
 */
export function solanaChainRecordPeId(
  actionType: SolanaChainRecordAct['actionType'],
  address: string,
  canonicalEventId: string,
): string {
  return `pe_solrec_${sha256(`${actionType}:${address}:${canonicalEventId}`)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Provian's own Solana wallets plus nothing else: the derivation adds System + incinerator. */
export function solanaChainRecordExcludedCounterparties(env: Env = process.env): ReadonlySet<string> {
  return provianSolanaServiceWallets(env);
}

// =============================================================================
// OBSERVATIONS
// =============================================================================

interface ObservationDoc {
  schema_version: string;
  chain: 'solana';
  signature: string;
  address: string;
  slot: number;
  requested_at_ms: number;
  status: 'pending' | 'complete' | 'refused';
  attempts: number;
  next_attempt_at_ms: number;
  lease_until_ms: number;
}

function observationDocument(signature: string, address: string, slot: number, now: number): Record<string, unknown> {
  return {
    schema_version: SOLANA_CHAIN_RECORD_OBSERVATION_SCHEMA,
    chain: 'solana',
    signature,
    address,
    slot,
    source: 'signature_scan',
    requested_at_ms: now,
    status: 'pending',
    attempts: 0,
    next_attempt_at_ms: now,
    lease_until_ms: 0,
    last_reason: null,
    outcome: null,
  };
}

/** Queue one observation when absent (a pointer already queued is never reset). */
export async function enqueueSolanaChainRecordObservation(
  db: Firestore,
  input: { readonly signature: string; readonly address: string; readonly slot: number },
  now: number,
): Promise<boolean> {
  if (!isSolanaSignature(input.signature) || !isSolanaAddress(input.address)) {
    throw new Error('solana_chain_record_observation_invalid');
  }
  const ref = db.collection(SOLANA_CHAIN_RECORD_OBSERVATIONS_COLLECTION)
    .doc(solanaChainRecordObservationId(input.signature, input.address));
  try {
    await ref.create(observationDocument(input.signature, input.address, input.slot, now));
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 6) return false; // ALREADY_EXISTS
    throw error;
  }
}

function parseObservation(raw: unknown): ObservationDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.schema_version !== SOLANA_CHAIN_RECORD_OBSERVATION_SCHEMA
    || o.chain !== 'solana'
    || !isSolanaSignature(o.signature)
    || !isSolanaAddress(o.address)
    || !Number.isSafeInteger(o.slot)
    || typeof o.requested_at_ms !== 'number'
    || typeof o.attempts !== 'number'
    || typeof o.next_attempt_at_ms !== 'number'
    || typeof o.lease_until_ms !== 'number'
    || (o.status !== 'pending' && o.status !== 'complete' && o.status !== 'refused')) {
    return null;
  }
  return o as unknown as ObservationDoc;
}

async function lease(db: Firestore, id: string, now: number): Promise<ObservationDoc | null> {
  const ref = db.collection(SOLANA_CHAIN_RECORD_OBSERVATIONS_COLLECTION).doc(id);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const doc = snap.exists ? parseObservation(snap.data()) : null;
    if (!doc || doc.status !== 'pending' || doc.lease_until_ms > now || doc.next_attempt_at_ms > now) return null;
    txn.update(ref, { lease_until_ms: now + LEASE_MS, attempts: doc.attempts + 1 });
    return { ...doc, attempts: doc.attempts + 1 };
  });
}

async function settle(db: Firestore, id: string, update: Record<string, unknown>): Promise<void> {
  const terminal = update.status === 'complete' || update.status === 'refused';
  await db.collection(SOLANA_CHAIN_RECORD_OBSERVATIONS_COLLECTION).doc(id).update({
    lease_until_ms: 0,
    ...update,
    ...(terminal ? { next_attempt_at_ms: TERMINAL_NEXT_ATTEMPT_MS } : {}),
  });
}

function retryDelayMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 10);
  return Math.min(RETRY_MS * 2 ** exponent, MAX_RETRY_MS);
}

// =============================================================================
// CROSS-LANE: THE x402 FACILITATOR
// =============================================================================

export type SolanaFacilitatorVerdict = 'not_facilitator' | 'clear' | 'minted' | 'capped' | 'wait' | 'refused';

/**
 * Whether this lane may emit for `address` in `tx` given the x402 facilitator lane. A transaction
 * whose fee payer is not the facilitator's fee wallet is `not_facilitator`. Otherwise the
 * facilitator's pointer decides: absent / pending / unreadable → `wait`; refused → `refused`;
 * recorded → for every act it sealed for this address, a minting status → `minted`, a zero-mint
 * terminal status → clear, anything else → `wait` (Unknown = Block).
 */
export async function readSolanaFacilitatorVerdict(
  db: Firestore,
  tx: SolanaAgreedTransaction,
  address: string,
  env: Env = process.env,
): Promise<SolanaFacilitatorVerdict> {
  const feeWallet = facilitatorSolanaFeeWallet(env);
  if (feeWallet === null) return 'wait';
  if (solanaFeePayer(tx) !== feeWallet) return 'not_facilitator';
  const snap = await db.collection(FACILITATOR_SETTLEMENTS_COLLECTION)
    .doc(facilitatorSettlementId({ chain: 'solana', txHash: tx.signature }))
    .get();
  if (!snap.exists) return 'wait';
  const pointer = snap.data() as { status?: unknown; acts?: unknown };
  if (pointer.status === 'refused') return 'refused';
  if (pointer.status !== 'recorded' || !Array.isArray(pointer.acts)) return 'wait';
  let wait = false;
  for (const raw of pointer.acts as unknown[]) {
    const act = raw as Partial<FacilitatorActResult> | null;
    if (!act || act.address !== address) continue;
    if (act.recorded !== true) continue;
    if (typeof act.pe_id !== 'string') return 'wait';
    const status = (await readActRow(db, act.pe_id))?.row.mint_status;
    if (typeof status === 'string' && FACILITATOR_ACT_MINTING.has(status)) return 'minted';
    if (typeof status === 'string' && FACILITATOR_ACT_REFUSED.has(status)) return 'capped';
    if (typeof status !== 'string' || !FACILITATOR_ACT_ZERO_TERMINAL.has(status)) wait = true;
  }
  return wait ? 'wait' : 'clear';
}

// =============================================================================
// DISCOVERY
// =============================================================================

interface CursorPass {
  high_slot: number;
  before: [string | null, string | null];
  done: [boolean, boolean];
}

interface CursorDoc {
  schema_version: typeof SOLANA_CHAIN_RECORD_CURSOR_SCHEMA;
  owner_address: string;
  account: string;
  low_slot: number;
  pass: CursorPass | null;
  updated_at_ms: number;
}

function parseCursor(raw: unknown, owner: string, account: string): CursorDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (c.schema_version !== SOLANA_CHAIN_RECORD_CURSOR_SCHEMA || c.owner_address !== owner || c.account !== account
    || !Number.isSafeInteger(c.low_slot)) {
    return null;
  }
  let pass: CursorPass | null = null;
  if (c.pass !== null && c.pass !== undefined) {
    const p = c.pass as Record<string, unknown>;
    const before = p.before as unknown[];
    const done = p.done as unknown[];
    if (!Number.isSafeInteger(p.high_slot) || !Array.isArray(before) || before.length !== 2
      || !before.every((b) => b === null || isSolanaSignature(b))
      || !Array.isArray(done) || done.length !== 2 || !done.every((d) => typeof d === 'boolean')) {
      return null;
    }
    pass = { high_slot: p.high_slot as number, before: [before[0] as string | null, before[1] as string | null], done: [done[0] as boolean, done[1] as boolean] };
  }
  return {
    schema_version: SOLANA_CHAIN_RECORD_CURSOR_SCHEMA,
    owner_address: owner,
    account,
    low_slot: c.low_slot as number,
    pass,
    updated_at_ms: typeof c.updated_at_ms === 'number' ? c.updated_at_ms : 0,
  };
}

interface DiscoveryRun {
  readonly deps: SolanaChainRecordDeps;
  readonly discovery: SolanaChainRecordDiscovery;
  readonly limits: SolanaChainRecordLimits;
  readonly now: number;
  readonly deadline: number;
  readonly clock: () => number;
  readonly report: SolanaDiscoveryReport;
  finalizedFloor: number | null;
}

/**
 * Scan one account (the watched address or one of its token accounts) for `owner`. Persists the
 * cursor only after every candidate it read is queued, so a crash re-reads (and re-creates
 * nothing). Returns the outcome label.
 */
async function scanAccount(run: DiscoveryRun, owner: SolanaProvenAddressRecord, account: string): Promise<string> {
  const { deps, discovery, limits } = run;
  const ref = deps.db.collection(SOLANA_CHAIN_RECORD_CURSORS_COLLECTION).doc(solanaChainRecordCursorId(owner.address, account));
  const snap = await ref.get();
  const fence = owner.proven_at_slot;
  let cursor = snap.exists ? parseCursor(snap.data(), owner.address, account) : null;
  if (snap.exists && cursor === null) throw new Error('solana_chain_record_cursor_invalid');
  if (cursor === null) {
    cursor = {
      schema_version: SOLANA_CHAIN_RECORD_CURSOR_SCHEMA,
      owner_address: owner.address,
      account,
      low_slot: fence,
      pass: null,
      updated_at_ms: run.now,
    };
  }
  // The proof's fence is a floor: nothing at or before it is ever read for this owner.
  if (cursor.low_slot < fence) cursor = { ...cursor, low_slot: fence, pass: null };
  if (cursor.pass === null) {
    if (run.finalizedFloor === null) run.finalizedFloor = await discovery.finalizedSlotFloor();
    if (run.finalizedFloor <= cursor.low_slot) return 'up_to_date';
    cursor = { ...cursor, pass: { high_slot: run.finalizedFloor, before: [null, null], done: [false, false] } };
  }
  const pass = cursor.pass as CursorPass;
  const candidates = new Map<string, number>();
  for (const leg of [0, 1] as const) {
    let pages = 0;
    while (!pass.done[leg] && pages < limits.pagesPerLeg
      && run.report.queued + candidates.size < limits.queuedPerCycle) {
      const page = await discovery.signaturesPage(leg, account, { before: pass.before[leg], limit: limits.pageSize });
      pages += 1;
      run.report.pages += 1;
      let reachedEnd = page.length < limits.pageSize;
      for (const entry of page) {
        if (entry.slot <= cursor.low_slot) { reachedEnd = true; continue; }
        if (entry.blockTimeMs !== null && entry.blockTimeMs < SOLANA_COMMERCE_CUT_LINE_MS) { reachedEnd = true; continue; }
        if (entry.slot > pass.high_slot || !entry.succeeded) continue;
        const prior = candidates.get(entry.signature);
        candidates.set(entry.signature, prior === undefined ? entry.slot : Math.min(prior, entry.slot));
      }
      if (reachedEnd) pass.done[leg] = true;
      else pass.before[leg] = page[page.length - 1].signature;
    }
  }
  for (const [signature, slot] of candidates) {
    if (await enqueueSolanaChainRecordObservation(deps.db, { signature, address: owner.address, slot }, run.now)) {
      run.report.queued += 1;
    }
  }
  let outcome = 'pass_in_progress';
  if (pass.done[0] && pass.done[1]) {
    cursor = { ...cursor, low_slot: pass.high_slot, pass: null };
    run.report.passes_completed += 1;
    outcome = 'pass_complete';
  } else {
    cursor = { ...cursor, pass };
  }
  await ref.set({ ...cursor, updated_at_ms: run.now });
  return outcome;
}

/**
 * The token accounts of `owner` to scan this cycle: a window of at most `cap` of the sorted list,
 * rotated across cycles (the offset persists per owner), so an owner holding more accounts than the
 * cap has every one of them scanned in turn and none is skipped for good.
 */
async function nextTokenAccountWindow(
  db: Firestore,
  owner: string,
  accounts: readonly string[],
  cap: number,
  now: number,
): Promise<string[]> {
  const sorted = [...new Set(accounts)].sort();
  const size = Math.max(0, cap);
  if (sorted.length <= size) return sorted;
  const ref = db.collection(SOLANA_CHAIN_RECORD_CURSORS_COLLECTION).doc(`solown_${sha256(owner)}`);
  const snap = await ref.get();
  const stored = snap.exists ? snap.get('token_offset') : 0;
  const offset = Number.isSafeInteger(stored) && (stored as number) >= 0 ? (stored as number) % sorted.length : 0;
  const window = Array.from({ length: size }, (_, i) => sorted[(offset + i) % sorted.length]);
  await ref.set({ owner_address: owner, token_offset: (offset + size) % sorted.length, updated_at_ms: now });
  return window;
}

/**
 * Discovery for one cycle: visit up to `ownersPerCycle` watched addresses in rotation, each with
 * its token accounts. Throws only on a fault reading the registry itself; a fault on one address is
 * reported and the cycle moves on.
 */
export async function runSolanaChainRecordDiscovery(
  deps: SolanaChainRecordDeps,
  limits: SolanaChainRecordLimits = SOLANA_CHAIN_RECORD_LIMITS,
): Promise<SolanaDiscoveryReport | { readonly skipped: string }> {
  const discovery = deps.discovery;
  if (!discovery) return { skipped: 'discovery_not_configured' };
  const now = (deps.now ?? Date.now)();
  const clock = deps.clock ?? Date.now;
  const report: SolanaDiscoveryReport = {
    owners: 0, accounts: 0, pages: 0, queued: 0, passes_completed: 0, errors: 0, wrapped: false, outcomes: [],
  };
  const run: DiscoveryRun = {
    deps, discovery, limits, now, deadline: clock() + limits.discoveryBudgetMs, clock, report, finalizedFloor: null,
  };
  const stateRef = deps.db.collection(SOLANA_CHAIN_RECORD_STATE_COLLECTION).doc(SOLANA_CHAIN_RECORD_ROTATION_DOC);
  const state = await stateRef.get();
  const after = state.exists && typeof state.get('after_address') === 'string' ? state.get('after_address') as string : null;
  let query = deps.db.collection(SOLANA_PROVEN_ADDRESSES_COLLECTION).orderBy('address');
  if (after !== null) query = query.startAfter(after);
  const snap = await query.limit(Math.max(1, limits.ownersPerCycle)).get();
  let lastVisited: string | null = after;
  let visitedAll = true;
  for (const doc of snap.docs) {
    if (clock() >= run.deadline) { visitedAll = false; break; }
    lastVisited = doc.id;
    const record: unknown = doc.data();
    if (!isSolanaProvenAddressRecord(record, doc.id)) {
      report.outcomes.push({ address: doc.id, outcome: 'registry_record_invalid' });
      continue;
    }
    report.owners += 1;
    try {
      const tokenAccounts = await nextTokenAccountWindow(deps.db, record.address,
        await discovery.tokenAccounts(record.address), limits.tokenAccountsPerOwner, now);
      for (const account of [record.address, ...tokenAccounts]) {
        if (clock() >= run.deadline) break;
        report.accounts += 1;
        const outcome = await scanAccount(run, record, account);
        report.outcomes.push({ address: record.address, outcome: account === record.address ? outcome : `token_account:${outcome}` });
      }
    } catch (error) {
      report.errors += 1;
      report.outcomes.push({ address: record.address, outcome: `error:${errorText(error)}` });
    }
  }
  // A short page is the end of the registry: the next cycle starts again from the beginning.
  const wrapped = visitedAll && snap.docs.length < Math.max(1, limits.ownersPerCycle);
  report.wrapped = wrapped;
  await stateRef.set({ after_address: wrapped ? null : lastVisited, updated_at_ms: now });
  return report;
}

// =============================================================================
// DRAIN
// =============================================================================

async function processObservation(
  deps: SolanaChainRecordDeps,
  id: string,
  doc: ObservationDoc,
  now: number,
): Promise<string> {
  const env = deps.env ?? process.env;
  const retry = async (reason: string): Promise<string> => {
    if (now - doc.requested_at_ms > SOLANA_CHAIN_RECORD_OBSERVATION_HORIZON_MS) {
      await settle(deps.db, id, { status: 'refused', last_reason: reason, outcome: { reason: `horizon_expired:${reason}` } });
      return `refused:horizon_expired:${reason}`;
    }
    await settle(deps.db, id, { next_attempt_at_ms: now + retryDelayMs(doc.attempts), last_reason: reason });
    return `waiting:${reason}`;
  };
  const refuse = async (reason: string): Promise<string> => {
    await settle(deps.db, id, { status: 'refused', last_reason: reason, outcome: { reason } });
    return `refused:${reason}`;
  };
  const noAct = async (reason: string): Promise<string> => {
    await settle(deps.db, id, { status: 'complete', last_reason: reason, outcome: { reason } });
    return `no_act:${reason}`;
  };
  const resolve = deps.resolveIdentity ?? resolveFacilitatorSolanaIdentity;

  let identity: FacilitatorSolanaIdentity | null;
  try {
    identity = await resolve(deps.db, doc.address);
  } catch (error) {
    return retry(`identity_unresolvable:${errorText(error)}`);
  }
  if (identity === null) return refuse('not_a_provian_identity');
  if (identity.address !== doc.address) return retry('identity_address_mismatch');

  let tx: SolanaAgreedTransaction | null;
  try {
    tx = await deps.readTransaction(doc.signature);
  } catch (error) {
    return retry(errorText(error));
  }
  if (tx === null) {
    if (now - doc.requested_at_ms > SOLANA_CHAIN_RECORD_NOT_FOUND_HORIZON_MS) return refuse('transaction_not_found');
    return retry('transaction_not_finalized');
  }
  if (tx.signature !== doc.signature) return refuse('evidence_transaction_mismatch');
  if (tx.err !== null) return refuse('transaction_failed');
  if (tx.blockTimeMs === null) return retry('block_time_missing');
  if (tx.blockTimeMs < SOLANA_COMMERCE_CUT_LINE_MS) return refuse('before_landing');
  if (tx.slot <= identity.provenAtSlot) return refuse('before_identity_fence');

  let derivation: SolanaChainRecordDerivation;
  try {
    derivation = deriveSolanaChainRecordAct(tx, identity.address, {
      excludedCounterparties: solanaChainRecordExcludedCounterparties(env),
    });
  } catch (error) {
    // A pure function of agreed final facts: a throw can only repeat.
    return refuse(`derivation_error:${errorText(error)}`);
  }
  if (derivation.status === 'no_act') return noAct(derivation.reason);
  const act = derivation.act;

  const facilitator = await readSolanaFacilitatorVerdict(deps.db, tx, identity.address, env);
  if (facilitator === 'wait') return retry('awaiting_facilitator_lane');
  if (facilitator === 'minted') return noAct('facilitator_lane_minted');
  if (facilitator === 'refused') return noAct('facilitator_pointer_refused');
  if (facilitator === 'capped') return noAct('facilitator_lane_refused_act');

  // The fences read EVM registries: a counterparty (or a receive's fee payer) that is itself a
  // proven Provian Solana identity is handed over as its owner's live EVM address.
  let counterpartyFenceAddress = act.counterparty;
  let signerFenceAddress: string | null = null;
  try {
    const counterpartyIdentity = await resolve(deps.db, act.counterparty);
    if (counterpartyIdentity !== null) {
      if (counterpartyIdentity.address !== act.counterparty) return retry('counterparty_identity_address_mismatch');
      counterpartyFenceAddress = counterpartyIdentity.ownerEvmAddress;
    }
    const feePayer = solanaFeePayer(tx);
    if (act.actionType === 'receive' && feePayer !== act.counterparty && feePayer !== identity.address) {
      const signerIdentity = await resolve(deps.db, feePayer);
      if (signerIdentity !== null) signerFenceAddress = signerIdentity.ownerEvmAddress;
    }
  } catch (error) {
    return retry(`counterparty_unresolvable:${errorText(error)}`);
  }

  const emitted = await deps.emitActPE({
    identity,
    act,
    tx: tx as SolanaAgreedTransaction & { readonly blockTimeMs: number },
    counterpartyFenceAddress,
    signerFenceAddress,
  });
  await settle(deps.db, id, {
    status: 'complete',
    last_reason: null,
    outcome: { pe_id: emitted.peId, action_type: act.actionType, canonical_event_id: act.canonicalEventId },
  });
  return `emitted:${act.actionType}`;
}

export async function runSolanaChainRecordDrain(
  deps: SolanaChainRecordDeps,
  limits: SolanaChainRecordLimits = SOLANA_CHAIN_RECORD_LIMITS,
): Promise<SolanaDrainReport> {
  const now = (deps.now ?? Date.now)();
  const clock = deps.clock ?? Date.now;
  const deadline = clock() + limits.drainBudgetMs;
  const batch = Math.max(1, limits.drainBatch);
  const report: SolanaDrainReport = {
    leased: 0, emitted: 0, by_type: { send: 0, swap: 0, receive: 0 }, no_act: 0, refused: 0, waiting: 0, errors: 0, outcomes: [],
  };
  // READY observations only, oldest due first (a single-field range: finished ones carry
  // TERMINAL_NEXT_ATTEMPT_MS and waiting ones a future time, so neither crowds a ready one out).
  const snap = await deps.db.collection(SOLANA_CHAIN_RECORD_OBSERVATIONS_COLLECTION)
    .where('next_attempt_at_ms', '<=', now)
    .orderBy('next_attempt_at_ms')
    .limit(batch * 4)
    .get();
  const ready = snap.docs
    .map((d) => ({ id: d.id, doc: parseObservation(d.data()) }))
    .filter((r) => r.doc !== null && r.doc.status === 'pending' && r.doc.next_attempt_at_ms <= now && r.doc.lease_until_ms <= now)
    .slice(0, batch);
  for (const { id } of ready) {
    if (clock() >= deadline) break;
    let leased: ObservationDoc | null;
    try {
      leased = await lease(deps.db, id, now);
    } catch (error) {
      report.errors += 1;
      report.outcomes.push({ id, outcome: `lease_failed:${errorText(error)}` });
      continue;
    }
    if (!leased) continue;
    report.leased += 1;
    try {
      const outcome = await processObservation(deps, id, leased, now);
      report.outcomes.push({ id, outcome });
      if (outcome.startsWith('emitted:')) {
        report.emitted += 1;
        report.by_type[outcome.slice('emitted:'.length) as 'send' | 'swap' | 'receive'] += 1;
      } else if (outcome.startsWith('no_act:')) report.no_act += 1;
      else if (outcome.startsWith('refused:')) report.refused += 1;
      else report.waiting += 1;
    } catch (error) {
      // An emit that threw leaves the observation pending; the deterministic PE id makes the next
      // attempt return the sealed PE.
      report.errors += 1;
      report.outcomes.push({ id, outcome: `error:${errorText(error)}` });
      const expired = now - leased.requested_at_ms > SOLANA_CHAIN_RECORD_OBSERVATION_HORIZON_MS;
      await settle(deps.db, id, expired
        ? { status: 'refused', last_reason: errorText(error), outcome: { reason: `horizon_expired:${errorText(error)}` } }
        : { next_attempt_at_ms: now + retryDelayMs(leased.attempts), last_reason: errorText(error) })
        .catch(() => {});
    }
  }
  return report;
}

/**
 * One cycle: discovery (queue what the watched addresses' signature lists show), then the drain.
 * A discovery fault is reported and never blocks the drain. A lane whose RPC legs are not
 * configured skips entirely (nothing is leased, so no observation burns a retry).
 */
export async function runSolanaChainRecordCycle(
  deps: SolanaChainRecordDeps,
  options: { readonly limits?: Partial<SolanaChainRecordLimits> } = {},
): Promise<SolanaChainRecordCycleReport> {
  try {
    deps.assertConfigured?.();
  } catch (error) {
    return { skipped: `solana_rpc_not_configured:${errorText(error)}` };
  }
  const limits: SolanaChainRecordLimits = { ...SOLANA_CHAIN_RECORD_LIMITS, ...(options.limits ?? {}) };
  let discovery: SolanaDiscoveryReport | { readonly skipped: string };
  try {
    discovery = await runSolanaChainRecordDiscovery(deps, limits);
  } catch (error) {
    discovery = { skipped: `discovery_error:${errorText(error)}` };
  }
  const drain = await runSolanaChainRecordDrain(deps, limits);
  return { discovery, drain };
}

// =============================================================================
// PRODUCTION DEPS
// =============================================================================

/**
 * The production emit: one relay-authored PE per act through `generatePE`, on the owner's own chain,
 * keyed on the Solana anchor (`solana:<signature>:<instruction index>`). The block time is the PE
 * time. Same shape as the facilitator lane's Solana emit.
 */
export function buildSolanaChainRecordEmit(deps: AgentBankDeps): SolanaChainRecordDeps['emitActPE'] {
  return async ({ identity, act, tx, counterpartyFenceAddress, signerFenceAddress }) => {
    const witness = chainWatcherWitness(FACILITATOR_SOLANA_NETWORK);
    const derived = [
      resolvableOrigin(`solana:${act.counterparty}`, witness),
      resolvableOrigin(`chaintx:${act.canonicalEventId}`, witness),
    ];
    const emitted = await generatePE(deps, {
      walletId: identity.walletId,
      agentId: identity.agentId,
      actorAddress: identity.address,
      actionType: act.actionType,
      ownerType: identity.ownerType,
      walletAddress: identity.address,
      counterpartyAddress: counterpartyFenceAddress,
      transactionSignerAddress: signerFenceAddress,
      // A Solana transaction read by the relay at `finalized` on two legs is a chain witness.
      witnessClass: 'chain_witnessed',
      metadata: {
        tx_hash: tx.signature,
        signature: tx.signature,
        instruction_index: act.instructionIndex,
        inner_instruction_index: act.innerIndex,
        slot: tx.slot,
        chain: 'solana',
        network: FACILITATOR_SOLANA_NETWORK,
        asset: act.assetSymbol,
        token_address: act.mint,
        amount_atomic: act.amountAtomic,
        leg: act.leg,
        ...(act.swap !== undefined
          ? {
            swap_program_id: act.swap.programId,
            sold_token_address: act.swap.sold.mint,
            sold_amount_atomic: act.swap.sold.amountAtomic,
            ...(act.swap.bought === null
              ? { cross_chain: true }
              : {
                bought_token_address: act.swap.bought.mint,
                bought_amount_atomic: act.swap.bought.amountAtomic,
              }),
          }
          : {}),
        fee_payer: solanaFeePayer(tx),
        transaction_version: tx.version,
        verified: true,
        finality: 'finalized',
        economic_evidence_hash: tx.evidenceHash,
        economic_evidence_providers: [...tx.providerOperatorIds],
        activity_mapped: true,
        source_type: 'chain_record',
        record_source: 'signature_scan',
        attributed_agent_id: identity.agentId,
        external_proven: true,
        proven_address: identity.address,
        solana_address: identity.address,
        solana_address_origin: identity.origin,
        counterparty_address: act.counterparty,
        ...(counterpartyFenceAddress !== act.counterparty ? { counterparty_owner_address: counterpartyFenceAddress } : {}),
      },
      input_origins: derived,
      relayObservation: {
        witness: relayObservationWitness(RELAY_WITNESS_CHAIN_WATCHER, FACILITATOR_SOLANA_NETWORK),
        derivedOrigins: derived,
      },
      observedCanonicalEventId: act.canonicalEventId,
      peIdOverride: solanaChainRecordPeId(act.actionType, identity.address, act.canonicalEventId),
      timestampOverride: tx.blockTimeMs,
      awaitAccrual: true,
    });
    return { peId: emitted.peId };
  };
}

export function buildSolanaChainRecordDeps(
  deps: AgentBankDeps,
  options: { readonly env?: Env; readonly fetchImpl?: typeof fetch } = {},
): SolanaChainRecordDeps {
  const env = options.env ?? process.env;
  let legs: SolanaRpcLegs | null = null;
  const useLegs = (): SolanaRpcLegs => {
    if (legs === null) legs = buildSolanaRpcLegs(env, options.fetchImpl ?? fetch);
    return legs;
  };
  return {
    db: deps.db,
    env,
    assertConfigured: () => { solanaVerifierEndpointConfig(env); },
    readTransaction: (signature) => readAgreedSolanaTransaction(useLegs(), signature),
    discovery: {
      finalizedSlotFloor: () => readSolanaFinalizedSlotFloor(useLegs()),
      tokenAccounts: (owner) => readSolanaTokenAccountsUnion(useLegs(), owner),
      signaturesPage: (leg, account, page) => readSolanaSignaturesPage(useLegs()[leg], account, page),
    },
    emitActPE: buildSolanaChainRecordEmit(deps),
  };
}
