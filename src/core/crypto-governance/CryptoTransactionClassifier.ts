import type { BiometricAction } from '../security/biometricAction';
/**
 * CryptoTransactionClassifier - On-Chain Transaction Classification
 *
 * Classifies on-chain transactions by contract address and function selector.
 * This is the crypto-world equivalent of CategoryMatcher (which does fiat-world
 * keyword matching on merchant names).
 *
 * Classification hierarchy:
 * 1. Known contract address → direct match (highest confidence)
 * 2. Function selector → ERC-20, DEX swap, prediction market, NFT, etc.
 * 3. Call data patterns → fallback heuristics
 * 4. Unknown → requires manual review (hard_confirm)
 *
 * SECURITY MODEL:
 * - Contract addresses are the primary enforcement surface for crypto governance.
 * - WalletConnect transaction and spend-authority requests pass through this classifier.
 *   The wallet owner controls the key, derived from the authenticated native seed vault.
 *   First-party Send/Swap uses its own owner review and authentication flow.
 * - Unknown transactions default to hard_confirm, not auto_approve.
 */

// ============================================================================
// TRANSACTION CATEGORIES
// ============================================================================

export type CryptoTransactionCategory =
    | 'token_transfer'      // Simple ERC-20/native transfer
    | 'token_approval'      // ERC-20 approve/increaseAllowance
    | 'dex_swap'           // DEX trade (Uniswap, 1inch, etc.)
    | 'prediction_market'   // Polymarket, Augur, etc.
    | 'nft_trade'          // OpenSea, Blur, etc.
    | 'defi_lending'       // Aave, Compound, etc.
    | 'defi_staking'       // Staking/unstaking
    | 'bridge'             // Cross-chain bridge
    | 'governance'         // DAO voting
    | 'contract_deploy'    // Contract creation
    | 'unknown';           // Unclassified → hard_confirm

export interface CryptoClassification {
    /** Primary category */
    category: CryptoTransactionCategory;
    /** Confidence (0-1). Below 0.7 triggers escalation. */
    confidence: number;
    /** Platform name if identified (e.g., "Polymarket", "Uniswap") */
    platform?: string;
    /** Sub-action if detectable (e.g., "placeBet", "redeemPosition") */
    subAction?: string;
    /** Whether this is a known contract address */
    isKnownContract: boolean;
    /** Risk tier: low (transfer to known), medium (DEX swap), high (prediction market), critical (unknown contract) */
    riskTier: 'low' | 'medium' | 'high' | 'critical';
}

// ============================================================================
// KNOWN CONTRACT REGISTRIES
// ============================================================================
// These registries map contract addresses to known platforms/categories.
// The hardcoded entries below serve as a baseline. The backend contract
// registry (`GET /v1/contract-registry`) supplements these at runtime via
// `refreshRegistryFromBackend()`, which merges signed entries into the
// in-memory map. Backend entries take precedence for the same address.
// ============================================================================

/**
 * Known contract entry.
 */
export interface KnownContract {
    address: string;        // Checksummed address (lowercase for matching)
    chain: string;          // e.g., 'base', 'polygon', 'ethereum'
    platform: string;       // e.g., 'Polymarket', 'Uniswap'
    category: CryptoTransactionCategory;
    riskTier: 'low' | 'medium' | 'high' | 'critical';
    description: string;
}

/**
 * Known prediction market contracts.
 * These are the enforcement surface for prediction market governance.
 */
const PREDICTION_MARKET_CONTRACTS: KnownContract[] = [
    // Polymarket (Polygon)
    {
        address: '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e',
        chain: 'polygon',
        platform: 'Polymarket',
        category: 'prediction_market',
        riskTier: 'high',
        description: 'Polymarket CTF Exchange',
    },
    {
        address: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
        chain: 'polygon',
        platform: 'Polymarket',
        category: 'prediction_market',
        riskTier: 'high',
        description: 'Polymarket Neg Risk CTF Exchange',
    },
    {
        address: '0xc5d563a36ae78145c45a50134d48a1215220f80a',
        chain: 'polygon',
        platform: 'Polymarket',
        category: 'prediction_market',
        riskTier: 'high',
        description: 'Polymarket Conditional Tokens Framework',
    },
    // Augur (Ethereum) - legacy but still active
    {
        address: '0x5b5e8b3efc31fd69f5fb2b42f2b2b689f6ee2a1e',
        chain: 'ethereum',
        platform: 'Augur',
        category: 'prediction_market',
        riskTier: 'high',
        description: 'Augur Exchange',
    },
];

/**
 * Known DEX contracts.
 */
const DEX_CONTRACTS: KnownContract[] = [
    // Uniswap V3 Router (multi-chain)
    {
        address: '0xe592427a0aece92de3edee1f18e0157c05861564',
        chain: 'ethereum',
        platform: 'Uniswap V3',
        category: 'dex_swap',
        riskTier: 'medium',
        description: 'Uniswap V3 SwapRouter',
    },
    {
        address: '0x2626664c2603336e57b271c5c0b26f421741e481',
        chain: 'base',
        platform: 'Uniswap V3',
        category: 'dex_swap',
        riskTier: 'medium',
        description: 'Uniswap V3 Universal Router (Base)',
    },
    {
        address: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
        chain: 'arbitrum',
        platform: 'Uniswap V3',
        category: 'dex_swap',
        riskTier: 'medium',
        description: 'Uniswap V3 SwapRouter02 (Arbitrum)',
    },
    {
        address: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
        chain: 'optimism',
        platform: 'Uniswap V3',
        category: 'dex_swap',
        riskTier: 'medium',
        description: 'Uniswap V3 SwapRouter02 (Optimism)',
    },
    // 1inch (EVM-consistent address across chains)
    {
        address: '0x1111111254eeb25477b68fb85ed929f73a960582',
        chain: 'ethereum',
        platform: '1inch',
        category: 'dex_swap',
        riskTier: 'medium',
        description: '1inch Aggregation Router',
    },
    {
        address: '0x1111111254eeb25477b68fb85ed929f73a960582',
        chain: 'base',
        platform: '1inch',
        category: 'dex_swap',
        riskTier: 'medium',
        description: '1inch Aggregation Router (Base)',
    },
    {
        address: '0x1111111254eeb25477b68fb85ed929f73a960582',
        chain: 'arbitrum',
        platform: '1inch',
        category: 'dex_swap',
        riskTier: 'medium',
        description: '1inch Aggregation Router (Arbitrum)',
    },
    {
        address: '0x1111111254eeb25477b68fb85ed929f73a960582',
        chain: 'optimism',
        platform: '1inch',
        category: 'dex_swap',
        riskTier: 'medium',
        description: '1inch Aggregation Router (Optimism)',
    },
    // Aerodrome (Base native DEX)
    {
        address: '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43',
        chain: 'base',
        platform: 'Aerodrome',
        category: 'dex_swap',
        riskTier: 'medium',
        description: 'Aerodrome Router (Base)',
    },
];

/**
 * Known lending/DeFi contracts.
 */
const DEFI_CONTRACTS: KnownContract[] = [
    // Aave V3 Pool (multi-chain)
    {
        address: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
        chain: 'ethereum',
        platform: 'Aave V3',
        category: 'defi_lending',
        riskTier: 'medium',
        description: 'Aave V3 Pool',
    },
    {
        address: '0xa238dd80c259a72e81d7e4664a9801593f98d1c5',
        chain: 'base',
        platform: 'Aave V3',
        category: 'defi_lending',
        riskTier: 'medium',
        description: 'Aave V3 Pool (Base)',
    },
    {
        address: '0x794a61358d6845594f94dc1db02a252b5b4814ad',
        chain: 'arbitrum',
        platform: 'Aave V3',
        category: 'defi_lending',
        riskTier: 'medium',
        description: 'Aave V3 Pool (Arbitrum)',
    },
    {
        address: '0x794a61358d6845594f94dc1db02a252b5b4814ad',
        chain: 'optimism',
        platform: 'Aave V3',
        category: 'defi_lending',
        riskTier: 'medium',
        description: 'Aave V3 Pool (Optimism)',
    },
    // Compound V3 (Base)
    {
        address: '0xb125e6687d4313864e53df431d5425969c15eb2f',
        chain: 'base',
        platform: 'Compound V3',
        category: 'defi_lending',
        riskTier: 'medium',
        description: 'Compound V3 USDC Market (Base)',
    },
];

/**
 * All known contracts, indexed by lowercase address for O(1) lookup.
 */
const KNOWN_CONTRACTS_BY_ADDRESS: Map<string, KnownContract> = new Map();

// Build index
for (const contract of [
    ...PREDICTION_MARKET_CONTRACTS,
    ...DEX_CONTRACTS,
    ...DEFI_CONTRACTS,
]) {
    KNOWN_CONTRACTS_BY_ADDRESS.set(contract.address.toLowerCase(), contract);
}

// ============================================================================
// FUNCTION SELECTOR PATTERNS
// ============================================================================
// 4-byte function selectors for common operations.
// Used as fallback when contract address isn't in the known registry.
// ============================================================================

interface SelectorPattern {
    selector: string;       // 4-byte hex (e.g., '0xa9059cbb')
    name: string;           // Function name
    category: CryptoTransactionCategory;
    confidence: number;     // How confident we are (selectors can collide)
}

const KNOWN_SELECTORS: SelectorPattern[] = [
    // ERC-20
    { selector: '0xa9059cbb', name: 'transfer(address,uint256)', category: 'token_transfer', confidence: 0.95 },
    { selector: '0x23b872dd', name: 'transferFrom(address,address,uint256)', category: 'token_transfer', confidence: 0.9 },
    { selector: '0x095ea7b3', name: 'approve(address,uint256)', category: 'token_approval', confidence: 0.95 },
    { selector: '0x39509351', name: 'increaseAllowance(address,uint256)', category: 'token_approval', confidence: 0.9 },

    // Uniswap / DEX
    { selector: '0x38ed1739', name: 'swapExactTokensForTokens', category: 'dex_swap', confidence: 0.85 },
    { selector: '0x7ff36ab5', name: 'swapExactETHForTokens', category: 'dex_swap', confidence: 0.85 },
    { selector: '0x18cbafe5', name: 'swapExactTokensForETH', category: 'dex_swap', confidence: 0.85 },
    { selector: '0x5ae401dc', name: 'multicall(uint256,bytes[])', category: 'dex_swap', confidence: 0.7 },

    // Polymarket / Prediction Markets
    { selector: '0x7d16e257', name: 'buyTokens', category: 'prediction_market', confidence: 0.8 },
    { selector: '0xe6ba0a9a', name: 'sellTokens', category: 'prediction_market', confidence: 0.8 },
    { selector: '0xfe87a6a0', name: 'redeemPositions', category: 'prediction_market', confidence: 0.8 },

    // Governance
    { selector: '0x56781388', name: 'castVote(uint256,uint8)', category: 'governance', confidence: 0.8 },
];

const SELECTORS_BY_HEX: Map<string, SelectorPattern> = new Map();
for (const pattern of KNOWN_SELECTORS) {
    SELECTORS_BY_HEX.set(pattern.selector.toLowerCase(), pattern);
}

// ============================================================================
// CLASSIFICATION ENGINE
// ============================================================================

export interface CryptoTransactionInput {
    /** Target contract address (null for native transfers) */
    to: string | null;
    /** Transaction value in wei/lamports (native currency amount) */
    value: string;
    /** Call data (hex encoded, includes 4-byte selector) */
    data?: string;
    /** Chain identifier */
    chain: string;
    /** Chain ID (EVM) */
    chainId?: number;
}

/**
 * Classify a crypto transaction.
 *
 * Classification priority:
 * 1. Known contract address match (highest confidence)
 * 2. Function selector match
 * 3. Native transfer detection (no data, value > 0)
 * 4. Contract creation detection (no `to`)
 * 5. Unknown (defaults to hard_confirm)
 */
export function classifyCryptoTransaction(tx: CryptoTransactionInput, biometricAction?: BiometricAction): CryptoClassification {
    // Contract creation
    if (!tx.to) {
        return {
            category: 'contract_deploy',
            confidence: 0.95,
            isKnownContract: false,
            riskTier: 'critical',
        };
    }

    const normalizedTo = tx.to.toLowerCase();

    // 1. Check known contract registry
    const knownContract = KNOWN_CONTRACTS_BY_ADDRESS.get(normalizedTo);
    if (knownContract) {
        return {
            category: knownContract.category,
            confidence: 1.0,
            platform: knownContract.platform,
            subAction: detectSubAction(tx.data, knownContract.category),
            isKnownContract: true,
            riskTier: knownContract.riskTier,
        };
    }

    // 2. Check function selector (if call data exists)
    if (tx.data && tx.data.length >= 10) {
        const selector = tx.data.slice(0, 10).toLowerCase();
        const selectorMatch = SELECTORS_BY_HEX.get(selector);
        if (selectorMatch) {
            return {
                category: selectorMatch.category,
                confidence: selectorMatch.confidence,
                subAction: selectorMatch.name,
                isKnownContract: false,
                riskTier: getRiskTierForCategory(selectorMatch.category),
            };
        }
    }

    // 3. Native transfer (value > 0, no data or just '0x')
    if ((!tx.data || tx.data === '0x' || tx.data === '') && tx.value && tx.value !== '0') {
        return {
            category: 'token_transfer',
            confidence: 0.95,
            isKnownContract: false,
            riskTier: 'low',
        };
    }

    // 4. Unknown contract interaction - trigger lazy registry refresh
    refreshRegistryFromBackend(biometricAction).catch(() => {});

    return {
        category: 'unknown',
        confidence: 0.0,
        isKnownContract: false,
        riskTier: 'critical',
    };
}

/**
 * Check if a transaction targets a prediction market contract.
 */
export function isPredictionMarketTransaction(tx: CryptoTransactionInput, biometricAction?: BiometricAction): boolean {
    const classification = classifyCryptoTransaction(tx, biometricAction);
    return classification.category === 'prediction_market';
}

/**
 * Check if a contract address is in the prediction market registry.
 */
export function isKnownPredictionMarketContract(address: string): boolean {
    return PREDICTION_MARKET_CONTRACTS.some(
        c => c.address.toLowerCase() === address.toLowerCase()
    );
}

/**
 * Get all known prediction market contract addresses for a chain.
 */
export function getPredictionMarketContractsForChain(chain: string): string[] {
    return PREDICTION_MARKET_CONTRACTS
        .filter(c => c.chain === chain)
        .map(c => c.address);
}

/**
 * Get the platform name for a contract address.
 */
export function getPlatformForContract(address: string): string | undefined {
    return KNOWN_CONTRACTS_BY_ADDRESS.get(address.toLowerCase())?.platform;
}

// ============================================================================
// BACKEND REGISTRY REFRESH
// ============================================================================
// Merges entries from the backend contract registry into the in-memory map.
// Backend entries take precedence over hardcoded for the same address.
// Fails silently - if backend is unreachable, hardcoded list is the baseline.
// ============================================================================

import AsyncStorage from '@react-native-async-storage/async-storage';

const REGISTRY_CACHE_KEY = '@provian_contract_registry';
const REGISTRY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface RegistryCacheEntry {
    entries: KnownContract[];
    cachedAt: number;
}

let registryRefreshInFlight = false;
let lastRefreshAttempt = 0;
const MIN_REFRESH_INTERVAL = 30_000; // Don't retry more than once per 30s

/**
 * Refresh the contract registry from the backend.
 * Called at app startup and lazily when an unknown contract is encountered.
 * Non-blocking - never delays classification.
 */
export async function refreshRegistryFromBackend(biometricAction?: BiometricAction): Promise<void> {
    // Prevent concurrent fetches and rapid retries
    const now = Date.now();
    if (registryRefreshInFlight || now - lastRefreshAttempt < MIN_REFRESH_INTERVAL) return;
    registryRefreshInFlight = true;
    lastRefreshAttempt = now;

    try {
        // Check AsyncStorage cache first
        const cached = await AsyncStorage.getItem(REGISTRY_CACHE_KEY);
        if (cached) {
            const cacheEntry: RegistryCacheEntry = JSON.parse(cached);
            if (now - cacheEntry.cachedAt < REGISTRY_CACHE_TTL) {
                mergeBackendEntries(cacheEntry.entries);
                return;
            }
        }

        // Fetch from backend through the app's WALLET-AUTHED request path.
        // `/v1/contract-registry` is behind the app-authed pre-launch surface gate,
        // so it serves the unpublished app pre-flip (a Bearer credential present)
        // and 404s an anonymous public-web caller. Lazy import keeps the
        // RelayAPIService graph off this classifier module (mirrors BalanceService).
        const { default: relayService } = await import('../../services/RelayAPIService');
        const data = await relayService.getContractRegistry(biometricAction);
        if (!data) {
            // Non-ok / network / pre-auth: degrade to the hardcoded list silently.
            return;
        }
        const { entries } = data as { entries: KnownContract[] };

        // [M-10] HMAC verification removed from client - the signing secret was
        // bundled in the app binary (EXPO_PUBLIC_), making it extractable.
        // Integrity is now provided by HTTPS transport + wallet auth on the endpoint.
        if (!entries || !Array.isArray(entries)) {
            console.warn('[CryptoClassifier] Registry response missing entries');
            return;
        }

        // Merge and cache
        mergeBackendEntries(entries);
        await AsyncStorage.setItem(
            REGISTRY_CACHE_KEY,
            JSON.stringify({ entries, cachedAt: now } satisfies RegistryCacheEntry),
        );
    } catch (err) {
        console.warn('[CryptoClassifier] Registry refresh failed (using hardcoded list):', err);
    } finally {
        registryRefreshInFlight = false;
    }
}

/**
 * Merge backend entries into the in-memory map.
 * Backend entries take precedence over hardcoded for the same address.
 */
function mergeBackendEntries(entries: KnownContract[]): void {
    for (const entry of entries) {
        if (entry.address && entry.category) {
            KNOWN_CONTRACTS_BY_ADDRESS.set(entry.address.toLowerCase(), entry);
        }
    }
}

// ============================================================================
// HELPERS
// ============================================================================

function detectSubAction(data: string | undefined, category: CryptoTransactionCategory): string | undefined {
    if (!data || data.length < 10) return undefined;
    const selector = data.slice(0, 10).toLowerCase();
    const match = SELECTORS_BY_HEX.get(selector);
    return match?.name;
}

function getRiskTierForCategory(category: CryptoTransactionCategory): 'low' | 'medium' | 'high' | 'critical' {
    switch (category) {
        case 'token_transfer':
            return 'low';
        case 'token_approval':
        case 'dex_swap':
        case 'defi_lending':
        case 'defi_staking':
        case 'governance':
            return 'medium';
        case 'prediction_market':
        case 'nft_trade':
        case 'bridge':
            return 'high';
        case 'contract_deploy':
        case 'unknown':
            return 'critical';
    }
}
