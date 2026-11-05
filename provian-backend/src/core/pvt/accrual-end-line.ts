/**
 * Accrual end line (shutdown coverage,).
 *
 * Provian may discontinue minting. The Terms of Service (Section 24.3) promise that it then
 * announces a shutdown date and runs ONE final settlement of the PVT earned before that date;
 * anything unsettled after it is void. That needs a way to say "nothing new accrues from instant
 * D" this module is it. It is the END twin of `PVT9_ELIGIBILITY_CUT_LINE_MS` (the start line).
 *
 * - `PVT_ACCRUAL_END_MS` unset or empty (the shipped state) → no end line; every path behaves
 * byte-for-byte as before.
 * - Set to a positive integer (Unix ms) → an act the relay receives at or after that instant
 * seals `record_only` (`service_accrual_ended`): it is still recorded and counted, it takes no
 * mint-once slot and creates no pending claim. A corroboration observed at or after it lifts
 * nothing, so no new top-up is created either.
 * - Set to anything else → Unknown = Block: treated as an end line at 0, so nothing new accrues.
 * A typo stops minting rather than letting it continue past an intended shutdown.
 *
 * Genesis: from D Genesis admission refuses every qualifying act (no new reservation), exactly as
 * an admission close at D would; a reservation made before D stays payable, so its own sealing,
 * which may run after D, is exempt (`isGenesisReservationSeal`). Claims already registered and
 * acts already sealed are untouched.
 *
 * The time compared is the relay's own clock when it received the act (`accrualReceiptMs`), never
 * the act's self-reported timestamp: a device may legitimately send an act up to 30 days after it
 * happened, so an act timestamp before D says nothing about whether the relay had it before D.
 */

export const ACCRUAL_END_ENV = 'PVT_ACCRUAL_END_MS';
export const ACCRUAL_ENDED_REASON = 'service_accrual_ended';

/** The configured end instant (Unix ms), `null` when none is configured. Malformed → 0. */
export function accrualEndMs(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[ACCRUAL_END_ENV];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^[1-9][0-9]{0,15}$/.test(trimmed)) return 0;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : 0;
}

/** True when an act received (or a corroboration observed) at `atMs` falls at or after the end line. */
export function accrualEndedAt(atMs: number, endMs: number | null = accrualEndMs()): boolean {
  if (endMs === null) return false;
  // A non-finite instant cannot be placed before the line: Unknown = Block.
  if (!Number.isFinite(atMs)) return true;
  return atMs >= endMs;
}

/**
 * The instant the end line judges an accrual by: when the relay first durably received the act.
 * A live sealing is judged by the clock now. A replay (a relay act whose pricing died after its
 * intake committed, or a staged ordinary intake) is judged by the instant that intake committed,
 * so an act the relay recorded before the shutdown date still settles even when its replay runs
 * after it. `receivedAtMs` is set only by relay code from its own committed row, never from a
 * request body.
 */
export function accrualReceiptMs(receivedAtMs: number | undefined, nowMs: number): number {
  return receivedAtMs === undefined ? nowMs : receivedAtMs;
}

/**
 * True for the sealing of an existing Genesis reservation: the Genesis state machine's marker AND
 * the reservation-bound economic snapshot it carries. Only these are exempt from the end line. A
 * reservation can exist only for a qualifying act before the end line, because Genesis admission
 * refuses every act at or after it (`shouldPersistGenesisQualification`); the reservation's own
 * sealing may still run after the line and must, since the Terms keep it payable.
 */
export function isGenesisReservationSeal(accrual: {
  readonly isGenesisGrant?: unknown;
  readonly economicSnapshot?: unknown;
}): boolean {
  if (accrual.isGenesisGrant !== true) return false;
  const snapshot = accrual.economicSnapshot;
  if (typeof snapshot !== 'object' || snapshot === null) return false;
  const factors = (snapshot as { readonly recordTimeFactors?: unknown }).recordTimeFactors;
  if (typeof factors !== 'object' || factors === null) return false;
  return (factors as { readonly fixedGrantSource?: unknown }).fixedGrantSource
    === 'genesis_campaign_reservation';
}

/**
 * The central accrual's end-line decision (`recordPEAccrual`), pure so every arm is testable: true
 * when this accrual must seal record_only because the relay received the act at or after the end
 * line. Judged by the caller's committed receipt (`accrualReceivedAtMs`); else, for a staged
 * ordinary-intake replay (no meter context, a durable replay source claimed), the timestamp the
 * intake row binds, which the accrual's verifier checks against the committed row before anything
 * can mint; else the clock now. The sealing of an existing Genesis reservation is exempt.
 */
export function accrualEndedFor(
  params: {
    readonly isGenesisGrant?: unknown;
    readonly economicSnapshot?: unknown;
    readonly accrualReceivedAtMs?: number;
    readonly meter?: unknown;
    readonly durableReplaySource?: unknown;
    readonly timestamp: number;
  },
  nowMs: number,
  endMs: number | null = accrualEndMs(),
): boolean {
  if (isGenesisReservationSeal(params)) return false;
  const receivedAtMs = params.accrualReceivedAtMs
    ?? (params.meter === undefined && params.durableReplaySource !== undefined
      ? params.timestamp
      : undefined);
  return accrualEndedAt(accrualReceiptMs(receivedAtMs, nowMs), endMs);
}
