import {openTestPrivateRequest} from './private-request.test-support';
/**
 * Burn-to-present (agent side) — binding conformance + present() round-trip.
 *
 * The binding is a CROSS-PACKAGE contract with the backend
 * (provian-backend/src/core/presentation/*). These tests pin the exact bytes: the
 * SAME fixed vector is asserted here and in the backend's presentation.test.ts, so
 * if either package's binding drifts, its own test reddens. A drift here would make
 * every agent presentation fail the backend's presenter-pop check.
 */
import { createHash, createVerify, createPublicKey } from 'crypto';
import { describe, it, expect } from 'vitest';
import {
  presentationBindingString,
  claimsDigest,
  canonicalReputationDirective,
  buildAgentPresentationRequest,
  burnIdForTx,
} from './presentation';
import { CommonsInstitutions } from './commons-institutions';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

// Reconstruct the verifying public key EXACTLY as the backend does
// (uncompressedHexToSpkiPem in proof-of-possession.ts), so this test verifies the
// SDK's presenter-pop the SAME way the relay will — a real cross-package guarantee.
function verifyLikeBackend(pubHex: string, message: string, derSigHex: string): boolean {
  const prefix = Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex');
  const der = Buffer.concat([prefix, Buffer.from('04', 'hex'), Buffer.from(pubHex, 'hex')]);
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  return createVerify('SHA256').update(message).verify(key, Buffer.from(derSigHex, 'hex'));
}

// The one fixed cross-package vector (mirrored in the backend test).
const VECTOR = {
  tier: 'reputation' as const,
  presenterAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  aud: 'requester-1',
  chal: 'chal-fixed-000000000',
  iat: 1000,
  exp: 1300,
  jti: 'jti-fixed',
  burnId: 'a'.repeat(64),
};
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

describe('binding conformance (cross-package pin)', () => {
  it('claimsDigest(reputation, empty directive) is sha256 of the exact preimage', () => {
    expect(claimsDigest({ tier: 'reputation', directive: {} })).toBe(EMPTY_DIRECTIVE_DIGEST);
  });

  it('claimsDigest(pe_fact) sorts pe_id:envelope_hash pairs and hashes the exact preimage', () => {
    expect(claimsDigest({ tier: 'pe_fact', peFacts: [{ peId: 'pe-b', envelopeHash: '0xBB' }, { peId: 'pe-a', envelopeHash: '0xAA' }] })).toBe(sha('pe_fact\npe-a:0xaa\npe-b:0xbb'));
  });

  it('presentationBindingString matches the pinned vector byte-for-byte', () => {
    expect(presentationBindingString({ ...VECTOR, claimsDigest: EMPTY_DIRECTIVE_DIGEST })).toBe(EXPECTED_BINDING);
  });

  it('canonicalReputationDirective sorts redactions and predicates deterministically', () => {
    const c = canonicalReputationDirective({ redact: ['b', 'a'], predicates: [{ field: 'z', op: 'gte', threshold: 1 }, { field: 'a', op: 'lt', threshold: 2 }] });
    expect(c.redact).toEqual(['a', 'b']);
    expect(c.predicates[0].field).toBe('a');
  });
});

describe('burnIdForTx — cross-package pin ', () => {
  it('matches the relay burn id for the pinned tx (case-insensitive)', () => {
    expect(burnIdForTx('base', '0x' + 'AB'.repeat(32))).toBe('9246ac10a914282f7315fc97226a5cf071f3c5d62ae302ae054dc03cc3a61fcd');
    expect(burnIdForTx('base', '0x' + 'ab'.repeat(32))).toBe('9246ac10a914282f7315fc97226a5cf071f3c5d62ae302ae054dc03cc3a61fcd');
  });
  it('is exported from the package entry (the CHANGELOG tells consumers to call it)', async () => {
    const pkg = await import('./index.js');
    expect(pkg.burnIdForTx('base', '0x' + 'ab'.repeat(32))).toBe('9246ac10a914282f7315fc97226a5cf071f3c5d62ae302ae054dc03cc3a61fcd');
  });
  it('a pipelined request carries the burn and binds its id; RED: a mismatched burnId is refused', () => {
    const tx = '0x' + 'ab'.repeat(32);
    const base = { privateKeyHex: 'a'.repeat(64), tier: 'pe_fact' as const, audience: 'aud', challenge: 'c'.repeat(64), nowSeconds: 1000, jti: 'j1' };
    const { body } = buildAgentPresentationRequest({ ...base, burnTx: { txHash: tx, amountAtomic: '5' } });
    expect(body.burn_id).toBe('9246ac10a914282f7315fc97226a5cf071f3c5d62ae302ae054dc03cc3a61fcd');
    expect(body.burn).toEqual({ tx_hash: tx, amount_atomic: '5', chain: 'base' });
    expect(() => buildAgentPresentationRequest({ ...base, burnId: 'f'.repeat(64), burnTx: { txHash: tx, amountAtomic: '5' } })).toThrow();
  });
});

describe('buildAgentPresentationRequest', () => {
  const KEY = '0x' + '11'.repeat(32);
  it('signs the binding with the agent key and produces a well-formed body', () => {
    const { body, binding } = buildAgentPresentationRequest({
      privateKeyHex: KEY, tier: 'reputation', burnId: 'a'.repeat(64), audience: 'r', challenge: 'chal-1616161616161616', ttlSeconds: 300, nowSeconds: 1000, jti: 'j1', disclosure: {},
    });
    expect(body.tier).toBe('reputation');
    expect(body.iat).toBe(1000);
    expect(body.exp).toBe(1300);
    expect(body.pop.scheme).toBe('ecdsa_sha256_secp256k1');
    expect(body.pop.pubkey.length).toBe(128); // uncompressed secp256k1, no 04
    expect(/^[0-9a-f]+$/.test(body.pop.signature)).toBe(true); // DER hex
    expect(body.disclosure).toEqual({ redact: [], predicates: [] });
    expect(binding).toContain('tier=reputation');
    // The presenter-pop verifies the SAME way the backend relay verifies it.
    expect(verifyLikeBackend(body.pop.pubkey, binding, body.pop.signature)).toBe(true);
    // RED: a tampered binding does not verify.
    expect(verifyLikeBackend(body.pop.pubkey, binding + 'x', body.pop.signature)).toBe(false);
  });

  it('clamps an over-long ttl to the max window', () => {
    const { body } = buildAgentPresentationRequest({ privateKeyHex: KEY, tier: 'pe_fact', burnId: 'a'.repeat(64), audience: 'r', challenge: 'chal-1616161616161616', ttlSeconds: 999999, nowSeconds: 1000, jti: 'j1', peFacts: [{ peId: 'pe-1', envelopeHash: '0xh' }] });
    expect(body.exp - body.iat).toBe(900); // PRESENTATION_MAX_TTL_SECONDS
    expect(body.pe_facts).toEqual([{ pe_id: 'pe-1', envelope_hash: '0xh' }]);
  });
});

describe('CommonsInstitutions.present() round-trip', () => {
  it('POSTs the signed body to /present and returns the token', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};
    const fetchStub = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = openTestPrivateRequest(JSON.parse(String(init?.body ?? '{}')),url,init?.headers);
      return { ok: true, status: 200, json: async () => ({ tier: 'reputation', presentation: { tier: 'reputation' }, token: 'opaque-token-xyz' }) };
    }) as unknown as typeof fetch;

    const institutions = new CommonsInstitutions({ relayUrl: 'https://api.provian.ai', walletId: 'wallet_aw_1', apiKey: 'pvn_live_x', apiSecret: 'pvns_y', fetch: fetchStub });
    const res = await institutions.present({ privateKeyHex: '0x' + '22'.repeat(32), tier: 'reputation', burnId: 'a'.repeat(64), audience: 'requester-1', challenge: 'chal-1616161616161616', disclosure: { redact: ['streak_days'] } });

    expect(capturedUrl).toBe('https://api.provian.ai/v1/agent/wallet/wallet_aw_1/present');
    expect(capturedBody.tier).toBe('reputation');
    expect((capturedBody.pop as { scheme: string }).scheme).toBe('ecdsa_sha256_secp256k1');
    expect((capturedBody.disclosure as { redact: string[] }).redact).toEqual(['streak_days']);
    expect(res.token).toBe('opaque-token-xyz');
  });

  it('recordBurn POSTs the burn tx and returns the burn_id', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchStub = (async (_url: string, init?: RequestInit) => {
      capturedBody = openTestPrivateRequest(JSON.parse(String(init?.body ?? '{}')),_url,init?.headers);
      return { ok: true, status: 200, json: async () => ({ burn_id: 'b'.repeat(64), verified: true }) };
    }) as unknown as typeof fetch;
    const institutions = new CommonsInstitutions({ relayUrl: 'https://api.provian.ai', walletId: 'wallet_aw_1', apiKey: 'pvn_live_x', apiSecret: 'pvns_y', fetch: fetchStub });
    const res = await institutions.recordBurn({ txHash: '0x' + 'c'.repeat(64), chain: 'base', amountAtomic: (15n * 10n ** 18n).toString() });
    expect(capturedBody.tx_hash).toBe('0x' + 'c'.repeat(64));
    expect(res.burnId).toBe('b'.repeat(64));
  });
});

// a presentation against a SIGNED challenge signs the v2 binding (req= / chal_exp=) and
// carries the envelope to /present; an unsigned envelope leaves v1 byte-identical.
describe('buildAgentPresentationRequest — v2 against a signed challenge ', () => {
  const SIGNED = {
    v: 1, audience: 'wallet_aw_test1', challenge: 'b'.repeat(64), issuedAt: 1790000000, expiresAt: 1790003600,
    requester: { type: 'wallet' as const, id: 'wallet_aw_test1', address: '0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5', kid: 'provian-commerce-2026-08a' },
    sig: '3T4r5igsr6mP2cyg34xzcnzFFYu-KOOMp23lJ6YR7wHgQNmTvcOI_7UbcLQDo30-7ld1efnQc2UQXAvMCDapDA',
  };
  const base = { privateKeyHex: 'a'.repeat(64), tier: 'pe_fact' as const, burnId: 'e'.repeat(64), audience: SIGNED.audience, challenge: SIGNED.challenge, nowSeconds: 1790000100, jti: 'pres_y', peFacts: [] };

  it('signed envelope → v2 binding with the envelope requester + expiresAt, and challenge_envelope in the body', () => {
    const { body, binding } = buildAgentPresentationRequest({ ...base, challengeEnvelope: SIGNED });
    const lines = binding.split('\n');
    expect(lines[0]).toBe('provian-presentation-v2');
    expect(lines.slice(-2)).toEqual(['req=wallet:wallet_aw_test1:0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5', 'chal_exp=1790003600']);
    expect(body.challenge_envelope).toEqual(SIGNED);
    expect(verifyLikeBackend(body.pop.pubkey, binding, body.pop.signature)).toBe(true);
  });

  it('unsigned envelope → the v1 binding, byte-identical to building without it', () => {
    const plain = buildAgentPresentationRequest(base);
    const withUnsigned = buildAgentPresentationRequest({ ...base, challengeEnvelope: { audience: SIGNED.audience, challenge: SIGNED.challenge } });
    expect(withUnsigned.binding).toBe(plain.binding);
    expect(withUnsigned.binding.startsWith('provian-presentation-v1\n')).toBe(true);
    expect(withUnsigned.body.challenge_envelope).toBeUndefined();
  });

  it('RED: an envelope for a different nonce is refused', () => {
    expect(() => buildAgentPresentationRequest({ ...base, challenge: 'c'.repeat(64), challengeEnvelope: SIGNED })).toThrow(/do not match/);
  });
});
