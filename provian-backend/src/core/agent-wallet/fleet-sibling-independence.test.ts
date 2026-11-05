/**
 * "The independence multiplier treats cross-citations inside the
 * fleet as internal (existing rule, unchanged)."
 *
 * A fleet code links each of a user's agents to the SAME human, so every fleet
 * agent is a sibling of every other (agent_wallets.linked_human_user_id equality).
 * This pins that the existing signer identity set already makes those siblings
 * one party: an origin a sibling owns is `same_party` and adds ZERO independence
 * lift, in both directions. RED control in-suite: the identical origin owned by
 * an unlinked stranger adds lift (count 1), so the zero is the rule, not an empty
 * set. No money-path code changes; this is a pin over it.
 */

import { resolveSignerIdentitySet } from '../pvt/signer-identity-set';
import { resolveOriginPricingInputs } from '../pvt/origin-pricing-inputs';
import type { BeneficiaryCacheEntry } from '../pvt/beneficiary';
import type { InputOrigin } from '../provenance/input-origins';
import type { SealedWitness } from '../pvt/origin-independence';

type Row = Record<string, unknown> & { __id?: string };

/** Minimal Firestore: where().get() over seeded rows (+ the paged/projected chain and batch the graph recorder uses). */
function fakeDb(seed: Record<string, Row[]>) {
  const cols = new Map<string, Map<string, Record<string, unknown>>>();
  const getCol = (name: string) => {
    let m = cols.get(name);
    if (!m) { m = new Map(); cols.set(name, m); }
    return m;
  };
  for (const [name, rows] of Object.entries(seed)) {
    let auto = 0;
    for (const r of rows) {
      const { __id, ...rest } = r;
      getCol(name).set(__id ?? `auto_${auto++}`, rest);
    }
  }
  return {
    collection(name: string) {
      const store = getCol(name);
      return {
        doc(id: string) {
          return { _col: name, _id: id, get: async () => ({ exists: store.has(id), data: () => store.get(id) }) };
        },
        where(field: string, _op: string, value: unknown) {
          const q = { limit: Infinity, after: null as string | null, fields: null as string[] | null };
          const chain = {
            orderBy: () => chain,
            select: (...fields: string[]) => { q.fields = fields; return chain; },
            limit: (n: number) => { q.limit = n; return chain; },
            startAfter: (id: string) => { q.after = id; return chain; },
            get: async () => {
              const docs = [...store.entries()]
                .filter(([, v]) => v[field] === value)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .filter(([id]) => q.after === null || id > q.after)
                .slice(0, q.limit)
                .map(([id, v]) => ({ id, data: () => (q.fields ? Object.fromEntries(q.fields.filter((f) => f in v).map((f) => [f, v[f]])) : v) }));
              return { docs, size: docs.length, empty: docs.length === 0 };
            },
          };
          return chain;
        },
      };
    },
    batch() {
      const ops: Array<{ col: string; id: string; data: Record<string, unknown> }> = [];
      return {
        set(ref: { _col: string; _id: string }, data: Record<string, unknown>) { ops.push({ col: ref._col, id: ref._id, data }); },
        commit: async () => { for (const o of ops) getCol(o.col).set(o.id, o.data); },
      };
    },
  } as never;
}

const cache = {} as never;
const HUMAN = 'user_frank';
const HUMAN_ADDR = `0x${'b'.repeat(40)}`;
const MAIN_ADDR = `0x${'a'.repeat(40)}`;   // the issuing agent (issued the fleet code)
const SCOUT_ADDR = `0x${'c'.repeat(40)}`;  // the agent a fleet code linked
const STRANGER_ADDR = `0x${'d'.repeat(40)}`;

/** Both fleet agents are linked to the same human — exactly what a fleet-code link writes. */
const fleetRows = {
  agent_wallets: [
    { __id: 'wallet_aw_main', agent_id: 'atlas', address: MAIN_ADDR, linked_human_user_id: HUMAN },
    { __id: 'wallet_aw_scout', agent_id: 'scout', address: SCOUT_ADDR, linked_human_user_id: HUMAN },
    { __id: 'wallet_aw_stranger', agent_id: 'stranger', address: STRANGER_ADDR, linked_human_user_id: null },
  ],
};
const linkedToFrank = async (): Promise<BeneficiaryCacheEntry> => ({
  linked: true, humanWalletId: 'wallet_frank', humanUserId: HUMAN, humanAddress: HUMAN_ADDR, agentShareBps: 2000 as never,
});

const WITNESS: SealedWitness = { identity: 'scout_daemon', tier: 'software' };
const origin = (id: string): InputOrigin => ({ hash: `sha256:${id}`, origin_identifier: id, witnessed: true });
const params = (signer: string, address: string, originId: string) => ({
  economicActorId: signer, walletAddress: address, peId: `pe_${signer}_1`, nowMs: 1000,
  submissionWitness: WITNESS, witnessObservedTokens: null, bodyDeclaredTokens: null,
  inputOrigins: [origin(originId)],
});

describe('fleet agents linked to one human are one party for independence ', () => {
  it('each fleet agent\'s identity set contains the other (both directions) and the human', async () => {
    const db = fakeDb(fleetRows);
    const scoutSet = await resolveSignerIdentitySet(db, cache, { economicActorId: 'scout', walletAddress: SCOUT_ADDR }, linkedToFrank);
    const mainSet = await resolveSignerIdentitySet(db, cache, { economicActorId: 'atlas', walletAddress: MAIN_ADDR }, linkedToFrank);
    expect(scoutSet.unresolvable).toBe(false);
    expect(scoutSet.identities.has(`evm:${MAIN_ADDR}`)).toBe(true);
    expect(scoutSet.identities.has('signer:atlas')).toBe(true);
    expect(mainSet.identities.has(`evm:${SCOUT_ADDR}`)).toBe(true);
    expect(mainSet.identities.has('signer:scout')).toBe(true);
    expect(scoutSet.identities.has(`evm:${HUMAN_ADDR}`)).toBe(true);
    // RED control: the unlinked stranger is not in either set.
    expect(scoutSet.identities.has(`evm:${STRANGER_ADDR}`)).toBe(false);
    expect(mainSet.identities.has(`evm:${STRANGER_ADDR}`)).toBe(false);
  });

  it('a sibling-owned origin is same_party and adds ZERO lift; RED: the same origin from a stranger adds lift', async () => {
    const sibling = await resolveOriginPricingInputs(fakeDb(fleetRows), cache, params('scout', SCOUT_ADDR, `evm:${MAIN_ADDR}`), linkedToFrank);
    expect(sibling.origins).toHaveLength(1);
    expect(sibling.origins[0].reason).toBe('same_party');
    expect(sibling.origins[0].counted).toBe(false);
    expect(sibling.independentOriginCount).toBe(0);

    const reverse = await resolveOriginPricingInputs(fakeDb(fleetRows), cache, params('atlas', MAIN_ADDR, `evm:${SCOUT_ADDR}`), linkedToFrank);
    expect(reverse.independentOriginCount).toBe(0);
    expect(reverse.origins[0].reason).toBe('same_party');

    // RED control: identical shape, witnessed, but the owner is an unlinked stranger → counted.
    const stranger = await resolveOriginPricingInputs(fakeDb(fleetRows), cache, params('scout', SCOUT_ADDR, `evm:${STRANGER_ADDR}`), linkedToFrank);
    expect(stranger.independentOriginCount).toBe(1);
    expect(stranger.origins[0].counted).toBe(true);
  });
});
