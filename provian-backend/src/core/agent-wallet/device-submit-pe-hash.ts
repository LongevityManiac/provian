/**
 * Shared device-submit PE hash.
 *
 * The `device_pe_submit` writer (`routes/devices.ts`) and the canonical agent
 * PE-chain reader (`canonical-agent-pe-chain.ts`) must agree BYTE-FOR-BYTE on how
 * a device-submitted PE hashes, or the reader cannot verify a device PE it now has
 * to admit as a unified-chain member (put device PEs on `pe_chain_tips/{agent_id}`).
 *
 * This module is the SINGLE source of that hash. The writer computes it here; the
 * reader re-derives it here from the stored fields and compares to the stored
 * `hash`. Keeping one implementation is the point — a second copy is exactly the
 * reader/writer drift that would silently reject every real device PE (pitfall:
 * "Don't change tier mapping without updating both sides of the canonicalization").
 *
 * The preimage is the 15-field content object the writer's `buildPEContent`
 * produces — NOT the full stored doc (which additionally carries hash, user_id,
 * policy_action_type, integration_source, counterparty_*, session_lineage,
 * self_referencing, trust_level_at_creation, created_at, durability — none of
 * which are hashed, matching the writer). `stableStringify` sorts keys, so field
 * declaration order here is irrelevant to the digest.
 */

import crypto from 'crypto';
import stableStringify from 'json-stable-stringify';

/** The exact hashed content of a `device_pe_submit` PE (writer `buildPEContent`). */
export interface DeviceSubmitPeContent {
  readonly id: unknown;
  readonly wallet_id: unknown;
  readonly action_type: unknown;
  readonly actor_address: unknown;
  readonly timestamp: unknown;
  readonly prev_hash: unknown;
  readonly attestation_type: unknown;
  readonly description: unknown;
  readonly intent_text: unknown;
  readonly metadata: unknown;
  readonly compute: unknown;
  readonly geo: unknown;
  readonly execution_env: unknown;
  readonly cited_pe_ids: unknown;
  readonly parent_goal_pe_id: unknown;
  // Prompt 1 (forward-only): `undefined` for a device PE that did not observe
  // inputs (the writer omits the key) and for every device PE written before
  // this change. stableStringify drops undefined, so the preimage — and hash —
  // is byte-identical to the pre-change one whenever the key is absent; present
  // (`[]` or populated) only when the device actually recorded origins.
  readonly input_origins?: unknown;
  /** Trust Layer build §2.3 — forward-only like input_origins: omitted when absent. */
  readonly output_digests?: unknown;
}

/** The keys, in one place, so the reader can reconstruct the preimage precisely. */
export const DEVICE_SUBMIT_PE_CONTENT_KEYS = Object.freeze([
  'id', 'wallet_id', 'action_type', 'actor_address', 'timestamp', 'prev_hash',
  'attestation_type', 'description', 'intent_text', 'metadata', 'compute', 'geo',
  'execution_env', 'cited_pe_ids', 'parent_goal_pe_id', 'input_origins', 'output_digests',
] as const);

/**
 * sha256 of the stable-stringified content. Byte-identical to the writer's
 * `crypto.createHash('sha256').update(stableStringify(buildPEContent(prevHash)) || '')`.
 */
export function deviceSubmitPeHash(content: DeviceSubmitPeContent): string {
  return crypto.createHash('sha256')
    .update(stableStringify(content) || '')
    .digest('hex');
}

/** Pull EXACTLY the hashed content out of a stored device PE doc, in canonical key order. */
export function deviceSubmitPeContentFromStored(
  raw: Record<string, unknown>,
): DeviceSubmitPeContent {
  return {
    id: raw.id,
    wallet_id: raw.wallet_id,
    action_type: raw.action_type,
    actor_address: raw.actor_address,
    timestamp: raw.timestamp,
    prev_hash: raw.prev_hash,
    attestation_type: raw.attestation_type,
    description: raw.description,
    intent_text: raw.intent_text,
    metadata: raw.metadata,
    compute: raw.compute,
    geo: raw.geo,
    execution_env: raw.execution_env,
    cited_pe_ids: raw.cited_pe_ids,
    parent_goal_pe_id: raw.parent_goal_pe_id,
    // undefined for a legacy / absent-state device PE → dropped by
    // stableStringify → original hash reproduced. Present only when observed.
    input_origins: raw.input_origins,
    output_digests: raw.output_digests,
  };
}
