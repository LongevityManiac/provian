/**
 * SOL/USD from Pyth's on-chain PriceUpdateV2 account (Anchor layout), read through our own RPC.
 *
 *   [0..8)   discriminator
 *   [8..40)  write_authority
 *   [40]     verification_level tag: 0 = Partial { num_signatures: u8 } (2 bytes), 1 = Full (1 byte)
 *   then     price_message: feed_id [32], price i64, conf u64, exponent i32, publish_time i64, …
 *
 * Refused (never priced): wrong owner, wrong feed, a Partial verification, a non-positive price,
 * a stale or future publish time.
 */
import { PYTH_RECEIVER_PROGRAM, PYTH_SOL_USD_FEED_ID } from '../constants.js';

export interface SolPrice {
  readonly price: bigint;
  readonly conf: bigint;
  readonly expo: number;
  readonly publishTime: number;
}

export class PriceError extends Error {}

export function parsePythPriceUpdate(owner: string, data: Uint8Array, nowSec: number, maxAgeSeconds: number): SolPrice {
  if (owner !== PYTH_RECEIVER_PROGRAM) throw new PriceError('price account owner is not the Pyth receiver');
  if (data.length < 40 + 1 + 32 + 8 + 8 + 4 + 8) throw new PriceError('price account too short');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let off = 40;
  const level = data[off];
  if (level !== 1) throw new PriceError('price update is not fully verified');
  off += 1;
  const feed = Buffer.from(data.subarray(off, off + 32)).toString('hex');
  if (feed !== PYTH_SOL_USD_FEED_ID) throw new PriceError('price account is not the SOL/USD feed');
  off += 32;
  const price = view.getBigInt64(off, true);
  off += 8;
  const conf = view.getBigUint64(off, true);
  off += 8;
  const expo = view.getInt32(off, true);
  off += 4;
  const publishTime = Number(view.getBigInt64(off, true));
  if (price <= 0n) throw new PriceError('non-positive price');
  if (expo < -18 || expo > 0) throw new PriceError('unexpected exponent');
  if (nowSec - publishTime > maxAgeSeconds) throw new PriceError('SOL/USD price is stale');
  if (publishTime > nowSec + 60) throw new PriceError('SOL/USD price is from the future');
  return { price, conf, expo, publishTime };
}
