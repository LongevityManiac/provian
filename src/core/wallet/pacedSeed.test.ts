/**
 * The paced BIP-39 seed (findings, 2026-10-23): byte-identical to @scure/bip39's
 * mnemonicToSeedSync on the BIP-39 reference vectors, and it gives the JS thread back while it runs.
 * RED controls: a wrong passphrase or one changed word gives another seed; a slice that never ends
 * never yields.
 */
import { describe, expect, it } from 'vitest';
import { mnemonicToSeedSync } from '@scure/bip39';
import { bytesToHex } from '@noble/hashes/utils';
import { mnemonicToSeedPaced } from './pacedSeed';
import { cpuBudget, UNPACED } from '../meter/cpuBudget';

// BIP-39 reference vectors (passphrase "TREZOR").
const VECTORS: [string, string][] = [
    ['abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04'],
    ['legal winner thank year wave sausage worth useful legal winner thank yellow',
        '2e8905819b8723fe2c1d161860e5ee1830318dbf49a83bd451cfb8440c28bd6fa457fe1296106559a3c80937a1c1069be3a3a5bd381ee6260e8d9739fce1f607'],
    ['zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote',
        'dd48c104698c30cfe2b6142103248622fb7bb0ff692eebb00089b32d22484e1613912f0a5b694407be899ffd31ed3992c456cdf60f5d4564b8ba3f05a69890ad'],
];

describe('mnemonicToSeedPaced', () => {
    it('matches the BIP-39 vectors and mnemonicToSeedSync, with and without a passphrase', async () => {
        for (const [mnemonic, seed] of VECTORS) {
            expect(bytesToHex(await mnemonicToSeedPaced(mnemonic, 'TREZOR', UNPACED))).toBe(seed);
            expect(bytesToHex(await mnemonicToSeedPaced(mnemonic, '', UNPACED))).toBe(bytesToHex(mnemonicToSeedSync(mnemonic)));
        }
        // NFKD: the same as the reference for a non-ASCII passphrase.
        expect(bytesToHex(await mnemonicToSeedPaced(VECTORS[0][0], 'café', UNPACED))).toBe(bytesToHex(mnemonicToSeedSync(VECTORS[0][0], 'café')));
    });

    it('RED: one changed word or another passphrase gives another seed', async () => {
        const base = bytesToHex(await mnemonicToSeedPaced(VECTORS[1][0], '', UNPACED));
        expect(bytesToHex(await mnemonicToSeedPaced(VECTORS[1][0].replace('wave', 'wage'), '', UNPACED))).not.toBe(base);
        expect(bytesToHex(await mnemonicToSeedPaced(VECTORS[1][0], 'x', UNPACED))).not.toBe(base);
    });

    it('gives the thread back while it runs (RED: a slice that never ends never yields)', async () => {
        let ticks = 0;
        let yields = 0;
        const run = (sliceMs: number) => mnemonicToSeedPaced(VECTORS[2][0], '', cpuBudget({ sliceMs, now: () => ticks++, yieldToUi: async () => { yields += 1; } }));
        expect(bytesToHex(await run(50))).toBe(bytesToHex(mnemonicToSeedSync(VECTORS[2][0])));
        expect(yields).toBeGreaterThan(10);
        yields = 0;
        await run(Number.POSITIVE_INFINITY);
        expect(yields).toBe(0);
    });
});
