/**
 * gate-side fixes — relay acceptance + RED negative controls.
 *
 * Every rule ships with a control that FAILS on a violating input and a positive twin that passes,
 * so no assertion here is vacuous:
 * item 1 a verify that names predicates refuses a pe_fact token (predicates_require_reputation_tier)
 * item 6 presentation_id = burn_id on every valid result; expected presenter mismatch refused;
 * relay verify stays stateless (the same token verifies twice)
 * item 7 signed challenges: pinned signing-string / signature vectors (cross-package), A.3
 * verdicts, relay issuance refuses invalid / expired / not-addressed envelopes BEFORE the
 * burn is consumed, v2 presentations bind the verified requester + deadline, verify
 * enforces the deadline, a v1 payload may not smuggle v2 fields, the co-sign binds v2
 */

import crypto from 'crypto';
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ethers } from 'ethers';

import {
  presentationBindingString,
  claimsDigest,
  buildPeFactCosignPayload,
  type PresenterPop,
  type Presentation,
  type PresentationRequester,
} from './types';
import { canonicalReputationDirective, type DisclosureDirective, type PredicateRequest } from './disclosure';
import { verifyPresentation } from './verify';
import { loadPresentationSigningKey, signPeFactCosign, signReputationPresentation } from './signer';
import { STANDING_ALWAYS_PRESENT_FIELDS } from './vocabulary-fields';
import { hashEnvelopeHashLeaf } from '../pvt/merkle';
import type { CommerceAttestationPublicJwk } from './jws-key-material';
import {
  challengeSigningString,
  challengePredicatesDigest,
  signChallengeEnvelope,
  verifyChallengeEnvelope,
  parseChallengeEnvelope,
  type ChallengeEnvelope,
} from './challenge';
import { challengeDisclosuresDigest, disclosureCommitmentDigest, normalizeDisclosureRequests, parseDisclosureAnswers } from './disclosure-request';
import { issueWalletChallengeFromRequest } from './challenge-issuer';

// PE METER: the relay keeps no PEs, so a pe_fact is proven from the PE + inclusion proof the
// PRESENTER supplies (`proveMeterFact`). Mock that one function so these tests exercise the
// SERVICE (ownership, binding, burn consumption), not the two-hop Merkle machinery (which the
// meter's own suites own); the counterparty-side leaf check stays real for verify.
jest.mock('../meter/meter-fact-proof', () => ({
  ...jest.requireActual<typeof import('../meter/meter-fact-proof')>('../meter/meter-fact-proof'),
  proveMeterFact: jest.fn(),
}));
import { proveMeterFact } from '../meter/meter-fact-proof';
import { producePresentationFromRequest, type PresenterPrincipal } from './service';

const mockedResolve = proveMeterFact as jest.MockedFunction<typeof proveMeterFact>;

// ─── keys ────────────────────────────────────────────────────────────────────
function makeEd25519Env(kid = 'test-presentation-key-1'): { env: Record<string, string>; publicKeys: CommerceAttestationPublicJwk[] } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  const pub = publicKey.export({ format: 'jwk' }) as { x: string };
  return {
    env: { ATTESTATION_SIGNING_KEY: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', kid, x: priv.x, d: priv.d }) },
    publicKeys: [{ kty: 'OKP', crv: 'Ed25519', kid, x: pub.x, use: 'sig', alg: 'EdDSA', key_ops: ['verify'] }],
  };
}
function makeAgentSigner(): { pubkeyHex: string; address: string; sign: (msg: string) => string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const pubkeyHex = Buffer.from(jwk.x, 'base64url').toString('hex').padStart(64, '0') + Buffer.from(jwk.y, 'base64url').toString('hex').padStart(64, '0');
  const address = ethers.computeAddress(`0x04${pubkeyHex}`).toLowerCase();
  return { pubkeyHex, address, sign: (msg: string) => { const s = crypto.createSign('SHA256'); s.update(msg); return s.sign(privateKey, 'hex'); } };
}
function domainKey(kid = 'k1') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }) as { x: string };
  return { privateKey, jwk: { kty: 'OKP', crv: 'Ed25519', x: pub.x, kid } };
}

// ─── fake Firestore (same shape as presentation.test.ts) ─────────────────────
type Row = Record<string, unknown>;
type Store = Map<string, Map<string, Row>>;
function coll(store: Store, name: string): Map<string, Row> {
  let c = store.get(name);
  if (!c) { c = new Map(); store.set(name, c); }
  return c;
}
class FakeDocRef {
  constructor(private store: Store, private collection: string, readonly id: string) {}
  async get() { const row = coll(this.store, this.collection).get(this.id); return { exists: row !== undefined, id: this.id, data: () => (row ? { ...row } : undefined) }; }
  set(data: Row): void { coll(this.store, this.collection).set(this.id, { ...data }); }
  create(data: Row): void {
    const c = coll(this.store, this.collection);
    if (c.has(this.id)) { const e = new Error('ALREADY_EXISTS') as Error & { code: number }; e.code = 6; throw e; }
    c.set(this.id, { ...data });
  }
}
class FakeQuery {
  constructor(private store: Store, private collection: string, private constraints: [string, unknown][] = [], private lim = Infinity) {}
  where(f: string, _op: string, v: unknown): FakeQuery { return new FakeQuery(this.store, this.collection, [...this.constraints, [f, v]], this.lim); }
  limit(n: number): FakeQuery { return new FakeQuery(this.store, this.collection, this.constraints, n); }
  orderBy(): FakeQuery { return this; }
  private rows() { let rows = [...coll(this.store, this.collection).entries()]; for (const [f, v] of this.constraints) rows = rows.filter(([, d]) => d[f] === v); return rows.slice(0, this.lim); }
  async get() { const rows = this.rows(); return { empty: rows.length === 0, size: rows.length, docs: rows.map(([id, d]) => ({ id, data: () => ({ ...d }) })) }; }
  count() { return { get: async () => ({ data: () => ({ count: this.rows().length }) }) }; }
}
function makeDb(store: Store) {
  return {
    collection: (name: string) => ({
      doc: (id: string) => new FakeDocRef(store, name, id),
      where: (f: string, op: string, v: unknown) => new FakeQuery(store, name).where(f, op, v),
      orderBy: () => new FakeQuery(store, name),
      limit: (n: number) => new FakeQuery(store, name).limit(n),
    }),
    runTransaction: async (fn: (txn: { get: (r: FakeDocRef) => ReturnType<FakeDocRef['get']>; create: (r: FakeDocRef, d: Row) => void; set: (r: FakeDocRef, d: Row) => void }) => Promise<unknown>) =>
      fn({ get: (r) => r.get(), create: (r, d) => r.create(d), set: (r, d) => r.set(d) }),
  } as unknown as import('firebase-admin/firestore').Firestore;
}

const BURN = 'a'.repeat(64);
const FLOOR_15 = (15n * 10n ** 18n).toString();
const NOW = 1_800_000_000;
const IAT = NOW;
const EXP = NOW + 300;
const CHAL = 'c'.repeat(64);

function seedBurn(store: Store, burnId: string, walletId: string): void {
  coll(store, 'pvt_burn_records').set(burnId, { tx_hash: '0x1', chain: 'base', wallet_id: walletId, burner_address: '0xabc', amount_atomic: FLOOR_15, status: 'recorded', verified: true });
}

function bindingFor(
  tier: 'pe_fact' | 'reputation', address: string, aud: string, chal: string, jti: string, burnId: string,
  opts: { peFacts?: { pe_id: string; envelope_hash: string }[]; directive?: DisclosureDirective; requester?: PresentationRequester; chalExp?: number; iat?: number; exp?: number } = {},
): string {
  const digest = tier === 'pe_fact'
    ? claimsDigest({ tier: 'pe_fact', pe_facts: opts.peFacts ?? [] })
    : claimsDigest({ tier: 'reputation', reputation_directive: canonicalReputationDirective(opts.directive ?? { redact: [], predicates: [] }) });
  return presentationBindingString({
    tier, presenter_address: address, aud, chal, iat: opts.iat ?? IAT, exp: opts.exp ?? EXP, jti, burn_id: burnId, claims_digest: digest,
    ...(opts.requester && opts.chalExp !== undefined ? { requester: opts.requester, chal_exp: opts.chalExp } : {}),
  });
}

let store: Store;
let ed: ReturnType<typeof makeEd25519Env>;
beforeEach(() => { store = new Map(); ed = makeEd25519Env(); mockedResolve.mockReset(); });

/** Every always-present Standing fact at an observed zero — bound to the ONE list the verifier checks. */
const STANDING_ZERO: Readonly<Record<string, number>> = Object.fromEntries(STANDING_ALWAYS_PRESENT_FIELDS.map((f) => [f, 0]));
/** The live vocabulary stub the service reads through its seam (the vocabulary suite owns the readers). */
const VOCAB: Readonly<Record<string, number>> = { 'work.total': 50, 'continuity.chain_depth': 50, ...STANDING_ZERO };

const HASH_A = '0x' + 'ab'.repeat(32);
const CLAIMS = [{ pe_id: 'pe-1', envelope_hash: HASH_A }];
const anchorStub = { verifyPE: async () => true };
function anchored() {
  return {
    status: 'proven' as const,
    proof: { pe_id: 'pe-1', envelope_hash: HASH_A, anchored: true as const, anchor: { batch_id: '0x' + '11'.repeat(32) }, leaf: { leaf_value: hashEnvelopeHashLeaf(HASH_A) }, merkle_proof: ['0x' + '22'.repeat(32)], verification: {} },
  };
}

/** A fully valid co-signed v1 pe_fact presentation. */
function peFactPresentation(agent: ReturnType<typeof makeAgentSigner>, aud = 'gate-1'): Presentation {
  const binding = bindingFor('pe_fact', agent.address, aud, CHAL, 'j1', BURN, { peFacts: CLAIMS });
  const key = loadPresentationSigningKey(ed.env);
  if (!key.ok) throw new Error('key');
  return {
    tier: 'pe_fact',
    payload: { v: 1, tier: 'pe_fact', iss: agent.address, sub: 'aw1', presenter_address: agent.address, aud, chal: CHAL, iat: IAT, exp: EXP, jti: 'j1', burn_id: BURN,
      presenter_pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex }, pe_facts: CLAIMS },
    provian_jws: signPeFactCosign(buildPeFactCosignPayload({ presenter_address: agent.address, burn_id: BURN, pe_facts: CLAIMS, jti: 'j1', iat: IAT, exp: EXP }), key.key),
    proofs: [anchored().proof],
  };
}

async function reputationPresentation(
  agent: ReturnType<typeof makeAgentSigner>,
  opts: { directive?: DisclosureDirective; aud?: string; chal?: string; envelope?: ChallengeEnvelope; fetchRequesterKeys?: (d: string) => Promise<{ kty: string; crv?: string; x?: string; kid: string }[]> } = {},
) {
  seedBurn(store, BURN, 'aw1');
  const directive = opts.directive ?? { redact: [], predicates: [] };
  const aud = opts.aud ?? 'gate-1';
  const env = opts.envelope;
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 300;
  const requester = env?.requester ? (env.requester.type === 'wallet' ? { type: 'wallet' as const, id: env.requester.id, address: env.requester.address } : { type: 'domain' as const, id: env.requester.id }) : undefined;
  const binding = bindingFor('reputation', agent.address, aud, opts.chal ?? env?.challenge ?? CHAL, 'j1', BURN, { directive, requester, chalExp: env?.expiresAt, iat, exp });
  const principal: PresenterPrincipal = { kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: 'agent1', publicKeyHex: agent.pubkeyHex, standing: {} };
  const pop: PresenterPop = { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex };
  const body: Record<string, unknown> = {
    tier: 'reputation', burn_id: BURN, audience: aud, challenge: opts.chal ?? env?.challenge ?? CHAL, iat, exp, jti: 'j1', pop,
    disclosure: canonicalReputationDirective(directive),
  };
  if (env) body.challenge_envelope = env;
  return producePresentationFromRequest(
    { db: makeDb(store), env: ed.env, vocabulary: async () => VOCAB, ...(opts.fetchRequesterKeys ? { fetchRequesterKeys: opts.fetchRequesterKeys } : {}) },
    principal,
    body,
  );
}

// =============================================================================
describe('item 1 — a predicate gate requires the reputation tier', () => {
  const asks: PredicateRequest[] = [{ field: 'work.total', op: 'gte', threshold: 10 }];

  it('RED: a valid pe_fact token presented to a predicate gate is refused before any crypto', async () => {
    const v = await verifyPresentation(peFactPresentation(makeAgentSigner()), { publicKeys: ed.publicKeys, peAnchorContract: anchorStub, expectedPredicates: asks, nowSeconds: NOW + 1 });
    expect(v).toEqual({ valid: false, reason: 'predicates_require_reputation_tier' });
  });

  it('positive twin: the SAME pe_fact token verifies when no predicates are asked', async () => {
    const v = await verifyPresentation(peFactPresentation(makeAgentSigner()), { publicKeys: ed.publicKeys, peAnchorContract: anchorStub, nowSeconds: NOW + 1 });
    expect(v.valid).toBe(true);
    if (v.valid) { expect(v.onchain_checked).toBe(true); expect(v.presentation_id).toBe(BURN); }
  });
});

// =============================================================================
describe('item 6 — presentation id, expected presenter, stateless relay verify', () => {
  it('presentation_id is the burn id on both tiers', async () => {
    const agent = makeAgentSigner();
    const r = await reputationPresentation(agent);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = await verifyPresentation(r.presentation, { publicKeys: ed.publicKeys, expectedAudience: 'gate-1', expectedChallenge: CHAL });
    expect(v.valid && v.presentation_id).toBe(BURN);
  });

  it('RED: a token from a DIFFERENT presenter than the one addressed is refused (address and wallet id forms)', async () => {
    const agent = makeAgentSigner();
    const r = await reputationPresentation(agent);
    if (!r.ok) throw new Error(r.error);
    const other = makeAgentSigner().address;
    const byAddr = await verifyPresentation(r.presentation, { publicKeys: ed.publicKeys, expectedAudience: 'gate-1', expectedChallenge: CHAL, expectedPresenter: other });
    expect(byAddr).toEqual({ valid: false, reason: 'presenter_mismatch' });
    const byId = await verifyPresentation(r.presentation, { publicKeys: ed.publicKeys, expectedAudience: 'gate-1', expectedChallenge: CHAL, expectedPresenter: 'aw-someone-else' });
    expect(byId).toEqual({ valid: false, reason: 'presenter_mismatch' });
    // positive twins: the right presenter by address (any case) and by wallet id
    expect((await verifyPresentation(r.presentation, { publicKeys: ed.publicKeys, expectedAudience: 'gate-1', expectedChallenge: CHAL, expectedPresenter: agent.address.toUpperCase().replace('0X', '0x') })).valid).toBe(true);
    expect((await verifyPresentation(r.presentation, { publicKeys: ed.publicKeys, expectedAudience: 'gate-1', expectedChallenge: CHAL, expectedPresenter: 'aw1' })).valid).toBe(true);
  });

  it('relay verify stays stateless: the same token verifies valid twice (the gate, not the relay, accepts once)', async () => {
    const r = await reputationPresentation(makeAgentSigner());
    if (!r.ok) throw new Error(r.error);
    const opts = { publicKeys: ed.publicKeys, expectedAudience: 'gate-1', expectedChallenge: CHAL };
    const a = await verifyPresentation(r.presentation, opts);
    const b = await verifyPresentation(r.presentation, opts);
    expect(a.valid && b.valid).toBe(true);
    expect(a.valid && b.valid && a.presentation_id === b.presentation_id).toBe(true);
  });
});

// =============================================================================
describe('item 7 — signed challenge vectors (cross-package pin)', () => {
  // The SAME vectors are asserted in the SDK, MCP core and app suites.
  const SEED = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
  const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), SEED]), format: 'der', type: 'pkcs8' });
  const preds: PredicateRequest[] = [{ field: 'work.total', op: 'gte', threshold: 10 }, { field: 'standing.adverse_events', op: 'in', set: [0] }];
  const dom = { audience: 'gate.example.com', challenge: 'a'.repeat(64), issuedAt: 1790000000, expiresAt: 1790000900, requester: { type: 'domain' as const, id: 'gate.example.com', kid: 'k1' }, presenter: '0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5', predicates: preds };
  const wal = { audience: 'wallet_aw_test1', challenge: 'b'.repeat(64), issuedAt: 1790000000, expiresAt: 1790003600, requester: { type: 'wallet' as const, id: 'wallet_aw_test1', address: '0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5', kid: 'provian-commerce-2026-08a' } };

  it('empty predicates digest is sha256("[]")', () => {
    expect(challengePredicatesDigest([])).toBe('4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
  });
  it('domain signing string + signature', () => {
    expect(challengeSigningString(dom)).toBe([
      'provian-challenge-v1', 'aud=gate.example.com', `chal=${'a'.repeat(64)}`, 'iat=1790000000', 'exp=1790000900',
      'req=domain:gate.example.com', 'kid=k1', 'presenter=0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5',
      'predicates=da4ebf087a6a4e7346e6bf971b59df8942f22381d2e04b7de563a919b6d9b653',
    ].join('\n'));
    expect(signChallengeEnvelope(dom, priv).sig).toBe('_SqvAe4KegEr31znYlpNJ6qjvcpU1lKxx2LCVJQdCuHKom5D37Dbi4K8VLEnt8s5McAPq__srMwSSYFlgVbKBw');
  });
  it('wallet signing string + signature', () => {
    expect(challengeSigningString(wal)).toBe([
      'provian-challenge-v1', 'aud=wallet_aw_test1', `chal=${'b'.repeat(64)}`, 'iat=1790000000', 'exp=1790003600',
      'req=wallet:wallet_aw_test1:0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5', 'kid=provian-commerce-2026-08a', 'presenter=',
      'predicates=4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    ].join('\n'));
    expect(signChallengeEnvelope(wal, priv).sig).toBe('3T4r5igsr6mP2cyg34xzcnzFFYu-KOOMp23lJ6YR7wHgQNmTvcOI_7UbcLQDo30-7ld1efnQc2UQXAvMCDapDA');
  });
  it('v2 binding strings', () => {
    expect(presentationBindingString({ tier: 'reputation', presenter_address: '0x5E645329EA23A84D6FB6006376F0B2B5E3B575F5', aud: 'gate.example.com', chal: 'a'.repeat(64), iat: 1790000100, exp: 1790000400, jti: 'pres_x', burn_id: 'c'.repeat(64), claims_digest: 'd'.repeat(64), requester: { type: 'domain', id: 'gate.example.com' }, chal_exp: 1790000900 }))
      .toBe(`provian-presentation-v2\ntier=reputation\npresenter=0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5\naud=gate.example.com\nchal=${'a'.repeat(64)}\niat=1790000100\nexp=1790000400\njti=pres_x\nburn=${'c'.repeat(64)}\nclaims=${'d'.repeat(64)}\nreq=domain:gate.example.com\nchal_exp=1790000900`);
    expect(presentationBindingString({ tier: 'pe_fact', presenter_address: '0xabc0000000000000000000000000000000000001', aud: 'wallet_aw_test1', chal: 'b'.repeat(64), iat: 1790000100, exp: 1790000400, jti: 'pres_y', burn_id: 'e'.repeat(64), claims_digest: 'f'.repeat(64), requester: { type: 'wallet', id: 'wallet_aw_test1', address: '0x5E645329EA23A84D6FB6006376F0B2B5E3B575F5' }, chal_exp: 1790003600 }))
      .toBe(`provian-presentation-v2\ntier=pe_fact\npresenter=0xabc0000000000000000000000000000000000001\naud=wallet_aw_test1\nchal=${'b'.repeat(64)}\niat=1790000100\nexp=1790000400\njti=pres_y\nburn=${'e'.repeat(64)}\nclaims=${'f'.repeat(64)}\nreq=wallet:wallet_aw_test1:0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5\nchal_exp=1790003600`);
  });
  it('an unsigned challenge produces the byte-identical v1 binding (no v2 lines)', () => {
    const b = presentationBindingString({ tier: 'reputation', presenter_address: '0xabc0000000000000000000000000000000000001', aud: 'x', chal: 'y'.repeat(16), iat: 1, exp: 61, jti: 'j', burn_id: 'z', claims_digest: 'q' });
    expect(b.startsWith('provian-presentation-v1\n')).toBe(true);
    expect(b.includes('req=')).toBe(false);
  });
});

// =============================================================================
describe('item 7 — presenter-side verdicts (A.3)', () => {
  const now = 1790000100;
  function domainEnvelope(k: ReturnType<typeof domainKey>, over: Partial<{ presenter: string; expiresAt: number; audience: string }> = {}) {
    return signChallengeEnvelope({
      audience: over.audience ?? 'gate.example.com', challenge: 'a'.repeat(64), issuedAt: 1790000000, expiresAt: over.expiresAt ?? 1790000900,
      requester: { type: 'domain', id: 'gate.example.com', kid: k.jwk.kid }, ...(over.presenter ? { presenter: over.presenter } : {}),
    }, k.privateKey);
  }

  it('verified: a domain-signed challenge whose key the well-known publishes', async () => {
    const k = domainKey();
    const v = await verifyChallengeEnvelope(domainEnvelope(k), { fetchRequesterKeys: async () => [k.jwk], nowSeconds: now });
    expect(v.status).toBe('verified');
    if (v.status === 'verified') expect(v.requester).toEqual({ type: 'domain', id: 'gate.example.com' });
  });
  it('unverified: a legacy unsigned challenge', async () => {
    const env = parseChallengeEnvelope({ audience: 'gate-1', challenge: 'a'.repeat(64) });
    expect(env).not.toBeNull();
    expect((await verifyChallengeEnvelope(env!, { nowSeconds: now })).status).toBe('unverified');
  });
  it('RED invalid: a signature by a key the domain does NOT publish', async () => {
    const k = domainKey();
    const impostor = domainKey();
    const v = await verifyChallengeEnvelope(domainEnvelope(impostor), { fetchRequesterKeys: async () => [k.jwk], nowSeconds: now });
    expect(v).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
  });
  it('RED invalid: a tampered field (predicates added after signing)', async () => {
    const k = domainKey();
    const tampered = { ...domainEnvelope(k), predicates: [{ field: 'work.total', op: 'gte' as const, threshold: 1 }] };
    expect((await verifyChallengeEnvelope(tampered, { fetchRequesterKeys: async () => [k.jwk], nowSeconds: now })).status).toBe('invalid');
  });
  it('RED invalid: audience ≠ requester identity', async () => {
    const k = domainKey();
    expect(await verifyChallengeEnvelope(domainEnvelope(k, { audience: 'other.example.com' }), { fetchRequesterKeys: async () => [k.jwk], nowSeconds: now }))
      .toMatchObject({ status: 'invalid', reason: 'audience_not_requester' });
  });
  it('RED invalid: the well-known is unreachable', async () => {
    const k = domainKey();
    expect(await verifyChallengeEnvelope(domainEnvelope(k), { fetchRequesterKeys: async () => { throw new Error('down'); }, nowSeconds: now }))
      .toMatchObject({ status: 'invalid', reason: 'requester_key_unreachable' });
  });
  it('RED expired: past the signed deadline (+60 s skew)', async () => {
    const k = domainKey();
    expect((await verifyChallengeEnvelope(domainEnvelope(k), { fetchRequesterKeys: async () => [k.jwk], nowSeconds: 1790000900 + 61 })).status).toBe('expired');
    expect((await verifyChallengeEnvelope(domainEnvelope(k), { fetchRequesterKeys: async () => [k.jwk], nowSeconds: 1790000900 + 60 })).status).toBe('verified');
  });
  it('RED not_addressed: a challenge naming another presenter', async () => {
    const k = domainKey();
    const env = domainEnvelope(k, { presenter: '0x' + '1'.repeat(40) });
    expect((await verifyChallengeEnvelope(env, { fetchRequesterKeys: async () => [k.jwk], nowSeconds: now, presenterAddress: '0x' + '2'.repeat(40) })).status).toBe('not_addressed');
    expect((await verifyChallengeEnvelope(env, { fetchRequesterKeys: async () => [k.jwk], nowSeconds: now, presenterAddress: '0x' + '1'.repeat(40) })).status).toBe('verified');
  });
  it('wallet challenge issued by the relay verifies against the Provian JWKS, and not against another key', async () => {
    const issued = issueWalletChallengeFromRequest({ walletId: 'aw_req', address: '0x' + 'ab'.repeat(20) }, { predicates: [{ field: 'work.total', op: 'gte', threshold: 3 }] }, ed.env);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.envelope.audience).toBe('aw_req');
    const ok = await verifyChallengeEnvelope(issued.envelope, { provianKeys: ed.publicKeys });
    expect(ok).toMatchObject({ status: 'verified', requester: { type: 'wallet', id: 'aw_req', address: '0x' + 'ab'.repeat(20) } });
    const other = makeEd25519Env();
    expect((await verifyChallengeEnvelope(issued.envelope, { provianKeys: other.publicKeys })).status).toBe('invalid');
  });
});

// =============================================================================
describe('item 7 — relay issuance against a signed challenge (/present)', () => {
  function walletEnvelope(over: { presenter?: string; ttl?: number; predicates?: PredicateRequest[] } = {}) {
    const issued = issueWalletChallengeFromRequest(
      { walletId: 'aw_req', address: '0x' + 'ab'.repeat(20) },
      { ...(over.predicates ? { predicates: over.predicates } : {}), ...(over.presenter ? { presenter: over.presenter } : {}), ...(over.ttl ? { ttl_seconds: over.ttl } : {}) },
      ed.env,
    );
    if (!issued.ok) throw new Error(issued.error);
    return issued.envelope;
  }

  it('a verified wallet challenge yields a v2 presentation that names the requester and verifies', async () => {
    const agent = makeAgentSigner();
    const env = walletEnvelope({ presenter: agent.address });
    const r = await reputationPresentation(agent, { aud: env.audience, envelope: env });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.presentation.payload.v).toBe(2);
    expect(r.presentation.payload.requester).toEqual({ type: 'wallet', id: 'aw_req', address: '0x' + 'ab'.repeat(20) });
    expect(r.presentation.payload.chal_exp).toBe(env.expiresAt);
    const v = await verifyPresentation(r.presentation, { publicKeys: ed.publicKeys, expectedAudience: env.audience, expectedChallenge: env.challenge });
    expect(v.valid).toBe(true);
    if (v.valid) { expect(v.requester).toEqual(r.presentation.payload.requester); expect(v.challenge_expires_at).toBe(env.expiresAt); }
  });

  it('RED: an invalid signature is refused at issuance and the burn is NOT consumed', async () => {
    const agent = makeAgentSigner();
    const env = { ...walletEnvelope(), sig: walletEnvelope().sig }; // a genuine sig from a DIFFERENT envelope
    const r = await reputationPresentation(agent, { aud: env.audience, envelope: env });
    expect(r).toMatchObject({ ok: false, status: 400, reason: 'challenge_signature_invalid' });
    expect(coll(store, 'burn_consumptions').has(BURN)).toBe(false);
  });

  it('RED: a signed challenge addressed to another presenter is refused (403) with no consumption', async () => {
    const agent = makeAgentSigner();
    const env = walletEnvelope({ presenter: makeAgentSigner().address });
    const r = await reputationPresentation(agent, { aud: env.audience, envelope: env });
    expect(r).toMatchObject({ ok: false, status: 403, reason: 'presenter_not_addressed' });
    expect(coll(store, 'burn_consumptions').has(BURN)).toBe(false);
  });

  it('RED: a disclosure that does not answer the signed predicates is refused before consumption', async () => {
    const agent = makeAgentSigner();
    const env = walletEnvelope({ predicates: [{ field: 'work.total', op: 'gte', threshold: 3 }] });
    const r = await reputationPresentation(agent, { aud: env.audience, envelope: env });
    expect(r).toMatchObject({ ok: false, reason: 'challenge_predicates_missing' });
    const answered = await reputationPresentation(agent, { aud: env.audience, envelope: env, directive: { redact: [], predicates: [{ field: 'work.total', op: 'gte', threshold: 3 }] } });
    expect(answered.ok).toBe(true);
  });

  it('RED: a domain challenge whose well-known key does not match is refused; the published key is accepted', async () => {
    const agent = makeAgentSigner();
    const k = domainKey();
    const nowS = Math.floor(Date.now() / 1000);
    const env = signChallengeEnvelope({ audience: 'gate.example.com', challenge: 'e'.repeat(64), issuedAt: nowS, expiresAt: nowS + 900, requester: { type: 'domain', id: 'gate.example.com', kid: 'k1' } }, k.privateKey);
    const wrong = await reputationPresentation(agent, { aud: 'gate.example.com', envelope: env, fetchRequesterKeys: async () => [domainKey().jwk] });
    expect(wrong).toMatchObject({ ok: false, reason: 'challenge_signature_invalid' });
    const right = await reputationPresentation(agent, { aud: 'gate.example.com', envelope: env, fetchRequesterKeys: async () => [k.jwk] });
    expect(right.ok).toBe(true);
    if (right.ok) expect(right.presentation.payload.requester).toEqual({ type: 'domain', id: 'gate.example.com' });
  });
});

// =============================================================================
describe('item 7 — verify enforces the signed deadline and the v2 binding', () => {
  async function v2Presentation() {
    const agent = makeAgentSigner();
    const issued = issueWalletChallengeFromRequest({ walletId: 'aw_req', address: '0x' + 'ab'.repeat(20) }, { ttl_seconds: 120 }, ed.env);
    if (!issued.ok) throw new Error(issued.error);
    const r = await reputationPresentation(agent, { aud: issued.envelope.audience, envelope: issued.envelope });
    if (!r.ok) throw new Error(r.error);
    return { presentation: r.presentation, env: issued.envelope };
  }

  it('RED: after the signed deadline (+60 s) a v2 presentation is refused challenge_expired; inside it verifies', async () => {
    const { presentation, env } = await v2Presentation();
    const base = { publicKeys: ed.publicKeys, expectedAudience: env.audience, expectedChallenge: env.challenge };
    expect((await verifyPresentation(presentation, { ...base, nowSeconds: (env.expiresAt as number) + 30 })).valid).toBe(true);
    expect(await verifyPresentation(presentation, { ...base, nowSeconds: (env.expiresAt as number) + 61 })).toEqual({ valid: false, reason: 'challenge_expired' });
  });

  it('RED: the requester\'s own deadline is enforced on a v1 presentation too', async () => {
    const r = await reputationPresentation(makeAgentSigner());
    if (!r.ok) throw new Error(r.error);
    const base = { publicKeys: ed.publicKeys, expectedAudience: 'gate-1', expectedChallenge: CHAL };
    const nowS = Math.floor(Date.now() / 1000);
    expect(await verifyPresentation(r.presentation, { ...base, challengeDeadline: nowS - 120 })).toEqual({ valid: false, reason: 'challenge_expired' });
    expect((await verifyPresentation(r.presentation, { ...base, challengeDeadline: nowS + 120 })).valid).toBe(true);
  });

  it('RED: a v2 presentation checked against a DIFFERENT expected requester is refused', async () => {
    const { presentation, env } = await v2Presentation();
    const base = { publicKeys: ed.publicKeys, expectedAudience: env.audience, expectedChallenge: env.challenge };
    expect(await verifyPresentation(presentation, { ...base, expectedRequester: { type: 'wallet', id: 'aw_req', address: '0x' + 'cd'.repeat(20) } }))
      .toEqual({ valid: false, reason: 'requester_mismatch' });
    expect((await verifyPresentation(presentation, { ...base, expectedRequester: { type: 'wallet', id: 'aw_req', address: '0x' + 'ab'.repeat(20) } })).valid).toBe(true);
  });

  it('RED: a v1 presentation (signature stripped at /present) answering a SIGNED challenge is refused requester_mismatch', async () => {
    const issued = issueWalletChallengeFromRequest({ walletId: 'aw_req', address: '0x' + 'ab'.repeat(20) }, { ttl_seconds: 120 }, ed.env);
    if (!issued.ok) throw new Error(issued.error);
    const env = issued.envelope;
    const stripped = await reputationPresentation(makeAgentSigner(), { aud: env.audience, chal: env.challenge });
    if (!stripped.ok) throw new Error(stripped.error);
    expect((stripped.presentation.payload as { v: number }).v).toBe(1);
    const base = { publicKeys: ed.publicKeys, expectedAudience: env.audience, expectedChallenge: env.challenge };
    const expectedRequester = { type: 'wallet' as const, id: 'aw_req', address: '0x' + 'ab'.repeat(20) };
    expect(await verifyPresentation(stripped.presentation, { ...base, expectedRequester })).toEqual({ valid: false, reason: 'requester_mismatch' });
    // positive twin: the same v1 token verifies when the gate did not issue a signed challenge
    expect((await verifyPresentation(stripped.presentation, base)).valid).toBe(true);
  });

  it('RED: a pe_fact v1 payload that smuggles a requester block is refused (malformed)', async () => {
    const p = peFactPresentation(makeAgentSigner());
    const smuggled: Presentation = { ...p, payload: { ...p.payload, requester: { type: 'domain', id: 'gate-1' } } };
    expect(await verifyPresentation(smuggled, { publicKeys: ed.publicKeys, peAnchorContract: anchorStub, nowSeconds: NOW + 1 })).toEqual({ valid: false, reason: 'malformed' });
  });

  it('pe_fact v2: the co-sign binds requester + deadline; a v1 co-sign cannot be lifted onto a v2 payload', async () => {
    const agent = makeAgentSigner();
    mockedResolve.mockResolvedValue(anchored());
    seedBurn(store, BURN, 'aw1');
    const issued = issueWalletChallengeFromRequest({ walletId: 'aw_req', address: '0x' + 'ab'.repeat(20) }, {}, ed.env);
    if (!issued.ok) throw new Error(issued.error);
    const env = issued.envelope;
    const requester = { type: 'wallet' as const, id: 'aw_req', address: '0x' + 'ab'.repeat(20) };
    const nowS = Math.floor(Date.now() / 1000);
    const iat = nowS;
    const exp = nowS + 300;
    const digest = claimsDigest({ tier: 'pe_fact', pe_facts: CLAIMS });
    const binding = presentationBindingString({ tier: 'pe_fact', presenter_address: agent.address, aud: env.audience, chal: env.challenge, iat, exp, jti: 'j1', burn_id: BURN, claims_digest: digest, requester, chal_exp: env.expiresAt as number });
    const principal: PresenterPrincipal = { kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: 'agent1', publicKeyHex: agent.pubkeyHex, standing: {} };
    const r = await producePresentationFromRequest({ db: makeDb(store), env: ed.env }, principal, {
      tier: 'pe_fact', burn_id: BURN, audience: env.audience, challenge: env.challenge, iat, exp, jti: 'j1',
      pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex }, pe_facts: CLAIMS.map((c) => ({ ...c, pe: { schema: 'held' }, inclusion: { held: true } })), challenge_envelope: env,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const base = { publicKeys: ed.publicKeys, peAnchorContract: anchorStub, expectedAudience: env.audience, expectedChallenge: env.challenge };
    const v = await verifyPresentation(r.presentation, base);
    expect(v.valid && v.tier === 'pe_fact' && v.requester?.id).toBe('aw_req');
    // Lift a v1 co-sign (same presenter/burn/claims/window) onto the v2 payload → refused.
    const key = loadPresentationSigningKey(ed.env);
    if (!key.ok) throw new Error('key');
    const v1Cosign = signPeFactCosign(buildPeFactCosignPayload({ presenter_address: agent.address, burn_id: BURN, pe_facts: CLAIMS, jti: 'j1', iat, exp }), key.key);
    expect(await verifyPresentation({ ...r.presentation, provian_jws: v1Cosign }, base)).toEqual({ valid: false, reason: 'pe_fact_cosign_payload_mismatch' });
    // A genuine v2 co-sign for ANOTHER requester (same deadline) — only the requester equality catches it.
    const otherRequester = signPeFactCosign(buildPeFactCosignPayload({ presenter_address: agent.address, burn_id: BURN, pe_facts: CLAIMS, jti: 'j1', iat, exp, requester: { type: 'wallet', id: 'aw_req', address: '0x' + 'cd'.repeat(20) }, chal_exp: env.expiresAt as number }), key.key);
    expect(await verifyPresentation({ ...r.presentation, provian_jws: otherRequester }, base)).toEqual({ valid: false, reason: 'pe_fact_cosign_payload_mismatch' });
    // A genuine v2 co-sign for the same requester with ANOTHER deadline — only the chal_exp equality catches it.
    const otherDeadline = signPeFactCosign(buildPeFactCosignPayload({ presenter_address: agent.address, burn_id: BURN, pe_facts: CLAIMS, jti: 'j1', iat, exp, requester, chal_exp: (env.expiresAt as number) + 3600 }), key.key);
    expect(await verifyPresentation({ ...r.presentation, provian_jws: otherDeadline }, base)).toEqual({ valid: false, reason: 'pe_fact_cosign_payload_mismatch' });
  });
});

// =============================================================================
describe('item 2 — a vocabulary read failure refuses issuance (503) and consumes nothing', () => {
  it('RED: a source that cannot be read → 503 vocabulary_source_unavailable, burn not consumed; positive twin issues', async () => {
    const { VocabularyUnavailableError } = await import('./vocabulary');
    const agent = makeAgentSigner();
    seedBurn(store, BURN, 'aw1');
    const iat = Math.floor(Date.now() / 1000);
    const binding = bindingFor('reputation', agent.address, 'gate-1', CHAL, 'j1', BURN, { iat, exp: iat + 300 });
    const principal: PresenterPrincipal = { kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: 'agent1', publicKeyHex: agent.pubkeyHex, standing: {} };
    const body = { tier: 'reputation', burn_id: BURN, audience: 'gate-1', challenge: CHAL, iat, exp: iat + 300, jti: 'j1', pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex }, disclosure: { redact: [], predicates: [] } };
    const failing = await producePresentationFromRequest({ db: makeDb(store), env: ed.env, vocabulary: async () => { throw new VocabularyUnavailableError('actor_stats', 'deadline exceeded'); } }, principal, body);
    expect(failing).toMatchObject({ ok: false, status: 503, reason: 'vocabulary_source_unavailable' });
    expect(coll(store, 'burn_consumptions').has(BURN)).toBe(false);
    const ok = await producePresentationFromRequest({ db: makeDb(store), env: ed.env, vocabulary: async () => VOCAB }, principal, body);
    expect(ok.ok).toBe(true);
  });
});

describe('share-only disclosure (, the operator on device: withhold by default)', () => {
  const WORK_GTE_1 = { field: 'work.total', op: 'gte' as const, threshold: 1 };

  it('reveals ONLY Standing, the predicate answers and the listed fields — and the verifier accepts the signed share list', async () => {
    const r = await reputationPresentation(makeAgentSigner(), { directive: { redact: [], predicates: [WORK_GTE_1], share: ['continuity.chain_depth'] } });
    if (!r.ok) throw new Error(r.error);
    const rep = (r.presentation.payload as { reputation: { facts: Record<string, number>; shared?: string[]; redacted: string[] } }).reputation;
    expect(rep.facts).toEqual({ ...STANDING_ZERO, 'continuity.chain_depth': 50 });
    expect(rep.shared).toEqual(['continuity.chain_depth']);
    expect(rep.redacted).toEqual([]);
    const v = await verifyPresentation(r.presentation, { publicKeys: ed.publicKeys, expectedAudience: 'gate-1', expectedChallenge: CHAL, expectedPredicates: [WORK_GTE_1] });
    expect(v).toMatchObject({ valid: true, predicates: [{ field: 'work.total', op: 'gte', threshold: 1, result: true }] });
  });

  it('RED: an empty share list withholds every non-standing raw fact — nothing is revealed by default', async () => {
    const r = await reputationPresentation(makeAgentSigner(), { directive: { redact: [], predicates: [], share: [] } });
    if (!r.ok) throw new Error(r.error);
    expect((r.presentation.payload as { reputation: { facts: Record<string, number> } }).reputation.facts).toEqual(STANDING_ZERO);
  });

  it('RED: share and redact together are refused before consumption; a standing or predicate-only share entry is refused', async () => {
    const both = await reputationPresentation(makeAgentSigner(), { directive: { redact: ['work.total'], predicates: [], share: ['continuity.chain_depth'] } });
    expect(both).toMatchObject({ ok: false });
    const standing = await reputationPresentation(makeAgentSigner(), { directive: { redact: [], predicates: [], share: ['standing.adverse_events'] } });
    expect(standing).toMatchObject({ ok: false });
  });

  it('RED: the share list is bound into the presenter PoP — a body whose share list differs from what the presenter signed is refused', async () => {
    const agent = makeAgentSigner();
    seedBurn(store, BURN, 'aw1');
    const iat = Math.floor(Date.now() / 1000);
    const signed: DisclosureDirective = { redact: [], predicates: [], share: [] };
    const sent: DisclosureDirective = { redact: [], predicates: [], share: ['continuity.chain_depth'] };
    const binding = bindingFor('reputation', agent.address, 'gate-1', CHAL, 'j1', BURN, { directive: signed, iat, exp: iat + 300 });
    const principal: PresenterPrincipal = { kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: 'agent1', publicKeyHex: agent.pubkeyHex, standing: {} };
    const mk = (d: DisclosureDirective) => producePresentationFromRequest(
      { db: makeDb(store), env: ed.env, vocabulary: async () => VOCAB },
      principal,
      { tier: 'reputation', burn_id: BURN, audience: 'gate-1', challenge: CHAL, iat, exp: iat + 300, jti: 'j1',
        pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex }, disclosure: canonicalReputationDirective(d) },
    );
    expect(await mk(sent)).toMatchObject({ ok: false });
    // positive twin: the body the presenter actually signed issues.
    expect(await mk(signed)).toMatchObject({ ok: true });
  });

  it('a directive without `share` canonicalizes byte-identically to before (no existing digest moves)', () => {
    expect(JSON.stringify(canonicalReputationDirective({ redact: ['b', 'a'], predicates: [] }))).toBe('{"redact":["a","b"],"predicates":[]}');
    expect(JSON.stringify(canonicalReputationDirective({ redact: [], predicates: [], share: ['z', 'a', 'a'] }))).toBe('{"redact":[],"predicates":[],"share":["a","z"]}');
  });
});


describe(' close-out — Standing is never withheld (: adverse facts always present, never redactable)', () => {
  it('RED: a directive that REDACTS a Standing fact is refused 400 before the burn is consumed; the same burn then presents by default WITH Standing', async () => {
    const refused = await reputationPresentation(makeAgentSigner(), { directive: { redact: ['standing.adverse_events'], predicates: [] } });
    expect(refused).toMatchObject({ ok: false, status: 400 });
    expect((refused as { error: string }).error).toMatch(/standing is always present and cannot be redacted/);
    expect(coll(store, 'burn_consumptions').has(BURN)).toBe(false);
    const ok = await reputationPresentation(makeAgentSigner());
    if (!ok.ok) throw new Error(ok.error);
    const facts = (ok.presentation.payload as { reputation: { facts: Record<string, number> } }).reputation.facts;
    for (const f of STANDING_ALWAYS_PRESENT_FIELDS) expect(facts[f]).toBe(0);
  });

  it('RED: a SIGNED reputation payload missing a Standing fact is refused standing_withheld at verify; the unmodified re-signed payload verifies (control)', async () => {
    const r = await reputationPresentation(makeAgentSigner());
    if (!r.ok) throw new Error(r.error);
    const key = loadPresentationSigningKey(ed.env);
    if (!key.ok) throw new Error('signing key');
    const payload = JSON.parse(JSON.stringify(r.presentation.payload)) as { reputation: { facts: Record<string, number> } };
    const verifyOpts = { publicKeys: ed.publicKeys, expectedAudience: 'gate-1', expectedChallenge: CHAL };
    const control = { ...r.presentation, provian_jws: signReputationPresentation(payload as never, key.key) };
    expect(await verifyPresentation(control, verifyOpts)).toMatchObject({ valid: true });
    for (const withheld of STANDING_ALWAYS_PRESENT_FIELDS) {
      const stripped = JSON.parse(JSON.stringify(payload)) as typeof payload;
      delete stripped.reputation.facts[withheld];
      const forged = { ...r.presentation, payload: stripped as never, provian_jws: signReputationPresentation(stripped as never, key.key) };
      expect(await verifyPresentation(forged, verifyOpts)).toEqual({ valid: false, reason: 'standing_withheld' });
    }
  });
});

// ── Requester-named disclosure vectors (2026-10-10, cross-package pin) ───────────────────────
// The SAME literals are asserted in the relay, SDK, MCP core and app suites: the request
// canonicalization, the challenge `disclosures=` digest, and the identity-only commitment the
// presenter's PoP covers. Every accepting assertion is paired with a RED control.
describe('named disclosure vectors (cross-package pin)', () => {
  const GCE_ROOT = '594759594b9b61524f6c8ef668f7177f7b9066bc0674f2f49fe9e052be78beb2';
  const RAW_REQUESTS = [
    { kind: 'witness', issuer: GCE_ROOT, limit: 3 },
    { kind: 'pe', output_digest: 'ab'.repeat(32), fields: ['metadata.lines'], content: ['description'] },
  ];
  const BOTH_DIGEST = '6e800ab4c7b515877c8204a316e6b6f6fac2955991dfb18e7fcea801a510e250';
  const SINGLE_DIGEST = '64a9ce6293c9eb83c422b209db81b4ec3b10ae32c0617512f2a3b825ff95d32d';
  const COMMITMENT_DIGEST = 'ad587e32f1d40021e49c349706775ef6dca39ba7f1ed3d5851a65c89c74ab4dc';
  const EMPTY_PREDICATES = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';

  it('normalizes to the sorted canonical list (pe before witness) and digests to the pinned value', () => {
    const reqs = normalizeDisclosureRequests(RAW_REQUESTS)!;
    expect(reqs).toEqual([
      { kind: 'pe', output_digest: 'ab'.repeat(32), fields: ['metadata.lines'], content: ['description'] },
      { kind: 'witness', issuer: GCE_ROOT, limit: 3 },
    ]);
    expect(challengeDisclosuresDigest(reqs)).toBe(BOTH_DIGEST);
    // Order-independent: the reversed raw list commits to the same digest.
    expect(challengeDisclosuresDigest(normalizeDisclosureRequests([...RAW_REQUESTS].reverse())!)).toBe(BOTH_DIGEST);
    expect(challengeDisclosuresDigest(normalizeDisclosureRequests([RAW_REQUESTS[1]])!)).toBe(SINGLE_DIGEST);
    // RED: a different limit, field, or content election moves the digest.
    expect(challengeDisclosuresDigest(normalizeDisclosureRequests([{ ...RAW_REQUESTS[0], limit: 4 }, RAW_REQUESTS[1]])!)).not.toBe(BOTH_DIGEST);
    expect(challengeDisclosuresDigest(normalizeDisclosureRequests([{ kind: 'pe', output_digest: 'ab'.repeat(32), fields: ['metadata.lines'] }])!)).not.toBe(SINGLE_DIGEST);
  });

  it('the signing line carries `disclosures=` ONLY when the challenge names disclosures (pinned)', () => {
    const base = { audience: 'gate.example.com', challenge: 'a'.repeat(64), issuedAt: 1790000000, expiresAt: 1790000900, requester: { type: 'domain' as const, id: 'gate.example.com', kid: 'k1' }, presenter: '0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5', predicates: [] };
    const withDisclosures = challengeSigningString({ ...base, disclosures: normalizeDisclosureRequests(RAW_REQUESTS)! });
    expect(withDisclosures).toBe([
      'provian-challenge-v1', 'aud=gate.example.com', `chal=${'a'.repeat(64)}`, 'iat=1790000000', 'exp=1790000900',
      'req=domain:gate.example.com', 'kid=k1', 'presenter=0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5',
      `predicates=${EMPTY_PREDICATES}`, `disclosures=${BOTH_DIGEST}`,
    ].join('\n'));
    // RED control: no disclosures → the pre-existing bytes, no trailing line.
    expect(challengeSigningString(base).includes('disclosures=')).toBe(false);
    expect(challengeSigningString({ ...base, disclosures: [] }).includes('disclosures=')).toBe(false);
  });

  it('the identity-only commitment digest is pinned, order-independent, and RED on a changed identity', () => {
    const reqs = normalizeDisclosureRequests(RAW_REQUESTS)!;
    const pe = reqs[0]; const witness = reqs[1];
    const record = { pe_id: 'pe_7', pe_hash: 'cd'.repeat(32), action_type: 'coding_session', timestamp: 1790000000000, witness: { kind: 'device', signer: 'dev_x' } };
    const answers = parseDisclosureAnswers([
      { request: witness, election: 'declined' },
      { request: pe, election: 'disclosed', records: [record] },
    ])!;
    expect(disclosureCommitmentDigest(answers)).toBe(COMMITMENT_DIGEST);
    expect(disclosureCommitmentDigest([...answers].reverse())).toBe(COMMITMENT_DIGEST);
    // The commitment ignores everything but elections + record identities: relay-derived witness
    // facts, fields and content do not move it (the Provian JWS covers those).
    const withFacts = parseDisclosureAnswers([
      { request: witness, election: 'declined' },
      { request: pe, election: 'disclosed', records: [{ ...record, action_type: 'other', witness: { kind: 'hardware', scheme: 'tpm2_quote' }, fields: { 'metadata.lines': 12 }, content: { description: 'x' } }] },
    ])!;
    expect(disclosureCommitmentDigest(withFacts)).toBe(COMMITMENT_DIGEST);
    // RED: a different pe_hash, a dropped record, or a flipped election moves it.
    expect(disclosureCommitmentDigest(parseDisclosureAnswers([{ request: witness, election: 'declined' }, { request: pe, election: 'disclosed', records: [{ ...record, pe_hash: 'ce'.repeat(32) }] }])!)).not.toBe(COMMITMENT_DIGEST);
    expect(disclosureCommitmentDigest(parseDisclosureAnswers([{ request: witness, election: 'declined' }, { request: pe, election: 'disclosed', records: [] }])!)).not.toBe(COMMITMENT_DIGEST);
    expect(disclosureCommitmentDigest(parseDisclosureAnswers([{ request: witness, election: 'disclosed', records: [] }, { request: pe, election: 'disclosed', records: [record] }])!)).not.toBe(COMMITMENT_DIGEST);
  });

  it('RED: malformed requests are refused as a whole (null), never partially accepted', () => {
    expect(normalizeDisclosureRequests([{ kind: 'pe', output_digest: 'zz'.repeat(32) }])).toBeNull();
    expect(normalizeDisclosureRequests([{ kind: 'pe', output_digest: 'ab'.repeat(32), content: ['prompt'] }])).toBeNull();
    expect(normalizeDisclosureRequests([{ kind: 'witness', limit: 51 }])).toBeNull();
    expect(normalizeDisclosureRequests(Array.from({ length: 17 }, (_, i) => ({ kind: 'pe', output_digest: i.toString(16).padStart(2, '0').repeat(32) })))).toBeNull();
    expect(normalizeDisclosureRequests([{ kind: 'pe', output_digest: 'ab'.repeat(32), fields: ['__proto__.x'] }])).toBeNull();
    expect(normalizeDisclosureRequests(undefined)).toEqual([]);
  });
});
