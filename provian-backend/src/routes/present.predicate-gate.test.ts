/**
 * the public verify route's new contract, with RED controls:
 * - `challenge_envelope` carries every expectation (audience, challenge, predicates, presenter,
 * deadline); explicit fields that disagree with it are a 400
 * - `expected_presenter` mismatch → valid:false presenter_mismatch
 * - the requester's deadline is enforced (challenge_expired)
 * - a pe_fact token presented to a predicate gate → predicates_require_reputation_tier
 * - every valid response carries presentation_id / presenter_address / sub / requester /
 * challenge_expires_at, and the route stays stateless (same token, same answer, twice)
 */
import crypto from 'crypto';
import { describe, it, expect } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';
import { createPresentRouter } from './present';
import { producePresentationFromRequest, type PresenterPrincipal } from '../core/presentation/service';
import { presentationBindingString, claimsDigest, encodePresentationToken, buildPeFactCosignPayload, type Presentation } from '../core/presentation/types';
import { canonicalReputationDirective, type DisclosureDirective } from '../core/presentation/disclosure';
import { loadPresentationSigningKey, signPeFactCosign } from '../core/presentation/signer';
import { issueWalletChallengeFromRequest } from '../core/presentation/challenge-issuer';
import { hashEnvelopeHashLeaf } from '../core/pvt/merkle';
import { STANDING_ALWAYS_PRESENT_FIELDS } from '../core/presentation/vocabulary-fields';

/** Every always-present Standing fact at an observed zero (the verifier refuses a payload without them). */
const STANDING_ZERO: Record<string, number> = Object.fromEntries(STANDING_ALWAYS_PRESENT_FIELDS.map((f) => [f, 0]));

function ed25519Env() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  return { ATTESTATION_SIGNING_KEY: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', kid: 'k1', x: priv.x, d: priv.d }) };
}
function agentSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const pubkeyHex = Buffer.from(jwk.x, 'base64url').toString('hex').padStart(64, '0') + Buffer.from(jwk.y, 'base64url').toString('hex').padStart(64, '0');
  return { pubkeyHex, address: ethers.computeAddress(`0x04${pubkeyHex}`).toLowerCase(), sign: (m: string) => crypto.createSign('SHA256').update(m).sign(privateKey, 'hex') };
}
function fakeDb() {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  const coll = (n: string) => { let c = store.get(n); if (!c) { c = new Map(); store.set(n, c); } return c; };
  coll('pvt_burn_records').set('a'.repeat(64), { wallet_id: 'aw1', amount_atomic: (15n * 10n ** 18n).toString(), status: 'recorded', verified: true, chain: 'base' });
  const ref = (n: string, id: string) => ({
    id,
    async get() { const r = coll(n).get(id); return { exists: r !== undefined, data: () => (r ? { ...r } : undefined) }; },
    set(d: Record<string, unknown>) { coll(n).set(id, { ...d }); },
    create(d: Record<string, unknown>) { if (coll(n).has(id)) throw new Error('exists'); coll(n).set(id, { ...d }); },
  });
  return {
    collection: (n: string) => ({ doc: (id: string) => ref(n, id) }),
    runTransaction: async (fn: (t: unknown) => Promise<unknown>) => fn({
      get: (r: { get: () => unknown }) => r.get(),
      create: (r: { create: (d: Record<string, unknown>) => void }, d: Record<string, unknown>) => r.create(d),
      set: (r: { set: (d: Record<string, unknown>) => void }, d: Record<string, unknown>) => r.set(d),
    }),
  } as unknown as import('firebase-admin/firestore').Firestore;
}

const WORK_GTE_5 = { field: 'work.total', op: 'gte' as const, threshold: 5 };

async function repToken(env: Record<string, string>, opts: { audience: string; challenge: string; directive?: DisclosureDirective; envelope?: unknown; agent?: ReturnType<typeof agentSigner> }) {
  const agent = opts.agent ?? agentSigner();
  const directive = opts.directive ?? { redact: [], predicates: [] };
  const now = Math.floor(Date.now() / 1000);
  const envObj = opts.envelope as { requester?: { type: 'wallet'; id: string; address: string }; expiresAt?: number } | undefined;
  const binding = presentationBindingString({
    tier: 'reputation', presenter_address: agent.address, aud: opts.audience, chal: opts.challenge, iat: now, exp: now + 300, jti: 'j1', burn_id: 'a'.repeat(64),
    claims_digest: claimsDigest({ tier: 'reputation', reputation_directive: canonicalReputationDirective(directive) }),
    ...(envObj?.requester ? { requester: envObj.requester, chal_exp: envObj.expiresAt } : {}),
  });
  const principal: PresenterPrincipal = { kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: 'agent1', publicKeyHex: agent.pubkeyHex, standing: {} };
  const r = await producePresentationFromRequest({ db: fakeDb(), env, vocabulary: async () => ({ 'work.total': 9, ...STANDING_ZERO }) }, principal, {
    tier: 'reputation', burn_id: 'a'.repeat(64), audience: opts.audience, challenge: opts.challenge, iat: now, exp: now + 300, jti: 'j1',
    pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex },
    disclosure: canonicalReputationDirective(directive),
    ...(opts.envelope ? { challenge_envelope: opts.envelope } : {}),
  });
  if (!r.ok) throw new Error(`setup: ${r.error}`);
  return { token: encodePresentationToken(r.presentation), agent };
}

function appWith(env: Record<string, string>) {
  const app = express();
  app.use(express.json());
  app.use('/v1/present', createPresentRouter({ env }));
  return app;
}

describe(' POST /v1/present/verify — challenge_envelope + expected_presenter', () => {
  it('a relay-signed challenge envelope carries every expectation; the response names the verified requester', async () => {
    const env = ed25519Env();
    const agent = agentSigner();
    const issued = issueWalletChallengeFromRequest({ walletId: 'aw_req', address: '0x' + 'ab'.repeat(20) }, { predicates: [WORK_GTE_5], presenter: agent.address }, env);
    if (!issued.ok) throw new Error(issued.error);
    const { token } = await repToken(env, { audience: issued.envelope.audience, challenge: issued.envelope.challenge, directive: { redact: [], predicates: [WORK_GTE_5] }, envelope: issued.envelope, agent });
    const res = await request(appWith(env)).post('/v1/present/verify').send({ token, challenge_envelope: issued.envelope });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      valid: true, tier: 'reputation', presentation_id: 'a'.repeat(64), presenter_address: agent.address, sub: 'aw1',
      requester: { type: 'wallet', id: 'aw_req', address: '0x' + 'ab'.repeat(20) }, challenge_expires_at: issued.envelope.expiresAt,
    });
    expect(res.body.predicates).toEqual([{ field: 'work.total', op: 'gte', threshold: 5, result: true }]);
    // Stateless: the same request again answers identically (the GATE accepts once, not the relay).
    const again = await request(appWith(env)).post('/v1/present/verify').send({ token, challenge_envelope: issued.envelope });
    expect(again.body).toEqual(res.body);
  });

  it('RED: the envelope\'s addressed presenter is enforced — a token from anyone else is refused', async () => {
    const env = ed25519Env();
    const addressed = agentSigner();
    const issued = issueWalletChallengeFromRequest({ walletId: 'aw_req', address: '0x' + 'ab'.repeat(20) }, {}, env);
    if (!issued.ok) throw new Error(issued.error);
    // The presenter produced a valid v2 token against the envelope as issued (no presenter named);
    // the gate's envelope names who it addressed, and the token's presenter is someone else.
    const { token } = await repToken(env, { audience: issued.envelope.audience, challenge: issued.envelope.challenge, envelope: issued.envelope });
    const res = await request(appWith(env)).post('/v1/present/verify').send({ token, challenge_envelope: { ...issued.envelope, presenter: addressed.address } });
    expect(res.body).toEqual({ valid: false, reason: 'presenter_mismatch' });
  });

  it('RED: expected_presenter mismatch is refused; the right presenter passes', async () => {
    const env = ed25519Env();
    const { token, agent } = await repToken(env, { audience: 'gate-x', challenge: 'c'.repeat(32) });
    const wrong = await request(appWith(env)).post('/v1/present/verify').send({ token, audience: 'gate-x', challenge: 'c'.repeat(32), expected_presenter: agentSigner().address });
    expect(wrong.body).toEqual({ valid: false, reason: 'presenter_mismatch' });
    const right = await request(appWith(env)).post('/v1/present/verify').send({ token, audience: 'gate-x', challenge: 'c'.repeat(32), expected_presenter: agent.address });
    expect(right.body.valid).toBe(true);
  });

  it('RED: the requester deadline in its own (unsigned) envelope is enforced', async () => {
    const env = ed25519Env();
    const { token } = await repToken(env, { audience: 'gate-x', challenge: 'd'.repeat(32) });
    const now = Math.floor(Date.now() / 1000);
    const past = await request(appWith(env)).post('/v1/present/verify').send({ token, challenge_envelope: { audience: 'gate-x', challenge: 'd'.repeat(32), issuedAt: now - 1000, expiresAt: now - 200 } });
    expect(past.body).toEqual({ valid: false, reason: 'challenge_expired' });
    const live = await request(appWith(env)).post('/v1/present/verify').send({ token, challenge_envelope: { audience: 'gate-x', challenge: 'd'.repeat(32), issuedAt: now - 10, expiresAt: now + 200 } });
    expect(live.body.valid).toBe(true);
    expect(live.body.challenge_expires_at).toBe(now + 200);
  });

  it('RED: explicit fields that disagree with the envelope are a 400', async () => {
    const env = ed25519Env();
    const { token } = await repToken(env, { audience: 'gate-x', challenge: 'e'.repeat(32) });
    const res = await request(appWith(env)).post('/v1/present/verify').send({ token, audience: 'someone-else', challenge_envelope: { audience: 'gate-x', challenge: 'e'.repeat(32) } });
    expect(res.status).toBe(400);
  });

  it('RED (item 1): a pe_fact token to a predicate gate is refused on the public route', async () => {
    const env = ed25519Env();
    const agent = agentSigner();
    const hash = '0x' + 'ab'.repeat(32);
    const claims = [{ pe_id: 'pe-1', envelope_hash: hash }];
    const now = Math.floor(Date.now() / 1000);
    const binding = presentationBindingString({ tier: 'pe_fact', presenter_address: agent.address, aud: 'gate-x', chal: 'f'.repeat(32), iat: now, exp: now + 300, jti: 'j1', burn_id: 'b'.repeat(64), claims_digest: claimsDigest({ tier: 'pe_fact', pe_facts: claims }) });
    const key = loadPresentationSigningKey(env);
    if (!key.ok) throw new Error('key');
    const p: Presentation = {
      tier: 'pe_fact',
      payload: { v: 1, tier: 'pe_fact', iss: agent.address, sub: 'aw1', presenter_address: agent.address, aud: 'gate-x', chal: 'f'.repeat(32), iat: now, exp: now + 300, jti: 'j1', burn_id: 'b'.repeat(64), presenter_pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex }, pe_facts: claims },
      provian_jws: signPeFactCosign(buildPeFactCosignPayload({ presenter_address: agent.address, burn_id: 'b'.repeat(64), pe_facts: claims, jti: 'j1', iat: now, exp: now + 300, sub: 'aw1' }), key.key),
      proofs: [{ pe_id: 'pe-1', envelope_hash: hash, anchored: true, anchor: { batch_id: '0x' + '11'.repeat(32) }, leaf: { leaf_value: hashEnvelopeHashLeaf(hash) }, merkle_proof: [], verification: {} }],
    };
    const app = express();
    app.use(express.json());
    app.use('/v1/present', createPresentRouter({ env, peAnchorContract: { verifyPE: async () => true } as unknown as import('ethers').Contract }));
    const gated = await request(app).post('/v1/present/verify').send({ token: encodePresentationToken(p), audience: 'gate-x', challenge: 'f'.repeat(32), predicates: [WORK_GTE_5] });
    expect(gated.body).toEqual({ valid: false, reason: 'predicates_require_reputation_tier' });
    // positive twin: without predicates the same token verifies on-chain, carrying the id + presenter.
    const plain = await request(app).post('/v1/present/verify').send({ token: encodePresentationToken(p), audience: 'gate-x', challenge: 'f'.repeat(32) });
    expect(plain.body).toMatchObject({ valid: true, tier: 'pe_fact', onchain_checked: true, presentation_id: 'b'.repeat(64), presenter_address: agent.address, sub: 'aw1', requester: null });

    // RED: the pe_fact payload `sub` is outside the presenter PoP. Rewriting it to
    // a victim wallet breaks the co-sign binding, so a wallet-id presenter check cannot be satisfied.
    const forged: Presentation = { ...p, payload: { ...p.payload, sub: 'victim-wallet' } };
    const forgedRes = await request(app).post('/v1/present/verify').send({ token: encodePresentationToken(forged), audience: 'gate-x', challenge: 'f'.repeat(32), expected_presenter: 'victim-wallet' });
    expect(forgedRes.body).toEqual({ valid: false, reason: 'pe_fact_cosign_payload_mismatch' });
    // A co-sign that predates the subject binding carries no signed subject: the bare `sub` is never
    // reported, and a wallet-id presenter check refuses it.
    const legacy: Presentation = {
      ...forged,
      provian_jws: signPeFactCosign(buildPeFactCosignPayload({ presenter_address: agent.address, burn_id: 'b'.repeat(64), pe_facts: claims, jti: 'j1', iat: now, exp: now + 300 }), key.key),
    };
    const legacyRes = await request(app).post('/v1/present/verify').send({ token: encodePresentationToken(legacy), audience: 'gate-x', challenge: 'f'.repeat(32), expected_presenter: 'victim-wallet' });
    expect(legacyRes.body).toEqual({ valid: false, reason: 'presenter_mismatch' });
    const legacyPlain = await request(app).post('/v1/present/verify').send({ token: encodePresentationToken(legacy), audience: 'gate-x', challenge: 'f'.repeat(32) });
    expect(legacyPlain.body).toMatchObject({ valid: true, sub: null });
    // positive twin: the signed subject satisfies the wallet-id check.
    const own = await request(app).post('/v1/present/verify').send({ token: encodePresentationToken(p), audience: 'gate-x', challenge: 'f'.repeat(32), expected_presenter: 'aw1' });
    expect(own.body).toMatchObject({ valid: true, sub: 'aw1' });
  });
});
