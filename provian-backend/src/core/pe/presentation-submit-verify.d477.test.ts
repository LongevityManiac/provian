/**
 * relay verify-at-submit (threads,, forum) is fail-closed on two new axes:
 * item 3: a pe_fact verdict is VALID only when the canonical PEAnchor check actually ran
 * (onchain_checked:true); a structural-only pass records `invalid / pe_fact_onchain_unchecked`.
 * A stored predicate list that does not parse is `invalid / malformed_predicates`, never "none".
 */
import crypto from 'crypto';
import { describe, it, expect } from '@jest/globals';
import { ethers } from 'ethers';
import { verifyFreshPresentationToken } from './presentation-submit-verify';
import { presentationBindingString, claimsDigest, buildPeFactCosignPayload, encodePresentationToken, type Presentation } from '../presentation/types';
import { loadPresentationSigningKey, signPeFactCosign } from '../presentation/signer';
import { hashEnvelopeHashLeaf } from '../pvt/merkle';
import type { CommerceAttestationPublicJwk } from '../presentation/jws-key-material';

function setup() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  const pub = publicKey.export({ format: 'jwk' }) as { x: string };
  const env = { ATTESTATION_SIGNING_KEY: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', kid: 'k1', x: priv.x, d: priv.d }) };
  const publicKeys: CommerceAttestationPublicJwk[] = [{ kty: 'OKP', crv: 'Ed25519', kid: 'k1', x: pub.x, use: 'sig', alg: 'EdDSA', key_ops: ['verify'] }];
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const jwk = ec.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const pubkeyHex = Buffer.from(jwk.x, 'base64url').toString('hex').padStart(64, '0') + Buffer.from(jwk.y, 'base64url').toString('hex').padStart(64, '0');
  const address = ethers.computeAddress(`0x04${pubkeyHex}`).toLowerCase();
  const hash = '0x' + 'ab'.repeat(32);
  const claims = [{ pe_id: 'pe-1', envelope_hash: hash }];
  const now = Math.floor(Date.now() / 1000);
  const binding = presentationBindingString({ tier: 'pe_fact', presenter_address: address, aud: 'aw_req', chal: 'c'.repeat(32), iat: now, exp: now + 300, jti: 'j1', burn_id: 'b'.repeat(64), claims_digest: claimsDigest({ tier: 'pe_fact', pe_facts: claims }) });
  const key = loadPresentationSigningKey(env);
  if (!key.ok) throw new Error('key');
  const p: Presentation = {
    tier: 'pe_fact',
    payload: { v: 1, tier: 'pe_fact', iss: address, sub: 'aw1', presenter_address: address, aud: 'aw_req', chal: 'c'.repeat(32), iat: now, exp: now + 300, jti: 'j1', burn_id: 'b'.repeat(64), presenter_pop: { scheme: 'ecdsa_sha256_secp256k1', signature: crypto.createSign('SHA256').update(binding).sign(ec.privateKey, 'hex'), pubkey: pubkeyHex }, pe_facts: claims },
    provian_jws: signPeFactCosign(buildPeFactCosignPayload({ presenter_address: address, burn_id: 'b'.repeat(64), pe_facts: claims, jti: 'j1', iat: now, exp: now + 300 }), key.key),
    proofs: [{ pe_id: 'pe-1', envelope_hash: hash, anchored: true, anchor: { batch_id: '0x' + '11'.repeat(32) }, leaf: { leaf_value: hashEnvelopeHashLeaf(hash) }, merkle_proof: [], verification: {} }],
  };
  return { token: encodePresentationToken(p), publicKeys };
}

describe('verifyFreshPresentationToken — ', () => {
  it('RED item 3: a pe_fact with no reachable anchor contract is INVALID (pe_fact_onchain_unchecked); with the anchor it is valid + onchain_checked', async () => {
    const { token, publicKeys } = setup();
    const input = { token, audience: 'aw_req', challenge: 'c'.repeat(32), predicates: [] };
    expect(await verifyFreshPresentationToken(input, { publicKeys, peAnchorContract: null })).toMatchObject({ verdict: 'invalid', reason: 'pe_fact_onchain_unchecked' });
    expect(await verifyFreshPresentationToken(input, { publicKeys, peAnchorContract: { verifyPE: async () => false } })).toMatchObject({ verdict: 'invalid', reason: 'pe_fact_proof_onchain_invalid' });
    expect(await verifyFreshPresentationToken(input, { publicKeys, peAnchorContract: { verifyPE: async () => true } })).toMatchObject({ verdict: 'valid', onchain_checked: true });
  });

  it('RED: a stored predicate list that does not parse is invalid (malformed_predicates), never "no predicates"', async () => {
    const { token, publicKeys } = setup();
    const r = await verifyFreshPresentationToken({ token, audience: 'aw_req', challenge: 'c'.repeat(32), predicates: [{ field: 'x' }] }, { publicKeys, peAnchorContract: { verifyPE: async () => true } });
    expect(r).toMatchObject({ verdict: 'invalid', reason: 'malformed_predicates' });
  });

  it('item 1 on the relay submit path: a pe_fact answering a request that asked predicates is invalid', async () => {
    const { token, publicKeys } = setup();
    const r = await verifyFreshPresentationToken({ token, audience: 'aw_req', challenge: 'c'.repeat(32), predicates: [{ field: 'work.total', op: 'gte', threshold: 1 }] }, { publicKeys, peAnchorContract: { verifyPE: async () => true } });
    expect(r).toMatchObject({ verdict: 'invalid', reason: 'predicates_require_reputation_tier' });
  });
});
