import { describe, expect, it } from 'vitest';
import type { Asset } from '../../store/walletStore';
import {
    balanceRowForSend,
    formatSolAtLeast,
    formatSolHeld,
    getSendableAssets,
    isSolanaTokenSend,
    offersEvmNetworkPicker,
    resolveInitialSendAsset, defaultSendChainId } from './sendAssetSelection';

const asset = (overrides: Partial<Asset> & Pick<Asset, 'symbol' | 'chain'>): Asset => ({
    name: overrides.symbol,
    balance: '1',
    price: 0,
    ...overrides,
});

const eth = asset({ symbol: 'ETH', chain: 'Base' });
const usdc = asset({ symbol: 'USDC', chain: 'Base', tokenAddress: '0xusdc' });
const sol = asset({ symbol: 'SOL', chain: 'Solana' });
const pvt = asset({
    symbol: 'PVT',
    chain: 'Base',
    tokenAddress: '0xpvt',
    isPVT: true,
});

describe('Send asset selection', () => {
    it('places live PVT first while preserving every other asset order', () => {
        expect(getSendableAssets([eth, usdc, pvt, sol])).toEqual([pvt, eth, usdc, sol]);
    });

    it('defaults a non-prefilled Send flow to PVT', () => {
        expect(resolveInitialSendAsset([eth, usdc, pvt, sol])).toBe(pvt);
    });

    it('still honors an explicitly requested send asset', () => {
        expect(resolveInitialSendAsset([eth, usdc, pvt, sol], 'USDC')).toBe(usdc);
    });

    it('filters a stale PVT-symbol row with no live token backing', () => {
        const stalePvt = asset({ symbol: 'PVT', chain: 'Base' });
        expect(getSendableAssets([eth, stalePvt, pvt])).toEqual([pvt, eth]);
    });
});

// wallet: USDC 0.94 on Base, 1.63 on Solana, 0 SOL. Choosing "USDC (Solana)"
// showed the Base/Arbitrum/Optimism picker, auto-selected Base, and refused 1.00 as
// "You only have 0.94 USDC".
describe('USDC (Solana) is its own asset, not an EVM network option', () => {
    const baseUsdc = asset({ symbol: 'USDC', chain: 'Base', chainId: 8453, tokenAddress: '0xusdc', balance: '0.94' });
    const arbUsdc = asset({ symbol: 'USDC', chain: 'Arbitrum', chainId: 42161, tokenAddress: '0xusdca', balance: '0' });
    const solUsdc = asset({
        symbol: 'USDC',
        chain: 'Solana',
        tokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        balance: '1.63',
    });
    const solNative = asset({ symbol: 'SOL', chain: 'Solana', balance: '0' });
    const wallet = [baseUsdc, arbUsdc, solUsdc, solNative];

    it('RED case: a Solana asset never gets the EVM network picker, whatever the symbol spans', () => {
        expect(offersEvmNetworkPicker(solUsdc, 3)).toBe(false);
        expect(offersEvmNetworkPicker(baseUsdc, 3)).toBe(true);
        expect(offersEvmNetworkPicker(baseUsdc, 1)).toBe(false);
        expect(offersEvmNetworkPicker(null, 3)).toBe(false);
    });

    it('RED case: the balance checked for a Solana USDC send is the Solana row, even with Base selected', () => {
        expect(balanceRowForSend(solUsdc, wallet, 8453)).toBe(solUsdc);
        expect(balanceRowForSend(solUsdc, wallet, 8453).balance).toBe('1.63');
    });

    it('an EVM send still checks the row on the chosen chain', () => {
        expect(balanceRowForSend(baseUsdc, wallet, 42161)).toBe(arbUsdc);
        expect(balanceRowForSend(baseUsdc, wallet, 8453)).toBe(baseUsdc);
        expect(balanceRowForSend(baseUsdc, wallet, 10)).toBe(baseUsdc); // no Optimism row: the asset itself
    });

    it('only a Solana TOKEN send needs the SOL-fee preflight (native SOL and EVM do not)', () => {
        expect(isSolanaTokenSend(solUsdc)).toBe(true);
        expect(isSolanaTokenSend(solNative)).toBe(false);
        expect(isSolanaTokenSend(baseUsdc)).toBe(false);
    });
});

describe('SOL figures in the fee alert', () => {
    const toLamports = (sol: string) => Math.round(parseFloat(sol) * 1e9);

    it("RED case: the \"needs at least\" figure rounds UP, so holding it is enough ", () => {
        expect(formatSolAtLeast(2_935_160)).toBe('0.002936');
        expect(toLamports(formatSolAtLeast(2_935_160))).toBeGreaterThanOrEqual(2_935_160);
    });

    it('never shows less than is needed, nor more than is held, across the range', () => {
        let checked = 0;
        for (let l = 0; l < 5_000_000; l += 997) {
            expect(toLamports(formatSolAtLeast(l))).toBeGreaterThanOrEqual(l);
            expect(toLamports(formatSolAtLeast(l)) - l).toBeLessThan(1000);
            expect(toLamports(formatSolHeld(l))).toBeLessThanOrEqual(l);
            checked++;
        }
        expect(checked).toBeGreaterThan(5000);
        expect(formatSolAtLeast(895_880)).toBe('0.000896');
        expect(formatSolHeld(0)).toBe('0');
    });
});

describe('defaultSendChainId — the tapped row decides the starting network (2026-10-17)', () => {
    const cheapestFirst = [{ chainId: 8453 }, { chainId: 10 }, { chainId: 42161 }];
    it('RED: the Arbitrum USDC row starts on Arbitrum, not the cheapest network', () => {
        expect(defaultSendChainId('Arbitrum', cheapestFirst)).toBe(42161);
        expect(defaultSendChainId('Optimism', cheapestFirst)).toBe(10);
    });
    it('falls back to the cheapest network when the row\'s chain is not offered, and to null with no picker', () => {
        expect(defaultSendChainId('Base', cheapestFirst)).toBe(8453);
        expect(defaultSendChainId('Solana', cheapestFirst)).toBe(8453);
        expect(defaultSendChainId('Arbitrum', [])).toBeNull();
    });
});
