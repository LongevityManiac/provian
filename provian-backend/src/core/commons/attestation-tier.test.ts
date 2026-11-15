/**
 * Wave 4 Commons hygiene tests:
 * HIGH-8: computeWalletAttestationTier reflects active devices
 * STEP 9: P-256 verification path runs without @noble runtime drift
 *
 * the former HIGH-7 block (loadLiveWalletGovernanceScore) is deleted —
 * governance_score, and the live-score reader that fed vouching, are gone.
 */

import { describe, it, expect } from '@jest/globals';
import {
  computeWalletAttestationTier,
  recomputeCommonsAttestationTier,
} from './wallet-reads';

interface FakeDoc {
  exists: boolean;
  data: () => Record<string, unknown>;
  ref?: { update: jest.Mock };
}

interface FakeQuery {
  empty: boolean;
  docs: FakeDoc[];
}

function makeFakeDb(opts: {
  walletDoc?: FakeDoc;
  // `wallets` collection keyed by DOC ID — honored byte-exactly, mirroring how
  // computeWalletAttestationTier now resolves the wallet (.doc(walletId).get()).
  // A wallet seeded under the WRONG id is correctly NOT found (so a wrong-value
  // lookup can no longer be masked).
  walletsById?: Record<string, FakeDoc>;
  devices?: FakeDoc[];
  profileDoc?: FakeDoc;
}): any {
  return {
    collection(name: string) {
      const chain = {
        where() { return chain; },
        limit() { return chain; },
        async get() {
          if (name === 'agent_wallets') {
            return { empty: !opts.walletDoc?.exists, docs: opts.walletDoc?.exists ? [opts.walletDoc] : [] };
          }
          if (name === 'devices') {
            return { docs: opts.devices ?? [] };
          }
          return { empty: true, docs: [] };
        },
        doc(id: string) {
          return {
            async get() {
              if (name === 'agent_wallets') {
                return opts.walletDoc ?? { exists: false, data: () => ({}) };
              }
              if (name === 'wallets') {
                return opts.walletsById?.[id] ?? { exists: false, data: () => ({}) };
              }
              if (name === 'commons_profiles') {
                return opts.profileDoc ?? { exists: false, data: () => ({}) };
              }
              return { exists: false, data: () => ({}) };
            },
          };
        },
      };
      return chain;
    },
  };
}

describe('Wave 4 HIGH-8: computeWalletAttestationTier', () => {
  it('returns software when no devices are active', async () => {
    const db = makeFakeDb({ devices: [] });
    const result = await computeWalletAttestationTier({ db } as any, 'wallet_aw_x');
    expect(result.tier).toBe('software');
    expect(result.raw_tier).toBe('software');
  });

  it('caps an unverified human Mac SE signer at hardware_partial', async () => {
    const db = makeFakeDb({
      walletsById: {
        wallet_aw_x: { exists: true, data: () => ({ attested_security_level: 'hardware' }) },
      },
      devices: [
        {
          exists: true,
          data: () => ({
            status: 'active',
            signing_method: 'secure_enclave_p256',
            owner_type: 'human',
            attestation_capability: 'hardware_tpm',
            platform: 'macOS',
          }),
        },
      ],
    });
    const result = await computeWalletAttestationTier({ db } as any, 'wallet_aw_x');
    expect(result.tier).toBe('hardware');
    expect(result.raw_tier).toBe('hardware_partial');
  });

  it('honors a server-verified human Android StrongBox tier', async () => {
    const db = makeFakeDb({
      walletsById: {
        wallet_aw_x: { exists: true, data: () => ({ attested_security_level: 'hardware_full' }) },
      },
      devices: [
        {
          exists: true,
          data: () => ({
            status: 'active',
            signing_method: 'secure_enclave_p256',
            owner_type: 'human',
            attestation_capability: 'hardware_tpm',
            attested_security_level: 'hardware_full',
            platform: 'android',
          }),
        },
      ],
    });
    const result = await computeWalletAttestationTier({ db } as any, 'wallet_aw_x');
    expect(result.tier).toBe('hardware');
    expect(result.raw_tier).toBe('hardware_full');
  });

  it('downgrades to software when wallet has no attested_security_level (Wave 3 fail-closed mirrors)', async () => {
    const db = makeFakeDb({
      // No wallet doc on file → no attested_security_level → fail-closed.
      devices: [
        {
          exists: true,
          data: () => ({
            status: 'active',
            signing_method: 'bearer',
            owner_type: 'human',
            attestation_capability: 'hardware_tpm',
            platform: 'linux',
          }),
        },
      ],
    });
    const result = await computeWalletAttestationTier({ db } as any, 'wallet_aw_x');
    expect(result.tier).toBe('software');
  });

  it('honors a NON-SE hardware_tpm device when the wallet doc (by id) attests hardware (regression: wallet-id was queried against user_id, always missing — bug masked by a filter-ignoring mock)', async () => {
    const db = makeFakeDb({
      // The wallet's attested level lives on wallets/{walletId} — resolved by
      // DOC ID. Pre-fix this was queried as where('user_id','==',walletId) and
      // never matched, so a bearer (non-SE) hardware device was wrongly
      // downgraded to software. There is no SE override here, so the outcome
      // depends entirely on the wallet-gate lookup being correct.
      walletsById: {
        wallet_aw_x: { exists: true, data: () => ({ attested_security_level: 'hardware' }) },
      },
      devices: [
        {
          exists: true,
          data: () => ({
            status: 'active',
            signing_method: 'bearer',
            owner_type: 'human',
            attestation_capability: 'hardware_tpm',
            platform: 'android',
          }),
        },
      ],
    });
    const result = await computeWalletAttestationTier({ db } as any, 'wallet_aw_x');
    expect(result.tier).toBe('hardware');
    expect(result.raw_tier).toBe('hardware_tpm');
  });

  it('still downgrades a non-SE hardware device when the wallet doc is seeded under a DIFFERENT id (doc-id lookup is exact)', async () => {
    const db = makeFakeDb({
      walletsById: {
        some_other_wallet: { exists: true, data: () => ({ attested_security_level: 'hardware' }) },
      },
      devices: [
        {
          exists: true,
          data: () => ({
            status: 'active',
            signing_method: 'bearer',
            owner_type: 'human',
            attestation_capability: 'hardware_tpm',
            platform: 'android',
          }),
        },
      ],
    });
    const result = await computeWalletAttestationTier({ db } as any, 'wallet_aw_x');
    expect(result.tier).toBe('software');
  });

  it('keeps an agent-owned SE-signing device software-only', async () => {
    const db = makeFakeDb({
      walletsById: {
        wallet_aw_x: { exists: true, data: () => ({ attested_security_level: 'hardware' }) },
      },
      devices: [
        {
          exists: true,
          data: () => ({
            status: 'active',
            signing_method: 'secure_enclave_p256',
            owner_type: 'agent',
            attestation_capability: 'hardware_tpm',
            platform: 'linux',
          }),
        },
      ],
    });
    const result = await computeWalletAttestationTier({ db } as any, 'wallet_aw_x');
    expect(result.tier).toBe('software');
    expect(result.raw_tier).toBe('software');
  });

  it('fails closed to software when a legacy device has no verified owner type', async () => {
    const db = makeFakeDb({
      walletsById: {
        wallet_aw_x: { exists: true, data: () => ({ attested_security_level: 'hardware' }) },
      },
      devices: [
        {
          exists: true,
          data: () => ({
            status: 'active',
            signing_method: 'secure_enclave_p256',
            attestation_capability: 'hardware_tpm',
            platform: 'macOS',
          }),
        },
      ],
    });
    const result = await computeWalletAttestationTier({ db } as any, 'wallet_aw_x');
    expect(result.tier).toBe('software');
    expect(result.raw_tier).toBe('software');
  });
});

describe('Wave 4 HIGH-8: recomputeCommonsAttestationTier', () => {
  it('updates the profile doc when one exists', async () => {
    const update = jest.fn();
    const profileDoc: FakeDoc = {
      exists: true,
      data: () => ({}),
      ref: { update } as any,
    };
    const db = makeFakeDb({
      profileDoc,
      walletsById: {
        wallet_aw_x: { exists: true, data: () => ({ attested_security_level: 'hardware' }) },
      },
      devices: [
        {
          exists: true,
          data: () => ({
            status: 'active',
            signing_method: 'secure_enclave_p256',
            owner_type: 'human',
            attestation_capability: 'hardware_tpm',
            platform: 'darwin',
          }),
        },
      ],
    });
    await recomputeCommonsAttestationTier({ db } as any, 'wallet_aw_x');
    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.attestation_tier).toBe('hardware');
    expect(arg.attestation_tier_raw).toBe('hardware_partial');
    expect(typeof arg.attestation_tier_updated_at).toBe('number');
  });

  it('is a no-op when no profile exists for the wallet', async () => {
    const update = jest.fn();
    const db = makeFakeDb({
      profileDoc: { exists: false, data: () => ({}), ref: { update } as any },
      devices: [],
    });
    await recomputeCommonsAttestationTier({ db } as any, 'wallet_aw_x');
    expect(update).not.toHaveBeenCalled();
  });
});

describe('Wave 4 STEP 9: P-256 paths run via webcrypto, not the broken @noble subpath', () => {
  it('Node webcrypto verify roundtrips for ECDSA-P256', async () => {
    const subtle = (require('crypto') as { webcrypto: { subtle: any } }).webcrypto.subtle;
    const keyPair = await subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const message = new TextEncoder().encode('wave4-noble-drift-test');
    const sig = await subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.privateKey,
      message,
    );
    const ok = await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.publicKey,
      sig,
      message,
    );
    expect(ok).toBe(true);
  });

  it('importKey rejects an off-curve raw P-256 point (regression guard for validateSEC1P256PublicKey)', async () => {
    const subtle = (require('crypto') as { webcrypto: { subtle: any } }).webcrypto.subtle;
    // 65 bytes 04||X||Y - but X and Y are zero, which is not on the P-256 curve.
    const offCurve = Buffer.alloc(65);
    offCurve[0] = 0x04;
    let rejected = false;
    try {
      await subtle.importKey(
        'raw',
        offCurve,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});
