/**
 * mobile-chat-earning — the record-time overlay that makes a HUMAN's in-app
 * chat capture (`ai_conversation`) MINT, instead of sealing `record_only`.
 *
 * WHY THE MOBILE LANE SEALED record_only (the fence this lifts). The mobile
 * submit path (`POST /v1/pe/submit/mobile`) is a best-effort transport: its
 * accrual params carried neither `throwOnError` nor `durableReplaySource`, so
 * `resolveOperationalDisposition` returned `record_only` at its first branch —
 * BEFORE the action-policy matrix was ever consulted (`pvt-accrual.ts`). The
 * `ai_conversation` matrix row is already `eligible` at 10000 bps
 * (`pvt-action-policy-matrix.generated.json`); nothing in the matrix or the
 * monetary template changes here — this overlay only stops the transport from
 * demoting a row the policy already prices to mint. DIGEST-NEUTRAL.
 *
 * THE ANTI-SYBIL CONTROL IS THE BIOMETRIC APP GATE. Every
 * mobile submission is body-bound by construction — the wallet-auth v2 bearer
 * binds the request body hash (`wallet-auth.ts`), and a bot cannot open a
 * biometrically gated app and converse all day. So there is NO daily ceiling,
 * NO fatigue curve, and NO attestation gate: a person typing back and forth in
 * the app earns for it at standard weights with novelty decay on top, exactly
 * like every other surface. This is the EXACT parallel of 's
 * device-witnessed compute overlay (`device-witnessed-earning.ts`): there the
 * device body-binding IS the record-time verifier; here the biometric-gated,
 * body-bound app submission IS the record-time verifier.
 *
 * THE CANONICAL EVENT + MINT-ONCE is the session fingerprint. `ChatPEEmitter`
 * computes `session_fingerprint_hash` over the captured turn window and the
 * relay already content-hash-dedups on it. It is the natural per-session
 * canonical event and the hard per-occurrence mint-once anchor: a replay of the
 * identical captured session produces the same fingerprint → the same
 * `device_occurrence` claim → novelty 0 → 0 PVT. Distinct sessions keep their
 * `artifact_hash` novelty pricing (the standard per-UTC-day novelty CEILING for
 * DISTINCT outputs — never a hard per-day cap). Kept OUT of the route handler as
 * a pure function so it carries an in-suite RED negative control.
 */

import * as crypto from 'crypto';
import type { RecordPEAccrualParams } from '../../pvt-accrual';
import { ORDINARY_ACCRUAL_REPLAY_SOURCE } from './wp11/ordinary-accrual-intake';

/** 64 lowercase hex — the exact shape the metadata validator enforces. */
const SESSION_FINGERPRINT = /^[0-9a-f]{64}$/;

/**
 * SURFACES THAT NEVER MINT. Android out-of-app AI capture
 * (the Phase 2c M7 UsageStats path, surface `mobile_usage_stats`) is NOT live: no shipping
 * client emits it, and its capture is not sound enough to price (the daily-interval query
 * re-reports the same day totals under a new fingerprint on every app open, so each open
 * would mint the same usage again). The mobile validator refuses the surface outright; this
 * overlay refuses it again on EVERY lane (the device route's metadata is free-form), so the
 * invariant "no PE on this surface mints" holds even if a validator is later loosened.
 * Normalized (trim + lowercase) so a case variant cannot slip past.
 */
export const NON_MINTING_AI_CONVERSATION_SURFACES: readonly string[] = ['mobile_usage_stats'];

function isNonMintingSurface(surface: string | null | undefined): boolean {
  if (typeof surface !== 'string') return false;
  return NON_MINTING_AI_CONVERSATION_SURFACES.includes(surface.trim().toLowerCase());
}

/**
 * NO ACTIVE-DURATION EFFORT FLOOR (— "every act mints once at its
 * best-supported value"). The 2,000 ms `active_duration_ms` floor that used to
 * live here is REMOVED: a chat session under 2 s now mints exactly like any other,
 * and there is no replacement threshold, cap, or gate. The anti-Sybil answer is the
 * set of controls that were always doing the real work — device registration,
 * attestation tier, novelty decay, and hard per-occurrence mint-once (the session
 * fingerprint) — never a minimum duration. The floor's own docblock had already
 * conceded it was NOT an anti-forgery control (self-reported, device-authenticated
 * metadata a modified daemon could forge), so its only reach was casual short-blip
 * filtering, which this ruling deliberately drops. DIGEST-NEUTRAL: the
 * `ai_conversation` matrix row stays `eligible` at 10000 bps; this only stops the
 * transport from demoting a row the policy already prices to mint.
 *
 * WHY THIS SEAM STILL MATTERS. `ai_conversation` is `externalProofPriced` (reason
 * code `VERIFIED_SOVEREIGN_AGENT_WORK`): a self-attested/software submission floors
 * to 0 and seals `record_only` UNLESS this overlay stamps `verified`. The remaining
 * gates are structural validity, not effort/size: the action type must be
 * `ai_conversation`, a well-formed session fingerprint must be present (the mint-once
 * anchor), and (device route) the request must be body-bound. Those fail-safes are
 * preserved; only the duration floor is gone.
 */

/**
 * The accrual-param overlay that turns a body-bound `ai_conversation` mobile PE
 * into a durable, verified, mintable one. PURE (a function of its inputs only).
 * Returns an EMPTY overlay — byte-identical sealed disposition to before —
 * unless the action type is `ai_conversation` AND the surface is not a
 * non-minting one AND a well-formed session
 * fingerprint is present (fail-safe: a missing/malformed fingerprint stamps
 * nothing and the PE stays `record_only`, never a 0-point "eligible").
 */
export function mobileChatVerifiedFields(input: {
  readonly actionType: string;
  readonly sessionFingerprintHash: string | null | undefined;
  /** `ai_conversation_metadata.surface` (mobile) / `metadata.surface` (device). */
  readonly surface: string | null | undefined;
}): Partial<RecordPEAccrualParams> {
  if (input.actionType !== 'ai_conversation') return {};
  // the Android UsageStats surface never mints (empty overlay → record_only).
  if (isNonMintingSurface(input.surface)) return {};
  const fingerprint =
    typeof input.sessionFingerprintHash === 'string'
      ? input.sessionFingerprintHash.trim().toLowerCase()
      : '';
  if (!SESSION_FINGERPRINT.test(fingerprint)) return {};
  // No duration floor (2026-): a session under 2 s mints. The
  // fingerprint gate above is the mint-once/novelty anchor; a replay of the same
  // session reprices to 0. The only remaining gates are structural validity.

  const canonical = `ai_conversation:${fingerprint}`;
  const canonicalHash = crypto.createHash('sha256').update(canonical).digest('hex');
  return {
    // Claim the co-committed ordinary-accrual intake row → the durability fence
    // lifts (verified against that committed row in pvt-accrual, never on the
    // caller's word). This must ride the SAME builder that writes the intake
    // row, so the bytes match.
    durableReplaySource: ORDINARY_ACCRUAL_REPLAY_SOURCE,
    // The biometric-gated, body-bound app submission IS the record-time
    // verifier (the / parallel).
    economicEvidenceState: 'verified',
    // Satisfies canonical_event_required for the verified_work_artifact group.
    economicCanonicalEventId: canonical,
    // Hard per-occurrence mint-once: a replay of the identical captured session
    // → same fingerprint → same digest → exactDuplicate → novelty 0 → 0 PVT.
    deviceWitnessedOccurrenceHash: canonicalHash,
    // Compute-category artifact novelty (the SOFT per-UTC-day novelty CEILING
    // for DISTINCT sessions — never a hard daily cap;).
    artifact_hash: canonicalHash,
  };
}

/**
 * (WS2) — the DEVICE-route variant of the same overlay, for the DESKTOP
 * observer's `ai_conversation` capture on `POST /v1/devices/pe/submit`.
 *
 * The mobile submit path is body-bound by construction (wallet-auth v2 binds the
 * body hash), so `mobileChatVerifiedFields` needs no gate. The device route is
 * NOT: a bearer daemon with no `X-Provian-Body-HMAC` is authenticated but cannot
 * vouch for the specific work it claims, so it must stay `record_only`. This thin
 * wrapper adds exactly that `bodyBound` gate — mirroring the sibling device
 * overlays `deviceWitnessedVerifiedFields`/`commitWitnessedVerifiedFields`
 * (device-witnessed-earning.ts), which both gate on `bodyBound` and otherwise
 * delegates to the SAME pure logic so mobile and desktop price a chat session
 * identically. PURE; empty overlay (unchanged sealed disposition) unless
 * body-bound AND `ai_conversation` AND a well-formed fingerprint.
 */
export function deviceChatVerifiedFields(input: {
  readonly actionType: string;
  readonly bodyBound: boolean;
  readonly sessionFingerprintHash: string | null | undefined;
  readonly surface: string | null | undefined;
}): Partial<RecordPEAccrualParams> {
  if (!input.bodyBound) return {};
  return mobileChatVerifiedFields({
    actionType: input.actionType,
    sessionFingerprintHash: input.sessionFingerprintHash,
    surface: input.surface,
  });
}
