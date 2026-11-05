/**
 * `economicSessionLineageId` WITNESSED CAPTURE CONTEXT, verified.
 *
 * ── THE RULE THIS IMPLEMENTS, VERBATIM ──────────────────────────────────────
 * Lineage is the attested session under which the work evidence was CAPTURED.
 * It is produced by the Observer SDK from that session's own attestation
 * material, sealed into the PE at record time, and bound into the evidence
 * digest. It is NEVER synthesized by the relay, and NEVER derived from account
 * identity (`userId`) or from a transport session. Absence means the fence
 * holds, exactly as before. All evidence captured within one attested observer
 * runtime session shares one lineage id.
 *
 * ── WHAT MAKES IT VERIFIABLE RATHER THAN CLIENT-CHOSEN ──────────────────────
 * The id is a DERIVATION, not a value the client picks. Its preimage commits to
 * the **attested device the relay itself resolved from device authentication** * never to a device id the client sent. The relay recomputes the digest from
 * that resolved identity plus the caller's declared session boundary, and
 * requires byte-equality. So:
 *
 * - a random string does not verify;
 * - an id minted for a DIFFERENT device does not verify;
 * - an id derived from `userId`, a wallet address, or a session token does not
 * verify, and is additionally refused by name (below) so the failure reads
 * as the forbidden construction rather than as a generic digest mismatch;
 * - the same observer runtime session yields the SAME id for every PE it
 * captures, because the nonce and start instant are fixed when the session
 * opens — which is precisely the "one causal session, one lineage" rule.
 *
 * ── THE LIMIT OF THAT GUARANTEE, STATED PLAINLY ─────────────────────
 * The only binding material is the device id, which the authenticated caller
 * already knows. So the relay CANNOT distinguish "one session, many PEs" from a
 * client that mints a fresh lineage per PE: the one-session-one-id property is
 * enforced by an honest SDK, not by this verifier. What the relay does
 * guarantee is narrower and still worth having — this id belongs to THIS
 * attested device and to no other, and it cannot be an account identifier
 * wearing a lineage costume.
 *
 * That gap is bounded today: lifting this fence moves an act to
 * `pending_evidence`, which pays 0, and no live path resolves
 * `pending_evidence` to `eligible`. It must be closed before one does —
 * otherwise per-PE minting would satisfy the fence for free. Closing it needs
 * material the relay can check independently (a device-signed session opening,
 * or a monotonic session counter bound to the device record), which is a
 * protocol addition, not a tightening of this function.
 *
 * The per-session nonce being client-generated is NOT the gap: the session IS
 * the agent's own runtime and no third party can attest to its boundaries.
 *
 * ── FAIL-CLOSED, AND NEVER SILENTLY ─────────────────────────────────────────
 * A malformed or unverifiable claim is REFUSED with a named reason, not quietly
 * dropped. A dropped claim is indistinguishable from absence, and absence means
 * the fence holds — so silently dropping would tell a caller their work was
 * lineage-bound when it was not. Absence itself (no claim at all) is not an
 * error: it returns `absent`, the caller passes null, and the fence holds.
 *
 * This module performs NO I/O and has no dependencies beyond `crypto`. It
 * cannot read a device, mint a lineage, or reach Firestore — the only thing it
 * can do is say yes or no to a claim, given an identity the caller already
 * authenticated.
 */

import crypto from 'crypto';

/** Derivation version. A future scheme gets a new prefix, never a new meaning. */
export const ECONOMIC_SESSION_LINEAGE_VERSION = 2 as const;
export const ECONOMIC_SESSION_LINEAGE_PREFIX = 'pesl2_' as const;

/** Hex characters of digest carried in the id. 40 hex = 160 bits. */
const DIGEST_HEX_LENGTH = 40;

const NONCE_PATTERN = /^[0-9a-f]{32}$/;
const ID_PATTERN = new RegExp(`^${ECONOMIC_SESSION_LINEAGE_PREFIX}[0-9a-f]{${DIGEST_HEX_LENGTH}}$`);

/**
 * The claim a client submits alongside the PE. `id` is redundant with the other
 * three by construction — which is the point: the relay recomputes it and the
 * two must agree byte for byte.
 */
export interface EconomicSessionLineageClaim {
  readonly v: number;
  readonly session_started_at_ms: number;
  readonly session_nonce: string;
  /**
   * 1-based, strictly monotonic per device. This is the field the relay
   * has independent state about: the registry below remembers the last ordinal
   * it admitted for this device, so a session cannot be replayed, forked, or
   * skipped ahead. It is in the DIGEST, so it cannot be edited after minting.
   */
  readonly session_ordinal: number;
  readonly id: string;
}

export type EconomicSessionLineageRejection =
  | 'absent'
  | 'malformed_claim'
  | 'unsupported_version'
  | 'invalid_nonce'
  | 'invalid_session_start'
  | 'invalid_session_ordinal'
  | 'invalid_id_format'
  | 'no_attested_device'
  | 'account_derived_id'
  | 'digest_mismatch';

export type EconomicSessionLineageVerdict =
  | { readonly ok: true; readonly lineageId: string }
  | { readonly ok: false; readonly reason: EconomicSessionLineageRejection };

/**
 * THE derivation. Pure, and the ONLY place an id is ever computed — the SDK
 * mirror in `provian-agent-sdk/src/observer/session-lineage.ts` reproduces this
 * exact preimage, and `economic-session-lineage.test.ts` pins the two together
 * with a shared vector so they cannot drift.
 *
 * `attestedDeviceId` is supplied by the RELAY from the authenticated device, or
 * by the SDK from the device credential it authenticates with. It is never read
 * from the request body — a client-supplied device id would make the whole
 * binding circular.
 */
export function deriveEconomicSessionLineageId(input: {
  readonly attestedDeviceId: string;
  readonly sessionStartedAtMs: number;
  readonly sessionNonce: string;
  readonly sessionOrdinal: number;
}): string {
  const preimage = JSON.stringify({
    v: ECONOMIC_SESSION_LINEAGE_VERSION,
    attested_device_id: input.attestedDeviceId,
    session_started_at_ms: input.sessionStartedAtMs,
    session_nonce: input.sessionNonce,
    session_ordinal: input.sessionOrdinal,
  });
  const digest = crypto.createHash('sha256').update(preimage, 'utf8').digest('hex');
  return `${ECONOMIC_SESSION_LINEAGE_PREFIX}${digest.slice(0, DIGEST_HEX_LENGTH)}`;
}

function isClaimShaped(value: unknown): value is EconomicSessionLineageClaim {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<EconomicSessionLineageClaim>;
  return typeof c.v === 'number'
    && typeof c.session_started_at_ms === 'number'
    && typeof c.session_nonce === 'string'
    && typeof c.session_ordinal === 'number'
    && typeof c.id === 'string';
}

/**
 * Identifiers that must NEVER be able to serve as a lineage id, checked by name
 * so the refusal says WHAT was wrong. The digest check would reject these
 * anyway; this exists because "account-derived id" is a specific prohibition in
 * the rule, and a guard that only fails generically teaches the next reader
 * nothing about why.
 *
 * The parameter is deliberately `readonly (string | null | undefined)[]` so a
 * caller can pass whatever identity it happens to hold without pre-filtering.
 */
export function isAccountDerivedLineageId(
  candidate: string,
  accountIdentifiers: readonly (string | null | undefined)[],
): boolean {
  const normalized = candidate.trim().toLowerCase();
  for (const identifier of accountIdentifiers) {
    if (identifier === null || identifier === undefined) continue;
    const id = identifier.trim();
    if (id.length === 0) continue;
    if (normalized === id.toLowerCase()) return true;
    // Also refuse the obvious "hash the account id and call it lineage" shape.
    const hashed = crypto.createHash('sha256').update(id, 'utf8').digest('hex');
    if (normalized === `${ECONOMIC_SESSION_LINEAGE_PREFIX}${hashed.slice(0, DIGEST_HEX_LENGTH)}`) {
      return true;
    }
    if (normalized === hashed) return true;
  }
  return false;
}

/**
 * Verify a submitted claim against an identity the caller ALREADY authenticated.
 *
 * `attestedDeviceId` null means the request carried no attested device — an
 * agent-session-authenticated call, for instance. That is not a lineage-capable
 * request, and the claim is refused rather than accepted on faith. The PE still
 * records; it simply stays behind the lineage fence, which is the correct and
 * unchanged outcome for a submission whose capture context nothing attested.
 *
 * The parameter type is widened to `unknown` on purpose so every violating case
 * is CONSTRUCTIBLE in a test — 's unreachable-branch shape is a guard a
 * literal type has quietly made unfailable.
 */
export function verifyEconomicSessionLineage(
  claim: unknown,
  attestedDeviceId: string | null,
  accountIdentifiers: readonly (string | null | undefined)[] = [],
): EconomicSessionLineageVerdict {
  if (claim === undefined || claim === null) return { ok: false, reason: 'absent' };
  // THE VERSION CHECK RUNS FIRST, and the order is the whole point.
  //
  // It used to run AFTER `isClaimShaped`, which requires `session_ordinal` — a
  // field v1 claims do not have. So a genuine stale `pesl1_` artifact, the exact
  // population `unsupported_version` was added for, answered `malformed_claim`;
  // the by-name failure fired only for a fully v2-shaped claim with an edited
  // `v`, which is a forgery, not a migration. The reason code told the one
  // caller who could act on it the wrong thing.
  if (typeof claim === 'object' && 'v' in (claim as Record<string, unknown>)
    && (claim as { v?: unknown }).v !== ECONOMIC_SESSION_LINEAGE_VERSION) {
    return { ok: false, reason: 'unsupported_version' };
  }
  if (!isClaimShaped(claim)) return { ok: false, reason: 'malformed_claim' };
  if (!NONCE_PATTERN.test(claim.session_nonce)) return { ok: false, reason: 'invalid_nonce' };
  if (!Number.isSafeInteger(claim.session_started_at_ms) || claim.session_started_at_ms <= 0) {
    return { ok: false, reason: 'invalid_session_start' };
  }
  if (!Number.isSafeInteger(claim.session_ordinal) || claim.session_ordinal < 1) {
    return { ok: false, reason: 'invalid_session_ordinal' };
  }
  if (!ID_PATTERN.test(claim.id)) return { ok: false, reason: 'invalid_id_format' };
  if (attestedDeviceId === null || attestedDeviceId.trim().length === 0) {
    return { ok: false, reason: 'no_attested_device' };
  }
  if (isAccountDerivedLineageId(claim.id, accountIdentifiers)) {
    return { ok: false, reason: 'account_derived_id' };
  }

  const expected = deriveEconomicSessionLineageId({
    attestedDeviceId,
    sessionStartedAtMs: claim.session_started_at_ms,
    sessionNonce: claim.session_nonce,
    sessionOrdinal: claim.session_ordinal,
  });
  // Constant-time compare: both operands are fixed-length by the format checks
  // above, so a length mismatch cannot reach here and leak through the throw.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(claim.id, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'digest_mismatch' };
  }
  return { ok: true, lineageId: claim.id };
}
