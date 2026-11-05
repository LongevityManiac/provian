import {
  createPriceFeed,
  mergePrices,
  parseAlchemy,
  parseCoingecko,
  PRICE_FEED_TTL_MS,
  type FeedPrice,
  type PriceFeedDeps,
  type PriceFeedSnapshot,
} from './price-feed';

const T0 = 1_790_000_000_000;

function cg(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function harness(over: Partial<PriceFeedDeps> = {}) {
  let now = T0;
  let durable: PriceFeedSnapshot | null = null;
  const fetch = jest.fn(async (_url: string) => cg({ ethereum: { usd: 3000, usd_24h_change: 1.5 } }));
  const deps: PriceFeedDeps = {
    fetch,
    now: () => now,
    alchemyApiKey: 'k',
    loadLastKnown: async () => durable,
    saveLastKnown: async (s) => { durable = JSON.parse(JSON.stringify(s)); },
    ...over,
  };
  return {
    deps,
    fetch: (over.fetch as jest.Mock | undefined) ?? fetch,
    advance: (ms: number) => { now += ms; },
    getDurable: () => durable,
    setDurable: (s: PriceFeedSnapshot | null) => { durable = s; },
  };
}

describe('price feed parsing', () => {
  it('keeps only positive finite prices for known ids (RED: zero, NaN, string and unknown ids dropped)', () => {
    const parsed = parseCoingecko({
      ethereum: { usd: 3000, usd_24h_change: -2 },
      solana: { usd: 0 },
      tether: { usd: 'NaN' },
      dai: { usd: Number.NaN },
      notacoin: { usd: 5 },
    }, T0);
    expect(Object.keys(parsed)).toEqual(['ETH']);
    expect(parsed.ETH).toEqual({ usd: 3000, usd_24h_change: -2, as_of_ms: T0, source: 'coingecko' });
  });

  it('parses Alchemy by-symbol rows, skipping errors and zero values', () => {
    const parsed = parseAlchemy({ data: [
      { symbol: 'ETH', prices: [{ currency: 'usd', value: '2999.5', lastUpdatedAt: new Date(T0 - 1000).toISOString() }] },
      { symbol: 'SOL', prices: [{ currency: 'usd', value: '0' }] },
      { symbol: 'USDC', error: 'not found', prices: [] },
      { symbol: 'PVT', prices: [{ currency: 'usd', value: '9' }] },
    ] }, T0);
    expect(parsed).toEqual({ ETH: { usd: 2999.5, usd_24h_change: null, as_of_ms: T0 - 1000, source: 'alchemy' } });
  });

  it('merge keeps a symbol the fresh answer did not carry, with its own age', () => {
    const old: Record<string, FeedPrice> = {
      ETH: { usd: 1, usd_24h_change: null, as_of_ms: T0 - 10, source: 'coingecko' },
      SOL: { usd: 2, usd_24h_change: null, as_of_ms: T0 - 10, source: 'coingecko' },
    };
    const merged = mergePrices(old, { ETH: { usd: 3, usd_24h_change: 1, as_of_ms: T0, source: 'coingecko' } });
    expect(merged.ETH.usd).toBe(3);
    expect(merged.SOL).toEqual(old.SOL);
  });
});

describe('createPriceFeed', () => {
  it('serves from cache inside the TTL (one upstream call per minute regardless of readers)', async () => {
    const h = harness();
    const feed = createPriceFeed(h.deps);
    await Promise.all([feed.read(), feed.read(), feed.read()]);
    await feed.read();
    // CoinGecko once + Alchemy once for the symbols CoinGecko did not answer.
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.advance(PRICE_FEED_TTL_MS);
    await feed.read();
    expect(h.fetch).toHaveBeenCalledTimes(4);
  });

  it('RED: when every upstream fails, it serves the last known prices with their age — never empty, never zero', async () => {
    const h = harness();
    const feed = createPriceFeed(h.deps);
    const first = await feed.read();
    expect(first.prices.ETH.usd).toBe(3000);
    expect(first.upstream_down).toBe(false);

    (h.deps.fetch as jest.Mock).mockImplementation(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    h.advance(3 * 60 * 60 * 1000);
    const down = await feed.read();
    expect(down.upstream_down).toBe(true);
    expect(down.prices.ETH).toEqual(first.prices.ETH);
    expect(down.served_at_ms - down.prices.ETH.as_of_ms).toBe(3 * 60 * 60 * 1000);
  });

  it('a cold relay instance with both upstreams down serves the durable last-known copy', async () => {
    const h = harness({ fetch: jest.fn(async () => { throw new Error('ECONNRESET'); }) });
    h.setDurable({ prices: { SOL: { usd: 150, usd_24h_change: 0.5, as_of_ms: T0 - 5000, source: 'coingecko' } }, refreshed_at_ms: T0 - 5000 });
    const out = await createPriceFeed(h.deps).read();
    expect(out.upstream_down).toBe(true);
    expect(out.prices.SOL.usd).toBe(150);
  });

  it('a never-priced symbol is absent (so the app shows "—"), and nothing is saved from an empty answer', async () => {
    const h = harness({ fetch: jest.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })) });
    const out = await createPriceFeed(h.deps).read();
    expect(out.prices).toEqual({});
    expect(h.getDurable()).toBeNull();
  });

  it('fills symbols CoinGecko missed from Alchemy, and persists the merged snapshot', async () => {
    const fetch = jest.fn(async (url: string) => (url.includes('coingecko')
      ? cg({ ethereum: { usd: 3000 } })
      : cg({ data: [{ symbol: 'SOL', prices: [{ currency: 'usd', value: '151' }] }] })));
    const h = harness({ fetch });
    const out = await createPriceFeed(h.deps).read();
    expect(out.prices.ETH.source).toBe('coingecko');
    expect(out.prices.SOL).toMatchObject({ usd: 151, source: 'alchemy' });
    expect(fetch.mock.calls[1][0]).not.toContain('symbols=ETH');
    expect(h.getDurable()?.prices.SOL.usd).toBe(151);
  });
});
