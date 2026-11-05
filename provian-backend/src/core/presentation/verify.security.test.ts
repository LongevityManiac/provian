/**
 * F5 / F52 / F58 — the public verifier must NOT fan out one on-chain
 * PEAnchor.verifyPE call per attacker-supplied proof. These RED controls prove:
 *  - a claim/proof count over MAX_PE_FACT_CLAIMS is refused BEFORE any RPC;
 *  - duplicate pe_ids are refused;
 *  - a claimless presentation triggers ZERO on-chain calls (short-circuit);
 *  - only the proofs REFERENCED by a claim are verified (padded proofs are
 *    never called) — the old loop verified every element of `proofs`.
 */
import { describe, it, expect, jest } from '@jest/globals';
import crypto from 'crypto';
import { ethers } from 'ethers';
import { verifyPresentation } from './verify';
import { presentationBindingString, claimsDigest, buildPeFactCosignPayload, type PeFactProof, type Presentation } from './types';
import { hashEnvelopeHashLeaf } from '../pvt/merkle';
import { MAX_PE_FACT_CLAIMS } from './types';
import { signPeFactCosign } from './signer';
import type { CommerceAttestationPublicJwk } from './jws-key-material';

const NOW = Math.floor(Date.now() / 1000);
const AUD = 'requester-1';
const CHAL = 'chal-abcdefghijklmnop';
const BURN = 'a'.repeat(64);

// ─── Provian Ed25519 co-sign key ─────────────────────────────────────
// After every pe_fact verifier REQUIRES the Provian co-sign JWS, so these
// F5/F52/F58 fixtures must carry a valid one to reach the cap/dedupe/RPC-fan-out
// logic under test — otherwise they fail earlier at `pe_fact_not_cosigned`.
function makeProvianCosigner(): { key: { kid: string; privateKey: crypto.KeyObject }; publicKeys: CommerceAttestationPublicJwk[] } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }) as { x: string };
  const kid = 'test-presentation-key-1';
  return {
    key: { kid, privateKey },
    publicKeys: [{ kty: 'OKP', crv: 'Ed25519', kid, x: pub.x, use: 'sig', alg: 'EdDSA', key_ops: ['verify'] }],
  };
}
const provian = makeProvianCosigner();

function agentSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const pubkeyHex = Buffer.from(jwk.x, 'base64url').toString('hex').padStart(64, '0')
    + Buffer.from(jwk.y, 'base64url').toString('hex').padStart(64, '0');
  return {
    pubkeyHex,
    address: ethers.computeAddress(`0x04${pubkeyHex}`).toLowerCase(),
    sign: (m: string) => crypto.createSign('SHA256').update(m).sign(privateKey, 'hex'),
  };
}

function envHash(i: number): string {
  return '0x' + crypto.createHash('sha256').update(`env-${i}`).digest('hex');
}

/** Build a structurally valid pe_fact presentation with a real presenter PoP.
 *  `claimCount` claims, plus `extraProofs` unreferenced proofs appended. */
function makePeFact(claimCount: number, opts: { extraProofs?: number; duplicateFirstPeId?: boolean } = {}): Presentation {
  const agent = agentSigner();
  const claims = Array.from({ length: claimCount }, (_, i) => ({
    pe_id: opts.duplicateFirstPeId && i === 1 ? 'pe_0' : `pe_${i}`,
    envelope_hash: envHash(i),
  }));
  const buildProof = (pe_id: string, envelope_hash: string, batch = 'batch1'): PeFactProof => ({
    pe_id,
    envelope_hash,
    anchored: true,
    anchor: { batch_id: batch },
    leaf: { leaf_value: hashEnvelopeHashLeaf(envelope_hash) },
    merkle_proof: ['0x' + '11'.repeat(32)],
    verification: {},
  });
  const proofs: PeFactProof[] = claims.map((c) => buildProof(c.pe_id, c.envelope_hash));
  for (let i = 0; i < (opts.extraProofs ?? 0); i++) {
    const eh = envHash(1000 + i);
    proofs.push(buildProof(`pe_extra_${i}`, eh));
  }
  const digest = claimsDigest({ tier: 'pe_fact', pe_facts: claims });
  const binding = presentationBindingString({
    tier: 'pe_fact', presenter_address: agent.address, aud: AUD, chal: CHAL,
    iat: NOW, exp: NOW + 300, jti: 'j1', burn_id: BURN, claims_digest: digest,
  });
  // The Provian co-sign REQUIRED by, bound to the exact payload fields.
  const provianJws = signPeFactCosign(
    buildPeFactCosignPayload({ presenter_address: agent.address, burn_id: BURN, pe_facts: claims, jti: 'j1', iat: NOW, exp: NOW + 300 }),
    provian.key,
  );
  return {
    tier: 'pe_fact',
    provian_jws: provianJws,
    payload: {
      v: 1, tier: 'pe_fact', iss: agent.address, sub: 'aw1', presenter_address: agent.address,
      aud: AUD, chal: CHAL, iat: NOW, exp: NOW + 300, jti: 'j1', burn_id: BURN,
      presenter_pop: { scheme: 'ecdsa_sha256_secp256k1', signature: agent.sign(binding), pubkey: agent.pubkeyHex },
      pe_facts: claims,
    },
    proofs,
  } as unknown as Presentation;
}

function mockContract() {
  return { verifyPE: jest.fn(async () => true) };
}
const opts = (c: ReturnType<typeof mockContract>) => ({ expectedAudience: AUD, expectedChallenge: CHAL, nowSeconds: NOW, peAnchorContract: c, publicKeys: provian.publicKeys });

describe('verifyPresentation pe_fact caps (F5/F52/F58)', () => {
  it('happy path: a single valid claim verifies with exactly ONE on-chain call', async () => {
    const c = mockContract();
    const r = await verifyPresentation(makePeFact(1), opts(c));
    expect(r.valid).toBe(true);
    expect(c.verifyPE).toHaveBeenCalledTimes(1);
  });

  it('RED: >MAX_PE_FACT_CLAIMS proofs are refused BEFORE any on-chain call', async () => {
    const c = mockContract();
    const r = await verifyPresentation(makePeFact(MAX_PE_FACT_CLAIMS + 1), opts(c));
    expect(r.valid).toBe(false);
    expect((r as { reason: string }).reason).toBe('pe_fact_too_many_claims');
    expect(c.verifyPE).toHaveBeenCalledTimes(0); // never fans out to the RPC
  });

  it('RED: duplicate pe_ids are refused', async () => {
    const c = mockContract();
    const r = await verifyPresentation(makePeFact(2, { duplicateFirstPeId: true }), opts(c));
    expect(r.valid).toBe(false);
    expect((r as { reason: string }).reason).toBe('pe_fact_duplicate_claim');
    expect(c.verifyPE).toHaveBeenCalledTimes(0);
  });

  it('RED: a claimless presentation makes ZERO on-chain calls (refused before any RPC)', async () => {
    const c = mockContract();
    // 0 claims, but 5 padded proofs — the old loop would call verifyPE 5 times.
    // Post- a zero-claim pe_fact is refused outright (pe_fact_no_claims); the
    // F5 property we assert is unchanged: NO on-chain fan-out for padded proofs.
    const p = makePeFact(0, { extraProofs: 5 });
    const r = await verifyPresentation(p, opts(c));
    expect(r.valid).toBe(false);
    expect((r as { reason: string }).reason).toBe('pe_fact_no_claims');
    expect(c.verifyPE).toHaveBeenCalledTimes(0);
  });

  it('RED: only proofs referenced by a claim are verified (padded proofs are ignored)', async () => {
    const c = mockContract();
    // 3 claims + 2 unreferenced extra proofs (5 total). Old code: 5 calls. New: 3.
    const r = await verifyPresentation(makePeFact(3, { extraProofs: 2 }), opts(c));
    expect(r.valid).toBe(true);
    expect(c.verifyPE).toHaveBeenCalledTimes(3);
  });
});
