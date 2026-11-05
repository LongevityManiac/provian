/**
 * work package O4 — VOUCH under the RAIL HANDSHAKE (fold, 6-09-04) + RED controls.
 *
 * A vouch is a TRUST ACT and is now GATED: it commits ONLY behind a live
 * REPUTATION-tier handshake (a burn-backed reputation presentation the voucher
 * produced to the vouchee = `target_agent_id`). The presentation IS the vouch's
 * burn — the vouch never burns again (fold, don't stack). Fences, each with a
 * permanent RED control a mutation reddens, paired with a non-vacuous reachability
 * proof:
 * - missing-handshake: no live reputation presentation to the vouchee → 428.
 * - wrong-tier: a 5-PVT pe_fact handshake does NOT satisfy the vouch → 428
 * (this is what preserves the 15-PVT scarcity floor through the fold).
 * - wrong-audience: a reputation handshake to a DIFFERENT party → 428 here
 * (per-relationship binding; anti-sybil quantity control per relationship).
 * - expired-window: a presentation older than the finite window → 428.
 * - per-relationship (NOT per-action): ONE live handshake makes MANY vouches to
 * the same vouchee (the decision's "second vouch in-window, no new present").
 * - self-vouch / ownership / note bounds refuse.
 * REACHABILITY: the happy path proves a vouch CAN succeed, so no refusal is vacuous.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import type { AgentBankDeps } from '../agent-bank/types';
import {
  stakeVouch,
  stakeHumanVouch,
  getVouch,
  vouchesByVoucher,
  vouchesForTarget,
  LINKED_PAIR_VOUCH_REFUSED,
} from './burn-vouch';
import { COMMONS_PRESENTATIONS_COLLECTION } from '../presentation/types';
import { RAIL_HANDSHAKE_WINDOW_MS } from '../rail/handshake';

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
  constructor(private store: Store, private collection: string, private constraints: [string, unknown][] = [], private max?: number) {}
  where(field: string, _op: string, value: unknown): FakeQuery {
    return new FakeQuery(this.store, this.collection, [...this.constraints, [field, value]], this.max);
  }
  limit(n: number): FakeQuery {
    return new FakeQuery(this.store, this.collection, this.constraints, n);
  }
  async get(): Promise<{ empty: boolean; docs: { id: string; data: () => Row }[] }> {
    let rows = [...coll(this.store, this.collection).entries()];
    for (const [f, v] of this.constraints) rows = rows.filter(([, d]) => d[f] === v);
    if (this.max !== undefined) rows = rows.slice(0, this.max);
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

const VOUCHER = { id: 'aw1', agent_id: 'agent1' };
const TARGET = 'agent2';
const NOW = 1_800_000_000_000;

/**
 * Seed a live handshake — exactly what producing a presentation to `audience`
 * writes into `commons_presentations` (keyed by burn_id). `tier` defaults to the
 * reputation tier the vouch gate requires.
 */
function seedHandshake(
  store: Store,
  walletId: string,
  audience: string,
  recordedAt: number,
  opts: { burnId?: string; tier?: 'pe_fact' | 'reputation' } = {},
): string {
  const burnId = opts.burnId ?? `burn_${walletId}_${audience}_${recordedAt}`;
  coll(store, COMMONS_PRESENTATIONS_COLLECTION).set(burnId, {
    presentation_id: `pres_${burnId}`, tier: opts.tier ?? 'reputation', wallet_id: walletId,
    audience, burn_id: burnId, recorded_at: recordedAt,
  });
  return burnId;
}

let store: Store;
beforeEach(() => {
  store = new Map();
  // the agent vouch path reads the voucher's own wallet record (linked-human exclusion).
  coll(store, 'agent_wallets').set('aw1', { id: 'aw1', agent_id: 'agent1' });
});

describe('O4 vouch — happy path (reachability)', () => {
  it('a live reputation handshake to the vouchee stakes a vouch; lookups resolve; backing burn recorded', async () => {
    const burnId = seedHandshake(store, 'aw1', TARGET, NOW - 1000, { burnId: 'burnA' });
    const r = await stakeVouch(makeDeps(store), { walletId: 'aw1', agentWallet: VOUCHER, targetAgentId: TARGET, note: 'solid work', nowMs: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vouch.target_agent_id).toBe(TARGET);
    expect(r.vouch.note).toBe('solid work');
    expect(r.vouch.backing_burn_id).toBe(burnId);
    expect(r.vouch.vouch_id.startsWith('vouch_')).toBe(true);

    expect((await getVouch(makeDeps(store), r.vouch.vouch_id))?.voucher_agent_id).toBe('agent1');
    expect((await vouchesByVoucher(makeDeps(store), 'aw1')).map((v) => v.target_agent_id)).toEqual([TARGET]);
    expect((await vouchesForTarget(makeDeps(store), TARGET)).map((v) => v.voucher_agent_id)).toEqual(['agent1']);
  });

  it('per-relationship, NOT per-action: ONE live handshake stakes MANY vouches to the same vouchee (no new present)', async () => {
    seedHandshake(store, 'aw1', TARGET, NOW - 1000);
    const a = await stakeVouch(makeDeps(store), { walletId: 'aw1', agentWallet: VOUCHER, targetAgentId: TARGET, note: 'first', nowMs: NOW });
    const b = await stakeVouch(makeDeps(store), { walletId: 'aw1', agentWallet: VOUCHER, targetAgentId: TARGET, note: 'second', nowMs: NOW });
    expect(a.ok && b.ok).toBe(true);
    expect((await vouchesForTarget(makeDeps(store), TARGET)).length).toBe(2);
    // Both rode the SAME backing burn — no second/stacked burn was charged.
    if (a.ok && b.ok) expect(a.vouch.backing_burn_id).toBe(b.vouch.backing_burn_id);
  });
});

describe('O4 vouch — RED controls (gate)', () => {
  it('RED missing-handshake: no live reputation presentation → 428 (a fresh one then passes)', async () => {
    // Empty population: no presentation seeded. Must refuse, not pass vacuously.
    const r = await stakeVouch(makeDeps(store), { walletId: 'aw1', agentWallet: VOUCHER, targetAgentId: TARGET, nowMs: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(428);
    expect(r.reason).toBe('rail_handshake_required');
    // non-vacuous: seeding a live reputation handshake flips it to a pass
    seedHandshake(store, 'aw1', TARGET, NOW - 1000);
    expect((await stakeVouch(makeDeps(store), { walletId: 'aw1', agentWallet: VOUCHER, targetAgentId: TARGET, nowMs: NOW })).ok).toBe(true);
  });

  it('RED wrong-tier: a 5-PVT pe_fact handshake does NOT satisfy the vouch → 428 (scarcity floor preserved)', async () => {
    seedHandshake(store, 'aw1', TARGET, NOW - 1000, { tier: 'pe_fact' });
    const peFactOnly = await stakeVouch(makeDeps(store), { walletId: 'aw1', agentWallet: VOUCHER, targetAgentId: TARGET, nowMs: NOW });
    expect(peFactOnly.ok).toBe(false);
    if (peFactOnly.ok) return;
    expect(peFactOnly.status).toBe(428);
    // non-vacuous: a reputation handshake to the same vouchee passes
    seedHandshake(store, 'aw1', TARGET, NOW - 900, { tier: 'reputation', burnId: 'repBurn' });
    expect((await stakeVouch(makeDeps(store), { walletId: 'aw1', agentWallet: VOUCHER, targetAgentId: TARGET, nowMs: NOW })).ok).toBe(true);
  });

  it('RED wrong-audience: a reputation handshake to a DIFFERENT party does not license a vouch here → 428', async () => {
    seedHandshake(store, 'aw1', 'agentOTHER', NOW - 1000);
    const r = await stakeVouch(makeDeps(store), { walletId: 'aw1', agentWallet: VOUCHER, targetAgentId: TARGET, nowMs: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(428);
    // non-vacuous: the handshake to THIS vouchee makes the vouch
    seedHandshake(store, 'aw1', TARGET, NOW - 1000);
    expect((await stakeVouch(makeDeps(store), { walletId: 'aw1', agentWallet: VOUCHER, targetAgentId: TARGET, nowMs: NOW })).ok).toBe(true);
  });

  it('RED expired-window: a reputation presentation older than the finite window → 428', async () => {
    seedHandshake(store, 'aw1', TARGET, NOW - RAIL_HANDSHAKE_WINDOW_MS - 1);
    const stale = await stakeVouch(makeDeps(store), { walletId: 'aw1', agentWallet: VOUCHER, targetAgentId: TARGET, nowMs: NOW });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.status).toBe(428);
    // non-vacuous: a presentation just inside the window makes the vouch
    seedHandshake(store, 'aw1', TARGET, NOW - RAIL_HANDSHAKE_WINDOW_MS + 1000, { burnId: 'fresh' });
    expect((await stakeVouch(makeDeps(store), { walletId: 'aw1', agentWallet: VOUCHER, targetAgentId: TARGET, nowMs: NOW })).ok).toBe(true);
  });
});

describe('O4 vouch — RED controls (act validity)', () => {
  it('RED self-vouch: an agent cannot vouch for itself (even with a live handshake)', async () => {
    seedHandshake(store, 'aw1', 'agent1', NOW - 1000);
    const r = await stakeVouch(makeDeps(store), { walletId: 'aw1', agentWallet: VOUCHER, targetAgentId: 'agent1', nowMs: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/yourself/);
  });

  it('RED ownership + note bounds refuse (with a live handshake present)', async () => {
    seedHandshake(store, 'aw1', TARGET, NOW - 1000);
    // wallet mismatch (403) even with a handshake
    expect((await stakeVouch(makeDeps(store), { walletId: 'aw1', agentWallet: { id: 'aw2', agent_id: 'x' }, targetAgentId: TARGET, nowMs: NOW })).ok).toBe(false);
    // too-long note
    const longNote = await stakeVouch(makeDeps(store), { walletId: 'aw1', agentWallet: VOUCHER, targetAgentId: TARGET, note: 'x'.repeat(281), nowMs: NOW });
    expect(longNote.ok).toBe(false);
    if (longNote.ok) return;
    expect(longNote.status).toBe(400);
    // malformed target
    expect((await stakeVouch(makeDeps(store), { walletId: 'aw1', agentWallet: VOUCHER, targetAgentId: '', nowMs: NOW })).ok).toBe(false);
  });
});


// ─── the excluded pair + a PERSON's vouch ────────────────────────────────────────────
describe('excluded pair (agent → its linked human), enforced at the relay', () => {
  const HUMAN_USER = 'user_linked';
  const HUMAN_WALLET_DOC = 'wallet_linked_doc';
  const HUMAN_ADDR = '0xAbCdEf0000000000000000000000000000000001';

  it('RED: an agent cannot vouch for its linked human — by user id, wallet doc id, or address — even WITH a live handshake', async () => {
    coll(store, 'agent_wallets').set('aw1', {
      id: 'aw1', agent_id: 'agent1',
      linked_human_user_id: HUMAN_USER, linked_human_wallet_id: HUMAN_WALLET_DOC, linked_human_address: HUMAN_ADDR,
    });
    for (const ref of [HUMAN_USER, HUMAN_WALLET_DOC, HUMAN_ADDR.toLowerCase()]) {
      seedHandshake(store, 'aw1', ref, NOW - 1000);
      const r = await stakeVouch(makeDeps(store), { walletId: 'aw1', agentWallet: VOUCHER, targetAgentId: ref, nowMs: NOW });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(403);
        expect(r.reason).toBe(LINKED_PAIR_VOUCH_REFUSED);
      }
    }
    expect(coll(store, 'commons_burn_vouches').size).toBe(0);
  });

  it('REACHABILITY: the same agent CAN vouch for a person it is NOT linked to (the refusal is the link, nothing else)', async () => {
    coll(store, 'agent_wallets').set('aw1', { id: 'aw1', agent_id: 'agent1', linked_human_user_id: HUMAN_USER });
    seedHandshake(store, 'aw1', 'user_someone_else', NOW - 1000);
    const r = await stakeVouch(makeDeps(store), { walletId: 'aw1', agentWallet: VOUCHER, targetAgentId: 'user_someone_else', nowMs: NOW });
    expect(r.ok).toBe(true);
  });

  it('fail-closed: a voucher whose own wallet record cannot be read is refused (Unknown = Block)', async () => {
    coll(store, 'agent_wallets').delete('aw1');
    seedHandshake(store, 'aw1', TARGET, NOW - 1000);
    const r = await stakeVouch(makeDeps(store), { walletId: 'aw1', agentWallet: VOUCHER, targetAgentId: TARGET, nowMs: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(503);
  });
});

describe('a PERSON vouches (same reputation burn + floor; excluded pair refused)', () => {
  const USER = 'user_frank';
  const PRESENTER = 'wallet_frank_doc';
  const ADDR = '0x1111111111111111111111111111111111111111';
  const LINKED_AGENT_WALLET = 'wallet_aw_linked';
  const LINKED_AGENT_ID = 'agent_linked';
  const OTHER_AGENT_WALLET = 'wallet_aw_other';
  const OTHER_AGENT_ID = 'agent_other';
  const OTHER_PERSON = 'user_other';

  beforeEach(() => {
    coll(store, 'wallets').set(PRESENTER, { user_id: USER, type: 'human', address: ADDR });
    coll(store, 'agent_wallets').set(LINKED_AGENT_WALLET, { id: LINKED_AGENT_WALLET, agent_id: LINKED_AGENT_ID, linked_human_user_id: USER, linked_human_wallet_id: PRESENTER });
    coll(store, 'agent_wallets').set(OTHER_AGENT_WALLET, { id: OTHER_AGENT_WALLET, agent_id: OTHER_AGENT_ID, linked_human_user_id: 'user_somebody' });
    coll(store, 'commons_profiles').set(OTHER_PERSON, { wallet_id: OTHER_PERSON, participant_type: 'human' });
  });

  it('REACHABILITY: a person vouches for an unlinked agent on a live REPUTATION presentation to its Commons id; the vouch carries it', async () => {
    const burnId = seedHandshake(store, PRESENTER, OTHER_AGENT_WALLET, NOW - 1000, { burnId: 'burnH' });
    const r = await stakeHumanVouch(makeDeps(store), { userId: USER, targetId: OTHER_AGENT_WALLET, note: 'good agent', nowMs: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vouch.voucher_kind).toBe('human');
    expect(r.vouch.voucher_wallet_id).toBe(USER);
    expect(r.vouch.target_kind).toBe('agent');
    expect(r.vouch.target_party_id).toBe(OTHER_AGENT_WALLET);
    expect(r.vouch.target_agent_id).toBe(OTHER_AGENT_ID); // listed with the agent's other vouches
    expect(r.vouch.backing_burn_id).toBe(burnId);
    expect((await vouchesForTarget(makeDeps(store), OTHER_AGENT_ID)).length).toBe(1);
  });

  it('REACHABILITY: a person vouches for another person (profile on the Commons)', async () => {
    seedHandshake(store, PRESENTER, OTHER_PERSON, NOW - 1000);
    const r = await stakeHumanVouch(makeDeps(store), { userId: USER, targetId: OTHER_PERSON, nowMs: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.vouch.target_kind).toBe('human');
    expect((await vouchesForTarget(makeDeps(store), OTHER_PERSON)).length).toBe(1);
  });

  it('RED: a person cannot vouch for their OWN linked agent — by wallet id or agent id — even with a live reputation handshake', async () => {
    for (const ref of [LINKED_AGENT_WALLET, LINKED_AGENT_ID]) {
      seedHandshake(store, PRESENTER, ref, NOW - 1000);
      const r = await stakeHumanVouch(makeDeps(store), { userId: USER, targetId: ref, nowMs: NOW });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(403);
        expect(r.reason).toBe(LINKED_PAIR_VOUCH_REFUSED);
      }
    }
    expect(coll(store, 'commons_burn_vouches').size).toBe(0);
  });

  it('RED: no live reputation presentation → 428; a pe_fact one does not satisfy it either', async () => {
    const none = await stakeHumanVouch(makeDeps(store), { userId: USER, targetId: OTHER_AGENT_WALLET, nowMs: NOW });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.status).toBe(428);
    seedHandshake(store, PRESENTER, OTHER_AGENT_WALLET, NOW - 1000, { tier: 'pe_fact' });
    const cheap = await stakeHumanVouch(makeDeps(store), { userId: USER, targetId: OTHER_AGENT_WALLET, nowMs: NOW });
    expect(cheap.ok).toBe(false);
    if (!cheap.ok) expect(cheap.status).toBe(428);
  });

  it('RED: the handshake must come from THIS person (another presenter\'s presentation does not count)', async () => {
    seedHandshake(store, 'wallet_someone_else_doc', OTHER_AGENT_WALLET, NOW - 1000);
    const r = await stakeHumanVouch(makeDeps(store), { userId: USER, targetId: OTHER_AGENT_WALLET, nowMs: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(428);
  });

  it('self-vouch refuses (by user id, wallet doc id, address); an unknown target is 404', async () => {
    for (const ref of [USER, PRESENTER, ADDR]) {
      const r = await stakeHumanVouch(makeDeps(store), { userId: USER, targetId: ref, nowMs: NOW });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    }
    const unknown = await stakeHumanVouch(makeDeps(store), { userId: USER, targetId: 'user_nobody', nowMs: NOW });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.status).toBe(404);
  });
});
