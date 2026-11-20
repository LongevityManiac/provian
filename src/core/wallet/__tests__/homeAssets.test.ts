import { describe, expect, it } from 'vitest';
import type { Asset } from '../../../store/walletStore';
import { homeAssetBalance, homeAssets } from '../homeAssets';

const asset = (symbol: string, balance: string, chain: Asset['chain'] = 'Base'): Asset => ({
    symbol, name: symbol, balance, chain, price: 0,
});

describe('Home asset list', () => {
    it('pins PVT, USDC and ETH, preserves holds on separate networks, and hides empty holdings', () => {
        const confirmedPvt = { ...asset('PVT', '10'), isPVT: true };
        const baseUsdc = asset('USDC', '0.2');
        const solanaUsdc = asset('USDC', '0.1', 'Solana');
        const list = homeAssets([asset('DAI', '0.00'), baseUsdc, asset('PVT', '99'), solanaUsdc,
            asset('ETH', '0'), asset('SOL', '0.01', 'Solana')], confirmedPvt, true);

        expect(list.map(row => row.symbol)).toEqual(['PVT', 'USDC', 'ETH', 'SOL']);
        expect(list[0].holdings).toEqual([confirmedPvt]);
        expect(list[1].holdings).toEqual([baseUsdc, solanaUsdc]);
        expect(homeAssetBalance(list[1], true)).toBe('0.3');
        expect(homeAssetBalance(list[1], false)).toBeNull();
    });

    it('keeps supported assets visible before balances arrive without showing zeros', () => {
        const list = homeAssets([], null, true);
        expect(list.map(row => row.symbol)).toEqual(['PVT', 'USDC', 'ETH']);
        expect(list.map(row => homeAssetBalance(row, false))).toEqual([null, null, null]);
    });
});
