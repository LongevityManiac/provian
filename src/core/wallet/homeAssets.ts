import { formatUnits, parseUnits } from 'ethers';
import type { Asset } from '../../store/walletStore';

export interface HomeAsset {
    key: string;
    symbol: string;
    holdings: Asset[];
}

export const individualAssetKey = (asset: Asset): string =>
    `${asset.chain}:${asset.chainId ?? ''}:${asset.tokenAddress ?? ''}:${asset.symbol}`;

export function homeAssets(assets: readonly Asset[], confirmedPvt: Asset | null, includePvt: boolean): HomeAsset[] {
    const pvt = confirmedPvt ?? assets.find(asset => asset.isPVT === true);
    const pinned = [
        ...(includePvt ? [{ key: 'PVT', symbol: 'PVT', holdings: pvt ? [pvt] : [] }] : []),
        { key: 'USDC', symbol: 'USDC', holdings: assets.filter(asset => asset.symbol === 'USDC') },
        { key: 'ETH', symbol: 'ETH', holdings: assets.filter(asset => asset.symbol === 'ETH') },
    ];
    const additional = assets.filter(asset => !asset.isPVT && !['PVT', 'USDC', 'ETH'].includes(asset.symbol.toUpperCase())
        && Number(asset.balance.replace(/,/g, '')) > 0);
    return [...pinned, ...additional.map(asset => ({
        key: individualAssetKey(asset),
        symbol: asset.symbol,
        holdings: [asset],
    }))];
}

export function homeAssetBalance(asset: HomeAsset, portfolioConfirmed: boolean): string | null {
    if (!asset.holdings.length) return null;
    if (asset.key !== 'USDC' && asset.key !== 'ETH') return asset.holdings[0].balance;
    if (!portfolioConfirmed) return null;
    try {
        const total = asset.holdings.reduce((sum, holding) => sum + parseUnits(holding.balance.replace(/,/g, ''), 18), 0n);
        return formatUnits(total, 18);
    } catch {
        return null;
    }
}
