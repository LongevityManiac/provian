/**
 * REQUESTER-NAMED DISCLOSURE — proof with RED controls:
 * a challenge naming a specific output digest returns that record's metadata only; an issuer
 * filter returns only that issuer's records; an undisclosed field is absent; a declined request
 * verifies as declined; a tampered disclosure fails verification.
 */
import { describe, it, expect, beforeAll, beforeEach } from '@jest/globals';
import crypto, { X509Certificate, type webcrypto } from 'crypto';
import * as x509 from '@peculiar/x509';
import { ethers } from 'ethers';
import {
  actLeafOf, actRecordOf, actsRootOf, batchHashOf, buildBatch, hardwareNonceOfAct, merkleProofOf, peHashOf, PE_V2_SCHEMA, type PeV2,
} from '../meter/meter-wire';
import { producePresentationFromRequest, type PresenterPrincipal } from './service';
import { verifyPresentation } from './verify';
import { signChallengeEnvelope, parseChallengeEnvelope, verifyChallengeEnvelope, challengeSigningString, type ChallengeEnvelope } from './challenge';
import { claimsDigest, presentationBindingString, decodePresentationToken, encodePresentationToken, type Presentation } from './types';
import { canonicalReputationDirective, type PredicateRequest } from './disclosure';
import {
  normalizeDisclosureRequests, canonicalDisclosureRequest, challengeDisclosuresDigest, disclosureCommitmentDigest,
  parseDisclosureAnswers, type CanonicalDisclosureRequest, type DisclosureAnswer,
} from './disclosure-request';
import { STANDING_ALWAYS_PRESENT_FIELDS } from './vocabulary-fields';
import type { CommerceAttestationPublicJwk } from './jws-key-material';

x509.cryptoProvider.set(crypto.webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

// ─── fixtures (the same shapes presentation.test.ts uses) ───────────────────────────────────────
function makeEd25519Env(): { env: Record<string, string>; publicKeys: CommerceAttestationPublicJwk[]; keys: { kty: string; crv: string; x: string; kid: string }[] } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  const pub = publicKey.export({ format: 'jwk' }) as { x: string };
  const kid = 'test-presentation-key-1';
  return {
    env: { ATTESTATION_SIGNING_KEY: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', kid, x: priv.x, d: priv.d }) },
    publicKeys: [{ kty: 'OKP', crv: 'Ed25519', kid, x: pub.x, use: 'sig', alg: 'EdDSA', key_ops: ['verify'] }],
    keys: [{ kty: 'OKP', crv: 'Ed25519', x: pub.x, kid }],
  };
}
function makeAgentSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const pubkeyHex = Buffer.from(jwk.x, 'base64url').toString('hex').padStart(64, '0') + Buffer.from(jwk.y, 'base64url').toString('hex').padStart(64, '0');
  const address = ethers.computeAddress(`0x04${pubkeyHex}`).toLowerCase();
  return { pubkeyHex, address, sign: (msg: string) => { const s = crypto.createSign('SHA256'); s.update(msg); return s.sign(privateKey, 'hex'); } };
}
type Row = Record<string, unknown>;
type Store = Map<string, Map<string, Row>>;
function coll(store: Store, name: string): Map<string, Row> { let c = store.get(name); if (!c) { c = new Map(); store.set(name, c); } return c; }
class FakeDocRef {
  constructor(private store: Store, private collection: string, readonly id: string) {}
  async get() { const row = coll(this.store, this.collection).get(this.id); return { exists: row !== undefined, id: this.id, data: () => (row ? { ...row } : undefined) }; }
  set(data: Row, opts?: { merge?: boolean }): void { const c = coll(this.store, this.collection); c.set(this.id, opts?.merge ? { ...(c.get(this.id) ?? {}), ...data } : { ...data }); }
  create(data: Row): void { const c = coll(this.store, this.collection); if (c.has(this.id)) { const e = new Error('ALREADY_EXISTS') as Error & { code: number }; e.code = 6; throw e; } c.set(this.id, { ...data }); }
}
function makeDb(store: Store) {
  return {
    collection: (name: string) => ({ doc: (id: string) => new FakeDocRef(store, name, id) }),
    runTransaction: async (fn: (txn: { get: (r: FakeDocRef) => ReturnType<FakeDocRef['get']>; create: (r: FakeDocRef, d: Row) => void; set: (r: FakeDocRef, d: Row, o?: { merge?: boolean }) => void }) => Promise<unknown>) =>
      fn({ get: (r) => r.get(), create: (r, d) => r.create(d), set: (r, d, o) => r.set(d, o) }),
  } as unknown as import('firebase-admin/firestore').Firestore;
}
const FLOOR_15 = (15n * 10n ** 18n).toString();
function seedBurn(store: Store, burnId: string, walletId: string): void {
  coll(store, 'pvt_burn_records').set(burnId, { tx_hash: `0x${burnId.slice(0, 8)}`, chain: 'base', wallet_id: walletId, burner_address: '0xabc', amount_atomic: FLOOR_15, status: 'recorded', verified: true });
}
const STANDING: Record<string, number> = Object.fromEntries(STANDING_ALWAYS_PRESENT_FIELDS.map((f) => [f, 0]));
const FACTS = { ...STANDING, 'work.total': 12, 'continuity.chain_depth': 12 };

// ─── a synthetic TPM witness under a test root (the hardware suite's builder) ────────────────────
interface TestKey { readonly pair: webcrypto.CryptoKeyPair; readonly node: crypto.KeyObject }
const T0 = Date.UTC(2026, 9, 9, 12);
async function genRsa(): Promise<TestKey> {
  const pair = await crypto.webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 }, true, ['sign', 'verify']) as webcrypto.CryptoKeyPair;
  const pkcs8 = Buffer.from(await crypto.webcrypto.subtle.exportKey('pkcs8', pair.privateKey));
  return { pair, node: crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }) };
}
const tpm2b = (b: Buffer): Buffer => Buffer.concat([Buffer.from([(b.length >> 8) & 0xff, b.length & 0xff]), b]);
function quoteOf(nonce: Buffer): Buffer {
  const parts = [Buffer.from([0xff, 0x54, 0x43, 0x47]), Buffer.from([0x80, 0x18]), tpm2b(Buffer.alloc(0)), tpm2b(nonce)];
  const clock = Buffer.alloc(17); clock.writeBigUInt64BE(123n, 0); clock.writeUInt32BE(1, 8); clock.writeUInt32BE(0, 12); clock[16] = 1;
  const fw = Buffer.alloc(8); fw.writeBigUInt64BE(0x20220715n, 0);
  const sel = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from([0x00, 0x0b, 3, 0x07, 0x00, 0x00])]);
  return Buffer.concat([...parts, clock, fw, sel, tpm2b(Buffer.alloc(32, 7))]);
}
function akPublicOf(key: TestKey): Buffer {
  const jwk = crypto.createPublicKey(key.node).export({ format: 'jwk' }) as { n: string };
  const head = Buffer.from([0x00, 0x01, 0x00, 0x0b, 0x00, 0x05, 0x00, 0x72]);
  const params = Buffer.concat([tpm2b(Buffer.alloc(0)), Buffer.from([0x00, 0x10]), Buffer.from([0x00, 0x14, 0x00, 0x0b]), Buffer.from([0x08, 0x00]), Buffer.from([0, 0, 0, 0])]);
  return Buffer.concat([head, params, tpm2b(Buffer.from(jwk.n, 'base64url'))]);
}

// ─── the presenter's chain: three PEs, one hardware-witnessed ───────────────────────────────────
const DEVICE = 'dev_disclosure_1';
const ACTOR = 'agent_disclosure_1';
const DIGEST_A = 'ab'.repeat(32);
const DIGEST_B = 'cd'.repeat(32);
let root: X509Certificate;
let rootFingerprint: string;
let pes: PeV2[];
let inclusionOf: (i: number) => Record<string, unknown>;
let akSignerSha256: string;

beforeAll(async () => {
  const rootKey = await genRsa(); const akKey = await genRsa();
  const rootCert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01', name: 'CN=test EK/AK CA Root', notBefore: new Date(T0 - 86_400_000), notAfter: new Date(T0 + 365 * 86_400_000),
    signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, keys: rootKey.pair, extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  root = new X509Certificate(rootCert.toString('pem'));
  rootFingerprint = crypto.createHash('sha256').update(root.raw).digest('hex');
  const leafCert = await x509.X509CertificateGenerator.create({
    serialNumber: '02', subject: 'CN=gce-ak', issuer: root.subject.replace(/\n/g, ', '), notBefore: new Date(T0 - 86_400_000), notAfter: new Date(T0 + 30 * 86_400_000),
    signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, publicKey: akKey.pair.publicKey, signingKey: rootKey.pair.privateKey,
    extensions: [new x509.BasicConstraintsExtension(false, undefined, true)],
  });
  const leaf = new X509Certificate(leafCert.toString('pem'));
  akSignerSha256 = crypto.createHash('sha256').update(crypto.createPublicKey(akKey.node).export({ type: 'spki', format: 'der' })).digest('hex');

  const base = (i: number, over: Record<string, unknown>): PeV2 => ({
    schema: PE_V2_SCHEMA, pe_id: `pe_${i}`, device_id: DEVICE, prev_hash: i === 0 ? 'genesis' : '', timestamp: T0 + i * 1000, action_type: 'coding_session', ...over,
  });
  const pe0 = base(0, { description: 'wrote the parser', intent_text: 'ship the parser', output_digests: [{ hash: `sha256:${DIGEST_A}`, kind: 'file' }], metadata: { model: 'claude', lines: 42 } });
  // The nonce covers the act's identity (prev_hash included), so the chain link is set BEFORE the witness is built.
  const pe1raw = base(1, { prev_hash: peHashOf(pe0), output_digests: [{ hash: `sha256:${DIGEST_B}`, kind: 'file' }], metadata: { model: 'claude', lines: 7 } });
  // The hardware witness is nonce-bound to THIS act (its identity + pricing minus the witness slot).
  const nonce = Buffer.from(hardwareNonceOfAct(actRecordOf(pe1raw)), 'hex');
  const q = quoteOf(nonce);
  const sig = crypto.sign('sha256', q, { key: akKey.node, padding: crypto.constants.RSA_PKCS1_PADDING });
  const pe1 = { ...pe1raw, hardware_witness: { scheme: 'tpm2_quote', quote: q.toString('base64'), signature: Buffer.concat([Buffer.from([0x00, 0x14, 0x00, 0x0b]), tpm2b(sig)]).toString('base64'), ak_public: akPublicOf(akKey).toString('base64'), ak_cert_chain: [leaf.toString()] } };
  const pe2 = base(2, { output_digests: [{ hash: `sha256:${'ef'.repeat(32)}`, kind: 'file' }], metadata: { model: 'gpt', lines: 3 } });
  // Chain the hashes.
  const p2 = { ...pe2, prev_hash: peHashOf(pe1) };
  pes = [pe0, pe1, p2].map((p) => ({ ...p, pe_hash: peHashOf(p) }));
  const batch = buildBatch({ device_id: DEVICE, seq: 1, prev_batch_hash: 'genesis', created_at_ms: T0 + 5000, pes });
  const leaves = batch.acts.map(actLeafOf);
  expect(actsRootOf(batch.acts)).toBe(batch.acts_root);
  const batchHash = batchHashOf(batch);
  inclusionOf = (i) => ({ act_index: i, act_proof: merkleProofOf(leaves, i), acts_root: batch.acts_root, batch: { device_id: DEVICE, actor_id: ACTOR, seq: 1, batch_hash: batchHash }, anchor: { day: '2026-10-09', proof: [] } });
});

// ─── the requester (a domain gate) and the presenter ────────────────────────────────────────────
const SEED = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const gateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), SEED]), format: 'der', type: 'pkcs8' });
const gateJwk = (() => { const x = (crypto.createPublicKey(gateKey).export({ format: 'jwk' }) as { x: string }).x; return { kty: 'OKP', crv: 'Ed25519', x, kid: 'k1' }; })();
const NOW = Math.floor(Date.now() / 1000);
const CHAL = 'c'.repeat(64);
const BURN = 'a'.repeat(64);
const BURN2 = 'b'.repeat(64);
const PRED: PredicateRequest = { field: 'work.total', op: 'gte', threshold: 10 };

function challengeWith(disclosures: unknown[], over: Record<string, unknown> = {}): ChallengeEnvelope {
  const normalized = normalizeDisclosureRequests(disclosures);
  if (normalized === null) throw new Error('fixture: malformed disclosures');
  return signChallengeEnvelope({ audience: 'gate.example.com', challenge: CHAL, issuedAt: NOW - 10, expiresAt: NOW + 890, requester: { type: 'domain', id: 'gate.example.com', kid: 'k1' }, predicates: [PRED], disclosures: normalized, ...over }, gateKey);
}

let store: Store;
let ed: ReturnType<typeof makeEd25519Env>;
let agent: ReturnType<typeof makeAgentSigner>;
let principal: PresenterPrincipal;
const anchorOk = { verifyPE: async () => true };
beforeEach(() => {
  store = new Map(); ed = makeEd25519Env(); agent = makeAgentSigner();
  seedBurn(store, BURN, 'aw1');
  seedBurn(store, BURN2, 'aw1');
  principal = { kind: 'agent', walletId: 'aw1', address: agent.address, peOwnerUserId: ACTOR, publicKeyHex: agent.pubkeyHex, standing: {} };
});
function deps(anchor: { verifyPE(b: string, l: string, p: string[]): Promise<boolean> } = anchorOk) {
  return { db: makeDb(store), env: ed.env, vocabulary: async () => FACTS, fetchRequesterKeys: async () => [gateJwk], peAnchor: anchor, hardware: { rootsOverride: { tpm2_quote: [root] } } };
}

/** The presenter's side: sign the binding over the directive + its disclosure commitment, build the body. */
function presentBody(env: ChallengeEnvelope, answers: { request: CanonicalDisclosureRequest; election: 'disclosed' | 'declined'; records?: number[] }[], jti = 'j1', burn = BURN) {
  const directive = { redact: [], predicates: [...(env.predicates ?? [])] };
  const committed: DisclosureAnswer[] = answers.map((a) => ({
    request: a.request, election: a.election,
    ...(a.election === 'disclosed' ? { records: (a.records ?? []).map((i) => ({ pe_id: pes[i].pe_id, pe_hash: pes[i].pe_hash as string, action_type: '-', timestamp: 0, witness: { kind: 'device' as const } })) } : {}),
  }));
  const digest = claimsDigest({ tier: 'reputation', reputation_directive: canonicalReputationDirective(directive), ...(committed.length > 0 ? { disclosures: committed } : {}) });
  const binding = presentationBindingString({ tier: 'reputation', presenter_address: agent.address, aud: env.audience, chal: env.challenge, iat: NOW, exp: NOW + 300, jti, burn_id: burn, claims_digest: digest, requester: { type: 'domain', id: 'gate.example.com' }, chal_exp: env.expiresAt as number });
  return {
    tier: 'reputation', burn_id: burn, audience: env.audience, challenge: env.challenge, iat: NOW, exp: NOW + 300, jti,
    pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex },
    disclosure: directive, challenge_envelope: env,
    disclosures: answers.map((a) => ({ request: a.request, election: a.election, ...(a.election === 'disclosed' ? { records: (a.records ?? []).map((i) => ({ pe_id: pes[i].pe_id, pe_hash: pes[i].pe_hash, pe: pes[i], inclusion: inclusionOf(i) })) } : {}) })),
  };
}
const verifyOpts = (env: ChallengeEnvelope, over: Record<string, unknown> = {}) => ({
  publicKeys: ed.publicKeys, expectedAudience: env.audience, expectedChallenge: env.challenge, expectedPredicates: env.predicates ?? [],
  expectedDisclosures: env.disclosures ?? [], expectedRequester: { type: 'domain' as const, id: 'gate.example.com' }, peAnchorContract: anchorOk, nowSeconds: NOW + 1, ...over,
});

describe('the challenge: disclosure requests are a distinct, signed part of it', () => {
  it('the signing string gains a disclosures line ONLY when requests are named (every pre-existing challenge signs byte-identical bytes)', () => {
    const base = { audience: 'gate.example.com', challenge: CHAL, issuedAt: NOW, expiresAt: NOW + 900, requester: { type: 'domain' as const, id: 'gate.example.com', kid: 'k1' }, predicates: [PRED] };
    const without = challengeSigningString(base);
    expect(challengeSigningString({ ...base, disclosures: [] })).toBe(without);
    const req = canonicalDisclosureRequest({ kind: 'pe', output_digest: DIGEST_A })!;
    expect(challengeSigningString({ ...base, disclosures: [req] })).toBe(`${without}\ndisclosures=${challengeDisclosuresDigest([req])}`);
    // Order-independent, normalized commitment.
    const w = canonicalDisclosureRequest({ kind: 'witness', issuer: rootFingerprint.toUpperCase(), limit: 2, fields: ['metadata.lines', 'metadata.model'] })!;
    expect(challengeDisclosuresDigest([req, w])).toBe(challengeDisclosuresDigest([w, req]));
    expect(w).toEqual({ kind: 'witness', issuer: rootFingerprint, limit: 2, fields: ['metadata.lines', 'metadata.model'] });
  });
  it('RED: a malformed request refuses the whole challenge (an unknown kind, a short digest, a witness request naming nothing, a bad path, an unknown content election, a limit of 0)', () => {
    for (const bad of [
      [{ kind: 'record', output_digest: DIGEST_A }], [{ kind: 'pe', output_digest: 'abc' }], [{ kind: 'witness' }], [{ kind: 'pe', output_digest: DIGEST_A, fields: ['meta data'] }],
      [{ kind: 'pe', output_digest: DIGEST_A, content: ['everything'] }], [{ kind: 'witness', signer: 'dev', limit: 0 }], [{ kind: 'pe', output_digest: DIGEST_A, extra: 1 }],
      [{ kind: 'pe', output_digest: DIGEST_A }, { kind: 'pe', output_digest: DIGEST_A }],
    ]) {
      expect(normalizeDisclosureRequests(bad)).toBeNull();
      expect(parseChallengeEnvelope({ audience: 'gate.example.com', challenge: CHAL, disclosures: bad })).toBeNull();
    }
  });
  it('a signed challenge naming disclosures verifies; one disclosure byte changed → bad_signature', async () => {
    const env = challengeWith([{ kind: 'pe', output_digest: DIGEST_A, fields: ['metadata.lines'] }]);
    expect((await verifyChallengeEnvelope(env, { fetchRequesterKeys: async () => [gateJwk], nowSeconds: NOW })).status).toBe('verified');
    const tampered = parseChallengeEnvelope({ ...env, disclosures: [{ kind: 'pe', output_digest: DIGEST_A, fields: ['metadata.lines', 'metadata.model'] }] })!;
    expect(await verifyChallengeEnvelope(tampered, { fetchRequesterKeys: async () => [gateJwk], nowSeconds: NOW })).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
  });
});

describe('named digest → that record only, metadata floor unless fields/content are requested', () => {
  it('GREEN: the named PE is disclosed as metadata; an unrequested field is ABSENT; it verifies and returns the answer', async () => {
    const env = challengeWith([{ kind: 'pe', output_digest: DIGEST_A }]);
    const r = await producePresentationFromRequest(deps(), principal, presentBody(env, [{ request: env.disclosures![0], election: 'disclosed', records: [0] }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const answers = r.presentation.payload.disclosures!;
    expect(answers).toHaveLength(1);
    expect(answers[0].election).toBe('disclosed');
    const rec = answers[0].records![0];
    expect(rec).toEqual({ pe_id: 'pe_0', pe_hash: pes[0].pe_hash, action_type: 'coding_session', timestamp: T0, witness: { kind: 'device', signer: DEVICE }, output_digest: DIGEST_A });
    expect(rec.fields).toBeUndefined();
    expect(rec.content).toBeUndefined();
    expect(JSON.stringify(r.presentation.payload)).not.toContain('wrote the parser');
    expect(r.presentation.disclosure_proofs).toHaveLength(1);
    // Standing rides beside it, always.
    for (const f of STANDING_ALWAYS_PRESENT_FIELDS) expect(r.presentation.payload.reputation!.facts[f]).toBe(0);
    const v = await verifyPresentation(r.presentation, verifyOpts(env));
    expect(v.valid).toBe(true);
    if (!v.valid) return;
    expect(v.onchain_checked).toBe(true);
    expect(v.disclosures).toEqual(answers);
    expect(v.predicates![0].result).toBe(true);
  });
  it('GREEN: requested fields and elected content appear; an unrequested field stays absent', async () => {
    const env = challengeWith([{ kind: 'pe', output_digest: DIGEST_A, fields: ['metadata.lines', 'output_digests.0.kind', 'metadata.missing'], content: ['description', 'artifacts'] }]);
    const r = await producePresentationFromRequest(deps(), principal, presentBody(env, [{ request: env.disclosures![0], election: 'disclosed', records: [0] }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rec = r.presentation.payload.disclosures![0].records![0];
    expect(rec.fields).toEqual({ 'metadata.lines': 42, 'output_digests.0.kind': 'file', 'metadata.missing': null });
    expect(rec.fields).not.toHaveProperty('metadata.model');
    expect(rec.content).toEqual({ description: 'wrote the parser', artifacts: [{ hash: `sha256:${DIGEST_A}`, kind: 'file' }] });
    expect(rec.content).not.toHaveProperty('intent');
    expect(JSON.stringify(r.presentation.payload)).not.toContain('ship the parser');
    expect((await verifyPresentation(r.presentation, verifyOpts(env))).valid).toBe(true);
  });
  it('RED: a record that does not carry the named digest is refused before anything is consumed', async () => {
    const env = challengeWith([{ kind: 'pe', output_digest: DIGEST_A }]);
    const r = await producePresentationFromRequest(deps(), principal, presentBody(env, [{ request: env.disclosures![0], election: 'disclosed', records: [2] }]));
    expect(r).toMatchObject({ ok: false, status: 400, reason: 'disclosure_record_mismatch' });
    expect(coll(store, 'burn_consumptions').size).toBe(0);
  });
  it('RED: a PE the presenter does not own / a PE not anchored is refused', async () => {
    const env = challengeWith([{ kind: 'pe', output_digest: DIGEST_A }]);
    const other = { ...principal, peOwnerUserId: 'someone_else' };
    expect(await producePresentationFromRequest(deps(), other, presentBody(env, [{ request: env.disclosures![0], election: 'disclosed', records: [0] }]))).toMatchObject({ ok: false, reason: 'pe_not_owned' });
    expect(await producePresentationFromRequest(deps({ verifyPE: async () => false }), principal, presentBody(env, [{ request: env.disclosures![0], election: 'disclosed', records: [0] }]))).toMatchObject({ ok: false, reason: 'pe_not_anchored' });
  });
});

describe('issuer filter → only that issuer\'s records', () => {
  it('GREEN: the hardware-witnessed PE answers an issuer request with the root fingerprint, signer, measurement; RED: a device-witnessed PE under the same request is refused', async () => {
    const env = challengeWith([{ kind: 'witness', issuer: rootFingerprint, limit: 5, fields: ['metadata.lines'] }]);
    const r = await producePresentationFromRequest(deps(), principal, presentBody(env, [{ request: env.disclosures![0], election: 'disclosed', records: [1] }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rec = r.presentation.payload.disclosures![0].records![0];
    expect(rec.witness).toEqual({ kind: 'hardware', scheme: 'tpm2_quote', issuer: rootFingerprint, signer: akSignerSha256, measurement: `sha256:${'07'.repeat(32)}` });
    expect(rec.fields).toEqual({ 'metadata.lines': 7 });
    expect((await verifyPresentation(r.presentation, verifyOpts(env))).valid).toBe(true);
    // RED: pe_0 carries no hardware witness → its witness is the device → not this issuer → refused.
    const red = await producePresentationFromRequest(deps(), principal, presentBody(env, [{ request: env.disclosures![0], election: 'disclosed', records: [1, 0] }], 'j2'));
    expect(red).toMatchObject({ ok: false, reason: 'disclosure_record_mismatch' });
    // RED: a signer request naming another key is refused for the same record.
    const env2 = challengeWith([{ kind: 'witness', signer: 'ff'.repeat(32) }]);
    expect(await producePresentationFromRequest(deps(), principal, presentBody(env2, [{ request: env2.disclosures![0], election: 'disclosed', records: [1] }], 'j3'))).toMatchObject({ ok: false, reason: 'disclosure_record_mismatch' });
    // GREEN: a signer request naming the DEVICE id admits the device-witnessed records.
    const env3 = challengeWith([{ kind: 'witness', signer: DEVICE, limit: 2 }]);
    const ok3 = await producePresentationFromRequest(deps(), principal, presentBody(env3, [{ request: env3.disclosures![0], election: 'disclosed', records: [0, 2] }], 'j4', BURN2));
    expect(ok3.ok).toBe(true);
    if (ok3.ok) expect(ok3.presentation.payload.disclosures![0].records!.map((x) => x.pe_id)).toEqual(['pe_0', 'pe_2']);
  });
  it('RED: a witness whose chain does not reach the pinned root yields no issuer (the record is refused for an issuer request)', async () => {
    const env = challengeWith([{ kind: 'witness', issuer: rootFingerprint }]);
    const d = { ...deps(), hardware: { rootsOverride: { tpm2_quote: [] as X509Certificate[] } } };
    expect(await producePresentationFromRequest(d, principal, presentBody(env, [{ request: env.disclosures![0], election: 'disclosed', records: [1] }]))).toMatchObject({ ok: false, reason: 'disclosure_record_mismatch' });
  });
});

describe('elections: declined is signed as declined; every named request must be answered', () => {
  it('GREEN: a declined request verifies as declined, nothing of the record travels', async () => {
    const env = challengeWith([{ kind: 'pe', output_digest: DIGEST_A, content: ['description'] }, { kind: 'witness', issuer: rootFingerprint }]);
    const r = await producePresentationFromRequest(deps(), principal, presentBody(env, [{ request: env.disclosures![0], election: 'declined' }, { request: env.disclosures![1], election: 'disclosed', records: [] }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = await verifyPresentation(r.presentation, verifyOpts(env));
    expect(v.valid).toBe(true);
    if (!v.valid) return;
    expect(v.disclosures!.map((a) => a.election)).toEqual(['declined', 'disclosed']);
    expect(v.disclosures![1].records).toEqual([]);
    expect(JSON.stringify(r.presentation)).not.toContain('wrote the parser');
    expect(r.presentation.disclosure_proofs).toBeUndefined();
  });
  it('RED: a request left unanswered is refused at issuance (burn untouched) and at verify', async () => {
    const env = challengeWith([{ kind: 'pe', output_digest: DIGEST_A }, { kind: 'witness', issuer: rootFingerprint }]);
    const r = await producePresentationFromRequest(deps(), principal, presentBody(env, [{ request: env.disclosures![0], election: 'declined' }]));
    expect(r).toMatchObject({ ok: false, reason: 'challenge_disclosures_missing' });
    expect(coll(store, 'burn_consumptions').size).toBe(0);
    // A presentation answering a one-request challenge, verified against a two-request expectation.
    const one = challengeWith([{ kind: 'pe', output_digest: DIGEST_A }]);
    const ok = await producePresentationFromRequest(deps(), principal, presentBody(one, [{ request: one.disclosures![0], election: 'declined' }]));
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(await verifyPresentation(ok.presentation, verifyOpts(one, { expectedDisclosures: env.disclosures }))).toEqual({ valid: false, reason: 'disclosures_unanswered' });
    // RED: a pe_fact presentation can never answer a disclosure gate.
    expect(await verifyPresentation({ tier: 'pe_fact', payload: ok.presentation.payload } as unknown as Presentation, verifyOpts(one, { expectedPredicates: [] }))).toEqual({ valid: false, reason: 'disclosures_require_reputation_tier' });
  });
  it('RED: a disclosure the presenter did not sign (election flipped, record swapped) → bad_presenter_pop', async () => {
    const env = challengeWith([{ kind: 'pe', output_digest: DIGEST_A }]);
    const body = presentBody(env, [{ request: env.disclosures![0], election: 'declined' }]);
    const flipped = { ...body, disclosures: [{ request: env.disclosures![0], election: 'disclosed', records: [{ pe_id: pes[0].pe_id, pe_hash: pes[0].pe_hash, pe: pes[0], inclusion: inclusionOf(0) }] }] };
    expect(await producePresentationFromRequest(deps(), principal, flipped)).toMatchObject({ ok: false, reason: 'bad_presenter_pop' });
  });
});

describe('a tampered disclosure fails verification', () => {
  async function issued(): Promise<{ env: ChallengeEnvelope; presentation: Presentation }> {
    const env = challengeWith([{ kind: 'pe', output_digest: DIGEST_A, fields: ['metadata.lines'], content: ['fact_tier'] }]);
    const r = await producePresentationFromRequest(deps(), principal, presentBody(env, [{ request: env.disclosures![0], election: 'disclosed', records: [0] }]));
    if (!r.ok) throw new Error(r.error);
    return { env, presentation: r.presentation };
  }
  /** Re-sign nothing: a tampered REPUTATION payload must fail the Provian JWS; a tampered proof the leaf check. */
  it('RED: a changed field value, a changed election, a dropped record, a swapped proof — each refused', async () => {
    const { env, presentation } = await issued();
    expect((await verifyPresentation(presentation, verifyOpts(env))).valid).toBe(true);
    // The payload is what the JWS covers: any edit to the structured copy is ignored (the JWS wins)…
    const edited = { ...presentation, payload: { ...presentation.payload, disclosures: [] } };
    const v1 = await verifyPresentation(edited, verifyOpts(env));
    expect(v1.valid && v1.disclosures![0].records![0].fields).toEqual({ 'metadata.lines': 42 });
    // …so a forger must forge the JWS, which fails against the Provian key.
    const [h, p, s] = presentation.provian_jws!.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    payload.disclosures[0].records[0].fields['metadata.lines'] = 420;
    const forged = { ...presentation, provian_jws: `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}` };
    expect(await verifyPresentation(forged, verifyOpts(env))).toEqual({ valid: false, reason: 'reputation_jws_bad_signature' });
    // A proof that does not match the disclosed record (another PE's proof under this pe_id) → refused.
    const swapped = { ...presentation, disclosure_proofs: [{ ...presentation.disclosure_proofs![0], leaf: { ...presentation.disclosure_proofs![0].leaf, act: actRecordOf(pes[2]) } }] };
    expect(await verifyPresentation(swapped, verifyOpts(env))).toEqual({ valid: false, reason: 'disclosure_record_invalid' });
    // A dropped proof → refused; the on-chain hop failing → refused.
    expect(await verifyPresentation({ ...presentation, disclosure_proofs: [] }, verifyOpts(env))).toEqual({ valid: false, reason: 'disclosure_record_invalid' });
    expect(await verifyPresentation(presentation, verifyOpts(env, { peAnchorContract: { verifyPE: async () => false } }))).toEqual({ valid: false, reason: 'disclosure_record_invalid' });
    // The token round-trips.
    expect((await verifyPresentation(decodePresentationToken(encodePresentationToken(presentation))!, verifyOpts(env))).valid).toBe(true);
  });
  it('RED (relay-side forgery model): a relay that returned a field the anchored act does not carry is caught by the leaf check', async () => {
    const { env, presentation } = await issued();
    // Re-sign the payload with the SAME relay key but a false field: the JWS verifies, the anchored act does not agree.
    const { signReputationPresentation, loadPresentationSigningKey } = await import('./signer');
    const key = loadPresentationSigningKey(ed.env);
    if (!key.ok) throw new Error('key');
    const payload = JSON.parse(JSON.stringify(presentation.payload));
    payload.disclosures[0].records[0].fields['metadata.lines'] = 420;
    const lying = { ...presentation, payload, provian_jws: signReputationPresentation(payload, key.key) };
    expect(await verifyPresentation(lying, verifyOpts(env))).toEqual({ valid: false, reason: 'disclosure_record_invalid' });
    payload.disclosures[0].records[0].fields['metadata.lines'] = 42;
    payload.disclosures[0].records[0].content.fact_tier.pricing.metadata.lines = 1;
    const lying2 = { ...presentation, payload, provian_jws: signReputationPresentation(payload, key.key) };
    expect(await verifyPresentation(lying2, verifyOpts(env))).toEqual({ valid: false, reason: 'disclosure_record_invalid' });
  });
  it('the commitment the presenter signs is identity-only and order-independent', () => {
    const req = canonicalDisclosureRequest({ kind: 'witness', signer: DEVICE, limit: 2 })!;
    const a: DisclosureAnswer[] = [{ request: req, election: 'disclosed', records: [{ pe_id: 'pe_2', pe_hash: 'ff'.repeat(32), action_type: 'x', timestamp: 1, witness: { kind: 'device' } }, { pe_id: 'pe_0', pe_hash: 'ee'.repeat(32), action_type: 'y', timestamp: 2, witness: { kind: 'hardware' }, fields: { a: 1 } }] }];
    const b: DisclosureAnswer[] = [{ request: req, election: 'disclosed', records: [{ pe_id: 'pe_0', pe_hash: 'ee'.repeat(32), action_type: '-', timestamp: 0, witness: { kind: 'device' } }, { pe_id: 'pe_2', pe_hash: 'ff'.repeat(32), action_type: '-', timestamp: 0, witness: { kind: 'device' } }] }];
    expect(disclosureCommitmentDigest(a)).toBe(disclosureCommitmentDigest(b));
    expect(disclosureCommitmentDigest([{ request: req, election: 'declined' }])).not.toBe(disclosureCommitmentDigest(a));
    expect(parseDisclosureAnswers([{ request: req, election: 'declined', records: [] }])).toBeNull();
    expect(parseDisclosureAnswers([{ request: req, election: 'disclosed', records: [1, 2, 3].map((i) => ({ pe_id: `p${i}`, pe_hash: 'aa'.repeat(32), action_type: 'x', timestamp: 1, witness: { kind: 'device' } })) }])).toBeNull(); // over the request's limit
  });
});
