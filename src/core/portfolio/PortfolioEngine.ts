import { CHAIN_IDS, CHAINS } from '../chains/ChainConstants';

export interface TokenBalance {
    chainId: number;
    address: string; // Contract address or 'native'
    symbol: string;
    name: string;
    decimals: number;
    balance: string;
    usdValue?: number;
}

export interface PortfolioView {
    totalUsdValue: number;
    assets: TokenBalance[];
    byChain: Record<number, number>; // ChainId -> UsdValue
}

class PortfolioEngine {
    private static instance: PortfolioEngine;
    private cache: Map<string, PortfolioView> = new Map();

    private constructor() { }

    static getInstance(): PortfolioEngine {
        if (!PortfolioEngine.instance) {
            PortfolioEngine.instance = new PortfolioEngine();
        }
        return PortfolioEngine.instance;
    }

    /**
     * Get portfolio for an account (Stubbed)
     */
    async getPortfolioForAccount(account: string): Promise<PortfolioView> {
        const assets: TokenBalance[] = [];
        let totalUsd = 0;
        const byChain: Record<number, number> = {};

        const chainIds = [CHAIN_IDS.BASE, CHAIN_IDS.ARBITRUM, CHAIN_IDS.OPTIMISM];

        for (const chainId of chainIds) {
            const chain = CHAINS[chainId];
            if (!chain) continue;

            const nativeBal = '1.5';
            const nativePrice = 1850;
            const nativeUsd = parseFloat(nativeBal) * nativePrice;

            assets.push({
                chainId: chain.id,
                address: 'native',
                symbol: chain.nativeCurrency,
                name: chain.name,
                decimals: chain.nativeCurrencyDecimals,
                balance: nativeBal,
                usdValue: nativeUsd
            });

            const usdcBal = '500.0';
            const usdcUsd = 500.0;
            assets.push({
                chainId: chain.id,
                address: '0xA0b8...eB48',
                symbol: 'USDC',
                name: 'USD Coin',
                decimals: 6,
                balance: usdcBal,
                usdValue: usdcUsd
            });

            const chainTotal = nativeUsd + usdcUsd;
            byChain[chain.id] = chainTotal;
            totalUsd += chainTotal;
        }

        const view: PortfolioView = {
            totalUsdValue: totalUsd,
            assets,
            byChain
        };

        this.cache.set(account, view);
        return view;
    }

    async getAssetBreakdown(account: string) {
        const portfolio = await this.getPortfolioForAccount(account);
        const breakdown: Record<string, number> = {};
        for (const asset of portfolio.assets) {
            breakdown[asset.symbol] = (breakdown[asset.symbol] || 0) + (asset.usdValue || 0);
        }
        return breakdown;
    }
}

export default PortfolioEngine.getInstance();
