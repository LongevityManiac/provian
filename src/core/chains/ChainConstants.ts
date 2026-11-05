/**
 * Chain Constants
 *
 * Centralized chain ID and configuration for supported blockchains: the EVM L2s
 * (Base, Arbitrum, Optimism) plus Solana as a first-class payment surface.
 *
 * EVM chains share one numeric-chainId model and one secp256k1 EOA. Solana is a
 * distinct address space (ed25519 / base58) with no EVM chainId; its asset chain
 * is discriminated by name ('Solana') and routed on that, never on a numeric id.
 *
 * [L-23] EVM token contract addresses are sourced from TOKEN_ADDRESSES in
 * ./evm/config.ts (the canonical, environment-aware registry) rather than
 * being duplicated here. Updating an address only requires editing
 * TOKEN_ADDRESSES; this file picks up the change automatically.
 */

import { TOKEN_ADDRESSES } from './evm/config';

export interface ChainInfo {
    id: number;
    name: string;
    shortName: string;
    nativeCurrency: string;
    nativeCurrencyDecimals: number;
    addressFormat: 'evm' | 'solana';
    avgFeeUsd: number;
    blockTime: number;
    explorerUrl: string;
    isTestnet: boolean;
}

export const CHAIN_IDS = {
    BASE: 8453,
    ARBITRUM: 42161,
    OPTIMISM: 10,
} as const;

/**
 * Solana is not an EVM numeric-chainId chain. This sentinel id is used only to
 * satisfy the ChainInfo shape for display; it is NEVER passed to an EVM
 * provider/router. All Solana routing keys off `addressFormat === 'solana'` or
 * `chain === 'Solana'`.
 */
export const SOLANA_CHAIN_ID_SENTINEL = -501;

export const SOLANA_CHAIN_INFO: ChainInfo = {
    id: SOLANA_CHAIN_ID_SENTINEL,
    name: 'Solana',
    shortName: 'SOL',
    nativeCurrency: 'SOL',
    nativeCurrencyDecimals: 9,
    addressFormat: 'solana',
    avgFeeUsd: 0.001,
    blockTime: 0.4,
    explorerUrl: 'https://solscan.io',
    isTestnet: false,
};

export type ChainId = typeof CHAIN_IDS[keyof typeof CHAIN_IDS];

export const CHAINS: Record<number, ChainInfo> = {
    [CHAIN_IDS.BASE]: {
        id: CHAIN_IDS.BASE,
        name: 'Base',
        shortName: 'BASE',
        nativeCurrency: 'ETH',
        nativeCurrencyDecimals: 18,
        addressFormat: 'evm',
        avgFeeUsd: 0.01,
        blockTime: 2,
        explorerUrl: 'https://basescan.org',
        isTestnet: false,
    },

    [CHAIN_IDS.ARBITRUM]: {
        id: CHAIN_IDS.ARBITRUM,
        name: 'Arbitrum',
        shortName: 'ARB',
        nativeCurrency: 'ETH',
        nativeCurrencyDecimals: 18,
        addressFormat: 'evm',
        avgFeeUsd: 0.02,
        blockTime: 0.25,
        explorerUrl: 'https://arbiscan.io',
        isTestnet: false,
    },

    [CHAIN_IDS.OPTIMISM]: {
        id: CHAIN_IDS.OPTIMISM,
        name: 'Optimism',
        shortName: 'OP',
        nativeCurrency: 'ETH',
        nativeCurrencyDecimals: 18,
        addressFormat: 'evm',
        avgFeeUsd: 0.02,
        blockTime: 2,
        explorerUrl: 'https://optimistic.etherscan.io',
        isTestnet: false,
    },
};

/**
 * Get chain info from our Asset chain name.
 */
export function getChainFromAssetChain(assetChain: string): ChainInfo | null {
    const lower = assetChain.toLowerCase();
    switch (lower) {
        case 'base':
            return CHAINS[CHAIN_IDS.BASE];
        case 'arbitrum':
            return CHAINS[CHAIN_IDS.ARBITRUM];
        case 'optimism':
            return CHAINS[CHAIN_IDS.OPTIMISM];
        case 'solana':
            return SOLANA_CHAIN_INFO;
        default:
            return null;
    }
}

/**
 * Get chain ID from Asset chain name.
 */
export function getChainIdFromAssetChain(assetChain: string): number | null {
    const chain = getChainFromAssetChain(assetChain);
    if (!chain) {
        console.warn(`[ChainConstants] Unknown asset chain: "${assetChain}" - refusing to default`);
        return null;
    }
    return chain.id;
}

/**
 * Multi-chain token configuration.
 * Defines which chains each token is available on and their addresses.
 */
export interface MultiChainTokenChain {
    chainId: number;
    address: string;
    decimals: number;
    feeEstimateUsd: number;
    isPreferred?: boolean;
}

export interface MultiChainToken {
    symbol: string;
    name: string;
    isStablecoin: boolean;
    chains: MultiChainTokenChain[];
}

/**
 * [L-23] Address resolver: pulls the canonical contract address for a
 * (chainId, symbol) pair from TOKEN_ADDRESSES. Throws at module load if
 * the table doesn't have the expected entry, so address drift surfaces
 * immediately rather than as a silent runtime undefined.
 */
function requireTokenAddress(chainId: number, symbol: string): string {
    const addr = TOKEN_ADDRESSES[chainId]?.[symbol];
    if (!addr) {
        throw new Error(`[ChainConstants] Missing canonical address for ${symbol} on chain ${chainId}`);
    }
    return addr;
}

export const MULTI_CHAIN_TOKENS: MultiChainToken[] = [
    {
        symbol: 'USDT',
        name: 'Tether USD',
        isStablecoin: true,
        chains: [
            {
                chainId: CHAIN_IDS.ARBITRUM,
                address: requireTokenAddress(CHAIN_IDS.ARBITRUM, 'USDT'),
                decimals: 6,
                feeEstimateUsd: 0.02,
                isPreferred: true,
            },
        ],
    },
    {
        symbol: 'USDC',
        name: 'USD Coin',
        isStablecoin: true,
        chains: [
            {
                chainId: CHAIN_IDS.BASE,
                address: requireTokenAddress(CHAIN_IDS.BASE, 'USDC'),
                decimals: 6,
                feeEstimateUsd: 0.01,
                isPreferred: true,
            },
            {
                chainId: CHAIN_IDS.ARBITRUM,
                address: requireTokenAddress(CHAIN_IDS.ARBITRUM, 'USDC'),
                decimals: 6,
                feeEstimateUsd: 0.02,
            },
            {
                chainId: CHAIN_IDS.OPTIMISM,
                address: requireTokenAddress(CHAIN_IDS.OPTIMISM, 'USDC'),
                decimals: 6,
                feeEstimateUsd: 0.02,
            },
        ],
    },
];

/**
 * Get multi-chain token info by symbol.
 */
export function getMultiChainToken(symbol: string): MultiChainToken | undefined {
    return MULTI_CHAIN_TOKENS.find(t => t.symbol === symbol);
}

/**
 * Get available chains for a token, sorted by preference then fee.
 */
export function getTokenChainsSortedByFee(symbol: string): MultiChainToken['chains'] {
    const token = getMultiChainToken(symbol);
    if (!token) return [];

    return [...token.chains].sort((a, b) => {
        if (a.isPreferred && !b.isPreferred) return -1;
        if (!a.isPreferred && b.isPreferred) return 1;
        return a.feeEstimateUsd - b.feeEstimateUsd;
    });
}

/**
 * Get cheapest chain for a token.
 */
export function getCheapestChainForToken(symbol: string): number | null {
    const sorted = getTokenChainsSortedByFee(symbol);
    return sorted.length > 0 ? sorted[0].chainId : null;
}

/**
 * Check if a token is available on multiple chains.
 */
export function isMultiChainToken(symbol: string): boolean {
    const token = getMultiChainToken(symbol);
    return token !== undefined && token.chains.length > 1;
}

/**
 * Format fee for display.
 */
export function formatFeeEstimate(feeUsd: number): string {
    if (feeUsd < 0.01) {
        return '<$0.01';
    }
    if (feeUsd < 1) {
        return `~$${feeUsd.toFixed(2)}`;
    }
    return `~$${feeUsd.toFixed(0)}+`;
}
