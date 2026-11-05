/**
 * SLIP-0010 ed25519 derivation — validated against the PUBLISHED test vectors
 * (SLIP-0010 spec, Test vector 1 & 2 for ed25519) and cross-checked against
 * @solana/web3.js's own Keypair.fromSeed → base58 encoding.
 *
 * This is a money-path derivation: a wrong key funds an unrecoverable address.
 * The vectors below are the external ground truth, not self-authored fixtures.
 */

import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519';
import { slip10MasterKey, slip10DeriveEd25519Seed } from './slip10';

const hex = (s: string): Uint8Array =>
    new Uint8Array((s.match(/.{1,2}/g) ?? []).map((b) => parseInt(b, 16)));
const toHex = (u: Uint8Array): string =>
    Array.from(u).map((b) => b.toString(16).padStart(2, '0')).join('');

// SLIP-0010 spec, Test vector 1 for ed25519. seed = 000102030405060708090a0b0c0d0e0f
const VECTOR_1_SEED = hex('000102030405060708090a0b0c0d0e0f');
const VECTOR_1: Array<{ path: string; key: string }> = [
    { path: 'm', key: '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7' },
    { path: "m/0'", key: '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3' },
    { path: "m/0'/1'", key: 'b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2' },
    { path: "m/0'/1'/2'", key: '92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9' },
    { path: "m/0'/1'/2'/2'", key: '30d1dc7e5fc04c31219ab25a27ae00b50f6fd66622f6e9c913253d6511d1e662' },
    { path: "m/0'/1'/2'/2'/1000000000'", key: '8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793' },
];

// SLIP-0010 spec, Test vector 2 for ed25519.
const VECTOR_2_SEED = hex(
    'fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542',
);
const VECTOR_2: Array<{ path: string; key: string }> = [
    { path: 'm', key: '171cb88b1b3c1db25add599712e36245d75bc65a1a5c9e18d76f9f2b1eab4012' },
    { path: "m/0'", key: '1559eb2bbec5790b0c65d8693e4d0875b1747f4970ae8b650486ed7470845635' },
    { path: "m/0'/2147483647'", key: 'ea4f5bfe8694d8bb74b7b59404632fd5968b774ed545e810de9c32a4fb4192f4' },
];

describe('slip10 ed25519 derivation (published test vectors)', () => {
    it('matches SLIP-0010 Test vector 1 at every depth', () => {
        expect(toHex(slip10MasterKey(VECTOR_1_SEED).key)).toBe(VECTOR_1[0].key);
        let evaluated = 0;
        for (const { path, key } of VECTOR_1) {
            expect(toHex(slip10DeriveEd25519Seed(VECTOR_1_SEED, path))).toBe(key);
            evaluated++;
        }
        // Guard against a vacuous pass over an empty population.
        expect(evaluated).toBe(6);
    });

    it('matches SLIP-0010 Test vector 2', () => {
        for (const { path, key } of VECTOR_2) {
            expect(toHex(slip10DeriveEd25519Seed(VECTOR_2_SEED, path))).toBe(key);
        }
    });

    it('NEGATIVE CONTROL: a wrong expected key does not match (equality is meaningful)', () => {
        const derived = toHex(slip10DeriveEd25519Seed(VECTOR_1_SEED, "m/0'"));
        // Flip one nibble of the true vector.
        const wrong = VECTOR_1[1].key.replace(/^6/, '7');
        expect(wrong).not.toBe(VECTOR_1[1].key);
        expect(derived).not.toBe(wrong);
    });

    it('FAIL CLOSED: rejects a non-hardened segment', () => {
        expect(() => slip10DeriveEd25519Seed(VECTOR_1_SEED, "m/44'/501'/0'/0")).toThrow(
            /hardened/i,
        );
    });

    it('FAIL CLOSED: rejects a path that does not start with m', () => {
        expect(() => slip10DeriveEd25519Seed(VECTOR_1_SEED, "44'/501'/0'/0'")).toThrow(/start/i);
    });
});

describe('solana address encoding parity with @solana/web3.js', () => {
    it('bs58(ed25519.getPublicKey(seed)) === Keypair.fromSeed(seed).publicKey', () => {
        for (const { path } of VECTOR_1) {
            const seed = slip10DeriveEd25519Seed(VECTOR_1_SEED, path);
            const nobleAddr = bs58.encode(ed25519.getPublicKey(seed));
            const web3Addr = Keypair.fromSeed(seed).publicKey.toBase58();
            expect(nobleAddr).toBe(web3Addr);
        }
    });

    it('derives the Solana account path m/44\'/501\'/0\'/0\' deterministically', () => {
        const seed = slip10DeriveEd25519Seed(VECTOR_1_SEED, "m/44'/501'/0'/0'");
        const addr = Keypair.fromSeed(seed).publicKey.toBase58();
        // Base58, 32-byte pubkey → 43-44 chars, no 0x.
        expect(addr).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
        expect(addr.startsWith('0x')).toBe(false);
    });
});
