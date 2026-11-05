/**
 * the recorder's wait, and acceptance at one-block inclusion.
 * The relay holds a record request open until the burn is MINED, asks the verifier at
 * `acceptance: 'inclusion'`, and records the burn `finality: 'provisional'` handing it to the
 * 12-block finality check (`burn-finality.ts`). Waiting changes WHEN the verifier is asked, never
 * what it accepts. controls:
 * A. MEMPOOL RED: a burn that is never mined inside the wait (pending, dropped, or replaced by a
 * same-nonce tx) records NOTHING: no row, the in-flight marker released. Mutating the
 * `if (!v.ok)` release (or the loop's exit on a refusal) turns this RED.
 * B. waitMs 0: exactly ONE verifier call.
 * C. A crashed request's stale in-flight marker is taken over; a live one is waited on, never
 * trampled.
 * D. A REVOKED burn (it failed finality) can never be recorded again.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { TxVerificationResult } from '../onchain/tx-verifier';

const mockVerify = jest.fn<typeof import('../onchain/tx-verifier').verifyEvmPvtBurn>();
jest.mock('../onchain/tx-verifier', () => ({
  verifyEvmPvtBurn: (...args: unknown[]) => mockVerify(...(args as Parameters<typeof import('../onchain/tx-verifier').verifyEvmPvtBurn>)),
}));
import {
  recordFirstPartyBurn,
  burnIdFor,
  BURN_RECORD_MAX_WAIT_MS,
  BURN_VERIFY_RETRY_MS,
  BURN_RECORD_PENDING_GRACE_MS,
} from './burn-record';
import type { FinalityProbe } from './burn-finality-wait';

type Row = Record<string, unknown>;
class FakeDocRef {
  constructor(private store: Map<string, Row>, readonly id: string) {}
  async get() { const r = this.store.get(this.id); return { exists: r !== undefined, data: () => (r ? { ...r } : undefined) }; }
  async create(data: Row) { if (this.store.has(this.id)) { const e = new Error('x') as Error & { code: number }; e.code = 6; throw e; } this.store.set(this.id, { ...data }); }
  async set(data: Row, opts?: { merge?: boolean }) { this.store.set(this.id, opts?.merge ? { ...(this.store.get(this.id) ?? {}), ...data } : { ...data }); }
  async delete() { this.store.delete(this.id); }
}
function makeDb() {
  const store = new Map<string, Row>();
  const db = {
    collection: () => ({ doc: (id: string) => new FakeDocRef(store, id) }),
    runTransaction: async (fn: (txn: {
      get: (r: FakeDocRef) => ReturnType<FakeDocRef['get']>;
      set: (r: FakeDocRef, d: Row) => void;
      create: (r: FakeDocRef, d: Row) => void;
      delete: (r: FakeDocRef) => void;
    }) => Promise<unknown>) =>
      fn({
        get: (r) => r.get(),
        set: (r, d) => { void r.set(d); },
        create: (r, d) => { if (store.has(r.id)) { const e = new Error('x') as Error & { code: number }; e.code = 6; throw e; } store.set(r.id, { ...d }); },
        delete: (r) => { void r.delete(); },
      }),
  } as unknown as import('firebase-admin/firestore').Firestore;
  return { store, db };
}
function fakeClock(start = 5_000_000) {
  let t = start;
  const naps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { naps.push(ms); t += ms; }, naps, elapsed: () => t - start, start };
}

const ADDR = '0x1111111111111111111111111111111111111111';
const TX = `0x${'b'.repeat(64)}`;
const AMT = (5n * 10n ** 18n).toString();
const BURN_ID = burnIdFor('base', TX);
const params = (waitMs: number) => ({ walletId: 'aw1', address: ADDR, ownerKind: 'agent' as const, ownerId: 'agent-1', txHash: TX, chain: 'base', amountAtomic: AMT, waitMs });

/**
 * A chain: the tx is MINED in block 100 `minedAfterMs` after the request starts (never, when
 * `neverMined` — a pending / dropped / replaced tx); head advances a block per 2 s. The verifier
 * honours its `acceptance`: inclusion accepts a mined burn at once, finality needs 12.
 */
function chain(clock: ReturnType<typeof fakeClock>, opts: { minedAfterMs?: number; neverMined?: boolean } = {}) {
  const mined = () => !opts.neverMined && clock.now() - clock.start >= (opts.minedAfterMs ?? 0);
  const headAt = () => 100 + Math.floor((clock.now() - clock.start) / 2000);
  const probe: FinalityProbe = {
    async receiptBlock() { return mined() ? 100 : null; },
    async headBlock() { return headAt(); },
  };
  const verifierSays = async (p: { acceptance?: 'finality' | 'inclusion' }): Promise<TxVerificationResult> => {
    if (!mined()) return { ok: false, reason: 'tx_not_found' };
    if (p.acceptance === 'inclusion') return { ok: true, blockNumber: 100, blockHash: `0x${'e'.repeat(64)}`, confirmations: 1 };
    const confirmations = headAt() - 100 + 1;
    return confirmations >= 12
      ? { ok: true, blockNumber: 100, confirmations }
      : { ok: false, reason: `insufficient_confirmations: ${confirmations}/12`, confirmations };
  };
  return { probe, verifierSays: verifierSays as never, headAt };
}

beforeEach(() => { mockVerify.mockReset(); });

// The burn id every package derives before the relay records the burn (app burnIdForTx, SDK
// burnIdForTx, MCP present) — the SAME vector is pinned in each; a drift reddens its own test.
describe('burnIdFor — cross-package pin', () => {
  it('is sha256 of "<chain>:<lowercase tx hash>"', () => {
    expect(burnIdFor('base', '0x' + 'AB'.repeat(32))).toBe('9246ac10a914282f7315fc97226a5cf071f3c5d62ae302ae054dc03cc3a61fcd');
    expect(burnIdFor('base', '0x' + 'ab'.repeat(32))).toBe('9246ac10a914282f7315fc97226a5cf071f3c5d62ae302ae054dc03cc3a61fcd');
  });
});

describe('recordFirstPartyBurn — wait + inclusion acceptance', () => {
  it('holds the request until the burn is MINED, accepts it at inclusion, records it provisional, and hands it to finality', async () => {
    const c = fakeClock();
    const ch = chain(c, { minedAfterMs: 3_000 });
    mockVerify.mockImplementation(ch.verifierSays);
    const { db, store } = makeDb();
    const scheduled: string[] = [];
    const r = await recordFirstPartyBurn(
      { db, probe: ch.probe, sleep: c.sleep, now: c.now, scheduleFinalization: (id) => { scheduled.push(id); } },
      params(BURN_RECORD_MAX_WAIT_MS),
    );
    expect(r).toEqual({ ok: true, burnId: BURN_ID, verified: true, finality: 'provisional' });
    expect(store.get(BURN_ID)).toMatchObject({
      status: 'recorded', verified: true, block_number: 100, agent_id: 'agent-1',
      finality: 'provisional', included_block_hash: `0x${'e'.repeat(64)}`, accepted_at: expect.any(Number),
    });
    // Asked at INCLUSION — never at finality, which is the finalizer's job.
    expect(mockVerify.mock.calls.every(([p]) => p.acceptance === 'inclusion')).toBe(true);
    // Accepted the moment it was mined, not 12 blocks later.
    expect(c.elapsed()).toBeGreaterThanOrEqual(3_000);
    expect(c.elapsed()).toBeLessThanOrEqual(3_000 + 250 + BURN_VERIFY_RETRY_MS);
    // Every accepted burn goes to its finality check, exactly once.
    expect(scheduled).toEqual([BURN_ID]);
  });

  it(' A (MEMPOOL RED): a burn never mined inside the wait — pending, dropped, or replaced by a same-nonce tx — records NOTHING', async () => {
    const c = fakeClock();
    const ch = chain(c, { neverMined: true });
    mockVerify.mockImplementation(ch.verifierSays);
    const { db, store } = makeDb();
    const scheduled: string[] = [];
    const r = await recordFirstPartyBurn(
      { db, probe: ch.probe, sleep: c.sleep, now: c.now, scheduleFinalization: (id) => { scheduled.push(id); } },
      params(BURN_RECORD_MAX_WAIT_MS),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.reason).toBe('tx_not_found');
    // No burn row — the in-flight marker was released — so no product can consume it.
    expect(store.has(BURN_ID)).toBe(false);
    expect(scheduled).toEqual([]);
    // Bounded by the relay's wait, never past it.
    expect(c.elapsed()).toBeLessThanOrEqual(BURN_RECORD_MAX_WAIT_MS);
    // Non-vacuous: the verifier WAS asked (and refused) — the refusal, not a skip, is what recorded nothing.
    expect(mockVerify).toHaveBeenCalled();
  });

  it(' B: waitMs 0 — exactly one verifier call; not yet mined → nothing recorded', async () => {
    const c = fakeClock();
    const ch = chain(c, { minedAfterMs: 2_000 });
    mockVerify.mockImplementation(ch.verifierSays);
    const { db, store } = makeDb();
    const r = await recordFirstPartyBurn({ db, probe: ch.probe, sleep: c.sleep, now: c.now }, params(0));
    expect(r).toMatchObject({ ok: false, status: 400, reason: 'tx_not_found' });
    expect(mockVerify).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);
    expect(c.naps).toEqual([]);
  });

  it(' D: a burn REVOKED at finality can never be recorded again (no fresh benefit from a failed burn)', async () => {
    const c = fakeClock();
    const ch = chain(c);
    mockVerify.mockImplementation(ch.verifierSays);
    const { db, store } = makeDb();
    const revoked = { status: 'revoked', verified: false, finality: 'failed', wallet_id: 'aw1', created_at: c.now() - 3_600_000, revoked_at: c.now() - 60_000 };
    store.set(BURN_ID, revoked);
    const r = await recordFirstPartyBurn({ db, probe: ch.probe, sleep: c.sleep, now: c.now }, params(BURN_RECORD_MAX_WAIT_MS));
    expect(r).toMatchObject({ ok: false, status: 409, reason: 'burn_revoked' });
    expect(store.get(BURN_ID)).toEqual(revoked);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('a non-final-but-permanent refusal (wrong burner / amount) ends the wait at once', async () => {
    const c = fakeClock();
    mockVerify.mockResolvedValue({ ok: false, reason: 'no_matching_pvt_burn_log' });
    const probe: FinalityProbe = { async receiptBlock() { return 100; }, async headBlock() { return 200; } };
    const { db, store } = makeDb();
    const r = await recordFirstPartyBurn({ db, probe, sleep: c.sleep, now: c.now }, params(BURN_RECORD_MAX_WAIT_MS));
    expect(r).toMatchObject({ ok: false, status: 400, reason: 'no_matching_pvt_burn_log' });
    expect(mockVerify).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);
  });

  it(' C1: a crashed request\'s stale in-flight marker is taken over', async () => {
    const c = fakeClock();
    mockVerify.mockResolvedValue({ ok: true, blockNumber: 7, confirmations: 12 });
    const { db, store } = makeDb();
    store.set(BURN_ID, { status: 'pending', wallet_id: 'aw1', created_at: c.now() - 60_000, pending_until: c.now() - 1 });
    const r = await recordFirstPartyBurn({ db, sleep: c.sleep, now: c.now }, params(0));
    expect(r).toEqual({ ok: true, burnId: BURN_ID, verified: true, finality: 'provisional' });
    expect(store.get(BURN_ID)).toMatchObject({ status: 'recorded', finality: 'provisional' });
  });

  it(' C2: a LIVE in-flight marker is never trampled — no wait → 409; a waiting caller gets its result', async () => {
    const c = fakeClock();
    const { db, store } = makeDb();
    store.set(BURN_ID, { status: 'pending', wallet_id: 'aw1', created_at: c.now(), pending_until: c.now() + 120_000 });
    const noWait = await recordFirstPartyBurn({ db, sleep: c.sleep, now: c.now }, params(0));
    expect(noWait).toMatchObject({ ok: false, status: 409 });
    expect(mockVerify).not.toHaveBeenCalled();

    // The other request finishes while this one waits.
    let naps = 0;
    const sleep = async (ms: number) => { naps += 1; await c.sleep(ms); if (naps === 3) store.set(BURN_ID, { ...store.get(BURN_ID), status: 'recorded', verified: true }); };
    const waited = await recordFirstPartyBurn({ db, sleep, now: c.now }, params(BURN_RECORD_MAX_WAIT_MS));
    expect(waited).toEqual({ ok: true, burnId: BURN_ID, verified: true, idempotent: true, finality: 'final' });
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('a waiting caller never takes a burn recorded by a DIFFERENT wallet (F10 holds under the wait)', async () => {
    const c = fakeClock();
    const { db, store } = makeDb();
    store.set(BURN_ID, { status: 'recorded', verified: true, wallet_id: 'someone-else' });
    const r = await recordFirstPartyBurn({ db, sleep: c.sleep, now: c.now }, params(BURN_RECORD_MAX_WAIT_MS));
    expect(r).toMatchObject({ ok: false, status: 409 });
  });
});

// a request whose marker went stale and was taken over must never
// write over, or delete, the new owner's row when it finally finishes.
describe('recordFirstPartyBurn — ownership fence on a taken-over marker', () => {
  const W1 = '0x1111111111111111111111111111111111111111';
  const W2 = '0x2222222222222222222222222222222222222222';
  const p1 = { walletId: 'w1', address: W1, ownerKind: 'agent' as const, ownerId: 'a1', txHash: TX, chain: 'base', amountAtomic: '5', waitMs: 0 };
  const p2 = { walletId: 'w2', address: W2, ownerKind: 'agent' as const, ownerId: 'a2', txHash: TX, chain: 'base', amountAtomic: '999', waitMs: 0 };

  it('RED A: the slow rightful owner finishing after a failed takeover still records a whole row for ITSELF', async () => {
    const { store, db } = makeDb();
    let t = 1_000_000;
    const now = () => t;
    let releaseA!: (v: TxVerificationResult) => void;
    const verify = jest.fn<(...a: unknown[]) => Promise<TxVerificationResult>>()
      .mockImplementationOnce(() => new Promise((r) => { releaseA = r; }))
      .mockResolvedValueOnce({ ok: false, reason: 'no_matching_burn_log' });
    const pA = recordFirstPartyBurn({ db, now, sleep: async () => {}, verify: verify as never }, p1);
    await new Promise((r) => setImmediate(r));
    t += BURN_RECORD_PENDING_GRACE_MS + 1_000; // W1's marker is now stale
    const rB = await recordFirstPartyBurn({ db, now, sleep: async () => {}, verify: verify as never }, p2);
    expect(rB.ok).toBe(false);
    releaseA({ ok: true, blockNumber: 1 });
    expect((await pA).ok).toBe(true);
    const row = store.get(BURN_ID)!;
    expect(row).toMatchObject({ status: 'recorded', verified: true, wallet_id: 'w1', amount_atomic: '5', burner_address: W1.toLowerCase() });
    expect(row).not.toHaveProperty('claim_token');
    const again = await recordFirstPartyBurn({ db, now, sleep: async () => {}, verify: verify as never }, p1);
    expect(again).toMatchObject({ ok: true, idempotent: true });
  });

  it('RED B: the stale owner finishing while the NEW owner is in flight writes nothing and does not release it', async () => {
    const { store, db } = makeDb();
    let t = 1_000_000;
    const now = () => t;
    let releaseA!: (v: TxVerificationResult) => void;
    let releaseB!: (v: TxVerificationResult) => void;
    const verify = jest.fn<(...a: unknown[]) => Promise<TxVerificationResult>>()
      .mockImplementationOnce(() => new Promise((r) => { releaseA = r; }))
      .mockImplementationOnce(() => new Promise((r) => { releaseB = r; }));
    const pA = recordFirstPartyBurn({ db, now, sleep: async () => {}, verify: verify as never }, p1);
    await new Promise((r) => setImmediate(r));
    t += BURN_RECORD_PENDING_GRACE_MS + 1_000;
    const pB = recordFirstPartyBurn({ db, now, sleep: async () => {}, verify: verify as never }, p2);
    await new Promise((r) => setImmediate(r));
    expect(store.get(BURN_ID)).toMatchObject({ status: 'pending', wallet_id: 'w2' });
    releaseA({ ok: true, blockNumber: 1 });
    const rA = await pA;
    // W1 lost its marker: nothing is recorded under W2's claimed amount, W2's marker is intact.
    expect(rA).toMatchObject({ ok: false, status: 409 });
    expect(store.get(BURN_ID)).toMatchObject({ status: 'pending', wallet_id: 'w2', amount_atomic: '999' });
    releaseB({ ok: false, reason: 'no_matching_burn_log' });
    expect((await pB).ok).toBe(false);
    expect(store.has(BURN_ID)).toBe(false);
    // W1's retry records its own burn.
    verify.mockResolvedValueOnce({ ok: true, blockNumber: 1 });
    expect(await recordFirstPartyBurn({ db, now, sleep: async () => {}, verify: verify as never }, p1)).toMatchObject({ ok: true });
    expect(store.get(BURN_ID)).toMatchObject({ status: 'recorded', wallet_id: 'w1', amount_atomic: '5' });
  });
});
