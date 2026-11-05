import { describe, expect, it } from 'vitest';
import { ceilDiv, usdcAtomicFromLamports, usdcAtomicFromWei, withMargin } from './fee-math.js';
import { parsePythPriceUpdate, PriceError } from './solana/price.js';
import { readQuote, signQuote } from './solana/quote.js';
import { PYTH_RECEIVER_PROGRAM, PYTH_SOL_USD_FEED_ID, SOLANA_NETWORK } from './constants.js';

describe('fee arithmetic rounds UP (the fee never under-covers its gas)', () => {
  it('wei → USDC at Chainlink 8dp', () => {
    // 1e12 wei = 1e-6 ETH; at $2,700 = $0.0027 = 2,700 atomic exactly.
    expect(usdcAtomicFromWei(10n ** 12n, 2_700_00000000n, 8)).toBe(2_700n);
    // one more wei must round up to 2,701 (RED control for floor division)
    expect(usdcAtomicFromWei(10n ** 12n + 1n, 2_700_00000000n, 8)).toBe(2_701n);
  });
  it('lamports → USDC at Pyth expo −8', () => {
    // 10,000 lamports at $120 = $0.0012 = 1,200 atomic exactly; +1 lamport rounds up.
    expect(usdcAtomicFromLamports(10_000n, 120_00000000n, -8)).toBe(1_200n);
    expect(usdcAtomicFromLamports(10_001n, 120_00000000n, -8)).toBe(1_201n);
  });
  it('margin is exactly $0.0003 and never a free tier', () => {
    expect(withMargin(0n)).toBe(300n);
    expect(ceilDiv(0n, 7n)).toBe(0n);
  });
});

function pythAccount(opts: { level?: number; feed?: string; price?: bigint; expo?: number; publish?: number } = {}): Uint8Array {
  const buf = new Uint8Array(134);
  const view = new DataView(buf.buffer);
  let off = 40;
  buf[off] = opts.level ?? 1;
  off += 1;
  buf.set(Buffer.from(opts.feed ?? PYTH_SOL_USD_FEED_ID, 'hex'), off);
  off += 32;
  view.setBigInt64(off, opts.price ?? 121_00000000n, true);
  off += 8;
  view.setBigUint64(off, 1_000_000n, true);
  off += 8;
  view.setInt32(off, opts.expo ?? -8, true);
  off += 4;
  view.setBigInt64(off, BigInt(opts.publish ?? 1_000_000), true);
  return buf;
}

describe('Pyth on-chain SOL/USD', () => {
  it('parses a fresh, fully verified update', () => {
    expect(parsePythPriceUpdate(PYTH_RECEIVER_PROGRAM, pythAccount(), 1_000_010, 120)).toMatchObject({ price: 121_00000000n, expo: -8, publishTime: 1_000_000 });
  });
  it('RED: wrong owner, wrong feed, partial verification, stale, future, non-positive are all refused', () => {
    const now = 1_000_010;
    expect(() => parsePythPriceUpdate('11111111111111111111111111111111', pythAccount(), now, 120)).toThrow(PriceError);
    expect(() => parsePythPriceUpdate(PYTH_RECEIVER_PROGRAM, pythAccount({ feed: 'ab'.repeat(32) }), now, 120)).toThrow(/SOL\/USD feed/);
    expect(() => parsePythPriceUpdate(PYTH_RECEIVER_PROGRAM, pythAccount({ level: 0 }), now, 120)).toThrow(/verified/);
    expect(() => parsePythPriceUpdate(PYTH_RECEIVER_PROGRAM, pythAccount({ publish: now - 121 }), now, 120)).toThrow(/stale/);
    expect(() => parsePythPriceUpdate(PYTH_RECEIVER_PROGRAM, pythAccount({ publish: now + 61 }), now, 120)).toThrow(/future/);
    expect(() => parsePythPriceUpdate(PYTH_RECEIVER_PROGRAM, pythAccount({ price: 0n }), now, 120)).toThrow(/non-positive/);
  });
});

describe('Solana fee quote tokens', () => {
  const now = 1_800_000_000_000;
  it('round-trips within the TTL', () => {
    const t = signQuote('s3cret-s3cret-s3cret', SOLANA_NETWORK, { price: 99n, expo: -8, issuedAtMs: now });
    expect(readQuote('s3cret-s3cret-s3cret', SOLANA_NETWORK, t, now + 60_000)).toEqual({ price: 99n, expo: -8, issuedAtMs: now });
  });
  it('RED: expired, forged, re-pointed or mangled tokens are ignored', () => {
    const t = signQuote('s3cret-s3cret-s3cret', SOLANA_NETWORK, { price: 99n, expo: -8, issuedAtMs: now });
    expect(readQuote('s3cret-s3cret-s3cret', SOLANA_NETWORK, t, now + 5 * 60_000 + 1)).toBeNull();
    expect(readQuote('other-secret-xxxxxxx', SOLANA_NETWORK, t, now)).toBeNull();
    expect(readQuote('s3cret-s3cret-s3cret', 'solana:devnet', t, now)).toBeNull();
    const [body, mac] = t.split('.') as [string, string];
    const altered = Buffer.from(Buffer.from(body, 'base64url').toString('utf8').replace('"99"', '"1"')).toString('base64url');
    expect(readQuote('s3cret-s3cret-s3cret', SOLANA_NETWORK, `${altered}.${mac}`, now)).toBeNull();
    expect(readQuote(null, SOLANA_NETWORK, t, now)).toBeNull();
  });
});
