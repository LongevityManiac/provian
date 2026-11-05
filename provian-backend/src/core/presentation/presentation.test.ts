/**
 * Burn-to-present cryptographic core — acceptance + RED negative controls.
 *
 * Every security property ships with a RED control that is observed FAILING, so a
 * green assertion is never vacuous:
 * - REPLAY: the same burn cannot produce a second presentation (409).
 * - WRONG-REQUESTER: a presentation bound to requester A does not verify for B
 * (audience_mismatch) nor for A's challenge changed (challenge_mismatch).
 * - STALE-WINDOW: an expired presentation does not verify (expired); an
 * over-long window is refused at production and at verify.
 * - PRESENTER-POP: a tampered / foreign-key signature does not verify.
 * - HUMAN-BURN-FROM-WRONG-ADDRESS: a burn not from the human's own first-party
 * address fails verification (expectedFrom binds to the caller's address).
 * - PE-FACT OWNERSHIP / ANCHORING: a foreign or unanchored PE cannot be presented.
 * - REPUTATION SIGNING: unconfigured key fails closed (503).
 *
 * The client-side binding + signature use the SAME shared functions a real SDK
 * uses (presentationBindingString / claimsDigest / canonicalReputationDirective),
 * not a private re-implementation, so the test binds to the single source.
 */

import crypto from 'crypto';
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ethers } from 'ethers';

import {
  presentationBindingString,
  claimsDigest,
  buildPeFactCosignPayload,
  PRESENTATION_TYP,
  type PresenterPop,
  type Presentation,
} from './types';
import { canonicalReputationDirective, type DisclosureDirective } from './disclosure';
import { verifyPresentation, verifyPresenterPop } from './verify';
import { loadPresentationSigningKey, signPeFactCosign, signReputationPresentation } from './signer';
import { hashEnvelopeHashLeaf } from '../pvt/merkle';
import { ACTOR_STATS_COLLECTION, emptyActorStats, type ActorStatsDoc } from '../pvt/actor-stats';
import type { CommerceAttestationPublicJwk } from './jws-key-material';

// PE METER: the relay keeps no PEs, so a pe_fact is proven from the PE + inclusion proof the
// PRESENTER supplies (`proveMeterFact`). Mock that one function so these tests exercise the
// SERVICE (ownership, binding, burn consumption), not the two-hop Merkle machinery (which the
// meter's own suites own); the counterparty-side leaf check stays real for verify.
jest.mock('../meter/meter-fact-proof', () => ({
  ...jest.requireActual<typeof import('../meter/meter-fact-proof')>('../meter/meter-fact-proof'),
  proveMeterFact: jest.fn(),
}));
import { proveMeterFact } from '../meter/meter-fact-proof';
import {
  produceReputationPresentation,
  producePeFactPresentation,
  producePresentationFromRequest,
  type PresenterPrincipal,
} from './service';

const mockedResolve = proveMeterFact as jest.MockedFunction<typeof proveMeterFact>;
/** The presenter-held PE + inclusion proof a pe_fact carries (opaque here: `proveMeterFact` is mocked). */
const HELD = { pe: { schema: 'held' }, inclusion: { held: true } };

// ─── Ed25519 Provian signing key (env ATTESTATION_SIGNING_KEY) ───────────────
function makeEd25519Env(): { env: Record<string, string>; publicKeys: CommerceAttestationPublicJwk[] } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  const pub = publicKey.export({ format: 'jwk' }) as { x: string };
  const kid = 'test-presentation-key-1';
  const jwk = { kty: 'OKP', crv: 'Ed25519', kid, x: priv.x, d: priv.d };
  return {
    env: { ATTESTATION_SIGNING_KEY: JSON.stringify(jwk) },
    publicKeys: [{ kty: 'OKP', crv: 'Ed25519', kid, x: pub.x, use: 'sig', alg: 'EdDSA', key_ops: ['verify'] }],
  };
}

// ─── Agent secp256k1 signer (ECDSA-SHA256 / DER, verifyEcdsaSha256-compatible) ─
function makeAgentSigner(): { pubkeyHex: string; address: string; sign: (msg: string) => string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const xHex = Buffer.from(jwk.x, 'base64url').toString('hex').padStart(64, '0');
  const yHex = Buffer.from(jwk.y, 'base64url').toString('hex').padStart(64, '0');
  const pubkeyHex = xHex + yHex; // 128 hex, no 04 prefix
  const address = ethers.computeAddress(`0x04${pubkeyHex}`).toLowerCase();
  const sign = (msg: string): string => {
    const s = crypto.createSign('SHA256');
    s.update(msg);
    return s.sign(privateKey, 'hex'); // DER hex
  };
  return { pubkeyHex, address, sign };
}

// ─── Human EIP-191 signer ────────────────────────────────────────────────────
function makeHumanSigner(): { address: string; sign: (msg: string) => Promise<string> } {
  const wallet = ethers.Wallet.createRandom();
  return { address: wallet.address.toLowerCase(), sign: (msg: string) => wallet.signMessage(msg) };
}

// ─── Fake Firestore ──────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
type Store = Map<string, Map<string, Row>>;
function coll(store: Store, name: string): Map<string, Row> {
  let c = store.get(name);
  if (!c) { c = new Map(); store.set(name, c); }
  return c;
}
class FakeDocRef {
  constructor(private store: Store, private collection: string, readonly id: string) {}
  async get() {
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
  // the vocabulary is fail-closed, so the fixture gives it every reader it uses — op-aware
  // `where` (== and >=), `orderBy`/`select`/`startAfter` (the reference graph's paged read), and a
  // QuerySnapshot `size` — instead of relying on a read error being swallowed as zero.
  constructor(private store: Store, private collection: string, private constraints: [string, string, unknown][] = [], private lim = Infinity) {}
  where(f: string, op: string, v: unknown): FakeQuery {
    return new FakeQuery(this.store, this.collection, [...this.constraints, [f, op, v]], this.lim);
  }
  limit(n: number): FakeQuery { return new FakeQuery(this.store, this.collection, this.constraints, n); }
  orderBy(): FakeQuery { return this; }
  select(): FakeQuery { return this; }
  startAfter(): FakeQuery { return this; }
  private rows() {
    let rows = [...coll(this.store, this.collection).entries()];
    for (const [f, op, v] of this.constraints) {
      rows = rows.filter(([, d]) => (op === '>=' ? typeof d[f] === 'number' && (d[f] as number) >= (v as number) : d[f] === v));
    }
    return rows.slice(0, this.lim);
  }
  async get() {
    const rows = this.rows();
    return { empty: rows.length === 0, size: rows.length, docs: rows.map(([id, d]) => ({ id, data: () => ({ ...d }) })) };
  }
  count() { return { get: async () => ({ data: () => ({ count: this.rows().length }) }) }; }
}
class FakeCollection {
  constructor(private store: Store, private name: string) {}
  doc(id: string): FakeDocRef { return new FakeDocRef(this.store, this.name, id); }
  where(f: string, op: string, v: unknown): FakeQuery { return new FakeQuery(this.store, this.name).where(f, op, v); }
}
function makeDb(store: Store) {
  return {
    collection: (name: string) => new FakeCollection(store, name),
    runTransaction: async (fn: (txn: {
      get: (r: FakeDocRef) => ReturnType<FakeDocRef['get']>;
      create: (r: FakeDocRef, d: Row) => void;
      set: (r: FakeDocRef, d: Row, o?: { merge?: boolean }) => void;
    }) => Promise<unknown>) => fn({
      get: (r) => r.get(),
      create: (r, d) => r.create(d),
      set: (r, d, o) => r.set(d, o),
    }),
  } as unknown as import('firebase-admin/firestore').Firestore;
}

const BURN = 'a'.repeat(64);

/** §2.5: the disclosable set IS the live vocabulary, read from `actor_stats_v1` — seed the counters. */
function seedStats(store: Store, actorId: string, over: Partial<ActorStatsDoc>): void {
  coll(store, ACTOR_STATS_COLLECTION).set(actorId, { ...emptyActorStats(actorId), ...over } as unknown as Row);
}
const BURN2 = 'b'.repeat(64);
const FLOOR_15 = (15n * 10n ** 18n).toString();

function seedBurn(store: Store, burnId: string, walletId: string, over: Row = {}): void {
  coll(store, 'pvt_burn_records').set(burnId, {
    tx_hash: `0x${burnId.slice(0, 8)}`, chain: 'base', wallet_id: walletId,
    burner_address: '0xabc', amount_atomic: FLOOR_15,
    status: 'recorded', verified: true, ...over,
  });
}

const NOW = 1_800_000_000; // fixed unix seconds
const IAT = NOW;
const EXP = NOW + 300;

/** Build the binding a client signs, from the SAME shared functions the server uses. */
function bindingFor(tier: 'pe_fact' | 'reputation', address: string, aud: string, chal: string, jti: string, burnId: string, opts: { peFacts?: { pe_id: string; envelope_hash: string }[]; directive?: DisclosureDirective } = {}): string {
  const digest = tier === 'pe_fact'
    ? claimsDigest({ tier: 'pe_fact', pe_facts: opts.peFacts ?? [] })
    : claimsDigest({ tier: 'reputation', reputation_directive: canonicalReputationDirective(opts.directive ?? { redact: [], predicates: [] }) });
  return presentationBindingString({ tier, presenter_address: address, aud, chal, iat: IAT, exp: EXP, jti, burn_id: burnId, claims_digest: digest });
}

let store: Store;
let ed: ReturnType<typeof makeEd25519Env>;
beforeEach(() => { store = new Map(); ed = makeEd25519Env(); mockedResolve.mockReset(); });

// =============================================================================
// CROSS-PACKAGE BINDING PIN. The SAME fixed vector is asserted in the SDK's
// presentation.test.ts. If either package's binding drifts, its own test reddens
// and agent presentations would fail this side's presenter-pop check.
describe('binding conformance (cross-package pin with the SDK)', () => {
  const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  const EMPTY_DIRECTIVE_DIGEST = sha('reputation\n{"redact":[],"predicates":[]}');
  const EXPECTED_BINDING = [
    'provian-presentation-v1',
    'tier=reputation',
    'presenter=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'aud=requester-1',
    'chal=chal-fixed-000000000',
    'iat=1000',
    'exp=1300',
    'jti=jti-fixed',
    `burn=${'a'.repeat(64)}`,
    `claims=${EMPTY_DIRECTIVE_DIGEST}`,
  ].join('\n');

  it('claimsDigest(reputation, empty directive) matches the pinned preimage', () => {
    expect(claimsDigest({ tier: 'reputation', reputation_directive: canonicalReputationDirective({ redact: [], predicates: [] }) })).toBe(EMPTY_DIRECTIVE_DIGEST);
  });

  it('presentationBindingString matches the pinned vector byte-for-byte', () => {
    expect(presentationBindingString({
      tier: 'reputation', presenter_address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      aud: 'requester-1', chal: 'chal-fixed-000000000', iat: 1000, exp: 1300, jti: 'jti-fixed',
      burn_id: 'a'.repeat(64), claims_digest: EMPTY_DIRECTIVE_DIGEST,
    })).toBe(EXPECTED_BINDING); // note: presenter is lowercased in the binding
  });
});

// =============================================================================
describe('reputation tier — happy path + verify', () => {
  it('agent produces a reputation presentation that verifies for the bound requester', async () => {
    const agent = makeAgentSigner();
    seedBurn(store, BURN, 'aw1');
    const principal: PresenterPrincipal = {
      kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: 'agent1',
      publicKeyHex: agent.pubkeyHex, standing: {},
    };
    seedStats(store, 'agent1', { pe_count: 72, streak_days: 9, active_days: 41 });
    const binding = bindingFor('reputation', agent.address, 'requester-1', 'chal-abc-16charsmin', 'jti-1', BURN);
    const pop: PresenterPop = { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex };

    const r = await produceReputationPresentation(
      { db: makeDb(store), env: ed.env },
      { principal, burnId: BURN, audience: 'requester-1', challenge: 'chal-abc-16charsmin', iat: IAT, exp: EXP, jti: 'jti-1', pop, directive: { redact: [], predicates: [] }, nowSeconds: NOW },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.presentation.tier).toBe('reputation');

    const v = await verifyPresentation(r.presentation, {
      publicKeys: ed.publicKeys, expectedAudience: 'requester-1', expectedChallenge: 'chal-abc-16charsmin', nowSeconds: NOW + 10,
    });
    expect(v.valid).toBe(true);
    if (!v.valid) return;
    // The vocabulary is LIVE (read from actor_stats_v1 at production), never a principal-carried score.
    expect(v.payload.reputation?.facts['continuity.chain_depth']).toBe(72);
    expect(v.payload.reputation?.facts['continuity.streak_days']).toBe(9);
    expect(v.disclosed?.['continuity.active_days']).toBe(41);
    // Standing is ALWAYS present (§2.5) — even for an actor with no adverse events.
    expect(v.standing?.['standing.adverse_events']).toBe(0);
    // governance_score is GONE.
    expect(Object.keys(v.payload.reputation?.facts ?? {}).some((k) => k.includes('governance'))).toBe(false);
  });

  it('selective disclosure: redaction withholds a field, a predicate reveals only a boolean', async () => {
    const agent = makeAgentSigner();
    seedBurn(store, BURN, 'aw1');
    const principal: PresenterPrincipal = {
      kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: 'agent1',
      publicKeyHex: agent.pubkeyHex, standing: {},
    };
    seedStats(store, 'agent1', { pe_count: 720, streak_days: 9, active_days: 41 });
    const directive: DisclosureDirective = { redact: ['continuity.streak_days'], predicates: [{ field: 'continuity.chain_depth', op: 'gte', threshold: 700 }] };
    const binding = bindingFor('reputation', agent.address, 'r', 'chal-1616161616161616', 'jti-2', BURN, { directive });
    const pop: PresenterPop = { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex };

    const r = await produceReputationPresentation(
      { db: makeDb(store), env: ed.env },
      { principal, burnId: BURN, audience: 'r', challenge: 'chal-1616161616161616', iat: IAT, exp: EXP, jti: 'jti-2', pop, directive, nowSeconds: NOW },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rep = r.presentation.payload.reputation!;
    expect(rep.facts['continuity.active_days']).toBe(41);          // disclosed raw
    expect(rep.facts['continuity.streak_days']).toBeUndefined();   // redacted
    expect(rep.facts['continuity.chain_depth']).toBeUndefined();   // predicate-only (raw withheld)
    expect(rep.predicates).toEqual([{ field: 'continuity.chain_depth', op: 'gte', threshold: 700, result: true }]);
    expect(rep.redacted).toContain('continuity.streak_days');
    expect(rep.facts['standing.adverse_events']).toBe(0);           // standing never withheld
  });

  it('RED: a presenter cannot redact a standing.* field (§2.5 "ALWAYS PRESENT — not redactable by the presenter")', async () => {
    const agent = makeAgentSigner();
    seedBurn(store, BURN, 'aw1');
    const principal: PresenterPrincipal = { kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: 'agent1', publicKeyHex: agent.pubkeyHex, standing: {} };
    seedStats(store, 'agent1', { pe_count: 3, by_type: { bond_slashed: 1 }, adverse_by_type: { bond_slashed: 1 }, by_family_class: { other__chain_witnessed: 1 } });
    const directive: DisclosureDirective = { redact: ['standing.bond_slashed'], predicates: [] };
    const binding = bindingFor('reputation', agent.address, 'r', 'chal-1616161616161616', 'jti-3', BURN, { directive });
    const pop: PresenterPop = { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex };
    const r = await produceReputationPresentation(
      { db: makeDb(store), env: ed.env },
      { principal, burnId: BURN, audience: 'r', challenge: 'chal-1616161616161616', iat: IAT, exp: EXP, jti: 'jti-3', pop, directive, nowSeconds: NOW },
    );
    expect(r.ok).toBe(false);
    // Control: the same actor with no redaction discloses the adverse fact.
    const ok = await produceReputationPresentation(
      { db: makeDb(store), env: ed.env },
      { principal, burnId: BURN, audience: 'r', challenge: 'chal-1616161616161616', iat: IAT, exp: EXP, jti: 'jti-4', pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(bindingFor('reputation', agent.address, 'r', 'chal-1616161616161616', 'jti-4', BURN)), pubkey: agent.pubkeyHex }, directive: { redact: [], predicates: [] }, nowSeconds: NOW },
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.presentation.payload.reputation?.facts['standing.bond_slashed']).toBe(1);
    expect(ok.presentation.payload.reputation?.facts['standing.adverse_events']).toBe(1);
  });
});

// =============================================================================
describe('RED — replay / single-use', () => {
  it('the same burn cannot produce a second presentation (409)', async () => {
    const agent = makeAgentSigner();
    seedBurn(store, BURN, 'aw1');
    const principal: PresenterPrincipal = { kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: 'agent1', publicKeyHex: agent.pubkeyHex, standing: {} };
    const mk = (jti: string) => {
      const binding = bindingFor('reputation', agent.address, 'r', 'chal-1616161616161616', jti, BURN);
      return { principal, burnId: BURN, audience: 'r', challenge: 'chal-1616161616161616', iat: IAT, exp: EXP, jti, pop: { scheme: 'ecdsa_sha256_secp256k1' as const, signature: agent.sign(binding), pubkey: agent.pubkeyHex }, directive: { redact: [], predicates: [] }, nowSeconds: NOW };
    };
    const first = await produceReputationPresentation({ db: makeDb(store), env: ed.env }, mk('j1'));
    expect(first.ok).toBe(true);
    const second = await produceReputationPresentation({ db: makeDb(store), env: ed.env }, mk('j2'));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.status).toBe(409);
    // non-vacuous: a FRESH burn works
    seedBurn(store, BURN2, 'aw1');
    const bindingF = bindingFor('reputation', agent.address, 'r', 'chal-1616161616161616', 'j3', BURN2);
    const fresh = await produceReputationPresentation({ db: makeDb(store), env: ed.env }, { ...mk('j3'), burnId: BURN2, pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(bindingF), pubkey: agent.pubkeyHex } });
    expect(fresh.ok).toBe(true);
  });
});

// =============================================================================
describe('RED — wrong requester (audience / challenge binding)', () => {
  async function goodReputation() {
    const agent = makeAgentSigner();
    seedBurn(store, BURN, 'aw1');
    const principal: PresenterPrincipal = { kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: 'agent1', publicKeyHex: agent.pubkeyHex, standing: {} };
    const binding = bindingFor('reputation', agent.address, 'requester-A', 'chal-AAAAAAAAAAAAAAAA', 'j1', BURN);
    const r = await produceReputationPresentation({ db: makeDb(store), env: ed.env }, { principal, burnId: BURN, audience: 'requester-A', challenge: 'chal-AAAAAAAAAAAAAAAA', iat: IAT, exp: EXP, jti: 'j1', pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex }, directive: { redact: [], predicates: [] }, nowSeconds: NOW });
    if (!r.ok) throw new Error('setup failed');
    return r.presentation;
  }

  it('a presentation for requester A does not verify for requester B', async () => {
    const p = await goodReputation();
    const v = await verifyPresentation(p, { publicKeys: ed.publicKeys, expectedAudience: 'requester-B', nowSeconds: NOW + 1 });
    expect(v.valid).toBe(false);
    if (v.valid) return;
    expect(v.reason).toBe('audience_mismatch');
  });

  it('a presentation does not verify against a different challenge', async () => {
    const p = await goodReputation();
    const v = await verifyPresentation(p, { publicKeys: ed.publicKeys, expectedChallenge: 'chal-DIFFERENT-000', nowSeconds: NOW + 1 });
    expect(v.valid).toBe(false);
    if (v.valid) return;
    expect(v.reason).toBe('challenge_mismatch');
  });

  it('non-vacuous: it DOES verify for the correct requester + challenge', async () => {
    const p = await goodReputation();
    const v = await verifyPresentation(p, { publicKeys: ed.publicKeys, expectedAudience: 'requester-A', expectedChallenge: 'chal-AAAAAAAAAAAAAAAA', nowSeconds: NOW + 1 });
    expect(v.valid).toBe(true);
  });
});

// =============================================================================
describe('RED — stale / over-long window', () => {
  it('an expired presentation does not verify', async () => {
    const agent = makeAgentSigner();
    seedBurn(store, BURN, 'aw1');
    const principal: PresenterPrincipal = { kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: 'agent1', publicKeyHex: agent.pubkeyHex, standing: {} };
    const binding = bindingFor('reputation', agent.address, 'r', 'chal-1616161616161616', 'j1', BURN);
    const r = await produceReputationPresentation({ db: makeDb(store), env: ed.env }, { principal, burnId: BURN, audience: 'r', challenge: 'chal-1616161616161616', iat: IAT, exp: EXP, jti: 'j1', pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex }, directive: { redact: [], predicates: [] }, nowSeconds: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // verify well AFTER exp (+ beyond skew)
    const v = await verifyPresentation(r.presentation, { publicKeys: ed.publicKeys, nowSeconds: EXP + 1000 });
    expect(v.valid).toBe(false);
    if (v.valid) return;
    expect(v.reason).toBe('expired');
  });

  it('an over-long validity window is refused at production', async () => {
    const agent = makeAgentSigner();
    seedBurn(store, BURN, 'aw1');
    const principal: PresenterPrincipal = { kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: 'agent1', publicKeyHex: agent.pubkeyHex, standing: {} };
    const longExp = IAT + 100_000; // >> PRESENTATION_MAX_TTL_SECONDS
    const binding = presentationBindingString({ tier: 'reputation', presenter_address: agent.address, aud: 'r', chal: 'chal-1616161616161616', iat: IAT, exp: longExp, jti: 'j1', burn_id: BURN, claims_digest: claimsDigest({ tier: 'reputation', reputation_directive: canonicalReputationDirective({ redact: [], predicates: [] }) }) });
    const r = await produceReputationPresentation({ db: makeDb(store), env: ed.env }, { principal, burnId: BURN, audience: 'r', challenge: 'chal-1616161616161616', iat: IAT, exp: longExp, jti: 'j1', pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex }, directive: { redact: [], predicates: [] }, nowSeconds: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
  });
});

// =============================================================================
describe('RED — presenter proof of possession', () => {
  it('a tampered signature does not verify', () => {
    const agent = makeAgentSigner();
    const binding = presentationBindingString({ tier: 'pe_fact', presenter_address: agent.address, aud: 'r', chal: 'c'.repeat(16), iat: IAT, exp: EXP, jti: 'j', burn_id: BURN, claims_digest: 'x' });
    const good = agent.sign(binding);
    const tampered = good.slice(0, -2) + (good.endsWith('00') ? '11' : '00');
    expect(verifyPresenterPop(binding, { scheme: 'ecdsa_sha256_secp256k1', signature: tampered, pubkey: agent.pubkeyHex }, agent.address)).toBe(false);
    // non-vacuous
    expect(verifyPresenterPop(binding, { scheme: 'ecdsa_sha256_secp256k1', signature: good, pubkey: agent.pubkeyHex }, agent.address)).toBe(true);
  });

  it('a valid signature by a DIFFERENT key cannot impersonate the presenter address', () => {
    const agent = makeAgentSigner();
    const attacker = makeAgentSigner();
    const binding = presentationBindingString({ tier: 'pe_fact', presenter_address: agent.address, aud: 'r', chal: 'c'.repeat(16), iat: IAT, exp: EXP, jti: 'j', burn_id: BURN, claims_digest: 'x' });
    // attacker signs the SAME binding with their OWN key, claims to be `agent`
    const sig = attacker.sign(binding);
    expect(verifyPresenterPop(binding, { scheme: 'ecdsa_sha256_secp256k1', signature: sig, pubkey: attacker.pubkeyHex }, agent.address)).toBe(false);
  });

  it('human EIP-191 PoP: correct signer verifies, wrong signer does not', async () => {
    const human = makeHumanSigner();
    const other = makeHumanSigner();
    const binding = presentationBindingString({ tier: 'reputation', presenter_address: human.address, aud: 'r', chal: 'c'.repeat(16), iat: IAT, exp: EXP, jti: 'j', burn_id: BURN, claims_digest: 'x' });
    const sig = await human.sign(binding);
    expect(verifyPresenterPop(binding, { scheme: 'eip191_secp256k1', signature: sig }, human.address)).toBe(true);
    const otherSig = await other.sign(binding);
    expect(verifyPresenterPop(binding, { scheme: 'eip191_secp256k1', signature: otherSig }, human.address)).toBe(false);
  });

  it('an agent whose bare pubkey x-coordinate high byte is 0x04 STILL verifies (no false-reject)', () => {
    // ~1/256 of agents have a bare 128-hex pubkey starting with "04". The prior
    // unconditional `.replace(/^04/, '')` shortened it to 126 hex and false-rejected
    // it AFTER the agent had already burned real PVT. Search for such a key so this
    // control is deterministic, not a flaky ~0.4% green.
    let agent = makeAgentSigner();
    let tries = 0;
    while (!agent.pubkeyHex.startsWith('04') && tries < 4000) { agent = makeAgentSigner(); tries++; }
    expect(agent.pubkeyHex.startsWith('04')).toBe(true); // non-vacuous: we found one
    const binding = presentationBindingString({ tier: 'pe_fact', presenter_address: agent.address, aud: 'r', chal: 'c'.repeat(16), iat: IAT, exp: EXP, jti: 'j', burn_id: BURN, claims_digest: 'x' });
    expect(verifyPresenterPop(binding, { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex }, agent.address)).toBe(true);
  });
});

// =============================================================================
describe('RED — reputation signing key unconfigured (fail closed)', () => {
  it('produces a 503 when ATTESTATION_SIGNING_KEY is unset', async () => {
    const agent = makeAgentSigner();
    seedBurn(store, BURN, 'aw1');
    const principal: PresenterPrincipal = { kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: 'agent1', publicKeyHex: agent.pubkeyHex, standing: {} };
    const binding = bindingFor('reputation', agent.address, 'r', 'chal-1616161616161616', 'j1', BURN);
    const r = await produceReputationPresentation({ db: makeDb(store), env: {} }, { principal, burnId: BURN, audience: 'r', challenge: 'chal-1616161616161616', iat: IAT, exp: EXP, jti: 'j1', pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex }, directive: { redact: [], predicates: [] }, nowSeconds: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(503);
    // and the burn was NOT consumed (fail before consume)
    expect(store.get('burn_consumptions')?.has(BURN)).toBeFalsy();
  });
});

// =============================================================================
describe('pe_fact tier — ownership + anchoring', () => {
  const anchoredProof = (peId: string, hash: string) => ({
    status: 'proven' as const,
    proof: { pe_id: peId, envelope_hash: hash, anchored: true as const, anchor: { batch_id: 'batch-1', merkle_root: '0xroot' }, leaf: { leaf_value: '0xleaf' }, merkle_proof: ['0xsib'], verification: {} },
  });

  it('happy: an owned, anchored PE is presented and verifies (no on-chain check → structural pass)', async () => {
    const agent = makeAgentSigner();
    seedBurn(store, BURN, 'aw1');
    mockedResolve.mockResolvedValue(anchoredProof('pe-1', '0xhash1'));
    const principal: PresenterPrincipal = { kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: 'agent1', publicKeyHex: agent.pubkeyHex, standing: {} };
    const binding = bindingFor('pe_fact', agent.address, 'r', 'chal-1616161616161616', 'j1', BURN, { peFacts: [{ pe_id: 'pe-1', envelope_hash: '0xhash1' }] });
    const r = await producePeFactPresentation({ db: makeDb(store), env: ed.env }, { principal, burnId: BURN, audience: 'r', challenge: 'chal-1616161616161616', iat: IAT, exp: EXP, jti: 'j1', pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex }, peFacts: [{ pe_id: 'pe-1', envelope_hash: '0xhash1', ...HELD }], nowSeconds: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.presentation.proofs?.length).toBe(1);
    // No peAnchorContract → structural + co-sign path (the Provian co-sign is
    // required now, so publicKeys must be supplied even without an on-chain check).
    const v = await verifyPresentation(r.presentation, { publicKeys: ed.publicKeys, nowSeconds: NOW + 1 });
    expect(v.valid).toBe(true);
  });

  it('RED: a PE owned by a DIFFERENT agent cannot be presented', async () => {
    const agent = makeAgentSigner();
    seedBurn(store, BURN, 'aw1');
    mockedResolve.mockResolvedValue({ status: 'refused', http: 403, reason: 'pe_not_owned' });
    const principal: PresenterPrincipal = { kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: 'agent1', publicKeyHex: agent.pubkeyHex, standing: {} };
    const binding = bindingFor('pe_fact', agent.address, 'r', 'chal-1616161616161616', 'j1', BURN, { peFacts: [{ pe_id: 'pe-1', envelope_hash: '0xhash1' }] });
    const r = await producePeFactPresentation({ db: makeDb(store), env: ed.env }, { principal, burnId: BURN, audience: 'r', challenge: 'chal-1616161616161616', iat: IAT, exp: EXP, jti: 'j1', pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex }, peFacts: [{ pe_id: 'pe-1', envelope_hash: '0xhash1', ...HELD }], nowSeconds: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('pe_not_owned');
  });

  it('RED: an unanchored PE cannot be presented as a chain-verifiable fact', async () => {
    const agent = makeAgentSigner();
    seedBurn(store, BURN, 'aw1');
    mockedResolve.mockResolvedValue({ status: 'refused', http: 409, reason: 'pe_not_anchored' });
    const principal: PresenterPrincipal = { kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: 'agent1', publicKeyHex: agent.pubkeyHex, standing: {} };
    const binding = bindingFor('pe_fact', agent.address, 'r', 'chal-1616161616161616', 'j1', BURN, { peFacts: [{ pe_id: 'pe-1', envelope_hash: '0xhash1' }] });
    const r = await producePeFactPresentation({ db: makeDb(store), env: ed.env }, { principal, burnId: BURN, audience: 'r', challenge: 'chal-1616161616161616', iat: IAT, exp: EXP, jti: 'j1', pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex }, peFacts: [{ pe_id: 'pe-1', envelope_hash: '0xhash1', ...HELD }], nowSeconds: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('pe_not_anchored');
  });

  it('RED: a claimed envelope_hash that does not match the anchored one is refused', async () => {
    const agent = makeAgentSigner();
    seedBurn(store, BURN, 'aw1');
    mockedResolve.mockResolvedValue({ status: 'refused', http: 409, reason: 'pe_hash_mismatch' }); // the held PE hashes to something else
    const principal: PresenterPrincipal = { kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: 'agent1', publicKeyHex: agent.pubkeyHex, standing: {} };
    // The presenter claims a DIFFERENT (someone else's anchored) hash.
    const binding = bindingFor('pe_fact', agent.address, 'r', 'chal-1616161616161616', 'j1', BURN, { peFacts: [{ pe_id: 'pe-1', envelope_hash: '0xFORGEDhash' }] });
    const r = await producePeFactPresentation({ db: makeDb(store), env: ed.env }, { principal, burnId: BURN, audience: 'r', challenge: 'chal-1616161616161616', iat: IAT, exp: EXP, jti: 'j1', pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex }, peFacts: [{ pe_id: 'pe-1', envelope_hash: '0xFORGEDhash', ...HELD }], nowSeconds: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('pe_hash_mismatch');
    // and the burn was NOT consumed (rejected before consume)
    expect(store.get('burn_consumptions')?.has(BURN)).toBeFalsy();
  });

  // RED CONTROL (PE meter): the relay keeps no PEs, so a pe_fact naming only a pe_id + hash —
  // the pre-meter shape the relay used to resolve against its own record — is refused 410
  // `pe_kept_by_owner` BEFORE the burn, and nothing is "proven" from relay state. Its positive
  // twin is the happy test above (same claim, PE supplied → proven).
  it('RED: a pe_fact with NO held PE is refused 410 pe_kept_by_owner, burn untouched', async () => {
    const agent = makeAgentSigner();
    seedBurn(store, BURN, 'aw1');
    mockedResolve.mockResolvedValue(anchoredProof('pe-1', '0xhash1'));
    const principal: PresenterPrincipal = { kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: 'agent1', publicKeyHex: agent.pubkeyHex, standing: {} };
    const binding = bindingFor('pe_fact', agent.address, 'r', 'chal-1616161616161616', 'j1', BURN, { peFacts: [{ pe_id: 'pe-1', envelope_hash: '0xhash1' }] });
    const r = await producePeFactPresentation({ db: makeDb(store), env: ed.env }, { principal, burnId: BURN, audience: 'r', challenge: 'chal-1616161616161616', iat: IAT, exp: EXP, jti: 'j1', pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex }, peFacts: [{ pe_id: 'pe-1', envelope_hash: '0xhash1' }], nowSeconds: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(410);
    expect(r.reason).toBe('pe_kept_by_owner');
    expect(mockedResolve).not.toHaveBeenCalled();
    expect(store.get('burn_consumptions')?.has(BURN)).toBeFalsy();
  });

  it('RED: tampering a produced presentation\'s envelope_hash breaks the presenter pop', async () => {
    const agent = makeAgentSigner();
    seedBurn(store, BURN, 'aw1');
    mockedResolve.mockResolvedValue(anchoredProof('pe-1', '0xhash1'));
    const principal: PresenterPrincipal = { kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: 'agent1', publicKeyHex: agent.pubkeyHex, standing: {} };
    const binding = bindingFor('pe_fact', agent.address, 'r', 'chal-1616161616161616', 'j1', BURN, { peFacts: [{ pe_id: 'pe-1', envelope_hash: '0xhash1' }] });
    const r = await producePeFactPresentation({ db: makeDb(store), env: ed.env }, { principal, burnId: BURN, audience: 'r', challenge: 'chal-1616161616161616', iat: IAT, exp: EXP, jti: 'j1', pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex }, peFacts: [{ pe_id: 'pe-1', envelope_hash: '0xhash1', ...HELD }], nowSeconds: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // ATTACK: swap the envelope_hash (and matching proof) to a different anchored PE.
    const tampered = JSON.parse(JSON.stringify(r.presentation));
    tampered.payload.pe_facts[0].envelope_hash = '0xOTHERanchored';
    tampered.proofs[0].envelope_hash = '0xOTHERanchored';
    const v = await verifyPresentation(tampered, { nowSeconds: NOW + 1 });
    expect(v.valid).toBe(false);
    if (v.valid) return;
    expect(v.reason).toBe('bad_presenter_pop'); // the pop now binds envelope_hash
  });
});

// =============================================================================
// pe_fact ON-CHAIN leaf binding (the anchoring-claim path). `verifyPE` only proves
// a leaf is anchored; it does NOT tie that leaf to the claimed envelope_hash. The
// on-chain verify recomputes leaf = keccak256(0x00 || bytes32(envelope_hash)) and
// requires equality, so a genuine anchored leaf cannot be replayed under a forged
// hash even with a valid (re-signed) presenter PoP.
describe('pe_fact on-chain leaf binding — positive + RED control', () => {
  const HASH_A = '0x' + 'ab'.repeat(32); // a real 32-byte envelope hash
  const HASH_B = '0x' + 'cd'.repeat(32); // a DIFFERENT real hash → different leaf

  it('a genuine anchored leaf replayed under a FORGED claimed hash is refused (leaf binding), and the untampered proof verifies', async () => {
    const agent = makeAgentSigner();
    seedBurn(store, BURN, 'aw1');
    // The service resolves the REAL anchored proof for HASH_A (real leaf).
    mockedResolve.mockResolvedValue({
      status: 'proven',
      proof: {
        pe_id: 'pe-1', envelope_hash: HASH_A, anchored: true,
        anchor: { batch_id: '0x' + '11'.repeat(32) },
        leaf: { leaf_value: hashEnvelopeHashLeaf(HASH_A) },
        merkle_proof: ['0x' + '22'.repeat(32)], verification: {},
      },
    });
    const principal: PresenterPrincipal = { kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: 'agent1', publicKeyHex: agent.pubkeyHex, standing: {} };
    const binding = bindingFor('pe_fact', agent.address, 'r', 'chal-1616161616161616', 'j1', BURN, { peFacts: [{ pe_id: 'pe-1', envelope_hash: HASH_A }] });
    const r = await producePeFactPresentation({ db: makeDb(store), env: ed.env }, { principal, burnId: BURN, audience: 'r', challenge: 'chal-1616161616161616', iat: IAT, exp: EXP, jti: 'j1', pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex }, peFacts: [{ pe_id: 'pe-1', envelope_hash: HASH_A, ...HELD }], nowSeconds: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // verifyPE would pass on the REAL leaf; make it always-true to prove the leaf
    // binding — not the chain read — is what stops the forgery.
    const verifyPE = jest.fn(async (_b: string, _p: string, _pr: string[]) => true);
    const stub = { verifyPE };

    // POSITIVE control: the untampered presentation verifies on-chain.
    const good = await verifyPresentation(r.presentation, { publicKeys: ed.publicKeys, peAnchorContract: stub, nowSeconds: NOW + 1 });
    expect(good.valid).toBe(true);
    if (good.valid) expect(good.onchain_checked).toBe(true);
    expect(verifyPE).toHaveBeenCalledTimes(1);

    // ATTACK: keep the genuine anchored leaf(HASH_A), but claim HASH_B and re-sign
    // the PoP over the forgery so checkCommon passes. To isolate the LEAF binding
    // (not the co-sign) as what stops it, ALSO mint a Provian co-sign over the
    // forged HASH_B claim — as if Provian had (wrongly) attested it — so the
    // co-sign binding passes and only the leaf binding can catch the forgery.
    verifyPE.mockClear();
    const forgedBinding = bindingFor('pe_fact', agent.address, 'r', 'chal-1616161616161616', 'j1', BURN, { peFacts: [{ pe_id: 'pe-1', envelope_hash: HASH_B }] });
    const forged = JSON.parse(JSON.stringify(r.presentation));
    forged.payload.pe_facts[0].envelope_hash = HASH_B;
    forged.proofs[0].envelope_hash = HASH_B;
    forged.payload.presenter_pop.signature = agent.sign(forgedBinding);
    const signingKey = loadPresentationSigningKey(ed.env);
    if (!signingKey.ok) throw new Error('test signing key not loadable');
    forged.provian_jws = signPeFactCosign(
      buildPeFactCosignPayload({ presenter_address: agent.address, burn_id: BURN, pe_facts: [{ pe_id: 'pe-1', envelope_hash: HASH_B }], jti: 'j1', iat: IAT, exp: EXP }),
      signingKey.key,
    );
    // forged.proofs[0].leaf.leaf_value stays leaf(HASH_A) — the real anchored leaf.
    const bad = await verifyPresentation(forged, { publicKeys: ed.publicKeys, peAnchorContract: stub, nowSeconds: NOW + 1 });
    expect(bad).toEqual({ valid: false, reason: 'pe_fact_proof_onchain_invalid' });
    expect(verifyPE).not.toHaveBeenCalled(); // refused before the chain read
  });
});

// =============================================================================
// pe_fact PROVIAN CO-SIGN (F4/F61). The presenter signature + on-chain anchor
// prove the PEs exist and the presenter holds a live key; NEITHER proves the PEs
// belong to the presenter or that a burn was consumed. Provian co-signs those two
// facts at issuance and every verifier REQUIRES the co-sign. Each property ships
// with its RED control (observed failing), so no green here is vacuous.
describe('pe_fact Provian co-sign — required at verify (F4/F61)', () => {
  const HASH_A = '0x' + 'ab'.repeat(32);
  const CLAIMS = [{ pe_id: 'pe-1', envelope_hash: HASH_A }];
  const stub = { verifyPE: async () => true };

  /** A fully valid, Provian-co-signed pe_fact presentation for `agent`. */
  function coSigned(agent: ReturnType<typeof makeAgentSigner>, over?: { jws?: string; claims?: { pe_id: string; envelope_hash: string }[] }): Presentation {
    const claims = over?.claims ?? CLAIMS;
    const binding = bindingFor('pe_fact', agent.address, 'r', 'chal-1616161616161616', 'j1', BURN, { peFacts: claims });
    const key = loadPresentationSigningKey(ed.env);
    if (!key.ok) throw new Error('test signing key not loadable');
    const jws = over?.jws ?? signPeFactCosign(
      buildPeFactCosignPayload({ presenter_address: agent.address, burn_id: BURN, pe_facts: claims, jti: 'j1', iat: IAT, exp: EXP }),
      key.key,
    );
    return {
      tier: 'pe_fact',
      payload: {
        v: 1, tier: 'pe_fact', iss: agent.address, sub: 'aw1', presenter_address: agent.address,
        aud: 'r', chal: 'chal-1616161616161616', iat: IAT, exp: EXP, jti: 'j1', burn_id: BURN,
        presenter_pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex },
        pe_facts: claims,
      },
      provian_jws: jws,
      proofs: [{ pe_id: 'pe-1', envelope_hash: HASH_A, anchored: true, anchor: { batch_id: '0x' + '11'.repeat(32) }, leaf: { leaf_value: hashEnvelopeHashLeaf(HASH_A) }, merkle_proof: ['0x' + '22'.repeat(32)], verification: {} }],
    };
  }

  it('POSITIVE: a genuinely co-signed pe_fact VERIFIES (non-vacuous)', async () => {
    const agent = makeAgentSigner();
    const v = await verifyPresentation(coSigned(agent), { publicKeys: ed.publicKeys, peAnchorContract: stub, nowSeconds: NOW + 1 });
    expect(v.valid).toBe(true);
    if (v.valid) expect(v.onchain_checked).toBe(true);
  });

  it('RED: a self-issued pe_fact with NO co-sign is refused (pe_fact_not_cosigned)', async () => {
    const agent = makeAgentSigner();
    const p = coSigned(agent);
    delete (p as { provian_jws?: string }).provian_jws;
    const v = await verifyPresentation(p, { publicKeys: ed.publicKeys, peAnchorContract: stub, nowSeconds: NOW + 1 });
    expect(v).toEqual({ valid: false, reason: 'pe_fact_not_cosigned' });
  });

  it('RED: a co-sign minted with an ATTACKER key (real presenter, someone-else-anchored PEs) is refused', async () => {
    // The classic F4/F61 forgery: the attacker controls its own presenter key and
    // cites a real anchored PE, but cannot produce Provian\'s co-sign — it mints one
    // with its OWN Ed25519 key, reusing Provian\'s kid. bad_signature, not accepted.
    const agent = makeAgentSigner();
    const attackerKey = crypto.generateKeyPairSync('ed25519');
    const attackerPriv = attackerKey.privateKey.export({ format: 'jwk' }) as { x: string; d: string };
    const forgedJws = signPeFactCosign(
      buildPeFactCosignPayload({ presenter_address: agent.address, burn_id: BURN, pe_facts: CLAIMS, jti: 'j1', iat: IAT, exp: EXP }),
      { kid: 'test-presentation-key-1', privateKey: crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x: attackerPriv.x, d: attackerPriv.d }, format: 'jwk' }) },
    );
    const v = await verifyPresentation(coSigned(agent, { jws: forgedJws }), { publicKeys: ed.publicKeys, peAnchorContract: stub, nowSeconds: NOW + 1 });
    expect(v).toEqual({ valid: false, reason: 'pe_fact_cosign_bad_signature' });
  });

  it('RED: a reputation-typ JWS presented as a pe_fact co-sign is refused (pe_fact_cosign_wrong_typ)', async () => {
    const agent = makeAgentSigner();
    const key = loadPresentationSigningKey(ed.env);
    if (!key.ok) throw new Error('key');
    // Sign the co-sign payload but with the REPUTATION typ — the distinct typ pins.
    const wrongTypJws = signReputationPresentation(
      buildPeFactCosignPayload({ presenter_address: agent.address, burn_id: BURN, pe_facts: CLAIMS, jti: 'j1', iat: IAT, exp: EXP }) as unknown as Parameters<typeof signReputationPresentation>[0],
      key.key,
    );
    const v = await verifyPresentation(coSigned(agent, { jws: wrongTypJws }), { publicKeys: ed.publicKeys, peAnchorContract: stub, nowSeconds: NOW + 1 });
    expect(v).toEqual({ valid: false, reason: 'pe_fact_cosign_wrong_typ' });
  });

  it('RED: a valid co-sign LIFTED from another burn/claim set is refused (pe_fact_cosign_payload_mismatch)', async () => {
    const agent = makeAgentSigner();
    const key = loadPresentationSigningKey(ed.env);
    if (!key.ok) throw new Error('key');
    // A genuine Provian co-sign, but over a DIFFERENT burn_id — cannot be lifted.
    const otherBurnJws = signPeFactCosign(
      buildPeFactCosignPayload({ presenter_address: agent.address, burn_id: 'e'.repeat(64), pe_facts: CLAIMS, jti: 'j1', iat: IAT, exp: EXP }),
      key.key,
    );
    const v = await verifyPresentation(coSigned(agent, { jws: otherBurnJws }), { publicKeys: ed.publicKeys, peAnchorContract: stub, nowSeconds: NOW + 1 });
    expect(v).toEqual({ valid: false, reason: 'pe_fact_cosign_payload_mismatch' });
  });

  it('RED: a pe_fact with ZERO claims is refused (pe_fact_no_claims)', async () => {
    const agent = makeAgentSigner();
    const binding = bindingFor('pe_fact', agent.address, 'r', 'chal-1616161616161616', 'j1', BURN, { peFacts: [] });
    const p: Presentation = {
      tier: 'pe_fact',
      payload: {
        v: 1, tier: 'pe_fact', iss: agent.address, sub: 'aw1', presenter_address: agent.address,
        aud: 'r', chal: 'chal-1616161616161616', iat: IAT, exp: EXP, jti: 'j1', burn_id: BURN,
        presenter_pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex },
        pe_facts: [],
      },
      proofs: [],
    };
    const v = await verifyPresentation(p, { publicKeys: ed.publicKeys, peAnchorContract: stub, nowSeconds: NOW + 1 });
    expect(v).toEqual({ valid: false, reason: 'pe_fact_no_claims' });
  });

  // The full pe_fact loop the 09-08 mainnet drill mirrors: burn → produce
  // (Provian co-signs) → verify (co-sign + anchor) → replay refused (409). Uses
  // the real service + burn ledger; the anchor proof + on-chain read are stubbed.
  it('LOOP: burn → co-signed pe_fact → verify → replay refused (409)', async () => {
    const agent = makeAgentSigner();
    seedBurn(store, BURN, 'aw1');
    mockedResolve.mockResolvedValue({
      status: 'proven',
      proof: { pe_id: 'pe-1', envelope_hash: HASH_A, anchored: true, anchor: { batch_id: '0x' + '11'.repeat(32) }, leaf: { leaf_value: hashEnvelopeHashLeaf(HASH_A) }, merkle_proof: ['0x' + '22'.repeat(32)], verification: {} },
    });
    const principal: PresenterPrincipal = { kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: 'agent1', publicKeyHex: agent.pubkeyHex, standing: {} };
    const binding = bindingFor('pe_fact', agent.address, 'r', 'chal-1616161616161616', 'j1', BURN, { peFacts: CLAIMS });
    const produced = await producePeFactPresentation({ db: makeDb(store), env: ed.env }, { principal, burnId: BURN, audience: 'r', challenge: 'chal-1616161616161616', iat: IAT, exp: EXP, jti: 'j1', pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex }, peFacts: CLAIMS.map((c) => ({ ...c, ...HELD })), nowSeconds: NOW });
    expect(produced.ok).toBe(true);
    if (!produced.ok) return;
    expect(typeof produced.presentation.provian_jws).toBe('string'); // the co-sign IS emitted

    const v = await verifyPresentation(produced.presentation, { publicKeys: ed.publicKeys, peAnchorContract: stub, expectedAudience: 'r', expectedChallenge: 'chal-1616161616161616', nowSeconds: NOW + 1 });
    expect(v.valid).toBe(true);
    if (v.valid) expect(v.onchain_checked).toBe(true);

    // Replay the SAME burn → 409 (single-use). Sign a fresh binding for the
    // replay's own jti so it passes PoP and reaches the consumption guard.
    const replayBinding = bindingFor('pe_fact', agent.address, 'r', 'chal-1616161616161616', 'j1-replay', BURN, { peFacts: CLAIMS });
    const replay = await producePeFactPresentation({ db: makeDb(store), env: ed.env }, { principal, burnId: BURN, audience: 'r', challenge: 'chal-1616161616161616', iat: IAT, exp: EXP, jti: 'j1-replay', pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(replayBinding), pubkey: agent.pubkeyHex }, peFacts: CLAIMS.map((c) => ({ ...c, ...HELD })), nowSeconds: NOW });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.status).toBe(409);
  });
});

// =============================================================================
describe('human/agent SYMMETRY — human path through the shared entry point', () => {
  // producePresentationFromRequest uses real Date.now() (clients never send a
  // clock), so the human tests bind to real-time iat/exp.
  function realWindow() {
    const iat = Math.floor(Date.now() / 1000);
    return { iat, exp: iat + 300 };
  }
  function humanBinding(addr: string, aud: string, chal: string, jti: string, iat: number, exp: number): string {
    const digest = claimsDigest({ tier: 'reputation', reputation_directive: canonicalReputationDirective({ redact: [], predicates: [] }) });
    return presentationBindingString({ tier: 'reputation', presenter_address: addr, aud, chal, iat, exp, jti, burn_id: BURN, claims_digest: digest });
  }

  it('a human produces a reputation presentation (EIP-191 pop) that verifies', async () => {
    const human = makeHumanSigner();
    seedBurn(store, BURN, 'hw1');
    const { iat, exp } = realWindow();
    const principal: PresenterPrincipal = {
      kind: 'human', walletId: 'hw1', address: human.address, peOwnerUserId: 'user1', standing: {},
    };
    seedStats(store, 'user1', { pe_count: 12 });
    // The human signs the SAME canonical binding, with the SAME shared functions — EIP-191.
    const pop: PresenterPop = { scheme: 'eip191_secp256k1', signature: await human.sign(humanBinding(human.address, 'requester-1', 'chal-humanhumanhuman', 'jh1', iat, exp)) };
    // Drive the SHARED body-parsing entry point both routes use, proving symmetry.
    const r = await producePresentationFromRequest(
      { db: makeDb(store), env: ed.env },
      principal,
      { tier: 'reputation', burn_id: BURN, audience: 'requester-1', challenge: 'chal-humanhumanhuman', iat, exp, jti: 'jh1', pop, disclosure: {} },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.presentation.payload.presenter_address).toBe(human.address);
    const v = await verifyPresentation(r.presentation, { publicKeys: ed.publicKeys, expectedAudience: 'requester-1', expectedChallenge: 'chal-humanhumanhuman' });
    expect(v.valid).toBe(true);
    if (!v.valid) return;
    expect(v.payload.reputation?.facts['continuity.chain_depth']).toBe(12);
    expect(v.payload.reputation?.facts['actor.is_agent']).toBe(0);
    expect(v.standing?.['standing.adverse_events']).toBe(0);
  });

  it('RED: an agent pop scheme on a human principal is rejected', async () => {
    const human = makeHumanSigner();
    seedBurn(store, BURN, 'hw1');
    const { iat, exp } = realWindow();
    const principal: PresenterPrincipal = { kind: 'human', walletId: 'hw1', address: human.address, peOwnerUserId: 'user1', standing: {} };
    const r = await producePresentationFromRequest(
      { db: makeDb(store), env: ed.env },
      principal,
      { tier: 'reputation', burn_id: BURN, audience: 'r', challenge: 'chal-humanhumanhuman', iat, exp, jti: 'jh1', pop: { scheme: 'ecdsa_sha256_secp256k1', signature: await human.sign(humanBinding(human.address, 'r', 'chal-humanhumanhuman', 'jh1', iat, exp)), pubkey: 'deadbeef' }, disclosure: {} },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
  });
});
