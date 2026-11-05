// Verified token addresses across chains.
//
// For Provian-supported EVM chains (Base / Arbitrum / Optimism + their
// Sepolia testnets), addresses are sourced from the canonical EVMConfig
// table (`src/core/chains/evm/config.ts`). This eliminates a class of
// drift bug where mobile would query a stale dead-letter contract while
// the rest of the stack pointed at the live one (see audit doc
// `docs/audit/doc_code_reconciliation_2026_05.md`, V-1/V-2/V-3).
//
// Provian also supports Solana (SOL native + USDC on Solana) as a wallet
// asset for hold/send/receive/swap, but this allow-list is EVM-scoped:
// it verifies EVM ERC-20 contract addresses only. Solana USDC mint
// verification is handled separately in the Solana history parser, not
// here. (PVT remains a Base-only ERC-20; there is no PVT on Solana.)
//
// Other chains (Ethereum mainnet, Polygon, BNB Chain) are not Provian
// chains. Their entries are retained as static reference data for the
// spam filter and TokenVerifier so cross-chain receipts surface
// correctly when a user address is touched on a non-Provian chain.

import { TOKEN_ADDRESSES } from '../core/chains/evm/config';

interface TokenInfo {
    address: string;
    decimals: number;
    name: string;
    issuer: string;
}

// Per-symbol metadata for tokens whose address is sourced from EVMConfig.
// Decimals/name/issuer are stable per-symbol; per-chain "issuer" variations
// for WETH (e.g. "Base" vs "Arbitrum") were stylistic-only and were
// collapsed to a single canonical string here.
const EVM_TOKEN_META: Record<string, Omit<TokenInfo, 'address'>> = {
    USDC: { decimals: 6, name: 'USD Coin', issuer: 'Circle' },
    USDT: { decimals: 6, name: 'Tether USD', issuer: 'Tether' },
    DAI: { decimals: 18, name: 'Dai Stablecoin', issuer: 'MakerDAO' },
    WETH: { decimals: 18, name: 'Wrapped Ether', issuer: 'WETH' },
};

// Symbols this allow-list publishes per Provian chain. Restricting to an
// explicit set keeps backward compatibility - symbols not previously
// surfaced (e.g. DAI on Base, USDC.e on Arb/Op) stay out unless we
// deliberately add them.
const EVM_CHAIN_SYMBOLS: Record<number, readonly string[]> = {
    8453: ['USDC', 'WETH'],                 // Base mainnet
    42161: ['USDC', 'USDT', 'WETH'],        // Arbitrum One
    10: ['USDC', 'USDT', 'WETH'],           // Optimism
    84532: ['USDC', 'WETH'],                // Base Sepolia
    421614: ['USDC', 'WETH'],               // Arbitrum Sepolia
    11155420: ['USDC', 'WETH'],             // Optimism Sepolia
};

function buildEvmEntries(): Record<number, Record<string, TokenInfo>> {
    const out: Record<number, Record<string, TokenInfo>> = {};
    for (const [chainIdStr, symbols] of Object.entries(EVM_CHAIN_SYMBOLS)) {
        const chainId = Number(chainIdStr);
        const chainAddresses = TOKEN_ADDRESSES[chainId];
        if (!chainAddresses) continue;
        const entry: Record<string, TokenInfo> = {};
        for (const symbol of symbols) {
            const address = chainAddresses[symbol];
            const meta = EVM_TOKEN_META[symbol];
            if (!address || !meta) continue;
            entry[symbol] = { address, ...meta };
        }
        if (Object.keys(entry).length > 0) {
            out[chainId] = entry;
        }
    }
    return out;
}

// Static entries for chains outside EVMConfig's purview. Provian does not
// transact on these chains; they are retained for cross-chain receipt
// recognition only.
const NON_EVMCONFIG_CHAINS: Record<number, Record<string, TokenInfo>> = {
    // Ethereum Mainnet (chainId: 1)
    1: {
        USDC: {
            address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
            decimals: 6,
            name: 'USD Coin',
            issuer: 'Circle',
        },
        USDT: {
            address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
            decimals: 6,
            name: 'Tether USD',
            issuer: 'Tether',
        },
        DAI: {
            address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
            decimals: 18,
            name: 'Dai Stablecoin',
            issuer: 'MakerDAO',
        },
        WETH: {
            address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
            decimals: 18,
            name: 'Wrapped Ether',
            issuer: 'WETH',
        },
        WLFI: {
            address: '0xda5e1988097297dcdc1f90d4dfe7909e847cbef6',
            decimals: 18,
            name: 'World Liberty Financial',
            issuer: 'World Liberty Financial',
        },
        WLD: {
            address: '0x163f8c2467924be0ae7b5347228cabf260318753',
            decimals: 18,
            name: 'Worldcoin',
            issuer: 'Worldcoin',
        },
        USD1: {
            address: '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d',
            decimals: 6,
            name: 'World Liberty Financial USD',
            issuer: 'World Liberty Financial',
        },
    },

    // Polygon (chainId: 137)
    137: {
        USDC: {
            address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
            decimals: 6,
            name: 'USD Coin (PoS)',
            issuer: 'Circle',
        },
        USDT: {
            address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
            decimals: 6,
            name: 'Tether USD (PoS)',
            issuer: 'Tether',
        },
        DAI: {
            address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
            decimals: 18,
            name: 'Dai Stablecoin (PoS)',
            issuer: 'MakerDAO',
        },
        WMATIC: {
            address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
            decimals: 18,
            name: 'Wrapped Matic',
            issuer: 'Polygon',
        },
    },

    // BNB Chain (chainId: 56)
    56: {
        USDC: {
            address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
            decimals: 18,
            name: 'USD Coin',
            issuer: 'Circle',
        },
        USDT: {
            address: '0x55d398326f99059fF775485246999027B3197955',
            decimals: 18,
            name: 'Tether USD',
            issuer: 'Tether',
        },
        WBNB: {
            address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
            decimals: 18,
            name: 'Wrapped BNB',
            issuer: 'BSC',
        },
    },
};

export const VERIFIED_TOKENS: Record<number, Record<string, TokenInfo>> = {
    ...buildEvmEntries(),
    ...NON_EVMCONFIG_CHAINS,
};

// Common symbols that are frequently impersonated
export const HIGH_RISK_SYMBOLS = [
    'USDC', 'USDT', 'DAI', 'BUSD',
    'ETH', 'WETH', 'BTC', 'WBTC',
    'BNB', 'MATIC', 'SOL',
    'USDD', 'TUSD', 'USDP',
];

// Expected decimals for stablecoins (most common attack vector)
export const EXPECTED_DECIMALS: Record<string, number> = {
    USDC: 6,
    USDT: 6,
    DAI: 18,
    BUSD: 18,
    USDD: 18,
    TUSD: 18,
    USDP: 18,
};
