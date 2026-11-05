/**
 * class-admission-earning — the record-time overlay that lets a NEVER-SEEN action type, witnessed
 * by a non-actor key, MINT at its witness-class base on its first submission.
 *
 * THE RULING. Class-based earning admission (, ratified; was to land it; the
 * boundary is): a PE type the network has never seen earns at its evidence-class base on its
 * first submission, and a matrix row is an OVERRIDE only. An unknown type witnessed by a non-actor
 * key — a registered device bound to the envelope, a chain watcher, a forge webhook, a hardware
 * attestation — mints at that witness class's base; an unknown type carrying only the actor's own
 * declaration records at zero.
 *
 * WHY AN OVERLAY. The pricing half already existed: `resolveActionPolicyAtRecordTime` resolves an
 * unnamed type to `class_admitted`, `withClassAdmission` materializes an eligible row at the class
 * base (device_tier 10000 bps), and `pvt-accrual` stamps a witnessed class `verified` with a
 * synthesized canonical event. What never lifted was the TRANSPORT durability fence: the device
 * (`/v1/pe/submit`) and mobile (`/v1/pe/submit/mobile`) lanes co-commit an ordinary-accrual intake
 * row but only claim it through per-family overlays (the witnessed families, the commit
 * witness, the / chat overlays, human_approval). Every other type — i.e. every
 * never-seen type — sealed `record_only` at `resolveOperationalDisposition`'s first branch, however
 * well witnessed. This overlay claims that row for exactly the class-admitted case.
 *
 * WHAT IT NEVER TOUCHES. It fires only when the materialized runtime row for this type IS the
 * class-admitted one (`policyReviewState === 'class_admitted'`, eligible) — never on a named row,
 * static or Firestore-pointer, so every named row is byte-identical. It fires only for a WITNESSED
 * class; `actor_declared` (base 0) returns empty and records at zero. It is record-time only:
 * nothing already sealed is repriced.
 *
 * MINT-ONCE. The canonical event is the exact occurrence this lane witnessed:
 * `class_admitted:<action_type>:<lane witness id>:<canonical body digest>` the body digest is the
 * same canonical-body sha256 the hardware-witness nonce binds (`hardwareBindingNonceHex`). A
 * byte-identical replay → same digest → `device_occurrence` duplicate → novelty 0 → 0 PVT. Scoping
 * by the witnessing device means one device cannot pre-claim another device's occurrence by copying
 * its body. Distinct occurrences differ in their bodies (a reading id, a timestamp) and price under
 * the ordinary per-actor novelty decay. FAIL-CLOSED: a missing witness id or malformed digest returns
 * an EMPTY overlay (record, never a 0-anchor mint).
 *
 * THE MOBILE LANE IS NOT A WITNESS FOR A NEVER-SEEN TYPE (carried, : "no
 * actor's own claim mints, on any route"). On `/v1/pe/submit/mobile` the only voucher for an
 * unnamed type is the human's own wallet-auth token (plus, at most, an App Attest assertion that
 * the genuine app relayed what the human typed) — nothing OBSERVED the work. So the mobile lane
 * seals a class-admitted (unnamed) type at `actor_declared` (base 0 → record_only) via
 * {@link mobileLaneWitnessClass}; this overlay is no longer called there. Named mobile types (their
 * own matrix rows + verified-field overlays: ai_conversation, human_approval, …) keep the lane's
 * device_tier / hardware_rooted class unchanged. The device lane (`/v1/pe/submit`, observation-lane
 * types only since) and the hardware-witnessed relay/action lane keep this overlay.
 *
 * NEW-TYPE INTAKE SUPERSEDES the class-base mint above. A never-seen type on a
 * witness lane is RECORDED with no mint (`classAdmittedAction` seals every class-admitted row
 * record_only at weight 0), queued, and earns only once the operator signs a NAMED row for it — from that
 * row's activation forward. So `isClassAdmittedAtRecordTime` is now false for every input (no
 * class-admitted row is eligible) and the class-base overlay never fires. What fires instead is
 * {@link intakeSignedRowWitnessedFields}: on an intake lane (`new-type-intake.ts`), for an intake
 * type whose SIGNED named row is in force and eligible at the act's record time
 * ({@link isSignedIntakeRowEligibleAtRecordTime}), it claims the same durability fence, canonical
 * event and per-occurrence mint-once the class-base overlay did. An act recorded before the row's
 * effective time finds no eligible row, gets an EMPTY overlay, and seals record_only — never
 * repriced.
 *
 * Kept a pure function (plus read-only resolver helpers) so it carries an in-suite RED negative
 * control instead of being reachable only through a full route integration test.
 */
import * as crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { RecordPEAccrualParams } from '../../pvt-accrual';
import { ORDINARY_ACCRUAL_REPLAY_SOURCE } from './wp11/ordinary-accrual-intake';
import { WITNESSED_CLASSES, type WitnessClass } from './policy/evidence-class';
import { resolveActionPolicyAtRecordTime } from './policy/action-policy-gate';
import { loadRuntimeMonetaryPolicy, withWitnessClassOverride } from './policy/runtime-monetary-policy';

const BODY_DIGEST_RE = /^[0-9a-f]{64}$/;
const WITNESS_ID_MAX_CHARS = 256;

/**
 * True when, at `recordedAtMs`, the runtime policy the accrual will load gives `actionType` the
 * CLASS-ADMITTED eligible row for `witnessClass` — the exact row, read the exact way `pvt-accrual`
 * reads it (same resolver, same loader). READ-ONLY: it never observes/queues the identifier (that is
 * `resolveAndObserveActionPolicy`). Any read failure → false (the overlay stays empty → record).
 */
export async function isClassAdmittedAtRecordTime(
  db: Firestore,
  input: { readonly actionType: string; readonly recordedAtMs: number; readonly witnessClass: WitnessClass },
): Promise<boolean> {
  if (!WITNESSED_CLASSES.has(input.witnessClass)) return false;
  try {
    const resolution = await resolveActionPolicyAtRecordTime(db, input);
    if (resolution.status !== 'class_admitted') return false;
    const policy = await loadRuntimeMonetaryPolicy(db, input.recordedAtMs, resolution);
    const row = policy.actions[input.actionType];
    return row !== undefined
      && row.policyReviewState === 'class_admitted'
      && row.mintDisposition === 'eligible';
  } catch {
    return false;
  }
}

/**
 * The accrual-param overlay that makes a class-admitted, non-actor-witnessed PE durable and
 * mint-once on its own occurrence. PURE. Returns an EMPTY overlay — byte-identical sealed
 * disposition to before — unless ALL hold: the type is class-admitted (the caller's resolved
 * `classAdmitted`), the lane's witness class is a witnessed (non-actor) class, the witnessing
 * identity is present, and the canonical body digest is well-formed.
 */
export function classAdmittedWitnessedFields(input: {
  readonly actionType: string;
  readonly classAdmitted: boolean;
  readonly witnessClass: WitnessClass;
  readonly witnessId: string | null | undefined;
  readonly bodyDigestHex: string;
}): Partial<RecordPEAccrualParams> {
  if (!input.classAdmitted) return {};
  return witnessedOccurrenceOverlay('class_admitted', input);
}

/**
 * The shared overlay: claim the co-committed intake row, stamp the witnessed evidence, and anchor
 * mint-once on `<prefix>:<action_type>:<witness id>:<canonical body digest>`. PURE. EMPTY unless the
 * class is a witnessed (non-actor) class, the witness identity is present and bounded, and the body
 * digest is well-formed.
 */
function witnessedOccurrenceOverlay(
  prefix: 'class_admitted' | 'new_type_intake',
  input: {
    readonly actionType: string;
    readonly witnessClass: WitnessClass;
    readonly witnessId: string | null | undefined;
    readonly bodyDigestHex: string;
  },
): Partial<RecordPEAccrualParams> {
  if (!WITNESSED_CLASSES.has(input.witnessClass)) return {};
  const witnessId = typeof input.witnessId === 'string' ? input.witnessId.trim() : '';
  if (witnessId.length === 0 || witnessId.length > WITNESS_ID_MAX_CHARS) return {};
  if (!BODY_DIGEST_RE.test(input.bodyDigestHex)) return {};
  const canonical = `${prefix}:${input.actionType}:${witnessId}:${input.bodyDigestHex}`;
  const canonicalHash = crypto.createHash('sha256').update(canonical).digest('hex');
  return {
    // Claim the co-committed ordinary-accrual intake row → the transport durability fence lifts
    // (verified against that committed row in pvt-accrual, never on the caller's word).
    durableReplaySource: ORDINARY_ACCRUAL_REPLAY_SOURCE,
    // The lane's non-actor witness IS the evidence; set explicitly for parity with the sibling
    // overlays (pvt-accrual also stamps a `verified_witness_class` row verified itself).
    economicEvidenceState: 'verified',
    // The canonical event is this witnessed occurrence (satisfies canonical_event_required).
    economicCanonicalEventId: canonical,
    // Hard per-occurrence mint-once: a byte-identical replay → same digest → exactDuplicate → 0.
    deviceWitnessedOccurrenceHash: canonicalHash,
  };
}

/**
 * NEW-TYPE INTAKE, A4 — true when, at `recordedAtMs`, the runtime policy the accrual will load
 * prices `actionType` with a SIGNED, NAMED, ELIGIBLE row: read the exact way `pvt-accrual` reads it
 * (same resolver, same loader, same hardware override). False for the class-admitted synthesis
 * (record_only), for a record_only / absent named row, for an inactive or not-yet-effective policy
 * (the act predates the signing cut), for an effective rejection, for an actor-declared class, and
 * on any read failure. READ-ONLY.
 */
export async function isSignedIntakeRowEligibleAtRecordTime(
  db: Firestore,
  input: { readonly actionType: string; readonly recordedAtMs: number; readonly witnessClass: WitnessClass },
): Promise<boolean> {
  if (!WITNESSED_CLASSES.has(input.witnessClass)) return false;
  try {
    const resolution = await resolveActionPolicyAtRecordTime(db, input);
    if (resolution.status === 'rejected' || resolution.status === 'pending_policy') return false;
    const policy = withWitnessClassOverride(
      await loadRuntimeMonetaryPolicy(db, input.recordedAtMs, resolution),
      input.actionType,
      input.witnessClass,
    );
    const row = policy.actions[input.actionType];
    return row !== undefined
      && row.policyReviewState !== 'class_admitted'
      && row.mintDisposition === 'eligible';
  } catch {
    return false;
  }
}

/**
 * NEW-TYPE INTAKE, A4 — the overlay that lets an intake type MINT ONCE at its signed row's price on
 * the lane it came in on. PURE. EMPTY — the act records, byte-identical to before — unless ALL hold:
 * the lane admitted the act through the new-type intake (`intakeAdmitted`, never set for a named
 * observation type, whose own overlays stay byte-identical), the signed named row is eligible at
 * record time (`signedRowEligible`), the class is a witnessed (non-actor) class, the witnessing
 * identity is present, and the canonical body digest is well-formed.
 */
export function intakeSignedRowWitnessedFields(input: {
  readonly actionType: string;
  readonly intakeAdmitted: boolean;
  readonly signedRowEligible: boolean;
  readonly witnessClass: WitnessClass;
  readonly witnessId: string | null | undefined;
  readonly bodyDigestHex: string;
}): Partial<RecordPEAccrualParams> {
  if (!input.intakeAdmitted || !input.signedRowEligible) return {};
  return witnessedOccurrenceOverlay('new_type_intake', input);
}

/**
 * True when, at `recordedAtMs`, NO named row prices `actionType` — read exactly the way the accrual
 * reads it (same resolver, same runtime-policy loader): the materialized row is absent or is the
 * class-admitted synthesis. A named row that the resolver reports `class_admitted` (a matrix row
 * with no launch-emitter entry and no Firestore pointer, e.g. `human_approval`) is NAMED — the
 * loader keeps its row ("a named row always wins"). READ-ONLY. FAIL-CLOSED: any read failure answers
 * `true` (treat the type as the actor's own declaration → record_only), never "named".
 */
export async function isUnnamedActionTypeAtRecordTime(
  db: Firestore,
  input: { readonly actionType: string; readonly recordedAtMs: number },
): Promise<boolean> {
  try {
    const resolution = await resolveActionPolicyAtRecordTime(db, {
      actionType: input.actionType,
      recordedAtMs: input.recordedAtMs,
      witnessClass: 'device_tier',
    });
    const policy = await loadRuntimeMonetaryPolicy(db, input.recordedAtMs, resolution);
    const row = policy.actions[input.actionType];
    return row === undefined || row.policyReviewState === 'class_admitted';
  } catch {
    return true;
  }
}

/**
 * The relay-assigned witness class of a `/v1/pe/submit/mobile` envelope. PURE. A never-seen
 * (unnamed, class-admitted) type is the human's own declaration → `actor_declared` (base 0 →
 * record_only), whatever hardware report rides it. A named type keeps the lane's class: the
 * request-bound wallet auth on the human's registered phone (`device_tier`), or `hardware_rooted`
 * when an App Attest report verified.
 */
export function mobileLaneWitnessClass(input: {
  readonly hardwareAdmitted: boolean;
  readonly unnamedActionType: boolean;
}): WitnessClass {
  if (input.unnamedActionType) return 'actor_declared';
  return input.hardwareAdmitted ? 'hardware_rooted' : 'device_tier';
}
