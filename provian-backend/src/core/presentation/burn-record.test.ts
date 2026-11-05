/**
 * First-party burn recorder — acceptance + the human-burn-from-wrong-address RED
 * control.
 *
 * The security property: a burn is bound to the CALLER's own first-party address.
 * `recordFirstPartyBurn` passes `expectedFrom: <caller address>` to the on-chain
 * verifier, which requires a `Transfer(expectedFrom, 0x0, amount)` so a burn NOT
 * from the caller's address has no matching log and is refused. This is what makes
 * the human path safe: a human cannot record someone else's burn, and the burner
 * is never client-supplied.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockVerify = jest.fn<typeof import('../onchain/tx-verifier').verifyEvmPvtBurn>();
jest.mock('../onchain/tx-verifier', () => ({
  verifyEvmPvtBurn: (...args: unknown[]) => mockVerify(...(args as Parameters<typeof import('../onchain/tx-verifier').verifyEvmPvtBurn>)),
}));
import { recordFirstPartyBurn } from './burn-record';

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
  return {
    store,
    db: {
      collection: () => ({ doc: (id: string) => new FakeDocRef(store, id) }),
      runTransaction: async (fn: (txn: unknown) => Promise<unknown>) => fn({
        get: (r: { get: () => Promise<unknown> }) => r.get(),
        set: (r: { set: (d: Record<string, unknown>) => Promise<void> }, d: Record<string, unknown>) => { void r.set(d); },
        create: (r: { create: (d: Record<string, unknown>) => Promise<void> }, d: Record<string, unknown>) => r.create(d),
        delete: (r: { delete: () => Promise<void> }) => { void r.delete(); },
      }),
    } as unknown as import('firebase-admin/firestore').Firestore,
  };
}

const HUMAN = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const TX = `0x${'a'.repeat(64)}`;
const AMT = (15n * 10n ** 18n).toString();

beforeEach(() => { mockVerify.mockReset(); });

describe('recordFirstPartyBurn — binds expectedFrom to the caller address', () => {
  it('passes the caller\'s OWN address as expectedFrom, and records on a matching burn', async () => {
    mockVerify.mockResolvedValue({ ok: true, blockNumber: 42 });
    const { db, store } = makeDb();
    const r = await recordFirstPartyBurn({ db }, { walletId: 'hw1', address: HUMAN, ownerKind: 'human', ownerId: 'user1', txHash: TX, chain: 'base', amountAtomic: AMT });
    expect(r.ok).toBe(true);
    // The verifier was asked for a burn FROM the human's own address — never a client value.
    expect(mockVerify).toHaveBeenCalledWith(expect.objectContaining({ expectedFrom: HUMAN, chainId: 8453 }));
    expect((store.get([...store.keys()][0]) as Row).burner_address).toBe(HUMAN.toLowerCase());
  });

  it('RED: a burn that was NOT from the caller\'s address is refused (verifier finds no matching log)', async () => {
    // Simulate the chain: the burn tx exists but was sent from OTHER, so a verifier
    // asked for expectedFrom=HUMAN finds no matching Transfer(HUMAN,0x0,amt).
    mockVerify.mockImplementation(async (p) =>
      p.expectedFrom.toLowerCase() === OTHER.toLowerCase() ? { ok: true, blockNumber: 1 } : { ok: false, reason: 'no_matching_pvt_burn_log' });
    const { db, store } = makeDb();
    const r = await recordFirstPartyBurn({ db }, { walletId: 'hw1', address: HUMAN, ownerKind: 'human', ownerId: 'user1', txHash: TX, chain: 'base', amountAtomic: AMT });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.reason).toBe('no_matching_pvt_burn_log');
    // the pending marker was released so a corrected retry can proceed
    expect(store.size).toBe(0);
    // non-vacuous: the SAME tx recorded for the address that actually burned succeeds
    const r2 = await recordFirstPartyBurn({ db }, { walletId: 'aw1', address: OTHER, ownerKind: 'agent', ownerId: 'agent1', txHash: TX, chain: 'base', amountAtomic: AMT });
    expect(r2.ok).toBe(true);
  });

  it('rejects malformed address / tx / amount before touching the chain', async () => {
    const { db } = makeDb();
    expect((await recordFirstPartyBurn({ db }, { walletId: 'w', address: 'not-an-address', ownerKind: 'human', ownerId: 'u', txHash: TX, chain: 'base', amountAtomic: AMT })).ok).toBe(false);
    expect((await recordFirstPartyBurn({ db }, { walletId: 'w', address: HUMAN, ownerKind: 'human', ownerId: 'u', txHash: '0xbad', chain: 'base', amountAtomic: AMT })).ok).toBe(false);
    expect((await recordFirstPartyBurn({ db }, { walletId: 'w', address: HUMAN, ownerKind: 'human', ownerId: 'u', txHash: TX, chain: 'base', amountAtomic: '0' })).ok).toBe(false);
    expect((await recordFirstPartyBurn({ db }, { walletId: 'w', address: HUMAN, ownerKind: 'human', ownerId: 'u', txHash: TX, chain: 'polygon', amountAtomic: AMT })).ok).toBe(false);
    expect(mockVerify).not.toHaveBeenCalled();
  });
});
