/**
 * work package O6 — SUBSCRIPTION under the RAIL HANDSHAKE + RED controls.
 *
 * A subscription commits ONLY behind a live commons handshake (a burn-backed
 * presentation to RAIL_COMMONS_AUDIENCE). The presentation IS the burn — the
 * subscription never burns again. Fences, each with a permanent RED control and a
 * non-vacuous reachability proof:
 * - missing-handshake: no live commons presentation → 428.
 * - expired-window: a presentation older than the finite window → 428.
 * - per-relationship (NOT per-action): one handshake makes MANY subscriptions.
 * - ownership / topic bounds enforced.
 * REACHABILITY: the happy path proves a subscription CAN succeed.
 */
import { describe, it, expect } from '@jest/globals';
import type { AgentBankDeps } from '../agent-bank/types';
import {
  subscribe,
  normalizeTopic,
  subscriptionsByWallet,
} from './subscriptions';
import { COMMONS_PRESENTATIONS_COLLECTION } from '../presentation/service';
import { RAIL_COMMONS_AUDIENCE, RAIL_HANDSHAKE_WINDOW_MS } from '../rail/handshake';

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
function makeDeps(store: Store): AgentBankDeps {
  return {
    db: { collection: (name: string) => new FakeCollection(store, name) } as unknown as AgentBankDeps['db'],
  } as unknown as AgentBankDeps;
}

const WALLET = { id: 'aw1', agent_id: 'agent1' };
const TOPIC = 'want.translation';
const NOW = 1_800_000_000_000;

function seedCommonsHandshake(store: Store, walletId: string, recordedAt: number, burnId = `burn_${walletId}_${recordedAt}`): void {
  coll(store, COMMONS_PRESENTATIONS_COLLECTION).set(burnId, {
    presentation_id: `pres_${burnId}`, tier: 'reputation', wallet_id: walletId,
    audience: RAIL_COMMONS_AUDIENCE, burn_id: burnId, recorded_at: recordedAt,
  });
}

let store: Store;
beforeEach(() => { store = new Map(); });

describe('O6 subscription — topic normalization', () => {
  it('valid topics normalize; invalid reject', () => {
    expect(normalizeTopic('Want.Translation')).toBe('want.translation');
    expect(normalizeTopic('a')).toBeNull();
    expect(normalizeTopic('bad topic!')).toBeNull();
  });
});

describe('O6 subscription — happy path (reachability)', () => {
  it('a live commons handshake buys a subscription; backing burn recorded', async () => {
    seedCommonsHandshake(store, 'aw1', NOW - 1000, 'burnA');
    const r = await subscribe(makeDeps(store), { walletId: 'aw1', agentWallet: WALLET, topic: TOPIC, nowMs: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.subscription.topic).toBe(TOPIC);
    expect(r.subscription.backing_burn_id).toBe('burnA');
    expect(r.subscription.subscription_id.startsWith('sub_')).toBe(true);
    expect((await subscriptionsByWallet(makeDeps(store), 'aw1')).length).toBe(1);
  });

  it('per-relationship, NOT per-action: ONE live handshake buys MANY subscriptions', async () => {
    seedCommonsHandshake(store, 'aw1', NOW - 1000);
    const a = await subscribe(makeDeps(store), { walletId: 'aw1', agentWallet: WALLET, topic: 'want.translation', nowMs: NOW });
    const b = await subscribe(makeDeps(store), { walletId: 'aw1', agentWallet: WALLET, topic: 'want.design', nowMs: NOW });
    expect(a.ok && b.ok).toBe(true);
    expect((await subscriptionsByWallet(makeDeps(store), 'aw1')).length).toBe(2);
  });
});

describe('O6 subscription — RED controls', () => {
  it('RED missing-handshake: no live commons presentation → 428 (a fresh one then passes)', async () => {
    const r = await subscribe(makeDeps(store), { walletId: 'aw1', agentWallet: WALLET, topic: TOPIC, nowMs: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(428);
    expect(r.reason).toBe('rail_handshake_required');
    seedCommonsHandshake(store, 'aw1', NOW - 1000);
    expect((await subscribe(makeDeps(store), { walletId: 'aw1', agentWallet: WALLET, topic: TOPIC, nowMs: NOW })).ok).toBe(true);
  });

  it('RED expired-window: a commons presentation older than the finite window → 428', async () => {
    seedCommonsHandshake(store, 'aw1', NOW - RAIL_HANDSHAKE_WINDOW_MS - 1);
    const stale = await subscribe(makeDeps(store), { walletId: 'aw1', agentWallet: WALLET, topic: TOPIC, nowMs: NOW });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.status).toBe(428);
    seedCommonsHandshake(store, 'aw1', NOW - RAIL_HANDSHAKE_WINDOW_MS + 1000, 'fresh');
    expect((await subscribe(makeDeps(store), { walletId: 'aw1', agentWallet: WALLET, topic: TOPIC, nowMs: NOW })).ok).toBe(true);
  });

  it('RED ownership + topic bounds refuse (with a live handshake present)', async () => {
    seedCommonsHandshake(store, 'aw1', NOW - 1000);
    expect((await subscribe(makeDeps(store), { walletId: 'aw1', agentWallet: { id: 'aw2', agent_id: 'x' }, topic: TOPIC, nowMs: NOW })).ok).toBe(false);
    expect((await subscribe(makeDeps(store), { walletId: 'aw1', agentWallet: WALLET, topic: 'a', nowMs: NOW })).ok).toBe(false);
  });
});
