import { describe, it, expect } from 'vitest';
import { cachedPvtAsset } from '../pvtBalanceDisplay';
const wallet = `0x${'12'.repeat(20)}`;
const saved = { walletAddress: wallet, tokenAddress: `0x${'34'.repeat(20)}`, chainId: 8453, balance: '94.05', confirmedAt: 1000 };
describe('display-only PVT history', () => {
    it('restores a last-confirmed value only for its own wallet and Base', () => {
        expect(cachedPvtAsset(saved, wallet)?.balance).toBe('94.05');
        expect(cachedPvtAsset(saved, `0x${'56'.repeat(20)}`)).toBeNull();
        expect(cachedPvtAsset({ ...saved, chainId: 1 }, wallet)).toBeNull();
        expect(cachedPvtAsset(saved, wallet, false)).toBeNull();
    });
    it.each([null, {}, { ...saved, walletAddress: 42 }, { ...saved, tokenAddress: 'bad' }, { ...saved, balance: 'NaN' }, { ...saved, confirmedAt: 0 }])('rejects malformed persisted display data %#', value => {
        expect(cachedPvtAsset(value, wallet)).toBeNull();
    });
});

import { useWalletStore } from '../../../store/walletStore';
describe('wallet-bound confirmed display cache', () => {
    it('persists display history separately from live spendable assets and clears it on wallet change', () => {
        const asset = cachedPvtAsset(saved, wallet)!;
        useWalletStore.getState().resetOnboarding();
        useWalletStore.getState().setAddress(wallet);
        useWalletStore.getState().confirmPvtBalance(wallet, asset);
        const confirmed = useWalletStore.getState();
        expect(confirmed.lastConfirmedPvt?.balance).toBe('94.05');
        expect(confirmed.pvtBalanceStatus).toBe('fresh');
        expect(confirmed.assets.some(value => value.isPVT)).toBe(false);
        confirmed.setPvtBalanceStatus('updating');
        expect(useWalletStore.getState().lastConfirmedPvt?.balance).toBe('94.05');
        const other = `0x${'56'.repeat(20)}`;
        useWalletStore.getState().setAddress(other);
        useWalletStore.getState().confirmPvtBalance(wallet, asset);
        expect(useWalletStore.getState().lastConfirmedPvt).toBeNull();
        expect(useWalletStore.getState().pvtBalanceStatus).toBe('updating');
        useWalletStore.getState().setAddress(wallet);
        useWalletStore.getState().confirmPvtBalance(wallet, asset);
        useWalletStore.getState().resetOnboarding();
        expect(useWalletStore.getState().lastConfirmedPvt).toBeNull();
    });
});
