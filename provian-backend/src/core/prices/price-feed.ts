/**
 * The wallet's USD price feed, served by the relay (item 5).
 *
 * The app used to call api.coingecko.com directly from the phone. CoinGecko's
 * CDN blocks by client IP (a CloudFront 403 was observed from an ordinary home
 * connection), and the app had no last-known fallback beyond an in-memory copy,
 * so a blocked or offline phone rendered balances at $0.00 — or at a hardcoded
 * placeholder price.
 *
 * Now the relay fetches prices server-side (CoinGecko, with an optional demo
 * key, then Alchemy's Prices API for any symbol CoinGecko did not answer),
 * holds the result for 60 s, and keeps a durable last-known copy
 * (`price_feed/latest`) PER SYMBOL, each with its own `as_of_ms`. When both
 * upstreams fail, the relay answers with the last known prices and their ages
 * never an empty or zero price for a symbol it has ever priced. A symbol that
 * has never been priced is simply absent; the app renders " " for it.
 */

/** Wallet symbol → CoinGecko id. PVT has no market and is deliberately absent. */
export const PRICE_FEED_COINGECKO_IDS: Readonly<Record<string, string>> = Object.freeze({
  ETH: 'ethereum',
  WETH: 'weth',
  SOL: 'solana',
  USDC: 'usd-coin',
  USDT: 'tether',
  DAI: 'dai',
  ARB: 'arbitrum',
  OP: 'optimism',
  BONK: 'bonk',
  JUP: 'jupiter-exchange-solana',
  WIF: 'dogwifcoin',
  PYUSD: 'paypal-usd',
});

export const PRICE_FEED_SYMBOLS: readonly string[] = Object.freeze(Object.keys(PRICE_FEED_COINGECKO_IDS));

/** How long one upstream answer is served before the next refresh is attempted. */
export const PRICE_FEED_TTL_MS = 60_000;
/** One refresh never holds a request longer than this. */
export const PRICE_FEED_UPSTREAM_TIMEOUT_MS = 5_000;
export const PRICE_FEED_MAX_RESPONSE_BYTES = 256 * 1024;

export const PRICE_FEED_COLLECTION = 'price_feed';
export const PRICE_FEED_DOC = 'latest';

export type PriceSource = 'coingecko' | 'alchemy';

export interface FeedPrice {
  usd: number;
  /** Null when the source that priced it carries no 24 h change (Alchemy). */
  usd_24h_change: number | null;
  /** When this symbol's price was observed from its source. */
  as_of_ms: number;
  source: PriceSource;
}

export interface PriceFeedSnapshot {
  prices: Record<string, FeedPrice>;
  /** When the relay last completed a successful upstream refresh (0 = never). */
  refreshed_at_ms: number;
}

export interface PriceFeedResponse extends PriceFeedSnapshot {
  /** True when the last refresh attempt failed and these are last-known prices. */
  upstream_down: boolean;
  served_at_ms: number;
}

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean; status: number; json(): Promise<unknown>;
}>;

export interface PriceFeedDeps {
  fetch: FetchLike;
  now: () => number;
  coingeckoApiKey?: string;
  alchemyApiKey?: string;
  /** Durable last-known store. Failures here never fail a request. */
  loadLastKnown: () => Promise<PriceFeedSnapshot | null>;
  saveLastKnown: (snapshot: PriceFeedSnapshot) => Promise<void>;
  logWarn?: (label: string, detail: unknown) => void;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Parse CoinGecko `/simple/price` into feed prices. Unknown or non-positive entries are dropped. */
export function parseCoingecko(body: unknown, now: number): Record<string, FeedPrice> {
  const out: Record<string, FeedPrice> = {};
  if (!body || typeof body !== 'object') return out;
  const record = body as Record<string, unknown>;
  for (const [symbol, id] of Object.entries(PRICE_FEED_COINGECKO_IDS)) {
    if (!Object.prototype.hasOwnProperty.call(record, id)) continue;
    const entry = record[id];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (!isPositiveFinite(e.usd)) continue;
    const change = typeof e.usd_24h_change === 'number' && Number.isFinite(e.usd_24h_change) ? e.usd_24h_change : null;
    const updated = typeof e.last_updated_at === 'number' && e.last_updated_at > 0 ? e.last_updated_at * 1000 : now;
    out[symbol] = { usd: e.usd, usd_24h_change: change, as_of_ms: Math.min(updated, now), source: 'coingecko' };
  }
  return out;
}

/** Parse Alchemy `prices/v1/.../tokens/by-symbol` into feed prices. */
export function parseAlchemy(body: unknown, now: number): Record<string, FeedPrice> {
  const out: Record<string, FeedPrice> = {};
  if (!body || typeof body !== 'object') return out;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return out;
  for (const row of data) {
    if (!row || typeof row !== 'object') continue;
    const r = row as { symbol?: unknown; prices?: unknown; error?: unknown };
    if (typeof r.symbol !== 'string' || r.error) continue;
    const symbol = r.symbol.toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(PRICE_FEED_COINGECKO_IDS, symbol)) continue;
    if (!Array.isArray(r.prices)) continue;
    const usd = r.prices.find((p) => p && typeof p === 'object' && (p as { currency?: unknown }).currency === 'usd') as
      | { value?: unknown; lastUpdatedAt?: unknown } | undefined;
    if (!usd) continue;
    const value = typeof usd.value === 'string' ? Number(usd.value) : usd.value;
    if (!isPositiveFinite(value)) continue;
    const parsedAt = typeof usd.lastUpdatedAt === 'string' ? Date.parse(usd.lastUpdatedAt) : NaN;
    const asOf = Number.isFinite(parsedAt) && parsedAt > 0 ? Math.min(parsedAt, now) : now;
    out[symbol] = { usd: value, usd_24h_change: null, as_of_ms: asOf, source: 'alchemy' };
  }
  return out;
}

/**
 * Per-symbol merge: a fresh observation replaces an older one; a symbol the
 * fresh answer did not carry keeps its last-known price and its own age.
 */
export function mergePrices(
  lastKnown: Record<string, FeedPrice>,
  fresh: Record<string, FeedPrice>,
): Record<string, FeedPrice> {
  const merged: Record<string, FeedPrice> = { ...lastKnown };
  for (const [symbol, price] of Object.entries(fresh)) {
    const prior = merged[symbol];
    if (!prior || price.as_of_ms >= prior.as_of_ms) merged[symbol] = price;
  }
  return merged;
}

export function createPriceFeed(deps: PriceFeedDeps) {
  let snapshot: PriceFeedSnapshot | null = null;
  let loadedDurable = false;
  let lastAttemptMs = 0;
  let lastAttemptFailed = false;
  let inFlight: Promise<void> | null = null;
  const warn = deps.logWarn ?? (() => undefined);

  async function fetchCoingecko(now: number): Promise<Record<string, FeedPrice>> {
    const ids = Object.values(PRICE_FEED_COINGECKO_IDS).join(',');
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (deps.coingeckoApiKey) headers['x-cg-demo-api-key'] = deps.coingeckoApiKey;
    const res = await deps.fetch(url, { headers });
    if (!res.ok) throw new Error(`coingecko_http_${res.status}`);
    return parseCoingecko(await res.json(), now);
  }

  async function fetchAlchemy(symbols: string[], now: number): Promise<Record<string, FeedPrice>> {
    if (!deps.alchemyApiKey || symbols.length === 0) return {};
    const query = symbols.map((s) => `symbols=${encodeURIComponent(s)}`).join('&');
    const url = `https://api.g.alchemy.com/prices/v1/${deps.alchemyApiKey}/tokens/by-symbol?${query}`;
    const res = await deps.fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`alchemy_http_${res.status}`);
    return parseAlchemy(await res.json(), now);
  }

  async function ensureDurableLoaded(): Promise<void> {
    if (loadedDurable) return;
    loadedDurable = true;
    try {
      const durable = await deps.loadLastKnown();
      if (durable && durable.prices && typeof durable.prices === 'object') {
        snapshot = snapshot
          ? { prices: mergePrices(durable.prices, snapshot.prices), refreshed_at_ms: Math.max(snapshot.refreshed_at_ms, durable.refreshed_at_ms || 0) }
          : { prices: { ...durable.prices }, refreshed_at_ms: durable.refreshed_at_ms || 0 };
      }
    } catch (err) {
      warn('[price-feed] last-known load failed', err);
    }
  }

  async function refresh(): Promise<void> {
    const now = deps.now();
    lastAttemptMs = now;
    let fresh: Record<string, FeedPrice> = {};
    try {
      fresh = await fetchCoingecko(now);
    } catch (err) {
      warn('[price-feed] coingecko failed', err);
    }
    const missing = PRICE_FEED_SYMBOLS.filter((s) => !fresh[s]);
    if (missing.length > 0) {
      try {
        fresh = { ...fresh, ...(await fetchAlchemy(missing, now)) };
      } catch (err) {
        warn('[price-feed] alchemy failed', err);
      }
    }
    if (Object.keys(fresh).length === 0) {
      lastAttemptFailed = true;
      return;
    }
    lastAttemptFailed = false;
    snapshot = { prices: mergePrices(snapshot?.prices ?? {}, fresh), refreshed_at_ms: now };
    try {
      await deps.saveLastKnown(snapshot);
    } catch (err) {
      warn('[price-feed] last-known save failed', err);
    }
  }

  return {
    async read(): Promise<PriceFeedResponse> {
      await ensureDurableLoaded();
      const now = deps.now();
      if (now - lastAttemptMs >= PRICE_FEED_TTL_MS) {
        if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
        await inFlight;
      } else if (inFlight) {
        await inFlight;
      }
      return {
        prices: { ...(snapshot?.prices ?? {}) },
        refreshed_at_ms: snapshot?.refreshed_at_ms ?? 0,
        upstream_down: lastAttemptFailed,
        served_at_ms: deps.now(),
      };
    },
  };
}

export type PriceFeed = ReturnType<typeof createPriceFeed>;
