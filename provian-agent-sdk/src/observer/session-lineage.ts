/**
 * the PRODUCER of `economicSessionLineageId`.
 *
 * Lineage is WITNESSED CAPTURE CONTEXT: the attested observer runtime session
 * under which the work evidence was captured. It is produced HERE, agent-side,
 * because only the agent's own runtime knows where one causal session begins and
 * ends. The relay never synthesizes it — it only ever verifies a claim against
 * the device it authenticated (`provian-backend/src/core/pvt/economic-session-lineage.ts`).
 *
 * ── THE ONE RULE THE MECHANICS SERVE ────────────────────────────────────────
 * All evidence captured within ONE attested observer runtime session shares ONE
 * lineage id. So the id is minted once, when the session opens, and every PE
 * that session emits carries it verbatim. It is NOT re-derived per PE, because
 * a per-PE derivation would make every act its own causal session and the fence
 * would be satisfied by construction rather than by evidence.
 *
 * ── WHY IT IS VERIFIABLE AND NOT MERELY DECLARED ────────────────────────────
 * The preimage commits to the **device credential the observer authenticates
 * with** the same device the relay independently resolves from device auth.
 * The relay recomputes with ITS OWN resolved device id and requires
 * byte-equality, so an id minted for another device, a random string, or an
 * account identifier all fail. This mirror must stay byte-identical to the
 * relay's derivation; `session-lineage.test.ts` on both sides pins the same
 * vector for exactly that reason.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * - NOT an eligibility claim. It removes ONE fence (`session_lineage_policy:
 * 'required'`). Evidence, canonical-event and device gates are untouched, and
 * an agent work type with no verified evidence still seals `pending_evidence`.
 * - NOT derived from account identity or a transport session. There is no code
 * path here that can see a `userId`, a wallet, or a session token.
 * - NOT retroactive. A PE sealed without lineage stays sealed without it.
 */

import { createHash, randomBytes } from 'crypto';

export const ECONOMIC_SESSION_LINEAGE_VERSION = 2 as const;
export const ECONOMIC_SESSION_LINEAGE_PREFIX = 'pesl2_' as const;

/** Hex characters of digest carried in the id. Must match the relay exactly. */
const DIGEST_HEX_LENGTH = 40;

/** The wire shape sent alongside every PE captured in this session. */
export interface EconomicSessionLineageClaim {
  readonly v: typeof ECONOMIC_SESSION_LINEAGE_VERSION;
  readonly session_started_at_ms: number;
  readonly session_nonce: string;
  /** 1-based, strictly monotonic per device; inside the digest. */
  readonly session_ordinal: number;
  readonly id: string;
}

/**
 * THE derivation — byte-identical to the relay's. Any change here is a protocol
 * change and must move both sides plus the shared vector in both suites.
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
  const digest = createHash('sha256').update(preimage, 'utf8').digest('hex');
  return `${ECONOMIC_SESSION_LINEAGE_PREFIX}${digest.slice(0, DIGEST_HEX_LENGTH)}`;
}

/**
 * Mint the claim for one attested runtime session. Called ONCE per session.
 *
 * Returns null when there is no attested device credential to bind to — an
 * unattested runtime has no witnessed capture context to assert, and asserting
 * one anyway is precisely the fabrication the rule forbids. Null means the PE
 * ships without lineage and the fence holds, which is the correct outcome and
 * the same one every PE has today.
 */
export function mintSessionLineageClaim(input: {
  readonly attestedDeviceId: string | null | undefined;
  readonly sessionStartedAtMs: number;
  /**
   * the DURABLY RESERVED ordinal for this session. Null/absent means no
   * ordinal could be reserved, and a claim without one cannot be admitted, so
   * the honest answer is no lineage at all rather than a guess at the sequence.
   */
  readonly sessionOrdinal?: number | null;
  /** Injectable for deterministic tests ONLY. Production uses `randomBytes`. */
  readonly nonce?: string;
}): EconomicSessionLineageClaim | null {
  const deviceId = (input.attestedDeviceId ?? '').trim();
  if (deviceId.length === 0) return null;
  if (!Number.isSafeInteger(input.sessionStartedAtMs) || input.sessionStartedAtMs <= 0) return null;
  const sessionOrdinal = input.sessionOrdinal;
  if (typeof sessionOrdinal !== 'number'
    || !Number.isSafeInteger(sessionOrdinal) || sessionOrdinal < 1) return null;

  const sessionNonce = input.nonce ?? randomBytes(16).toString('hex');
  if (!/^[0-9a-f]{32}$/.test(sessionNonce)) return null;

  return {
    v: ECONOMIC_SESSION_LINEAGE_VERSION,
    session_started_at_ms: input.sessionStartedAtMs,
    session_nonce: sessionNonce,
    session_ordinal: sessionOrdinal,
    id: deriveEconomicSessionLineageId({
      attestedDeviceId: deviceId,
      sessionStartedAtMs: input.sessionStartedAtMs,
      sessionNonce,
      sessionOrdinal,
    }),
  };
}
