/**
 * EVM Chain Configuration
 *
 * Centralized configuration for EVM chains, supporting both
 * testnet (development) and mainnet (production) environments.
 */

// =============================================================================
// ENVIRONMENT (imported from shared, re-exported for convenience)
// =============================================================================

import {
    type Environment,
    getEnvironment,
    setEnvironmentOverride,
    getCurrentEnvironment,
    isTestnet,
} from '../../shared/environment';

export {
    type Environment,
    getEnvironment,
    setEnvironmentOverride,
    getCurrentEnvironment,
    isTestnet,
};

// =============================================================================
// CHAIN DEFINITIONS
// =============================================================================

export interface ChainConfig {
    chainId: number;
    name: string;
    shortName: string;
    symbol: string;
    decimals: number;
    rpcUrl: string;
    /** D-5 fix: Fallback RPC URL used when the primary is unreachable. */
    fallbackRpcUrl?: string;
    explorerUrl: string;
    isTestnet: boolean;
    // Related mainnet/testnet chain
    mainnetChainId?: number;
    testnetChainId?: number;
}

// -----------------------------------------------------------------------------
// TESTNETS
// -----------------------------------------------------------------------------

export const BASE_SEPOLIA: ChainConfig = {
    chainId: 84532,
    name: 'Base Sepolia',
    shortName: 'base-sepolia',
    symbol: 'ETH',
    decimals: 18,
    rpcUrl: 'https://sepolia.base.org',
    explorerUrl: 'https://sepolia.basescan.org',
    isTestnet: true,
    mainnetChainId: 8453,
};

export const ARBITRUM_SEPOLIA: ChainConfig = {
    chainId: 421614,
    name: 'Arbitrum Sepolia',
    shortName: 'arb-sepolia',
    symbol: 'ETH',
    decimals: 18,
    rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
    explorerUrl: 'https://sepolia.arbiscan.io',
    isTestnet: true,
    mainnetChainId: 42161,
};

export const OPTIMISM_SEPOLIA: ChainConfig = {
    chainId: 11155420,
    name: 'Optimism Sepolia',
    shortName: 'op-sepolia',
    symbol: 'ETH',
    decimals: 18,
    rpcUrl: 'https://sepolia.optimism.io',
    explorerUrl: 'https://sepolia-optimism.etherscan.io',
    isTestnet: true,
    mainnetChainId: 10,
};

// -----------------------------------------------------------------------------
// MAINNETS
// -----------------------------------------------------------------------------

export const BASE_MAINNET: ChainConfig = {
    chainId: 8453,
    name: 'Base',
    shortName: 'base',
    symbol: 'ETH',
    decimals: 18,
    rpcUrl: 'https://mainnet.base.org',
    fallbackRpcUrl: 'https://base.llamarpc.com',
    explorerUrl: 'https://basescan.org',
    isTestnet: false,
    testnetChainId: 84532,
};

export const ARBITRUM_MAINNET: ChainConfig = {
    chainId: 42161,
    name: 'Arbitrum One',
    shortName: 'arbitrum',
    symbol: 'ETH',
    decimals: 18,
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    fallbackRpcUrl: 'https://arbitrum.llamarpc.com',
    explorerUrl: 'https://arbiscan.io',
    isTestnet: false,
    testnetChainId: 421614,
};

export const OPTIMISM_MAINNET: ChainConfig = {
    chainId: 10,
    name: 'Optimism',
    shortName: 'optimism',
    symbol: 'ETH',
    decimals: 18,
    rpcUrl: 'https://mainnet.optimism.io',
    fallbackRpcUrl: 'https://optimism.llamarpc.com',
    explorerUrl: 'https://optimistic.etherscan.io',
    isTestnet: false,
    testnetChainId: 11155420,
};

// =============================================================================
// CHAIN REGISTRY
// =============================================================================

export const TESTNET_CHAINS: ChainConfig[] = [
    BASE_SEPOLIA,
    ARBITRUM_SEPOLIA,
    OPTIMISM_SEPOLIA,
];

export const MAINNET_CHAINS: ChainConfig[] = [
    BASE_MAINNET,
    ARBITRUM_MAINNET,
    OPTIMISM_MAINNET,
];

export const ALL_CHAINS: ChainConfig[] = [
    ...MAINNET_CHAINS,
    ...TESTNET_CHAINS,
];

/**
 * Get chains for current environment.
 */
export function getActiveChains(): ChainConfig[] {
    return isTestnet() ? TESTNET_CHAINS : MAINNET_CHAINS;
}

/**
 * Get chain by ID.
 */
export function getChainById(chainId: number): ChainConfig | undefined {
    return ALL_CHAINS.find(c => c.chainId === chainId);
}

/**
 * Get default chain for current environment.
 */
export function getDefaultChain(): ChainConfig {
    return isTestnet() ? BASE_SEPOLIA : BASE_MAINNET;
}

/**
 * Get RPC URLs for current environment.
 */
export function getRpcUrls(): Record<number, string> {
    const chains = getActiveChains();
    return Object.fromEntries(
        chains.map(c => [c.chainId, c.rpcUrl])
    );
}

/**
 * D-5 fix: Get fallback RPC URLs for current environment.
 * Returns only chains that have a fallback configured.
 */
export function getFallbackRpcUrls(): Record<number, string> {
    const chains = getActiveChains();
    return Object.fromEntries(
        chains.filter(c => c.fallbackRpcUrl).map(c => [c.chainId, c.fallbackRpcUrl!])
    );
}

// =============================================================================
// TOKEN ADDRESSES
// =============================================================================

export const TOKEN_ADDRESSES: Record<number, Record<string, string>> = {
    // Base Mainnet
    8453: {
        USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
        DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
        WETH: '0x4200000000000000000000000000000000000006',
    },
    // Arbitrum Mainnet
    42161: {
        USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        'USDC.e': '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
        USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
        WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    },
    // Optimism Mainnet
    10: {
        USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
        'USDC.e': '0x7F5c764cBc14f9669B88837ca1490cCa17c31607',
        USDT: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
        DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
        WETH: '0x4200000000000000000000000000000000000006',
    },
    // Base Sepolia (testnet tokens - limited availability)
    84532: {
        USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Circle testnet USDC
        WETH: '0x4200000000000000000000000000000000000006',
    },
    // Arbitrum Sepolia
    421614: {
        USDC: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
        WETH: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73',
    },
    // Optimism Sepolia
    11155420: {
        USDC: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
        WETH: '0x4200000000000000000000000000000000000006',
    },
};

/**
 * PVT9 kernel (successor) on Base mainnet — the live, fully-transferable ERC-20
 * whose `balanceOf` the relay's `GET /v1/pvt/balance/:addr` reads. Pinned here
 * DELIBERATELY OUTSIDE `TOKEN_ADDRESSES` so the on-chain balance loop does not
 * double-fetch it: a human's PVT balance is sourced from the relay reader
 * (`RelayAPIService.getPVTBalance`), while this address is what a first-party
 * PVT send targets via `TransactionService.sendERC20`. Base-only; 18 decimals.
 * The abandoned kernel `0x8b2306be…` is never referenced here.
 */
export const PVT9_TOKEN = {
    chainId: 8453,
    address: '0x8811441914381143b9408c5C32247367F86F173A',
    symbol: 'PVT',
    name: 'Provian Value Token',
    decimals: 18,
} as const;

/**
 * ProvianEscrowV4 on Base — the ONE escrow every Commons hire funds (PVT and USDC),.
 * The phone signs createEscrow / approve / fundEscrow / releaseEscrow / disputeEscrow /
 * claimDisputeTimeout only against THIS address and only approves the pinned token for it,
 * never an address the relay names (the SDK and MCP pin the same contract). Bound to
 * `contracts/deployments/base-pvt9-institutions.json` (`escrowV4`) by HumanJobEscrowFunder.test.ts.
 */
export const JOB_ESCROW_V4 = {
    chainId: 8453,
    address: '0x96560fDF49e563eFCdc2d502934676DC074732d0',
} as const;

/**
 * The live Provian contract set on Base (successor): the PVT9 kernel, its eligibility
 * verifier, the five institutions and the keyless migration distributor. The app transacts only
 * with `PVT9_TOKEN` and `JOB_ESCROW_V4`; this full list exists so the WalletConnect
 * reserved-message guard (`walletconnect/provianReserved.ts`) refuses any external dApp's typed
 * data whose EIP-712 `verifyingContract` is a Provian contract. Bound to
 * `contracts/deployments/base-pvt9-institutions.json` by `provianReserved.test.ts`.
 */
export const PROVIAN_BASE_CONTRACTS = {
    pvt9Kernel: PVT9_TOKEN.address,
    eligibilityVerifier: '0xb26Fd9d4f3b42911592B96270e8437287DE33406',
    escrowV4: JOB_ESCROW_V4.address,
    promiseV3: '0x7506F4A052750260A0ddcdF5E63a77CC646d89B9',
    poolV3: '0x1301BF63Cb6BaE7171f6c7D895C762B243964d26', // 2026-10-20: Funded pools refundable past deadline; 0xb355C79a… replaced
    bondPool: '0x6b09E9C72316De9d62d63f09B187d4c86bBf787E',
    courtV2: '0x9a326D1ff5EC97cE466CF6fc71BA6f5372E41D7f',
    migrationDistributor: '0xf674f1A915862430C9d0Da994f1B9EA5Dd0c71Ed',
} as const;

/**
 * Get token addresses for a chain.
 * @param chainId The chain ID to get tokens for
 * @returns Token addresses or empty object if chain not configured
 */
export function getTokenAddresses(chainId: number): Record<string, string> {
    const tokens = TOKEN_ADDRESSES[chainId];
    if (!tokens) {
        console.warn(`[EVMConfig] No token addresses configured for chain ${chainId}`);
        return {};
    }
    return tokens;
}

// =============================================================================
// FAUCETS (for testnet)
// =============================================================================

export const FAUCET_URLS: Record<number, string> = {
    84532: 'https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet', // Base Sepolia
    421614: 'https://faucet.arbitrum.io/', // Arbitrum Sepolia
    11155420: 'https://app.optimism.io/faucet', // Optimism Sepolia
};

export function getFaucetUrl(chainId: number): string | undefined {
    return FAUCET_URLS[chainId];
}
