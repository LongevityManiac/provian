/**
 * TokenVerifier - Verifies token contract addresses against canonical sources.
 *
 * Catches the most common token impersonation attack: airdropping fake USDC/USDT
 * from a non-canonical contract address. Uses TOKEN_ADDRESSES from EVM config
 * as the single source of truth.
 *
 * Security invariant: if a token claims to be USDC or USDT but its contract
 * address doesn't match the canonical address for that chain, it is flagged.
 */

import { TOKEN_ADDRESSES } from '../chains/evm/config';

export interface TokenVerificationResult {
    /** Whether the contract address matches the canonical address for this token on this chain */
    isCanonical: boolean;
    /** The expected canonical address (null if token/chain combination is unknown) */
    expectedAddress: string | null;
    /** The actual contract address being verified */
    actualAddress: string;
    /** The token symbol being claimed */
    tokenSymbol: string;
    /** The chain ID */
    chainId: number;
    /** Human-readable warning if verification fails */
    warning?: string;
}

/** Tokens that are commonly impersonated and should always be verified */
const VERIFIED_SYMBOLS = new Set(['USDC', 'USDT', 'USDC.e', 'DAI', 'WETH', 'PVT']);

/**
 * Verify that a token's contract address matches the canonical address
 * for the given chain. Returns verification result with warning if mismatch.
 */
export function verifyTokenAddress(
    tokenSymbol: string,
    contractAddress: string,
    chainId: number,
): TokenVerificationResult {
    const normalizedSymbol = tokenSymbol.toUpperCase();
    const normalizedAddress = contractAddress.toLowerCase();

    // Get canonical addresses for this chain
    const chainTokens = TOKEN_ADDRESSES[chainId];

    // If we don't have canonical addresses for this chain, we can't verify
    if (!chainTokens) {
        return {
            isCanonical: false,
            expectedAddress: null,
            actualAddress: contractAddress,
            tokenSymbol,
            chainId,
            // No warning - we simply don't know this chain's addresses
        };
    }

    // Find the canonical address for this token on this chain
    const canonicalAddress = chainTokens[normalizedSymbol] || chainTokens[tokenSymbol];

    // If we don't have a canonical address for this token, we can't verify
    if (!canonicalAddress) {
        return {
            isCanonical: false,
            expectedAddress: null,
            actualAddress: contractAddress,
            tokenSymbol,
            chainId,
            // Only warn for commonly impersonated tokens
            warning: VERIFIED_SYMBOLS.has(normalizedSymbol)
                ? `No canonical address found for ${tokenSymbol} on chain ${chainId}. This token may not be genuine.`
                : undefined,
        };
    }

    const isMatch = normalizedAddress === canonicalAddress.toLowerCase();

    return {
        isCanonical: isMatch,
        expectedAddress: canonicalAddress,
        actualAddress: contractAddress,
        tokenSymbol,
        chainId,
        warning: isMatch
            ? undefined
            : `This token claims to be ${tokenSymbol} but is not from the official contract address. Expected ${canonicalAddress.slice(0, 6)}...${canonicalAddress.slice(-4)}, got ${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}. This is likely a fake token.`,
    };
}

/**
 * Check if a token symbol is one we track canonical addresses for.
 */
export function isVerifiableToken(tokenSymbol: string): boolean {
    return VERIFIED_SYMBOLS.has(tokenSymbol.toUpperCase());
}

/**
 * Batch-verify a list of tokens. Returns only the non-canonical ones.
 * Useful for filtering airdropped fake tokens from balance displays.
 */
export function filterFakeTokens(
    tokens: Array<{ symbol: string; contractAddress: string; chainId: number }>,
): Array<{ symbol: string; contractAddress: string; chainId: number; warning: string }> {
    const fakes: Array<{ symbol: string; contractAddress: string; chainId: number; warning: string }> = [];

    for (const token of tokens) {
        // Only verify tokens that claim to be known symbols
        if (!isVerifiableToken(token.symbol)) continue;

        const result = verifyTokenAddress(token.symbol, token.contractAddress, token.chainId);
        if (!result.isCanonical && result.expectedAddress && result.warning) {
            fakes.push({
                symbol: token.symbol,
                contractAddress: token.contractAddress,
                chainId: token.chainId,
                warning: result.warning,
            });
        }
    }

    return fakes;
}
