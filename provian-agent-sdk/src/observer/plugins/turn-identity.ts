/**
 * turn-identity — the canonical, cross-source-stable identity of ONE agent turn.
 *
 * Both tool-orchestration lanes (OTelPlugin's trace lane and TranscriptPlugin's
 * session-file lane) stamp `metadata.turn_id` from THIS function so the relay
 * can enforce mint-once for a tool turn the way it already does for a commit:
 * the relay folds `turn_id` into the device-witnessed canonical event, and the
 * existing `device_occurrence` mint-once (keyed `(economic actor, sha256(event))`)
 * then admits the FIRST arrival of a turn and records every later arrival as a
 * duplicate that mints 0. `agent_tool_orchestration` turns had no such anchor —
 * unlike commits they carry no `(user, commit_sha)` — so a turn seen twice could
 * mint twice. This closes that gap on ONE turn identity; it caps no volume,
 * gates no earning, and adds no rate mechanism.
 *
 * THE DESIGN PROBLEM. The two lanes observe the same turn through independent
 * mechanisms and share NO natural identifier: the OTel lane has a `trace_id`
 * (from the harness's tracer); the transcript lane has `(session_fingerprint,
 * turn_index)` (from the on-disk session file). A relay key on either alone
 * catches same-source replay but NOT the same turn arriving from BOTH sources.
 * The one primitive the two sources DO share for one real turn is the set of
 * tool-call correlation ids: a harness that both emits OTel and writes a
 * transcript records the SAME call id (`gen_ai.tool.call.id` in the span,
 * `tool_use.id` / `toolCallId` in the transcript) for each call. So:
 *
 *   - When the turn carries ≥1 tool-call id, `turn_id` is `tc:sha256(sorted ids)`
 *     — IDENTICAL across the two sources for one turn (cross-source mint-once),
 *     and DISTINCT across turns (call ids are unique), so distinct work is NEVER
 *     merged. This is the safety priority: never refuse a distinct turn.
 *   - When the turn carries NO usable call id, `turn_id` falls back to the
 *     source's OWN exact turn key (the caller passes `fallbackSelfKey`). That is
 *     enough for same-source replay dedup and can never collide with a different
 *     turn; cross-source collapse for such a turn is left to the on-device
 *     window registry (its normal job) — the relay simply records both, which is
 *     safe (over-recording, never over-refusing).
 *
 * The claim is per economic actor, so a device can only ever collide with its
 * OWN turns — there is no cross-actor grief vector.
 */

import { createHash } from 'crypto';

/** Upper bound on a stamped turn_id (the relay validates the same bound). */
export const TURN_ID_MAX_CHARS = 128;

/** Prefix on the cross-source, call-id-anchored form. */
export const TURN_ID_ANCHOR_PREFIX = 'tc:';

/**
 * Compute the canonical turn_id for one turn.
 *
 * @param callIds  tool-call correlation ids observed this turn (any order, may
 *                 contain empties/dupes/null — all normalized away).
 * @param fallbackSelfKey  the source's OWN exact turn key, used verbatim when no
 *                 call id is available. MUST be distinct per turn for that
 *                 source (e.g. the OTel `trace_id`, or `tf:<fingerprint>:<turn>`
 *                 for the transcript lane). Truncated to TURN_ID_MAX_CHARS.
 */
export function computeTurnId(
  callIds: ReadonlyArray<string | null | undefined>,
  fallbackSelfKey: string,
): string {
  const ids = Array.from(
    new Set(
      callIds
        .map((c) => (typeof c === 'string' ? c.trim() : ''))
        .filter((c) => c.length > 0),
    ),
  ).sort();
  if (ids.length > 0) {
    // \x1f (unit separator) cannot appear in a normal correlation id, so the
    // join is unambiguous.
    return TURN_ID_ANCHOR_PREFIX
      + createHash('sha256').update(ids.join('\x1f'), 'utf8').digest('hex');
  }
  return fallbackSelfKey.slice(0, TURN_ID_MAX_CHARS);
}
