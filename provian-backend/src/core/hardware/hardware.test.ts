/**
 * Trust Layer build §2.9 — hardware-rooted witness verifiers. Every scheme has a GREEN (a report
 * that verifies against its scheme root) and RED controls (nonce not bound, chain to an UNPINNED
 * root, tampered signature, signer = actor). NVIDIA is proven against NVIDIA's PUBLISHED sample
 * report + chain and the PUBLISHED device root (no live GPU —).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import crypto, { X509Certificate, type webcrypto } from 'crypto';
import * as x509 from '@peculiar/x509';
import { PINNED_ROOT_FINGERPRINTS, pinnedRootsFor, GCP_CONFIDENTIAL_ISSUER, GCP_CONFIDENTIAL_OIDC_DISCOVERY } from './roots';
import { certFingerprintSha256, parseCertificate, findExtensionValue, oidToDer, spkiSha256, verifyChainToPinnedRoot } from './x509';
import { decodeCbor, encodeCbor } from './cbor';
import { hardwareBindingNonce, canonicalJson } from './binding';
import { admitHardwareWitness, sealedHardwareWitness, actorKeyFingerprints } from './admit';
import { parseNvidiaReport, verifyNvidiaCc } from './nvidia-cc';
import { NVIDIA_HOPPER_SAMPLE_REPORT_HEX, NVIDIA_HOPPER_SAMPLE_CERT_CHAIN_PEM } from './__fixtures__/nvidia-hopper-sample';
import { GCE_CVM_BINDING_NONCE_HEX, GCE_CVM_QUOTE_B64, GCE_CVM_SIGNATURE_B64, GCE_CVM_AK_PUBLIC_TPMT_B64, GCE_CVM_AK_LEAF_PEM, GCE_CVM_AK_ISSUER_PEM, GCE_CVM_SAMPLE_NOW_MS } from './__fixtures__/gce-cvm-ak-sample';
import { verifyTpm2Quote } from './tpm2';
import { resetJwksCacheForTests } from './jwt';
import { resetGcpDiscoveryForTests } from './gcp-confidential';
import { registerAppAttestKey, appAttestRegistrationNonce, appleAssertionDepsFor } from './app-attest-register';
import {
  APP_ATTEST_KEYS_COLLECTION, APP_ATTEST_KEY_OWNER_COLLECTION, KEY_BOUND_TO_OTHER_ACCOUNT, appAttestKeyDocId, appAttestKeyOwnerDocId,
  firestoreAppAttestKeyStore, planAppAttestKeyOwnerMigration, type AppAttestKeyDoc, type AppAttestKeyStore,
} from './app-attest-keys';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import type { HardwareVerifyContext } from './types';

x509.cryptoProvider.set(crypto.webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

const NOW = Date.UTC(2026, 8, 16, 12);
const BODY = { action_type: 'coding_session', description: 'x', metadata: { a: 1 }, output_digests: [{ hash: 'sha256:' + 'ab'.repeat(32), kind: 'file' }] };
const NONCE = hardwareBindingNonce(BODY);
/** sha256(canonicalJson({ purpose, key_id: 'dGVzdC1rZXktaWQtMDAwMDAwMDA=', user_id: 'user_abc' })), base64 — computed independently (openssl). Pinned in the app's AppAttest.test.ts too. */
const APP_ATTEST_BINDING_VECTOR_B64 = 'J+b5sGrLgGEJqLuELwZ8iuLziFeBEyNR3nMwo4F1P/M=';

function ctx(over: Partial<HardwareVerifyContext> = {}): HardwareVerifyContext {
  return { bindingNonce: NONCE, actorKeyFingerprints: new Set(), nowMs: NOW, ...over };
}

interface TestKey { readonly pair: webcrypto.CryptoKeyPair; readonly node: crypto.KeyObject }
async function genKey(alg: 'p256' | 'p384' | 'rsa'): Promise<TestKey> {
  const algorithm = alg === 'rsa'
    ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 }
    : { name: 'ECDSA', namedCurve: alg === 'p256' ? 'P-256' : 'P-384' };
  const pair = await crypto.webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']) as webcrypto.CryptoKeyPair;
  const pkcs8 = Buffer.from(await crypto.webcrypto.subtle.exportKey('pkcs8', pair.privateKey));
  return { pair, node: crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }) };
}
async function mkRoot(cn: string, key: TestKey): Promise<X509Certificate> {
  const alg = key.pair.privateKey.algorithm.name === 'ECDSA' ? { name: 'ECDSA', hash: 'SHA-384' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const c = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01', name: `CN=${cn}`, notBefore: new Date(NOW - 86_400_000), notAfter: new Date(NOW + 365 * 86_400_000),
    signingAlgorithm: alg, keys: key.pair, extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  return new X509Certificate(c.toString('pem'));
}
async function mkLeaf(cn: string, key: TestKey, issuer: X509Certificate, issuerKey: TestKey, extensions: x509.Extension[] = [], ca = false): Promise<X509Certificate> {
  const alg = issuerKey.pair.privateKey.algorithm.name === 'ECDSA' ? { name: 'ECDSA', hash: 'SHA-384' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const c = await x509.X509CertificateGenerator.create({
    serialNumber: crypto.randomBytes(8).toString('hex'), subject: `CN=${cn}`, issuer: issuer.subject.replace(/\n/g, ', '),
    notBefore: new Date(NOW - 86_400_000), notAfter: new Date(NOW + 30 * 86_400_000),
    signingAlgorithm: alg, publicKey: key.pair.publicKey, signingKey: issuerKey.pair.privateKey,
    extensions: [new x509.BasicConstraintsExtension(ca, undefined, true), ...extensions],
  });
  return new X509Certificate(c.toString('pem'));
}
const b64 = (b: Buffer): string => b.toString('base64');

describe('pinned scheme roots', () => {
  it('every pinned PEM re-derives its pinned fingerprint and subject (RED on a swapped root)', () => {
    for (const r of PINNED_ROOT_FINGERPRINTS) {
      const c = parseCertificate(r.pem);
      expect(c).not.toBeNull();
      expect(certFingerprintSha256(c!)).toBe(r.fingerprint);
      expect(c!.subject).toContain(r.subject);
    }
    // SET EQUALITY per scheme: the verifier's root set is EXACTLY the pinned literals — an extra
    // (attacker-appended) root in `parsedRoots()` goes RED here, not just a missing one.
    for (const scheme of ['aws_nitro', 'apple_app_attest', 'nvidia_cc', 'tpm2_quote'] as const) {
      const expected = PINNED_ROOT_FINGERPRINTS.filter((r) => r.scheme === scheme).map((r) => r.fingerprint).sort();
      expect(pinnedRootsFor(scheme).map(certFingerprintSha256).sort()).toEqual(expected);
      expect(expected.length).toBeGreaterThan(0);
    }
    // RED: a self-made root is not pinned anywhere.
    expect(PINNED_ROOT_FINGERPRINTS.map((r) => r.fingerprint)).not.toContain('00'.repeat(32));
  });
});

describe('binding nonce', () => {
  it('sha256 over the canonical body WITHOUT hardware_witness; key order and the slot itself never change it', () => {
    const a = hardwareBindingNonce({ ...BODY, hardware_witness: { scheme: 'tpm2_quote' } });
    const b = hardwareBindingNonce({ output_digests: BODY.output_digests, metadata: { a: 1 }, description: 'x', action_type: 'coding_session' });
    expect(a.equals(NONCE)).toBe(true);
    // Cross-package pin (SDK hardware-witness.test.ts + app hardwareBinding.test.ts carry the same hex).
    expect(NONCE.toString('hex')).toBe('5687bb54f26bcd785b650ac896f304ff759b458b38747e11b476c330c0bac036');
    expect(b.equals(NONCE)).toBe(true);
    expect(hardwareBindingNonce({ ...BODY, description: 'y' }).equals(NONCE)).toBe(false);
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe('{"a":[1,{"d":2}],"b":1}');
  });
});

describe('binding nonce — the relay-stripped identity keys are excluded on every side', () => {
  it('user_id / wallet_id / actor_address never change the nonce (the global middleware deletes them in place before the handler); every other key does', () => {
    const body = { action_type: 'coding_session', description: 'x', metadata: { a: 1 }, output_digests: [{ hash: 'sha256:' + 'ab'.repeat(32), kind: 'file' }] };
    const n = hardwareBindingNonce(body).toString('hex');
    expect(n).toBe('5687bb54f26bcd785b650ac896f304ff759b458b38747e11b476c330c0bac036');
    expect(hardwareBindingNonce({ ...body, actor_address: '0x1234', user_id: 'u', wallet_id: 'w' }).toString('hex')).toBe(n);
    expect(hardwareBindingNonce({ ...body, envelope_id: 'e' }).toString('hex')).not.toBe(n);
  });
  it('metadataWithHardwareWitness NEVER seals a client-supplied metadata.hardware_witness (RED control: the sealed object is the relay\'s, or nothing)', async () => {
    const { metadataWithHardwareWitness } = await import('./admit');
    const client = { a: 1, hardware_witness: { scheme: 'tpm2_quote', admitted: true, forged: 'yes' } };
    expect(metadataWithHardwareWitness(client, null)).toEqual({ a: 1 });
    expect(metadataWithHardwareWitness(client, { present: true, admitted: false, scheme: 'tpm2_quote', reason: 'slot_malformed' })).toEqual({ a: 1, hardware_witness: { present: true, admitted: false, scheme: 'tpm2_quote', reason: 'slot_malformed' } });
    expect(metadataWithHardwareWitness('not-an-object', null)).toBeNull();
  });
});

describe('nvidia_cc — NVIDIA published sample (no live GPU)', () => {
  const input = { scheme: 'nvidia_cc' as const, report: NVIDIA_HOPPER_SAMPLE_REPORT_HEX, cert_chain: NVIDIA_HOPPER_SAMPLE_CERT_CHAIN_PEM };
  const parsed = parseNvidiaReport(Buffer.from(NVIDIA_HOPPER_SAMPLE_REPORT_HEX, 'hex'))!;
  it('parses; the chain reaches the PUBLISHED NVIDIA Device Identity CA; the ECDSA-P384/SHA-384 signature over request||response verifies', () => {
    expect(parsed.numBlocks).toBe(64);
    expect(parsed.signature.length).toBe(96);
    // GREEN: bind to the sample's own response nonce → admitted (the only nonce the sample can carry).
    const v = verifyNvidiaCc(input, ctx({ bindingNonce: parsed.responseNonce }));
    expect(v.admitted).toBe(true);
    expect(v.reason).toBe('verified');
    expect(v.fields?.model).toBe('gh100');
    expect(v.fields?.issuer_root_fingerprint).toBe(PINNED_ROOT_FINGERPRINTS.find((r) => r.scheme === 'nvidia_cc')!.fingerprint);
    expect(v.fields?.measurement_digest).toMatch(/^sha384:[0-9a-f]{96}$/);
    expect(JSON.stringify(v.fields)).not.toContain(NVIDIA_HOPPER_SAMPLE_REPORT_HEX.slice(0, 64)); // raw report never in fields
  });
  it('RED: a nonce that is not THIS submission is recorded, not admitted', () => {
    const v = verifyNvidiaCc(input, ctx());
    expect(v.admitted).toBe(false);
    expect(v.reason).toBe('nonce_not_bound');
    expect(v.fields?.nonce_bound).toBe(false);
  });
  it('RED: one flipped byte in the measurement record fails the signature; a chain to an unpinned root is refused', () => {
    const hex = NVIDIA_HOPPER_SAMPLE_REPORT_HEX;
    const flipped = hex.slice(0, 100) + (hex[100] === '0' ? '1' : '0') + hex.slice(101);
    expect(verifyNvidiaCc({ ...input, report: flipped }, ctx({ bindingNonce: parsed.responseNonce })).reason).toBe('signature_invalid');
    const onlyLeaf = NVIDIA_HOPPER_SAMPLE_CERT_CHAIN_PEM.split('-----END CERTIFICATE-----')[0] + '-----END CERTIFICATE-----';
    expect(verifyNvidiaCc({ ...input, cert_chain: onlyLeaf }, ctx({ bindingNonce: parsed.responseNonce })).reason).toMatch(/^chain:/);
    // RED: the pinned root swapped for a stranger → the sample no longer verifies.
    const strangerCtx = ctx({ bindingNonce: parsed.responseNonce, rootsOverride: { nvidia_cc: [] } });
    expect(verifyNvidiaCc(input, strangerCtx).reason).toBe('chain:no_pinned_root');
  });
});

describe('aws_nitro — COSE_Sign1 attestation document', () => {
  let root: X509Certificate; let leaf: X509Certificate; let rootKey: TestKey; let leafKey: TestKey;
  beforeAll(async () => {
    rootKey = await genKey('p384'); leafKey = await genKey('p384');
    root = await mkRoot('test aws.nitro-enclaves', rootKey);
    leaf = await mkLeaf('i-test.enclave', leafKey, root, rootKey);
  });
  function doc(nonce: Buffer, tamper = false): string {
    const payload = new Map<unknown, unknown>([
      ['module_id', 'i-0abc-enc0123'], ['timestamp', NOW], ['digest', 'SHA384'],
      ['pcrs', new Map([[0, Buffer.alloc(48, 1)], [1, Buffer.alloc(48, 2)]])],
      ['certificate', Buffer.from(leaf.raw)], ['cabundle', [Buffer.from(root.raw)]], ['nonce', nonce],
    ]);
    const protectedBytes = encodeCbor(new Map([[1, -35]]) as never);
    const payloadBytes = encodeCbor(payload as never);
    const sigStructure = encodeCbor(['Signature1', protectedBytes, Buffer.alloc(0), payloadBytes]);
    let sig = crypto.sign('sha384', sigStructure, { key: leafKey.node, dsaEncoding: 'ieee-p1363' });
    if (tamper) sig = Buffer.from(sig.map((b, i) => (i === 3 ? b ^ 0xff : b)));
    return b64(Buffer.concat([Buffer.from([0xd2]), encodeCbor([protectedBytes, new Map() as never, payloadBytes, sig])]));
  }
  it('GREEN with the scheme root; RED: real pinned AWS root refuses a self-made chain; wrong nonce; tampered signature', async () => {
    const good = await admitHardwareWitness({ scheme: 'aws_nitro', document: doc(NONCE) }, ctx({ rootsOverride: { aws_nitro: [root] } }));
    expect(good.admitted).toBe(true);
    expect(good.verdict?.fields?.launch_measurement).toBe(`sha384:${'01'.repeat(48)}`);
    expect(good.verdict?.fields?.attested_time_ms).toBe(NOW);
    const realRoot = await admitHardwareWitness({ scheme: 'aws_nitro', document: doc(NONCE) }, ctx());
    expect(realRoot.admitted).toBe(false);
    expect(realRoot.verdict?.reason).toBe('chain:chain_does_not_reach_pinned_root');
    const wrongNonce = await admitHardwareWitness({ scheme: 'aws_nitro', document: doc(Buffer.alloc(32, 9)) }, ctx({ rootsOverride: { aws_nitro: [root] } }));
    expect(wrongNonce.verdict?.reason).toBe('nonce_not_bound');
    const tampered = await admitHardwareWitness({ scheme: 'aws_nitro', document: doc(NONCE, true) }, ctx({ rootsOverride: { aws_nitro: [root] } }));
    expect(tampered.verdict?.reason).toBe('signature_invalid');
    // RED: signer = actor
    const self = await admitHardwareWitness({ scheme: 'aws_nitro', document: doc(NONCE) }, ctx({ rootsOverride: { aws_nitro: [root] }, actorKeyFingerprints: new Set([spkiSha256(leaf)]) }));
    expect(self.verdict?.reason).toBe('signer_is_actor');
  });
});

describe('tpm2_quote — TPMS_ATTEST + TPMT_SIGNATURE + certified AK', () => {
  let root: X509Certificate; let leaf: X509Certificate; let rootKey: TestKey; let akKey: TestKey;
  beforeAll(async () => {
    rootKey = await genKey('rsa'); akKey = await genKey('rsa');
    root = await mkRoot('test EK/AK CA Root', rootKey);
    leaf = await mkLeaf('gce-ak', akKey, root, rootKey);
  });
  const tpm2b = (b: Buffer): Buffer => Buffer.concat([Buffer.from([(b.length >> 8) & 0xff, b.length & 0xff]), b]);
  function quote(nonce: Buffer): Buffer {
    const parts = [Buffer.from([0xff, 0x54, 0x43, 0x47]), Buffer.from([0x80, 0x18]), tpm2b(Buffer.alloc(0)), tpm2b(nonce)];
    const clock = Buffer.alloc(8 + 4 + 4 + 1); clock.writeBigUInt64BE(123n, 0); clock.writeUInt32BE(1, 8); clock.writeUInt32BE(0, 12); clock[16] = 1;
    const fw = Buffer.alloc(8); fw.writeBigUInt64BE(0x20220715n, 0);
    const sel = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from([0x00, 0x0b, 3, 0x07, 0x00, 0x00])]);
    return Buffer.concat([...parts, clock, fw, sel, tpm2b(Buffer.alloc(32, 7))]);
  }
  function signature(q: Buffer, tamper = false): Buffer {
    let sig = crypto.sign('sha256', q, { key: akKey.node, padding: crypto.constants.RSA_PKCS1_PADDING });
    if (tamper) sig = Buffer.from(sig.map((b, i) => (i === 5 ? b ^ 0x01 : b)));
    return Buffer.concat([Buffer.from([0x00, 0x14, 0x00, 0x0b]), tpm2b(sig)]);
  }
  function akPublic(key: TestKey): Buffer {
    const jwk = crypto.createPublicKey(key.node).export({ format: 'jwk' }) as { n: string };
    const n = Buffer.from(jwk.n, 'base64url');
    const head = Buffer.from([0x00, 0x01, 0x00, 0x0b, 0x00, 0x05, 0x00, 0x72]);
    const params = Buffer.concat([tpm2b(Buffer.alloc(0)), Buffer.from([0x00, 0x10]), Buffer.from([0x00, 0x14, 0x00, 0x0b]), Buffer.from([0x08, 0x00]), Buffer.from([0, 0, 0, 0])]);
    return Buffer.concat([head, params, tpm2b(n)]);
  }
  it('GREEN with the scheme root; RED: the REAL pinned Google root refuses; wrong nonce; tampered signature; an AK that the certificate does not certify', async () => {
    const q = quote(NONCE);
    const base = { scheme: 'tpm2_quote' as const, quote: b64(q), signature: b64(signature(q)), ak_public: b64(akPublic(akKey)), ak_cert_chain: [leaf.toString()] };
    const good = await admitHardwareWitness(base, ctx({ rootsOverride: { tpm2_quote: [root] } }));
    expect(good.admitted).toBe(true);
    expect(good.verdict?.fields?.pcr_selection).toBe('sha256:0,1,2');
    expect(good.verdict?.fields?.pcr_digest).toBe(`sha256:${'07'.repeat(32)}`);
    expect((await admitHardwareWitness(base, ctx())).verdict?.reason).toBe('chain:chain_does_not_reach_pinned_root');
    const wrongQ = quote(Buffer.alloc(32, 1));
    expect((await admitHardwareWitness({ ...base, quote: b64(wrongQ), signature: b64(signature(wrongQ)) }, ctx({ rootsOverride: { tpm2_quote: [root] } }))).verdict?.reason).toBe('nonce_not_bound');
    expect((await admitHardwareWitness({ ...base, signature: b64(signature(q, true)) }, ctx({ rootsOverride: { tpm2_quote: [root] } }))).verdict?.reason).toBe('signature_invalid');
    const other = await genKey('rsa');
    expect((await admitHardwareWitness({ ...base, ak_public: b64(akPublic(other)) }, ctx({ rootsOverride: { tpm2_quote: [root] } }))).verdict?.reason).toBe('ak_public_not_certified');
  });
});

describe('tpm2_quote — LIVE GCE Confidential VM sample (real vTPM, real Google-certified AK)', () => {
  const live = { scheme: 'tpm2_quote' as const, nonce_binding: 'body_sha256' as const, quote: GCE_CVM_QUOTE_B64, signature: GCE_CVM_SIGNATURE_B64, ak_public: GCE_CVM_AK_PUBLIC_TPMT_B64, ak_cert_chain: [GCE_CVM_AK_LEAF_PEM, GCE_CVM_AK_ISSUER_PEM] };
  const ctx = (): HardwareVerifyContext => ({ bindingNonce: Buffer.from(GCE_CVM_BINDING_NONCE_HEX, 'hex'), actorKeyFingerprints: new Set<string>(), nowMs: GCE_CVM_SAMPLE_NOW_MS });
  it('GREEN against the REAL pinned Google EK/AK CA Root (no test seam): admitted, nonce bound, metadata-only fields', () => {
    const v = verifyTpm2Quote(live, ctx());
    expect(v.admitted).toBe(true);
    expect(v.reason).toBe('verified');
    expect(v.fields?.issuer_root_fingerprint).toBe(PINNED_ROOT_FINGERPRINTS.find((r) => r.scheme === 'tpm2_quote')!.fingerprint);
    expect(v.fields?.manufacturer).toBe('Google LLC');
    expect(v.fields?.nonce_bound).toBe(true);
    expect(v.fields?.pcr_selection).toBe('sha256:0,1,2,3,4,5,6,7');
    for (const value of Object.values(v.fields ?? {})) expect(String(value)).not.toMatch(/BEGIN|provian-ai|1337250517445149647/);
  });
  it('the binding nonce in the quote IS the cross-package pin over the fixture body', () => {
    expect(hardwareBindingNonce({ action_type: 'coding_session', description: 'x', metadata: { a: 1 }, output_digests: [{ hash: 'sha256:' + 'ab'.repeat(32), kind: 'file' }] }).toString('hex')).toBe(GCE_CVM_BINDING_NONCE_HEX);
  });
  it('leaf-only chain resolves through the SHIPPED 2026 intermediate (a producer that cannot fetch AIA still admits)', () => {
    expect(verifyTpm2Quote({ ...live, ak_cert_chain: [GCE_CVM_AK_LEAF_PEM] }, ctx()).reason).toBe('verified');
  });
  it('RED: another submission\'s nonce is recorded not admitted; a flipped signature byte fails; the AK as the actor key is refused; expired clock is refused', () => {
    expect(verifyTpm2Quote(live, { ...ctx(), bindingNonce: Buffer.alloc(32, 7) })).toMatchObject({ admitted: false, reason: 'nonce_not_bound' });
    const sig = Buffer.from(GCE_CVM_SIGNATURE_B64, 'base64'); sig[sig.length - 1] ^= 0x01;
    expect(verifyTpm2Quote({ ...live, signature: sig.toString('base64') }, ctx()).admitted).toBe(false);
    const akSpki = spkiSha256(new X509Certificate(GCE_CVM_AK_LEAF_PEM));
    expect(verifyTpm2Quote(live, { ...ctx(), actorKeyFingerprints: new Set([akSpki]) }).reason).toBe('signer_is_actor');
    expect(verifyTpm2Quote(live, { ...ctx(), nowMs: Date.UTC(2057, 0, 1) }).admitted).toBe(false);
  });
});

describe('apple_app_attest — attestation object', () => {
  const APP_ID = 'L83XFY5S26.com.provian.wallet';
  let root: X509Certificate; let inter: X509Certificate; let rootKey: TestKey; let interKey: TestKey;
  beforeAll(async () => {
    rootKey = await genKey('p384'); interKey = await genKey('p384');
    root = await mkRoot('test Apple App Attestation Root CA', rootKey);
    inter = await mkLeaf('test Apple App Attestation CA 1', interKey, root, rootKey, [], true);
  });
  async function attestation(nonce: Buffer, opts: { dev?: boolean; counter?: number; wrongNonce?: boolean } = {}): Promise<string> {
    const credKey = await genKey('p256');
    const jwk = crypto.createPublicKey(credKey.node).export({ format: 'jwk' }) as { x: string; y: string };
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    const credId = crypto.createHash('sha256').update(point).digest();
    const rpIdHash = crypto.createHash('sha256').update(APP_ID).digest();
    const counter = Buffer.alloc(4); counter.writeUInt32BE(opts.counter ?? 0, 0);
    const aaguid = Buffer.from(opts.dev ? 'appattestdevelop' : 'appattest\0\0\0\0\0\0\0', 'latin1');
    const authData = Buffer.concat([rpIdHash, Buffer.from([0x45]), counter, aaguid, Buffer.from([0, 32]), credId]);
    const expected = crypto.createHash('sha256').update(Buffer.concat([authData, opts.wrongNonce ? Buffer.alloc(32, 3) : nonce])).digest();
    const der = Buffer.concat([Buffer.from([0x30, 0x24, 0xa1, 0x22, 0x04, 0x20]), expected]);
    const ext = new x509.Extension('1.2.840.113635.100.8.2', false, der);
    const credCert = await mkLeaf('cred', credKey, inter, interKey, [ext]);
    const obj = new Map<unknown, unknown>([
      ['fmt', 'apple-appattest'],
      ['attStmt', new Map<unknown, unknown>([['x5c', [Buffer.from(credCert.raw), Buffer.from(inter.raw)]], ['receipt', Buffer.alloc(4, 0)]])],
      ['authData', authData],
    ]);
    return b64(encodeCbor(obj as never));
  }
  it('GREEN with the scheme root + app id; RED: real Apple root refuses; wrong nonce; development aaguid recorded not admitted; missing app id fails closed', async () => {
    const good = await admitHardwareWitness({ scheme: 'apple_app_attest', attestation: await attestation(NONCE) }, ctx({ rootsOverride: { apple_app_attest: [root] }, appleAppId: APP_ID }));
    expect(good.admitted).toBe(true);
    expect(good.verdict?.fields?.tee_type).toBe('apple_secure_enclave');
    expect((await admitHardwareWitness({ scheme: 'apple_app_attest', attestation: await attestation(NONCE) }, ctx({ appleAppId: APP_ID }))).verdict?.reason).toBe('chain:chain_does_not_reach_pinned_root');
    expect((await admitHardwareWitness({ scheme: 'apple_app_attest', attestation: await attestation(NONCE, { wrongNonce: true }) }, ctx({ rootsOverride: { apple_app_attest: [root] }, appleAppId: APP_ID }))).verdict?.reason).toBe('nonce_not_bound');
    const dev = await admitHardwareWitness({ scheme: 'apple_app_attest', attestation: await attestation(NONCE, { dev: true }) }, ctx({ rootsOverride: { apple_app_attest: [root] }, appleAppId: APP_ID }));
    expect(dev.admitted).toBe(false);
    expect(dev.verdict?.reason).toBe('development_aaguid');
    expect(dev.verdict?.fields?.nonce_bound).toBe(true);
    expect((await admitHardwareWitness({ scheme: 'apple_app_attest', attestation: await attestation(NONCE) }, ctx({ rootsOverride: { apple_app_attest: [root] } }))).verdict?.reason).toBe('app_id_not_configured');
    expect((await admitHardwareWitness({ scheme: 'apple_app_attest', attestation: await attestation(NONCE) }, ctx({ rootsOverride: { apple_app_attest: [root] }, appleAppId: 'X.com.other' }))).verdict?.reason).toBe('rp_id_mismatch');
  });
  it('DER helpers: the extension scan finds the OID and the nonce', () => {
    expect(oidToDer('1.2.840.113635.100.8.2').toString('hex')).toBe('2a864886f763640802');
  });
});

function jwt(payload: Record<string, unknown>, key: crypto.KeyObject, kid: string, alg: 'RS256' | 'ES256' = 'RS256'): string {
  const h = Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = alg === 'RS256'
    ? crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key, padding: crypto.constants.RSA_PKCS1_PADDING })
    : crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${h}.${p}.${sig.toString('base64url')}`;
}
const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('gcp_confidential_space — Google-signed attestation token', () => {
  let key: TestKey;
  const JWKS = 'https://www.googleapis.com/service_accounts/v1/metadata/jwk/test';
  beforeAll(async () => { key = await genKey('rsa'); resetJwksCacheForTests(); resetGcpDiscoveryForTests(); });
  const fetchFor = (jwks: unknown) => async (url: string) => {
    if (url === GCP_CONFIDENTIAL_OIDC_DISCOVERY) return okJson({ issuer: GCP_CONFIDENTIAL_ISSUER, jwks_uri: JWKS });
    if (url === JWKS) return okJson(jwks);
    return { ok: false, status: 404, json: async () => ({}) };
  };
  it('GREEN: signature against the discovered JWKS, issuer pinned, eat_nonce bound; RED: wrong issuer / expired / unknown kid / wrong nonce', async () => {
    const pub = crypto.createPublicKey(key.node).export({ format: 'jwk' }) as { n: string; e: string };
    const jwks = { keys: [{ kty: 'RSA', kid: 'k1', alg: 'RS256', use: 'sig', n: pub.n, e: pub.e }] };
    const claims = { iss: GCP_CONFIDENTIAL_ISSUER, aud: 'provian', iat: NOW / 1000, exp: NOW / 1000 + 3600, eat_nonce: NONCE.toString('hex'), hwmodel: 'GCP_AMD_SEV', swname: 'CONFIDENTIAL_SPACE', swversion: '250101', secboot: true, dbgstat: 'disabled-since-boot', submods: { container: { image_digest: 'sha256:' + 'cd'.repeat(32) }, gce: { zone: 'us-central1-a', project_id: 'provian-ai' } } };
    const good = await admitHardwareWitness({ scheme: 'gcp_confidential_space', token: jwt(claims, key.node, 'k1') }, ctx({ fetch: fetchFor(jwks) }));
    expect(good.admitted).toBe(true);
    expect(good.verdict?.fields).toMatchObject({ tee_type: 'gcp_amd_sev', model: 'confidential_space', region: 'us-central1', secure_boot: true, debug_enabled: false, image_digest: 'sha256:' + 'cd'.repeat(32) });
    expect((await admitHardwareWitness({ scheme: 'gcp_confidential_space', token: jwt({ ...claims, iss: 'https://evil.example' }, key.node, 'k1') }, ctx({ fetch: fetchFor(jwks) }))).verdict?.reason).toBe('issuer_mismatch');
    expect((await admitHardwareWitness({ scheme: 'gcp_confidential_space', token: jwt({ ...claims, exp: NOW / 1000 - 3600 }, key.node, 'k1') }, ctx({ fetch: fetchFor(jwks) }))).verdict?.reason).toBe('token_expired');
    expect((await admitHardwareWitness({ scheme: 'gcp_confidential_space', token: jwt(claims, key.node, 'k2') }, ctx({ fetch: fetchFor(jwks) }))).verdict?.reason).toBe('signing_key_unknown');
    expect((await admitHardwareWitness({ scheme: 'gcp_confidential_space', token: jwt({ ...claims, eat_nonce: 'ff'.repeat(32) }, key.node, 'k1') }, ctx({ fetch: fetchFor(jwks) }))).verdict?.reason).toBe('nonce_not_bound');
    const other = await genKey('rsa');
    expect((await admitHardwareWitness({ scheme: 'gcp_confidential_space', token: jwt(claims, other.node, 'k1') }, ctx({ fetch: fetchFor(jwks) }))).verdict?.reason).toBe('signature_invalid');
  });
});

describe('azure_attestation — MAA token', () => {
  it('GREEN: x5c key from ${iss}/certs, issuer must be *.attest.azure.net, nonce bound; RED: foreign issuer / wrong nonce', async () => {
    resetJwksCacheForTests();
    const key = await genKey('rsa');
    const cert = await mkRoot('https://sharedeus.eus.attest.azure.net', key);
    const iss = 'https://sharedeus.eus.attest.azure.net';
    const jwks = { keys: [{ kty: 'RSA', kid: 'a1', alg: 'RS256', use: 'sig', x5c: [Buffer.from(cert.raw).toString('base64')] }] };
    const fetchImpl = async (url: string) => (url === `${iss}/certs` ? okJson(jwks) : { ok: false, status: 404, json: async () => ({}) });
    const claims = { iss, iat: NOW / 1000, exp: NOW / 1000 + 600, nbf: NOW / 1000 - 10, 'x-ms-attestation-type': 'sevsnpvm', 'x-ms-sevsnpvm-launchmeasurement': 'AB'.repeat(48), 'x-ms-sevsnpvm-is-debuggable': false, 'x-ms-runtime': { nonce: NONCE.toString('base64url') } };
    const good = await admitHardwareWitness({ scheme: 'azure_attestation', token: jwt(claims, key.node, 'a1') }, ctx({ fetch: fetchImpl }));
    expect(good.admitted).toBe(true);
    expect(good.verdict?.fields).toMatchObject({ tee_type: 'amd_sev_snp', launch_measurement: `sha384:${'ab'.repeat(48)}`, debug_enabled: false });
    expect((await admitHardwareWitness({ scheme: 'azure_attestation', token: jwt({ ...claims, iss: 'https://attest.evil.net' }, key.node, 'a1') }, ctx({ fetch: fetchImpl }))).verdict?.reason).toBe('issuer_not_azure_attestation');
    expect((await admitHardwareWitness({ scheme: 'azure_attestation', token: jwt({ ...claims, 'x-ms-runtime': { nonce: 'nope' } }, key.node, 'a1') }, ctx({ fetch: fetchImpl }))).verdict?.reason).toBe('nonce_not_bound');
  });
});

describe('admission + sealing', () => {
  it('absent slot → not present; malformed → recorded slot_malformed; sealed object never carries the raw report', async () => {
    expect(await admitHardwareWitness(undefined, ctx())).toEqual({ present: false, admitted: false, verdict: null });
    const bad = await admitHardwareWitness({ scheme: 'not-a-scheme' }, ctx());
    expect(bad.present).toBe(true);
    expect(bad.verdict?.reason).toBe('slot_malformed');
    const parsed = parseNvidiaReport(Buffer.from(NVIDIA_HOPPER_SAMPLE_REPORT_HEX, 'hex'))!;
    const adm = await admitHardwareWitness({ scheme: 'nvidia_cc', report: NVIDIA_HOPPER_SAMPLE_REPORT_HEX, cert_chain: NVIDIA_HOPPER_SAMPLE_CERT_CHAIN_PEM }, ctx({ bindingNonce: parsed.responseNonce }));
    const sealed = sealedHardwareWitness(adm)!;
    expect(sealed.admitted).toBe(true);
    expect(sealed.scheme).toBe('nvidia_cc');
    const json = JSON.stringify(sealed);
    expect(json).not.toContain('BEGIN CERTIFICATE');
    expect(json).not.toContain(NVIDIA_HOPPER_SAMPLE_REPORT_HEX.slice(0, 40));
    expect(sealed.report_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sealed.serial_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('actorKeyFingerprints maps a registered SEC1 P-256 device key to its SPKI sha256', async () => {
    const k = await genKey('p256');
    const jwk = crypto.createPublicKey(k.node).export({ format: 'jwk' }) as { x: string; y: string };
    const hex = '04' + Buffer.from(jwk.x, 'base64url').toString('hex') + Buffer.from(jwk.y, 'base64url').toString('hex');
    const fp = actorKeyFingerprints([hex, null, 'garbage']);
    expect(fp.size).toBe(1);
    expect([...fp][0]).toBe(crypto.createHash('sha256').update(crypto.createPublicKey(k.node).export({ type: 'spki', format: 'der' })).digest('hex'));
  });
  it('x509 chain: an expired intermediate or a self-signed non-pinned terminator is refused', async () => {
    const rootKey = await genKey('p256'); const root = await mkRoot('r', rootKey);
    const leafKey = await genKey('p256'); const leaf = await mkLeaf('l', leafKey, root, rootKey);
    expect(verifyChainToPinnedRoot(leaf, [], [root], NOW).ok).toBe(true);
    expect(verifyChainToPinnedRoot(leaf, [], [root], NOW + 400 * 86_400_000).reason).toBe('leaf_not_valid_now');
    expect(verifyChainToPinnedRoot(leaf, [root], [], NOW).reason).toBe('no_pinned_root');
    expect(findExtensionValue(Buffer.from(leaf.raw), '2.5.29.19')).not.toBeNull(); // basicConstraints present
    expect(decodeCbor(encodeCbor(['a', 1, Buffer.from([1, 2])]))).toEqual(['a', 1, Buffer.from([1, 2])]);
  });
});

describe('apple_app_attest — attest ONCE, assert PER PE (the mobile lane)', () => {
  const APP_ID = 'L83XFY5S26.com.provian.wallet';
  function memStore(): AppAttestKeyStore & { docs: Map<string, AppAttestKeyDoc> } {
    const docs = new Map<string, AppAttestKeyDoc>();
    return {
      docs,
      async lookup(u, k) { const d = docs.get(`${u}|${k}`); return d ?? null; },
      async register(doc) { const id = `${doc.user_id}|${doc.key_id}`; if (docs.has(id)) return { created: false }; docs.set(id, doc); return { created: true }; },
      async advance(u, k, counter, nowMs) { const d = docs.get(`${u}|${k}`); if (!d || !(counter > d.counter)) return false; docs.set(`${u}|${k}`, { ...d, counter, last_asserted_at_ms: nowMs }); return true; },
    };
  }

  /** One attested Secure-Enclave key under a test Apple root, with attestations for any account. */
  async function appAttestFixture() {
    const rootKey = await genKey('p384'); const interKey = await genKey('p384');
    const root = await mkRoot('test Apple App Attestation Root CA', rootKey);
    const inter = await mkLeaf('test Apple App Attestation CA 1', interKey, root, rootKey, [], true);
    const credKey = await genKey('p256');
    const jwk = crypto.createPublicKey(credKey.node).export({ format: 'jwk' }) as { x: string; y: string };
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    const credId = crypto.createHash('sha256').update(point).digest();
    const keyIdB64 = credId.toString('base64');
    const rpIdHash = crypto.createHash('sha256').update(APP_ID).digest();
    const authData = Buffer.concat([rpIdHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.from('appattest\0\0\0\0\0\0\0', 'latin1'), Buffer.from([0, 32]), credId]);
    /** The attestation object whose clientDataHash is `clientDataHash` (the app passes the registration binding). */
    const attestationOver = async (clientDataHash: Buffer): Promise<string> => {
      const expected = crypto.createHash('sha256').update(Buffer.concat([authData, clientDataHash])).digest();
      const ext = new x509.Extension('1.2.840.113635.100.8.2', false, Buffer.concat([Buffer.from([0x30, 0x24, 0xa1, 0x22, 0x04, 0x20]), expected]));
      const credCert = await mkLeaf('cred', credKey, inter, interKey, [ext]);
      return b64(encodeCbor(new Map<unknown, unknown>([
        ['fmt', 'apple-appattest'], ['attStmt', new Map<unknown, unknown>([['x5c', [Buffer.from(credCert.raw), Buffer.from(inter.raw)]], ['receipt', Buffer.alloc(2)]])], ['authData', authData],
      ]) as never));
    };
    const assertion = (counter: number, nonce: Buffer, key = credKey): string => {
      const c = Buffer.alloc(4); c.writeUInt32BE(counter, 0);
      const ad = Buffer.concat([rpIdHash, Buffer.from([0x40]), c]);
      const digest = crypto.createHash('sha256').update(Buffer.concat([ad, nonce])).digest();
      const sig = crypto.sign('sha256', digest, { key: key.node, dsaEncoding: 'der' });
      return b64(encodeCbor(new Map<unknown, unknown>([['signature', sig], ['authenticatorData', ad]]) as never));
    };
    return { root, jwk, keyIdB64, attestationOver, assertion };
  }

  it('registration verifies the attestation over the registration nonce and records the key; assertions then admit, replays refuse, a foreign key refuses', async () => {
    const { root, jwk, keyIdB64, attestationOver, assertion } = await appAttestFixture();
    const attestation = await attestationOver(appAttestRegistrationNonce(keyIdB64, 'u1'));
    const store = memStore();
    // RED: the real pinned Apple root refuses a self-made chain at registration.
    expect((await registerAppAttestKey(store, { userId: 'u1', keyId: keyIdB64, attestation, appleAppId: APP_ID, nowMs: NOW })).ok).toBe(false);
    const verdict = (await admitHardwareWitness({ scheme: 'apple_app_attest', attestation, key_id: keyIdB64 }, ctx({ bindingNonce: appAttestRegistrationNonce(keyIdB64, 'u1'), rootsOverride: { apple_app_attest: [root] }, appleAppId: APP_ID }))).verdict!;
    expect(verdict.admitted).toBe(true);
    await store.register({ user_id: 'u1', key_id: keyIdB64, public_key_jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, signer_key_sha256: verdict.fields!.signer_key_sha256, issuer_root_fingerprint: verdict.fields!.issuer_root_fingerprint!, environment: 'production', counter: 0, attested_at_ms: NOW, last_asserted_at_ms: null });
    const deps = appleAssertionDepsFor(store, 'u1', NOW);
    const good = await admitHardwareWitness({ scheme: 'apple_app_attest', key_id: keyIdB64, assertion: assertion(1, NONCE) }, ctx({ appleAppId: APP_ID, appleAssertion: deps }));
    expect(good.admitted).toBe(true);
    expect(good.verdict?.fields?.tee_type).toBe('apple_secure_enclave');
    expect(store.docs.get(`u1|${keyIdB64}`)?.counter).toBe(1);
    // RED: replay (same counter) refused; regression refused; wrong nonce refused; a key the registry never saw refused.
    expect((await admitHardwareWitness({ scheme: 'apple_app_attest', key_id: keyIdB64, assertion: assertion(1, NONCE) }, ctx({ appleAppId: APP_ID, appleAssertion: deps }))).verdict?.reason).toBe('counter_not_advanced');
    expect((await admitHardwareWitness({ scheme: 'apple_app_attest', key_id: keyIdB64, assertion: assertion(2, Buffer.alloc(32, 5)) }, ctx({ appleAppId: APP_ID, appleAssertion: deps }))).verdict?.reason).toBe('assertion_signature_invalid');
    const other = await genKey('p256');
    expect((await admitHardwareWitness({ scheme: 'apple_app_attest', key_id: keyIdB64, assertion: assertion(2, NONCE, other) }, ctx({ appleAppId: APP_ID, appleAssertion: deps }))).verdict?.reason).toBe('assertion_signature_invalid');
    expect((await admitHardwareWitness({ scheme: 'apple_app_attest', key_id: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', assertion: assertion(2, NONCE) }, ctx({ appleAppId: APP_ID, appleAssertion: deps }))).verdict?.reason).toBe('key_not_registered');
    expect((await admitHardwareWitness({ scheme: 'apple_app_attest', key_id: keyIdB64, assertion: assertion(2, NONCE) }, ctx({ appleAppId: APP_ID }))).verdict?.reason).toBe('assertion_registry_unavailable');
    // GREEN again with the next counter.
    expect((await admitHardwareWitness({ scheme: 'apple_app_attest', key_id: keyIdB64, assertion: assertion(2, NONCE) }, ctx({ appleAppId: APP_ID, appleAssertion: deps }))).admitted).toBe(true);
  });

  describe('one attested key backs ONE account (the Firestore registry)', () => {
    it('the registration binding names the account: sha256(canonicalJson({ key_id, purpose, user_id })) — pinned vector shared with the app', () => {
      // The same literal is pinned in src/core/security/AppAttest.test.ts (the app computes these bytes).
      expect(appAttestRegistrationNonce('dGVzdC1rZXktaWQtMDAwMDAwMDA=', 'user_abc').toString('base64')).toBe(APP_ATTEST_BINDING_VECTOR_B64);
      expect(canonicalJson({ purpose: 'provian_app_attest_register', key_id: 'k', user_id: 'u' })).toBe('{"key_id":"k","purpose":"provian_app_attest_register","user_id":"u"}');
      expect(appAttestRegistrationNonce('k'.repeat(24), 'u1').equals(appAttestRegistrationNonce('k'.repeat(24), 'u2'))).toBe(false);
    });

    it('RED: the same key registered under a second account is refused key_bound_to_other_account (old registry accepted it); the owner re-registers idempotently', async () => {
      const { root, keyIdB64, attestationOver } = await appAttestFixture();
      const db = createFakeFirestore();
      const store = firestoreAppAttestKeyStore(db as unknown as Firestore);
      const roots = { apple_app_attest: [root] };
      const a = await registerAppAttestKey(store, { userId: 'userA', keyId: keyIdB64, attestation: await attestationOver(appAttestRegistrationNonce(keyIdB64, 'userA')), appleAppId: APP_ID, nowMs: NOW }, roots);
      expect(a).toMatchObject({ ok: true, created: true });
      // User B holds the SAME physical key and produces a perfectly valid attestation bound to B.
      const b = await registerAppAttestKey(store, { userId: 'userB', keyId: keyIdB64, attestation: await attestationOver(appAttestRegistrationNonce(keyIdB64, 'userB')), appleAppId: APP_ID, nowMs: NOW + 1 }, roots);
      expect(b).toEqual({ ok: false, reason: KEY_BOUND_TO_OTHER_ACCOUNT, status: 409 });
      expect((await db.collection(APP_ATTEST_KEYS_COLLECTION).doc(appAttestKeyDocId('userB', keyIdB64)).get()).exists).toBe(false);
      const owner = (await db.collection(APP_ATTEST_KEY_OWNER_COLLECTION).doc(appAttestKeyOwnerDocId(keyIdB64)).get()).data();
      expect(owner).toMatchObject({ key_id: keyIdB64, user_id: 'userA', counter: 0, source: 'register' });
      const again = await registerAppAttestKey(store, { userId: 'userA', keyId: keyIdB64, attestation: await attestationOver(appAttestRegistrationNonce(keyIdB64, 'userA')), appleAppId: APP_ID, nowMs: NOW + 2 }, roots);
      expect(again).toMatchObject({ ok: true, created: false });
    });

    it('RED: an attestation bound to account A cannot register the key under account B (the nonce names the account)', async () => {
      const { root, keyIdB64, attestationOver } = await appAttestFixture();
      const store = firestoreAppAttestKeyStore(createFakeFirestore() as unknown as Firestore);
      const forA = await attestationOver(appAttestRegistrationNonce(keyIdB64, 'userA'));
      const r = await registerAppAttestKey(store, { userId: 'userB', keyId: keyIdB64, attestation: forA, appleAppId: APP_ID, nowMs: NOW }, { apple_app_attest: [root] });
      expect(r.ok).toBe(false);
      expect(r.ok ? null : r.reason).not.toBe(KEY_BOUND_TO_OTHER_ACCOUNT); // refused by the binding, before the registry
      // GREEN control: the same fixture registers for A (so the refusal above is the binding, not the fixture).
      expect((await registerAppAttestKey(store, { userId: 'userA', keyId: keyIdB64, attestation: forA, appleAppId: APP_ID, nowMs: NOW }, { apple_app_attest: [root] })).ok).toBe(true);
    });

    it('RED: an assertion for account B with account A\'s key is refused; the counter is GLOBAL per key', async () => {
      const { root, keyIdB64, attestationOver, assertion } = await appAttestFixture();
      const db = createFakeFirestore();
      const store = firestoreAppAttestKeyStore(db as unknown as Firestore);
      await registerAppAttestKey(store, { userId: 'userA', keyId: keyIdB64, attestation: await attestationOver(appAttestRegistrationNonce(keyIdB64, 'userA')), appleAppId: APP_ID, nowMs: NOW }, { apple_app_attest: [root] });
      // The pre- world: B also holds a per-(user, key) doc for the same key (legacy double registration).
      const aDoc = (await db.collection(APP_ATTEST_KEYS_COLLECTION).doc(appAttestKeyDocId('userA', keyIdB64)).get()).data() as unknown as AppAttestKeyDoc;
      await db.collection(APP_ATTEST_KEYS_COLLECTION).doc(appAttestKeyDocId('userB', keyIdB64)).set({ ...aDoc, user_id: 'userB', attested_at_ms: NOW + 5 } as unknown as Record<string, unknown>);
      const depsA = appleAssertionDepsFor(store, 'userA', NOW);
      const depsB = appleAssertionDepsFor(store, 'userB', NOW);
      expect((await admitHardwareWitness({ scheme: 'apple_app_attest', key_id: keyIdB64, assertion: assertion(1, NONCE) }, ctx({ appleAppId: APP_ID, appleAssertion: depsA }))).admitted).toBe(true);
      const forB = await admitHardwareWitness({ scheme: 'apple_app_attest', key_id: keyIdB64, assertion: assertion(2, NONCE) }, ctx({ appleAppId: APP_ID, appleAssertion: depsB }));
      expect(forB.admitted).toBe(false);
      expect(forB.verdict?.reason).toBe('key_not_registered');
      expect(await store.advance('userB', keyIdB64, 99, NOW)).toBe(false);
      const owner = (await db.collection(APP_ATTEST_KEY_OWNER_COLLECTION).doc(appAttestKeyOwnerDocId(keyIdB64)).get()).data();
      expect(owner?.counter).toBe(1);
      expect((await admitHardwareWitness({ scheme: 'apple_app_attest', key_id: keyIdB64, assertion: assertion(2, NONCE) }, ctx({ appleAppId: APP_ID, appleAssertion: depsA }))).admitted).toBe(true);
    });

    it('legacy keys (registered before the owner doc) stay valid; a key legacy-registered under two accounts resolves to the EARLIEST attested, at the max counter', async () => {
      const { jwk, keyIdB64, assertion } = await appAttestFixture();
      const db = createFakeFirestore();
      const legacy = (userId: string, attestedAt: number, counter: number): AppAttestKeyDoc => ({ user_id: userId, key_id: keyIdB64, public_key_jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, signer_key_sha256: 's', issuer_root_fingerprint: 'r', environment: 'production', counter, attested_at_ms: attestedAt, last_asserted_at_ms: null });
      await db.collection(APP_ATTEST_KEYS_COLLECTION).doc(appAttestKeyDocId('early', keyIdB64)).set(legacy('early', NOW - 1000, 3) as unknown as Record<string, unknown>);
      await db.collection(APP_ATTEST_KEYS_COLLECTION).doc(appAttestKeyDocId('late', keyIdB64)).set(legacy('late', NOW - 10, 7) as unknown as Record<string, unknown>);
      const store = firestoreAppAttestKeyStore(db as unknown as Firestore);
      expect(await store.lookup('late', keyIdB64)).toBeNull();
      expect((await store.lookup('early', keyIdB64))?.counter).toBe(7);
      // counter 5 <= global 7 → refused even though the early account's own doc saw only 3.
      expect((await admitHardwareWitness({ scheme: 'apple_app_attest', key_id: keyIdB64, assertion: assertion(5, NONCE) }, ctx({ appleAppId: APP_ID, appleAssertion: appleAssertionDepsFor(store, 'early', NOW) }))).verdict?.reason).toBe('counter_not_advanced');
      expect((await admitHardwareWitness({ scheme: 'apple_app_attest', key_id: keyIdB64, assertion: assertion(8, NONCE) }, ctx({ appleAppId: APP_ID, appleAssertion: appleAssertionDepsFor(store, 'early', NOW) }))).admitted).toBe(true);
      // The first advance materialized the owner doc.
      expect((await db.collection(APP_ATTEST_KEY_OWNER_COLLECTION).doc(appAttestKeyOwnerDocId(keyIdB64)).get()).data()).toMatchObject({ user_id: 'early', counter: 8, source: 'legacy_earliest_attested' });
      expect(await store.advance('late', keyIdB64, 50, NOW)).toBe(false);
      // A single-account legacy key keeps working untouched.
      const solo = await appAttestFixture();
      await db.collection(APP_ATTEST_KEYS_COLLECTION).doc(appAttestKeyDocId('solo', solo.keyIdB64)).set({ ...legacy('solo', NOW - 5, 2), key_id: solo.keyIdB64, public_key_jwk: { kty: 'EC', crv: 'P-256', x: solo.jwk.x, y: solo.jwk.y } } as unknown as Record<string, unknown>);
      expect((await admitHardwareWitness({ scheme: 'apple_app_attest', key_id: solo.keyIdB64, assertion: solo.assertion(3, NONCE) }, ctx({ appleAppId: APP_ID, appleAssertion: appleAssertionDepsFor(store, 'solo', NOW) }))).admitted).toBe(true);
    });

    it('migration planner: keeps the earliest owner, disables the rest, reports shared keys; a second run plans nothing', () => {
      const doc = (u: string, k: string, at: number, counter = 0): AppAttestKeyDoc => ({ user_id: u, key_id: k, public_key_jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, signer_key_sha256: 's', issuer_root_fingerprint: 'r', environment: 'production', counter, attested_at_ms: at, last_asserted_at_ms: null });
      const rows = [
        { id: 'b__K1', data: doc('b', 'K1', 20, 4) },
        { id: 'a__K1', data: doc('a', 'K1', 10, 2) },
        { id: 'c__K1', data: doc('c', 'K1', 30, 1) },
        { id: 'a__K2', data: doc('a', 'K2', 5) },
      ];
      const plan = planAppAttestKeyOwnerMigration(rows, new Map(), NOW);
      expect(plan.owners.map((o) => [o.doc.key_id, o.doc.user_id, o.doc.counter])).toEqual([['K1', 'a', 4], ['K2', 'a', 0]]);
      expect(plan.disable.map((d) => d.id).sort()).toEqual(['b__K1', 'c__K1']);
      expect(plan.shared_keys).toEqual([{ key_id: 'K1', owner_user_id: 'a', user_ids: ['a', 'b', 'c'] }]);
      // An existing owner doc wins over "earliest" (never re-point a bound key).
      const pinned = planAppAttestKeyOwnerMigration(rows, new Map([['K1', { key_id: 'K1', user_id: 'c', counter: 9, bound_at_ms: 1, last_asserted_at_ms: null, source: 'register' as const }]]), NOW);
      expect(pinned.disable.map((d) => d.id).sort()).toEqual(['a__K1', 'b__K1']);
      // Idempotent: after applying, nothing left to do.
      const applied = rows.map((r) => (plan.disable.some((d) => d.id === r.id) ? { ...r, data: { ...r.data, disabled_at_ms: NOW, disabled_reason: KEY_BOUND_TO_OTHER_ACCOUNT } } : r));
      const second = planAppAttestKeyOwnerMigration(applied, new Map(plan.owners.map((o) => [o.doc.key_id, o.doc])), NOW);
      expect(second.owners).toEqual([]);
      expect(second.disable).toEqual([]);
    });
  });
});
