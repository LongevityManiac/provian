/**
 * The phone batch's admission (fix run 2026-10-24). The phone names its meter device in its OWN
 * wallet token, so that id is a label the caller chose: it may name a chain, but it never decides
 * whose budget a batch spends or whose chain it extends. The limiter keys on the authenticated
 * wallet; chain ownership is enforced by `ingestMeterBatch` (`ownerBoundChain`) and by the tip and
 * proofs reads in server.ts.
 */
import type { RedisCache } from '../../cache';

/** Batches one wallet may land per hour, across every device id it names. */
export const MOBILE_METER_BATCHES_PER_HOUR = 30;

/** A phone meter device id: the app's own label, never a namespaced id (`relay:<actor>`). */
export function isMobileMeterDeviceId(deviceId: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(deviceId);
}

export function mobileMeterRateLimitKey(userId: string): string {
  return `rl:meterbatch:wallet:${userId}`;
}

export type MobileMeterAdmission =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 400 | 429; readonly body: Record<string, unknown> };

export async function admitMobileMeterBatch(
  cache: Pick<RedisCache, 'checkRateLimit'>,
  userId: string,
  deviceId: string,
): Promise<MobileMeterAdmission> {
  if (!isMobileMeterDeviceId(deviceId)) {
    return { ok: false, status: 400, body: { error: 'batch_device_id_invalid' } };
  }
  const rate = await cache.checkRateLimit(mobileMeterRateLimitKey(userId), MOBILE_METER_BATCHES_PER_HOUR, 3600);
  if (!rate.allowed) {
    return { ok: false, status: 429, body: { error: 'Rate limit exceeded', retry_after: rate.retryAfter ?? 60 } };
  }
  return { ok: true };
}
