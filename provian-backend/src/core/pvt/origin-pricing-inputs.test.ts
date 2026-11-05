/**
 * origin-pricing-inputs (, Prompt 3). The mint-time orchestrator: identity set + owner resolver
 * + relay-authoritative witnessing + closed-loop detector + graph recorder, folded into the two
 * pricing inputs. Every counting branch has a RED control that must add ZERO. The empty-origin case
 * is proven byte-identical to today (count 0, no edges).
 */

import { resolveOriginPricingInputs } from './origin-pricing-inputs';
import {
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeWalletAddressIndexId,
  CANONICAL_NATIVE_ADDRESS_INDEX_SCHEMA,
} from './native-wallet-registration';
import { ORIGIN_REFERENCE_GRAPH_COLLECTION } from './origin-reference-graph';
import type { BeneficiaryCacheEntry } from './beneficiary';
import type { InputOrigin } from '../provenance/input-origins';
import type { SealedWitness } from './origin-independence';

// ---- fake Firestore -------------------------------------------------------
type Doc = Record<string, unknown> & { __id?: string };

function fakeDb(seed: Record<string, Doc[]> = {}) {
  const cols = new Map<string, Map<string, Record<string, unknown>>>();
  const getCol = (name: string) => {
    let m = cols.get(name);
    if (!m) { m = new Map(); cols.set(name, m); }
    return m;
  };
  for (const [name, docs] of Object.entries(seed)) {
    const m = getCol(name);
    let auto = 0;
    for (const d of docs) {
      const { __id, ...rest } = d;
      m.set(__id ?? `auto_${auto++}`, rest);
    }
  }
  return {
    _cols: cols,
    collection(name: string) {
      const store = getCol(name);
      return {
        doc(id: string) {
          return {
            _col: name, _id: id,
            get: async () => ({ exists: store.has(id), data: () => store.get(id) }),
          };
        },
        where(field: string, _op: string, value: unknown) {
          // Supports the paged, projected out-edge read (orderBy(documentId) / select / limit / startAfter).
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
        set(ref: { _col: string; _id: string }, data: Record<string, unknown>) {
          ops.push({ col: ref._col, id: ref._id, data });
        },
        commit: async () => { for (const o of ops) getCol(o.col).set(o.id, o.data); },
      };
    },
  } as never;
}

const cache = {} as never;
const UNLINKED: BeneficiaryCacheEntry = {
  linked: false, humanWalletId: null, humanUserId: null, humanAddress: null, agentShareBps: null,
};
const unlinkedBeneficiary = async (): Promise<BeneficiaryCacheEntry> => UNLINKED;

const addr = (c: string) => `0x${c.repeat(40)}`;
const SELF = addr('1');
const BOB = addr('b');
const AA = addr('a');
const BB = addr('c'); // second ring member's address (distinct from BOB)

const origin = (id: string, witnessed = true): InputOrigin => ({
  hash: `sha256:${id}`, origin_identifier: id, witnessed,
});

const nativeRow = (address: string, agentId: string): Doc => ({
  __id: nativeWalletAddressIndexId(address),
  schema_version: CANONICAL_NATIVE_ADDRESS_INDEX_SCHEMA,
  chain_id: 8453, address, wallet_id: `wallet_aw_${agentId}`,
  owner_type: 'agent', owner_id: agentId, created_at_ms: 1,
});

const WITNESS: SealedWitness = { identity: 'atlas_daemon', tier: 'software' };

const base = {
  economicActorId: 'atlas', walletAddress: null as string | null, peId: 'pe_1', nowMs: 1000,
  submissionWitness: WITNESS as SealedWitness | null,
  witnessObservedTokens: null as number | null, bodyDeclaredTokens: null as number | null,
};

describe('resolveOriginPricingInputs — integration', () => {
  it('COUNTS a witnessed, external, independent origin and records its edge', async () => {
    const db = fakeDb();
    const r = await resolveOriginPricingInputs(db, cache, {
      ...base, inputOrigins: [origin(`evm:${BOB}`)],
    }, unlinkedBeneficiary);
    expect(r.independentOriginCount).toBe(1);
    expect(r.origins[0].counted).toBe(true);
    expect(r.origins[0].owner).toBe(`evm:${BOB}`);
    expect(r.edgesRecorded).toBe(1);
    expect((db as unknown as { _cols: Map<string, Map<string, unknown>> })
      ._cols.get(ORIGIN_REFERENCE_GRAPH_COLLECTION)!.size).toBe(1);
  });

  it('DEDUPES: three origins owned by one external party count once (three edges recorded)', async () => {
    const db = fakeDb();
    const r = await resolveOriginPricingInputs(db, cache, {
      ...base,
      inputOrigins: [origin('domain:sub1.lab.com'), origin('domain:sub2.lab.com'), origin('domain:lab.com')],
    }, unlinkedBeneficiary);
    expect(r.independentOriginCount).toBe(1);       // all reduce to registrable domain lab.com
    expect(r.edgesRecorded).toBe(3);                // but every edge is still recorded
  });

  // RED: no non-actor witness for the submission -> nothing witnessed -> zero, however the body reads.
  it('RED — no submission witness -> count 0 (body witnessed:true ignored)', async () => {
    const db = fakeDb();
    const r = await resolveOriginPricingInputs(db, cache, {
      ...base, submissionWitness: null, inputOrigins: [origin(`evm:${BOB}`, true)],
    }, unlinkedBeneficiary);
    expect(r.independentOriginCount).toBe(0);
    expect(r.origins[0].reason).toBe('unwitnessed');
    expect(r.origins[0].witnessed).toBe(false);
    expect(r.edgesRecorded).toBe(1); // still recorded as an (unwitnessed) edge
  });

  // RED: the origin owner IS the signer (its own native address) -> same party -> zero.
  it('RED — an origin owned by the signer itself is same-party -> count 0', async () => {
    const db = fakeDb();
    const r = await resolveOriginPricingInputs(db, cache, {
      ...base, walletAddress: SELF, inputOrigins: [origin(`evm:${SELF}`)],
    }, unlinkedBeneficiary);
    expect(r.independentOriginCount).toBe(0);
    expect(r.origins[0].reason).toBe('same_party');
  });

  // RED: a closed ring (A cites B, B cites A) -> B demoted to closed_loop -> zero.
  it('RED — a closed citation ring demotes the cited owner (count 0)', async () => {
    const db = fakeDb({
      [NATIVE_WALLET_ADDRESS_INDEX_COLLECTION]: [nativeRow(AA, 'atlas'), nativeRow(BB, 'sibling')],
      // Historical graph: sibling (B) already cited atlas's address (A). The current PE is atlas
      // citing B — closing the ring.
      [ORIGIN_REFERENCE_GRAPH_COLLECTION]: [
        { __id: 'edge_hist', signer: 'sibling', owner: `evm:${AA}`, counted: true },
      ],
    });
    const r = await resolveOriginPricingInputs(db, cache, {
      ...base, economicActorId: 'atlas', walletAddress: AA, inputOrigins: [origin(`evm:${BB}`)],
    }, unlinkedBeneficiary);
    expect(r.origins[0].reason).toBe('closed_loop');
    expect(r.independentOriginCount).toBe(0);
    expect(r.closedLoopUnresolvable).toBe(false);
  });

  // The SAME ring but the cited party is an EXTERNAL address (not a Provian signer) -> not a ring.
  it('a citation to an external (non-signer) address is NOT a loop -> counts', async () => {
    const db = fakeDb({
      [ORIGIN_REFERENCE_GRAPH_COLLECTION]: [
        { __id: 'e', signer: 'sibling', owner: `evm:${AA}`, counted: true },
      ],
      // BB is NOT in the native index -> external -> ownerToSigner returns null -> not a ring.
    });
    const r = await resolveOriginPricingInputs(db, cache, {
      ...base, economicActorId: 'atlas', walletAddress: AA, inputOrigins: [origin(`evm:${BB}`)],
    }, unlinkedBeneficiary);
    expect(r.independentOriginCount).toBe(1);
    expect(r.origins[0].counted).toBe(true);
  });

  // RED: identity set unresolvable (a registry read threw) -> fail-closed, every origin zero.
  it('RED — identity-set unresolvable -> count 0, reason owner_set_unresolvable', async () => {
    const db = fakeDb();
    const throwingBeneficiary = async (): Promise<BeneficiaryCacheEntry> => {
      throw new Error('registry down');
    };
    const r = await resolveOriginPricingInputs(db, cache, {
      ...base, inputOrigins: [origin(`evm:${BOB}`)],
    }, throwingBeneficiary);
    expect(r.identitySetUnresolvable).toBe(true);
    expect(r.independentOriginCount).toBe(0);
    expect(r.origins[0].reason).toBe('owner_set_unresolvable');
  });

  // Empty population : zero origins is a distinct shape, byte-identical to today.
  it('empty origins -> count 0, no observed tokens, no edges (byte-identical to today)', async () => {
    const db = fakeDb();
    const r = await resolveOriginPricingInputs(db, cache, {
      ...base, inputOrigins: [],
    }, unlinkedBeneficiary);
    expect(r.independentOriginCount).toBe(0);
    expect(r.origins).toHaveLength(0);
    expect(r.edgesRecorded).toBe(0);
  });

  it('RED: token telemetry cannot enter the independence pricing input', async () => {
    const db = fakeDb();
    const a = await resolveOriginPricingInputs(db, cache, { ...base, inputOrigins: [], witnessObservedTokens: 0, bodyDeclaredTokens: 0 }, unlinkedBeneficiary);
    const b = await resolveOriginPricingInputs(db, cache, { ...base, inputOrigins: [], witnessObservedTokens: 999999999, bodyDeclaredTokens: 999999999 }, unlinkedBeneficiary);
    expect(b).toEqual(a);
    expect(b).not.toHaveProperty('observedTokens');
  });

  it('records EVERY edge (counted + same-party) but counts only the independent one', async () => {
    const db = fakeDb();
    const r = await resolveOriginPricingInputs(db, cache, {
      ...base, walletAddress: SELF,
      inputOrigins: [origin(`evm:${BOB}`), origin(`evm:${SELF}`)], // one external, one self
    }, unlinkedBeneficiary);
    expect(r.independentOriginCount).toBe(1);
    expect(r.edgesRecorded).toBe(2);
  });
});
