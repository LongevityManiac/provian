import type { Asset } from '../../store/walletStore';
import { getChainIdFromAssetChain } from '../../core/chains/ChainConstants';

/**
 * A sendable asset. PVT9 is a real, first-party sendable ERC-20 :
 * exclude only stale legacy `PVT` rows that predate the balance-reader wiring
 * and therefore do not carry both the live marker and a token address.
 */
export const isSendableAsset = (asset: Asset): boolean =>
    asset.symbol.toUpperCase() !== 'PVT' || (asset.isPVT === true && !!asset.tokenAddress);

/** PVT leads the Send picker; every other asset keeps its wallet-provided order. */
export function getSendableAssets(assets: readonly Asset[]): Asset[] {
    const sendableAssets = assets.filter(isSendableAsset);
    return [
        ...sendableAssets.filter((asset) => asset.isPVT === true),
        ...sendableAssets.filter((asset) => asset.isPVT !== true),
    ];
}

/** An explicit unavailable symbol is a hard miss, never a different asset. */
export function resolveInitialSendAsset(
    assets: readonly Asset[],
    requestedSymbol?: string,
): Asset | null {
    const availableAssets = getSendableAssets(assets);
    if (requestedSymbol) {
        return availableAssets.find((asset) => asset.symbol === requestedSymbol) ?? null;
    }
    return availableAssets[0] ?? null;
}

/**
 * The EVM network picker (Base / Arbitrum / Optimism) applies only to an EVM asset whose symbol
 * exists on more than one EVM chain. A Solana asset — "USDC (Solana)" — is its own asset on its
 * own chain and never gets it: the picker would substitute the EVM default for the chosen asset.
 */
export function offersEvmNetworkPicker(asset: Pick<Asset, 'chain'> | null, evmChainCount: number): boolean {
    return asset !== null && asset.chain !== 'Solana' && evmChainCount > 1;
}

/**
 * The row whose balance a send spends. For an EVM symbol on several chains it is the row on the
 * chosen chain; a Solana asset carries no chainId, and its own row is the balance being spent.
 */
export function balanceRowForSend(asset: Asset, assets: readonly Asset[], chainId: number): Asset {
    if (asset.chain === 'Solana') return asset;
    return assets.find((a) => a.symbol === asset.symbol && a.chainId === chainId) ?? asset;
}

/** A Solana token (SPL) send: its network fee and any recipient-account rent are paid in SOL. */
export function isSolanaTokenSend(asset: Pick<Asset, 'chain' | 'tokenAddress'>): boolean {
    return asset.chain === 'Solana' && !!asset.tokenAddress;
}

/**
 * Lamports → SOL for a "you need at least X" figure: rounded UP at 6 decimals, so holding the
 * displayed amount is always enough (rounding to nearest could show less than is needed).
 */
export function formatSolAtLeast(lamports: number): string {
    return (Math.ceil(lamports / 1000) / 1e6).toString();
}

/** Lamports → SOL for a "you hold X" figure: rounded DOWN, never overstating the balance. */
export function formatSolHeld(lamports: number): string {
    return (Math.floor(lamports / 1000) / 1e6).toString();
}

/**
 * The network a Send starts on for a multi-chain token: the chain of the ROW the person tapped
 * (their "USDC (Arbitrum)" balance) when the picker offers it, else the cheapest. Before this the
 * picker always jumped to the cheapest network, so a tap on the Arbitrum row quietly became a Base
 * send and failed the balance check against a Base balance of zero (2026-10-17 bug check).
 */
export function defaultSendChainId(assetChain: string, availableChains: readonly { readonly chainId: number }[]): number | null {
    if (availableChains.length === 0) return null;
    const home = getChainIdFromAssetChain(assetChain);
    return availableChains.some((c) => c.chainId === home) ? (home as number) : availableChains[0].chainId;
}
