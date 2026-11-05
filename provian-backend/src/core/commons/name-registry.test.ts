/**
 * work package O8 — agent name registry acceptance + RED controls.
 *
 * The two scarcity invariants are the point, and each ships with a permanent
 * in-suite RED control that a mutation reddens:
 * - NAME UNIQUENESS: a taken name refuses (RED: second claim of the same name).
 * - ONE BURN → ONE NAME: a spent burn refuses (RED: reuse a burn for a 2nd name).
 * Plus the burn-gate fences: the burn must be the caller's own, recorded+verified.
 * REACHABILITY: the happy path proves a claim CAN succeed, so no refusal below is
 * vacuous.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AgentBankDeps } from '../agent-bank/types';
import {
  claimName,
  resolveName,
  namesForWallet,
  normalizeName,
} from './name-registry';
import {
  BURN_CONSUMPTIONS_COLLECTION,
  PVT_BURN_RECORDS_COLLECTION,
} from './burn-consumption';

type Row = Record<string, unknown>;
type Store = Map<string, Map<string, Row>>;
function coll(store: Store, name: string): Map<string, Row> {
  let c = store.get(name);
  if (!c) { c = new Map(); store.set(name, c); }
  return c;
}
class FakeDocRef {
  constructor(private store: Store, private collection: string, readonly id: string) {}
  async get(): Promise<{ exists: boolean; id: string; data: () => Row | undefined }> {
    const row = coll(this.store, this.collection).get(this.id);
    return { exists: row !== undefined, id: this.id, data: () => (row ? { ...row } : undefined) };
  }
  set(data: Row, opts?: { merge?: boolean }): void {
    const c = coll(this.store, this.collection);
    if (opts?.merge) c.set(this.id, { ...(c.get(this.id) ?? {}), ...data });
    else c.set(this.id, { ...data });
  }
  create(data: Row): void {
    const c = coll(this.store, this.collection);
    if (c.has(this.id)) { const e = new Error('ALREADY_EXISTS') as Error & { code: number }; e.code = 6; throw e; }
    c.set(this.id, { ...data });
  }
}
class FakeQuery {
  constructor(private store: Store, private collection: string, private constraints: [string, unknown][] = []) {}
  where(field: string, _op: string, value: unknown): FakeQuery {
    return new FakeQuery(this.store, this.collection, [...this.constraints, [field, value]]);
  }
  async get(): Promise<{ docs: { id: string; data: () => Row }[] }> {
    let rows = [...coll(this.store, this.collection).entries()];
    for (const [f, v] of this.constraints) rows = rows.filter(([, d]) => d[f] === v);
    return { docs: rows.map(([id, d]) => ({ id, data: () => ({ ...d }) })) };
  }
}
class FakeCollection {
  constructor(private store: Store, private name: string) {}
  doc(id: string): FakeDocRef { return new FakeDocRef(this.store, this.name, id); }
  where(field: string, op: string, value: unknown): FakeQuery {
    return new FakeQuery(this.store, this.name).where(field, op, value);
  }
}
function makeTxn() {
  return {
    get: (ref: FakeDocRef) => ref.get(),
    set: (ref: FakeDocRef, data: Row, opts?: { merge?: boolean }) => ref.set(data, opts),
    create: (ref: FakeDocRef, data: Row) => ref.create(data),
    update: (ref: FakeDocRef, data: Row) => ref.set(data, { merge: true }),
  };
}
function makeDeps(store: Store): AgentBankDeps {
  return {
    db: {
      collection: (name: string) => new FakeCollection(store, name),
      runTransaction: async (fn: (txn: ReturnType<typeof makeTxn>) => Promise<unknown>) => fn(makeTxn()),
    } as unknown as AgentBankDeps['db'],
    cache: {} as unknown as AgentBankDeps['cache'],
    peBuffer: { enqueue: jest.fn() },
    recordPEAccrual: jest.fn(),
  } as unknown as AgentBankDeps;
}

const WALLET = { id: 'aw1', agent_id: 'agent1' };
function seedBurn(store: Store, burnId: string, over: Row = {}): void {
  coll(store, PVT_BURN_RECORDS_COLLECTION).set(burnId, {
    tx_hash: `0x${burnId.slice(0, 8)}`, chain: 'base', wallet_id: 'aw1', agent_id: 'agent1',
    burner_address: '0xabc', amount_atomic: '15000000000000000000',
    status: 'recorded', verified: true, ...over,
  });
}
const B1 = 'a'.repeat(64);
const B2 = 'b'.repeat(64);
const ONE_PVT = 1_000_000_000_000_000_000n; // atomic units; name floor is 15 PVT

let store: Store;
beforeEach(() => { store = new Map(); });

describe('O8 name registry — happy path (reachability)', () => {
  it('a verified own burn claims a unique name; forward + reverse lookups resolve', async () => {
    seedBurn(store, B1);
    const r = await claimName(makeDeps(store), { walletId: 'aw1', agentWallet: WALLET, name: 'Atlas', burnId: B1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.claim.name_normalized).toBe('atlas');
    expect(r.claim.burn_id).toBe(B1);

    const resolved = await resolveName(makeDeps(store), 'ATLAS'); // case-insensitive
    expect(resolved?.wallet_id).toBe('aw1');
    const names = await namesForWallet(makeDeps(store), 'aw1');
    expect(names.map((n) => n.name_normalized)).toEqual(['atlas']);
    // the burn is now marked consumed in the SHARED ledger, tagged to this product
    const marker = coll(store, BURN_CONSUMPTIONS_COLLECTION).get(B1);
    expect(marker?.product).toBe('name_registry');
    expect(marker?.ref).toBe('atlas');
  });
});

describe('O8 name registry — RED controls', () => {
  it('RED name-uniqueness: a taken name refuses even with a fresh valid burn', async () => {
    seedBurn(store, B1); seedBurn(store, B2);
    expect((await claimName(makeDeps(store), { walletId: 'aw1', agentWallet: WALLET, name: 'atlas', burnId: B1 })).ok).toBe(true);
    const dup = await claimName(makeDeps(store), { walletId: 'aw1', agentWallet: WALLET, name: 'Atlas', burnId: B2 });
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.status).toBe(409);
    expect(dup.error).toMatch(/already taken/);
  });

  it('RED one-burn-one-name: a spent burn cannot claim a second name', async () => {
    seedBurn(store, B1);
    expect((await claimName(makeDeps(store), { walletId: 'aw1', agentWallet: WALLET, name: 'atlas', burnId: B1 })).ok).toBe(true);
    const reuse = await claimName(makeDeps(store), { walletId: 'aw1', agentWallet: WALLET, name: 'prometheus', burnId: B1 });
    expect(reuse.ok).toBe(false);
    if (reuse.ok) return;
    expect(reuse.status).toBe(409);
    expect(reuse.error).toMatch(/already been consumed/);
  });

  it('RED global-single-use: a burn already spent by ANOTHER product refuses the name claim', async () => {
    // the shared ledger is checked-and-written by every product. A burn
    // spent on, say, a vouch has a burn_consumptions/{burn_id} marker already, so
    // a later name claim on the SAME burn refuses even though the name is free and
    // the burn is a valid, verified, owned burn. This is the money-path gate: mutate
    // the `if (consumptionSnap.exists)` check in claimName and this reddens.
    seedBurn(store, B1);
    coll(store, BURN_CONSUMPTIONS_COLLECTION).set(B1, {
      burn_id: B1, product: 'vouch', wallet_id: 'aw1', ref: 'someone', consumed_at: 1,
    });
    const r = await claimName(makeDeps(store), { walletId: 'aw1', agentWallet: WALLET, name: 'atlas', burnId: B1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    expect(r.error).toMatch(/already been consumed/);
    // non-vacuous: the SAME name IS claimable with a FRESH, unconsumed burn
    seedBurn(store, B2);
    expect((await claimName(makeDeps(store), { walletId: 'aw1', agentWallet: WALLET, name: 'atlas', burnId: B2 })).ok).toBe(true);
  });

  it('RED burn-ownership: another wallet\'s burn cannot claim', async () => {
    seedBurn(store, B1, { wallet_id: 'aw2' });
    const r = await claimName(makeDeps(store), { walletId: 'aw1', agentWallet: WALLET, name: 'atlas', burnId: B1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(403);
  });

  it('RED unverified/pending burn cannot claim', async () => {
    seedBurn(store, B1, { status: 'pending', verified: false });
    const r = await claimName(makeDeps(store), { walletId: 'aw1', agentWallet: WALLET, name: 'atlas', burnId: B1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    // control that the SAME name IS claimable once the burn is verified (non-vacuous)
    seedBurn(store, B1, { status: 'recorded', verified: true });
    expect((await claimName(makeDeps(store), { walletId: 'aw1', agentWallet: WALLET, name: 'atlas', burnId: B1 })).ok).toBe(true);
  });

  it('RED missing burn / ownership guard / malformed name refuse', async () => {
    expect((await claimName(makeDeps(store), { walletId: 'aw1', agentWallet: WALLET, name: 'atlas', burnId: B1 })).ok).toBe(false); // no burn seeded
    expect((await claimName(makeDeps(store), { walletId: 'aw1', agentWallet: { id: 'other', agent_id: 'x' }, name: 'atlas', burnId: B1 })).ok).toBe(false); // wallet mismatch
    seedBurn(store, B1);
    const bad = await claimName(makeDeps(store), { walletId: 'aw1', agentWallet: WALLET, name: 'a', burnId: B1 });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.status).toBe(400);
  });
});

describe('O8 name registry — minimum-burn floor (Part 1)', () => {
  it('RED sub-floor burn refused (400); a fresh at-floor burn claims the name', async () => {
    // 14.999… PVT < the 15-PVT name-claim floor → refused before any claim.
    // Mutating the floor check in assertBurnRowUsable reddens this.
    seedBurn(store, B1, { amount_atomic: (15n * ONE_PVT - 1n).toString() });
    const under = await claimName(makeDeps(store), { walletId: 'aw1', agentWallet: WALLET, name: 'atlas', burnId: B1 });
    expect(under.ok).toBe(false);
    if (under.ok) return;
    expect(under.status).toBe(400);
    // non-vacuous: a fresh burn EXACTLY at the floor claims the same name
    seedBurn(store, B2, { amount_atomic: (15n * ONE_PVT).toString() });
    expect((await claimName(makeDeps(store), { walletId: 'aw1', agentWallet: WALLET, name: 'atlas', burnId: B2 })).ok).toBe(true);
  });
});

describe('O8 normalizeName', () => {
  it('lowercases, bounds length, and rejects bad charsets', () => {
    expect(normalizeName('Atlas')).toBe('atlas');
    expect(normalizeName('a')).toBeNull();
    expect(normalizeName('-bad')).toBeNull();
    expect(normalizeName('has space')).toBeNull();
    expect(normalizeName('x'.repeat(33))).toBeNull();
    expect(normalizeName('good_name-1')).toBe('good_name-1');
  });
});
