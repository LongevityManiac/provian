/**
 * Item 11 : the human's ONE recovery key — derived from the seed, published
 * once under a wallet signature, and the only key that opens a fleet agent's escrow.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';

vi.mock('../wallet/SeedManager', () => ({ default: {} }));
vi.mock('../../services/RelayAPIService', () => ({ default: {} }));

import {
    deriveHumanRecoveryAnchor, humanRecoveryAnchorMessage, publishHumanRecoveryAnchor, derivedAnchorSecretFor, type PublishDeps,
} from './humanRecoveryAnchor';
import { sealToAnchor, openWithAnchor, generateAnchorKeyPair } from '../security/agentKeyRecovery';

const MNEMONIC = 'test test test test test test test test test test test junk';
const wallet = ethers.Wallet.fromPhrase(MNEMONIC);

function deps(over: Partial<PublishDeps> = {}): PublishDeps & { published: Array<[string, string]>; mnemonicReads: number } {
    const published: Array<[string, string]> = [];
    const d = {
        published, mnemonicReads: 0,
        sessionValid: () => true,
        requireSession: async () => {},
        getMnemonic: async () => { d.mnemonicReads += 1; return MNEMONIC; },
        readPublished: async () => null as string | null | undefined,
        publish: async (p: string, s: string) => { published.push([p, s]); return true; },
        ...over,
    };
    return d;
}

describe('deriveHumanRecoveryAnchor', () => {
    it('is deterministic per seed (every phone holding it derives the same key) and differs across seeds', () => {
        const a = deriveHumanRecoveryAnchor(MNEMONIC);
        expect(deriveHumanRecoveryAnchor(MNEMONIC).publicKeyB64u).toBe(a.publicKeyB64u);
        expect(deriveHumanRecoveryAnchor(ethers.Wallet.createRandom().mnemonic!.phrase).publicKeyB64u).not.toBe(a.publicKeyB64u);
        expect(a.publicKeyB64u).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('a key an agent sealed to the published anchor opens with the seed-derived secret — and with no other key', () => {
        const a = deriveHumanRecoveryAnchor(MNEMONIC);
        const agentKey = ethers.getBytes(ethers.Wallet.createRandom().privateKey);
        const blob = sealToAnchor(a.publicKey, agentKey);
        expect(openWithAnchor(a.secretKey, blob)).toEqual(agentKey);
        expect(() => openWithAnchor(generateAnchorKeyPair().secretKey, blob)).toThrow();
    });

    it('the signed message is byte-identical to the relay\'s (parity pin against the backend source)', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'provian-backend', 'src', 'core', 'human-recovery-anchor.ts'), 'utf8');
        expect(src).toContain('return `Provian human recovery anchor v1\\n${pubkeyB64u}`;');
        expect(humanRecoveryAnchorMessage('X')).toBe('Provian human recovery anchor v1\nX');
    });
});

describe('publishHumanRecoveryAnchor', () => {
    it('publishes the derived key with a signature that recovers to this wallet', async () => {
        const d = deps();
        expect(await publishHumanRecoveryAnchor({ prompt: false }, d)).toBe('published');
        const [pub, sig] = d.published[0];
        expect(pub).toBe(deriveHumanRecoveryAnchor(MNEMONIC).publicKeyB64u);
        expect(ethers.verifyMessage(humanRecoveryAnchorMessage(pub), sig)).toBe(wallet.address);
        expect(d.mnemonicReads).toBe(1); // one seed read derives the anchor AND the signing key
    });

    it('never prompts without a session when prompt:false — no seed read, nothing sent', async () => {
        const d = deps({ sessionValid: () => false });
        expect(await publishHumanRecoveryAnchor({ prompt: false }, d)).toBe('no_session');
        expect(d.mnemonicReads).toBe(0);
        expect(d.published).toHaveLength(0);
    });

    it('review r2 #1: already on the relay → the seed is never read (every read is an OS prompt), nothing sent; RED control: an unreadable relay never publishes blind', async () => {
        const mine = deriveHumanRecoveryAnchor(MNEMONIC).publicKeyB64u;
        const already = deps({ readPublished: async () => mine });
        expect(await publishHumanRecoveryAnchor({ prompt: true }, already)).toBe('already_published');
        expect(already.published).toHaveLength(0);
        expect(already.mnemonicReads).toBe(0);
        const unreadable = deps({ readPublished: async () => undefined });
        expect(await publishHumanRecoveryAnchor({ prompt: true }, unreadable)).toBe('failed');
        expect(unreadable.published).toHaveLength(0);
    });

    it('recovery finds the derived secret only for this seed\'s anchor', async () => {
        const mine = deriveHumanRecoveryAnchor(MNEMONIC);
        expect(await derivedAnchorSecretFor(mine.publicKeyB64u, deps())).toEqual(mine.secretKey);
        expect(await derivedAnchorSecretFor('E75P6uryBMf9M1j8nAByGIHRdCeBKCJ-xnTzf3_pe20', deps())).toBeNull();
    });
});
