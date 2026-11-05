import type { BiometricAction } from '../security/biometricAction';
/**
 * BalanceService - Balance Queries (EVM + Solana)
 *
 * Queries real balances from supported chains:
 * - EVM L2s: Base, Arbitrum, Optimism (ETH + USDC + USDT + DAI + WETH), and the
 *   relay-read PVT9 balance on Base.
 * - Solana: native SOL + USDC (SPL) + the listed tokens held (chains/solana/tokens.ts), read from Solana RPC. Solana is a distinct
 *   address space and is NOT part of the EVM chainId token loop; its assets are
 *   read and shaped exactly like the out-of-band PVT asset (fetchSolanaAssets),
 *   then flow through the same merge → price-overlay → store pipeline.
 *
 * Environment-aware: mainnet by default, testnet in __DEV__ builds.
 * Updates walletStore.assets with live data.
 */

import { ethers } from 'ethers';
import {
    getActiveChains,
    getTokenAddresses,
    PVT9_TOKEN,
    type ChainConfig,
} from '../chains/evm/config';
import { isTestnet } from '../shared/environment';
import { useWalletStore, Asset } from '../../store/walletStore';
import PriceService, { type TokenPrice } from '../prices/PriceService';

// ERC-20 balanceOf + decimals ABI fragments
const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
];

const TOKEN_META: Record<string, { name: string; isStablecoin?: boolean }> = {
    ETH: { name: 'Ethereum' },
    SOL: { name: 'Solana' },
    USDC: { name: 'USD Coin', isStablecoin: true },
    'USDC.e': { name: 'Bridged USDC', isStablecoin: true },
    USDT: { name: 'Tether', isStablecoin: true },
    DAI: { name: 'Dai', isStablecoin: true },
    WETH: { name: 'Wrapped Ether' },
};

const CHAIN_NAME_MAP: Record<number, Asset['chain']> = {
    8453: 'Base',
    42161: 'Arbitrum',
    10: 'Optimism',
    84532: 'Base',
    421614: 'Arbitrum',
    11155420: 'Optimism',
};

function formatBalance(raw: bigint, tokenDecimals: number, displayDecimals: number): string {
    const full = ethers.formatUnits(raw, tokenDecimals);
    const dotIndex = full.indexOf('.');
    if (dotIndex === -1) {
        return displayDecimals > 0 ? `${full}.${'0'.repeat(displayDecimals)}` : full;
    }
    const intPart = full.slice(0, dotIndex);
    const fracPart = full.slice(dotIndex + 1);
    if (fracPart.length <= displayDecimals) {
        return `${intPart}.${fracPart.padEnd(displayDecimals, '0')}`;
    }
    return `${intPart}.${fracPart.slice(0, displayDecimals)}`;
}

// the only price the wallet ever uses without a feed observation is a
// stablecoin's $1 peg. There is no hardcoded market price for any floating asset
// (ETH was pinned at $3,200 and SOL at $150 here) — an unpriced floating asset is
// 'unknown' and renders "—", never a made-up or $0.00 value.
const STABLECOIN_PEG_SYMBOLS: ReadonlySet<string> = new Set(['USDC', 'USDC.E', 'USDT', 'DAI', 'PYUSD']);

/**
 * Stamp every asset's price from the last known feed prices (PriceService keeps
 * each symbol's last observation with its time). PVT is left alone (no market;
 * its tile shows no USD line). Pure, so it is tested directly.
 */
export function priceAssets(assets: Asset[], livePrices: Record<string, TokenPrice>): void {
    for (const asset of assets) {
        if (asset.isPVT === true) continue;
        const live = livePrices[asset.symbol.toUpperCase()];
        if (live && Number.isFinite(live.usd) && live.usd > 0) {
            asset.price = live.usd;
            asset.priceStatus = 'market';
            asset.priceAsOf = live.as_of;
        } else if (asset.isStablecoin === true || STABLECOIN_PEG_SYMBOLS.has(asset.symbol.toUpperCase())) {
            asset.price = 1;
            asset.priceStatus = 'peg';
            delete asset.priceAsOf;
        } else if (asset.priceStatus === 'market' && asset.price > 0) {
            // A price carried on a preserved prior snapshot stays with its age.
        } else {
            asset.price = 0;
            asset.priceStatus = 'unknown';
            delete asset.priceAsOf;
        }
    }
}

class BalanceService {
    private static instance: BalanceService;
    private providers: Map<number, ethers.JsonRpcProvider> = new Map();
    // [#31] Coalesce overlapping full-balance fetches per address so a slow
    // earlier call can't resolve after a faster later one and clobber the store
    // with stale data (last-write-wins race).
    private inFlight: Map<string, Promise<{ assets: Asset[]; failedChainIds: number[] }>> = new Map();

    private constructor() {}

    static getInstance(): BalanceService {
        if (!BalanceService.instance) {
            BalanceService.instance = new BalanceService();
        }
        return BalanceService.instance;
    }

    private getProvider(chain: ChainConfig): ethers.JsonRpcProvider {
        if (!this.providers.has(chain.chainId)) {
            this.providers.set(chain.chainId, new ethers.JsonRpcProvider(chain.rpcUrl));
        }
        return this.providers.get(chain.chainId)!;
    }

    clearProviders(): void {
        this.providers.clear();
    }

    /**
     * Query one chain's balances using a specific provider. Throws on a
     * chain-level RPC failure (e.g. the ETH getBalance call fails) so the
     * caller can retry on the fallback RPC. Per-token failures are tolerated
     * and reported via `failedSymbols` (which tokens failed) rather than thrown.
     */
    private async fetchChainBalancesWithProvider(
        address: string,
        chain: ChainConfig,
        provider: ethers.JsonRpcProvider,
    ): Promise<{ assets: Asset[]; failedSymbols: string[] }> {
        const assets: Asset[] = [];
        const chainName = CHAIN_NAME_MAP[chain.chainId] || 'Base';

        // Chain-level call: if this throws the chain RPC is considered down.
        const ethBalance = await provider.getBalance(address);
        assets.push({
            symbol: 'ETH',
            name: 'Ethereum',
            balance: formatBalance(ethBalance, 18, 6),
            price: 0,
            chain: chainName,
            chainId: chain.chainId,
            decimals: 18,
        });

        // #42: track WHICH tokens failed (not just a count) so the merge step can
        // restore each still-held-but-unreadable token from the prior snapshot
        // instead of dropping it from the list.
        const failedSymbols: string[] = [];
        const tokenAddresses = getTokenAddresses(chain.chainId);
        for (const [symbol, tokenAddr] of Object.entries(tokenAddresses)) {
            try {
                const contract = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
                const [rawBalance, decimals] = await Promise.all([
                    contract.balanceOf(address) as Promise<bigint>,
                    contract.decimals() as Promise<number>,
                ]);

                const meta = TOKEN_META[symbol] || { name: symbol };
                const displayDecimals = decimals <= 8 ? 2 : 6;

                assets.push({
                    symbol,
                    name: meta.name,
                    balance: formatBalance(rawBalance, decimals, displayDecimals),
                    price: 0,
                    chain: chainName,
                    chainId: chain.chainId,
                    tokenAddress: tokenAddr,
                    decimals,
                    isStablecoin: meta.isStablecoin,
                });
            } catch (err) {
                failedSymbols.push(symbol);
                console.warn(`[BalanceService] Failed to fetch ${symbol} on ${chain.name}:`, err);
            }
        }

        return { assets, failedSymbols };
    }

    /**
     * Fetch one chain's balances, retrying on the configured fallback RPC if
     * the primary fails. Returns `{ assets, failed }` where `failed` is true if
     * the chain could not be read at all (both RPCs down) OR a token sub-fetch
     * failed - i.e. the result is NOT a trustworthy "everything is zero".
     * Crucially this never silently maps an RPC outage to an empty balance set
     * without flagging it (review #5).
     */
    private async fetchEVMChainBalances(
        address: string,
        chain: ChainConfig,
    ): Promise<{ assets: Asset[]; failed: boolean; failedSymbols: string[] }> {
        try {
            const { assets, failedSymbols } = await this.fetchChainBalancesWithProvider(
                address,
                chain,
                this.getProvider(chain),
            );
            return { assets, failed: failedSymbols.length > 0, failedSymbols };
        } catch (primaryErr) {
            console.warn(`[BalanceService] Primary RPC failed on ${chain.name}:`, primaryErr);
        }

        if (chain.fallbackRpcUrl) {
            try {
                const provider = new ethers.JsonRpcProvider(chain.fallbackRpcUrl);
                const { assets, failedSymbols } = await this.fetchChainBalancesWithProvider(
                    address,
                    chain,
                    provider,
                );
                return { assets, failed: failedSymbols.length > 0, failedSymbols };
            } catch (fallbackErr) {
                console.warn(`[BalanceService] Fallback RPC failed on ${chain.name}:`, fallbackErr);
            }
        }

        // Both primary and fallback failed: signal failure with no assets so the
        // caller preserves the prior snapshot instead of wiping the chain to $0.
        return { assets: [], failed: true, failedSymbols: [] };
    }

    /**
     * Stamp USD prices from the relay price feed (PriceService keeps every
     * symbol's last known price with its age;). A feed failure never
     * zeroes a price: last-known prices stay, stablecoins sit at their peg, and
     * an asset that was never priced is 'unknown' (" " in the UI).
     */
    private async applyLivePrices(assets: Asset[]): Promise<void> {
        if (assets.length === 0) {
            return;
        }
        let livePrices: Record<string, TokenPrice> = {};
        try {
            const symbols = Array.from(new Set(assets.map(a => a.symbol)));
            livePrices = await PriceService.getPrices(symbols);
        } catch (err) {
            console.warn('[BalanceService] Price read failed; stamping from what is known:', err);
        }
        priceAssets(assets, livePrices);
    }

    private async fetchAllEVMBalances(
        address: string,
    ): Promise<Array<{ chainId: number; assets: Asset[]; failed: boolean; failedSymbols: string[] }>> {
        const chains = getActiveChains();
        const results = await Promise.allSettled(
            chains.map(chain =>
                this.fetchEVMChainBalances(address, chain).then(r => ({ chainId: chain.chainId, ...r })),
            ),
        );

        return results.map((result, i) =>
            result.status === 'fulfilled'
                ? result.value
                : { chainId: chains[i].chainId, assets: [], failed: true, failedSymbols: [] },
        );
    }

    /**
     * Fetch all balances across supported EVM chains, update the store, and
     * report which chains could not be read. Chains that failed entirely keep
     * their prior snapshot rather than being wiped to $0 (review #5), and
     * overlapping calls are coalesced (review #31).
     */
    async fetchAllBalancesDetailed(
        address: string, biometricAction?: BiometricAction,
    ): Promise<{ assets: Asset[]; failedChainIds: number[] }> {
        const existing = this.inFlight.get(address);
        if (existing) {
            return existing;
        }
        const promise = this.doFetchAllBalances(address, biometricAction).finally(() => {
            this.inFlight.delete(address);
        });
        this.inFlight.set(address, promise);
        return promise;
    }

    private async doFetchAllBalances(
        address: string, biometricAction?: BiometricAction,
    ): Promise<{ assets: Asset[]; failedChainIds: number[] }> {
        const env = isTestnet() ? 'testnet' : 'mainnet';
        console.log(`[BalanceService] Fetching balances (${env}) for ${address.slice(0, 8)}...`);

        // Start independent networks together. Publish a verified PVT balance
        // as soon as its relay read finishes, without waiting for every EVM
        // chain, Solana, and the price overlay. The final merged snapshot still
        // lands once all reads have settled.
        const pvtRead = this.fetchPvtAsset(address, biometricAction).then((result) => {
            if (result.asset) {
                const state = useWalletStore.getState();
                if (!state.address || state.address.toLowerCase() === address.toLowerCase()) {
                    state.setAssets([
                        ...state.assets.filter((asset) => asset.isPVT !== true),
                        result.asset,
                    ]);
                }
            }
            return result;
        });
        const [perChain, pvtResult, solana] = await Promise.all([
            this.fetchAllEVMBalances(address),
            pvtRead,
            this.fetchSolanaAssets(),
        ]);
        const prior = useWalletStore.getState().assets;

        const merged: Asset[] = [];
        const failedChainIds: number[] = [];
        for (const chainResult of perChain) {
            if (chainResult.assets.length > 0) {
                // Got fresh data (possibly partial) - use it.
                merged.push(...chainResult.assets);
                // #42: chain up, but one token's read failed this tick. The fresh
                // set is missing that still-held token, so restore it from the
                // prior snapshot instead of dropping it from totals + the
                // Send/Swap pickers. review #5 only preserved the prior snapshot
                // when a chain FULLY failed (assets.length===0); this covers the
                // chain-up/one-token-down partial case.
                if (chainResult.failed && chainResult.failedSymbols.length > 0) {
                    const freshSymbols = new Set(chainResult.assets.map(a => a.symbol));
                    for (const priorAsset of prior) {
                        if (
                            priorAsset.chainId === chainResult.chainId &&
                            priorAsset.isPVT !== true &&
                            chainResult.failedSymbols.includes(priorAsset.symbol) &&
                            !freshSymbols.has(priorAsset.symbol)
                        ) {
                            merged.push(priorAsset);
                        }
                    }
                }
            } else if (chainResult.failed) {
                // Total failure for this chain: preserve the prior snapshot so a
                // transient RPC outage doesn't blink the user's balance to $0.
                merged.push(...prior.filter(a => a.chainId === chainResult.chainId && a.isPVT !== true));
            }
            if (chainResult.failed) {
                failedChainIds.push(chainResult.chainId);
            }
        }

        // PVT9 balance (human PVT spendability,; reader LIVE pre-flip per
        //). Sourced from the relay reader — NOT the on-chain token loop —
        // because PVT is deliberately kept out of TOKEN_ADDRESSES. Base-mainnet
        // only. Never fails the whole balance refresh.
        if (pvtResult.asset) {
            merged.push(pvtResult.asset);
        } else if (pvtResult.failed) {
            // A failed balance read is unknown, never zero. Retain the last
            // confirmed tile and trigger the existing "outdated" warning.
            merged.push(...prior.filter((asset) => asset.isPVT === true));
            if (!failedChainIds.includes(PVT9_TOKEN.chainId)) {
                failedChainIds.push(PVT9_TOKEN.chainId);
            }
        }

        // Solana assets (SOL + USDC-SPL), read from Solana RPC using the
        // same-seed Solana address. On failure, preserve the prior Solana
        // snapshot rather than blinking those balances to nothing.
        if (solana.assets.length > 0) {
            merged.push(...solana.assets);
        } else if (solana.failed) {
            merged.push(...prior.filter(a => a.chain === 'Solana'));
        }

        await this.applyLivePrices(merged);
        const state = useWalletStore.getState();
        if (!state.address || state.address.toLowerCase() === address.toLowerCase()) {
            state.setAssets(merged);
        }

        console.log(
            `[BalanceService] Fetched ${merged.length} assets across ${env}` +
                (failedChainIds.length ? ` (${failedChainIds.length} chain(s) failed)` : ''),
        );
        return { assets: merged, failedChainIds };
    }

    /**
     * Fetch all balances across supported EVM chains and update the store.
     * Back-compat wrapper returning just the assets.
     */
    async fetchAllBalances(address: string, biometricAction?: BiometricAction): Promise<Asset[]> {
        return (await this.fetchAllBalancesDetailed(address, biometricAction)).assets;
    }

    /**
     * Fetch the wallet's on-chain PVT9 balance via the relay reader and shape
     * it as a first-class, sendable Asset. Testnet has no PVT card; a failed
     * relay read retains the last confirmed card with an outdated warning.
     * The address is the wallet's single EVM address (same across chains).
     * The Asset carries the pinned successor-kernel address so a first-party
     * send resolves the transfer target with no relay round-trip.
     */
    private async fetchPvtAsset(address: string, biometricAction?: BiometricAction): Promise<{ asset: Asset | null; failed: boolean }> {
        if (isTestnet()) {
            return { asset: null, failed: false };
        }
        try {
            // Lazy import: keeps the RelayAPIService graph off BalanceService's
            // static import path and out of the hot loop.
            const { default: relayService } = await import('../../services/RelayAPIService');
            const pvt = await relayService.getPVTBalance(address, biometricAction);
            if (!pvt || typeof pvt.balance_raw !== 'string' || !/^\d+$/.test(pvt.balance_raw)) {
                return { asset: null, failed: true };
            }
            return { asset: {
                symbol: PVT9_TOKEN.symbol,
                name: PVT9_TOKEN.name,
                balance: formatBalance(BigInt(pvt.balance_raw), PVT9_TOKEN.decimals, 4),
                // No USD price oracle for PVT. Kept at 0 so it contributes $0 to
                // the fiat total; the PVT card suppresses the misleading "$0.00"
                // line (DashboardScreen renders isPVT assets without a USD value).
                price: 0,
                chain: 'Base',
                chainId: PVT9_TOKEN.chainId,
                tokenAddress: PVT9_TOKEN.address,
                decimals: PVT9_TOKEN.decimals,
                isPVT: true,
            }, failed: false };
        } catch (err) {
            console.warn('[BalanceService] PVT balance fetch failed (non-fatal):', err);
            return { asset: null, failed: true };
        }
    }

    /**
     * Fetch Solana balances (native SOL + USDC-SPL) and shape them as
     * first-class Assets, exactly like fetchPvtAsset shapes the out-of-band PVT
     * asset. Reads the wallet's Solana address from the store (derived from the
     * same seed as the EVM address). Returns `failed:true` (with empty assets)
     * on RPC failure so the caller can preserve the prior snapshot rather than
     * blink Solana balances to zero.
     */
    private async fetchSolanaAssets(): Promise<{ assets: Asset[]; failed: boolean }> {
        const solanaAddress = useWalletStore.getState().solanaAddress;
        if (!solanaAddress) {
            return { assets: [], failed: false };
        }
        try {
            const { default: solanaRpc } = await import('../chains/solana/SolanaRpc');
            const { getActiveSolanaCluster, SOL_DECIMALS, SOL_SYMBOL, SOLANA_USDC_DECIMALS } =
                await import('../chains/solana/config');
            const cluster = getActiveSolanaCluster();

            const assets: Asset[] = [];
            let anyFailed = false;

            // Native SOL.
            try {
                const lamports = await solanaRpc.getBalanceLamports(solanaAddress);
                assets.push({
                    symbol: SOL_SYMBOL,
                    name: TOKEN_META.SOL.name,
                    balance: formatBalance(BigInt(lamports), SOL_DECIMALS, 6),
                    price: 0,
                    chain: 'Solana',
                    decimals: SOL_DECIMALS,
                });
            } catch (err) {
                anyFailed = true;
                console.warn('[BalanceService] SOL balance fetch failed:', err);
            }

            // USDC (SPL). Shown even at zero balance, at parity with USDC on the
            // EVM chains. A missing associated token account reads as zero.
            try {
                const bal = await solanaRpc.getSplTokenBalance(solanaAddress, cluster.usdcMint);
                const raw = bal ? BigInt(bal.amount) : 0n;
                assets.push({
                    symbol: 'USDC',
                    name: TOKEN_META.USDC.name,
                    balance: formatBalance(raw, SOLANA_USDC_DECIMALS, 2),
                    price: 0,
                    chain: 'Solana',
                    tokenAddress: cluster.usdcMint,
                    decimals: SOLANA_USDC_DECIMALS,
                    isStablecoin: true,
                });
            } catch (err) {
                anyFailed = true;
                console.warn('[BalanceService] Solana USDC balance fetch failed:', err);
            }

            // The listed Solana tokens (BONK, JUP, WIF, PYUSD — tokens.ts), shown once held.
            // A failed read keeps the prior figure rather than dropping a held token.
            const { getListedSolanaTokens, listedTokenAsset } = await import('../chains/solana/tokens');
            const prior = useWalletStore.getState().assets.filter(a => a.chain === 'Solana');
            for (const token of getListedSolanaTokens()) {
                try {
                    const bal = await solanaRpc.getSplTokenBalance(solanaAddress, token.mint);
                    const raw = bal ? BigInt(bal.amount) : 0n;
                    if (raw > 0n) {
                        assets.push(listedTokenAsset(token, formatBalance(raw, token.decimals, 6)));
                    }
                } catch (err) {
                    const kept = prior.find(a => a.tokenAddress === token.mint);
                    if (kept) assets.push(kept);
                    console.warn(`[BalanceService] Solana ${token.symbol} balance fetch failed:`, err);
                }
            }

            // If BOTH reads failed we have nothing fresh: signal failure so the
            // prior snapshot is preserved.
            return { assets, failed: anyFailed && assets.length === 0 };
        } catch (err) {
            console.warn('[BalanceService] Solana balance fetch failed (non-fatal):', err);
            return { assets: [], failed: true };
        }
    }

    /**
     * Fetch balances for a single EVM chain only.
     */
    async fetchChainBalances(address: string, chainId: number): Promise<Asset[]> {
        const chains = getActiveChains();
        const chain = chains.find(c => c.chainId === chainId);
        if (!chain) {
            console.warn(`[BalanceService] Chain ${chainId} not in active chains`);
            return [];
        }
        const { assets } = await this.fetchEVMChainBalances(address, chain);
        await this.applyLivePrices(assets);
        return assets;
    }
}

export default BalanceService.getInstance();
