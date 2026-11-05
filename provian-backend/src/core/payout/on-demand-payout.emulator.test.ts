/**
 * — the on-demand payout flow against the Firestore EMULATOR, with a fake chain and a
 * fake one-payee settlement (the real ones are proven live). Skipped unless FIRESTORE_EMULATOR_HOST
 * is set (see meter-single-lane.emulator.test.ts for the emulator command).
 *
 * Proves: nothing is charged when there is nothing to pay or when gas is above the fee; a paid
 * request charges once and answers with the charge, never after a settlement, which the
 * sweep then runs for ONLY its payee; a retried paid request lands on the same request and never
 * charges or settles twice; a wrong signer is refused before the chain; a
 * settlement that cannot run now leaves the request `charged` and the sweep finishes it.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { Wallet } from 'ethers';
import {
  advancePayout,
  PAYOUT_REQUESTS_COLLECTION,
  PAYOUT_SETTLE_LEASE_MS,
  requestPayout,
  sweepPayouts,
  type PayoutDeps,
  type PayoutSettleOutcome,
} from './on-demand-payout';
import type { PayoutChain } from './payout-chain';
import type { PayoutPayment } from './payout-terms';
import { signedPaymentHeader } from './payout-test-fixtures';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const suite = EMULATOR ? describe : describe.skip;
const RUN = `p${Date.now().toString(36)}`;

let db: FirebaseFirestore.Firestore;

function fakeChain(opts: { gasPriceWei: bigint }) {
  const submitted: PayoutPayment[] = [];
  const used = new Set<string>();
  const landed = new Map<string, string>();
  const chain: PayoutChain = {
    gasAddress: '0x' + '35'.repeat(20),
    authorizationUsed: async (from, nonce) => used.has(`${from}|${nonce}`),
    usdcBalance: async () => 5_000_000n,
    gasBalanceWei: async () => 10n ** 17n,
    gasPriceWei: async () => opts.gasPriceWei,
    l1FeeUpperBoundWei: async () => 1_000_000_000n,
    submitCharge: async (payment) => {
      submitted.push(payment);
      used.add(`${payment.authorization.from}|${payment.authorization.nonce}`);
      const hash = `0x${String(submitted.length).padStart(64, '0')}`;
      landed.set(`${payment.authorization.from}|${payment.authorization.nonce}`, hash);
      return hash;
    },
    confirmCharge: async () => 'confirmed',
    headBlock: async () => 1000,
    findCharge: async (p) => ({ txHash: landed.get(`${p.authorization.from}|${p.authorization.nonce}`) ?? null, windowClosed: false }),
  };
  return { chain, submitted };
}

function makeDeps(chain: PayoutChain, settleImpl: (payee: string) => PayoutSettleOutcome) {
  const settled: string[] = [];
  let clock = Date.now();
  const deps: PayoutDeps = {
    db,
    chain,
    ethUsd: async () => 4000,
    settle: async (payee) => { settled.push(payee); return settleImpl(payee); },
    withGasKeyLease: async (fn) => fn(),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    log: () => {},
  };
  return { deps, settled };
}

async function seedClaim(contributor: string, key: string, readyAtMs: number, points: string): Promise<void> {
  await db.collection('meter_pending_claims_v1').doc(key).set({
    claim_key: key, contributor, state: 'pending', unit: 'act', ready_at_ms: readyAtMs,
    record_points_atomic: points, beneficiary_class: 1, batch_hash: `b_${key}`, device_id: `dev_${RUN}`,
  });
}

suite('on-demand payout (emulator)', () => {
  const payer = Wallet.createRandom();
  const payee = Wallet.createRandom().address.toLowerCase();
  const other = Wallet.createRandom().address.toLowerCase();
  const idle = Wallet.createRandom().address.toLowerCase();
  const racer = Wallet.createRandom().address.toLowerCase();
  const racer2 = Wallet.createRandom().address.toLowerCase();
  const doubler = Wallet.createRandom().address.toLowerCase();
  const lapser = Wallet.createRandom().address.toLowerCase();
  const overlap = Wallet.createRandom().address.toLowerCase();

  beforeAll(async () => {
    const admin = await import('firebase-admin');
    if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-meter' });
    db = admin.firestore();
    const now = Date.now();
    await seedClaim(payee, `mc_${RUN}_a`, now - 1_000, '800000000000000000');
    await seedClaim(payee, `mc_${RUN}_b`, now + 3 * 86_400_000, '500000000000000000'); // not ready
    await seedClaim(other, `mc_${RUN}_c`, now - 1_000, '900000000000000000');
    await seedClaim(racer, `mc_${RUN}_r`, now - 1_000, '700000000000000000');
    await seedClaim(racer2, `mc_${RUN}_r2`, now - 1_000, '700000000000000000');
    await seedClaim(doubler, `mc_${RUN}_d`, now - 1_000, '600000000000000000');
    await seedClaim(lapser, `mc_${RUN}_l`, now - 1_000, '600000000000000000');
    await seedClaim(overlap, `mc_${RUN}_o`, now - 1_000, '600000000000000000');
  });

  it('nothing to pay: answers without a charge', async () => {
    const { chain, submitted } = fakeChain({ gasPriceWei: 6_000_000n });
    const { deps } = makeDeps(chain, () => ({ kind: 'nothing', cycleId: null }));
    const header = await signedPaymentHeader(payer, Math.floor(Date.now() / 1000));
    expect((await requestPayout(deps, { payee: idle, payeeKind: 'agent', requestedBy: 'w_idle', paymentHeader: header })).kind).toBe('nothing_to_pay');
    expect(submitted).toHaveLength(0);
  });

  it('quote: no header → 402 terms with the ready work (only the ready claim)', async () => {
    const { chain } = fakeChain({ gasPriceWei: 6_000_000n });
    const { deps } = makeDeps(chain, () => ({ kind: 'nothing', cycleId: null }));
    const out = await requestPayout(deps, { payee, payeeKind: 'agent', requestedBy: 'w_payee', paymentHeader: undefined });
    expect(out.kind).toBe('payment_required');
    if (out.kind !== 'payment_required') return;
    expect(out.work?.pointsAtomic).toBe(800000000000000000n);
    expect(out.gas?.covered).toBe(true);
  });

  it('RED: gas above the fee → waits, nothing charged, no request written', async () => {
    const { chain, submitted } = fakeChain({ gasPriceWei: 50_000_000_000n }); // 50 gwei
    const { deps } = makeDeps(chain, () => ({ kind: 'nothing', cycleId: null }));
    const header = await signedPaymentHeader(payer, Math.floor(Date.now() / 1000));
    const out = await requestPayout(deps, { payee, payeeKind: 'agent', requestedBy: 'w_payee', paymentHeader: header });
    expect(out.kind).toBe('waits_for_gas');
    expect(submitted).toHaveLength(0);
    const written = await db.collection(PAYOUT_REQUESTS_COLLECTION).where('payee', '==', payee).get();
    expect(written.size).toBe(0);
  });

  it('RED: a wrong signer is refused before the chain', async () => {
    const { chain, submitted } = fakeChain({ gasPriceWei: 6_000_000n });
    const { deps, settled } = makeDeps(chain, () => ({ kind: 'nothing', cycleId: null }));
    const header = await signedPaymentHeader(payer, Math.floor(Date.now() / 1000), { signWith: Wallet.createRandom() });
    const out = await requestPayout(deps, { payee, payeeKind: 'agent', requestedBy: 'w_payee', paymentHeader: header });
    expect(out).toEqual({ kind: 'payment_required', error: 'payment_signature_invalid' });
    expect(submitted).toHaveLength(0);
    expect(settled).toHaveLength(0);
  });

  it('RED: paid — charges once and answers with the charge, never after a settlement; the sweep settles only the payee; a retry lands on the same request', async () => {
    const { chain, submitted } = fakeChain({ gasPriceWei: 6_000_000n });
    const { deps, settled } = makeDeps(chain, () => ({
      kind: 'settled', cycleId: 'epoch1-x-payout', claimsSettled: 1, batchesConfirmed: 1, feeWeiSpent: '7000000000000',
    }));
    const header = await signedPaymentHeader(payer, Math.floor(Date.now() / 1000));
    const out = await requestPayout(deps, { payee, payeeKind: 'agent', requestedBy: 'w_payee', paymentHeader: header });
    expect(out.kind).toBe('request');
    if (out.kind !== 'request') return;
    // The answer reports the charge; the settlement (minutes on Base) is not run inside it.
    expect(out.request).toMatchObject({ state: 'charged', charge_tx_hash: `0x${'1'.padStart(64, '0')}`, settlement: null });
    expect(submitted).toHaveLength(1);
    expect(settled).toEqual([]);

    // A retried paid request reports the same request: no second charge, still no inline settlement.
    const again = await requestPayout(deps, { payee, payeeKind: 'agent', requestedBy: 'w_payee', paymentHeader: header });
    expect(again).toMatchObject({ kind: 'request', request: { request_id: out.request.request_id, state: 'charged' } });
    expect(submitted).toHaveLength(1);
    expect(settled).toEqual([]);

    // The sweep finishes it, for this payee alone.
    const after = await advancePayout(deps, out.request.request_id);
    expect(after.state).toBe('settled');
    expect(after.settlement?.claims_settled).toBe(1);
    expect(settled).toEqual([payee]);
    const retried = await requestPayout(deps, { payee, payeeKind: 'agent', requestedBy: 'w_payee', paymentHeader: header });
    expect(retried).toMatchObject({ kind: 'request', request: { state: 'settled' } });
    expect(submitted).toHaveLength(1);
    expect(settled).toEqual([payee]);

    // Someone else replaying this payment for their own payout is refused.
    const stolen = await requestPayout(deps, { payee: other, payeeKind: 'agent', requestedBy: 'w_other', paymentHeader: header });
    expect(stolen.kind).toBe('not_your_request');
    expect(submitted).toHaveLength(1);
  });

  it('a settlement that cannot run now leaves the request charged; the sweep finishes it', async () => {
    const { chain, submitted } = fakeChain({ gasPriceWei: 6_000_000n });
    let busy = true;
    const { deps, settled } = makeDeps(chain, () => (busy
      ? { kind: 'wait', reason: 'settlement_run_in_progress' }
      : { kind: 'settled', cycleId: 'epoch1-y-payout', claimsSettled: 1, batchesConfirmed: 1, feeWeiSpent: '1' }));
    const header = await signedPaymentHeader(payer, Math.floor(Date.now() / 1000));
    const out = await requestPayout(deps, { payee: other, payeeKind: 'human', requestedBy: 'u_other', paymentHeader: header });
    expect(out.kind).toBe('request');
    if (out.kind !== 'request') return;
    expect(out.request.state).toBe('charged');
    expect(submitted).toHaveLength(1);
    // The first advance cannot settle now: the request stays charged with the reason.
    expect(await advancePayout(deps, out.request.request_id)).toMatchObject({ state: 'charged', waiting_reason: 'settlement_run_in_progress' });

    busy = false;
    const sweep = await sweepPayouts(deps);
    expect(sweep.settled).toBeGreaterThanOrEqual(1);
    const after = await advancePayout(deps, out.request.request_id);
    expect(after.state).toBe('settled');
    expect(submitted).toHaveLength(1);
    expect(settled.filter((p) => p === other)).toHaveLength(2);
  });

  for (const submitEnds of ['throws', 'returns its hash'] as const) {
  it(`RED: a poll that settles the request while the submit is still running is never pulled back — one fee, one settlement (the submit ${submitEnds})`, async () => {
    const racerNow = submitEnds === 'throws' ? racer : racer2;
    const { chain } = fakeChain({ gasPriceWei: 6_000_000n });
    const seen: { block: number | null }[] = [];
    let mined: string | null = null;
    const { deps, settled } = makeDeps(chain, () => ({
      kind: 'settled', cycleId: 'epoch1-r-payout', claimsSettled: 1, batchesConfirmed: 1, feeWeiSpent: '1',
    }));
    (chain as { headBlock: PayoutChain['headBlock'] }).headBlock = async () => 4242;
    (chain as { findCharge: PayoutChain['findCharge'] }).findCharge = async (_p, since) => { seen.push({ block: since.block }); return { txHash: mined, windowClosed: false }; };
    (chain as { submitCharge: PayoutChain['submitCharge'] }).submitCharge = async () => {
      // The transaction mines; the client's poll (or the sweep) settles the request meanwhile…
      mined = '0x' + 'b2'.repeat(32);
      const snap = await db.collection(PAYOUT_REQUESTS_COLLECTION).where('payee', '==', racerNow).get();
      expect(snap.size).toBe(1);
      expect((await advancePayout(deps, snap.docs[0].id)).state).toBe('settled');
      // …then the submit call fails on its own follow-up read, or returns late.
      if (submitEnds === 'throws') throw new Error('getBlockNumber timeout');
      return mined;
    };
    const header = await signedPaymentHeader(payer, Math.floor(Date.now() / 1000));
    const out = await requestPayout(deps, { payee: racerNow, payeeKind: 'agent', requestedBy: 'w_racer', paymentHeader: header });
    if (out.kind !== 'request') throw new Error(`expected request, got ${out.kind}`);
    expect(out.request.state).toBe('settled');
    expect((await advancePayout(deps, out.request.request_id)).state).toBe('settled');
    expect(settled.filter((p) => p === racerNow)).toHaveLength(1);
    // The search started from the Base block recorded on the request.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((x) => x.block === 4242)).toBe(true);
  });
  }

  it('RED: two advances of a charged request (sweep + "check again") run ONE settlement, and its record stands', async () => {
    const { chain } = fakeChain({ gasPriceWei: 6_000_000n });
    let busy = true;
    let liveCalls = 0;
    let requestId = '';
    const { deps, settled } = makeDeps(chain, () => {
      if (busy) return { kind: 'wait', reason: 'settlement_run_in_progress' };
      return { kind: 'settled', cycleId: 'epoch1-d-payout', claimsSettled: 1, batchesConfirmed: 1, feeWeiSpent: '9' };
    });
    const realSettle = deps.settle;
    (deps as { settle: PayoutDeps['settle'] }).settle = async (payee, id) => {
      if (!busy) {
        liveCalls += 1;
        // While the first settlement runs, a second advance arrives (the sweep, or "check again").
        if (liveCalls === 1) await advancePayout(deps, requestId);
      }
      return realSettle(payee, id);
    };
    const header = await signedPaymentHeader(payer, Math.floor(Date.now() / 1000));
    const out = await requestPayout(deps, { payee: doubler, payeeKind: 'agent', requestedBy: 'w_doubler', paymentHeader: header });
    if (out.kind !== 'request') throw new Error(`expected request, got ${out.kind}`);
    expect(out.request.state).toBe('charged');
    requestId = out.request.request_id;
    const before = settled.filter((p) => p === doubler).length;

    busy = false;
    const after = await advancePayout(deps, requestId);
    expect(after).toMatchObject({ state: 'settled', settlement: { cycle_id: 'epoch1-d-payout', claims_settled: 1 } });
    expect(settled.filter((p) => p === doubler).length - before).toBe(1);
    // A later advance changes nothing.
    expect((await advancePayout(deps, requestId)).settlement?.claims_settled).toBe(1);
    expect(settled.filter((p) => p === doubler).length - before).toBe(1);
  });

  it('RED: an advance whose lease lapsed never overwrites the settlement a later advance recorded', async () => {
    const { chain } = fakeChain({ gasPriceWei: 6_000_000n });
    let phase: 'busy' | 'first' | 'second' = 'busy';
    let requestId = '';
    const { deps } = makeDeps(chain, () => ({ kind: 'wait', reason: 'settlement_run_in_progress' }));
    (deps as { settle: PayoutDeps['settle'] }).settle = async () => {
      if (phase === 'busy') return { kind: 'wait', reason: 'settlement_run_in_progress' };
      if (phase === 'first') {
        // This run outlives its lease; another advance takes the request over and settles it.
        phase = 'second';
        await deps.sleep(PAYOUT_SETTLE_LEASE_MS + 1);
        expect((await advancePayout(deps, requestId)).state).toBe('settled');
        // …and then this stale run finishes with "wait".
        return { kind: 'wait', reason: 'signer_busy' };
      }
      return { kind: 'settled', cycleId: 'epoch1-l-payout', claimsSettled: 1, batchesConfirmed: 1, feeWeiSpent: '5' };
    };
    const header = await signedPaymentHeader(payer, Math.floor(Date.now() / 1000));
    const out = await requestPayout(deps, { payee: lapser, payeeKind: 'agent', requestedBy: 'w_lapser', paymentHeader: header });
    if (out.kind !== 'request') throw new Error(`expected request, got ${out.kind}`);
    requestId = out.request.request_id;
    phase = 'first';
    const after = await advancePayout(deps, requestId);
    expect(after).toMatchObject({ state: 'settled', settlement: { cycle_id: 'epoch1-l-payout', claims_settled: 1 } });
  });

  it('RED: a stale advance that finishes while a newer advance still holds the lease changes nothing', async () => {
    const { chain } = fakeChain({ gasPriceWei: 6_000_000n });
    let phase: 'busy' | 'first' | 'second' = 'busy';
    let requestId = '';
    let releaseB: () => void = () => {};
    let bStarted: () => void = () => {};
    const bIsRunning = new Promise<void>((r) => { bStarted = r; });
    let bAdvance: Promise<unknown> | null = null;
    const { deps, settled } = makeDeps(chain, () => ({ kind: 'wait', reason: 'settlement_run_in_progress' }));
    (deps as { settle: PayoutDeps['settle'] }).settle = async (payee) => {
      if (phase === 'busy') return { kind: 'wait', reason: 'settlement_run_in_progress' };
      settled.push(payee);
      if (phase === 'first') {
        phase = 'second';
        await deps.sleep(PAYOUT_SETTLE_LEASE_MS + 1);
        bAdvance = advancePayout(deps, requestId); // B retakes the lapsed lease and starts settling…
        await bIsRunning;
        return { kind: 'wait', reason: 'signer_busy' }; // …and stale A finishes first.
      }
      bStarted();
      await new Promise<void>((r) => { releaseB = r; });
      return { kind: 'settled', cycleId: 'epoch1-o-payout', claimsSettled: 1, batchesConfirmed: 1, feeWeiSpent: '3' };
    };
    const header = await signedPaymentHeader(payer, Math.floor(Date.now() / 1000));
    const out = await requestPayout(deps, { payee: overlap, payeeKind: 'agent', requestedBy: 'w_overlap', paymentHeader: header });
    if (out.kind !== 'request') throw new Error(`expected request, got ${out.kind}`);
    requestId = out.request.request_id;
    phase = 'first';
    const runs = settled.filter((p) => p === overlap).length;
    // A's outcome is refused: B still holds the request.
    expect((await advancePayout(deps, requestId)).state).toBe('settling');
    // Nothing else can start a settlement while B runs.
    expect((await advancePayout(deps, requestId)).state).toBe('settling');
    releaseB();
    await bAdvance;
    const after = (await db.collection(PAYOUT_REQUESTS_COLLECTION).doc(requestId).get()).data();
    expect(after).toMatchObject({ state: 'settled', settlement: { cycle_id: 'epoch1-o-payout', claims_settled: 1 } });
    expect(settled.filter((p) => p === overlap).length - runs).toBe(2); // A and B — never a third
  });
});
