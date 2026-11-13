/** Binding signatures must fit both the canonical contract clock and the local five-minute window. */
export function bindingChallengeExpiry(blockTimestamp: number, nowMs: number): number {
  if (!Number.isSafeInteger(blockTimestamp) || blockTimestamp < 0 || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw Error('recourse_binding_clock_invalid');
  }
  const blockMs = blockTimestamp * 1000, blockCeiling = (blockTimestamp + 300) * 1000, wallCeiling = nowMs + 300_000;
  if (![blockMs, blockCeiling, wallCeiling].every(Number.isSafeInteger)) throw Error('recourse_binding_clock_invalid');
  const expiresAtMs = Math.min(blockCeiling, wallCeiling);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs || expiresAtMs <= blockMs) throw Error('recourse_binding_clock_stale');
  return expiresAtMs;
}
