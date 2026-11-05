import { describe, it, expect } from 'vitest';
import { isPvtMintTransfer, ZERO_ADDRESS } from './pvtMintClassifier';
import { PVT9_TOKEN } from '../chains/evm/config';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const REAL_SENDER = '0x2222222222222222222222222222222222222222';

describe('isPvtMintTransfer — PVT earning detection', () => {
    it('flags an incoming PVT mint (from zero address, pinned PVT9 contract)', () => {
        expect(
            isPvtMintTransfer({
                isReceived: true,
                from: ZERO_ADDRESS,
                contractAddress: PVT9_TOKEN.address,
                pvtAddress: PVT9_TOKEN.address,
            }),
        ).toBe(true);
    });

    // Case-insensitivity: Alchemy may return either casing for addresses.
    it('matches regardless of address casing', () => {
        expect(
            isPvtMintTransfer({
                isReceived: true,
                from: ZERO_ADDRESS,
                contractAddress: PVT9_TOKEN.address.toUpperCase(),
                pvtAddress: PVT9_TOKEN.address.toLowerCase(),
            }),
        ).toBe(true);
    });

    // Negative control #1: an ordinary incoming transfer from a real address is
    // NOT a mint — proves the guard distinguishes mints, not merely "incoming".
    it('does not flag an ordinary incoming USDC transfer', () => {
        expect(
            isPvtMintTransfer({
                isReceived: true,
                from: REAL_SENDER,
                contractAddress: USDC_BASE,
                pvtAddress: PVT9_TOKEN.address,
            }),
        ).toBe(false);
    });

    // Negative control #2: a look-alike token minted from a DIFFERENT contract is
    // NOT a PVT earning — proves the guard binds to the PVT9 address, not a symbol.
    it('does not flag a look-alike token minted from a non-PVT contract', () => {
        expect(
            isPvtMintTransfer({
                isReceived: true,
                from: ZERO_ADDRESS,
                contractAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
                pvtAddress: PVT9_TOKEN.address,
            }),
        ).toBe(false);
    });

    // Negative control #3: an OUTGOING transfer (isReceived=false) is never a mint,
    // even from the zero address with the PVT contract.
    it('does not flag an outgoing transfer', () => {
        expect(
            isPvtMintTransfer({
                isReceived: false,
                from: ZERO_ADDRESS,
                contractAddress: PVT9_TOKEN.address,
                pvtAddress: PVT9_TOKEN.address,
            }),
        ).toBe(false);
    });

    // Native transfers have no contract address → never a mint.
    it('does not flag a transfer with no contract address', () => {
        expect(
            isPvtMintTransfer({
                isReceived: true,
                from: ZERO_ADDRESS,
                contractAddress: undefined,
                pvtAddress: PVT9_TOKEN.address,
            }),
        ).toBe(false);
    });
});
