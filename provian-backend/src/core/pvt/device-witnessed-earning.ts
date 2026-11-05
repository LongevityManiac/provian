/**
 * DEVICE-WITNESSED VERIFIED EARNING (the Witness-1 mint enablement).
 *
 * A registered machine's observer daemon submits device-witnessed compute work
 * to `POST /v1/pe/submit` (device auth). Before that path co-committed a
 * durable intake row but deliberately withheld the `durableReplaySource` marker
 * AND never stamped `verified` evidence, so every such PE sealed `record_only`
 * and minted 0 however real the work (`devices.ts` pre-; the durability
 * fence in `pvt-accrual.ts::resolveOperationalDisposition`).
 *
 * This module is the record-time overlay that lifts both fences for the families
 * a body-bound daemon genuinely witnesses. It is the exact parallel of the
 * sovereign per-occurrence agent-key binding (, `routes/sovereign-pe.ts`):
 * there the agent's own-key signature over the occurrence IS the evidence; here
 * the device's authenticated per-request body binding (DeviceSignature/SE, or a
 * verified X-Provian-Body-HMAC on a bearer credential) IS the evidence. In both
 * cases the binding proves AUTHENTICITY (who observed this exact work), and the
 * attestation TIER prices the self-attested nature — bearer→software 0.8×,
 * SE→hardware_partial 1.0× under the evidence-priced table. Body-binding is
 * the whole gate; Secure Enclave is a value LIFT, never a requirement to earn
 * (the operator, Q2). The Sybil bound is per-device registration + real compute
 * cost + novelty decay — no cluster exclusion, fleet cap, or volume ceiling.
 *
 * Kept OUT of `devices.ts` on purpose: these are pure functions, so they carry
 * an in-suite RED negative control (`device-witnessed-earning.test.ts`) instead
 * of being reachable only through a full-Firestore route integration test.
 */

import * as crypto from 'crypto';
import type { RecordPEAccrualParams } from '../../pvt-accrual';
import { ORDINARY_ACCRUAL_REPLAY_SOURCE } from './wp11/ordinary-accrual-intake';
import { linkSpendCanonicalEvent } from './link-spend-witness';

/**
 * Device-witnessed compute families that seal VERIFIED at record time when the
 * submission is body-bound. Single source of truth: the route handler AND its
 * tests read THIS set (never a redeclared literal list).
 *
 * `coding_session` is DELIBERATELY ABSENT. It is commit-witnessed and shares its
 * `(user, commit_sha)` mint-once claim with the forge webhook (`service:*`, base
 * 3.0× vs compute 1.0×). A bare verified stamp here would let whichever witness
 * arrives first win the claim and STRAND the forge's higher-base value — the
 * regression Q1 forbids. Its best-value + corroboration-lift resolution is
 * the dual-witness path (Build B), which enrolls it there, not here.
 */
export const DEVICE_WITNESSED_VERIFIED_FAMILIES: ReadonlySet<string> = new Set([
  'compute_session',
  'inference_session',
  'agent_tool_orchestration',
  'agent_api_orchestration',
  // the Stripe Link spend witness. Keyed on the spend-request id
  // (`link_spend:<lsrq_…>`, SUCCEEDED only) — see link-spend-witness.ts.
  'link_spend',
]);

/** Upper bound on a stamped turn_id — mirrors the SDK's TURN_ID_MAX_CHARS. */
const TURN_ID_MAX_CHARS = 128;

/**
 * Normalize the device-supplied `metadata.turn_id` (the SDK's cross-source turn
 * identity: `tc:<sha256>`, a raw OTLP trace id, or the transcript lane's
 * `tf:<fingerprint>:<turn>` self key). Bounded + a safe charset so a hostile or
 * garbled value can never break the canonical-event string or the claim key.
 * Returns null (→ the caller falls back to trace_id) rather than throwing.
 */
function normalizeTurnId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (t.length === 0 || t.length > TURN_ID_MAX_CHARS) return null;
  if (!/^[A-Za-z0-9:_.\-]+$/.test(t)) return null;
  return t;
}

/**
 * The canonical event id (satisfies `canonical_event_required` AND keys the
 * artifact-novelty + device_occurrence mint-once) for a body-bound
 * device-witnessed compute PE:
 *  - orchestration → the cross-source turn identity `metadata.turn_id`
 *    (both the OTel and the transcript lane stamp it), falling back to the OTLP
 *    trace id for an already-deployed OTel PE that carries no turn_id. Keying on
 *    turn_id is what (a) lets the TRANSCRIPT lane — which has no trace_id — earn
 *    and take a device_occurrence claim at all, and (b) collapses the SAME turn
 *    seen by BOTH sources to ONE mint (their turn_ids match). A turn that carries
 *    no tool-call id keys turn_id === trace_id, so the event is byte-identical to
 *    the pre-turn_id form — no double-mint across the deploy boundary.
 *  - compute/inference → the attested observer session lineage (one PE/session).
 * The action_type is folded in so a turn that emits BOTH a tool- and an
 * api-orchestration PE (same trace/turn) does not collide onto one claim.
 * Returns null when the required identifier is absent → the caller stamps
 * nothing and the PE stays record_only (fail-safe, never a 0-point "eligible").
 */
export function deviceWitnessedCanonicalEvent(
  actionType: string,
  metadata: unknown,
  sessionLineageId: string | null,
): string | null {
  if (actionType === 'agent_tool_orchestration' || actionType === 'agent_api_orchestration') {
    const md = metadata as { turn_id?: unknown; trace_id?: unknown } | null | undefined;
    const turnId = normalizeTurnId(md?.turn_id);
    const traceId = typeof md?.trace_id === 'string' ? md.trace_id.trim() : '';
    const id = turnId ?? (traceId.length > 0 ? traceId : null);
    return id !== null ? `${actionType}:${id}` : null;
  }
  if (actionType === 'compute_session' || actionType === 'inference_session') {
    return sessionLineageId && sessionLineageId.length > 0
      ? `${actionType}:${sessionLineageId}`
      : null;
  }
  if (actionType === 'link_spend') {
    // The completed purchase, keyed on Link's own spend-request id. A non-
    // succeeded terminal (failed/denied/expired/canceled) or a malformed record
    // yields no canonical event → no verified stamp → record_only.
    return linkSpendCanonicalEvent(metadata);
  }
  return null;
}

/**
 * The accrual-param overlay that turns a body-bound device-witnessed compute PE
 * into a durable, verified, mintable one. PURE (a function of its inputs only).
 * Returns an EMPTY overlay — byte-identical sealed disposition to pre-* unless ALL hold: the submission is body-bound, the action type is a
 * device-witnessed compute family, AND a canonical event id is derivable.
 */
export function deviceWitnessedVerifiedFields(input: {
  readonly actionType: string;
  readonly bodyBound: boolean;
  readonly metadata: unknown;
  readonly sessionLineageId: string | null;
}): Partial<RecordPEAccrualParams> {
  if (!input.bodyBound || !DEVICE_WITNESSED_VERIFIED_FAMILIES.has(input.actionType)) {
    return {};
  }
  const canonical = deviceWitnessedCanonicalEvent(
    input.actionType,
    input.metadata,
    input.sessionLineageId,
  );
  if (canonical === null) return {};
  const canonicalHash = crypto.createHash('sha256').update(canonical).digest('hex');
  return {
    // Claim the co-committed intake row → the durability fence lifts.
    durableReplaySource: ORDINARY_ACCRUAL_REPLAY_SOURCE,
    // The device body-binding IS the record-time verifier (the parallel).
    economicEvidenceState: 'verified',
    // Satisfies canonical_event_required.
    economicCanonicalEventId: canonical,
    // the HARD per-occurrence mint-once (the residual (b) fix). A replay
    // of the identical body-bound submission produces the SAME canonical event
    // → the same digest → an `exactDuplicate` device-occurrence claim → novelty
    // 0 → 0 PVT. This is the anti-replay net Build A lacked: it carried only the
    // SOFT artifact-novelty claim below, which never forces `exactDuplicate`
    // (floored at 0.3× and reset every UTC day), so a replay minted again.
    deviceWitnessedOccurrenceHash: canonicalHash,
    // Compute-category artifact-novelty (the SOFT per-UTC-day novelty CEILING for
    // DISTINCT outputs — retained so distinct work keeps its uniqueArtifact
    // pricing; the hard replay block above is what closes the double-mint hole).
    artifact_hash: canonicalHash,
  };
}

/**
 * Build B (unit 2) — the SEPARATE commit-witness enrollment for
 * `coding_session`, DELIBERATELY not part of `DEVICE_WITNESSED_VERIFIED_FAMILIES`.
 *
 * A body-bound observer `coding_session` that carries a commit sha is the local
 * (daemon) witness of a git commit that a forge webhook (`service:github_commit`,
 * base 3.0×) may also witness. Both share the SAME `(user, commit_sha)` cross-
 * witness mint-once claim (`commitSha` → `prepareCommitMintClaim`), so exactly one
 * of the two ever mints for a commit. This overlay lifts the daemon's durability +
 * evidence fences — durable (claims the co-committed intake row) + `verified` (the
 * device body-binding IS the record-time verifier, the parallel) + canonical
 * event = the commit — so the daemon competes on that claim as a MINTABLE witness
 * (compute base 1.0× × its own attestation tier: bearer→software 0.8×, SE→1.0×).
 *
 * It DOES NOT set `deviceWitnessedOccurrenceHash` the mint-once here is the
 * EXISTING commit claim, NOT the `device_occurrence` claim (which is the hard
 * per-occurrence net for the body-bound compute families that have no commit).
 * Adding a second mint-once anchor for one canonical event would be a double
 * claim for one act. It sets no `artifact_hash` either — the commit claim is the
 * sole dedup, and a per-UTC-day artifact-novelty ceiling would only muddy the
 * base-weight takeover comparison it must not affect.
 *
 * Empty (byte-identical to pre-, so the PE stays `record_only`) unless ALL
 * hold: the action is `coding_session`, the submission is body-bound, and a
 * commit sha is present. The best-value takeover between the daemon and the forge
 * is decided at record time in `pvt-accrual.ts` off the sealed base weight; the
 * corroboration lift is applied at settlement. Neither lives here.
 */
export function commitWitnessedVerifiedFields(input: {
  readonly actionType: string;
  readonly bodyBound: boolean;
  readonly commitSha: string | null | undefined;
}): Partial<RecordPEAccrualParams> {
  if (input.actionType !== 'coding_session' || !input.bodyBound) return {};
  const commitSha = typeof input.commitSha === 'string' ? input.commitSha.trim() : '';
  if (commitSha.length === 0) return {};
  return {
    // Claim the co-committed intake row → the durability fence lifts.
    durableReplaySource: ORDINARY_ACCRUAL_REPLAY_SOURCE,
    // The device body-binding IS the record-time verifier (the parallel).
    economicEvidenceState: 'verified',
    // Satisfies canonical_event_required; the commit is the canonical event.
    economicCanonicalEventId: `coding_session:${commitSha}`,
  };
}
