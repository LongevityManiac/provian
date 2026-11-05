/**
 * THE PER-DEVICE SESSION REGISTRY: the relay's own state about sessions.
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 * recorded, honestly, that the lineage derivation's only binding material
 * is the device id — which the authenticated caller already knows. So the pure
 * verifier could confirm "this id belongs to this device" and nothing more: it
 * could not tell one attested session emitting many PEs from a client minting a
 * fresh lineage per PE. The one-session-one-id property rested entirely on an
 * honest SDK, and the docblock said so rather than pretending otherwise.
 *
 * The reason no cryptographic construction fixes that on its own is worth
 * stating, because it is why this file exists instead of a bigger signature:
 * the agent genuinely controls its own runtime, and it already holds whatever
 * key it would sign a session-opening with. A second signature over the
 * session-open, made by the same key that just authenticated the request, proves
 * nothing the request did not already prove. What was missing was not more
 * signing — it was **state on the relay's side of the boundary**.
 *
 * ── WHAT THE RELAY NOW ENFORCES ─────────────────────────────────────────────
 * One document per device, holding the last session it admitted. The claim
 * carries a 1-based `session_ordinal` that is INSIDE the lineage digest (so it
 * cannot be edited after minting), and admission is transactional:
 *
 * - the FIRST session a device ever opens must be ordinal 1;
 * - a claim whose lineage id equals the current one is a CONTINUATION — the
 * ordinary case, every PE after the first in a session — and is admitted
 * without moving the registry forward;
 * - a NEW lineage id must present exactly `current_ordinal + 1`, and its
 * declared start must not move backwards in time;
 * - a superseded lineage (an ordinal at or below the current one, under a
 * different id) is REFUSED — sessions cannot be replayed or resumed after
 * the device has moved on;
 * - the same ordinal under a different id is REFUSED — sessions cannot FORK,
 * which is what "parallel sessions to inflate the count" would look like;
 * - a skipped ordinal is REFUSED — the sequence has no holes, so the count
 * the registry reports is the real number of sessions this device opened.
 *
 * ── WHAT IS CLOSED, AND WHAT HONESTLY IS NOT ────────────────────────────────
 * CLOSED: fabrication of parallel or retroactive sessions, replay of an old
 * lineage, and an uncountable session space. Sessions are now sequential,
 * countable, non-replayable and non-forkable, and `sessions_opened_total` is a
 * number the relay computed rather than one the client asserted — so any future
 * rule that prices or groups by session has real state to read instead of an id
 * to trust.
 *
 * NOT CLOSED, and it cannot be from here: the relay still cannot prove that a
 * session corresponds to real elapsed work. A determined client can advance the
 * ordinal once per PE. What changes is that doing so is now VISIBLE — it burns
 * a monotonic counter the relay owns, at a rate the registry records — instead
 * of being indistinguishable from honest behaviour. Any rule that later prices
 * by session must read `sessions_opened_total` and `pe_count_current`, not the
 * lineage id alone. That is stated here rather than left for the next reader to
 * discover.
 *
 * Writes ONLY this collection, inside the caller's transaction. It grants no
 * mint, settlement or eligibility authority: its entire output is admit/refuse.
 */

import type admin from 'firebase-admin';
import type { EconomicSessionLineageClaim } from './economic-session-lineage';

export const DEVICE_SESSION_REGISTRY_COLLECTION = 'device_session_lineage_v1';
export const DEVICE_SESSION_REGISTRY_SCHEMA = 'device-session-lineage/v1' as const;

export interface DeviceSessionRegistryDocument {
  readonly schema_version: typeof DEVICE_SESSION_REGISTRY_SCHEMA;
  readonly device_id: string;
  /** The lineage id currently admitted for this device. */
  readonly current_lineage_id: string;
  /** Its 1-based ordinal. Strictly monotonic; never decreases. */
  readonly current_ordinal: number;
  /** The session's own declared start instant. */
  readonly current_started_at_ms: number;
  /** When the relay admitted this session. Relay clock, not the client's. */
  readonly admitted_at_ms: number;
  /** How many sessions this device has ever opened. Relay-computed. */
  readonly sessions_opened_total: number;
  /** PEs admitted under the CURRENT session. Relay-counted. */
  readonly pe_count_current: number;
}

export type DeviceSessionAdmission =
  | { readonly ok: true; readonly kind: 'opened' | 'continued'; readonly ordinal: number }
  | {
    readonly ok: false;
    readonly reason: DeviceSessionRejection;
    /**
     * THE RESYNC VALUE, and why withholding it was a defect.
     *
     * 's reserve-before-use store burns an ordinal at session OPEN, but the
     * relay only advances when a PE carrying it is ADMITTED. So a session that
     * opens and never lands a lineage-bearing PE — a transient submit failure,
     * or a session whose only PE fell outside its capture window — desynced the
     * device by one. The local counter only ever increased, so EVERY later claim
     * was refused `session_ordinal_gap` from then on, permanently, and the route
     * 400s BEFORE the chain-tip advance: those PEs stopped being RECORDED, not
     * merely fenced (Security Invariant #5). called the skip "recoverable";
     * nothing in the shipped code could recover it.
     *
     * This is the recovery, and it gives the client no power it lacked: the
     * relay-computed next ordinal is exactly the number an honest client already
     * derives. Monotonicity, fork-refusal and supersession are unchanged — only
     * ONE session can ever occupy an ordinal, and the counter still only moves
     * forward. Null where no sequencing answer applies.
     */
    readonly expectedOrdinal: number | null;
  };

export type DeviceSessionRejection =
  | 'first_session_must_be_ordinal_one'
  | 'session_ordinal_gap'
  | 'session_ordinal_conflict'
  | 'session_superseded'
  | 'session_start_regressed'
  | 'session_start_in_future'
  | 'registry_malformed';

/**
 * Clock skew tolerated on a client-declared session start. A technical
 * tolerance, not an economic value: it exists so an honestly-skewed device is
 * not refused, and so a client cannot declare a session opening in 2100.
 */
export const SESSION_START_FUTURE_SKEW_MS = 5 * 60 * 1000;

function isRegistryDoc(value: unknown): value is DeviceSessionRegistryDocument {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<DeviceSessionRegistryDocument>;
  return r.schema_version === DEVICE_SESSION_REGISTRY_SCHEMA
    && typeof r.device_id === 'string'
    && typeof r.current_lineage_id === 'string'
    && typeof r.current_ordinal === 'number' && Number.isSafeInteger(r.current_ordinal)
    && typeof r.current_started_at_ms === 'number'
    && typeof r.sessions_opened_total === 'number'
    && typeof r.pe_count_current === 'number';
}

/**
 * Decide admission against the registry state. PURE — the transaction wrapper
 * below does the I/O — so every branch is directly constructible in a test
 * without a Firestore double, which is what keeps the refusal arms from becoming
 * the unreachable guards warns about.
 */
export function judgeDeviceSessionAdmission(
  prior: DeviceSessionRegistryDocument | null,
  claim: EconomicSessionLineageClaim,
  nowMs: number,
): DeviceSessionAdmission {
  // The ordinal the relay would admit for a NEW session, from ITS OWN state.
  const expectedOrdinal = (prior?.current_ordinal ?? 0) + 1;

  if (prior === null) {
    // A device's first session. Starting anywhere but 1 would make
    // `sessions_opened_total` a number the client chose.
    if (claim.session_ordinal !== 1) {
      return { ok: false, reason: 'first_session_must_be_ordinal_one', expectedOrdinal };
    }
    if (claim.session_started_at_ms > nowMs + SESSION_START_FUTURE_SKEW_MS) {
      return { ok: false, reason: 'session_start_in_future', expectedOrdinal: null };
    }
    return { ok: true, kind: 'opened', ordinal: 1 };
  }

  if (claim.id === prior.current_lineage_id) {
    // The ordinary case: another PE inside the session already admitted. The
    // ordinal must still agree, or the digest and the registry disagree about
    // what this session IS.
    if (claim.session_ordinal !== prior.current_ordinal) {
      return { ok: false, reason: 'session_ordinal_conflict', expectedOrdinal };
    }
    return { ok: true, kind: 'continued', ordinal: prior.current_ordinal };
  }

  // A different lineage id: this is a session OPEN.
  if (claim.session_ordinal === prior.current_ordinal) {
    // Same ordinal, different id — a FORK. Two sessions claiming one slot is
    // exactly what running parallel sessions to inflate the count looks like.
    return { ok: false, reason: 'session_ordinal_conflict', expectedOrdinal };
  }
  if (claim.session_ordinal < prior.current_ordinal) {
    // Replaying or resuming a session the device has already moved past.
    return { ok: false, reason: 'session_superseded', expectedOrdinal };
  }
  if (claim.session_ordinal !== prior.current_ordinal + 1) {
    // A hole in the sequence would make the count unverifiable.
    return { ok: false, reason: 'session_ordinal_gap', expectedOrdinal };
  }
  if (claim.session_started_at_ms < prior.current_started_at_ms) {
    // A later session cannot have started earlier than the one it follows.
    return { ok: false, reason: 'session_start_regressed', expectedOrdinal: null };
  }
  if (claim.session_started_at_ms > nowMs + SESSION_START_FUTURE_SKEW_MS) {
    // the declared start is compared to the RELAY's clock, not only to
    // the previous session's. Without this, "a later session cannot have started
    // earlier" was two client-chosen numbers checked against each other, and a
    // session could declare itself opening in 2100.
    return { ok: false, reason: 'session_start_in_future', expectedOrdinal: null };
  }
  return { ok: true, kind: 'opened', ordinal: claim.session_ordinal };
}

/** Build the row to commit for an admitted claim. PURE. */
export function nextRegistryDocument(
  prior: DeviceSessionRegistryDocument | null,
  deviceId: string,
  claim: EconomicSessionLineageClaim,
  admission: Extract<DeviceSessionAdmission, { ok: true }>,
  nowMs: number,
): DeviceSessionRegistryDocument {
  if (admission.kind === 'continued' && prior !== null) {
    return { ...prior, pe_count_current: prior.pe_count_current + 1 };
  }
  return {
    schema_version: DEVICE_SESSION_REGISTRY_SCHEMA,
    device_id: deviceId,
    current_lineage_id: claim.id,
    current_ordinal: claim.session_ordinal,
    current_started_at_ms: claim.session_started_at_ms,
    admitted_at_ms: nowMs,
    sessions_opened_total: (prior?.sessions_opened_total ?? 0) + 1,
    pe_count_current: 1,
  };
}

/**
 * Admit (or refuse) one claim, transactionally.
 *
 * The transaction is what makes the fork refusal real: two concurrent PEs
 * opening different sessions at the same ordinal cannot both read the same
 * prior state and both commit — one loses and is refused.
 *
 * A malformed registry row REFUSES rather than resetting. Fail-closed is right
 * here and the direction matters: recreating a lost registry would let a client
 * corrupt the doc to reset its own ordinal, which is the one thing the registry
 * exists to prevent.
 */
export async function admitDeviceSessionLineage(
  db: admin.firestore.Firestore,
  deviceId: string,
  claim: EconomicSessionLineageClaim,
  nowMs: number,
): Promise<DeviceSessionAdmission> {
  const ref = db.collection(DEVICE_SESSION_REGISTRY_COLLECTION).doc(deviceId);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    let prior: DeviceSessionRegistryDocument | null = null;
    if (snap.exists) {
      const raw: unknown = snap.data();
      if (!isRegistryDoc(raw)) {
        // No resync value here, deliberately: a malformed row means the relay
        // does not KNOW where the counter is, and inventing one would let a
        // client that corrupted the doc choose its own ordinal.
        return {
          ok: false, reason: 'registry_malformed', expectedOrdinal: null,
        } as DeviceSessionAdmission;
      }
      prior = raw;
    }
    const admission = judgeDeviceSessionAdmission(prior, claim, nowMs);
    if (!admission.ok) return admission;
    txn.set(ref, { ...nextRegistryDocument(prior, deviceId, claim, admission, nowMs) });
    return admission;
  });
}
