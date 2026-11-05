/**
 * PE Hash Chain Validator - Server-Side Chain Integrity Enforcement
 *
 * SECURITY CRITICAL: This module prevents PE hash chain forgery by ensuring
 * atomic chain tip advancement. Without this, concurrent PE submissions could
 * read the same prev_hash, creating a forked chain that violates the
 * append-only hash chain invariant (Security Invariant #5).
 *
 * Attack prevented: An attacker with device credentials submitting forged PEs
 * with arbitrary prev_hash values, or racing concurrent submissions to fork
 * the chain.
 *
 * Implementation: Uses Firestore transactions to atomically read-then-write
 * the chain tip. Only one PE can claim each position in the chain. Losers
 * get a contention error and must retry (at which point they get the correct
 * prev_hash from the winner).
 *
 * Firestore collection: `pe_chain_tips` - one document per user_id, storing
 * the current chain tip hash. This is the authoritative source of truth for
 * chain ordering, replacing the non-atomic getLatestPEHash + updateLatestPEHash
 * pattern for PE submission endpoints.
 */

import admin from 'firebase-admin';

// =============================================================================
// Constants
// =============================================================================

/** Firestore collection for chain tip documents */
const CHAIN_TIPS_COLLECTION = 'pe_chain_tips';

/** Firestore collection for PE hash uniqueness index */
const PE_HASH_INDEX_COLLECTION = 'pe_hash_index';

/** Genesis value for the first PE in a chain (matches existing convention) */
export const GENESIS_HASH = '0x0000';

/** Maximum allowed future drift (5 seconds - strict for temporal validation) */
const MAX_FUTURE_MS = 5 * 1000;

/** Maximum allowed past drift (30 seconds - default clock skew window) */
const MAX_PAST_MS = 30 * 1000;

/** Legacy timestamp window for the standalone validatePETimestamp function */
const LEGACY_MAX_FUTURE_MS = 5 * 60 * 1000;
const LEGACY_MAX_PAST_MS = 60 * 60 * 1000;

// =============================================================================
// Types
// =============================================================================

export interface ChainAdvanceResult {
  /** The previous chain tip hash (to be used as prev_hash in the new PE) */
  prev_hash: string;
  /** The new PE hash that is now the chain tip */
  new_hash: string;
}

/**
 * Context handed to a `coWrites` callback: the resolved prev_hash and the newly
 * computed PE hash for the attempt that is currently committing.
 */
export interface ChainCoWriteCtx {
  prevHash: string;
  newHash: string;
}

/**
 * Additional writes to commit ATOMICALLY in the same transaction as the
 * chain-tip advance (WS4 — PE durability + Commons atomicity).
 *
 * Invoked AFTER the tip read, temporal validation, hash compute, and tip write,
 * with the live transaction and the resolved {prevHash,newHash}. This is how the
 * universal PE-document write (and, for Commons, the entity document) become
 * durable-or-nothing together with the tip advance.
 *
 * Contract:
 *  - MUST perform only writes (`txn.set`/`txn.update`/`txn.create`). No reads:
 *    Firestore requires all reads before all writes, and the single tip read has
 *    already happened.
 *  - MUST be pure-on-retry: Firestore may re-run the transaction on contention,
 *    so build every write payload from captured values / the supplied ctx and
 *    perform no external side effects.
 *  - Throwing rolls back the ENTIRE transaction (tip advance + every co-write):
 *    nothing is committed. This is the fail-closed atomicity guarantee.
 */
export type ChainCoWrites = (
  txn: admin.firestore.Transaction,
  ctx: ChainCoWriteCtx,
) => void;

/**
 * Optional transactional reads/validation that must complete before the chain
 * tip or any co-written PE/entity document is changed. This is intentionally a
 * separate phase from `ChainCoWrites`: Firestore requires every read to happen
 * before the first write. Callers use it for uniqueness/idempotency guards and
 * other admission checks that must serialize with PE creation.
 */
export type ChainAtomicPrecondition = (
  txn: admin.firestore.Transaction,
  ctx: { prevHash: string },
) => Promise<void>;

/**
 * True if `v` is thenable (Promise-like). Used to fail closed when a co-write
 * callback is accidentally `async`: TypeScript's void-return rule lets an
 * `async () => Promise<void>` satisfy a `() => void` parameter, but an awaited
 * read/write inside it would escape the transaction's synchronous commit window
 * and silently defeat the all-or-nothing guarantee. We detect and reject it.
 */
export function isThenable(v: unknown): boolean {
  return (
    (typeof v === 'object' || typeof v === 'function') &&
    v !== null &&
    typeof (v as { then?: unknown }).then === 'function'
  );
}

export type ChainValidationError =
  | { code: 'chain_contention'; message: string }
  | { code: 'duplicate'; message: string }
  | { code: 'timestamp_future'; message: string }
  | { code: 'timestamp_past'; message: string };

// =============================================================================
// Core: Atomic Chain Tip Advance
// =============================================================================

/**
 * Atomically read the current PE chain tip and advance it to the new PE hash.
 *
 * Uses a Firestore transaction to guarantee that only one PE can claim each
 * position in the chain. If two PEs race, the transaction serialization ensures
 * one succeeds and the other retries with the updated chain tip.
 *
 * @param db - Firestore instance
 * @param userId - The chain owner (user_id or provisional identifier)
 * @param computeHash - Callback that receives the prev_hash and returns the new PE hash.
 *                      Called inside the transaction - must be pure (no side effects).
 *                      May be called multiple times if the transaction retries.
 * @param peTimestamp - Optional PE timestamp for temporal validation + monotonic ordering.
 * @param coWrites - Optional atomic co-writes (WS4). When provided, these run in the
 *                   SAME transaction as the tip advance, so the PE document (and, for
 *                   Commons, the entity document) are durable-or-nothing with the tip.
 *                   See {@link ChainCoWrites} for the (write-only, pure-on-retry) contract.
 * @returns The prev_hash and new_hash on success
 * @throws ChainValidationError on contention or duplicate
 */
export async function advanceChainTipAtomic(
  db: admin.firestore.Firestore,
  userId: string,
  computeHash: (prevHash: string) => string,
  peTimestamp?: number,
  coWrites?: ChainCoWrites,
  atomicPrecondition?: ChainAtomicPrecondition,
): Promise<ChainAdvanceResult> {
  const tipRef = db.collection(CHAIN_TIPS_COLLECTION).doc(userId);

  const result = await db.runTransaction(async (txn) => {
    const tipDoc = await txn.get(tipRef);
    const tipData = tipDoc.exists ? tipDoc.data()! : null;

    // Read current chain tip. First PE in chain uses genesis value.
    const prevHash = tipData ? (tipData.hash as string) : GENESIS_HASH;

    // Caller-specific idempotency/uniqueness reads run before temporal
    // validation so an exact retry can return its committed result even when
    // its original timestamp is no longer strictly newer than the chain tip.
    if (atomicPrecondition) {
      await atomicPrecondition(txn, { prevHash });
    }

    // --- Temporal validation (when peTimestamp is provided) ---
    if (peTimestamp !== undefined) {
      const now = Date.now();

      // Clock skew check: PE timestamp must be within acceptable window of server time
      if (peTimestamp > now + MAX_FUTURE_MS) {
        const err: ChainValidationError = { code: 'timestamp_future', message: 'PE timestamp is too far in the future' };
        throw Object.assign(new Error(err.message), { validationError: err });
      }
      if (peTimestamp < now - MAX_PAST_MS) {
        const err: ChainValidationError = { code: 'timestamp_past', message: 'PE timestamp is too far in the past' };
        throw Object.assign(new Error(err.message), { validationError: err });
      }

      // Monotonic check: PE timestamp must be strictly greater than last accepted
      const lastTimestamp = tipData?.last_pe_timestamp as number | undefined;
      if (lastTimestamp !== undefined && peTimestamp <= lastTimestamp) {
        const err: ChainValidationError = {
          code: 'timestamp_past',
          message: 'PE timestamp must be strictly greater than previous PE',
        };
        throw Object.assign(new Error(err.message), { validationError: err });
      }
    }

    // Compute the new PE hash using the caller's function.
    const newHash = computeHash(prevHash);

    // Advance the chain tip atomically, including timestamp
    txn.set(tipRef, {
      hash: newHash,
      user_id: userId,
      updated_at: Date.now(),
      ...(peTimestamp !== undefined ? { last_pe_timestamp: peTimestamp } : {}),
    });

    // WS4: atomic co-writes (PE document + optional entity document) commit in
    // THIS transaction. They run after the tip write (writes-after-read), are
    // write-only, and a throw here rolls back the tip advance too — so the chain
    // tip can never advance to a PE whose document failed to persist.
    if (coWrites) {
      // Fail closed if a caller passed an async co-write: a returned Promise
      // means the writes are NOT in this transaction's commit and atomicity is
      // broken. `void` is assignable to `unknown`, so this captures the real
      // runtime return without weakening the `=> void` contract.
      const coWriteResult: unknown = coWrites(txn, { prevHash, newHash });
      if (isThenable(coWriteResult)) {
        throw new Error(
          'advanceChainTipAtomic coWrites must be synchronous (write-only); a returned Promise would escape the transaction and break atomicity',
        );
      }
    }

    return { prev_hash: prevHash, new_hash: newHash };
  });

  return result;
}

// =============================================================================
// Timestamp Freshness Validation
// =============================================================================

/**
 * Validate that a PE timestamp is within an acceptable freshness window.
 *
 * SECURITY: Prevents two classes of attack:
 * 1. Backdating - submitting PEs with old timestamps to manipulate ordering
 *    or claim credit for work that didn't happen at the stated time.
 * 2. Future-dating - submitting PEs with future timestamps to game time-based
 *    scoring or create confusion in the chain ordering.
 *
 * The server generates timestamps for device PEs (defense-in-depth),
 * but this check catches clock skew and validates any externally-provided timestamps.
 *
 * @returns null if valid, or a ChainValidationError describing the issue
 */
export function validatePETimestamp(timestamp: number): ChainValidationError | null {
  const now = Date.now();
  const drift = timestamp - now;

  if (drift > LEGACY_MAX_FUTURE_MS) {
    return {
      code: 'timestamp_future',
      // SECURITY: Do not reveal the server's clock or the acceptable window
      message: 'PE timestamp is too far in the future',
    };
  }

  if (-drift > LEGACY_MAX_PAST_MS) {
    return {
      code: 'timestamp_past',
      // SECURITY: Do not reveal the acceptable window
      message: 'PE timestamp is too far in the past',
    };
  }

  return null;
}

// =============================================================================
// Duplicate PE Detection
// =============================================================================

/**
 * Check if a PE with the given hash already exists in the hash index.
 *
 * SECURITY: Prevents replay attacks where a valid PE is resubmitted.
 * While PE IDs contain UUIDs (making hash collisions near-impossible),
 * this check provides defense-in-depth against implementation bugs or
 * future changes that might weaken the uniqueness guarantee.
 *
 * @returns true if the hash is a duplicate (already exists)
 */
export async function isDuplicatePEHash(
  db: admin.firestore.Firestore,
  peHash: string,
): Promise<boolean> {
  const ref = db.collection(PE_HASH_INDEX_COLLECTION).doc(peHash);
  const doc = await ref.get();
  return doc.exists;
}

/**
 * Register a PE hash in the uniqueness index after successful chain advance.
 * Fire-and-forget - failure here doesn't break the chain, only weakens
 * the duplicate detection for this specific PE.
 */
export async function registerPEHash(
  db: admin.firestore.Firestore,
  peHash: string,
  peId: string,
  userId: string,
): Promise<void> {
  await db.collection(PE_HASH_INDEX_COLLECTION).doc(peHash).set({
    pe_id: peId,
    user_id: userId,
    created_at: Date.now(),
  });
}
