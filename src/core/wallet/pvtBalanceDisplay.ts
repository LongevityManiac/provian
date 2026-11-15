import type { Asset } from '../../store/walletStore';

export interface ConfirmedPvtBalance {
    walletAddress: string;
    tokenAddress: string;
    chainId: 8453;
    balance: string;
    confirmedAt: number;
}
/** Display history only. This is never a deployment proof or spending authority. */
export function cachedPvtAsset(value: unknown, wallet: string, mainnet = true): Asset | null {
    if (!mainnet || !value || typeof value !== 'object') return null;
    const saved = value as Partial<ConfirmedPvtBalance>;
    if (!/^0x[0-9a-f]{40}$/i.test(wallet) || typeof saved.walletAddress !== 'string' || saved.walletAddress.toLowerCase() !== wallet.toLowerCase()
        || saved.chainId !== 8453 || typeof saved.tokenAddress !== 'string'
        || !/^0x[0-9a-f]{40}$/i.test(saved.tokenAddress) || typeof saved.balance !== 'string'
        || !/^\d+(?:\.\d+)?$/.test(saved.balance) || typeof saved.confirmedAt !== 'number'
        || !Number.isFinite(saved.confirmedAt) || saved.confirmedAt <= 0) return null;
    return { symbol: 'PVT', name: 'Provian Value Token', balance: saved.balance,
        price: 0, chain: 'Base', chainId: 8453, tokenAddress: saved.tokenAddress, decimals: 18, isPVT: true };
}
