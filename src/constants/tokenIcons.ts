/**
 * Token Icons
 * ===========
 *
 * Official token icon URLs for supported assets.
 * Uses Trustwallet's open-source asset repository for consistency.
 *
 * Trustwallet repo: https://github.com/trustwallet/assets
 */

// Trustwallet CDN base URL
const TRUSTWALLET_CDN = 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains';

// Chain-specific icon paths
const CHAIN_PATHS: Record<string, string> = {
    base: 'base',
    arbitrum: 'arbitrum',
    optimism: 'optimism',
    solana: 'solana',
};

// Native token icons (not ERC-20s)
export const NATIVE_TOKEN_ICONS: Record<string, string> = {
    ETH: `${TRUSTWALLET_CDN}/ethereum/info/logo.png`,
    SOL: `${TRUSTWALLET_CDN}/solana/info/logo.png`,

    // Wrapped natives
    WETH: `${TRUSTWALLET_CDN}/ethereum/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png`,
    WBTC: `${TRUSTWALLET_CDN}/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599/logo.png`,
    WBNB: `${TRUSTWALLET_CDN}/smartchain/assets/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c/logo.png`,
};

// Stablecoin icons (by symbol - these are consistent across chains)
export const STABLECOIN_ICONS: Record<string, string> = {
    USDC: `${TRUSTWALLET_CDN}/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png`,
    USDT: `${TRUSTWALLET_CDN}/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png`,
    DAI: `${TRUSTWALLET_CDN}/ethereum/assets/0x6B175474E89094C44Da98b954EesdfCdC6B8aBd6e/logo.png`,
    BUSD: `${TRUSTWALLET_CDN}/smartchain/assets/0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56/logo.png`,
    TUSD: `${TRUSTWALLET_CDN}/ethereum/assets/0x0000000000085d4780B73119b644AE5ecd22b376/logo.png`,
    FRAX: `${TRUSTWALLET_CDN}/ethereum/assets/0x853d955aCEf822Db058eb8505911ED77F175b99e/logo.png`,
};

// Other popular tokens
export const POPULAR_TOKEN_ICONS: Record<string, string> = {
    // DeFi
    UNI: `${TRUSTWALLET_CDN}/ethereum/assets/0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984/logo.png`,
    AAVE: `${TRUSTWALLET_CDN}/ethereum/assets/0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9/logo.png`,
    LINK: `${TRUSTWALLET_CDN}/ethereum/assets/0x514910771AF9Ca656af840dff83E8264EcF986CA/logo.png`,
    MKR: `${TRUSTWALLET_CDN}/ethereum/assets/0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2/logo.png`,
    CRV: `${TRUSTWALLET_CDN}/ethereum/assets/0xD533a949740bb3306d119CC777fa900bA034cd52/logo.png`,
    LDO: `${TRUSTWALLET_CDN}/ethereum/assets/0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32/logo.png`,

    // Staked tokens
    stETH: `${TRUSTWALLET_CDN}/ethereum/assets/0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84/logo.png`,
    rETH: `${TRUSTWALLET_CDN}/ethereum/assets/0xae78736Cd615f374D3085123A210448E74Fc6393/logo.png`,
    cbETH: `${TRUSTWALLET_CDN}/ethereum/assets/0xBe9895146f7AF43049ca1c1AE358B0541Ea49704/logo.png`,

    // Memes / Popular
    DOGE: `${TRUSTWALLET_CDN}/dogecoin/info/logo.png`,
    SHIB: `${TRUSTWALLET_CDN}/ethereum/assets/0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE/logo.png`,
    PEPE: `${TRUSTWALLET_CDN}/ethereum/assets/0x6982508145454Ce325dDbE47a25d4ec3d2311933/logo.png`,

    // Worldcoin / WLFI
    WLD: `${TRUSTWALLET_CDN}/ethereum/assets/0x163f8c2467924be0ae7b5347228cabf260318753/logo.png`,
};

// Chain icons (for network badges)
export const CHAIN_ICONS: Record<string, string> = {
    Base: 'https://raw.githubusercontent.com/base-org/brand-kit/main/logo/symbol/Base_Symbol_Blue.png',
    Arbitrum: `${TRUSTWALLET_CDN}/arbitrum/info/logo.png`,
    Optimism: `${TRUSTWALLET_CDN}/optimism/info/logo.png`,
    Solana: `${TRUSTWALLET_CDN}/solana/info/logo.png`,
};

// PVT uses a custom rendered icon (PVTIcon component), not a URL.
// This sentinel is used by TokenIcon to detect PVT and render inline.
export const PVT_SYMBOL = 'PVT';

/**
 * Get the icon URL for a token by symbol
 * Falls back through: native -> stablecoin -> popular -> null
 * PVT returns null (rendered by custom component in TokenIcon)
 */
export function getTokenIconUrl(symbol: string): string | null {
    const upperSymbol = symbol.toUpperCase();
    if (upperSymbol === PVT_SYMBOL) return null; // Handled by PVTIcon

    return (
        NATIVE_TOKEN_ICONS[upperSymbol] ||
        STABLECOIN_ICONS[upperSymbol] ||
        POPULAR_TOKEN_ICONS[upperSymbol] ||
        null
    );
}

/**
 * Get the icon URL for a chain
 */
export function getChainIconUrl(chain: string): string | null {
    return CHAIN_ICONS[chain] || null;
}

/**
 * Get token icon by contract address (for EVM chains)
 * @param address - Token contract address (checksummed or lowercase)
 * @param chain - Chain name (Ethereum, Base, etc.)
 */
export function getTokenIconByAddress(address: string, chain: string): string | null {
    const chainPath = CHAIN_PATHS[chain.toLowerCase()];
    if (!chainPath) return null;

    // Trustwallet uses checksummed addresses, but we'll try lowercase too
    return `${TRUSTWALLET_CDN}/${chainPath}/assets/${address}/logo.png`;
}

export default {
    getTokenIconUrl,
    getChainIconUrl,
    getTokenIconByAddress,
    NATIVE_TOKEN_ICONS,
    STABLECOIN_ICONS,
    POPULAR_TOKEN_ICONS,
    CHAIN_ICONS,
};
