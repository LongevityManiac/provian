/**
 * Durable admission state for addresses discovered by chain-global watchers.
 *
 * A global block checkpoint alone is insufficient: an address can be proven
 * after the watched set is enumerated but before that checkpoint advances. The
 * next run must therefore backfill the new address from its economic eligibility
 * fence through the already-committed global checkpoint before it is allowed to
 * participate in the normal global scan.
 */

import crypto from 'crypto';
import type {
  DocumentReference,
  Firestore,
  Transaction,
} from 'firebase-admin/firestore';
import { recordWatchRegistryEntry, removeWatchMarkInTransaction } from './watch-registry';

export const WATCHER_ADDRESS_ADMISSION_COLLECTION = 'pvt_watcher_address_admissions_v1';
export const INBOUND_WATCHER_CHECKPOINT_COLLECTION = 'genesis_inbound_checkpoints';
const ADMISSION_SCHEMA = 'pvt-watcher-address-admission/v2';
const REGISTRATION_FENCED_ADMISSION_SCHEMA = 'pvt-watcher-address-admission/v3';

export type WatcherDirection = 'inbound' | 'outbound';
export type WatcherAdmissionState = 'backfilling' | 'live';

export interface WatcherAddressAdmissionTarget {
  direction: WatcherDirection;
  chainId: number;
  address: string;
  walletId: string;
  agentId: string;
  eligibilityStartBlock: number;
}

export interface WatcherAddressAdmissionDocument {
  schema_version: typeof ADMISSION_SCHEMA | typeof REGISTRATION_FENCED_ADMISSION_SCHEMA;
  direction: WatcherDirection;
  chain_id: number;
  address: string;
  wallet_id: string;
  agent_id: string;
  eligibility_start_block: number;
  state: WatcherAdmissionState;
  backfill_next_block: number;
  catch_up_through_block: number;
  /** Membership generation at which this address last entered `live`.
   *  A global checkpoint may advance only while this generation is unchanged,
   *  so the address document plus checkpoint generation durably proves that
   *  every live address was present in the committed scan snapshot. */
  membership_generation: number;
  /** v3 only: registration already incremented the global generation, so the
   * later backfill-to-live transition must not increment it a second time. */
  generation_fenced_at_registration?: true;
  revision: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface WatcherCheckpointSnapshot {
  lastProcessedBlock: number | null;
  membershipGeneration: number;
}

interface ParsedWatcherCheckpoint extends WatcherCheckpointSnapshot {
  updatedAtMs: number;
}

export interface WatcherAddressAdmissionResult {
  admission: WatcherAddressAdmissionDocument;
  membershipGeneration: number;
}

const EXACT_KEYS = [
  'address',
  'agent_id',
  'backfill_next_block',
  'catch_up_through_block',
  'chain_id',
  'created_at_ms',
  'direction',
  'eligibility_start_block',
  'membership_generation',
  'revision',
  'schema_version',
  'state',
  'updated_at_ms',
  'wallet_id',
] as const;
const REGISTRATION_FENCED_EXACT_KEYS = [
  ...EXACT_KEYS,
  'generation_fenced_at_registration',
] as const;

function assertSafeBlock(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < -1) {
    throw new Error(`watcher_address_admission_invalid:${field}`);
  }
}

function assertMembershipGeneration(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('watcher_checkpoint_invalid:membership_generation');
  }
}

function parseCheckpoint(
  raw: Record<string, unknown> | undefined,
  chainId: number,
): ParsedWatcherCheckpoint {
  if (!raw) return { lastProcessedBlock: null, membershipGeneration: 0, updatedAtMs: 0 };

  // TWO ACCEPTED SHAPES, AND ONLY TWO.
  //
  // The canonical shape carries `membership_generation`. The LEGACY shape is the three keys that
  // existed before that field was introduced, and both live Base checkpoints
  // (`genesis_inbound_checkpoints/8453`, `activity_outbound_checkpoints/8453`) are still in it.
  // Refusing them took down every `POST /v1/agent/wallet/create` with
  // `watcher_checkpoint_invalid:shape` and errored the outbound watcher on every 30-minute scan:
  // no agent onboarding, no origination, no mint.
  //
  // WHY WIDENING HERE IS THE HONEST FIX AND NOT THE CONVENIENT ONE. Three lines above, an
  // ABSENT checkpoint already parses to `membershipGeneration: 0`. A legacy document is the same
  // statement — written before generations existed, and therefore before any rotation could have
  // fenced it — so reading it as 0 makes the parser agree with a rule it already applies. The
  // alternative, back-filling the field onto two live money-path documents, would write the very
  // same 0 while also mutating production state that is evidence.
  //
  // This widens the SHAPE gate by exactly one known-historical arrangement. It does not weaken a
  // single value check: a document that CARRIES `membership_generation` must still satisfy
  // `assertMembershipGeneration`, an unknown or extra key is still `:shape`, and every other
  // field is validated identically on both paths. `parse-checkpoint-legacy-shape.test.ts` holds
  // the refusals.
  const CANONICAL_KEYS = ['chain_id', 'last_processed_block', 'membership_generation', 'updated_at'];
  const LEGACY_KEYS = ['chain_id', 'last_processed_block', 'updated_at'];
  const actualKeys = Object.keys(raw).sort();
  const matches = (expected: string[]): boolean => actualKeys.length === expected.length
    && expected.slice().sort().every((key, index) => key === actualKeys[index]);

  const isCanonical = matches(CANONICAL_KEYS);
  const isLegacy = !isCanonical && matches(LEGACY_KEYS);
  if (!isCanonical && !isLegacy) {
    throw new Error('watcher_checkpoint_invalid:shape');
  }
  if (raw.chain_id !== chainId) {
    throw new Error('watcher_checkpoint_invalid:chain_id');
  }
  const lastProcessedBlock = raw.last_processed_block;
  if (lastProcessedBlock !== null) {
    assertSafeBlock(lastProcessedBlock, 'last_processed_block');
    if (lastProcessedBlock < 0) {
      throw new Error('watcher_checkpoint_invalid:last_processed_block');
    }
  }
  // A legacy document has no generation to read; it predates rotations, so it IS generation 0 —
  // the same value an absent document parses to. A canonical document is validated exactly as
  // before: a present-but-invalid generation still throws.
  const membershipGeneration = isLegacy ? 0 : raw.membership_generation;
  assertMembershipGeneration(membershipGeneration);
  if (!Number.isSafeInteger(raw.updated_at) || (raw.updated_at as number) < 0) {
    throw new Error('watcher_checkpoint_invalid:updated_at');
  }
  return {
    lastProcessedBlock,
    membershipGeneration,
    updatedAtMs: raw.updated_at as number,
  };
}

/** Exact checkpoint parser for registration-recovery transactions. */
export function parseWatcherCheckpointDocument(
  raw: Record<string, unknown> | undefined,
  chainId: number,
): { lastProcessedBlock: number | null; membershipGeneration: number; updatedAtMs: number } {
  return parseCheckpoint(raw, chainId);
}

function nextMembershipGeneration(current: number): number {
  if (current >= Number.MAX_SAFE_INTEGER) {
    throw new Error('watcher_checkpoint_invalid:membership_generation_exhausted');
  }
  return current + 1;
}

function normalizedTarget(target: WatcherAddressAdmissionTarget): WatcherAddressAdmissionTarget {
  if (target.direction !== 'inbound' && target.direction !== 'outbound') {
    throw new Error('watcher_address_admission_invalid:direction');
  }
  if (!Number.isSafeInteger(target.chainId) || target.chainId <= 0) {
    throw new Error('watcher_address_admission_invalid:chain_id');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(target.address)) {
    throw new Error('watcher_address_admission_invalid:address');
  }
  if (!target.walletId || !target.agentId) {
    throw new Error('watcher_address_admission_invalid:owner');
  }
  assertSafeBlock(target.eligibilityStartBlock, 'eligibility_start_block');
  if (target.eligibilityStartBlock < 0) {
    throw new Error('watcher_address_admission_invalid:eligibility_start_block');
  }
  return { ...target, address: target.address.toLowerCase() };
}

export function watcherAddressAdmissionDocId(target: WatcherAddressAdmissionTarget): string {
  const normalized = normalizedTarget(target);
  return watcherAddressAdmissionDocIdFor(normalized.direction, normalized.chainId, normalized.address);
}

/** The one admission document an address has per direction and chain (read by address alone). */
export function watcherAddressAdmissionDocIdFor(direction: WatcherDirection, chainId: number, address: string): string {
  return crypto.createHash('sha256')
    .update(`${direction}:${chainId}:${address.toLowerCase()}`)
    .digest('hex');
}

export function parseWatcherAddressAdmission(
  raw: Record<string, unknown> | undefined,
): WatcherAddressAdmissionDocument {
  const expectedKeys = raw?.schema_version === REGISTRATION_FENCED_ADMISSION_SCHEMA
    ? REGISTRATION_FENCED_EXACT_KEYS
    : EXACT_KEYS;
  if (!raw || Object.keys(raw).sort().join('\u0000') !== [...expectedKeys].sort().join('\u0000')) {
    throw new Error('watcher_address_admission_invalid:shape');
  }
  if ((raw.schema_version !== ADMISSION_SCHEMA
      && raw.schema_version !== REGISTRATION_FENCED_ADMISSION_SCHEMA)
    || (raw.schema_version === REGISTRATION_FENCED_ADMISSION_SCHEMA
      && raw.generation_fenced_at_registration !== true)
    || (raw.direction !== 'inbound' && raw.direction !== 'outbound')
    || !Number.isSafeInteger(raw.chain_id) || (raw.chain_id as number) <= 0
    || typeof raw.address !== 'string' || !/^0x[0-9a-f]{40}$/.test(raw.address)
    || typeof raw.wallet_id !== 'string' || raw.wallet_id.length === 0
    || typeof raw.agent_id !== 'string' || raw.agent_id.length === 0
    || (raw.state !== 'backfilling' && raw.state !== 'live')
    || !Number.isSafeInteger(raw.membership_generation)
    || (raw.membership_generation as number) < 0
    || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1
    || !Number.isSafeInteger(raw.created_at_ms) || (raw.created_at_ms as number) < 0
    || !Number.isSafeInteger(raw.updated_at_ms) || (raw.updated_at_ms as number) < 0) {
    throw new Error('watcher_address_admission_invalid:fields');
  }
  assertSafeBlock(raw.eligibility_start_block, 'eligibility_start_block');
  assertSafeBlock(raw.backfill_next_block, 'backfill_next_block');
  assertSafeBlock(raw.catch_up_through_block, 'catch_up_through_block');
  const doc = raw as unknown as WatcherAddressAdmissionDocument;
  if (doc.eligibility_start_block < 0
    || doc.backfill_next_block < doc.eligibility_start_block
    || doc.catch_up_through_block < doc.eligibility_start_block - 1
    || (doc.state === 'backfilling' && doc.backfill_next_block > doc.catch_up_through_block)
    || (doc.state === 'live' && doc.backfill_next_block <= doc.catch_up_through_block)) {
    throw new Error('watcher_address_admission_invalid:state_matrix');
  }
  return doc;
}

export interface NativeWalletWatcherRegistrationPlan {
  /** the database the plan was read from, for the watch-registry write that rides on it. */
  readonly db: Firestore;
  readonly admissionRef: DocumentReference;
  readonly checkpointRef: DocumentReference;
  readonly admission: WatcherAddressAdmissionDocument;
  readonly membershipGeneration: number;
  readonly priorLastProcessedBlock: number | null;
  /**
   * true when this registration RE-BINDS an address whose admission belonged to a
   * displaced human registration (the address's admission doc id is address-keyed, so there is
   * exactly one to replace). The write overwrites it; every other registration creates.
   */
  readonly replaceExisting?: true;
}

/**
 * Read and plan the native-wallet admission writes inside the wallet's own
 * registration transaction. This is the moment the address becomes
 * economically enumerable, so generation invalidation cannot wait for a later
 * watcher run.
 */
export async function prepareNativeWalletWatcherRegistration(
  db: Firestore,
  txn: Transaction,
  targetInput: WatcherAddressAdmissionTarget,
  nowMs: number,
): Promise<NativeWalletWatcherRegistrationPlan> {
  return planNativeWalletWatcherRegistration(db, txn, targetInput, nowMs, null);
}

/**
 * plan the admission for a human wallet that DISPLACES an earlier, unproven (or
 * released) registration of the same address. Exactly the birth plan — fresh generation-fenced
 * admission at the new wallet's own fence, membership generation bumped — except the address's
 * one admission doc must currently be bound to the DISPLACED wallet/owner (or be absent, for a
 * registration that predates admissions), and it is overwritten rather than created. Bound to
 * anyone else → throws, so a rebind can never steal another live wallet's admission.
 */
export async function prepareNativeWalletWatcherRebind(
  db: Firestore,
  txn: Transaction,
  targetInput: WatcherAddressAdmissionTarget,
  displaced: { readonly walletId: string; readonly agentId: string },
  nowMs: number,
): Promise<NativeWalletWatcherRegistrationPlan> {
  return planNativeWalletWatcherRegistration(db, txn, targetInput, nowMs, displaced);
}

async function planNativeWalletWatcherRegistration(
  db: Firestore,
  txn: Transaction,
  targetInput: WatcherAddressAdmissionTarget,
  nowMs: number,
  displaced: { readonly walletId: string; readonly agentId: string } | null,
): Promise<NativeWalletWatcherRegistrationPlan> {
  const target = normalizedTarget(targetInput);
  if (target.direction !== 'inbound' || target.chainId !== 8453
    || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('native_watcher_registration_invalid');
  }
  const admissionRef = db.collection(WATCHER_ADDRESS_ADMISSION_COLLECTION)
    .doc(watcherAddressAdmissionDocId(target));
  const checkpointRef = db.collection(INBOUND_WATCHER_CHECKPOINT_COLLECTION)
    .doc(String(target.chainId));
  const [admissionSnap, checkpointSnap] = await Promise.all([
    txn.get(admissionRef),
    txn.get(checkpointRef),
  ]);
  let replaceExisting = false;
  if (admissionSnap.exists) {
    if (displaced === null) throw new Error('native_watcher_registration_admission_exists');
    let prior: WatcherAddressAdmissionDocument;
    try {
      prior = parseWatcherAddressAdmission(admissionSnap.data() as Record<string, unknown> | undefined);
    } catch {
      throw new Error('native_watcher_rebind_admission_invalid');
    }
    if (prior.address !== target.address
      || prior.wallet_id !== displaced.walletId
      || prior.agent_id !== displaced.agentId) {
      throw new Error('native_watcher_rebind_admission_mismatch');
    }
    replaceExisting = true;
  }
  const checkpoint = parseCheckpoint(
    checkpointSnap.exists
      ? checkpointSnap.data() as Record<string, unknown> | undefined
      : undefined,
    target.chainId,
  );
  if (nowMs < checkpoint.updatedAtMs) throw new Error('native_watcher_registration_time_regression');
  const membershipGeneration = nextMembershipGeneration(checkpoint.membershipGeneration);
  const catchUpThroughBlock = Math.max(
    checkpoint.lastProcessedBlock ?? -1,
    target.eligibilityStartBlock - 1,
  );
  const live = target.eligibilityStartBlock > catchUpThroughBlock;
  const admission: WatcherAddressAdmissionDocument = {
    schema_version: REGISTRATION_FENCED_ADMISSION_SCHEMA,
    direction: target.direction,
    chain_id: target.chainId,
    address: target.address,
    wallet_id: target.walletId,
    agent_id: target.agentId,
    eligibility_start_block: target.eligibilityStartBlock,
    state: live ? 'live' : 'backfilling',
    backfill_next_block: target.eligibilityStartBlock,
    catch_up_through_block: catchUpThroughBlock,
    membership_generation: membershipGeneration,
    generation_fenced_at_registration: true,
    revision: 1,
    created_at_ms: nowMs,
    updated_at_ms: nowMs,
  };
  return {
    db,
    admissionRef,
    checkpointRef,
    admission,
    membershipGeneration,
    priorLastProcessedBlock: checkpoint.lastProcessedBlock,
    ...(replaceExisting ? { replaceExisting: true as const } : {}),
  };
}

/** Write-only half of prepareNativeWalletWatcherRegistration. */
export function writeNativeWalletWatcherRegistration(
  txn: Transaction,
  plan: NativeWalletWatcherRegistrationPlan,
  nowMs: number,
): void {
  if (plan.replaceExisting) {
    txn.set(plan.admissionRef, plan.admission as unknown as Record<string, unknown>);
  } else {
    txn.create(plan.admissionRef, plan.admission as unknown as Record<string, unknown>);
  }
  txn.set(plan.checkpointRef, {
    chain_id: plan.admission.chain_id,
    last_processed_block: plan.priorLastProcessedBlock,
    membership_generation: plan.membershipGeneration,
    updated_at: nowMs,
  });
  // the address enters the watch registry in the SAME commit that makes it watchable and
  // bumps the membership generation, so a watcher that read the generation before this commit
  // cannot advance its checkpoint, and one that read it after sees the address.
  recordWatchRegistryEntry(txn, plan.db, 'native', plan.admission.address, nowMs);
  if (plan.replaceExisting) {
    // A rebind binds the address to a different wallet: the outbound watcher's admission for it
    // names the displaced wallet, so its mark no longer holds; an inbound admission that is not
    // live needs its catch-up, so its mark goes too.
    removeWatchMarkInTransaction(txn, plan.db, 'outbound_usdc', plan.admission.address);
    if (plan.admission.state !== 'live') {
      removeWatchMarkInTransaction(txn, plan.db, 'inbound_usdc', plan.admission.address);
    }
  }
}

export async function readWatcherCheckpointSnapshot(
  db: Firestore,
  globalCheckpointCollection: string,
  chainId: number,
): Promise<WatcherCheckpointSnapshot> {
  if (!globalCheckpointCollection || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error('watcher_checkpoint_invalid:read_args');
  }
  const snap = await db.collection(globalCheckpointCollection).doc(String(chainId)).get();
  return parseCheckpoint(
    snap.exists ? snap.data() as Record<string, unknown> | undefined : undefined,
    chainId,
  );
}

/**
 * Commit a chain-global checkpoint only for the exact membership/checkpoint
 * snapshot that was read before address enumeration. A newly-live address
 * increments the membership generation transactionally, invalidating an older
 * worker. Exact prior-checkpoint matching also prevents concurrent workers from
 * regressing or silently overtaking one another.
 */
export async function commitWatcherCheckpoint(
  db: Firestore,
  globalCheckpointCollection: string,
  chainId: number,
  expected: WatcherCheckpointSnapshot,
  processedThroughBlock: number,
  nowMs: number,
): Promise<WatcherCheckpointSnapshot> {
  if (!globalCheckpointCollection || !Number.isSafeInteger(chainId) || chainId <= 0
    || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('watcher_checkpoint_invalid:commit_args');
  }
  assertSafeBlock(processedThroughBlock, 'processed_through_block');
  if (processedThroughBlock < 0) {
    throw new Error('watcher_checkpoint_invalid:processed_through_block');
  }
  if (expected.lastProcessedBlock !== null) {
    assertSafeBlock(expected.lastProcessedBlock, 'expected_last_processed_block');
  }
  assertMembershipGeneration(expected.membershipGeneration);
  const ref = db.collection(globalCheckpointCollection).doc(String(chainId));

  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const current = parseCheckpoint(
      snap.exists ? snap.data() as Record<string, unknown> | undefined : undefined,
      chainId,
    );
    if (current.membershipGeneration !== expected.membershipGeneration) {
      throw new Error('watcher_membership_generation_changed');
    }
    if (current.lastProcessedBlock !== expected.lastProcessedBlock) {
      throw new Error('watcher_checkpoint_changed');
    }
    if (nowMs < current.updatedAtMs) throw new Error('watcher_checkpoint_time_regression');
    const currentBlock = current.lastProcessedBlock ?? -1;
    if (processedThroughBlock < currentBlock) {
      throw new Error('watcher_checkpoint_regression');
    }
    txn.set(ref, {
      chain_id: chainId,
      last_processed_block: processedThroughBlock,
      membership_generation: current.membershipGeneration,
      updated_at: nowMs,
    });
    return {
      lastProcessedBlock: processedThroughBlock,
      membershipGeneration: current.membershipGeneration,
    };
  });
}

/**
 * Advance a chain-global watcher checkpoint to `headToBlock` when the watched
 * set is EMPTY, so the cursor tracks head instead of silently freezing.
 *
 * WHY A FROZEN CURSOR IS THE BUG THIS FIXES. Both agent-address watchers
 * (inbound + outbound) return before committing when their watched set is empty.
 * An empty set is the normal pre-launch state (every agent is `platform:'test'`
 * and excluded), so every scheduler tick returns a perfectly healthy-looking
 * report — `watched_addresses:0`, HTTP 200, zero errors — while the durable
 * cursor never moves. That is the / silent-freeze class: live in any
 * point-in-time check, frozen in fact. Its gap to head then grows ~43k
 * blocks/day, and the FIRST real (non-test) address to appear inherits the
 * entire accumulated gap to grind through before it can earn.
 *
 * WHY ADVANCING IS SAFE (not merely convenient). An empty watched set means
 * zero addresses whose logs could appear in any range, so every block in
 * `(current, headToBlock]` is VACUOUSLY scanned — there is nothing to find. The
 * per-address admission machinery keeps it airtight for the future: any address
 * admitted later is created with
 * `catch_up_through_block = max(input, THIS checkpoint's last_processed_block,
 * fence-1)` and backfills from its own immutable eligibility fence up to that
 * ceiling before it joins the global band. So advancing the global cursor here
 * never skips a log for a not-yet-watched address — that address re-derives its
 * catch-up ceiling from the advanced checkpoint and backfills the whole range.
 *
 * The advance is a CAS via `commitWatcherCheckpoint` it preserves membership
 * generation and REFUSES a regression. `headToBlock` at or below the current
 * cursor is a no-op (returns null) — the cursor can stall (until head moves) or
 * hold, but it can never silently rewind. Returns the block advanced to, or null
 * when there was nothing ahead to advance to.
 */
export async function advanceEmptyWatcherCheckpoint(
  db: Firestore,
  globalCheckpointCollection: string,
  chainId: number,
  snapshot: WatcherCheckpointSnapshot,
  headToBlock: number,
  nowMs: number,
): Promise<number | null> {
  assertSafeBlock(headToBlock, 'empty_advance_head_block');
  if (headToBlock < 0) return null;
  const current = snapshot.lastProcessedBlock;
  // Only advance when head is strictly ahead of the current cursor. Never write
  // an equal/lower value — that would be a stale rewrite (churns updated_at) or
  // a regression (which the CAS refuses anyway). A no-op here is the correct
  // "nothing to do this tick" outcome, distinct from a silent freeze because the
  // caller reached this path deliberately and the cursor is already at head.
  if (current !== null && headToBlock <= current) return null;
  await commitWatcherCheckpoint(
    db,
    globalCheckpointCollection,
    chainId,
    { lastProcessedBlock: current, membershipGeneration: snapshot.membershipGeneration },
    headToBlock,
    nowMs,
  );
  return headToBlock;
}

function assertTargetBinding(
  doc: WatcherAddressAdmissionDocument,
  target: WatcherAddressAdmissionTarget,
): void {
  if (doc.direction !== target.direction
    || doc.chain_id !== target.chainId
    || doc.address !== target.address
    || doc.wallet_id !== target.walletId
    || doc.agent_id !== target.agentId
    || doc.eligibility_start_block !== target.eligibilityStartBlock) {
    throw new Error('watcher_address_admission_binding_mismatch');
  }
}

/** Re-read the exact durable admission before a claimed event can emit. */
export async function assertWatcherAddressAdmissionBinding(
  db: Firestore,
  targetInput: WatcherAddressAdmissionTarget,
): Promise<WatcherAddressAdmissionDocument> {
  const target = normalizedTarget(targetInput);
  const ref = db.collection(WATCHER_ADDRESS_ADMISSION_COLLECTION)
    .doc(watcherAddressAdmissionDocId(target));
  const snap = await ref.get();
  if (!snap.exists) throw new Error('watcher_address_admission_missing');
  const admission = parseWatcherAddressAdmission(
    snap.data() as Record<string, unknown> | undefined,
  );
  assertTargetBinding(admission, target);
  return admission;
}

/**
 * Create or refresh one address's durable catch-up target. `catchUpThroughBlock`
 * is the already-committed global checkpoint (or the block immediately before
 * the first normal range when no checkpoint exists).
 */
export async function ensureWatcherAddressAdmission(
  db: Firestore,
  targetInput: WatcherAddressAdmissionTarget,
  catchUpThroughBlockInput: number,
  globalCheckpointCollection: string,
  expectedMembershipGeneration: number,
  nowMs: number,
): Promise<WatcherAddressAdmissionResult> {
  const target = normalizedTarget(targetInput);
  assertSafeBlock(catchUpThroughBlockInput, 'catch_up_through_block');
  assertMembershipGeneration(expectedMembershipGeneration);
  if (!globalCheckpointCollection || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('watcher_address_admission_invalid:now');
  }
  const ref = db.collection(WATCHER_ADDRESS_ADMISSION_COLLECTION)
    .doc(watcherAddressAdmissionDocId(target));
  const checkpointRef = db.collection(globalCheckpointCollection).doc(String(target.chainId));

  return db.runTransaction(async (txn) => {
    const [snap, checkpointSnap] = await Promise.all([
      txn.get(ref),
      txn.get(checkpointRef),
    ]);
    const checkpoint = parseCheckpoint(
      checkpointSnap.exists
        ? checkpointSnap.data() as Record<string, unknown> | undefined
        : undefined,
      target.chainId,
    );
    if (checkpoint.membershipGeneration !== expectedMembershipGeneration) {
      throw new Error('watcher_membership_generation_changed');
    }
    if (nowMs < checkpoint.updatedAtMs) {
      throw new Error('watcher_checkpoint_time_regression');
    }
    const catchUpThroughBlock = Math.max(
      catchUpThroughBlockInput,
      checkpoint.lastProcessedBlock ?? -1,
      target.eligibilityStartBlock - 1,
    );
    if (!snap.exists) {
      const live = target.eligibilityStartBlock > catchUpThroughBlock;
      const membershipGeneration = live
        ? nextMembershipGeneration(checkpoint.membershipGeneration)
        : checkpoint.membershipGeneration;
      const created: WatcherAddressAdmissionDocument = {
        schema_version: ADMISSION_SCHEMA,
        direction: target.direction,
        chain_id: target.chainId,
        address: target.address,
        wallet_id: target.walletId,
        agent_id: target.agentId,
        eligibility_start_block: target.eligibilityStartBlock,
        state: live ? 'live' : 'backfilling',
        backfill_next_block: target.eligibilityStartBlock,
        catch_up_through_block: catchUpThroughBlock,
        membership_generation: membershipGeneration,
        revision: 1,
        created_at_ms: nowMs,
        updated_at_ms: nowMs,
      };
      txn.create(ref, created as unknown as Record<string, unknown>);
      if (live) {
        txn.set(checkpointRef, {
          chain_id: target.chainId,
          last_processed_block: checkpoint.lastProcessedBlock,
          membership_generation: membershipGeneration,
          updated_at: nowMs,
        });
      }
      return { admission: created, membershipGeneration };
    }

    const current = parseWatcherAddressAdmission(snap.data() as Record<string, unknown> | undefined);
    assertTargetBinding(current, target);
    if (current.state === 'live') {
      if (current.membership_generation > checkpoint.membershipGeneration) {
        throw new Error('watcher_address_admission_invalid:future_membership_generation');
      }
      return {
        admission: current,
        membershipGeneration: checkpoint.membershipGeneration,
      };
    }
    if (current.catch_up_through_block >= catchUpThroughBlock) {
      return {
        admission: current,
        membershipGeneration: checkpoint.membershipGeneration,
      };
    }
    const updated: WatcherAddressAdmissionDocument = {
      ...current,
      catch_up_through_block: catchUpThroughBlock,
      revision: current.revision + 1,
      updated_at_ms: nowMs,
    };
    txn.set(ref, updated as unknown as Record<string, unknown>);
    return {
      admission: updated,
      membershipGeneration: checkpoint.membershipGeneration,
    };
  });
}

/**
 * Persist one completed backfill range. The global checkpoint is read in the
 * same transaction that would transition the address to `live`, so a concurrent
 * global advance extends the catch-up target instead of opening a gap.
 */
export async function advanceWatcherAddressAdmission(
  db: Firestore,
  targetInput: WatcherAddressAdmissionTarget,
  processedThroughBlock: number,
  globalCheckpointCollection: string,
  expectedMembershipGeneration: number,
  nowMs: number,
): Promise<WatcherAddressAdmissionResult> {
  const target = normalizedTarget(targetInput);
  assertSafeBlock(processedThroughBlock, 'processed_through_block');
  assertMembershipGeneration(expectedMembershipGeneration);
  if (!globalCheckpointCollection || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('watcher_address_admission_invalid:advance_args');
  }
  const ref = db.collection(WATCHER_ADDRESS_ADMISSION_COLLECTION)
    .doc(watcherAddressAdmissionDocId(target));
  const checkpointRef = db.collection(globalCheckpointCollection).doc(String(target.chainId));

  return db.runTransaction(async (txn) => {
    const admissionSnap = await txn.get(ref);
    if (!admissionSnap.exists) throw new Error('watcher_address_admission_missing');
    const current = parseWatcherAddressAdmission(
      admissionSnap.data() as Record<string, unknown> | undefined,
    );
    assertTargetBinding(current, target);

    const checkpointSnap = await txn.get(checkpointRef);
    const checkpoint = parseCheckpoint(
      checkpointSnap.exists
        ? checkpointSnap.data() as Record<string, unknown> | undefined
        : undefined,
      target.chainId,
    );
    if (checkpoint.membershipGeneration !== expectedMembershipGeneration) {
      throw new Error('watcher_membership_generation_changed');
    }
    if (nowMs < checkpoint.updatedAtMs) {
      throw new Error('watcher_checkpoint_time_regression');
    }

    // Idempotent acknowledgement after an ambiguous client-side commit result.
    if (current.backfill_next_block > processedThroughBlock) {
      return {
        admission: current,
        membershipGeneration: checkpoint.membershipGeneration,
      };
    }
    if (current.state !== 'backfilling'
      || processedThroughBlock < current.backfill_next_block
      || processedThroughBlock > current.catch_up_through_block) {
      throw new Error('watcher_address_admission_invalid:advance_range');
    }

    const globalCheckpoint = checkpoint.lastProcessedBlock ?? -1;
    const catchUpThroughBlock = Math.max(current.catch_up_through_block, globalCheckpoint);
    const backfillNextBlock = processedThroughBlock + 1;
    const becomesLive = backfillNextBlock > catchUpThroughBlock;
    const membershipGeneration = becomesLive
      && current.generation_fenced_at_registration !== true
      ? nextMembershipGeneration(checkpoint.membershipGeneration)
      : checkpoint.membershipGeneration;
    const updated: WatcherAddressAdmissionDocument = {
      ...current,
      state: becomesLive ? 'live' : 'backfilling',
      backfill_next_block: backfillNextBlock,
      catch_up_through_block: catchUpThroughBlock,
      membership_generation: membershipGeneration,
      revision: current.revision + 1,
      updated_at_ms: nowMs,
    };
    txn.set(ref, updated as unknown as Record<string, unknown>);
    if (becomesLive) {
      txn.set(checkpointRef, {
        chain_id: target.chainId,
        last_processed_block: checkpoint.lastProcessedBlock,
        membership_generation: membershipGeneration,
        updated_at: nowMs,
      });
    }
    return { admission: updated, membershipGeneration };
  });
}
