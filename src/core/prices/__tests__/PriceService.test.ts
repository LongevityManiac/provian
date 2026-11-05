import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * item 5: prices come from the relay (never a direct CoinGecko call), and a
 * failed refresh keeps every last-known price with its age — never erases it.
 */

const proxyFetch = vi.fn();
vi.mock('../../../services/ProxyConfig', () => ({ default: { proxyFetch } }));

const storage = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => storage.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { storage.set(k, v); }),
    },
}));

import PriceService, { mergeTokenPrices, parseRelayPrices, restorePriceCache } from '../PriceService';

const NOW = 1_790_000_000_000;

function relayAnswer(prices: Record<string, unknown>) {
    return { ok: true, status: 200, json: async () => ({ prices, refreshed_at_ms: NOW, upstream_down: false }) };
}

describe('PriceService (relay feed, last-known prices)', () => {
    beforeEach(() => {
        proxyFetch.mockReset();
        storage.clear();
        PriceService.resetForTests();
        vi.spyOn(Date, 'now').mockReturnValue(NOW);
    });

    it('reads prices through the relay proxy, never a direct price-source URL', async () => {
        const directFetch = vi.fn();
        vi.stubGlobal('fetch', directFetch);
        proxyFetch.mockResolvedValue(relayAnswer({
            ETH: { usd: 3000, usd_24h_change: 1.5, as_of_ms: NOW - 1000 },
            WETH: { usd: 2995, usd_24h_change: null, as_of_ms: NOW - 1000 },
        }));
        await PriceService.refreshPrices();
        expect(proxyFetch).toHaveBeenCalledWith('prices', '', { method: 'GET' });
        expect(directFetch).not.toHaveBeenCalled();
        const prices = await PriceService.getPrices(['ETH', 'weth', 'PVT']);
        expect(prices.ETH).toEqual({ symbol: 'ETH', usd: 3000, usd_24h_change: 1.5, as_of: NOW - 1000 });
        expect(prices.WETH.usd).toBe(2995);
        expect(prices.PVT).toBeUndefined();
        vi.unstubAllGlobals();
    });

    it('RED: a failed refresh keeps the last known price and its age (no $0, no erasure)', async () => {
        proxyFetch.mockResolvedValueOnce(relayAnswer({ ETH: { usd: 3000, as_of_ms: NOW - 1000 } }));
        await PriceService.refreshPrices();
        expect(PriceService.isSourceDown()).toBe(false);

        proxyFetch.mockRejectedValueOnce(new Error('offline'));
        await PriceService.refreshPrices();
        expect(PriceService.isSourceDown()).toBe(true);
        const eth = await PriceService.getPrice('ETH');
        expect(eth).toMatchObject({ usd: 3000, as_of: NOW - 1000 });
        expect(await PriceService.getUsdValue('ETH', 2)).toBe(6000);
    });

    it('a never-priced symbol reports null (the UI renders "—"), not 0', async () => {
        proxyFetch.mockRejectedValue(new Error('offline'));
        expect(await PriceService.getPrice('SOL')).toBeNull();
        expect(await PriceService.getUsdValue('SOL', 5)).toBeNull();
    });

    it('persists last-known prices so a cold start with the relay down still has them', async () => {
        proxyFetch.mockResolvedValueOnce(relayAnswer({ SOL: { usd: 150, as_of_ms: NOW - 5 } }));
        await PriceService.refreshPrices();
        const saved = restorePriceCache(JSON.parse(storage.get('price_cache')!));
        expect(saved?.prices.SOL.usd).toBe(150);
    });
});

describe('price parsing and merge', () => {
    it('drops zero / non-finite prices (RED: a 0 from the feed never becomes a price)', () => {
        const parsed = parseRelayPrices({ prices: { ETH: { usd: 0 }, SOL: { usd: Number.NaN }, DAI: { usd: 1, as_of_ms: NOW } } }, NOW);
        expect(Object.keys(parsed)).toEqual(['DAI']);
    });

    it('merge keeps symbols the fresh answer omitted', () => {
        const merged = mergeTokenPrices(
            { SOL: { symbol: 'SOL', usd: 150, usd_24h_change: null, as_of: NOW - 10 } },
            { ETH: { symbol: 'ETH', usd: 3000, usd_24h_change: null, as_of: NOW } },
        );
        expect(Object.keys(merged).sort()).toEqual(['ETH', 'SOL']);
    });

    it('restores the pre- cache shape (last_updated → as_of)', () => {
        const restored = restorePriceCache({ prices: { ETH: { symbol: 'ETH', usd: 2900, usd_24h_change: 0, last_updated: NOW - 60_000 } }, timestamp: NOW - 60_000 });
        expect(restored?.prices.ETH.as_of).toBe(NOW - 60_000);
    });
});
