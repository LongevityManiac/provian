/**
 * The Solana proof-of-control message is Provian-reserved: no dApp can obtain the wallet's
 * signature over it through WalletConnect.
 *
 * Today the app advertises ONLY the eip155 namespace (no solana_* method is served at all), so the
 * risk is a future Solana namespace. The guard therefore (a) refuses the message by an EXPLICIT
 * pattern (`provian_solana_proof`) on personal_sign, and (b) classifies `solana_signMessage` so a
 * Solana namespace added later inherits the refusal.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import bs58 from 'bs58';
import { checkProvianReserved } from '../provianReserved';
import { buildSolanaProofMessage, SOLANA_PROOF_MESSAGE_HEADER } from '../../chains/solana/solanaProofMessage';

const SOL = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const WALLET = '0x1111111111111111111111111111111111111111';
const PROOF = buildSolanaProofMessage({
    subjectLine: 'person: user_7', address: SOL, nonce: '0123456789abcdef0123456789abcdef',
    issuedIso: '2026-10-04T12:00:00.000Z', expiresIso: '2026-10-04T12:10:00.000Z',
});
const utf8Hex = (s: string): string => `0x${Buffer.from(s, 'utf8').toString('hex')}`;
const b58 = (s: string): string => bs58.encode(Buffer.from(s, 'utf8'));

describe('provianReserved — the Solana proof-of-control message', () => {
    it('personal_sign: refused by the explicit Solana-proof pattern (text and hex, either param order)', () => {
        for (const params of [[PROOF, WALLET], [WALLET, PROOF], [utf8Hex(PROOF), WALLET]]) {
            expect(checkProvianReserved('personal_sign', params)).toMatchObject({ reserved: true, reason: 'provian_solana_proof' });
        }
    });

    it('the explicit pattern holds even when the brand word is disguised or dropped', () => {
        for (const text of [
            PROOF.replace('Provian', 'Prоvian'),            // Cyrillic о
            PROOF.replace('Provian ', ''),                       // brand dropped
            PROOF.replace('Solana proof of control', 'S​olana  proof of control'), // zero-width + odd spaces
        ]) {
            expect(checkProvianReserved('personal_sign', [text, WALLET])).toMatchObject({ reserved: true, reason: 'provian_solana_proof' });
        }
    });

    it('solana_signMessage (WalletConnect Solana: base58 bytes) is classified and refuses the proof', () => {
        expect(checkProvianReserved('solana_signMessage', { message: b58(PROOF), pubkey: SOL }))
            .toMatchObject({ reserved: true, reason: 'provian_solana_proof' });
        expect(checkProvianReserved('solana_signMessage', { message: PROOF, pubkey: SOL }))
            .toMatchObject({ reserved: true, reason: 'provian_solana_proof' });
        // Any other Provian text is refused there too (the general rule).
        expect(checkProvianReserved('solana_signMessage', { message: b58('Provian proof of control'), pubkey: SOL }))
            .toMatchObject({ reserved: true });
    });

    it('positive control: an ordinary Solana sign-in message is NOT reserved (the guard is not refusing everything)', () => {
        expect(checkProvianReserved('solana_signMessage', { message: b58('example.com wants you to sign in with your Solana account'), pubkey: SOL }))
            .toEqual({ reserved: false });
    });

    it('malformed solana_signMessage params and Solana transaction methods fail closed', () => {
        expect(checkProvianReserved('solana_signMessage', [b58(PROOF)])).toMatchObject({ reserved: true, reason: 'unclassifiable_params' });
        expect(checkProvianReserved('solana_signTransaction', { transaction: 'AQ==' })).toMatchObject({ reserved: true, reason: 'unclassified_method' });
        expect(checkProvianReserved('solana_signAndSendTransaction', { transaction: 'AQ==' })).toMatchObject({ reserved: true, reason: 'unclassified_method' });
    });

    it('binds to the source of truth: the header the guard folds is the one the app signs', () => {
        expect(SOLANA_PROOF_MESSAGE_HEADER).toBe('Provian Solana proof of control');
        expect(PROOF.startsWith(SOLANA_PROOF_MESSAGE_HEADER)).toBe(true);
    });

    it('today the WalletConnect session advertises no solana_* method (eip155 only)', () => {
        const src = readFileSync(resolve(__dirname, '../WalletConnectService.ts'), 'utf8');
        const block = src.slice(src.indexOf('const SUPPORTED_METHODS'), src.indexOf('] as const;', src.indexOf('const SUPPORTED_METHODS')));
        expect(block).toContain('personal_sign');
        expect(block).not.toMatch(/solana_/);
        expect(src).not.toMatch(/\bsolana\s*:\s*\{/); // no `solana: { accounts, methods }` namespace
    });
});
