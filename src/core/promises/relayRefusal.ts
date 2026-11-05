/**
 * A 4xx other than not-found / timeout / rate-limit: the relay REFUSED this write, so re-sending
 * the same bytes can never succeed. Until 2026-10-17 every failed promise write was treated as
 * "offline" and queued for retry on every sync, forever.
 */
export function isDefinitiveRelayRefusal(httpStatus: number | undefined): boolean {
  return httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && ![404, 408, 425, 429].includes(httpStatus);
}
