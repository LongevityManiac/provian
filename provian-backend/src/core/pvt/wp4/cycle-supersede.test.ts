/**
 * THE WEDGE, MADE EXECUTABLE — then un-wedged.
 *
 * The defect (M7, carried in OPEN_ITEMS): one refusal-closed cycle blocked every later
 * settlement run for the rest of the UTC day, because the day's single cycle id refused
 * `acquireCycleLease` forever with `cycle_closed`. The RED control here reproduces that
 * exact sequence through the REAL store functions before proving the resolver clears it —
 * and proves the resolver REFUSES when the closed cycle holds anything unresolved, which is
 * the deadlock case a suffixed id must never paper over.
 */

import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import {
  MAX_CYCLE_SUPERSESSIONS,
  resolveEffectiveCycleId,
} from './cycle-supersede';
import {
  SETTLEMENT_BATCHES_COLLECTION,
  SETTLEMENT_CYCLES_COLLECTION,
  acquireCycleLease,
  closeCycle,
  recordAttempt,
  registerClaim,
  reserveBatch,
  type NewClaimInput,
  type SettlementDb,
} from './durable-settlement-store';

const BASE = 'epoch1-2026-08-04';
const WORKER = 'worker-supersede';
const NOW = 20_000_000;

function H(n: number): string {
  return `0x${n.toString(16).padStart(64, '0')}`;
}
function ADDR(n: number): string {
  return `0x${n.toString(16).padStart(40, '0')}`;
}

async function openCycle(db: SettlementDb, cycleId: string): Promise<void> {
  const acquired = await acquireCycleLease(db, {
    cycleId,
    workerId: WORKER,
    nowMs: NOW,
    leaseTtlMs: 60_000,
    epoch: 1,
    policyHash: H(0xfeed),
    signer: ADDR(0xbeef),
    baseNonce: 3,
    limits: { max_transactions: 100, max_fee_wei_total: '100000000000000000' },
    cursorStart: 0n,
  });
  if (acquired.kind !== 'acquired') throw new Error(`setup lease failed: ${acquired.kind}`);
}

async function closeAs(db: SettlementDb, cycleId: string, stopReason: string): Promise<void> {
  await closeCycle(db, {
    cycleId, workerId: WORKER, nowMs: NOW + 5, status: 'stopped', stopReason,
  });
}

async function reserveOn(db: SettlementDb, cycleId: string): Promise<void> {
  const claims: NewClaimInput[] = [1, 2].map((n) => ({
    leg: 'sole',
    pe_id: `pe-${n}`,
    claim_id: H(n),
    lane: 'standard',
    contributor: ADDR(0xa1),
    beneficiary_class: 1,
    record_points_atomic: '1000000000000000000',
  }));
  for (const claim of claims) {
    const registered = await registerClaim(db, claim, NOW);
    if (registered.kind !== 'created' && registered.kind !== 'already_registered_identical') {
      throw new Error(`setup register failed: ${registered.kind}`);
    }
  }
  const reserved = await reserveBatch(db, {
    cycleId,
    workerId: WORKER,
    nowMs: NOW + 1,
    batchId: H(0x7001),
    lane: 'standard',
    epoch: 1,
    policyHash: H(0xfeed),
    cursorStart: 0n,
    cursorEnd: 2n,
    recipientCount: 1,
    claimCount: 2,
    totalMintedAtomic: 55n,
    calldata: '0xdeadbeef',
    members: [
      { leg: 'sole' as const, pe_id: 'pe-1', claim_id: H(1) },
      { leg: 'sole' as const, pe_id: 'pe-2', claim_id: H(2) },
    ],
  });
  if (reserved.kind !== 'reserved') throw new Error(`setup reserve failed: ${reserved.kind}`);
}

async function docCount(db: SettlementDb, collection: string): Promise<number> {
  const snap = await db.collection(collection).get();
  return snap.docs.length;
}

describe('resolveEffectiveCycleId', () => {
  it('uses the base id untouched on a fresh day', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const resolved = await resolveEffectiveCycleId(db, BASE);
    expect(resolved).toEqual({ kind: 'ok', cycleId: BASE, supersededCycleIds: [] });
  });

  it('resumes an active cycle rather than superseding it', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await openCycle(db, BASE);
    const resolved = await resolveEffectiveCycleId(db, BASE);
    expect(resolved).toEqual({ kind: 'ok', cycleId: BASE, supersededCycleIds: [] });
  });

  it('RED CONTROL — the wedge is real: a refusal-closed cycle refuses its lease forever', async () => {
    // The pre-fix behaviour, reproduced through the real store: after one
    // batch_unsettleable stop, the day's id is dead and a second run gets cycle_closed.
    const db = createFakeFirestore() as unknown as SettlementDb;
    await openCycle(db, BASE);
    await closeAs(db, BASE, 'batch_unsettleable');
    const secondRun = await acquireCycleLease(db, {
      cycleId: BASE, workerId: 'worker-b', nowMs: NOW + 100, leaseTtlMs: 60_000,
      epoch: 1, policyHash: H(0xfeed), signer: ADDR(0xbeef), baseNonce: 3,
      limits: { max_transactions: 100, max_fee_wei_total: '100000000000000000' },
      cursorStart: 0n,
    });
    expect(secondRun).toEqual({ kind: 'refused', reason: 'cycle_closed' });
  });

  it('UN-WEDGES: supersedes a refusal-closed empty cycle and the new id takes a lease', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await openCycle(db, BASE);
    await closeAs(db, BASE, 'batch_approval_refused');

    const resolved = await resolveEffectiveCycleId(db, BASE);
    expect(resolved.kind).toBe('ok');
    if (resolved.kind !== 'ok') return;
    expect(resolved.cycleId).toBe(`${BASE}-r2`);
    expect(resolved.supersededCycleIds).toEqual([BASE]);

    // End to end: the resolved id is actually runnable.
    const lease = await acquireCycleLease(db, {
      cycleId: resolved.cycleId, workerId: 'worker-b', nowMs: NOW + 100, leaseTtlMs: 60_000,
      epoch: 1, policyHash: H(0xfeed), signer: ADDR(0xbeef), baseNonce: 3,
      limits: { max_transactions: 100, max_fee_wei_total: '100000000000000000' },
      cursorStart: 0n,
    });
    expect(lease.kind).toBe('acquired');
  });

  it('walks past multiple closed-empty supersessions in one day', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await openCycle(db, BASE);
    await closeAs(db, BASE, 'batch_unsettleable');
    await openCycle(db, `${BASE}-r2`);
    await closeAs(db, `${BASE}-r2`, 'fee_limit');

    const resolved = await resolveEffectiveCycleId(db, BASE);
    expect(resolved).toEqual({
      kind: 'ok',
      cycleId: `${BASE}-r3`,
      supersededCycleIds: [BASE, `${BASE}-r2`],
    });
  });

  it('REFUSES to supersede past a closed cycle holding a SUBMITTED batch (the case)', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await openCycle(db, BASE);
    await reserveOn(db, BASE);
    const attempt = await recordAttempt(db, {
      cycleId: BASE, batchId: H(0x7001), workerId: WORKER, nowMs: NOW + 2,
      attempt: {
        nonce: 3,
        tx_hash: H(0xabc),
        kind: 'original',
        max_fee_per_gas_wei: '5',
        max_priority_fee_per_gas_wei: '1',
        gas_limit: '100000',
      },
    });
    expect(attempt.kind).toBe('recorded');
    // A submitted attempt can outlive its cycle only via the broadcast_failed non-closing
    // stop — but a crash plus an operator closing by hand can produce this shape, and it is
    // exactly the one a fresh cycle id must never step around.
    await closeAs(db, BASE, 'operator_manual_close');

    const resolved = await resolveEffectiveCycleId(db, BASE);
    expect(resolved).toEqual({
      kind: 'refused',
      reason: 'closed_cycle_has_unresolved_batches',
      cycleId: BASE,
      unresolvedStatuses: ['submitted'],
    });
  });

  it('REFUSES to supersede past a closed cycle holding a RESERVED orphan', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await openCycle(db, BASE);
    await reserveOn(db, BASE);
    await closeAs(db, BASE, 'batch_unsettleable');

    const resolved = await resolveEffectiveCycleId(db, BASE);
    expect(resolved.kind).toBe('refused');
    if (resolved.kind !== 'refused') return;
    expect(resolved.reason).toBe('closed_cycle_has_unresolved_batches');
    expect(resolved.unresolvedStatuses).toEqual(['reserved']);
  });

  it('stops at the supersession backstop instead of looping', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await openCycle(db, BASE);
    await closeAs(db, BASE, 'batch_unsettleable');
    for (let n = 2; n <= MAX_CYCLE_SUPERSESSIONS; n += 1) {
      await openCycle(db, `${BASE}-r${n}`);
      await closeAs(db, `${BASE}-r${n}`, 'batch_unsettleable');
    }
    const resolved = await resolveEffectiveCycleId(db, BASE);
    expect(resolved.kind).toBe('refused');
    if (resolved.kind !== 'refused') return;
    expect(resolved.reason).toBe('supersede_limit');
  });

  it('REPLAY CANARY — resolution is read-only and idempotent across a crash/re-run', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await openCycle(db, BASE);
    await closeAs(db, BASE, 'batch_unsettleable');

    const cyclesBefore = await docCount(db, SETTLEMENT_CYCLES_COLLECTION);
    const batchesBefore = await docCount(db, SETTLEMENT_BATCHES_COLLECTION);

    // A run that resolved and then crashed before taking the lease leaves NOTHING behind:
    // the identical re-run resolves to the identical id, and no doc moved.
    const first = await resolveEffectiveCycleId(db, BASE);
    const second = await resolveEffectiveCycleId(db, BASE);
    expect(second).toEqual(first);
    expect(await docCount(db, SETTLEMENT_CYCLES_COLLECTION)).toBe(cyclesBefore);
    expect(await docCount(db, SETTLEMENT_BATCHES_COLLECTION)).toBe(batchesBefore);
  });
});
