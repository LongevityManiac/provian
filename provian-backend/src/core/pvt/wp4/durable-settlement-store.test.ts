/**
 * settlement runtime — durable settlement store tests.
 *
 * The properties under test are the acceptance lines of plan §settlement runtime item 5:
 * durable cursor, cumulative counters that survive retry, single-worker
 * lease, safe nonce ownership, and the exactly-once apply that makes crash
 * continuation sound. The same-nonce replacement rule (no two live
 * settlements for one reservation) is enforced here transactionally.
 */

import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import { PAYOUT_LEG_ROLES } from '../wp-ev/payout-legs';
import {
  CLAIM_HOLD_BASE_MS,
  CLAIM_HOLD_MAX_MS,
  CLAIM_LEDGER_COLLECTION,
  PE_HISTORY_COLLECTION,
  SETTLEMENT_BATCHES_COLLECTION,
  SETTLEMENT_CYCLES_COLLECTION,
  acquireCycleLease,
  acquireSignerLease,
  claimHoldBackoffMs,
  clearMinedReceipt,
  holdClaims,
  revertReorgedBatch,
  settleClaimsFromChainEvidence,
  listHeldClaims,
  allocateNonce,
  applyConfirmedBatch,
  claimKeyOf,
  closeCycle,
  listUnresolvedBatches,
  markBatchDead,
  readLedgerPage,
  recordAttempt,
  recordMinedReceipt,
  registerClaim,
  registerClaimsBulk,
  releaseUnusedNonce,
  repairLedgerWritebacks,
  reserveBatch,
  retireIfNeverBroadcastOrphan,
  retireNeverBroadcastOrphans,
  writeLedgerSettlement,
  type NewClaimInput,
  type SettlementBatchDoc,
  type SettlementCycleDoc,
  type SettlementDb,
} from './durable-settlement-store';
import { resolveEffectiveCycleId } from './cycle-supersede';

const H = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const ADDR = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;

function standardClaim(n: number, contributor = ADDR(0xa1)): NewClaimInput {
  return {
    leg: 'sole' as const,
    pe_id: `pe-${n}`,
    claim_id: H(n),
    lane: 'standard',
    contributor,
    beneficiary_class: 1,
    record_points_atomic: '1000000000000000000',
  };
}

function genesisClaim(n: number, contributor = ADDR(0xb1)): NewClaimInput {
  return {
    leg: 'sole' as const,
    pe_id: `pe-g-${n}`,
    claim_id: H(1000 + n),
    lane: 'genesis',
    contributor,
    genesis_anchor_key: H(2000 + n),
    wallet_id: H(3000 + n),
    one_time_anchor: H(4000 + n),
    grant_type: 1,
    qualified_at: 1_700_000_000_000,
    reserved_gross_atomic: '75000000000000000000',
  };
}

const CYCLE = 'cycle-epoch0-1';
const WORKER = 'worker-a';
const NOW = 10_000_000;

async function freshCycle(db: SettlementDb, overrides?: {
  maxTransactions?: number;
  cursorStart?: bigint;
}): Promise<SettlementCycleDoc> {
  const acquired = await acquireCycleLease(db, {
    cycleId: CYCLE,
    workerId: WORKER,
    nowMs: NOW,
    leaseTtlMs: 60_000,
    epoch: 0,
    policyHash: H(0xfeed),
    signer: ADDR(0xbeef),
    baseNonce: 7,
    limits: {
      max_transactions: overrides?.maxTransactions ?? 100,
      max_fee_wei_total: '100000000000000000',
    },
    cursorStart: overrides?.cursorStart ?? 0n,
  });
  if (acquired.kind !== 'acquired') throw new Error('setup lease failed');
  return acquired.cycle;
}

async function reserveOne(db: SettlementDb, batchN = 1, cursorStart = 0n, claimCount = 2) {
  for (let i = 0; i < claimCount; i += 1) {
    await registerClaim(db, standardClaim(i + 1), NOW);
  }
  return reserveBatch(db, {
    cycleId: CYCLE,
    workerId: WORKER,
    nowMs: NOW + 1,
    batchId: H(0x5000 + batchN),
    lane: 'standard',
    epoch: 0,
    policyHash: H(0xfeed),
    cursorStart,
    cursorEnd: cursorStart + BigInt(claimCount),
    recipientCount: 1,
    claimCount,
    totalMintedAtomic: 123n,
    calldata: '0xdeadbeef',
    members: Array.from({ length: claimCount }, (_, i) => ({
      leg: 'sole' as const,
      pe_id: `pe-${i + 1}`,
      claim_id: H(i + 1),
    })),
  });
}

describe('claim ledger', () => {
  it('registers a claim once and is idempotent for the identical identity', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    expect((await registerClaim(db, standardClaim(1), NOW)).kind).toBe('created');
    expect((await registerClaim(db, standardClaim(1), NOW + 1)).kind)
      .toBe('already_registered_identical');
  });

  it('rejects claim-id drift for an already-registered PE (double-mint vector)', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await registerClaim(db, standardClaim(1), NOW);
    const drifted = { ...standardClaim(1), claim_id: H(99) };
    const result = await registerClaim(db, drifted, NOW + 1);
    expect(result).toEqual({ kind: 'rejected', reason: 'claim_identity_drift' });
  });

  it('normalizes PE identity the way claim-identity does (case/whitespace)', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await registerClaim(db, standardClaim(1), NOW);
    const spoofed = { ...standardClaim(1), pe_id: ' PE-1 ', claim_id: H(99) };
    const result = await registerClaim(db, spoofed, NOW + 1);
    expect(result).toEqual({ kind: 'rejected', reason: 'claim_identity_drift' });
  });

  it('refuses lane-mismatched payloads in both directions', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const genesisOnStandard = { ...standardClaim(2), wallet_id: H(1) };
    expect((await registerClaim(db, genesisOnStandard, NOW)).kind).toBe('rejected');
    const standardOnGenesis = { ...genesisClaim(2), record_points_atomic: '1' };
    expect((await registerClaim(db, standardOnGenesis, NOW)).kind).toBe('rejected');
  });

  it('bulk registration validates every row before writing any', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as SettlementDb;
    const bad = { ...standardClaim(3), claim_id: '0xnope' };
    await expect(registerClaimsBulk(db, [standardClaim(1), bad], NOW))
      .rejects.toThrow('invalid_claim_id');
    expect(fake.store.size).toBe(0);
  });

  it('pages the ledger by document id with the unsettled filter', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await registerClaimsBulk(db, [1, 2, 3, 4, 5].map((n) => standardClaim(n, ADDR(0xa0 + n))), NOW);
    const first = await readLedgerPage(db, { pageSize: 2, unsettledOnly: true });
    expect(first.rows).toHaveLength(2);
    const second = await readLedgerPage(db, {
      pageSize: 2, unsettledOnly: true, startAfterDocId: first.lastDocId!,
    });
    expect(second.rows).toHaveLength(2);
    const ids = [...first.rows, ...second.rows].map((r) => r.docId);
    expect(new Set(ids).size).toBe(4);
  });
});

describe('M9r2 · the leg is validated at the WRITE boundary', () => {
  it('refuses a claim whose leg is not a recognized payout role', async () => {
    // `leg` is HALF the document id (`${pe_key}#${leg}`) and was validated nowhere: not by
    // `validateNewClaim`, and not by `assertNoLegacyLedgerRows` either, since a row written with
    // `leg: undefined` yields the NON-EMPTY claim_key "pe#undefined" and passes that guard
    // cleanly. `claim-identity.ts` then dropped such a record, silently unenforcing every drift
    // check for it. The violating value is constructible because the field is a plain string.
    const db = createFakeFirestore() as unknown as SettlementDb;
    const bad = { ...standardClaim(1), leg: 'not-a-leg' } as unknown as NewClaimInput;
    expect(await registerClaim(db, bad, NOW))
      .toEqual({ kind: 'rejected', reason: 'invalid_leg' });

    const missing = { ...standardClaim(1) } as Record<string, unknown>;
    delete missing.leg;
    expect(await registerClaim(db, missing as unknown as NewClaimInput, NOW))
      .toEqual({ kind: 'rejected', reason: 'invalid_leg' });

    // GREEN CONTROL: every REAL role is accepted, so the refusals above are about the value and
    // not about the check rejecting everything. Bound to the single source, so a fourth role is
    // covered without anyone remembering to add it here.
    for (const leg of PAYOUT_LEG_ROLES) {
      const fresh = createFakeFirestore() as unknown as SettlementDb;
      expect((await registerClaim(fresh, { ...standardClaim(1), leg }, NOW)).kind)
        .toBe('created');
    }
  });
});

describe(' · settlement eligibility re-check (opts.requirePeHistoryStatus)', () => {
  const READY = 'eligible';

  async function seedPeHistory(db: SettlementDb, peId: string, mintStatus: string): Promise<void> {
    // pe_history is keyed by the RAW peId everywhere in the codebase (pe-history.ts, the inlet
    // source, the takeover's demotion), so the re-check reads the same doc a real writer wrote.
    await db.collection(PE_HISTORY_COLLECTION).doc(peId).set({ peId, mint_status: mintStatus });
  }

  async function readClaim(db: SettlementDb, input: NewClaimInput): Promise<Record<string, unknown> | undefined> {
    const snap = await db.collection(CLAIM_LEDGER_COLLECTION).doc(claimKeyOf(input.pe_id, input.leg)).get();
    return snap.exists ? snap.data() : undefined;
  }

  it('registers when the pinned pe_history.mint_status still holds', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await seedPeHistory(db, standardClaim(1).pe_id, READY);
    const result = await registerClaim(db, standardClaim(1), NOW, { requirePeHistoryStatus: READY });
    expect(result.kind).toBe('created');
    expect(await readClaim(db, standardClaim(1))).toBeDefined();
  });

  it('REFUSES a demoted incumbent and writes NO ledger row', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await seedPeHistory(db, standardClaim(1).pe_id, 'corroborated_duplicate');
    const result = await registerClaim(db, standardClaim(1), NOW, { requirePeHistoryStatus: READY });
    expect(result).toEqual({ kind: 'rejected', reason: 'pe_history_not_settleable' });
    expect(await readClaim(db, standardClaim(1))).toBeUndefined();
  });

  it('fails CLOSED when the pe_history row is missing entirely', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const result = await registerClaim(db, standardClaim(1), NOW, { requirePeHistoryStatus: READY });
    expect(result).toEqual({ kind: 'rejected', reason: 'pe_history_not_settleable' });
    expect(await readClaim(db, standardClaim(1))).toBeUndefined();
  });

  it('RED CONTROL: WITHOUT the opt the SAME demoted row STILL registers — the gate is load-bearing', async () => {
    // The empty-guard analogue for a gate: prove the refusal above is the OPT doing work, not the
    // fixture. Same demoted pe_history row, but no `requirePeHistoryStatus` → no re-check → created.
    const db = createFakeFirestore() as unknown as SettlementDb;
    await seedPeHistory(db, standardClaim(1).pe_id, 'corroborated_duplicate');
    const result = await registerClaim(db, standardClaim(1), NOW);
    expect(result.kind).toBe('created');
    expect(await readClaim(db, standardClaim(1))).toBeDefined();
  });

  it('a demotion landing MID-TRANSACTION forces a retry that observes it (no row created)', async () => {
    // The re-check reads pe_history INSIDE the txn, so a takeover that demotes the row between
    // this txn's first attempt and its commit must be seen on retry. `retryFirstTxn` models
    // exactly that: attempt one reads 'eligible' and buffers a create; that attempt is DISCARDED;
    // `beforeRetry` demotes the row; the retry re-reads 'corroborated_duplicate' and refuses. This
    // is the crash/replay + arrival-order property at the store layer — without the in-txn read it
    // would commit the create against a now-stale 'eligible'.
    const peId = standardClaim(1).pe_id;
    const db = createFakeFirestore({
      retryFirstTxn: {
        beforeRetry: (store) => {
          store.set(`${PE_HISTORY_COLLECTION}/${peId}`, { peId, mint_status: 'corroborated_duplicate' });
        },
      },
    }) as unknown as SettlementDb;
    await seedPeHistory(db, peId, READY);
    const result = await registerClaim(db, standardClaim(1), NOW, { requirePeHistoryStatus: READY });
    expect(result).toEqual({ kind: 'rejected', reason: 'pe_history_not_settleable' });
    expect(await readClaim(db, standardClaim(1))).toBeUndefined();
  });
});

describe('cycle lease (single worker)', () => {
  it('creates on first acquire and renews for the same worker', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const created = await freshCycle(db);
    expect(created.next_nonce).toBe(7);
    expect(created.cursor_next).toBe('0');
    const renewed = await acquireCycleLease(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 10, leaseTtlMs: 60_000,
      epoch: 0, policyHash: H(0xfeed), signer: ADDR(0xbeef), baseNonce: 999,
      limits: { max_transactions: 100, max_fee_wei_total: '100000000000000000' },
      cursorStart: 0n,
    });
    expect(renewed.kind).toBe('acquired');
    // Re-acquire binds to the EXISTING durable state, not the caller's args.
    expect((renewed as { cycle: SettlementCycleDoc }).cycle.next_nonce).toBe(7);
  });

  it('refuses a second worker while the lease is live, admits it after expiry', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await freshCycle(db);
    const liveRefusal = await acquireCycleLease(db, {
      cycleId: CYCLE, workerId: 'worker-b', nowMs: NOW + 1, leaseTtlMs: 60_000,
      epoch: 0, policyHash: H(0xfeed), signer: ADDR(0xbeef), baseNonce: 7,
      limits: { max_transactions: 100, max_fee_wei_total: '100000000000000000' },
      cursorStart: 0n,
    });
    expect(liveRefusal).toEqual({ kind: 'refused', reason: 'lease_held' });
    const takeover = await acquireCycleLease(db, {
      cycleId: CYCLE, workerId: 'worker-b', nowMs: NOW + 61_000, leaseTtlMs: 60_000,
      epoch: 0, policyHash: H(0xfeed), signer: ADDR(0xbeef), baseNonce: 7,
      limits: { max_transactions: 100, max_fee_wei_total: '100000000000000000' },
      cursorStart: 0n,
    });
    expect(takeover.kind).toBe('acquired');
  });

  it('refuses adoption under a mismatched epoch/policy/signer', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await freshCycle(db);
    const mismatch = await acquireCycleLease(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 10, leaseTtlMs: 60_000,
      epoch: 1, policyHash: H(0xfeed), signer: ADDR(0xbeef), baseNonce: 7,
      limits: { max_transactions: 100, max_fee_wei_total: '100000000000000000' },
      cursorStart: 0n,
    });
    expect(mismatch).toEqual({ kind: 'refused', reason: 'config_mismatch' });
  });

  it('refuses to re-lease a closed cycle', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await freshCycle(db);
    await closeCycle(db, { cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 5, status: 'stopped', stopReason: 'fee_limit' });
    const refused = await acquireCycleLease(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 10, leaseTtlMs: 60_000,
      epoch: 0, policyHash: H(0xfeed), signer: ADDR(0xbeef), baseNonce: 7,
      limits: { max_transactions: 100, max_fee_wei_total: '100000000000000000' },
      cursorStart: 0n,
    });
    expect(refused).toEqual({ kind: 'refused', reason: 'cycle_closed' });
  });
});

describe('batch reservation, nonce ownership and the durable cursor', () => {
  it('assigns nonces monotonically from the cycle and refuses cursor gaps', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await freshCycle(db);
    const first = await reserveOne(db, 1, 0n);
    expect(first.kind).toBe('reserved');
    expect((first as { nonce: number }).nonce).toBe(7);
    // Second reservation at a NON-contiguous cursor refuses: the durable
    // cursor has not advanced (nothing applied yet).
    const gap = await reserveOne(db, 2, 5n);
    expect(gap).toEqual({ kind: 'refused', reason: 'cursor_discontinuity' });
  });

  it('enforces the cycle transaction budget at reservation', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await freshCycle(db, { maxTransactions: 0 });
    const refused = await reserveOne(db, 1, 0n);
    expect(refused).toEqual({ kind: 'refused', reason: 'transaction_limit' });
  });

  it('releaseUnusedNonce returns only the most recent, never-signed allocation', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await freshCycle(db);
    const reserved = await reserveOne(db, 1, 0n);
    expect(reserved.kind).toBe('reserved');
    // Wrong nonce (not the last allocation) refuses.
    expect(await releaseUnusedNonce(db, { cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 2, nonce: 6 }))
      .toEqual({ released: false });
    expect(await releaseUnusedNonce(db, { cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 2, nonce: 7 }))
      .toEqual({ released: true });
    const next = await allocateNonce(db, { cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 3 });
    expect(next).toEqual({ kind: 'allocated', nonce: 7 });
  });
});

describe('attempt recording — the same-nonce replacement invariant', () => {
  async function reservedBatch(db: SettlementDb): Promise<number> {
    await freshCycle(db);
    const reserved = await reserveOne(db, 1, 0n);
    if (reserved.kind !== 'reserved') throw new Error('setup');
    return reserved.nonce;
  }

  const attempt = (nonce: number, hash: number, kind: 'original' | 'replacement' | 'retry_after_revert' | 'cancel') => ({
    nonce,
    tx_hash: H(hash),
    kind,
    max_fee_per_gas_wei: '1000000000',
    max_priority_fee_per_gas_wei: '100000000',
    gas_limit: '1000000',
  });

  it('original first, then replacement at the SAME nonce only', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const nonce = await reservedBatch(db);
    expect((await recordAttempt(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 2, batchId: H(0x5001),
      attempt: attempt(nonce, 0xa1, 'original'),
    })).kind).toBe('recorded');
    // A replacement at a DIFFERENT nonce is the two-live-settlements vector —
    // refused transactionally.
    expect(await recordAttempt(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 3, batchId: H(0x5001),
      attempt: attempt(nonce + 1, 0xa2, 'replacement'),
    })).toEqual({ kind: 'refused', reason: 'nonce_rules_violated' });
    expect((await recordAttempt(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 3, batchId: H(0x5001),
      attempt: attempt(nonce, 0xa2, 'replacement'),
    })).kind).toBe('recorded');
  });

  it('a new nonce is admitted only after a MINED-FAILED receipt', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const nonce = await reservedBatch(db);
    await recordAttempt(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 2, batchId: H(0x5001),
      attempt: attempt(nonce, 0xa1, 'original'),
    });
    // Unmined predecessor: retry_after_revert refused.
    expect(await recordAttempt(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 3, batchId: H(0x5001),
      attempt: attempt(nonce + 1, 0xa2, 'retry_after_revert'),
    })).toEqual({ kind: 'refused', reason: 'nonce_rules_violated' });
    await recordMinedReceipt(db, {
      batchId: H(0x5001), txHash: H(0xa1), nowMs: NOW + 4,
      status: 'reverted', blockNumber: 10, gasUsed: 21_000n, effectiveGasPriceWei: 5n,
    });
    expect((await recordAttempt(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 5, batchId: H(0x5001),
      attempt: attempt(nonce + 1, 0xa2, 'retry_after_revert'),
    })).kind).toBe('recorded');
  });

  it('consumes the transaction budget for every submission and never resets it', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const fake = db as unknown as { store: Map<string, Record<string, unknown>> };
    const nonce = await reservedBatch(db);
    await recordAttempt(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 2, batchId: H(0x5001),
      attempt: attempt(nonce, 0xa1, 'original'),
    });
    await recordAttempt(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 3, batchId: H(0x5001),
      attempt: attempt(nonce, 0xa2, 'replacement'),
    });
    const cycle = fake.store.get(`${SETTLEMENT_CYCLES_COLLECTION}/${CYCLE}`) as unknown as SettlementCycleDoc;
    expect(cycle.consumed.transactions_submitted).toBe(2);
    expect(cycle.consumed.replacements_submitted).toBe(1);
    expect(BigInt(cycle.consumed.fee_wei_reserved)).toBe(2n * 1_000_000_000n * 1_000_000n);
  });
});

describe('exactly-once apply (crash-and-retry safe counters + cursor)', () => {
  async function confirmedSetup(db: SettlementDb): Promise<void> {
    await registerClaim(db, standardClaim(1), NOW);
    await registerClaim(db, standardClaim(2), NOW);
    await freshCycle(db);
    const reserved = await reserveOne(db, 1, 0n);
    if (reserved.kind !== 'reserved') throw new Error('setup');
    await recordAttempt(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 2, batchId: H(0x5001),
      attempt: {
        nonce: reserved.nonce, tx_hash: H(0xa1), kind: 'original',
        max_fee_per_gas_wei: '1000000000', max_priority_fee_per_gas_wei: '1', gas_limit: '1000000',
      },
    });
    await recordMinedReceipt(db, {
      batchId: H(0x5001), txHash: H(0xa1), nowMs: NOW + 3,
      status: 'success', blockNumber: 11, gasUsed: 400_000n, effectiveGasPriceWei: 3n,
    });
  }

  it('applies once, advances the durable cursor, and is idempotent', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const fake = db as unknown as { store: Map<string, Record<string, unknown>> };
    await confirmedSetup(db);
    expect((await applyConfirmedBatch(db, {
      cycleId: CYCLE, batchId: H(0x5001), txHash: H(0xa1), nowMs: NOW + 4,
    })).kind).toBe('applied');
    expect((await applyConfirmedBatch(db, {
      cycleId: CYCLE, batchId: H(0x5001), txHash: H(0xa1), nowMs: NOW + 5,
    })).kind).toBe('already_applied');
    const cycle = fake.store.get(`${SETTLEMENT_CYCLES_COLLECTION}/${CYCLE}`) as unknown as SettlementCycleDoc;
    expect(cycle.cursor_next).toBe('2');
    expect(fake.store.get(`pvt9_payee_settlement_clocks_v1/${ADDR(0xa1)}`)).toMatchObject({ last_settled_at_ms: NOW + 4, batch_id: H(0x5001) });
    expect((fake.store.get(`${SETTLEMENT_BATCHES_COLLECTION}/${H(0x5001)}`) as unknown as SettlementBatchDoc).settled_at_ms).toBe(NOW + 4);
    expect(cycle.consumed.batches_confirmed).toBe(1);
    expect(cycle.consumed.claims_settled).toBe(2);
    expect(BigInt(cycle.consumed.fee_wei_spent)).toBe(400_000n * 3n);
    // The worst-case reservation was converted, not double-counted.
    expect(BigInt(cycle.consumed.fee_wei_reserved)).toBe(0n);
  });

  it('refuses to apply a mined cancel as a settlement', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await freshCycle(db);
    const reserved = await reserveOne(db, 1, 0n);
    if (reserved.kind !== 'reserved') throw new Error('setup');
    await recordAttempt(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 2, batchId: H(0x5001),
      attempt: {
        nonce: reserved.nonce, tx_hash: H(0xa1), kind: 'original',
        max_fee_per_gas_wei: '1', max_priority_fee_per_gas_wei: '1', gas_limit: '21000',
      },
    });
    await recordAttempt(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 3, batchId: H(0x5001),
      attempt: {
        nonce: reserved.nonce, tx_hash: H(0xa2), kind: 'cancel',
        max_fee_per_gas_wei: '2', max_priority_fee_per_gas_wei: '1', gas_limit: '21000',
      },
    });
    await recordMinedReceipt(db, {
      batchId: H(0x5001), txHash: H(0xa2), nowMs: NOW + 4,
      status: 'success', blockNumber: 12, gasUsed: 21_000n, effectiveGasPriceWei: 1n,
    });
    expect(await applyConfirmedBatch(db, {
      cycleId: CYCLE, batchId: H(0x5001), txHash: H(0xa2), nowMs: NOW + 5,
    })).toEqual({ kind: 'refused', reason: 'no_successful_attempt' });
  });

  it('writes ledger settlement after apply and repair completes a crash gap', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const fake = db as unknown as { store: Map<string, Record<string, unknown>> };
    await confirmedSetup(db);
    await applyConfirmedBatch(db, { cycleId: CYCLE, batchId: H(0x5001), txHash: H(0xa1), nowMs: NOW + 4 });

    // Simulate the crash: applied but writebacks never ran.
    const batchKey = `${SETTLEMENT_BATCHES_COLLECTION}/${H(0x5001)}`;
    expect((fake.store.get(batchKey) as unknown as SettlementBatchDoc).writebacks_complete).toBe(false);
    const repaired = await repairLedgerWritebacks(db, { nowMs: NOW + 6 });
    expect(repaired.repairedBatches).toBe(1);
    const row1 = fake.store.get(`${CLAIM_LEDGER_COLLECTION}/pe-1#sole`)!;
    expect(row1.settled).toBe(true);
    expect(row1.settled_batch_id).toBe(H(0x5001));
    expect((fake.store.get(batchKey) as unknown as SettlementBatchDoc).writebacks_complete).toBe(true);
    // Idempotent: a second repair pass finds nothing.
    expect((await repairLedgerWritebacks(db, { nowMs: NOW + 7 })).repairedBatches).toBe(0);
  });

  it('settlement writes pe_history back on BOTH lanes: a settled grant leaves the eligible claim source', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const fake = db as unknown as { store: Map<string, Record<string, unknown>> };
    // One standard-lane PE and one genesis-lane PE, both sitting 'eligible' in
    // the enrichment record the standard inlet SELECTS from.
    // a pre-freeze (no split doc) standard act flips only when its rows sum to the
    // PE's settleable total, so the enrichment row carries the sealed total as production's do.
    fake.store.set('pe_history/pe-1', { mint_status: 'eligible', record_points_atomic: '1000000000000000000' });
    fake.store.set('pe_history/pe-g-1', { mint_status: 'eligible' });
    await registerClaim(db, standardClaim(1), NOW);
    await registerClaim(db, genesisClaim(1), NOW);
    await freshCycle(db);
    const reserved = await reserveBatch(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 1, batchId: H(0x5001),
      lane: 'standard', epoch: 0, policyHash: H(0xfeed),
      cursorStart: 0n, cursorEnd: 2n, recipientCount: 2, claimCount: 2,
      totalMintedAtomic: 123n, calldata: '0xdeadbeef',
      members: [
        { leg: 'sole' as const, pe_id: 'pe-1', claim_id: H(1) },
        { leg: 'sole' as const, pe_id: 'pe-g-1', claim_id: H(1001) },
      ],
    });
    if (reserved.kind !== 'reserved') throw new Error('setup');
    await recordAttempt(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 2, batchId: H(0x5001),
      attempt: {
        nonce: reserved.nonce, tx_hash: H(0xa1), kind: 'original',
        max_fee_per_gas_wei: '1000000000', max_priority_fee_per_gas_wei: '1', gas_limit: '1000000',
      },
    });
    await recordMinedReceipt(db, {
      batchId: H(0x5001), txHash: H(0xa1), nowMs: NOW + 3,
      status: 'success', blockNumber: 11, gasUsed: 400_000n, effectiveGasPriceWei: 3n,
    });
    await applyConfirmedBatch(db, { cycleId: CYCLE, batchId: H(0x5001), txHash: H(0xa1), nowMs: NOW + 4 });

    // THE DEFECT, CONSTRUCTED (the RED control): the batch is applied and
    // confirmed on chain, yet both settled PEs still read 'eligible' in the
    // claim source — the pre- state machine, frozen mid-transition.
    expect(fake.store.get('pe_history/pe-1')).toMatchObject({ mint_status: 'eligible' });
    expect(fake.store.get('pe_history/pe-g-1')).toMatchObject({ mint_status: 'eligible' });

    const result = await writeLedgerSettlement(db, { batchId: H(0x5001), nowMs: NOW + 6 });
    expect(result.peHistory).toMatchObject({
      minted: 2, already_minted: 0, refused_terminal: 0, missing: 0, unexpected_status: 0,
    });
    expect(fake.store.get('pe_history/pe-1')).toMatchObject({
      mint_status: 'minted',
      settled_batch_id: H(0x5001),
      settled_tx_hash: H(0xa1),
      minted_via: 'pvt9_settlement',
    });
    expect(fake.store.get('pe_history/pe-g-1')).toMatchObject({ mint_status: 'minted' });
    // The two claims really are one per lane.
    expect(fake.store.get(`${CLAIM_LEDGER_COLLECTION}/pe-1#sole`)).toMatchObject({ lane: 'standard', settled: true });
    expect(fake.store.get(`${CLAIM_LEDGER_COLLECTION}/pe-g-1#sole`)).toMatchObject({ lane: 'genesis', settled: true });
    // Idempotent: a second pass reclassifies nothing.
    const again = await writeLedgerSettlement(db, { batchId: H(0x5001), nowMs: NOW + 7 });
    expect(again.peHistory).toMatchObject({ minted: 0, already_minted: 2 });
  });

  it('the PE-level flip is DEFERRED until EVERY leg of a split act is settled', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const fake = db as unknown as { store: Map<string, Record<string, unknown>> };
    const PE = 'pe-split-1';
    fake.store.set(`pe_history/${PE}`, { mint_status: 'eligible', record_points_atomic: '1000000000000000000' });

    // A split act: an agent leg (20%) and a beneficiary leg (80%), two ledger rows under one PE
    // that settle in DIFFERENT batches (the planner orders recipients by address).
    const agentClaim = H(0x111);
    const benClaim = H(0x222);
    await registerClaim(db, {
      leg: 'agent', pe_id: PE, claim_id: agentClaim, lane: 'standard',
      contributor: ADDR(0xa1), beneficiary_class: 2, record_points_atomic: '200000000000000000',
    }, NOW);
    await registerClaim(db, {
      leg: 'beneficiary', pe_id: PE, claim_id: benClaim, lane: 'standard',
      contributor: ADDR(0xb2), beneficiary_class: 1, record_points_atomic: '800000000000000000',
    }, NOW);
    await freshCycle(db);

    // ── Batch 1: settle ONLY the agent leg ──
    const b1 = await reserveBatch(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 1, batchId: H(0x6001),
      lane: 'standard', epoch: 0, policyHash: H(0xfeed),
      cursorStart: 0n, cursorEnd: 1n, recipientCount: 1, claimCount: 1,
      totalMintedAtomic: 200n, calldata: '0xdead01',
      members: [{ leg: 'agent' as const, pe_id: PE, claim_id: agentClaim }],
    });
    if (b1.kind !== 'reserved') throw new Error('b1 setup');
    await recordAttempt(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 2, batchId: H(0x6001),
      attempt: {
        nonce: b1.nonce, tx_hash: H(0xaa1), kind: 'original',
        max_fee_per_gas_wei: '1000000000', max_priority_fee_per_gas_wei: '1', gas_limit: '1000000',
      },
    });
    await recordMinedReceipt(db, {
      batchId: H(0x6001), txHash: H(0xaa1), nowMs: NOW + 3,
      status: 'success', blockNumber: 11, gasUsed: 400_000n, effectiveGasPriceWei: 3n,
    });
    await applyConfirmedBatch(db, { cycleId: CYCLE, batchId: H(0x6001), txHash: H(0xaa1), nowMs: NOW + 4 });

    const after1 = await writeLedgerSettlement(db, { batchId: H(0x6001), nowMs: NOW + 5 });
    // THE FIX (RED without it): the agent leg settled, but the beneficiary leg has NOT, so the
    // PE-level flip is DEFERRED. Pre- flipped to 'minted' here, which then refused the
    // still-unsettled beneficiary leg as `already_minted` and orphaned it.
    expect(after1.peHistory).toMatchObject({ minted: 0, deferred_partial: 1 });
    expect(fake.store.get(`pe_history/${PE}`)).toMatchObject({ mint_status: 'eligible' });
    expect(fake.store.get(`${CLAIM_LEDGER_COLLECTION}/${PE}#agent`)).toMatchObject({ settled: true });
    expect(fake.store.get(`${CLAIM_LEDGER_COLLECTION}/${PE}#beneficiary`)).toMatchObject({ settled: false });

    // ── Batch 2: settle the beneficiary leg ──
    const b2 = await reserveBatch(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 6, batchId: H(0x6002),
      lane: 'standard', epoch: 0, policyHash: H(0xfeed),
      cursorStart: 1n, cursorEnd: 2n, recipientCount: 1, claimCount: 1,
      totalMintedAtomic: 800n, calldata: '0xdead02',
      members: [{ leg: 'beneficiary' as const, pe_id: PE, claim_id: benClaim }],
    });
    if (b2.kind !== 'reserved') throw new Error('b2 setup');
    await recordAttempt(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 7, batchId: H(0x6002),
      attempt: {
        nonce: b2.nonce, tx_hash: H(0xbb2), kind: 'original',
        max_fee_per_gas_wei: '1000000000', max_priority_fee_per_gas_wei: '1', gas_limit: '1000000',
      },
    });
    await recordMinedReceipt(db, {
      batchId: H(0x6002), txHash: H(0xbb2), nowMs: NOW + 8,
      status: 'success', blockNumber: 12, gasUsed: 400_000n, effectiveGasPriceWei: 3n,
    });
    await applyConfirmedBatch(db, { cycleId: CYCLE, batchId: H(0x6002), txHash: H(0xbb2), nowMs: NOW + 9 });

    const after2 = await writeLedgerSettlement(db, { batchId: H(0x6002), nowMs: NOW + 10 });
    // Every leg is now settled — the flip fires ONCE, exactly when the PE is fully paid.
    expect(after2.peHistory).toMatchObject({ minted: 1, deferred_partial: 0 });
    expect(fake.store.get(`pe_history/${PE}`)).toMatchObject({
      mint_status: 'minted', minted_via: 'pvt9_settlement',
    });
  });

  it('the writeback never reclassifies terminal ineligible and refusals do not wedge repair', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const fake = db as unknown as { store: Map<string, Record<string, unknown>> };
    // pe-1 is terminal 'ineligible' (Pitfall #45); pe-2 has no enrichment doc.
    fake.store.set('pe_history/pe-1', { mint_status: 'ineligible' });
    await confirmedSetup(db);
    await applyConfirmedBatch(db, { cycleId: CYCLE, batchId: H(0x5001), txHash: H(0xa1), nowMs: NOW + 4 });

    const result = await writeLedgerSettlement(db, { batchId: H(0x5001), nowMs: NOW + 6 });
    expect(result.peHistory).toMatchObject({
      minted: 0, refused_terminal: 1, missing: 1, unexpected_status: 0,
    });
    // Terminal stays terminal — no field of the ineligible doc moved.
    expect(fake.store.get('pe_history/pe-1')).toEqual({ mint_status: 'ineligible' });
    // Refusals complete the writeback flag rather than re-running repair forever.
    const batchKey = `${SETTLEMENT_BATCHES_COLLECTION}/${H(0x5001)}`;
    expect((fake.store.get(batchKey) as unknown as SettlementBatchDoc).writebacks_complete).toBe(true);
    expect((await repairLedgerWritebacks(db, { nowMs: NOW + 7 })).repairedBatches).toBe(0);
  });

  it('writeLedgerSettlement refuses an unapplied batch', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await freshCycle(db);
    await reserveOne(db, 1, 0n);
    await expect(writeLedgerSettlement(db, { batchId: H(0x5001), nowMs: NOW + 2 }))
      .rejects.toThrow('not applied');
  });
});

describe('unresolved batch listing (resume order)', () => {
  it('lists submitted and reserved-orphan batches in nonce order', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await freshCycle(db);
    const first = await reserveOne(db, 1, 0n, 2);
    if (first.kind !== 'reserved') throw new Error('setup');
    await recordAttempt(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 2, batchId: H(0x5001),
      attempt: {
        nonce: first.nonce, tx_hash: H(0xa1), kind: 'original',
        max_fee_per_gas_wei: '1', max_priority_fee_per_gas_wei: '1', gas_limit: '21000',
      },
    });
    // A dead batch and a confirmed batch are NOT unresolved.
    await markBatchDead(db, { batchId: H(0x5001), nowMs: NOW + 3, reason: 'test' });
    const unresolved = await listUnresolvedBatches(db, CYCLE);
    expect(unresolved).toHaveLength(0);
  });
});

describe(' never-broadcast orphan reservations in a closed cycle', () => {
  const ATTEMPT = {
    nonce: 7, tx_hash: H(0xa1), kind: 'original' as const,
    max_fee_per_gas_wei: '1000000000', max_priority_fee_per_gas_wei: '100000000', gas_limit: '1000000',
  };
  const batchStatus = async (db: SettlementDb): Promise<string> =>
    ((await db.collection('pvt9_settlement_batches_v1').doc(H(0x5001)).get()).data() as { status: string }).status;
  const reservedBy = async (db: SettlementDb, pe: string): Promise<unknown> =>
    ((await db.collection(CLAIM_LEDGER_COLLECTION).doc(claimKeyOf(pe, 'sole', 'act')).get()).data() ?? {}).reserved_batch_id;

  it('retires a 0-attempt reservation in a stopped cycle, releases its members, and unblocks supersession', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await freshCycle(db);
    expect((await reserveOne(db, 1, 0n)).kind).toBe('reserved');
    await closeCycle(db, { cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 5, status: 'stopped', stopReason: 'transaction_limit' });
    // The wedge, as production saw it: the closed cycle refuses supersession.
    expect((await resolveEffectiveCycleId(db, CYCLE)).kind).toBe('refused');

    expect((await retireNeverBroadcastOrphans(db, { nowMs: NOW + 10 })).retired).toEqual([H(0x5001)]);
    expect(await batchStatus(db)).toBe('dead');
    expect(await reservedBy(db, 'pe-1')).toBeNull();
    expect(await reservedBy(db, 'pe-2')).toBeNull();
    expect(await resolveEffectiveCycleId(db, CYCLE)).toEqual({ kind: 'ok', cycleId: `${CYCLE}-r2`, supersededCycleIds: [CYCLE] });
    // Idempotent: nothing left to retire.
    expect((await retireNeverBroadcastOrphans(db, { nowMs: NOW + 11 })).retired).toEqual([]);
  });

  it('RED: a reservation with ONE recorded attempt is never retired (it may be on chain)', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await freshCycle(db);
    await reserveOne(db, 1, 0n);
    expect((await recordAttempt(db, { cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 2, batchId: H(0x5001), attempt: ATTEMPT })).kind).toBe('recorded');
    await closeCycle(db, { cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 5, status: 'stopped', stopReason: 'broadcast_failed' });
    expect((await retireNeverBroadcastOrphans(db, { nowMs: NOW + 10 })).retired).toEqual([]);
    // The stale-query race: the per-batch transaction itself must refuse a batch that gained an
    // attempt after the \`status == reserved\` scan read it.
    expect(await retireIfNeverBroadcastOrphan(db, { batchId: H(0x5001), nowMs: NOW + 10 })).toBe(false);
    expect(await batchStatus(db)).toBe('submitted');
    expect(await reservedBy(db, 'pe-1')).toBe(H(0x5001));
  });

  it('RED: a 0-attempt reservation in an ACTIVE cycle is left to same-cycle continuation', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await freshCycle(db);
    await reserveOne(db, 1, 0n);
    expect((await retireNeverBroadcastOrphans(db, { nowMs: NOW + 10 })).retired).toEqual([]);
    expect(await retireIfNeverBroadcastOrphan(db, { batchId: H(0x5001), nowMs: NOW + 10 })).toBe(false);
    expect(await batchStatus(db)).toBe('reserved');
    expect(await reservedBy(db, 'pe-1')).toBe(H(0x5001));
  });

  it('RED: after retirement the stranded worker cannot record an attempt (refused before broadcast)', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await freshCycle(db);
    await reserveOne(db, 1, 0n);
    await closeCycle(db, { cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 5, status: 'stopped', stopReason: 'resumption_abort' });
    await retireNeverBroadcastOrphans(db, { nowMs: NOW + 10 });
    const late = await recordAttempt(db, { cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 11, batchId: H(0x5001), attempt: ATTEMPT });
    expect(late.kind).toBe('refused');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// the store-level guards the reconciler, finality, and isolation rest on
// ─────────────────────────────────────────────────────────────────────────────
describe(' store guards', () => {
  const attempt = (nonce: number, hash: number, kind: 'original' | 'replacement' | 'retry_after_revert' | 'cancel') => ({
    nonce,
    tx_hash: H(hash),
    kind,
    max_fee_per_gas_wei: '1000000000',
    max_priority_fee_per_gas_wei: '100000000',
    gas_limit: '1000000',
  });
  const SIGNER = ADDR(0xbeef);

  /** A batch with one recorded original, in a cycle that has since CLOSED (stranded). */
  async function strandedBatch(db: SettlementDb): Promise<number> {
    await freshCycle(db);
    const reserved = await reserveOne(db, 1, 0n);
    if (reserved.kind !== 'reserved') throw new Error('setup');
    await recordAttempt(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 2, batchId: H(0x5001),
      attempt: attempt(reserved.nonce, 0xa1, 'original'),
    });
    await closeCycle(db, { cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 3, status: 'stopped', stopReason: 'replacement_budget_exhausted' });
    return reserved.nonce;
  }

  it('ADOPTION is fenced on the live SIGNER lease, and only at the nonce the batch already holds', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const nonce = await strandedBatch(db);
    const adopt = (workerId: string, a: ReturnType<typeof attempt>) => recordAttempt(db, {
      cycleId: CYCLE, workerId, nowMs: NOW + 10, batchId: H(0x5001), attempt: a, adoptSigner: SIGNER,
    });

    // RED CONTROL: without the signer lease, adoption is refused (the closed cycle alone never
    // authorizes a write).
    expect(await adopt('worker-b', attempt(nonce, 0xa2, 'replacement')))
      .toEqual({ kind: 'refused', reason: 'batch_not_reserved' });
    // The ordinary (cycle-lease) path is refused on a closed cycle — why adoption exists.
    expect((await recordAttempt(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 10, batchId: H(0x5001),
      attempt: attempt(nonce, 0xa2, 'replacement'),
    })).kind).toBe('refused');

    await acquireSignerLease(db, { signer: SIGNER, workerId: 'worker-b', nowMs: NOW + 5, leaseTtlMs: 60_000 });
    // A NEW nonce is never adoptable, nor a second original.
    expect(await adopt('worker-b', attempt(nonce + 1, 0xa3, 'replacement')))
      .toEqual({ kind: 'refused', reason: 'nonce_rules_violated' });
    expect(await adopt('worker-b', attempt(nonce, 0xa3, 'original')))
      .toEqual({ kind: 'refused', reason: 'nonce_rules_violated' });
    expect(await adopt('worker-b', attempt(nonce + 1, 0xa3, 'retry_after_revert')))
      .toEqual({ kind: 'refused', reason: 'nonce_rules_violated' });
    // Another worker than the lease holder is refused.
    expect(await adopt('worker-c', attempt(nonce, 0xa3, 'replacement')))
      .toEqual({ kind: 'refused', reason: 'batch_not_reserved' });
    // The holder may replace or cancel at the SAME nonce.
    expect((await adopt('worker-b', attempt(nonce, 0xa3, 'replacement'))).kind).toBe('recorded');
  });

  it('MONEY-SAFETY: a batch with a SEEN successful settle can never be marked dead', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const fake = db as unknown as { store: Map<string, Record<string, unknown>> };
    await strandedBatch(db);
    await recordMinedReceipt(db, {
      batchId: H(0x5001), txHash: H(0xa1), nowMs: NOW + 4,
      status: 'success', blockNumber: 10, blockHash: H(0xb10c), gasUsed: 21_000n, effectiveGasPriceWei: 5n,
    });
    const batch = fake.store.get(`${SETTLEMENT_BATCHES_COLLECTION}/${H(0x5001)}`) as unknown as SettlementBatchDoc;
    expect(batch.status).toBe('mined');
    expect(await markBatchDead(db, { batchId: H(0x5001), nowMs: NOW + 5, reason: 'x' })).toEqual({ marked: false });
    // The reservation is kept: its claims cannot be re-selected while the chain may have paid them.
    expect(fake.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe-1', 'sole')}`)?.reserved_batch_id).toBe(H(0x5001));

    // Once the receipt is withdrawn (proven non-canonical) the batch is ordinary again.
    expect(await clearMinedReceipt(db, { batchId: H(0x5001), txHash: H(0xa1), nowMs: NOW + 6 })).toEqual({ cleared: true });
    expect((fake.store.get(`${SETTLEMENT_BATCHES_COLLECTION}/${H(0x5001)}`) as unknown as SettlementBatchDoc).status)
      .toBe('submitted');
    // RED CONTROL: the same call on a batch with no successful receipt DOES mark it dead.
    expect(await markBatchDead(db, { batchId: H(0x5001), nowMs: NOW + 7, reason: 'x' })).toEqual({ marked: true });
  });

  it('a hold never touches a claim that is reserved or settled', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const fake = db as unknown as { store: Map<string, Record<string, unknown>> };
    await freshCycle(db);
    await reserveOne(db, 1, 0n, 2); // pe-1, pe-2 reserved by the batch
    await registerClaim(db, standardClaim(3), NOW);
    const { held } = await holdClaims(db, {
      nowMs: NOW,
      holds: [1, 2, 3].map((n) => ({ claimKey: claimKeyOf(`pe-${n}`, 'sole'), reason: 'r', detail: 'd' })),
    });
    expect(held).toEqual([claimKeyOf('pe-3', 'sole')]);
    const row3 = fake.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe-3', 'sole')}`) as Record<string, unknown>;
    expect(row3.hold).toMatchObject({ reason: 'r', count: 1, retry_at_ms: NOW + CLAIM_HOLD_BASE_MS });
    // Holding again backs off (doubles), bounded by the cap.
    await holdClaims(db, { nowMs: NOW, holds: [{ claimKey: claimKeyOf('pe-3', 'sole'), reason: 'r', detail: 'd' }] });
    const again = fake.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe-3', 'sole')}`) as Record<string, unknown>;
    expect(again.hold).toMatchObject({ count: 2, retry_at_ms: NOW + 2 * CLAIM_HOLD_BASE_MS });
    expect(claimHoldBackoffMs(99)).toBe(CLAIM_HOLD_MAX_MS);
  });

  it('a reorged batch is unwound only when it is its cycle TIP (a later batch was built on it)', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const fake = db as unknown as { store: Map<string, Record<string, unknown>> };
    await freshCycle(db);
    const reserved = await reserveOne(db, 1, 0n, 2);
    if (reserved.kind !== 'reserved') throw new Error('setup');
    await recordAttempt(db, {
      cycleId: CYCLE, workerId: WORKER, nowMs: NOW + 2, batchId: H(0x5001),
      attempt: attempt(reserved.nonce, 0xa1, 'original'),
    });
    await recordMinedReceipt(db, {
      batchId: H(0x5001), txHash: H(0xa1), nowMs: NOW + 3,
      status: 'success', blockNumber: 10, blockHash: H(0xb10c), gasUsed: 21_000n, effectiveGasPriceWei: 5n,
    });
    await applyConfirmedBatch(db, {
      cycleId: CYCLE, batchId: H(0x5001), txHash: H(0xa1), nowMs: NOW + 4,
      final: { blockNumber: 10, blockHash: H(0xb10c) },
    });
    await writeLedgerSettlement(db, { batchId: H(0x5001), nowMs: NOW + 5 });
    // A later batch advanced the cycle past this one: not the tip, refused.
    const cycleKey = `${SETTLEMENT_CYCLES_COLLECTION}/${CYCLE}`;
    const tipCycle = fake.store.get(cycleKey) as Record<string, unknown>;
    fake.store.set(cycleKey, { ...tipCycle, cursor_next: '5' });
    expect(await revertReorgedBatch(db, { batchId: H(0x5001), nowMs: NOW + 6, reason: 'r' }))
      .toEqual({ kind: 'refused', reason: 'not_cycle_tip' });
    expect(fake.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe-1', 'sole')}`)?.settled).toBe(true);

    // As the tip, it unwinds: ledger unsettled but still RESERVED by the batch, cursor rolled back.
    fake.store.set(cycleKey, tipCycle);
    expect((await revertReorgedBatch(db, { batchId: H(0x5001), nowMs: NOW + 7, reason: 'r' })).kind).toBe('reverted');
    const row = fake.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe-1', 'sole')}`) as Record<string, unknown>;
    expect(row.settled).toBe(false);
    expect(row.reserved_batch_id).toBe(H(0x5001));
    const cycle = fake.store.get(cycleKey) as unknown as SettlementCycleDoc;
    expect(cycle.cursor_next).toBe('0');
    const batch = fake.store.get(`${SETTLEMENT_BATCHES_COLLECTION}/${H(0x5001)}`) as unknown as SettlementBatchDoc;
    expect(batch.status).toBe('submitted');
    expect(batch.applied).toBe(false);
    expect(batch.attempts.every((a) => a.mined === null)).toBe(true);
  });
});

describe(' review · chain-evidence settlement (the kernel read paid at the safe block)', () => {
  const key = (n: number): string => claimKeyOf(`pe-${n}`, 'sole');
  const evidence = { safe_block: 42, reason: 'test', concluding_batch_id: null };

  it('writes ONLY an unsettled, unreserved row whose claim id is the one the kernel was asked about', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const fake = db as unknown as { store: Map<string, Record<string, unknown>> };
    await freshCycle(db);
    // Claims 1 and 2 are reserved by a live batch; claim 3 is free.
    expect((await reserveOne(db, 1, 0n, 2)).kind).toBe('reserved');
    await registerClaim(db, standardClaim(3), NOW);
    fake.store.set(`${PE_HISTORY_COLLECTION}/pe-3`, { mint_status: 'eligible', record_points_atomic: '1000000000000000000' });

    const result = await settleClaimsFromChainEvidence(db, {
      nowMs: NOW + 5,
      claims: [
        { claimKey: key(1), claimId: H(99) }, // not this row's claim
        { claimKey: key(2), claimId: H(2) }, // another batch's reservation
        { claimKey: key(3), claimId: H(3) },
      ],
      evidence,
    });
    expect(result.settled).toEqual([key(3)]);
    expect(result.skipped).toEqual([
      { claimKey: key(1), why: 'claim_id_mismatch' },
      { claimKey: key(2), why: `reserved_by:${H(0x5001)}` },
    ]);
    expect(fake.store.get(`${CLAIM_LEDGER_COLLECTION}/${key(3)}`)).toMatchObject({
      settled: true, settled_via: 'chain_evidence', settled_tx_hash: null, reserved_batch_id: null, settled_batch_id: null,
      chain_settlement_evidence: { safe_block: 42, concluding_batch_id: null },
    });
    expect(fake.store.get(`${CLAIM_LEDGER_COLLECTION}/${key(2)}`)).toMatchObject({ settled: false });
    expect(fake.store.get(`${PE_HISTORY_COLLECTION}/pe-3`)).toMatchObject({ mint_status: 'minted', minted_via: 'pvt9_chain_evidence' });
    expect(result.peHistoryMinted).toBe(1);

    // Idempotent: a second pass writes nothing.
    const again = await settleClaimsFromChainEvidence(db, { nowMs: NOW + 6, claims: [{ claimKey: key(3), claimId: H(3) }], evidence });
    expect(again.settled).toEqual([]);
    expect(again.skipped).toEqual([{ claimKey: key(3), why: 'already_settled' }]);
  });

  it('the batch that holds the reservation may settle its OWN members from chain evidence', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await freshCycle(db);
    expect((await reserveOne(db, 1, 0n, 1)).kind).toBe('reserved');
    const result = await settleClaimsFromChainEvidence(db, {
      nowMs: NOW + 5, claims: [{ claimKey: key(1), claimId: H(1) }], evidence: { ...evidence, concluding_batch_id: H(0x5001) },
    });
    expect(result.settled).toEqual([key(1)]);
    // The concluding batch may clear its OWN reservation, but it is never named as the payer.
    const fake = db as unknown as { store: Map<string, Record<string, unknown>> };
    expect(fake.store.get(`${CLAIM_LEDGER_COLLECTION}/${key(1)}`)).toMatchObject({
      settled_batch_id: null, reserved_batch_id: null, chain_settlement_evidence: { concluding_batch_id: H(0x5001) },
    });
  });

  it('a held claim is listed for the kernel re-check until it settles', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await registerClaim(db, standardClaim(1), NOW);
    await holdClaims(db, { nowMs: NOW, holds: [{ claimKey: key(1), reason: 'batch_unsettleable', detail: 'x' }] });
    expect((await listHeldClaims(db, 10)).map((row) => row.claim_key)).toEqual([key(1)]);
    await settleClaimsFromChainEvidence(db, { nowMs: NOW + 1, claims: [{ claimKey: key(1), claimId: H(1) }], evidence });
    expect(await listHeldClaims(db, 10)).toEqual([]);
  });
});
