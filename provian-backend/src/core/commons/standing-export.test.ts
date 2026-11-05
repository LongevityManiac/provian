/**
 * work package O9 standing export — REMEDIATED to burn-to-present.
 *
 * The standing export was a bearer snapshot: `GET /v1/standing/:id` returned the
 * scores to anyone holding the id — unsigned, requester-unbound, replayable. It is
 * now a reputation-tier presentation (tested in presentation.test.ts). This file
 * locks the NON-presentation surface that remains:
 * - a raw id lookup returns ONLY metadata, NEVER scores (the defect is gone);
 * - the owner history lists metadata only;
 * - a RED control feeds a record carrying scores and proves they never leak.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import type { AgentBankDeps } from '../agent-bank/types';
import {
  getStandingPresentationMeta,
  standingPresentationsByWallet,
} from './standing-export';
import { COMMONS_PRESENTATIONS_COLLECTION } from '../presentation/service';

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
}
class FakeQuery {
  constructor(private store: Store, private collection: string, private constraints: [string, unknown][] = [], private lim = Infinity) {}
  where(field: string, _op: string, value: unknown): FakeQuery {
    return new FakeQuery(this.store, this.collection, [...this.constraints, [field, value]], this.lim);
  }
  limit(n: number): FakeQuery { return new FakeQuery(this.store, this.collection, this.constraints, n); }
  async get(): Promise<{ empty: boolean; docs: { id: string; data: () => Row }[] }> {
    let rows = [...coll(this.store, this.collection).entries()];
    for (const [f, v] of this.constraints) rows = rows.filter(([, d]) => d[f] === v);
    rows = rows.slice(0, this.lim);
    return { empty: rows.length === 0, docs: rows.map(([id, d]) => ({ id, data: () => ({ ...d }) })) };
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

const BURN = 'a'.repeat(64);
// A record that DELIBERATELY carries scores, to prove they never leak through the
// metadata surface. The production path never writes scores to this record; this
// adversarial seed is the RED control's input.
function seedPresentation(store: Store, id: string, over: Row = {}): void {
  coll(store, COMMONS_PRESENTATIONS_COLLECTION).set(id, {
    presentation_id: 'pres_1',
    tier: 'reputation',
    wallet_id: 'aw1',
    presenter_address: '0xabc',
    audience: 'requester-1',
    issued_at: 1000,
    expires_at: 1300,
    // adversarial: scores that MUST NOT appear in any metadata response
    governance_score: 72,
    pe_count: 41,
    streak_days: 9,
    ...over,
  });
}

let store: Store;
beforeEach(() => { store = new Map(); });

describe('standing metadata lookup — reachability', () => {
  it('resolves a reputation presentation to non-sensitive metadata', async () => {
    seedPresentation(store, BURN);
    const meta = await getStandingPresentationMeta(makeDeps(store), BURN);
    expect(meta).not.toBeNull();
    expect(meta?.presentation_id).toBe('pres_1');
    expect(meta?.audience).toBe('requester-1');
    expect(meta?.wallet_id).toBe('aw1');
  });

  it('owner history lists the wallet\'s reputation presentations (metadata only)', async () => {
    seedPresentation(store, BURN);
    const list = await standingPresentationsByWallet(makeDeps(store), 'aw1');
    expect(list.length).toBe(1);
    expect(list[0].presentation_id).toBe('pres_1');
  });
});

describe('RED — a raw id lookup NEVER returns a bearer snapshot (scores)', () => {
  it('metadata carries no scores even when the record adversarially holds them', async () => {
    seedPresentation(store, BURN);
    const meta = await getStandingPresentationMeta(makeDeps(store), BURN);
    expect(meta).not.toBeNull();
    // The whole object, serialized, must contain none of the score fields/values.
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toMatch(/governance_score/);
    expect(serialized).not.toMatch(/pe_count/);
    expect(serialized).not.toMatch(/streak_days/);
    expect(Object.keys(meta as object)).not.toContain('governance_score');
    // Non-vacuous: metadata IS returned (the lookup works), it simply omits scores.
    expect(meta?.audience).toBe('requester-1');
  });

  it('owner history rows carry no scores either', async () => {
    seedPresentation(store, BURN);
    const list = await standingPresentationsByWallet(makeDeps(store), 'aw1');
    expect(JSON.stringify(list)).not.toMatch(/governance_score|pe_count|streak_days/);
  });
});

describe('standing metadata lookup — refusals', () => {
  it('non-reputation records and missing ids return null', async () => {
    seedPresentation(store, BURN, { tier: 'pe_fact' });
    expect(await getStandingPresentationMeta(makeDeps(store), BURN)).toBeNull();
    expect(await getStandingPresentationMeta(makeDeps(store), 'c'.repeat(64))).toBeNull();
    expect(await getStandingPresentationMeta(makeDeps(store), '')).toBeNull();
  });
});
