/**
 * Wave 4 PoP tests - claims-bound challenge primitive used by HIGH-1
 * (agent connect) and HIGH-2 (parent authorization).
 *
 * Coverage:
 *   - Roundtrip: issue → sign → verify → consumed.
 *   - Replay: second verify rejected.
 *   - Wrong key: verify fails.
 *   - Claims mismatch (extra / missing / different): verify fails.
 *   - Purpose mismatch: verify fails (defense for cross-purpose reuse).
 *   - Tampered signature: verify fails.
 */

import { describe, it, expect, beforeEach, beforeAll } from '@jest/globals';
import crypto from 'crypto';

import {
  issuePopChallenge,
  verifyAndConsumePopChallenge,
  issueClaimsPopChallenge,
  verifyAndConsumeClaimsPopChallenge,
  canonicalPopMessage,
} from './proof-of-possession';

interface MemCache {
  isEnabled: () => boolean;
  set: (k: string, v: unknown, ttl: number) => Promise<void>;
  setNx: (k: string, v: unknown, ttl: number) => Promise<boolean>;
  get: <T>(k: string) => Promise<T | null>;
  del: (k: string) => Promise<void>;
  store: Map<string, unknown>;
}

function makeCache(): MemCache {
  const store = new Map<string, unknown>();
  return {
    store,
    isEnabled: () => true,
    set: async (k, v) => { store.set(k, v); },
    setNx: async (k, v) => {
      if (store.has(k)) return false;
      store.set(k, v);
      return true;
    },
    get: async (k) => (store.has(k) ? (store.get(k) as any) : null),
    del: async (k) => { store.delete(k); },
  };
}

function generateSecp256k1KeyPair(): { publicKeyHex: string; privateKey: crypto.KeyObject } {
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const rawPub = ec.publicKey.export({ type: 'spki', format: 'der' });
  // SPKI header is 23 bytes for secp256k1; the last 65 are 04||X||Y.
  const pubBytes = rawPub.subarray(rawPub.length - 65);
  return {
    publicKeyHex: pubBytes.toString('hex'),
    privateKey: ec.privateKey,
  };
}

function signClaimsPop(input: {
  privateKey: crypto.KeyObject;
  purpose: 'agent_connect' | 'parent_authorization';
  challenge: string;
  claims: Record<string, string>;
}): string {
  const message = canonicalPopMessage({
    purpose: input.purpose,
    challenge: input.challenge,
    claims: input.claims,
  });
  const signer = crypto.createSign('SHA256');
  signer.update(message);
  return signer.sign(input.privateKey).toString('hex');
}

function leading04NoPrefixPublicKey(): string {
  for (let value = 1; value < 10_000; value += 1) {
    const ecdh = crypto.createECDH('secp256k1');
    const privateKey = Buffer.alloc(32);
    privateKey.writeUInt32BE(value, 28);
    ecdh.setPrivateKey(privateKey);
    const noPrefix = ecdh.getPublicKey('hex', 'uncompressed').slice(2);
    if (noPrefix.startsWith('04')) return noPrefix;
  }
  throw new Error('leading-04 secp256k1 fixture not found');
}

describe('Wave 4 PoP - claims-bound challenge', () => {
  let cache: MemCache;
  let kp: ReturnType<typeof generateSecp256k1KeyPair>;
  // De-flake: generate the (CPU-heavy) secp256k1 keypair ONCE per file instead of
  // once per test. The per-test keygen in beforeEach made this keygen-heavy file
  // occasionally stall under full parallel-worker load, surfacing as a rare flaky
  // failure on the first test. No test needs a UNIQUE key (the wrong-key case
  // makes its own inline); only the cache must be fresh per test (replay test).
  beforeAll(() => {
    kp = generateSecp256k1KeyPair();
  });
  beforeEach(() => {
    cache = makeCache();
  });

  it('valid signature + claim equality → ok=true (roundtrip)', async () => {
    const claims = { connection_token: 'tok_x', agent_wallet_id: 'wallet_aw_y' };
    const issued = await issueClaimsPopChallenge(cache, {
      purpose: 'agent_connect',
      public_key_hex: kp.publicKeyHex,
      claims,
    });
    const sig = signClaimsPop({
      privateKey: kp.privateKey,
      purpose: 'agent_connect',
      challenge: issued.challenge,
      claims,
    });
    const result = await verifyAndConsumeClaimsPopChallenge(cache, {
      challenge_id: issued.challenge_id,
      purpose: 'agent_connect',
      public_key_hex: kp.publicKeyHex,
      expected_claims: claims,
      signature_hex: sig,
    });
    expect(result.ok).toBe(true);
  });

  it('does not strip a legitimate leading 04 from the 128-hex no-prefix form', async () => {
    const publicKeyHex = leading04NoPrefixPublicKey();
    expect(publicKeyHex).toHaveLength(128);
    expect(publicKeyHex.startsWith('04')).toBe(true);
    const claims = { connection_token: 'tok_leading_04' };
    const issued = await issueClaimsPopChallenge(cache, {
      purpose: 'agent_connect',
      public_key_hex: publicKeyHex,
      claims,
    });
    const result = await verifyAndConsumeClaimsPopChallenge(cache, {
      challenge_id: issued.challenge_id,
      purpose: 'agent_connect',
      public_key_hex: publicKeyHex,
      expected_claims: claims,
      signature_hex: '00',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('signature_invalid');
  });

  it('replay → second verify is rejected (cache delete is single-use)', async () => {
    const claims = { connection_token: 'tok_x', agent_wallet_id: 'wallet_aw_y' };
    const issued = await issueClaimsPopChallenge(cache, {
      purpose: 'agent_connect',
      public_key_hex: kp.publicKeyHex,
      claims,
    });
    const sig = signClaimsPop({
      privateKey: kp.privateKey,
      purpose: 'agent_connect',
      challenge: issued.challenge,
      claims,
    });
    const first = await verifyAndConsumeClaimsPopChallenge(cache, {
      challenge_id: issued.challenge_id,
      purpose: 'agent_connect',
      public_key_hex: kp.publicKeyHex,
      expected_claims: claims,
      signature_hex: sig,
    });
    expect(first.ok).toBe(true);
    const second = await verifyAndConsumeClaimsPopChallenge(cache, {
      challenge_id: issued.challenge_id,
      purpose: 'agent_connect',
      public_key_hex: kp.publicKeyHex,
      expected_claims: claims,
      signature_hex: sig,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('challenge_not_found');
  });

  it('wrong-key signature → reason=signature_invalid', async () => {
    const claims = { parent_wallet_id: 'wallet_aw_a', child_address: '0xabc' };
    const issued = await issueClaimsPopChallenge(cache, {
      purpose: 'parent_authorization',
      public_key_hex: kp.publicKeyHex,
      claims,
    });
    const otherKp = generateSecp256k1KeyPair();
    const sig = signClaimsPop({
      privateKey: otherKp.privateKey,
      purpose: 'parent_authorization',
      challenge: issued.challenge,
      claims,
    });
    const result = await verifyAndConsumeClaimsPopChallenge(cache, {
      challenge_id: issued.challenge_id,
      purpose: 'parent_authorization',
      public_key_hex: kp.publicKeyHex,
      expected_claims: claims,
      signature_hex: sig,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('signature_invalid');
  });

  it('claims mismatch (extra key in expected) → reason=claims_mismatch', async () => {
    const claims = { connection_token: 'tok_x', agent_wallet_id: 'wallet_aw_y' };
    const issued = await issueClaimsPopChallenge(cache, {
      purpose: 'agent_connect',
      public_key_hex: kp.publicKeyHex,
      claims,
    });
    const sig = signClaimsPop({
      privateKey: kp.privateKey,
      purpose: 'agent_connect',
      challenge: issued.challenge,
      claims,
    });
    const result = await verifyAndConsumeClaimsPopChallenge(cache, {
      challenge_id: issued.challenge_id,
      purpose: 'agent_connect',
      public_key_hex: kp.publicKeyHex,
      expected_claims: { ...claims, foreign_field: 'leak' },
      signature_hex: sig,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('claims_mismatch');
  });

  it('claims value mismatch (changed agent_wallet_id) → reason=claims_mismatch', async () => {
    const claims = { connection_token: 'tok_x', agent_wallet_id: 'wallet_aw_y' };
    const issued = await issueClaimsPopChallenge(cache, {
      purpose: 'agent_connect',
      public_key_hex: kp.publicKeyHex,
      claims,
    });
    const sig = signClaimsPop({
      privateKey: kp.privateKey,
      purpose: 'agent_connect',
      challenge: issued.challenge,
      claims,
    });
    const result = await verifyAndConsumeClaimsPopChallenge(cache, {
      challenge_id: issued.challenge_id,
      purpose: 'agent_connect',
      public_key_hex: kp.publicKeyHex,
      expected_claims: { connection_token: 'tok_x', agent_wallet_id: 'wallet_aw_attacker' },
      signature_hex: sig,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('claims_mismatch');
  });

  it('purpose mismatch → reason=purpose_mismatch (cross-purpose reuse blocked)', async () => {
    const claims = { connection_token: 'tok_x', agent_wallet_id: 'wallet_aw_y' };
    const issued = await issueClaimsPopChallenge(cache, {
      purpose: 'agent_connect',
      public_key_hex: kp.publicKeyHex,
      claims,
    });
    const sig = signClaimsPop({
      privateKey: kp.privateKey,
      purpose: 'agent_connect',
      challenge: issued.challenge,
      claims,
    });
    const result = await verifyAndConsumeClaimsPopChallenge(cache, {
      challenge_id: issued.challenge_id,
      purpose: 'parent_authorization',
      public_key_hex: kp.publicKeyHex,
      expected_claims: claims,
      signature_hex: sig,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('purpose_mismatch');
  });

  it('tampered signature byte → reason=signature_invalid', async () => {
    const claims = { connection_token: 'tok_x', agent_wallet_id: 'wallet_aw_y' };
    const issued = await issueClaimsPopChallenge(cache, {
      purpose: 'agent_connect',
      public_key_hex: kp.publicKeyHex,
      claims,
    });
    const sig = signClaimsPop({
      privateKey: kp.privateKey,
      purpose: 'agent_connect',
      challenge: issued.challenge,
      claims,
    });
    const tampered = sig.slice(0, -2) + (sig.slice(-2) === 'ff' ? '00' : 'ff');
    const result = await verifyAndConsumeClaimsPopChallenge(cache, {
      challenge_id: issued.challenge_id,
      purpose: 'agent_connect',
      public_key_hex: kp.publicKeyHex,
      expected_claims: claims,
      signature_hex: tampered,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(['signature_invalid', 'signature_verify_error']).toContain(result.reason);
  });
});

describe('agent registration PoP context', () => {
  it('binds registration ID, agent ID, and recovery generation to a fresh challenge', async () => {
    const cache = makeCache();
    const kp = generateSecp256k1KeyPair();
    const publicKey = kp.publicKeyHex.slice(2);
    const context = {
      registration_id: 'agent-registration-proof-context-0001',
      agent_id: 'proof-agent',
      credential_recovery_generation: 7,
    };
    const issued = await issuePopChallenge(cache, publicKey, context);
    const signer = crypto.createSign('SHA256');
    signer.update(issued.challenge);
    const signature = signer.sign(kp.privateKey).toString('hex');
    const verified = await verifyAndConsumePopChallenge(
      cache,
      issued.challenge_id,
      publicKey,
      signature,
      { registration_id: context.registration_id, agent_id: context.agent_id },
    );
    expect(verified).toEqual({ ok: true, registration_context: context });
  });

  it('rejects reuse under a different registration or agent identity', async () => {
    const cache = makeCache();
    const kp = generateSecp256k1KeyPair();
    const publicKey = kp.publicKeyHex.slice(2);
    const issued = await issuePopChallenge(cache, publicKey, {
      registration_id: 'agent-registration-proof-context-0002',
      agent_id: 'proof-agent',
      credential_recovery_generation: null,
    });
    const signer = crypto.createSign('SHA256');
    signer.update(issued.challenge);
    const signature = signer.sign(kp.privateKey).toString('hex');
    await expect(verifyAndConsumePopChallenge(
      cache,
      issued.challenge_id,
      publicKey,
      signature,
      { registration_id: 'agent-registration-different-0002', agent_id: 'other-agent' },
    )).resolves.toEqual({ ok: false, reason: 'challenge_not_found' });
  });

  it('allows exactly one concurrent redemption of a valid signature', async () => {
    const cache = makeCache();
    const kp = generateSecp256k1KeyPair();
    const publicKey = kp.publicKeyHex.slice(2);
    const context = {
      registration_id: 'agent-registration-concurrent-0001',
      agent_id: 'proof-agent-concurrent',
      credential_recovery_generation: null,
    };
    const issued = await issuePopChallenge(cache, publicKey, context);
    const signer = crypto.createSign('SHA256');
    signer.update(issued.challenge);
    const signature = signer.sign(kp.privateKey).toString('hex');
    const results = await Promise.all([
      verifyAndConsumePopChallenge(cache, issued.challenge_id, publicKey, signature, context),
      verifyAndConsumePopChallenge(cache, issued.challenge_id, publicKey, signature, context),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: 'challenge_consume_failed' },
    ]);
  });
});
