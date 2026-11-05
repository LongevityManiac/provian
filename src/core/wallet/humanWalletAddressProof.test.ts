/**
 * the app side of the human-wallet registration address proof.
 * The digest vector is the SAME literal pinned in the relay's human-wallet-address-proof.test.ts,
 * so a drift of the domain or struct on either side goes red.
 */
import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';

import {
    HUMAN_WALLET_REGISTRATION_DOMAIN,
    HUMAN_WALLET_REGISTRATION_TYPES,
    humanWalletRegistrationMessage,
    addressProofAuthorized,
    authorizedAddressProof,
    encodeAddressProofAuthorization,
    registerWithAddressProof,
    signHumanWalletAddressProof,
} from './humanWalletAddressProof';

const PINNED_DIGEST = '0x275c73190df21fd33698b1f34e0f34b541d5576d0a4db70eee5aaca3fe814343';

describe('humanWalletAddressProof', () => {
    it('the typed data hashes to the digest the relay pins (domain + struct parity)', () => {
        const message = { user_id: 'user_abc', address: '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a', device_id: 'device-1', timestamp: 1790000000 };
        expect(ethers.TypedDataEncoder.hash(HUMAN_WALLET_REGISTRATION_DOMAIN, HUMAN_WALLET_REGISTRATION_TYPES, message)).toBe(PINNED_DIGEST);
        expect(HUMAN_WALLET_REGISTRATION_DOMAIN.name).toMatch(/provian/i);
    });

    it('signs with the wallet key; the signature recovers to the wallet address over the relay-shaped message', async () => {
        const wallet = new ethers.Wallet(`0x${'11'.repeat(32)}`);
        const nowMs = 1_790_000_000_123;
        const proof = await signHumanWalletAddressProof(wallet, { userId: 'user_abc', address: wallet.address, deviceId: 'device-1', nowMs });
        expect(proof.timestamp).toBe(1_790_000_000);
        const message = humanWalletRegistrationMessage({ userId: 'user_abc', address: wallet.address, deviceId: 'device-1', nowMs });
        expect(ethers.verifyTypedData(HUMAN_WALLET_REGISTRATION_DOMAIN, HUMAN_WALLET_REGISTRATION_TYPES, message, proof.signature)).toBe(wallet.address);
    });

    it('an existing registration replays proof-free: no signing, no biometric prompt', async () => {
        const post = vi.fn(async (_p: unknown) => ({ status: 200 }));
        const sign = vi.fn(async () => ({ signature: '0x', timestamp: 1 }));
        expect((await registerWithAddressProof(post, sign)).status).toBe(200);
        expect(sign).not.toHaveBeenCalled();
        expect(post).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenCalledWith(null);
    });

    it('RED: a NEW registration answered 428 is retried ONCE with the signed proof (without the retry the wallet never binds)', async () => {
        const proof = { signature: '0xabc', timestamp: 7 };
        const post = vi.fn(async (p: unknown) => ({ status: p === null ? 428 : 201 }));
        const sign = vi.fn(async () => proof);
        expect((await registerWithAddressProof(post, sign)).status).toBe(201);
        expect(sign).toHaveBeenCalledTimes(1);
        expect(post.mock.calls).toEqual([[null], [proof]]);
    });

    it('a second 428 is returned as-is (no loop)', async () => {
        const post = vi.fn(async () => ({ status: 428 }));
        const sign = vi.fn(async () => ({ signature: '0x', timestamp: 1 }));
        expect((await registerWithAddressProof(post, sign)).status).toBe(428);
        expect(post).toHaveBeenCalledTimes(2);
    });

    it(' defect 3: an UNAUTHORIZED device (sign → null) never sends a proof; the 428 is returned and nothing binds', async () => {
        const post = vi.fn(async (_p: unknown) => ({ status: 428 }));
        const sign = vi.fn(async () => null);
        expect((await registerWithAddressProof(post, sign)).status).toBe(428);
        expect(post).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenCalledWith(null);
    });
});

describe('address-proof authorization (round-robin fairness)', () => {
    const ADDR = '0xAbCd000000000000000000000000000000000001';
    it('a definitive recovery for THIS account + address authorizes', () => {
        const stored = encodeAddressProofAuthorization({ address: ADDR, userId: 'user_x' });
        expect(addressProofAuthorized(stored, 'user_x', ADDR)).toBe(true);
        expect(addressProofAuthorized(stored, 'user_x', ADDR.toLowerCase())).toBe(true);
    });
    it('RED: another account (e.g. an empty account left after a transient recovery failure) is NOT authorized', () => {
        const stored = encodeAddressProofAuthorization({ address: ADDR, userId: 'user_x' });
        expect(addressProofAuthorized(stored, 'user_empty', ADDR)).toBe(false);
    });
    it('another address, no record, malformed record, or no current account → NO', () => {
        const stored = encodeAddressProofAuthorization({ address: ADDR, userId: 'user_x' });
        expect(addressProofAuthorized(stored, 'user_x', '0x0000000000000000000000000000000000000002')).toBe(false);
        expect(addressProofAuthorized(null, 'user_x', ADDR)).toBe(false);
        expect(addressProofAuthorized('not json', 'user_x', ADDR)).toBe(false);
        expect(addressProofAuthorized('{"address":1}', 'user_x', ADDR)).toBe(false);
        expect(addressProofAuthorized(stored, null, ADDR)).toBe(false);
    });
    it('a freshly generated address (userId null) authorizes whatever account this device holds', () => {
        const stored = encodeAddressProofAuthorization({ address: ADDR, userId: null });
        expect(addressProofAuthorized(stored, 'user_any', ADDR)).toBe(true);
    });
});

describe('authorizedAddressProof - sign only after a DEFINITIVE recovery (round-robin fairness)', () => {
    const proof = { signature: '0xabc', timestamp: 7 };
    it('RED: recovery fails transiently (503) -> NO proof is signed (old: signed anyway, displacing the key holder intact legacy account)', async () => {
        const sign = vi.fn(async () => proof);
        const recover = vi.fn(async () => { throw new Error('Relay credential recovery failed (503)'); });
        const out = await authorizedAddressProof({ allowed: true, isAuthorized: async () => false, recover, sign });
        expect(out).toBeNull();
        expect(recover).toHaveBeenCalledTimes(1);
        expect(sign).not.toHaveBeenCalled();
    });
    it('RED: a caller that just saw recovery fail (allowed: false) signs nothing and does not re-run recovery', async () => {
        const sign = vi.fn(async () => proof);
        const recover = vi.fn(async () => undefined);
        expect(await authorizedAddressProof({ allowed: false, isAuthorized: async () => true, recover, sign })).toBeNull();
        expect(recover).not.toHaveBeenCalled();
        expect(sign).not.toHaveBeenCalled();
    });
    it('recovery RESOLVES and authorizes this account -> the proof is signed', async () => {
        let authorized = false;
        const recover = vi.fn(async () => { authorized = true; });
        const sign = vi.fn(async () => proof);
        expect(await authorizedAddressProof({ allowed: true, isAuthorized: async () => authorized, recover, sign })).toBe(proof);
        expect(sign).toHaveBeenCalledTimes(1);
    });
    it('recovery resolves but does NOT authorize this account -> no proof', async () => {
        const sign = vi.fn(async () => proof);
        expect(await authorizedAddressProof({ allowed: true, isAuthorized: async () => false, recover: async () => undefined, sign })).toBeNull();
        expect(sign).not.toHaveBeenCalled();
    });
    it('already authorized -> signs without re-running recovery', async () => {
        const recover = vi.fn(async () => undefined);
        const sign = vi.fn(async () => proof);
        expect(await authorizedAddressProof({ allowed: true, isAuthorized: async () => true, recover, sign })).toBe(proof);
        expect(recover).not.toHaveBeenCalled();
    });
});
