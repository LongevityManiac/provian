import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  computePromiseDigest,
  humanPromiseSignMessage,
  signHumanPromiseWithKey,
  verifyHumanPromiseSignature,
  HUMAN_PROMISE_SIGN_VERSION,
} from './promiseSigning';

// the device-local SHA-256 "tamper tags" are GONE — a human promise's
// create / accept / counter / close-out are signed with the wallet's secp256k1 key
// (EIP-191). This proves the mobile signing surface: the digest is deterministic
// and shared, the signed message matches the backend format, and a real signature
// verifies — while a tampered digest / phase / address is REFUSED (the negative
// controls that make the positive assertions meaningful, per).

// A fixed throwaway key (NOT a real wallet) so the digest/signature are stable.
const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const WALLET = new ethers.Wallet(PK);
const ADDR = WALLET.address; // 0x70997970C51812dc3A010C7d01b50e0d17dc79C8

const TERMS = {
  promiseId: 'promise-123',
  creatorAddress: ADDR,
  theyGave: 'Tamales',
  theyOwe: '50 pesos',
  dueDate: 1_800_000_000_000,
  createdAt: 1_700_000_000_000,
};

describe('promiseSigning — digest', () => {
  it('is a lowercase 64-hex sha256 and is deterministic across calls', async () => {
    const a = await computePromiseDigest(TERMS);
    const b = await computePromiseDigest({ ...TERMS });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it('lowercases the creator address so both parties compute the SAME digest', async () => {
    const lower = await computePromiseDigest({ ...TERMS, creatorAddress: ADDR.toLowerCase() });
    const upper = await computePromiseDigest({ ...TERMS, creatorAddress: ADDR.toUpperCase() });
    expect(lower).toBe(upper);
  });

  it('changes when any bound term changes (negative control: not a constant)', async () => {
    const base = await computePromiseDigest(TERMS);
    expect(await computePromiseDigest({ ...TERMS, theyOwe: '51 pesos' })).not.toBe(base);
    expect(await computePromiseDigest({ ...TERMS, promiseId: 'other' })).not.toBe(base);
    expect(await computePromiseDigest({ ...TERMS, dueDate: null })).not.toBe(base);
  });
});

describe('promiseSigning — signed message format (must match the backend)', () => {
  it('is version|phase|promiseId|digest', () => {
    const msg = humanPromiseSignMessage('create', 'p1', 'a'.repeat(64));
    expect(msg).toBe(`${HUMAN_PROMISE_SIGN_VERSION}|create|p1|${'a'.repeat(64)}`);
    expect(HUMAN_PROMISE_SIGN_VERSION).toBe('provian.promise.v1');
  });
});

describe('promiseSigning — EIP-191 sign/verify round-trip', () => {
  it('a real signature recovers to the signing wallet for each phase', async () => {
    const digest = await computePromiseDigest(TERMS);
    for (const phase of ['create', 'accept', 'counter', 'closeout'] as const) {
      const sig = await signHumanPromiseWithKey(PK, phase, TERMS.promiseId, digest);
      expect(verifyHumanPromiseSignature({
        phase, promiseId: TERMS.promiseId, digest, signature: sig, expectedAddress: ADDR,
      })).toBe(true);
    }
  });

  it('verify is case-insensitive on the expected address', async () => {
    const digest = await computePromiseDigest(TERMS);
    const sig = await signHumanPromiseWithKey(PK, 'create', TERMS.promiseId, digest);
    expect(verifyHumanPromiseSignature({
      phase: 'create', promiseId: TERMS.promiseId, digest, signature: sig,
      expectedAddress: ADDR.toLowerCase(),
    })).toBe(true);
  });

  // NEGATIVE CONTROLS — each must FAIL, or the positive assertions above prove
  // nothing (a guard that cannot fail is no guard).
  it('REFUSES a signature over a TAMPERED digest', async () => {
    const digest = await computePromiseDigest(TERMS);
    const sig = await signHumanPromiseWithKey(PK, 'create', TERMS.promiseId, digest);
    const tampered = await computePromiseDigest({ ...TERMS, theyOwe: '999 pesos' });
    expect(verifyHumanPromiseSignature({
      phase: 'create', promiseId: TERMS.promiseId, digest: tampered, signature: sig, expectedAddress: ADDR,
    })).toBe(false);
  });

  it('REFUSES a create signature replayed as a closeout (phase is domain-separated)', async () => {
    const digest = await computePromiseDigest(TERMS);
    const sig = await signHumanPromiseWithKey(PK, 'create', TERMS.promiseId, digest);
    expect(verifyHumanPromiseSignature({
      phase: 'closeout', promiseId: TERMS.promiseId, digest, signature: sig, expectedAddress: ADDR,
    })).toBe(false);
  });

  it('REFUSES a signature that recovers to a DIFFERENT wallet', async () => {
    const digest = await computePromiseDigest(TERMS);
    const sig = await signHumanPromiseWithKey(PK, 'create', TERMS.promiseId, digest);
    const other = ethers.Wallet.createRandom().address;
    expect(verifyHumanPromiseSignature({
      phase: 'create', promiseId: TERMS.promiseId, digest, signature: sig, expectedAddress: other,
    })).toBe(false);
  });

  it('REFUSES empty / malformed signatures and non-address expectations', () => {
    const digest = 'a'.repeat(64);
    expect(verifyHumanPromiseSignature({ phase: 'create', promiseId: 'p', digest, signature: '', expectedAddress: ADDR })).toBe(false);
    expect(verifyHumanPromiseSignature({ phase: 'create', promiseId: 'p', digest, signature: '0xdeadbeef', expectedAddress: ADDR })).toBe(false);
    expect(verifyHumanPromiseSignature({ phase: 'create', promiseId: 'p', digest, signature: '0x', expectedAddress: 'not-an-address' })).toBe(false);
  });
});
