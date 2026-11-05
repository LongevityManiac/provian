import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * USD prices for wallet assets (item 5).
 *
 * The phone never calls a price source directly any more. CoinGecko's CDN blocks
 * by client IP (a CloudFront 403 was observed from an ordinary home connection),
 * and the old direct call left a blocked phone with no price at all. The relay
 * (`GET /api/proxy/prices`, provian-backend core/prices/price-feed.ts) fetches
 * server-side and keeps a durable per-symbol last-known copy.
 *
 * On the phone, every symbol keeps its LAST KNOWN price with the time it was
 * observed (`as_of`), merged per symbol and persisted, so a failed refresh never
 * erases a price: the UI shows that price with its age. A symbol that has never
 * been priced is absent — callers render " ", never $0.00.
 */

export interface TokenPrice {
    symbol: string;
    usd: number;
    /** 24h change in percent, or null when the source carried none. */
    usd_24h_change: number | null;
    /** When this price was observed at its source (ms). */
    as_of: number;
}

export interface PriceCache {
    prices: Record<string, TokenPrice>;
    /** When the phone last completed a successful refresh (ms; 0 = never). */
    timestamp: number;
}

const STORAGE_KEY = 'price_cache';
const CACHE_DURATION = 60 * 1000; // 60 seconds

/** Symbols the relay feed prices. PVT has no market and is deliberately absent. */
const FEED_SYMBOLS: readonly string[] = [
    'ETH', 'WETH', 'SOL', 'USDC', 'USDT', 'DAI', 'ARB', 'OP', 'BONK', 'JUP', 'WIF', 'PYUSD',
];

function isPositiveFinite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Parse the relay's `{ prices: { SYM: { usd, usd_24h_change, as_of_ms } } }` answer. */
export function parseRelayPrices(body: unknown, now: number): Record<string, TokenPrice> {
    const out: Record<string, TokenPrice> = {};
    if (!body || typeof body !== 'object') return out;
    const prices = (body as { prices?: unknown }).prices;
    if (!prices || typeof prices !== 'object') return out;
    for (const [rawSymbol, entry] of Object.entries(prices as Record<string, unknown>)) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        if (!isPositiveFinite(e.usd)) continue;
        const symbol = rawSymbol.toUpperCase();
        const asOf = isPositiveFinite(e.as_of_ms) ? Math.min(e.as_of_ms, now) : now;
        const change = typeof e.usd_24h_change === 'number' && Number.isFinite(e.usd_24h_change) ? e.usd_24h_change : null;
        out[symbol] = { symbol, usd: e.usd, usd_24h_change: change, as_of: asOf };
    }
    return out;
}

/** Per-symbol merge: newer observations replace older; anything not re-priced keeps its last-known entry. */
export function mergeTokenPrices(
    lastKnown: Record<string, TokenPrice>,
    fresh: Record<string, TokenPrice>,
): Record<string, TokenPrice> {
    const merged: Record<string, TokenPrice> = { ...lastKnown };
    for (const [symbol, price] of Object.entries(fresh)) {
        const prior = merged[symbol];
        if (!prior || price.as_of >= prior.as_of) merged[symbol] = price;
    }
    return merged;
}

/** Read a persisted cache, including the pre- shape (`last_updated`, no `as_of`). */
export function restorePriceCache(raw: unknown): PriceCache | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as { prices?: unknown; timestamp?: unknown };
    if (!r.prices || typeof r.prices !== 'object') return null;
    const prices: Record<string, TokenPrice> = {};
    for (const [symbol, entry] of Object.entries(r.prices as Record<string, unknown>)) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        if (!isPositiveFinite(e.usd)) continue;
        const asOf = isPositiveFinite(e.as_of) ? e.as_of : isPositiveFinite(e.last_updated) ? e.last_updated : null;
        if (asOf === null) continue;
        const change = typeof e.usd_24h_change === 'number' && Number.isFinite(e.usd_24h_change) ? e.usd_24h_change : null;
        prices[symbol.toUpperCase()] = { symbol: symbol.toUpperCase(), usd: e.usd, usd_24h_change: change, as_of: asOf };
    }
    return { prices, timestamp: isPositiveFinite(r.timestamp) ? r.timestamp : 0 };
}

async function fetchFromRelay(): Promise<unknown> {
    // Lazy import keeps the relay/auth graph off this module's static import path.
    const { default: ProxyConfig } = await import('../../services/ProxyConfig');
    const response = await ProxyConfig.proxyFetch('prices', '', { method: 'GET' });
    if (!response.ok) {
        throw new Error(`price feed HTTP ${response.status}`);
    }
    return response.json();
}

class PriceService {
    private static instance: PriceService;
    private cache: PriceCache | null = null;
    private lastAttemptAt = 0;
    private lastAttemptFailed = false;
    private fetchPromise: Promise<void> | null = null;
    private refreshInterval: ReturnType<typeof setInterval> | null = null;
    private ready: Promise<void>;

    private constructor() {
        this.ready = this.loadCachedPrices();
    }

    static getInstance(): PriceService {
        if (!PriceService.instance) {
            PriceService.instance = new PriceService();
        }
        return PriceService.instance;
    }

    async startAutoRefresh(): Promise<void> {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
        }
        await this.refreshPrices();
        this.refreshInterval = setInterval(() => {
            this.refreshPrices();
        }, CACHE_DURATION);
    }

    stopAutoRefresh(): void {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
    }

    /** The last known price for a symbol (possibly old — check `as_of`), or null if never priced. */
    async getPrice(symbol: string): Promise<TokenPrice | null> {
        await this.ensureFresh();
        return this.cache?.prices[symbol.toUpperCase()] ?? null;
    }

    async getPrices(symbols: string[]): Promise<Record<string, TokenPrice>> {
        await this.ensureFresh();
        const result: Record<string, TokenPrice> = {};
        for (const symbol of symbols) {
            const upper = symbol.toUpperCase();
            const price = this.cache?.prices[upper];
            if (price) result[upper] = price;
        }
        return result;
    }

    /** USD value at the last known price, or null when the symbol has never been priced. */
    async getUsdValue(symbol: string, amount: number): Promise<number | null> {
        const price = await this.getPrice(symbol);
        return price ? amount * price.usd : null;
    }

    async get24hChange(symbol: string): Promise<number | null> {
        const price = await this.getPrice(symbol);
        return price?.usd_24h_change ?? null;
    }

    /** True when the most recent refresh attempt failed (prices shown are last-known). */
    isSourceDown(): boolean {
        return this.lastAttemptFailed;
    }

    async refreshPrices(): Promise<void> {
        if (this.fetchPromise) {
            return this.fetchPromise;
        }
        this.fetchPromise = this.fetchPrices();
        try {
            await this.fetchPromise;
        } finally {
            this.fetchPromise = null;
        }
    }

    private async ensureFresh(): Promise<void> {
        await this.ready;
        if (Date.now() - this.lastAttemptAt > CACHE_DURATION) {
            await this.refreshPrices();
        }
    }

    private async fetchPrices(): Promise<void> {
        await this.ready;
        const now = Date.now();
        this.lastAttemptAt = now;
        try {
            const fresh = parseRelayPrices(await fetchFromRelay(), now);
            if (Object.keys(fresh).length === 0) {
                throw new Error('price feed returned no prices');
            }
            this.cache = {
                prices: mergeTokenPrices(this.cache?.prices ?? {}, fresh),
                timestamp: now,
            };
            this.lastAttemptFailed = false;
            await this.saveCachedPrices();
        } catch (error) {
            // Keep every last-known price; the UI shows it with its age.
            this.lastAttemptFailed = true;
            console.warn('[PriceService] Price refresh failed; keeping last known prices:', error);
        }
    }

    private async loadCachedPrices(): Promise<void> {
        try {
            const cached = await AsyncStorage.getItem(STORAGE_KEY);
            if (cached) {
                const restored = restorePriceCache(JSON.parse(cached));
                if (restored) {
                    this.cache = this.cache
                        ? { prices: mergeTokenPrices(restored.prices, this.cache.prices), timestamp: this.cache.timestamp }
                        : restored;
                }
            }
        } catch (error) {
            console.warn('[PriceService] Failed to load cached prices:', error);
        }
    }

    private async saveCachedPrices(): Promise<void> {
        try {
            if (this.cache) {
                await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.cache));
            }
        } catch (error) {
            console.warn('[PriceService] Failed to save cached prices:', error);
        }
    }

    formatPriceChange(change: number): { text: string; isPositive: boolean } {
        const isPositive = change >= 0;
        const text = `${isPositive ? '+' : ''}${change.toFixed(2)}%`;
        return { text, isPositive };
    }

    getSupportedSymbols(): string[] {
        return [...FEED_SYMBOLS];
    }

    isSymbolSupported(symbol: string): boolean {
        return FEED_SYMBOLS.includes(symbol.toUpperCase());
    }

    /** Test-only: forget in-memory state so each test starts cold. */
    resetForTests(): void {
        this.cache = null;
        this.lastAttemptAt = 0;
        this.lastAttemptFailed = false;
        this.fetchPromise = null;
        this.ready = Promise.resolve();
    }
}

export default PriceService.getInstance();
