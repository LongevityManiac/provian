import { Transaction, keccak256, type TransactionRequest } from 'ethers';
import { FieldValue, type Firestore, type Transaction as FirestoreTransaction } from 'firebase-admin/firestore';
import type { FinalizedOwnerTransaction } from './transaction-finality';

/**
 * The Recourse transaction lane: one gas wallet of its own, separate from the
 * settlement minter, that sends every relay-driven Recourse transaction.
 *
 * - One writer per key: a durable lease on the lane document admits one run at
 *   a time, and every nonce is allocated in the same Firestore transaction that
 *   persists the signed bytes. A signed transaction is never forgotten.
 * - Back-to-back: transactions go out at consecutive nonces without waiting
 *   for the previous one to confirm. Up to `LANE_MAX_PENDING` may be unmined.
 * - Done at twelve confirmations, the relay's Base rule, never `finalized`.
 * - Oldest live request first: every queued row carries `laneQueueKey`
 *   (creation time, then id). A request that has expired or become obsolete
 *   is closed without a transaction, so it never holds up the rows behind it,
 *   and a request that fails transiently is skipped for the rest of the run.
 * - No transaction is sent twice: only the persisted bytes are broadcast, and a
 *   fee replacement reuses the same nonce, target and calldata, so at most one
 *   variant can ever be included. Every variant is kept and reconciled.
 */
export const RECOURSE_LANE_COLLECTION = 'recourse_transaction_lane_v1';
export const LANE_LEASE_TTL_MS = 60_000;
/** Signed transactions not yet included in a block. */
export const LANE_MAX_PENDING = 16;
/** Signed transactions not yet reconciled at twelve confirmations. */
export const LANE_MAX_OPEN = 192;
export const LANE_PREPARE_CONCURRENCY = 8;
export const LANE_PRIORITY_FEE_WEI = 1_000_000n;
/** Head-of-line or underpriced transactions are replaced after this long unmined. */
export const LANE_REPLACE_AFTER_MS = 60_000;
/** Money-safety bound on any single replacement. Reaching it stops the lane. */
export const LANE_MAX_FEE_CEILING_WEI = 50_000_000_000n;
export const LANE_WAIT_MS = 2_000;
/** Twelve two-second Base blocks: nothing signed more recently can be done or need resending. */
export const LANE_CONFIRMATION_WAIT_MS = 24_000;

export function laneQueueKey(nowMs: number, id: string): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw Error('recourse_lane_queue_time_invalid');
  return `${String(nowMs).padStart(16, '0')}:${id}`;
}
/** Fields every queue writes when a row (re)enters the queued state. */
/** The live queue of one collection, oldest first. Every lane collection is held in the
 * private store, where only an equality on an indexed field narrows the physical read:
 * filtering on `status` keeps each read proportional to the backlog, never the history. */
export function laneQueue(db: Firestore, collection: string) {
  return db.collection(collection).where('status', '==', 'queued').orderBy('laneQueueKey');
}
export function laneQueuedFields(nowMs: number, id: string): { readonly laneQueueKey: string } {
  return { laneQueueKey: laneQueueKey(nowMs, id) };
}

export interface LaneRow { readonly collection: string; readonly id: string; readonly data: Readonly<Record<string, unknown>>; }
export interface LanePlan { readonly executor: string; readonly calldata: string; readonly fields: Readonly<Record<string, unknown>>; }
export type LaneTerminal = { readonly status: 'confirmed' | 'failed'; readonly reason: string; readonly fields?: Readonly<Record<string, unknown>> };
export type LanePrepared = ({ readonly kind: 'sign'; readonly plan: LanePlan }) | ({ readonly kind: 'finish' } & LaneTerminal) | { readonly kind: 'wait'; readonly reason: string };
export interface LaneKind {
  readonly name: string;
  readonly collection: string;
  /** Decide an unsigned queued row: close it without a transaction, sign its checked call, or leave it for a later run. */
  prepare(row: LaneRow, gasPayer: string): Promise<LanePrepared>;
  /** The executor and calldata reconstructed from the durable record, never from the signed bytes. */
  expected(row: LaneRow): { readonly executor: string; readonly calldata: string };
  /** Reconcile consumer state for a receipt with twelve confirmations. Throwing leaves it for the next run. */
  settle(row: LaneRow, receipt: FinalizedOwnerTransaction): Promise<LaneTerminal>;
  /** Consumer writes that must commit atomically with the terminal status. Reads first, then writes. */
  onFinish?(tx: FirestoreTransaction, row: LaneRow, terminal: LaneTerminal): Promise<void>;
}
export interface LaneChain {
  /** `latest` is the lowest mined nonce either independent RPC reports, `pending` the highest seen. */
  nonces(address: string): Promise<{ readonly latest: number; readonly pending: number }>;
  baseFee(): Promise<bigint>;
  estimateGas(from: string, to: string, data: string): Promise<bigint>;
  /** Upper estimate of the full cost of one signed transaction, L1 and operator fees included. */
  cost(unsigned: TransactionRequest): Promise<bigint>;
  balance(address: string): Promise<bigint>;
  /** Send the exact bytes. An already-known or already-mined transaction is not an error. */
  broadcast(raw: string): Promise<void>;
  /** null: no receipt. Throws `recourse_transaction_not_finalized` below twelve confirmations. */
  confirmed(raw: string): Promise<FinalizedOwnerTransaction | null>;
}
export interface LaneSigner { readonly address: string; signTransaction(tx: TransactionRequest): Promise<string>; }
export interface LaneDeps {
  readonly db: Firestore;
  readonly signer: LaneSigner;
  readonly chain: LaneChain;
  readonly kinds: readonly LaneKind[];
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly workerId: string;
  /** Refuse to sign when the lane key is the settlement submitter or any other role. */
  readonly fence?: () => Promise<void>;
  readonly maxPending?: number;
  readonly concurrency?: number;
}
export interface LaneReport {
  skipped?: 'lane_busy' | 'lane_idle';
  signed: number; replaced: number; confirmed: number; failed: number; closedUnsigned: number; waiting: number;
  open: number; nextNonce: number | null; stopReason: string | null; errors: string[];
}
interface OpenEntry { readonly collection: string; readonly id: string; }
interface LaneState { nextNonce: number; open: Record<string, OpenEntry>; }

const HASH = /^0x[0-9a-f]{64}$/, ADDRESS = /^0x[0-9a-f]{40}$/;
function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:]+$/.test(message) ? message : 'recourse_lane_error';
}
function readState(data: Record<string, unknown> | undefined): LaneState | null {
  if (!data || data.next_nonce === undefined) return null;
  const nextNonce = data.next_nonce, open = data.open;
  if (typeof nextNonce !== 'number' || !Number.isSafeInteger(nextNonce) || nextNonce < 0
    || !open || typeof open !== 'object' || Array.isArray(open)) throw Error('recourse_lane_state_invalid');
  const entries: Record<string, OpenEntry> = {};
  for (const [nonce, value] of Object.entries(open as Record<string, unknown>)) {
    const entry = value as Record<string, unknown> | null;
    if (!/^(?:0|[1-9][0-9]*)$/.test(nonce) || Number(nonce) >= nextNonce || !entry || typeof entry.collection !== 'string'
      || typeof entry.id !== 'string') throw Error('recourse_lane_state_invalid');
    entries[nonce] = { collection: entry.collection, id: entry.id };
  }
  return { nextNonce, open: entries };
}
/** Validate one signed variant against the record before it is broadcast or reconciled. */
export function assertLaneTransaction(raw: string, signer: string, nonce: number, expected: { executor: string; calldata: string }): Transaction {
  const tx = Transaction.from(raw);
  if (!tx.signature || tx.from?.toLowerCase() !== signer || tx.chainId !== 8453n || tx.type !== 2 || tx.nonce !== nonce
    || tx.to?.toLowerCase() !== expected.executor.toLowerCase() || tx.data !== expected.calldata || tx.value !== 0n || tx.gasLimit <= 0n
    || tx.maxFeePerGas === null || tx.maxPriorityFeePerGas === null || tx.maxFeePerGas < tx.maxPriorityFeePerGas) {
    throw Error('recourse_lane_signed_mismatch');
  }
  return tx;
}
function variants(row: LaneRow): string[] {
  const current = row.data.signedTransaction, replaced = row.data.replacedTransactions ?? [];
  if (typeof current !== 'string' || row.data.transactionHash !== keccak256(current) || !Array.isArray(replaced)
    || !replaced.every(value => typeof value === 'string')) throw Error('recourse_lane_record_invalid');
  return [current, ...(replaced as string[])];
}

/**
 * One bounded run. Reconcile everything already signed, then sign the oldest
 * live queued requests until `deadlineMs`, the mempool bound or the queue end.
 */
export async function runRecourseLane(deps: LaneDeps, deadlineMs: number): Promise<LaneReport> {
  const now = deps.now ?? Date.now, sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const db = deps.db, signer = deps.signer.address.toLowerCase(), kinds = new Map(deps.kinds.map(kind => [kind.collection, kind]));
  const maxPending = deps.maxPending ?? LANE_MAX_PENDING, concurrency = deps.concurrency ?? LANE_PREPARE_CONCURRENCY;
  if (!ADDRESS.test(signer) || kinds.size !== deps.kinds.length) throw Error('recourse_lane_configuration_invalid');
  const report: LaneReport = { signed: 0, replaced: 0, confirmed: 0, failed: 0, closedUnsigned: 0, waiting: 0,
    open: 0, nextNonce: null, stopReason: null, errors: [] };
  const laneRef = db.collection(RECOURSE_LANE_COLLECTION).doc(signer);

  // An idle lane makes no RPC call: nothing open and nothing queued.
  const initial = await laneRef.get();
  const known = readState(initial.exists ? initial.data() : undefined);
  if (known && Object.keys(known.open).length === 0 && !(await anyQueued(db, deps.kinds))) {
    report.skipped = 'lane_idle'; report.nextNonce = known.nextNonce; return report;
  }
  if (!known && !(await anyQueued(db, deps.kinds))) { report.skipped = 'lane_idle'; return report; }

  const chainAtStart = await deps.chain.nonces(signer);
  const acquired = await db.runTransaction(async tx => {
    const snap = await tx.get(laneRef), data = snap.exists ? snap.data() : undefined;
    const owner = data?.owner, expires = Number(data?.expires_at_ms ?? 0);
    if (typeof owner === 'string' && owner !== deps.workerId && expires > now()) return null;
    let state = readState(data);
    if (!state) {
      // First use of this key: nothing may be pending from any other writer.
      if (chainAtStart.pending !== chainAtStart.latest) throw Error('recourse_lane_nonce_foreign');
      state = { nextNonce: chainAtStart.latest, open: {} };
    }
    tx.set(laneRef, { signer, owner: deps.workerId, acquired_at_ms: now(), expires_at_ms: now() + LANE_LEASE_TTL_MS,
      next_nonce: state.nextNonce, open: state.open }, { merge: false });
    return state;
  });
  if (!acquired) { report.skipped = 'lane_busy'; return report; }
  const state: LaneState = acquired;

  /** Every write re-proves the lease and the nonce the run believes it holds. */
  const assertLease = async (tx: FirestoreTransaction): Promise<LaneState> => {
    const snap = await tx.get(laneRef), data = snap.data();
    const current = readState(data);
    if (!current || data?.owner !== deps.workerId || Number(data?.expires_at_ms) <= now()
      || current.nextNonce !== state.nextNonce) throw Error('recourse_lane_lease_lost');
    return current;
  };
  const renew = async () => {
    await db.runTransaction(async tx => {
      await assertLease(tx);
      tx.update(laneRef, { expires_at_ms: now() + LANE_LEASE_TTL_MS });
    });
  };
  const rowRef = (row: { collection: string; id: string }) => db.collection(row.collection).doc(row.id);
  const loadRow = async (entry: OpenEntry): Promise<LaneRow> => {
    const snap = await rowRef(entry).get();
    if (!snap.exists) throw Error('recourse_lane_record_missing');
    return { collection: entry.collection, id: entry.id, data: snap.data() ?? {} };
  };

  /** Close a row atomically with its consumer writes and, if it holds one, its nonce. */
  const finish = async (row: LaneRow, terminal: LaneTerminal, nonce: number | null, signed?: { raw: string; replaced: string[] }) => {
    const kind = kinds.get(row.collection)!;
    await db.runTransaction(async tx => {
      const current = await assertLease(tx);
      const snap = await tx.get(rowRef(row)), data = snap.data() ?? {};
      if (nonce === null) {
        if (data.signedTransaction !== undefined || data.status !== 'queued' || data.laneQueueKey !== row.data.laneQueueKey) throw Error('recourse_lane_record_changed');
      } else {
        const entry = current.open[String(nonce)];
        if (!entry || entry.collection !== row.collection || entry.id !== row.id || data.laneNonce !== nonce
          || data.status !== 'submitted' || data.transactionHash !== row.data.transactionHash) throw Error('recourse_lane_record_changed');
      }
      if (kind.onFinish) await kind.onFinish(tx, { ...row, data: signed ? { ...data, signedTransaction: signed.raw, transactionHash: keccak256(signed.raw) } : data }, terminal);
      // The consumer's fields come last: an owner operation executed by another
      // sponsor records that transaction's hash, keeping ours as the sponsored one.
      tx.update(rowRef(row), {
        ...(signed ? { signedTransaction: signed.raw, transactionHash: keccak256(signed.raw), replacedTransactions: signed.replaced } : {}),
        ...(terminal.fields ?? {}), status: terminal.status, terminalReason: terminal.reason, finalizedAtMs: now(),
        laneQueueKey: FieldValue.delete() });
      if (nonce !== null) {
        const open = { ...current.open }; delete open[String(nonce)];
        tx.update(laneRef, { open, expires_at_ms: now() + LANE_LEASE_TTL_MS });
      }
    });
    if (nonce !== null) delete state.open[String(nonce)];
    if (nonce === null) report.closedUnsigned++;
    if (terminal.status === 'confirmed') report.confirmed++; else report.failed++;
  };

  let feeQuote: { baseFee: bigint; atMs: number } | null = null;
  const baseFee = async () => {
    if (!feeQuote || now() - feeQuote.atMs > 10_000) feeQuote = { baseFee: await deps.chain.baseFee(), atMs: now() };
    return feeQuote.baseFee;
  };

  /** Replace a stuck transaction with the same nonce, target and calldata at a higher fee. */
  const replace = async (row: LaneRow, nonce: number, raw: string, previous: string[]) => {
    const tx = Transaction.from(raw), base = await baseFee();
    const priority = [tx.maxPriorityFeePerGas! * 5n / 4n + 1n, LANE_PRIORITY_FEE_WEI].reduce((a, b) => a > b ? a : b);
    const maxFee = [tx.maxFeePerGas! * 5n / 4n + 1n, base * 3n + priority].reduce((a, b) => a > b ? a : b);
    if (maxFee > LANE_MAX_FEE_CEILING_WEI) throw Error('recourse_lane_fee_ceiling');
    const unsigned: TransactionRequest = { type: 2, chainId: 8453, nonce, to: tx.to!, data: tx.data, value: 0, gasLimit: tx.gasLimit,
      maxFeePerGas: maxFee, maxPriorityFeePerGas: priority };
    const next = await deps.signer.signTransaction(unsigned);
    assertLaneTransaction(next, signer, nonce, kinds.get(row.collection)!.expected(row));
    await db.runTransaction(async t => {
      const current = await assertLease(t);
      const snap = await t.get(rowRef(row)), data = snap.data() ?? {};
      const entry = current.open[String(nonce)];
      if (!entry || entry.id !== row.id || data.signedTransaction !== raw || data.status !== 'submitted') throw Error('recourse_lane_record_changed');
      t.update(rowRef(row), { signedTransaction: next, transactionHash: keccak256(next), replacedTransactions: [raw, ...previous], laneSignedAtMs: now() });
      t.update(laneRef, { expires_at_ms: now() + LANE_LEASE_TTL_MS });
    });
    report.replaced++;
    await deps.chain.broadcast(next);
  };

  let chainNonces = chainAtStart;
  /** Unmined bytes are sent at most once per run. */
  const sentThisRun = new Set<number>();
  const refreshNonces = async () => {
    chainNonces = await deps.chain.nonces(signer);
    // Another writer used this key: never sign over it. Reconciliation continues.
    if (chainNonces.latest > state.nextNonce || chainNonces.pending > state.nextNonce) report.stopReason = 'recourse_lane_nonce_foreign';
  };

  /** Reconcile every open nonce: settle confirmed receipts, rebroadcast or replace unmined bytes. */
  const reconcile = async () => {
    await refreshNonces();
    for (const nonceKey of Object.keys(state.open).map(Number).sort((a, b) => a - b)) {
      if (now() >= deadlineMs) return;
      const entry = state.open[String(nonceKey)];
      try {
        const row = await loadRow(entry), kind = kinds.get(row.collection);
        // Just sent: it cannot have twelve confirmations, and its bytes are already out.
        // A failed first broadcast is marked on the row and resent on the next run instead.
        if (now() - Number(row.data.laneSignedAtMs ?? 0) < LANE_CONFIRMATION_WAIT_MS && row.data.laneBroadcastFailedAtMs === undefined) continue;
        if (!kind) throw Error('recourse_lane_kind_unknown');
        const all = variants(row), expected = kind.expected(row);
        for (const raw of all) assertLaneTransaction(raw, signer, nonceKey, expected);
        let mined = false, terminal: FinalizedOwnerTransaction | null = null, landed: string | null = null;
        for (const raw of all) {
          try {
            const result = await deps.chain.confirmed(raw);
            if (result) { terminal = result; landed = raw; break; }
          } catch (error) {
            if (errorCode(error) === 'recourse_transaction_not_finalized') { mined = true; break; }
            throw error;
          }
        }
        if (terminal && landed) {
          const settledRow: LaneRow = { ...row, data: { ...row.data, signedTransaction: landed, transactionHash: keccak256(landed) } };
          const outcome = await kind.settle(settledRow, terminal);
          await finish(row, outcome, nonceKey, { raw: landed, replaced: all.filter(raw => raw !== landed) });
          continue;
        }
        if (mined) continue;
        // No variant has a receipt. A consumed nonce means a receipt is still propagating.
        if (nonceKey < chainNonces.latest) { report.errors.push(`recourse_lane_receipt_lagging:${nonceKey}`); continue; }
        const current = all[0], signedAt = Number(row.data.laneSignedAtMs ?? 0);
        if (now() - signedAt >= LANE_REPLACE_AFTER_MS) {
          const tx = Transaction.from(current), base = await baseFee();
          if (nonceKey === chainNonces.latest || tx.maxFeePerGas! < base * 2n + tx.maxPriorityFeePerGas!) {
            await replace(row, nonceKey, current, all.slice(1));
            sentThisRun.add(nonceKey);
            continue;
          }
        }
        if (!sentThisRun.has(nonceKey)) { sentThisRun.add(nonceKey); await deps.chain.broadcast(current); }
      } catch (error) {
        const code = errorCode(error);
        report.errors.push(`${code}:${nonceKey}`);
        if (code === 'recourse_lane_lease_lost' || code === 'recourse_lane_fee_ceiling' || code === 'recourse_lane_signed_mismatch') {
          report.stopReason = code; return;
        }
      }
    }
  };

  // Oldest live request first across every kind. Each collection is read in key order.
  const cursors = new Map(deps.kinds.map(kind => [kind.collection, { after: null as string | null, buffer: [] as LaneRow[], drained: false }]));
  const skip = new Set<string>();
  const nextBatch = async (limit: number): Promise<LaneRow[]> => {
    const batch: LaneRow[] = [];
    while (batch.length < limit) {
      for (const [collection, cursor] of cursors) {
        if (cursor.buffer.length > 0) continue;
        let query = laneQueue(db, collection).limit(25);
        if (cursor.after) query = query.startAfter(cursor.after);
        const page = await query.get();
        cursor.buffer = page.docs.map(doc => ({ collection, id: doc.id, data: doc.data() }));
        if (cursor.buffer.length > 0) cursor.after = String(cursor.buffer[cursor.buffer.length - 1].data.laneQueueKey);
      }
      let best: { collection: string; row: LaneRow } | null = null;
      for (const [collection, cursor] of cursors) {
        const head = cursor.buffer[0];
        if (head && (!best || String(head.data.laneQueueKey) < String(best.row.data.laneQueueKey))) best = { collection, row: head };
      }
      if (!best) break;
      cursors.get(best.collection)!.buffer.shift();
      const key = `${best.collection}/${best.row.id}`;
      if (skip.has(key) || best.row.data.status !== 'queued' || best.row.data.signedTransaction !== undefined) continue;
      skip.add(key);
      batch.push(best.row);
    }
    return batch;
  };

  try {
    await reconcile();
    if (deps.fence && report.stopReason === null) {
      try { await deps.fence(); } catch (error) { report.stopReason = errorCode(error); }
    }
    while (report.stopReason === null && now() < deadlineMs) {
      await renew();
      const pending = state.nextNonce - chainNonces.latest;
      if (pending >= maxPending || Object.keys(state.open).length >= LANE_MAX_OPEN) {
        await sleep(LANE_WAIT_MS);
        await reconcile();
        continue;
      }
      const batch = await nextBatch(Math.min(concurrency, maxPending - pending));
      if (batch.length === 0) break;
      const prepared = await Promise.all(batch.map(async row => {
        const kind = kinds.get(row.collection)!;
        try {
          const decision = await kind.prepare(row, signer);
          if (decision.kind !== 'sign') return { row, decision, gas: 0n };
          const gas = await deps.chain.estimateGas(signer, decision.plan.executor, decision.plan.calldata);
          return { row, decision, gas: (gas * 120n + 99n) / 100n };
        } catch (error) {
          return { row, decision: { kind: 'wait', reason: errorCode(error) } as LanePrepared, gas: 0n };
        }
      }));
      const signable = prepared.filter(item => item.decision.kind === 'sign');
      const base = signable.length > 0 ? await baseFee() : 0n;
      const maxFee = base * 3n + LANE_PRIORITY_FEE_WEI;
      let affordable = Number.MAX_SAFE_INTEGER;
      if (signable.length > 0) {
        // Every unmined transaction already signed, plus this batch, must be fundable.
        const costs = await Promise.all(signable.map(item => {
          const plan = (item.decision as { plan: LanePlan }).plan;
          return deps.chain.cost({ type: 2, chainId: 8453, nonce: state.nextNonce, to: plan.executor, data: plan.calldata, value: 0,
            gasLimit: item.gas, maxFeePerGas: maxFee, maxPriorityFeePerGas: LANE_PRIORITY_FEE_WEI });
        }));
        const each = costs.reduce((a, b) => a > b ? a : b, 0n);
        const balance = await deps.chain.balance(signer);
        const reserved = BigInt(Math.max(0, state.nextNonce - chainNonces.latest)) * each;
        affordable = each === 0n ? signable.length : Number((balance - reserved) / each);
        if (affordable < signable.length) report.stopReason = 'recourse_lane_gas_unavailable';
      }
      for (const item of prepared) {
        const decision = item.decision;
        if (decision.kind === 'wait') { report.waiting++; report.errors.push(`${decision.reason}:${item.row.id}`); continue; }
        if (decision.kind === 'finish') {
          try { await finish(item.row, decision, null); }
          catch (error) { report.errors.push(`${errorCode(error)}:${item.row.id}`); }
          continue;
        }
        if (affordable <= 0) continue;
        affordable--;
        const plan = decision.plan, nonce = state.nextNonce;
        const unsigned: TransactionRequest = { type: 2, chainId: 8453, nonce, to: plan.executor, data: plan.calldata, value: 0,
          gasLimit: item.gas, maxFeePerGas: maxFee, maxPriorityFeePerGas: LANE_PRIORITY_FEE_WEI };
        let raw: string;
        try {
          raw = await deps.signer.signTransaction(unsigned);
          assertLaneTransaction(raw, signer, nonce, plan);
        } catch (error) {
          // Nothing persisted: the row stays queued and the nonce stays free.
          report.errors.push(`${errorCode(error)}:${item.row.id}`); report.stopReason = 'recourse_lane_sign_failed'; break;
        }
        try {
          await db.runTransaction(async tx => {
            const current = await assertLease(tx);
            const ref = rowRef(item.row), snap = await tx.get(ref), data = snap.data() ?? {};
            if (data.status !== 'queued' || data.signedTransaction !== undefined || data.laneQueueKey !== item.row.data.laneQueueKey) throw Error('recourse_lane_record_changed');
            tx.update(ref, { ...plan.fields, executor: plan.executor, gasPayer: signer, signedTransaction: raw, transactionHash: keccak256(raw),
              replacedTransactions: [], status: 'submitted', laneSigner: signer, laneNonce: nonce, laneSignedAtMs: now(), preparedAtMs: now(),
              laneQueueKey: FieldValue.delete() });
            tx.update(laneRef, { next_nonce: nonce + 1, open: { ...current.open, [String(nonce)]: { collection: item.row.collection, id: item.row.id } },
              expires_at_ms: now() + LANE_LEASE_TTL_MS });
          });
        } catch (error) {
          // Nothing persisted, so nothing was broadcast and the nonce is still free.
          const code = errorCode(error);
          report.errors.push(`${code}:${item.row.id}`);
          if (code === 'recourse_lane_lease_lost') { report.stopReason = code; break; }
          continue;
        }
        state.nextNonce = nonce + 1;
        state.open[String(nonce)] = { collection: item.row.collection, id: item.row.id };
        report.signed++;
        sentThisRun.add(nonce);
        try { await deps.chain.broadcast(raw); }
        catch (error) {
          // The persisted bytes are rebroadcast by reconciliation; stop adding behind them.
          report.errors.push(`${errorCode(error)}:${item.row.id}`); report.stopReason = 'recourse_lane_broadcast_failed';
          try { await rowRef(item.row).update({ laneBroadcastFailedAtMs: now() }); } catch { /* resent once old enough */ }
          break;
        }
      }
    }
    if (report.stopReason === null || report.stopReason === 'recourse_lane_broadcast_failed') await reconcile();
  } finally {
    report.open = Object.keys(state.open).length; report.nextNonce = state.nextNonce;
    await db.runTransaction(async tx => {
      const snap = await tx.get(laneRef);
      if (snap.get('owner') === deps.workerId) tx.update(laneRef, { expires_at_ms: now() });
    });
  }
  return report;
}

export async function anyQueued(db: Firestore, kinds: readonly LaneKind[]): Promise<boolean> {
  const pages = await Promise.all(kinds.map(kind => laneQueue(db, kind.collection).limit(1).get()));
  return pages.some(page => !page.empty);
}
/** True while `id` still holds an unreconciled lane nonce. Retry paths must not requeue it. */
export async function laneHoldsOperation(tx: FirestoreTransaction, db: Firestore, signer: string, collection: string, id: string): Promise<boolean> {
  if (!ADDRESS.test(signer) || !HASH.test(id)) return true;
  const lane = await tx.get(db.collection(RECOURSE_LANE_COLLECTION).doc(signer));
  const open = lane.get('open');
  if (!open || typeof open !== 'object') return false;
  return Object.values(open as Record<string, OpenEntry>).some(entry => entry?.collection === collection && entry?.id === id);
}
