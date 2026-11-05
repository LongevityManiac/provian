/**
 * Address Validator
 *
 * Validates EVM (0x + 40 hex) and Solana (base58, 32-byte pubkey) address
 * formats and detects which family an address belongs to. Used by the Send flow
 * to confirm a recipient matches the selected asset's chain.
 */

import bs58 from 'bs58';
import { getAddress } from 'ethers';

export type ChainType = 'ethereum' | 'solana' | 'unknown';

export interface AddressValidationResult {
    isValid: boolean;
    detectedChain: ChainType;
    format: string;
    error?: string;
}

const HEX_REGEX = /^[0-9a-fA-F]+$/;
// Base58 alphabet (Bitcoin/Solana) — excludes 0, O, I, l.
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Detect which blockchain an address belongs to based on format.
 */
export function detectAddressChain(address: string): ChainType {
    if (!address || address.length === 0) {
        return 'unknown';
    }

    const trimmed = address.trim();

    // EVM (Base, Arbitrum, Optimism)
    if (trimmed.startsWith('0x') && trimmed.length === 42) {
        const hexPart = trimmed.slice(2);
        if (HEX_REGEX.test(hexPart) && hasValidEvmChecksum(trimmed)) {
            return 'ethereum';
        }
        return 'unknown';
    }

    // Solana: base58, decodes to a 32-byte public key (typically 43-44 chars).
    if (!trimmed.startsWith('0x') && trimmed.length >= 32 && trimmed.length <= 44 && BASE58_REGEX.test(trimmed)) {
        if (isValidSolanaAddress(trimmed)) {
            return 'solana';
        }
    }

    return 'unknown';
}

/**
 * Validate an address for a specific chain.
 */
export function validateAddress(address: string, expectedChain: ChainType): AddressValidationResult {
    if (!address || address.length === 0) {
        return {
            isValid: false,
            detectedChain: 'unknown',
            format: 'empty',
            error: 'Address is required'
        };
    }

    const trimmed = address.trim();
    const detectedChain = detectAddressChain(trimmed);

    const result: AddressValidationResult = {
        isValid: false,
        detectedChain,
        format:
            detectedChain === 'ethereum'
                ? '0x + 40 hex characters'
                : detectedChain === 'solana'
                    ? 'base58 (32-byte public key)'
                    : 'unknown format',
    };

    if (detectedChain === 'unknown') {
        result.error = 'Invalid address format';
        return result;
    }

    if (detectedChain !== expectedChain) {
        result.error = 'Address format does not match expected chain';
        return result;
    }

    if (expectedChain === 'ethereum') {
        result.isValid = validateEVMAddress(trimmed);
        if (!result.isValid) {
            result.error = 'Invalid EVM address format';
        }
    } else if (expectedChain === 'solana') {
        result.isValid = isValidSolanaAddress(trimmed);
        if (!result.isValid) {
            result.error = 'Invalid Solana address format';
        }
    }

    return result;
}

/**
 * Validate EVM address format (0x prefix + 40 hex characters).
 */
function validateEVMAddress(address: string): boolean {
    if (!address.startsWith('0x') || address.length !== 42) {
        return false;
    }
    const hexPart = address.slice(2);
    return HEX_REGEX.test(hexPart) && hasValidEvmChecksum(address);
}

/**
 * EIP-55: a MIXED-case EVM address carries a checksum, and a mistyped character breaks it. An
 * all-lowercase or all-uppercase address carries none and is taken as written. Before this the
 * Send screen accepted any 40 hex characters and ethers refused the bad checksum only after
 * Face ID (2026-10-17 bug check).
 */
export function hasValidEvmChecksum(address: string): boolean {
    const hex = address.slice(2);
    if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return true;
    try {
        return getAddress(address) === address;
    } catch {
        return false;
    }
}

/**
 * Validate a Solana address: base58 that decodes to exactly 32 bytes.
 * (On-curve enforcement for wallet recipients happens at send time in
 * SolanaTransactionService; here we only validate the address format/length.)
 */
export function isValidSolanaAddress(address: string): boolean {
    try {
        if (!BASE58_REGEX.test(address)) return false;
        return bs58.decode(address).length === 32;
    } catch {
        return false;
    }
}

/**
 * Map chain names to ChainType for validation.
 */
export function chainNameToType(chain: string): ChainType {
    const lower = chain.toLowerCase();
    switch (lower) {
        case 'ethereum':
        case 'base':
        case 'arbitrum':
        case 'optimism':
            return 'ethereum';
        case 'solana':
            return 'solana';
        default:
            return 'unknown';
    }
}

/**
 * Get chain display name.
 */
export function getChainDisplayName(chain: ChainType): string {
    switch (chain) {
        case 'ethereum':
            return 'EVM';
        case 'solana':
            return 'Solana';
        default:
            return 'Unknown';
    }
}
