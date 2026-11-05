import { describe, expect, it } from 'vitest';
import type { Asset } from '../../store/walletStore';
import { priceAssets } from '../../core/wallet/BalanceService';
import {
    assetUsdValue,
    formatUsd,
    portfolioTotal,
    priceAgeLabel,
    STALE_PRICE_AFTER_MS,
    UNKNOWN_USD,
} from '../fiatDisplay';

const NOW = 1_790_000_000_000;
const t = (key: string, o?: Record<string, unknown>) => (o ? `${key}:${JSON.stringify(o)}` : key);

function asset(over: Partial<Asset>): Asset {
    return { symbol: 'ETH', name: 'Ethereum', balance: '2', price: 0, chain: 'Base', ...over };
}

describe('fiat display (never $0.00 because a price source failed)', () => {
    it('RED: an unknown price renders "—", not $0.00', () => {
        const eth = asset({ priceStatus: 'unknown' });
        expect(assetUsdValue(eth)).toBeNull();
        expect(formatUsd(assetUsdValue(eth))).toBe(UNKNOWN_USD);
    });

    it('CONTROL: a genuinely empty balance at a known price is a real $0.00', () => {
        expect(formatUsd(assetUsdValue(asset({ balance: '0', price: 3000, priceStatus: 'market', priceAsOf: NOW })))).toBe('$0.00');
    });

    it('a held asset with no price makes the total "—" rather than understating it', () => {
        const total = portfolioTotal([
            asset({ price: 3000, priceStatus: 'market', priceAsOf: NOW }),
            asset({ symbol: 'SOL', balance: '1', priceStatus: 'unknown' }),
        ], NOW);
        expect(total.value).toBeNull();
        // An unheld unknown asset does not blank the total.
        expect(portfolioTotal([
            asset({ price: 3000, priceStatus: 'market', priceAsOf: NOW }),
            asset({ symbol: 'SOL', balance: '0', priceStatus: 'unknown' }),
        ], NOW).value).toBe(6000);
    });

    it('a last-known price shows its age once stale, and not while fresh', () => {
        const fresh = asset({ price: 3000, priceStatus: 'market', priceAsOf: NOW - 1000 });
        const stale = asset({ price: 3000, priceStatus: 'market', priceAsOf: NOW - 3 * 60 * 60 * 1000 });
        expect(priceAgeLabel(fresh, t, NOW)).toBe('');
        expect(priceAgeLabel(stale, t, NOW)).toContain('prices.asOf');
        expect(portfolioTotal([stale], NOW)).toEqual({ value: 6000, staleSince: NOW - 3 * 60 * 60 * 1000 });
        expect(portfolioTotal([fresh], NOW).staleSince).toBeNull();
        expect(STALE_PRICE_AFTER_MS).toBe(5 * 60 * 1000);
    });

    it('commas in a balance are parsed, not truncated', () => {
        expect(assetUsdValue(asset({ balance: '1,234.5', price: 1, priceStatus: 'peg' }))).toBe(1234.5);
    });
});

describe('priceAssets (BalanceService stamping)', () => {
    it('stamps market prices with their age, pegs stablecoins, and never invents a floating price', () => {
        const assets = [
            asset({}),
            asset({ symbol: 'USDC', isStablecoin: true }),
            asset({ symbol: 'SOL', chain: 'Solana' }),
            asset({ symbol: 'PVT', isPVT: true }),
        ];
        priceAssets(assets, { ETH: { symbol: 'ETH', usd: 3100, usd_24h_change: null, as_of: NOW - 60_000 } });
        expect(assets[0]).toMatchObject({ price: 3100, priceStatus: 'market', priceAsOf: NOW - 60_000 });
        expect(assets[1]).toMatchObject({ price: 1, priceStatus: 'peg' });
        expect(assets[2]).toMatchObject({ price: 0, priceStatus: 'unknown' });
        expect(assets[3].priceStatus).toBeUndefined();
    });

    it('a preserved prior snapshot keeps its market price and age when the feed has nothing', () => {
        const prior = asset({ price: 2900, priceStatus: 'market', priceAsOf: NOW - 7_200_000 });
        priceAssets([prior], {});
        expect(prior).toMatchObject({ price: 2900, priceStatus: 'market', priceAsOf: NOW - 7_200_000 });
    });

    it('RED: a pre- placeholder price with no status is not trusted', () => {
        const legacy = asset({ price: 3200 });
        priceAssets([legacy], {});
        expect(legacy).toMatchObject({ price: 0, priceStatus: 'unknown' });
    });
});
