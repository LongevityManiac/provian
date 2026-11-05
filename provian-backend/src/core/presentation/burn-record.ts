/**
 * First-party PVT burn recorder — the ONE recorder for both the agent and the human path.
 *
 * The recorder binds the on-chain burn's `expectedFrom` to the CALLER's own first-party
 * address — the human's `wallets/` EVM address on the human path, the agent's sovereign
 * address on the agent path (`recordAgentBurn` delegates here) — then verifies a real
 * `Transfer(from, 0x0, amount)` on the PVT token, records a verified row in
 * `pvt_burn_records`, idempotent by (chain, txHash).
 *
 * The security-critical part — that the burn actually happened, from exactly this
 * address, to the zero address, for exactly this amount — is the SHARED `verifyEvmPvtBurn`.
 * Only the choice of `expectedFrom` differs, and it is ALWAYS the authenticated caller's own
 * address, never client-supplied.
 *
 * a Base burn is ACCEPTED once it is mined in one block —
 * `verifyEvmPvtBurn({ acceptance: 'inclusion' })` both operator-bound legs agree on the receipt
 * and its canonical block; a pending / mempool tx is never accepted — and recorded
 * `finality: 'provisional'`. It is consumable exactly once from then on, like any recorded burn.
 * The 12-block finality check still runs on every accepted burn (`burn-finality.ts`): in-process
 * right after acceptance, and on the 5-minute sweep. A burn that fails it is revoked with every
 * relay-held benefit it backs.
 *
 * A caller may ask the relay to WAIT for the burn to be mined (`waitMs`) instead of polling. The
 * request is held open; `waitForFinalityWindow({ confirmations: 1 })` watches the free secondary
 * leg for the receipt, and the verifier is called again, a few hundred ms apart, while it still
 * reports the burn not yet mined. The verdict is the verifier's alone — waiting changes WHEN it is
 * asked, never what it accepts. A burn not mined inside the wait records nothing: the in-flight
 * marker is released and no benefit can be bought with it.
 */

import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { verifyEvmPvtBurn, type TxVerificationResult } from '../onchain/tx-verifier';
import { PVT_BURN_RECORDS_COLLECTION } from '../commons/burn-consumption';
import { timeBurnStep } from '../onchain/burn-timing';
import { waitForFinalityWindow, type FinalityProbe } from './burn-finality-wait';
import { scheduleBurnFinalization } from './burn-finality';

/** base / arbitrum / optimism → chain id (mirrors TRANSFER_CHAIN_IDS). */
const BURN_CHAIN_IDS: Record<string, number> = { base: 8453, arbitrum: 42161, optimism: 10 };

/** the longest a record request is held open waiting for the burn to be mined (~2 s typical). */
export const BURN_RECORD_MAX_WAIT_MS = 90_000;
/**
 * How far past its own wait an in-flight marker is still presumed alive (a crashed request's marker
 * goes stale). Covers a slow verifier call (30 s per RPC leg); liveness only — correctness never
 * depends on it, because every final write is fenced on the marker's `claim_token`.
 */
export const BURN_RECORD_PENDING_GRACE_MS = 120_000;
/** A pre- in-flight marker carries no `pending_until`; it is stale this long after `created_at`. */
export const BURN_RECORD_LEGACY_PENDING_STALE_MS = 5 * 60_000;
/** Re-ask the verifier this soon after it reports the burn not yet final. */
export const BURN_VERIFY_RETRY_MS = 300;

/** `sha256(chain:txHash)` — the burn id every product keys on. Pure; mirrored by the SDK and the app. */
export function burnIdFor(chain: string, txHash: string): string {
  return crypto.createHash('sha256').update(`${chain}:${txHash.toLowerCase()}`).digest('hex');
}

export interface RecordFirstPartyBurnParams {
  /** The wallet id this burn is recorded under (agent wallet id / human wallet id). */
  readonly walletId: string;
  /** The first-party burning EVM address — the authenticated caller's OWN address.
   *  Binds the on-chain `expectedFrom`. Never client-supplied. */
  readonly address: string;
  readonly ownerKind: 'agent' | 'human';
  /** agent_id (agent) or user_id (human) — audit attribution on the burn row. */
  readonly ownerId: string;
  readonly txHash: string;
  readonly chain: string;
  /** Atomic 18-decimal PVT units burned, as an integer string. */
  readonly amountAtomic: string;
  /**
   * hold the request open up to this long for the burn to be mined (clamped to
   * {@link BURN_RECORD_MAX_WAIT_MS}). 0 / absent = one immediate verifier call.
   */
  readonly waitMs?: number;
}

/** `provisional` — accepted at inclusion, finality check pending; `final` — past 12 confirmations. */
export type RecordedBurnFinality = 'provisional' | 'final';

export type RecordFirstPartyBurnResult =
  | { ok: true; burnId: string; verified: boolean; idempotent?: boolean; finality?: RecordedBurnFinality }
  | { ok: false; status: number; error: string; reason?: string };

export interface BurnRecordDeps {
  readonly db: Firestore;
  /** Test seams (production: the secondary-leg probe, real timers, the shared verifier). */
  readonly probe?: FinalityProbe;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly verify?: typeof verifyEvmPvtBurn;
  /**
   * Hand an accepted (provisional) burn to its finality check. Production: the in-process finalizer
   * (`scheduleBurnFinalization`); the 5-minute sweep is the guarantee either way.
   */
  readonly scheduleFinalization?: (burnId: string, txHash: string) => void;
}

/** A verifier refusal that can clear with time (not yet visible / not yet final / an RPC blip). */
export function isTransientBurnRefusal(reason: string | undefined): boolean {
  return typeof reason === 'string'
    && /^(tx_not_found|insufficient_confirmations|rpc_error)/.test(reason);
}

type MarkerClaim =
  | { kind: 'claimed' }
  | { kind: 'done'; result: RecordFirstPartyBurnResult };

function pendingIsStale(row: Record<string, unknown>, nowMs: number): boolean {
  if (typeof row.pending_until === 'number') return row.pending_until < nowMs;
  const created = typeof row.created_at === 'number' ? row.created_at : 0;
  return created + BURN_RECORD_LEGACY_PENDING_STALE_MS < nowMs;
}

export async function recordFirstPartyBurn(
  deps: BurnRecordDeps,
  params: RecordFirstPartyBurnParams,
): Promise<RecordFirstPartyBurnResult> {
  const { walletId, address, ownerKind, ownerId, txHash, chain, amountAtomic } = params;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const verify = deps.verify ?? verifyEvmPvtBurn;

  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return { ok: false, status: 400, error: 'a first-party EVM burning address is required' };
  }
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, status: 400, error: 'tx_hash is required (0x + 64 hex chars)' };
  }
  if (typeof amountAtomic !== 'string' || !/^[0-9]+$/.test(amountAtomic) || amountAtomic === '0') {
    return { ok: false, status: 400, error: 'amount_atomic must be a positive integer string (atomic 18-decimal PVT units)' };
  }
  const chainId = BURN_CHAIN_IDS[chain];
  if (!chainId) {
    return { ok: false, status: 400, error: "chain must be 'base', 'arbitrum', or 'optimism'" };
  }
  const waitMs = Math.max(0, Math.min(BURN_RECORD_MAX_WAIT_MS, Math.floor(params.waitMs ?? 0)));
  const deadline = now() + waitMs;
  // Only Base accepts at inclusion; any other chain's verifier is its full check, so its record is final.
  const finalityAtAcceptance: RecordedBurnFinality = chainId === 8453 ? 'provisional' : 'final';

  const burnId = burnIdFor(chain, txHash);
  const recordRef = deps.db.collection(PVT_BURN_RECORDS_COLLECTION).doc(burnId);
  // Ownership fence: this request's marker carries a token of its own, and every final write
  // (record or release) happens only while the stored marker still carries it. A request whose
  // marker went stale and was taken over can then never write over, or delete, the new owner's row.
  const claimToken = crypto.randomBytes(16).toString('hex');
  const markerFields = (): Record<string, unknown> => ({
    tx_hash: txHash,
    chain,
    wallet_id: walletId,
    owner_kind: ownerKind,
    owner_id: ownerId,
    // The agent path has always attributed its rows by `agent_id`; keep it on agent rows.
    ...(ownerKind === 'agent' ? { agent_id: ownerId } : {}),
    burner_address: address.toLowerCase(),
    amount_atomic: amountAtomic,
    status: 'pending',
    created_at: now(),
    pending_until: now() + waitMs + BURN_RECORD_PENDING_GRACE_MS,
    claim_token: claimToken,
  });
  const isMine = (row: Record<string, unknown> | undefined): boolean =>
    row !== undefined && row.status === 'pending' && row.claim_token === claimToken;

  /** Release this request's marker — only if it is still ours. Nothing was recorded. */
  const release = async (): Promise<void> => {
    await deps.db.runTransaction(async (txn) => {
      const row = (await txn.get(recordRef)).data();
      if (isMine(row)) txn.delete(recordRef);
    }).catch(() => {});
  };

  /**
   * Record the verified burn — only while the marker is still ours, or if no row exists (a marker
   * that went stale, was taken over and released by its new owner). The row is written whole from
   * THIS request's own verified fields, never merged onto whatever is stored.
   */
  const commit = async (v: TxVerificationResult): Promise<RecordFirstPartyBurnResult> =>
    deps.db.runTransaction(async (txn): Promise<RecordFirstPartyBurnResult> => {
      const row = (await txn.get(recordRef)).data();
      if (row?.status === 'recorded') return fromRecorded(row);
      if (row?.status === 'revoked') return revokedResult;
      if (row !== undefined && !isMine(row)) {
        return { ok: false, status: 409, error: 'A record for this burn tx_hash is already in progress' };
      }
      const acceptedAt = now();
      const recorded = {
        ...markerFields(),
        ...(row ? { created_at: row.created_at } : {}),
        status: 'recorded',
        verified: true,
        block_number: v.blockNumber ?? null,
        recorded_at: acceptedAt,
        // a Base burn is accepted at inclusion; the finality check owns the rest.
        finality: finalityAtAcceptance,
        included_block_hash: v.blockHash ?? null,
        // / which PVT kernel the burn log was on — the live one, or the retired
        // predecessor for a burn at/below the migration snapshot block — so predecessor burns are
        // labelled on their row.
        token_address: v.tokenAddress ?? null,
        accepted_at: acceptedAt,
      };
      delete (recorded as Record<string, unknown>).pending_until;
      delete (recorded as Record<string, unknown>).claim_token;
      if (row) txn.set(recordRef, recorded);
      else txn.create(recordRef, recorded);
      return { ok: true, burnId, verified: true, finality: finalityAtAcceptance };
    });

  /** Only a fully-verified prior record is idempotently returnable, and only to its own wallet. */
  const fromRecorded = (row: Record<string, unknown>): RecordFirstPartyBurnResult =>
    row.wallet_id !== walletId
      ? { ok: false, status: 409, error: 'This burn tx was already recorded by a different wallet' }
      : {
        ok: true,
        burnId,
        verified: Boolean(row.verified),
        idempotent: true,
        finality: row.finality === 'provisional' ? 'provisional' : 'final',
      };
  /** A revoked burn never reached finality. Terminal: it can never be recorded (or bought with) again. */
  const revokedResult: RecordFirstPartyBurnResult = {
    ok: false,
    status: 409,
    error: 'This burn did not reach Base finality and was revoked',
    reason: 'burn_revoked',
  };

  const claimMarker = async (): Promise<MarkerClaim> => {
    for (;;) {
      try {
        await recordRef.create(markerFields());
        return { kind: 'claimed' };
      } catch (err) {
        if ((err as { code?: number }).code !== 6) throw err;
      }
      const existing = (await recordRef.get()).data();
      if (!existing) continue; // released between the create and the read — try again
      if (existing.status === 'recorded') return { kind: 'done', result: fromRecorded(existing) };
      if (existing.status === 'revoked') return { kind: 'done', result: revokedResult };
      // Anything but an in-flight marker is terminal here — never a loop on a state this recorder
      // does not own.
      if (existing.status !== 'pending') {
        return { kind: 'done', result: { ok: false, status: 409, error: 'This burn tx is in a state that cannot be recorded' } };
      }
      // An in-flight record. A crashed request's marker goes stale and is taken over; a live
      // one is waited on while this caller is itself willing to wait.
      if (pendingIsStale(existing, now())) {
        const took = await deps.db.runTransaction(async (txn) => {
          const snap = await txn.get(recordRef);
          const row = snap.data();
          if (!row || row.status !== 'pending' || !pendingIsStale(row, now())) return false;
          txn.set(recordRef, markerFields());
          return true;
        });
        if (took) return { kind: 'claimed' };
        continue;
      }
      if (now() >= deadline) {
        return { kind: 'done', result: { ok: false, status: 409, error: 'A record for this burn tx_hash is already in progress' } };
      }
      await sleep(Math.min(500, Math.max(0, deadline - now())));
    }
  };

  const claim = await claimMarker();
  if (claim.kind === 'done') return claim.result;

  try {
    if (waitMs > 0 && chainId === 8453) {
      await waitForFinalityWindow(txHash, { deadlineAtMs: deadline, probe: deps.probe, sleep, now, confirmations: 1 });
    }
    let v: TxVerificationResult;
    for (;;) {
      v = await timeBurnStep('burn_inclusion_verification', () => verify({
        chainId,
        txHash,
        expectedFrom: address,
        expectedAmountWei: BigInt(amountAtomic),
        acceptance: 'inclusion',
      }));
      if (v.ok || !isTransientBurnRefusal(v.reason) || now() + BURN_VERIFY_RETRY_MS >= deadline) break;
      await sleep(BURN_VERIFY_RETRY_MS);
    }
    if (!v.ok) {
      // Release the marker so a corrected (or later) retry can proceed. Nothing was recorded.
      await release();
      return { ok: false, status: 400, error: 'On-chain PVT burn verification failed', reason: v.reason };
    }
    const result = await commit(v);
    if (result.ok && result.finality === 'provisional' && !result.idempotent) {
      (deps.scheduleFinalization ?? defaultScheduleFinalization(deps))(burnId, txHash);
    }
    return result;
  } catch (err) {
    // The verify/commit threw AFTER we claimed the marker. Re-read: a row recorded for THIS wallet
    // means the commit landed before the throw (return it idempotently); otherwise release our
    // marker (fenced — never another request's) and surface the error.
    const after = (await recordRef.get().catch(() => undefined))?.data();
    if (after?.status === 'recorded' && after.wallet_id === walletId) {
      return { ok: true, burnId, verified: Boolean(after.verified) };
    }
    await release();
    throw err;
  }
}

/**
 * The production hand-off to the finality check: the in-process finalizer with the recorder's own db
 * and verifier. Off under jest (a test that wants it passes `scheduleFinalization`), so no background
 * work outlives a test.
 */
function defaultScheduleFinalization(deps: BurnRecordDeps): (burnId: string, txHash: string) => void {
  if (process.env.NODE_ENV === 'test') return () => {};
  return (burnId, txHash) => scheduleBurnFinalization(
    { db: deps.db, now: deps.now, verify: deps.verify, probe: deps.probe, log: (l) => console.warn(l) },
    burnId,
    txHash,
  );
}
