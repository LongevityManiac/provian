/**
 * the human-wallet registration address proof. GREEN: a proof signed by the address's
 * own key, bound to the relay's own (user, device, address) context, inside ±5 minutes. RED: every
 * forgery — another key, another account, another device, another address, a stale or future
 * timestamp, a different EIP-712 domain, a malformed signature.
 */
import { describe, expect, it } from '@jest/globals';
import { ethers } from 'ethers';

import {
  HUMAN_WALLET_REGISTRATION_DOMAIN,
  HUMAN_WALLET_REGISTRATION_TYPES,
  humanWalletRegistrationDigest,
  verifyHumanWalletAddressProof,
} from './human-wallet-address-proof';
import { signAddressProof, testSigner } from './__test-helpers__/address-proof';

const NOW = Date.UTC(2026, 8, 26, 12);
const OWNER = testSigner('11');
const OTHER = testSigner('22');
const ADDR = OWNER.address.toLowerCase();
const CTX = { userId: 'user_owner', deviceId: 'device-1', address: ADDR, nowMs: NOW };

describe('verifyHumanWalletAddressProof', () => {
  it('the domain names Provian (the WalletConnect block refuses any such typed data from a dApp)', () => {
    expect(String(HUMAN_WALLET_REGISTRATION_DOMAIN.name)).toMatch(/provian/i);
    expect(Object.keys(HUMAN_WALLET_REGISTRATION_TYPES)).toEqual(['RegisterHumanWallet']);
  });

  it('the digest vector is the SAME literal the app pins (src/core/wallet/humanWalletAddressProof.test.ts)', () => {
    expect(`0x${humanWalletRegistrationDigest({ user_id: 'user_abc', address: '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a', device_id: 'device-1', timestamp: 1790000000 })}`)
      .toBe('0x275c73190df21fd33698b1f34e0f34b541d5576d0a4db70eee5aaca3fe814343');
  });

  it('GREEN: the key holder\'s proof verifies and yields the digest the transaction consumes', async () => {
    const proof = await signAddressProof(OWNER, { userId: 'user_owner', deviceId: 'device-1', nowMs: NOW });
    const v = verifyHumanWalletAddressProof(proof, CTX);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.proof.signer).toBe(ADDR);
    expect(v.proof.digest).toBe(humanWalletRegistrationDigest({ user_id: 'user_owner', address: ADDR, device_id: 'device-1', timestamp: proof.timestamp }));
    // Checksummed address in the body verifies the same.
    expect(verifyHumanWalletAddressProof(proof, { ...CTX, address: OWNER.address }).ok).toBe(true);
  });

  it('RED: a proof signed by another key is refused signer_mismatch', async () => {
    const forged = await signAddressProof(OTHER, { userId: 'user_owner', deviceId: 'device-1', nowMs: NOW, address: ADDR });
    expect(verifyHumanWalletAddressProof(forged, CTX)).toEqual({ ok: false, reason: 'address_proof_signer_mismatch' });
  });

  it('RED: a genuine proof replayed by ANOTHER account, device or for another address does not verify', async () => {
    const proof = await signAddressProof(OWNER, { userId: 'user_owner', deviceId: 'device-1', nowMs: NOW });
    expect(verifyHumanWalletAddressProof(proof, { ...CTX, userId: 'user_squatter' })).toMatchObject({ ok: false, reason: 'address_proof_signer_mismatch' });
    expect(verifyHumanWalletAddressProof(proof, { ...CTX, deviceId: 'device-2' })).toMatchObject({ ok: false, reason: 'address_proof_signer_mismatch' });
    expect(verifyHumanWalletAddressProof(proof, { ...CTX, address: OTHER.address.toLowerCase() })).toMatchObject({ ok: false });
    expect(verifyHumanWalletAddressProof(proof, { ...CTX, deviceId: null })).toEqual({ ok: false, reason: 'address_proof_device_unbound' });
  });

  it('RED: stale and future timestamps outside ±5 minutes are refused; inside the window verify', async () => {
    for (const [offsetMs, ok] of [[-5 * 60_000 - 1_000, false], [5 * 60_000 + 1_000, false], [-4 * 60_000, true], [4 * 60_000, true]] as const) {
      const proof = await signAddressProof(OWNER, { userId: 'user_owner', deviceId: 'device-1', nowMs: NOW + offsetMs });
      const v = verifyHumanWalletAddressProof(proof, CTX);
      expect(v.ok).toBe(ok);
      if (!ok) expect(v).toEqual({ ok: false, reason: 'address_proof_stale' });
    }
  });

  it('RED: the same struct signed under ANOTHER domain (e.g. the recovery domain) is refused', async () => {
    const timestamp = Math.floor(NOW / 1000);
    const signature = await OWNER.signTypedData(
      { name: 'Provian Relay Recovery', version: '1', chainId: 8453 },
      HUMAN_WALLET_REGISTRATION_TYPES,
      { user_id: 'user_owner', address: ADDR, device_id: 'device-1', timestamp },
    );
    expect(verifyHumanWalletAddressProof({ signature, timestamp }, CTX)).toEqual({ ok: false, reason: 'address_proof_signer_mismatch' });
  });

  it('RED: malformed proofs are refused before any signature recovery', () => {
    expect(verifyHumanWalletAddressProof('0xabc', CTX)).toEqual({ ok: false, reason: 'address_proof_malformed' });
    expect(verifyHumanWalletAddressProof({ signature: '0x12', timestamp: 1 }, CTX)).toEqual({ ok: false, reason: 'address_proof_signature_malformed' });
    expect(verifyHumanWalletAddressProof({ signature: `0x${'ab'.repeat(65)}`, timestamp: 'x' }, CTX)).toEqual({ ok: false, reason: 'address_proof_timestamp_malformed' });
    expect(verifyHumanWalletAddressProof({ signature: `0x${'00'.repeat(65)}`, timestamp: Math.floor(NOW / 1000) }, CTX)).toEqual({ ok: false, reason: 'address_proof_signature_invalid' });
    void ethers;
  });
});
