import { describe, it, expect } from 'vitest';
import {
    detectAddressChain,
    validateAddress,
    isValidSolanaAddress,
    chainNameToType, hasValidEvmChecksum } from './AddressValidator';

// Real 32-byte base58 Solana addresses.
const SOL_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_SYSTEM = '11111111111111111111111111111111';
const EVM_ADDR = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

describe('AddressValidator — EVM checksum (EIP-55, 2026-10-17)', () => {
    const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    it('takes a correctly checksummed, an all-lowercase and an all-uppercase address', () => {
        expect(detectAddressChain(USDC_BASE)).toBe('ethereum');
        expect(detectAddressChain(USDC_BASE.toLowerCase())).toBe('ethereum');
        expect(detectAddressChain(`0x${USDC_BASE.slice(2).toUpperCase()}`)).toBe('ethereum');
        expect(validateAddress(USDC_BASE, 'ethereum').isValid).toBe(true);
    });
    it('RED: a mixed-case address with one wrong character fails its checksum and is refused', () => {
        // The last character flipped: a typo that used to pass as "40 hex characters".
        const typo = `${USDC_BASE.slice(0, -1)}4`;
        expect(detectAddressChain(typo)).toBe('unknown');
        expect(validateAddress(typo, 'ethereum').isValid).toBe(false);
        // The same 40 characters with the checksum capitalisation wrong is refused too.
        const badCase = `0x${USDC_BASE.slice(2, 10).toLowerCase()}${USDC_BASE.slice(10)}`;
        expect(hasValidEvmChecksum(badCase)).toBe(false);
        expect(detectAddressChain(badCase)).toBe('unknown');
    });
});

describe('AddressValidator — Solana', () => {
    it('detects a valid Solana address', () => {
        expect(detectAddressChain(SOL_USDC_MINT)).toBe('solana');
        expect(detectAddressChain(SOL_SYSTEM)).toBe('solana');
        expect(isValidSolanaAddress(SOL_USDC_MINT)).toBe(true);
    });

    it('does NOT classify an EVM address as Solana (and vice versa)', () => {
        expect(detectAddressChain(EVM_ADDR)).toBe('ethereum');
        expect(isValidSolanaAddress(EVM_ADDR)).toBe(false);
        expect(detectAddressChain(SOL_USDC_MINT)).not.toBe('ethereum');
    });

    it('FAIL CLOSED: rejects malformed base58 / wrong length', () => {
        expect(isValidSolanaAddress('')).toBe(false);
        expect(isValidSolanaAddress('0OIl')).toBe(false); // invalid base58 chars
        expect(isValidSolanaAddress('abc')).toBe(false); // too short to be 32 bytes
        expect(detectAddressChain('not an address')).toBe('unknown');
    });

    it('validateAddress cross-checks detected vs expected chain', () => {
        expect(validateAddress(SOL_USDC_MINT, 'solana').isValid).toBe(true);
        expect(validateAddress(SOL_USDC_MINT, 'ethereum').isValid).toBe(false);
        expect(validateAddress(EVM_ADDR, 'solana').isValid).toBe(false);
        expect(validateAddress(EVM_ADDR, 'ethereum').isValid).toBe(true);
    });

    it('maps chain names to types', () => {
        expect(chainNameToType('solana')).toBe('solana');
        expect(chainNameToType('Solana')).toBe('solana');
        expect(chainNameToType('base')).toBe('ethereum');
    });
});
