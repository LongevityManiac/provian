import { describe, expect, it } from 'vitest';

import {
    decryptBackupEnvelope,
    encryptBackupEnvelope,
    validatePin,
    LEGACY_PBKDF2_ITERATIONS,
    PBKDF2_ITERATIONS,
    type CloudBackupPayload,
    type StoredBackup,
} from './cloudBackupEnvelope';

const PAYLOAD: CloudBackupPayload = {
    mnemonic: 'test test test test test test test test test test test junk',
    wallet_address: '0x1111111111111111111111111111111111111111',
    chain_ids: [8453, 42161, 10],
    created_at: '2026-01-01T00:00:00.000Z',
    device_info: { platform: 'ios', attestation_tier: 'hardware' },
};

/**
 * FROZEN legacy fixture: a pre-chunk-i envelope (no `iterations` field,
 * 100K PBKDF2 count) encrypted with the 6-digit PIN "123456" — the exact
 * class of blob live users still restore. Generated once from the original
 * derivation parameters and pinned as bytes, so this test proves the
 * current code decrypts yesterday's backups, not merely its own output.
 * Its plaintext is PAYLOAD above. Do not regenerate.
 */
const LEGACY_ENVELOPE: StoredBackup = {
    version: 2,
    salt: '0707070707070707070707070707070707070707070707070707070707070707',
    nonce: '090909090909090909090909',
    ciphertext:
        '7b3766003da09a0259ee052bb583af054deef4181975ba29ac947cba820fa2890148df10613fb34a0cf65e5fd392315e58f7860019c0778301a22fa63c6476acaec5000c8336ae13b712ede32347debbc327ff8aafab4d6803e7fb72c79ac95b03f2360c2593e1c568152205f61810792fbd3ccb9a1fb423a29ce965f7f6f3579b12fe0fb3b0fe7de70da5b889ec73e3ce7051c94d0e71549e5dcca8371dfedee238292423f2d1c95a21accfbacda4dc47f1052642b2d7af267942435792948d228f938f3626ec6a3ef3bbd0548913fc74b634900f8becda5be266c6315c806205fc2e37f5c486d145c165f1083de542f8302e533b843b1c9046cfe9fef37bae3812174c6407fb81cc16010d3e4e4ee95805a634379508ad472e2a',
};

describe('cloud backup envelope round trip', () => {
    it('encrypts and decrypts with a long alphanumeric backup password', async () => {
        const stored = await encryptBackupEnvelope(PAYLOAD, 'correct horse battery staple 42');
        expect(stored.version).toBe(2);
        expect(stored.iterations).toBe(PBKDF2_ITERATIONS);

        const roundTripped = await decryptBackupEnvelope(stored, 'correct horse battery staple 42');
        expect(roundTripped).toEqual(PAYLOAD);
    });

    it('encrypts and decrypts with a legacy-style 6-digit PIN as the password', async () => {
        const stored = await encryptBackupEnvelope(PAYLOAD, '123456');
        const roundTripped = await decryptBackupEnvelope(stored, '123456');
        expect(roundTripped).toEqual(PAYLOAD);
    });

    it('decrypts the FROZEN legacy envelope (no iterations field, 100K count, 6-digit PIN)', async () => {
        // The envelope deliberately omits `iterations`; the decrypt path must
        // fall back to LEGACY_PBKDF2_ITERATIONS. Guard the fixture is really
        // exercising that branch:
        expect(LEGACY_ENVELOPE.iterations).toBeUndefined();
        expect(LEGACY_PBKDF2_ITERATIONS).toBe(100_000);

        const payload = await decryptBackupEnvelope(LEGACY_ENVELOPE, '123456');
        expect(payload).toEqual(PAYLOAD);
    });
});

describe('cloud backup envelope negative controls', () => {
    it('RED: a wrong password fails GCM auth instead of returning junk', async () => {
        const stored = await encryptBackupEnvelope(PAYLOAD, '123456');
        await expect(decryptBackupEnvelope(stored, '123457')).rejects.toThrow();
        // And the frozen legacy blob rejects a wrong PIN the same way.
        await expect(decryptBackupEnvelope(LEGACY_ENVELOPE, '654321')).rejects.toThrow();
    });

    it('RED: a tampered ciphertext fails GCM auth', async () => {
        const stored = await encryptBackupEnvelope(PAYLOAD, '123456');
        const flipped =
            (stored.ciphertext[0] === '0' ? '1' : '0') + stored.ciphertext.slice(1);
        await expect(
            decryptBackupEnvelope({ ...stored, ciphertext: flipped }, '123456'),
        ).rejects.toThrow();
    });

    it('RED: validatePin rejects passwords under 6 characters and empty strings', () => {
        expect(() => validatePin('12345')).toThrow(/at least 6 characters/);
        expect(() => validatePin('')).toThrow(/at least 6 characters/);
        // Control that the guard can admit: 6 chars passes.
        expect(() => validatePin('123456')).not.toThrow();
        expect(() => validatePin('a much longer alphanumeric passphrase')).not.toThrow();
    });
});
