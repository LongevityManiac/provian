/**
 * CHUNK H Wave 3 unit tests.
 *
 * BLOCKER-2: verifyAttestationCapability fails closed when wallet
 *   attested_security_level is missing.
 * BLOCKER-3: full_governance is derived from preconditions, never
 *   accepted from a request body. Test the derivation function directly.
 * BLOCKER-4: bound-preimage signature verifier - replay rejection,
 *   stale rejection, mismatched method/path/body rejection.
 *
 * BLOCKER-1 (mobile tier resolution) and STEP 5 (the verify endpoint)
 * are exercised via supertest in adjacent integration tests; this file
 * keeps to pure-unit coverage that doesn't need Firestore.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import crypto from 'crypto';

import { verifyAttestationCapability } from './devices';
// deriveFullGovernance (and the whole governance-score module) is deleted;
// its BLOCKER-3 derivation tests are removed below.
import { evaluateBadges, createEarnedBadges } from '../core/agent-wallet/badges';
import { verifyBoundDeviceSignature } from './middleware/device-signature-binding';
import type { AgentWalletDocument } from '../core/agent-wallet/types';

// Restore Wave-3-relevant types without pulling firebase-admin into the unit tests.
type FakeDeviceDoc = { data: () => { attestation_capability: string; status: string } };

function fakeDb(devices: FakeDeviceDoc[]): any {
  return {
    collection() {
      return {
        where() { return this; },
        async get() { return { docs: devices }; },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// BLOCKER-2 fail-closed behaviour
// ---------------------------------------------------------------------------

describe('BLOCKER-2: verifyAttestationCapability fail-closed', () => {
  it('downgrades a hardware claim on a wallet with no attested_security_level', () => {
    const result = verifyAttestationCapability('hardware_tpm', 'human', null);
    expect(result.verifiedCapability).toBe('software');
    expect(result.downgraded).toBe(true);
  });

  it('downgrades a hardware claim on a wallet with explicit "software"', () => {
    const result = verifyAttestationCapability('hardware', 'human', 'software');
    expect(result.verifiedCapability).toBe('software');
    expect(result.downgraded).toBe(true);
  });

  it('honours a hardware claim only when the wallet level is an explicit hardware variant', () => {
    for (const level of ['hardware', 'hardware_tpm', 'hardware_full', 'hardware_partial']) {
      const result = verifyAttestationCapability('hardware', 'human', level);
      expect(result.verifiedCapability).toBe('hardware');
      expect(result.downgraded).toBe(false);
    }
  });

  it('still downgrades agent-owned devices regardless of wallet level', () => {
    const result = verifyAttestationCapability('hardware', 'agent', 'hardware');
    expect(result.verifiedCapability).toBe('software');
    expect(result.downgraded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BLOCKER-3 derivation
// ---------------------------------------------------------------------------

const baseWallet: Pick<AgentWalletDocument, 'id' | 'governance' | 'linked_human_wallet_id'> = {
  id: 'wallet_aw_x',
  linked_human_wallet_id: 'wallet_human_y',
  governance: {
    pe_coverage_enabled: false,
    attestation_enabled: false,
    human_oversight_enabled: false,
    spending_limits_enabled: true, // non-default precondition (b)
    full_governance: false,
  },
};

// the BLOCKER-3 deriveFullGovernance derivation tests are removed —
// the governance-score module and its full_governance derivation are deleted.

describe('BLOCKER-3: evaluateBadges never newly awards governed ', () => {
  // the agent governance layer is gone, so there is no full-governance
  // signal and `governed` is never newly awarded. evaluateBadges no longer takes
  // a `derivedFullGovernance` input.
  it('does not award governed for an otherwise-qualified wallet', () => {
    const wallet = {
      ...baseWallet,
      pe_count: 1,
      created_at: 0,
      streak_days: 0,
      x402_payment_count: 0,
      attestation_count: 0,
      economic_activity_usd: 0,
      badges: [],
      // satisfy the rest of the AgentWalletDocument shape via cast
    } as unknown as AgentWalletDocument;
    const newBadges = evaluateBadges({ wallet });
    expect(newBadges).not.toContain('governed');
  });

  it('does not re-award governed when stored badges already contain it', () => {
    const wallet = {
      ...baseWallet,
      pe_count: 1,
      created_at: 0,
      streak_days: 0,
      x402_payment_count: 0,
      attestation_count: 0,
      economic_activity_usd: 0,
      badges: createEarnedBadges(['governed'], Date.now()),
    } as unknown as AgentWalletDocument;
    const newBadges = evaluateBadges({ wallet });
    expect(newBadges).not.toContain('governed');
  });
});

// ---------------------------------------------------------------------------
// BLOCKER-4 bound-preimage verifier - replay / staleness / binding
// ---------------------------------------------------------------------------

interface MockCache {
  isEnabled: () => boolean;
  setNx: (key: string, value: unknown, ttl: number) => Promise<boolean>;
  store: Map<string, unknown>;
}

function makeMockCache(): MockCache {
  const store = new Map<string, unknown>();
  return {
    store,
    isEnabled: () => true,
    setNx: async (key) => {
      if (store.has(key)) return false;
      store.set(key, true);
      return true;
    },
  };
}

async function generateP256(): Promise<{
  publicKeyHex: string;
  /** Sign the b64url preimage string. Returns 64-byte compact (r||s)
   *  signature over sha256(message). The verifier runs sha256 itself
   *  on the same bytes before calling p256.verify. */
  signMessage: (message: Uint8Array) => Promise<Buffer>;
}> {
  const { webcrypto } = await import('crypto');
  const subtle = (webcrypto as unknown as { subtle: any }).subtle;
  const keyPair = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const pubRaw = await subtle.exportKey('raw', keyPair.publicKey);
  return {
    publicKeyHex: Buffer.from(new Uint8Array(pubRaw)).toString('hex'),
    async signMessage(message: Uint8Array) {
      const sig = await subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keyPair.privateKey,
        message,
      );
      return Buffer.from(new Uint8Array(sig));
    },
  };
}

function buildEnvelope(overrides: Partial<{ mth: string; pth: string; bh: string; iat: number; exp: number; jti: string; aud: string }>): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    mth: 'POST',
    pth: '/v1/pe/submit',
    bh: 'deadbeef',
    iat: now,
    exp: now + 300,
    jti: crypto.randomBytes(16).toString('hex'),
    aud: 'provian-relay-prod',
    ...overrides,
  };
}

async function buildSignature(
  envelopeOverrides: Partial<{ mth: string; pth: string; bh: string; iat: number; exp: number; jti: string; aud: string }>,
  rawBody: string,
  signer: { signMessage: (message: Uint8Array) => Promise<Buffer> },
): Promise<{ header: string; envelope: Record<string, unknown> }> {
  const bh = crypto.createHash('sha256').update(rawBody).digest('hex');
  const envelope = buildEnvelope({ bh, ...envelopeOverrides });
  const json = JSON.stringify(envelope);
  const preimageB64u = Buffer.from(json, 'utf8').toString('base64url');
  const sig = await signer.signMessage(new TextEncoder().encode(preimageB64u));
  return {
    header: `${preimageB64u}.${sig.toString('base64url')}`,
    envelope,
  };
}

describe('BLOCKER-4: verifyBoundDeviceSignature', () => {
  let signer: Awaited<ReturnType<typeof generateP256>>;
  let cache: MockCache;
  const db: any = {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: false }),
      }),
    }),
    runTransaction: async () => Promise.resolve(),
  };

  beforeEach(async () => {
    signer = await generateP256();
    cache = makeMockCache();
  });

  it('accepts a valid bound signature exactly once (replay rejected)', async () => {
    const rawBody = '{"hello":"world"}';
    const { header } = await buildSignature({}, rawBody, signer);

    const first = await verifyBoundDeviceSignature({
      signatureHeader: header,
      rawBody,
      method: 'POST',
      path: '/v1/pe/submit',
      signingPublicKeyHex: signer.publicKeyHex,
      deps: { db, cache: cache as any },
    });
    expect(first.ok).toBe(true);

    const second = await verifyBoundDeviceSignature({
      signatureHeader: header,
      rawBody,
      method: 'POST',
      path: '/v1/pe/submit',
      signingPublicKeyHex: signer.publicKeyHex,
      deps: { db, cache: cache as any },
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('SIG_REPLAY');
  });

  it('rejects a stale signature (exp in the past)', async () => {
    const rawBody = '{"hello":"world"}';
    const past = Math.floor(Date.now() / 1000) - 600;
    const { header } = await buildSignature({ iat: past - 300, exp: past }, rawBody, signer);

    const result = await verifyBoundDeviceSignature({
      signatureHeader: header,
      rawBody,
      method: 'POST',
      path: '/v1/pe/submit',
      signingPublicKeyHex: signer.publicKeyHex,
      deps: { db, cache: cache as any },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SIG_EXP_PAST');
  });

  it('rejects when the request method does not match the envelope', async () => {
    const rawBody = '{}';
    const { header } = await buildSignature({ mth: 'POST' }, rawBody, signer);
    const result = await verifyBoundDeviceSignature({
      signatureHeader: header,
      rawBody,
      method: 'PATCH',
      path: '/v1/pe/submit',
      signingPublicKeyHex: signer.publicKeyHex,
      deps: { db, cache: cache as any },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SIG_METHOD_MISMATCH');
  });

  it('rejects when the request path does not match the envelope', async () => {
    const rawBody = '{}';
    const { header } = await buildSignature({ pth: '/v1/pe/submit' }, rawBody, signer);
    const result = await verifyBoundDeviceSignature({
      signatureHeader: header,
      rawBody,
      method: 'POST',
      path: '/v1/something/else',
      signingPublicKeyHex: signer.publicKeyHex,
      deps: { db, cache: cache as any },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SIG_PATH_MISMATCH');
  });

  it('rejects when the body hash does not match the actual body', async () => {
    const signedBody = '{"a":1}';
    const tamperedBody = '{"a":2}';
    const { header } = await buildSignature({}, signedBody, signer);
    const result = await verifyBoundDeviceSignature({
      signatureHeader: header,
      rawBody: tamperedBody,
      method: 'POST',
      path: '/v1/pe/submit',
      signingPublicKeyHex: signer.publicKeyHex,
      deps: { db, cache: cache as any },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SIG_BODY_HASH_MISMATCH');
  });

  it('rejects a header missing the bound-preimage form (legacy raw signature)', async () => {
    const rawBody = '{}';
    const result = await verifyBoundDeviceSignature({
      // base64url of 64 random bytes - looks like a legacy raw signature.
      signatureHeader: crypto.randomBytes(64).toString('base64url'),
      rawBody,
      method: 'POST',
      path: '/v1/pe/submit',
      signingPublicKeyHex: signer.publicKeyHex,
      deps: { db, cache: cache as any },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SIG_HEADER_FORMAT');
  });

  it('rejects when audience does not match this deployment', async () => {
    const rawBody = '{}';
    const { header } = await buildSignature({ aud: 'provian-relay-staging' }, rawBody, signer);
    const result = await verifyBoundDeviceSignature({
      signatureHeader: header,
      rawBody,
      method: 'POST',
      path: '/v1/pe/submit',
      signingPublicKeyHex: signer.publicKeyHex,
      deps: { db, cache: cache as any },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SIG_AUD_MISMATCH');
  });
});
