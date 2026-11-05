/**
 * Regression tests for generatePE (Agent Bank shared PE helper).
 *
 * Guards Security Invariant #5 (append-only, hash-chained, verifiable PEs).
 *
 * The bug these tests lock down: generatePE used to hash a content object that
 * INCLUDED the five extended structural fields (compute/geo/execution_env/
 * cited_pe_ids/parent_goal_pe_id) to advance the chain tip, but stored a PE
 * whose `hash` was computed over a content object WITHOUT them. Because
 * json-stable-stringify serializes null-valued keys, the two hashes diverged
 * even when every extended field was null - so the stored PE.hash never
 * matched the value the chain tip advanced to, and prev_hash(N+1) never equaled
 * stored_hash(N). The fix builds the canonical content ONCE and reuses it for
 * both the hash and the enqueue.
 *
 * These tests exercise the REAL generatePE + REAL advanceChainTipAtomic against
 * an in-memory Firestore stub, so a future regression that desyncs the hashed
 * content from the stored content fails here.
 *
 * PE METER (2026-10-03): the relay no longer stores a readable PE. The PE it authors is staged in
 * the tip transaction as a transient intake (`meter_relay_acts_v1`) carrying the act record (pe
 * hash + prev hash) and the PE sealed to its owner; the owner opens the box. So "the stored PE"
 * these tests read is the PE the owner receives — opened here with the owner's message key.
 */
import { describe, it, expect } from '@jest/globals';
import crypto from 'crypto';
import { generatePE, type GeneratePEParams } from './pe-utils';
import type { AgentBankDeps } from './types';
import { openWithKey, fromB64u, toB64u } from '../meter/sealed-box';
import { actMatchesPe, peHashOf } from '../meter/meter-wire';
import type { RelayActIntake } from '../meter/meter-relay-authored';

interface Ref { __path: string; get(): Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }> }

class StubFirestore {
  store = new Map<string, Record<string, unknown>>();
  collection(name: string) {
    const store = this.store;
    return {
      doc: (id: string): Ref => ({
        __path: `${name}/${id}`,
        get: async () => {
          const data = store.get(`${name}/${id}`);
          return { exists: data !== undefined, data: () => data };
        },
      }),
      where: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }),
    };
  }
  async runTransaction<T>(fn: (txn: StubTxn) => Promise<T>): Promise<T> {
    return fn(new StubTxn(this.store));
  }
}

class StubTxn {
  constructor(private store: Map<string, Record<string, unknown>>) {}
  async get(ref: Ref) {
    const data = this.store.get(ref.__path);
    return { exists: data !== undefined, data: () => data };
  }
  set(ref: Ref, data: Record<string, unknown>) { this.store.set(ref.__path, data); }
  create(ref: Ref, data: Record<string, unknown>) {
    if (this.store.has(ref.__path)) throw new Error(`already exists: ${ref.__path}`);
    this.store.set(ref.__path, data);
  }
  delete(ref: Ref) { this.store.delete(ref.__path); }
}

/** The owner's message key: the relay seals the PE to its public half; the test opens it. */
function ownerKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const secret = (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).subarray(-32);
  const pub = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);
  return { secret, pub };
}

function makeDeps() {
  const db = new StubFirestore();
  const key = ownerKey();
  db.store.set('commons_message_keys/wallet_aw_1', { pubkey_b64u: toB64u(key.pub) });
  const accrualCalls: Array<Record<string, unknown>> = [];
  const deps = {
    db,
    cache: {},
    peBuffer: { enqueue: () => { throw new Error('a readable PE was enqueued'); } },
    recordPEAccrual: async (params: Record<string, unknown>) => {
      accrualCalls.push(params);
    },
  } as unknown as AgentBankDeps;
  /** Every staged intake, in commit order, with the PE its owner opens from the sealed copy. */
  const intakes = () => [...db.store.entries()]
    .filter(([k]) => k.startsWith('meter_relay_acts_v1/'))
    .map(([, v]) => {
      const intake = v as unknown as RelayActIntake;
      const own = intake.sealed.find((c) => c.to === 'agent:agent_x');
      const pe = own ? JSON.parse(openWithKey(key.secret, fromB64u(own.box)).toString('utf8')) as Record<string, unknown> : null;
      return { intake, pe };
    });
  return { db, deps, intakes, accrualCalls };
}

const TIP = (agentId: string) => `pe_chain_tips/${agentId}`;

const baseParams: GeneratePEParams = {
  walletId: 'wallet_aw_1',
  agentId: 'agent_x',
  actorAddress: '0xAGENT',
  actionType: 'escrow_created',
  metadata: { foo: 1 },
};

describe('generatePE - hash chain integrity (Invariant #5)', () => {
  it('stages a PE whose hash equals the value the chain tip advanced to (no extended fields)', async () => {
    const { db, deps, intakes } = makeDeps();

    const res = await generatePE(deps, { ...baseParams });

    const tip = db.store.get(TIP('agent_x'));
    expect(tip).toBeDefined();
    const [{ intake, pe }] = intakes();
    // The crux: the PE's hash === chain tip hash, and the owner's opened copy hashes to it.
    expect(intake.act.pe_hash).toBe(tip!.hash);
    expect(peHashOf(pe as never)).toBe(tip!.hash);
    expect(res.peHash).toBe(tip!.hash);
    // First PE on a fresh chain links to genesis.
    expect(intake.act.prev_hash).toBe('0x0000');
    expect(pe!.prev_hash).toBe('0x0000');
    expect(res.prevHash).toBe('0x0000');
    // No envelope is stored: the relay keeps the act record (exactly the wire's pricing projection
    // of the PE the owner holds — identity + pricing inputs, no free text) and the sealed box.
    expect([...db.store.keys()].some((k) => k.startsWith('provenance_envelopes/'))).toBe(false);
    expect(actMatchesPe(intake.act, pe as never)).toBe(true);
  });

  it('still matches when extended structural fields are populated, and carries them to the owner', async () => {
    const { db, deps, intakes } = makeDeps();

    await generatePE(deps, {
      ...baseParams,
      compute: { duration_ms: 5, tokens_processed: 10 },
      cited_pe_ids: ['pe_upstream_a', 'pe_upstream_b'],
      parent_goal_pe_id: 'pe_goal_1',
    });

    const tip = db.store.get(TIP('agent_x'));
    const [{ intake, pe }] = intakes();
    expect(intake.act.pe_hash).toBe(tip!.hash);
    expect(peHashOf(pe as never)).toBe(tip!.hash);
    expect(pe!.cited_pe_ids).toEqual(['pe_upstream_a', 'pe_upstream_b']);
    expect(pe!.parent_goal_pe_id).toBe('pe_goal_1');
    expect(pe!.compute).toEqual({ duration_ms: 5, tokens_processed: 10 });
    expect(pe!.metadata).toEqual({ foo: 1 });
  });

  it('links consecutive PEs: prev_hash(N+1) === hash(N)', async () => {
    const { db, deps, intakes } = makeDeps();

    await generatePE(deps, { ...baseParams, actionType: 'escrow_created' });
    const firstHash = intakes()[0].intake.act.pe_hash;
    const tipAfterFirst = (db.store.get(TIP('agent_x')) as Record<string, unknown>).hash as string;

    await generatePE(deps, { ...baseParams, actionType: 'escrow_funded' });

    const all = intakes();
    expect(all).toHaveLength(2);
    expect(all[1].intake.act.prev_hash).toBe(firstHash);
    expect(all[1].intake.act.prev_hash).toBe(tipAfterFirst);
    const tipAfterSecond = (db.store.get(TIP('agent_x')) as Record<string, unknown>).hash as string;
    expect(all[1].intake.act.pe_hash).toBe(tipAfterSecond);
  });

  it('RED control: an owner with no published message key gets no copy (never a readable fallback)', async () => {
    const { db, deps, intakes } = makeDeps();
    db.store.delete('commons_message_keys/wallet_aw_1');
    await generatePE(deps, { ...baseParams });
    const [{ intake, pe }] = intakes();
    expect(intake.sealed).toEqual([]);
    expect(pe).toBeNull();
  });
});

describe('generatePE - accrual forwarding', () => {
  it('forwards cited_pe_ids / parent_goal_pe_id to recordPEAccrual', async () => {
    const { deps, accrualCalls } = makeDeps();

    await generatePE(deps, {
      ...baseParams,
      cited_pe_ids: ['pe_a'],
      parent_goal_pe_id: 'pe_g',
    });

    expect(accrualCalls).toHaveLength(1);
    expect(accrualCalls[0].citedPeIds).toEqual(['pe_a']);
    expect(accrualCalls[0].parentGoalPeId).toBe('pe_g');
  });

  it('accrues under accrualActionType when provided, keeping the PE action_type distinct', async () => {
    const { deps, intakes, accrualCalls } = makeDeps();

    await generatePE(deps, {
      ...baseParams,
      actionType: 'agent_wallet_created',
      accrualActionType: 'wallet_created',
    });

    // The PE records its own action_type...
    expect(intakes()[0].pe!.action_type).toBe('agent_wallet_created');
    expect(intakes()[0].intake.act.action_type).toBe('agent_wallet_created');
    // ...but accrual uses the override (so the device setup rate limit applies).
    expect(accrualCalls[0].actionType).toBe('wallet_created');
  });

  it('defaults accrual action type to the PE action type when no override is given', async () => {
    const { deps, accrualCalls } = makeDeps();
    await generatePE(deps, { ...baseParams, actionType: 'escrow_created' });
    expect(accrualCalls[0].actionType).toBe('escrow_created');
  });
});

/**
 * the sealed canonical event identity.
 *
 * `economicCanonicalEventId` is what a later resolution must match
 * (`monetary-accounting.ts:1146`) and the key any per-event exactly-once rule is
 * written against. Until the key order ranked `tx_hash` FIRST and
 * `canonical_event_id` LAST, so an emitter supplying both sealed the
 * transaction hash and threw away the exact identity it had computed.
 *
 * These are the PERMANENT controls for that ordering, not a one-shot probe
 * someone ran by hand. The third is the one that matters: it constructs the
 * real collision (two canonical events in ONE transaction) and asserts the two
 * sealed ids differ. the pre- order it fails, because both sealed
 * the same tx hash.
 *
 * They drive the REAL `generatePE` and read the REAL argument handed to
 * `deps.recordPEAccrual`, which `pvt-accrual.ts:932` takes verbatim as the
 * snapshot's `canonicalEventId` so this asserts the production value, not a
 * restatement of the key list.
 */
describe('generatePE - sealed canonical event identity ', () => {
  const TX = '0xaaaabbbbccccddddeeeeffff00001111222233334444555566667777888899990';
  const EVENT_AT_LOG_7 = `8453:${TX}:7`;
  const EVENT_AT_LOG_12 = `8453:${TX}:12`;

  const verifiedFunding = (metadata: Record<string, unknown>): GeneratePEParams => ({
    ...baseParams,
    actionType: 'promise_funded',
    metadata: { verified: true, ...metadata },
  });

  it('seals the EXPLICIT canonical_event_id, not the tx hash, when both are present', async () => {
    const { deps, accrualCalls } = makeDeps();

    await generatePE(deps, verifiedFunding({
      tx_hash: TX,
      canonical_event_id: EVENT_AT_LOG_7,
    }));

    expect(accrualCalls[0].economicCanonicalEventId).toBe(EVENT_AT_LOG_7);
    // Stated as a refusal too, so a future reorder cannot pass by coincidence.
    expect(accrualCalls[0].economicCanonicalEventId).not.toBe(TX);
    expect(accrualCalls[0].economicEvidenceState).toBe('verified');
  });

  it('two canonical events in ONE transaction seal DISTINCT ids', async () => {
    const { deps, accrualCalls } = makeDeps();

    // One lender batch-funding two promises in a single transaction: same tx
    // hash, different log index. This is the shape that makes a tx hash an
    // unusable exactly-once key.
    await generatePE(deps, verifiedFunding({
      tx_hash: TX,
      canonical_event_id: EVENT_AT_LOG_7,
    }));
    await generatePE(deps, verifiedFunding({
      tx_hash: TX,
      canonical_event_id: EVENT_AT_LOG_12,
    }));

    const [first, second] = accrualCalls;
    expect(first.economicCanonicalEventId).toBe(EVENT_AT_LOG_7);
    expect(second.economicCanonicalEventId).toBe(EVENT_AT_LOG_12);
    // The property, stated directly: one transaction, two identities.
    expect(first.economicCanonicalEventId).not.toBe(second.economicCanonicalEventId);
  });

  it('still falls back to the tx hash when no canonical_event_id is supplied', async () => {
    // The many emitters with no finer identity — both USDC watchers, the
    // transfer-record route — must be unaffected by the reorder. This is the
    // no-op half of the change and is asserted, not assumed.
    const { deps, accrualCalls } = makeDeps();

    await generatePE(deps, verifiedFunding({ tx_hash: TX }));

    expect(accrualCalls[0].economicCanonicalEventId).toBe(TX);
  });

  it('seals nothing without the verified stamp, even with a canonical event id', async () => {
    const { deps, accrualCalls } = makeDeps();

    await generatePE(deps, {
      ...baseParams,
      actionType: 'promise_funded',
      metadata: { tx_hash: TX, canonical_event_id: EVENT_AT_LOG_7 },
    });

    expect(accrualCalls[0].economicCanonicalEventId).toBeNull();
    expect(accrualCalls[0].economicEvidenceState).toBeUndefined();
  });

  it('ignores a blank canonical_event_id rather than sealing whitespace', async () => {
    const { deps, accrualCalls } = makeDeps();

    await generatePE(deps, verifiedFunding({
      tx_hash: TX,
      canonical_event_id: '   ',
    }));

    // A present-but-empty explicit id must not shadow the usable fallback, or
    // an emitter bug would silently seal nothing on a canonical-event-required
    // type and park the row in pending_evidence forever.
    expect(accrualCalls[0].economicCanonicalEventId).toBe(TX);
  });
});
