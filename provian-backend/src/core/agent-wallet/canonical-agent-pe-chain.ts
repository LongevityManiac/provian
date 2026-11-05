import { privateRetentionCollection } from '../provenance/private-retention';
import crypto from 'crypto';
import stableStringify from 'json-stable-stringify';
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import { deviceSubmitPeHash, deviceSubmitPeContentFromStored } from './device-submit-pe-hash';
import { isValidStoredInputOrigins } from '../provenance/input-origins';
import { isValidStoredOutputDigests } from '../provenance/output-digests';
import { isWitnessClass } from '../pvt/policy/evidence-class';
import { IDENTITY_ACTS_COLLECTION, validateIdentityAct } from '../meter/identity-acts';
import { LEGACY_IDENTITY_PES_COLLECTION } from '../meter/meter-store';

export const CANONICAL_AGENT_PE_COLLECTION = 'provenance_envelopes' as const;
export const CANONICAL_AGENT_PE_TIP_COLLECTION = 'pe_chain_tips' as const;

const PE_ID = /^pe_[A-Za-z0-9_-]{1,240}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const CANONICAL_AGENT_STORED_PE_KEYS = Object.freeze([
  'id', 'wallet_id', 'agent_id', 'action_type', 'actor_address', 'timestamp',
  'prev_hash', 'attestation_type', 'metadata', 'compute', 'geo', 'execution_env',
  'cited_pe_ids', 'parent_goal_pe_id', 'hash', 'user_id', 'policy_action_type',
  'integration_source', 'counterparty_address', 'counterparty_type',
  'session_lineage', 'self_referencing', 'trust_level_at_creation', 'created_at',
  'durability', 'input_origins', 'output_digests', 'witness_class', 'witnessed_at_ms',
] as const);

// `input_origins` (Prompt 1) is a FORWARD-ONLY field written ONLY when the
// producer observed inputs (present-empty `[]` or present-populated); an absent
// PE omits the key entirely, so a legacy `agent_bank_generate_pe` doc — every PE
// written before this change — carries none. It is therefore OPTIONAL here, the
// same treatment `description`/`intent_text` get on the device shape below: a
// 25-key legacy doc and a 26-key origins-bearing doc both validate, and both
// re-derive their stored hash byte-identically through `canonicalAgentPeHash`
// (which reads `raw.input_origins`, undefined for a legacy doc → dropped by
// stableStringify → the original preimage). A required-key gate here would
// reject every pre-existing agent PE .
const CANONICAL_AGENT_OPTIONAL_STORED_KEYS: ReadonlySet<string> = new Set([
  'input_origins',
  // Trust Layer build (2026-09-16): `output_digests` is forward-only + hashed exactly like
  // `input_origins`; `witness_class` / `witnessed_at_ms` are relay-assigned and UNHASHED (the
  // hash re-derivation below never reads them), so a legacy doc without them validates unchanged.
  'output_digests', 'witness_class', 'witnessed_at_ms',
]);
const CANONICAL_AGENT_REQUIRED_STORED_KEYS: readonly string[] =
  CANONICAL_AGENT_STORED_PE_KEYS.filter(
    (k) => !CANONICAL_AGENT_OPTIONAL_STORED_KEYS.has(k),
  );

// the OTHER unified-chain member shape (routes/devices.ts buildSubmitStoredDoc).
// It is the canonical key set MINUS `agent_id` PLUS `description` + `intent_text`, and
// is hashed by deviceSubmitPeHash (which excludes agent_id, includes description/intent_text).
export const DEVICE_SUBMIT_STORED_PE_KEYS = Object.freeze([
  'id', 'wallet_id', 'action_type', 'actor_address', 'timestamp', 'prev_hash',
  'attestation_type', 'description', 'intent_text', 'metadata', 'compute', 'geo',
  'execution_env', 'cited_pe_ids', 'parent_goal_pe_id', 'hash', 'user_id',
  'policy_action_type', 'integration_source', 'counterparty_address',
  'counterparty_type', 'session_lineage', 'self_referencing',
  'trust_level_at_creation', 'created_at', 'durability', 'input_origins',
  'output_digests', 'witness_class', 'witnessed_at_ms',
] as const);

// `description`/`intent_text` are OPTIONAL in the STORED doc, not because the field
// is optional but because of how it is written. The device-submit writer
// (routes/devices.ts buildPEContent) sets `description` and `intent_text` from
// `req.body.description`; a PE description is optional (Article I), and the common
// observer case (compute_session / inference_session via reportAction) carries
// none — so both are `undefined`. Firestore runs with ignoreUndefinedProperties,
// which STRIPS undefined, so a description-less device PE is stored with 24 keys,
// not 26. It is hashed identically whether omitted or undefined (stableStringify
// drops both), so admitting the 24-key shape is NOT a hash weakening — the
// deviceSubmitPeHash re-derivation below is still the integrity anchor. A 26-key
// `exactKeys` gate here rejected exactly the description-less device PEs that
// exists to resolve, leaving those rows held forever.
const DEVICE_SUBMIT_OPTIONAL_STORED_KEYS: ReadonlySet<string> = new Set([
  'description', 'intent_text',
  // Trust Layer build (2026-09-16): see the canonical-shape note above.
  'output_digests', 'witness_class', 'witnessed_at_ms',
  // `input_origins` (Prompt 1) is written only when the device observed inputs;
  // an absent device PE omits it, as does every device PE written before this
  // change. Optional here for the same reason it is optional on the canonical
  // shape — the deviceSubmitPeHash re-derivation is the integrity anchor.
  'input_origins',
]);
const DEVICE_SUBMIT_REQUIRED_STORED_KEYS: readonly string[] =
  DEVICE_SUBMIT_STORED_PE_KEYS.filter(
    (k) => !DEVICE_SUBMIT_OPTIONAL_STORED_KEYS.has(k),
  );

interface SnapshotLike {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

interface TipSnapshotLike {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

/**
 * The fields EVERY unified-chain member carries, whatever its writer. Both the
 * canonical (agent_bank_generate_pe) and device (device_pe_submit) shapes extend
 * this. The (deprecated) chain-snapshot validator reads only these fields;
 * canonical-only fields (agent_id) are read through `validateIdentityPeSnapshots`,
 * which returns the canonical type.
 */
export interface AgentChainMemberPe extends Record<string, unknown> {
  id: string;
  wallet_id: string;
  user_id: string;
  action_type: string;
  actor_address: string;
  timestamp: number;
  created_at: number;
  prev_hash: string;
  hash: string;
  metadata: Record<string, unknown>;
  integration_source: string;
}

export interface CanonicalAgentStoredPe extends AgentChainMemberPe {
  agent_id: string;
}

/** device member: no agent_id; carries description/intent_text. */
export interface DeviceSubmitStoredPe extends AgentChainMemberPe {
  description: unknown;
  intent_text: unknown;
}

export interface ValidatedCanonicalAgentPeChain {
  /** Current tip first, genesis PE last. Mixed canonical + device members. */
  pes: readonly AgentChainMemberPe[];
  peIds: readonly string[];
  peHashes: readonly string[];
  byId: ReadonlyMap<string, AgentChainMemberPe>;
  tipHash: string;
}

export class CanonicalAgentPeChainIntegrityError extends Error {
  constructor(readonly reason: string) {
    super(`canonical_agent_pe_chain_integrity:${reason}`);
    this.name = 'CanonicalAgentPeChainIntegrityError';
  }
}

function fail(reason: string): never {
  throw new CanonicalAgentPeChainIntegrityError(reason);
}

function exactKeys(raw: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(raw).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length
    && actual.every((key, index) => key === canonical[index]);
}

/**
 * Like exactKeys, but a fixed set of keys MAY be absent (never extra). Every
 * `required` key must be present, and no key outside `required ∪ optional` may
 * appear. Used for the device shape, whose `description`/`intent_text` are stripped
 * from the stored doc when the caller supplies no description (see
 * DEVICE_SUBMIT_OPTIONAL_STORED_KEYS).
 */
function keysAllowingOptional(
  raw: Record<string, unknown>,
  required: readonly string[],
  optional: ReadonlySet<string>,
): boolean {
  const actual = new Set(Object.keys(raw));
  for (const key of actual) {
    if (!optional.has(key) && !required.includes(key)) return false; // no extras
  }
  for (const key of required) {
    if (!actual.has(key)) return false; // every required key present
  }
  return true;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function canonicalAgentPeHash(raw: Record<string, unknown>): string {
  const canonical = {
    id: raw.id,
    wallet_id: raw.wallet_id,
    agent_id: raw.agent_id,
    action_type: raw.action_type,
    actor_address: raw.actor_address,
    timestamp: raw.timestamp,
    prev_hash: raw.prev_hash,
    attestation_type: raw.attestation_type,
    metadata: raw.metadata,
    compute: raw.compute,
    geo: raw.geo,
    execution_env: raw.execution_env,
    cited_pe_ids: raw.cited_pe_ids,
    parent_goal_pe_id: raw.parent_goal_pe_id,
    // Prompt 1: forward-only. `undefined` for every legacy doc (key never
    // written) → stableStringify drops it → the original preimage and hash are
    // reproduced byte-identically. Present (`[]` or populated) only for a doc
    // that actually observed inputs.
    input_origins: raw.input_origins,
    // Trust Layer build §2.3: forward-only exactly like input_origins (absent → dropped → same hash).
    output_digests: raw.output_digests,
  };
  const serialized = stableStringify(canonical);
  if (typeof serialized !== 'string') return fail('pe_canonical_serialization');
  return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
}

export function validateCanonicalAgentStoredPe(params: {
  raw: Record<string, unknown> | undefined;
  documentId: string;
  agentId: string;
  walletId: string;
  maxTimestampMs?: number;
  allowedActorAddresses?: ReadonlySet<string>;
}): CanonicalAgentStoredPe {
  const { raw } = params;
  if (!raw || !keysAllowingOptional(
    raw, CANONICAL_AGENT_REQUIRED_STORED_KEYS, CANONICAL_AGENT_OPTIONAL_STORED_KEYS,
  )) fail('pe_shape');
  if (raw.id !== params.documentId
    || typeof raw.id !== 'string' || !PE_ID.test(raw.id)
    || raw.agent_id !== params.agentId
    || raw.user_id !== params.agentId
    || raw.wallet_id !== params.walletId
    || typeof raw.action_type !== 'string' || raw.action_type.length === 0
    || typeof raw.policy_action_type !== 'string' || raw.policy_action_type.length === 0
    || typeof raw.actor_address !== 'string' || !ADDRESS.test(raw.actor_address)
    || typeof raw.timestamp !== 'number' || !Number.isSafeInteger(raw.timestamp) || raw.timestamp < 0
    || raw.created_at !== raw.timestamp
    || (params.maxTimestampMs !== undefined && raw.timestamp > params.maxTimestampMs)
    || typeof raw.prev_hash !== 'string'
    || (raw.prev_hash !== '0x0000' && !SHA256.test(raw.prev_hash))
    || typeof raw.hash !== 'string' || !SHA256.test(raw.hash)
    || typeof raw.attestation_type !== 'string' || raw.attestation_type.length === 0
    || !plainRecord(raw.metadata)
    || raw.integration_source !== 'agent_bank_generate_pe'
    || (raw.durability !== 'provisional' && raw.durability !== 'final')
    || typeof raw.self_referencing !== 'boolean'
    || (raw.counterparty_address !== null && typeof raw.counterparty_address !== 'string')
    || (raw.counterparty_type !== null && typeof raw.counterparty_type !== 'string')
    || (raw.session_lineage !== null && !plainRecord(raw.session_lineage))
    || (raw.trust_level_at_creation !== null
      && typeof raw.trust_level_at_creation !== 'string')
    || (raw.compute !== null && !plainRecord(raw.compute))
    || (raw.geo !== null && !plainRecord(raw.geo))
    || (raw.execution_env !== null && !plainRecord(raw.execution_env))
    || (raw.cited_pe_ids !== null
      && (!Array.isArray(raw.cited_pe_ids)
        || raw.cited_pe_ids.some((value) => typeof value !== 'string')))
    || (raw.parent_goal_pe_id !== null && typeof raw.parent_goal_pe_id !== 'string')
    // Prompt 1: absent (undefined/null) OR an array of {hash, origin_identifier}
    // string pairs. The writer only ever stores normalizeInputOrigins() output,
    // so a real doc always passes; a hand-tampered shape fails closed here (and
    // the hash re-derivation below would catch tampering regardless).
    || !isValidStoredInputOrigins(raw.input_origins)
    || !isValidStoredOutputDigests(raw.output_digests)
    || (raw.witness_class !== undefined && !isWitnessClass(raw.witness_class))
    || (raw.witnessed_at_ms !== undefined
      && (typeof raw.witnessed_at_ms !== 'number' || !Number.isSafeInteger(raw.witnessed_at_ms)))) {
    fail('pe_fields');
  }
  if (params.allowedActorAddresses
    && !params.allowedActorAddresses.has(raw.actor_address.toLowerCase())) {
    fail('pe_actor_authority');
  }
  if (canonicalAgentPeHash(raw) !== raw.hash) fail('pe_hash');
  return raw as CanonicalAgentStoredPe;
}

/**
 * Validate a `device_pe_submit` unified-chain member. Same rigor as
 * the canonical validator, adapted to the device shape: NO agent_id (ownership binds
 * on user_id === agentId), the extra description/intent_text fields, and the hash
 * verified via the shared deviceSubmitPeHash (NOT canonicalAgentPeHash — a different
 * preimage). A hash/shape/binding failure here is a HARD fail: the caller only reaches
 * this after confirming user_id===agentId && wallet_id===walletId, so the doc claims to
 * be a member of THIS chain and a corrupt one must never be admitted.
 */
export function validateDeviceSubmitStoredPe(params: {
  raw: Record<string, unknown> | undefined;
  documentId: string;
  agentId: string;
  walletId: string;
  maxTimestampMs?: number;
  allowedActorAddresses?: ReadonlySet<string>;
}): DeviceSubmitStoredPe {
  const { raw } = params;
  if (!raw || !keysAllowingOptional(
    raw, DEVICE_SUBMIT_REQUIRED_STORED_KEYS, DEVICE_SUBMIT_OPTIONAL_STORED_KEYS,
  )) fail('device_pe_shape');
  if (raw.id !== params.documentId
    || typeof raw.id !== 'string' || !PE_ID.test(raw.id)
    || raw.user_id !== params.agentId
    || raw.wallet_id !== params.walletId
    || typeof raw.action_type !== 'string' || raw.action_type.length === 0
    || typeof raw.policy_action_type !== 'string' || raw.policy_action_type.length === 0
    || typeof raw.actor_address !== 'string' || !ADDRESS.test(raw.actor_address)
    || typeof raw.timestamp !== 'number' || !Number.isSafeInteger(raw.timestamp) || raw.timestamp < 0
    || raw.created_at !== raw.timestamp
    || (params.maxTimestampMs !== undefined && raw.timestamp > params.maxTimestampMs)
    || typeof raw.prev_hash !== 'string'
    || (raw.prev_hash !== '0x0000' && !SHA256.test(raw.prev_hash))
    || typeof raw.hash !== 'string' || !SHA256.test(raw.hash)
    || typeof raw.attestation_type !== 'string' || raw.attestation_type.length === 0
    // description/intent_text: string when present, or ABSENT (undefined) — the
    // writer omits them for a description-less PE and Firestore strips undefined.
    // null is tolerated defensively. The hash re-derivation below is the integrity
    // anchor regardless of which of these three states the stored field is in.
    || (raw.description !== null && raw.description !== undefined && typeof raw.description !== 'string')
    || (raw.intent_text !== null && raw.intent_text !== undefined && typeof raw.intent_text !== 'string')
    || !plainRecord(raw.metadata)
    || raw.integration_source !== 'device_pe_submit'
    || (raw.durability !== 'provisional' && raw.durability !== 'final')
    || typeof raw.self_referencing !== 'boolean'
    || (raw.counterparty_address !== null && typeof raw.counterparty_address !== 'string')
    || (raw.counterparty_type !== null && typeof raw.counterparty_type !== 'string')
    || (raw.session_lineage !== null && !plainRecord(raw.session_lineage))
    || (raw.trust_level_at_creation !== null
      && typeof raw.trust_level_at_creation !== 'string')
    || (raw.compute !== null && !plainRecord(raw.compute))
    || (raw.geo !== null && !plainRecord(raw.geo))
    || (raw.execution_env !== null && !plainRecord(raw.execution_env))
    || (raw.cited_pe_ids !== null
      && (!Array.isArray(raw.cited_pe_ids)
        || raw.cited_pe_ids.some((value) => typeof value !== 'string')))
    || (raw.parent_goal_pe_id !== null && typeof raw.parent_goal_pe_id !== 'string')
    // Prompt 1: same three-state acceptance as the canonical shape above.
    || !isValidStoredInputOrigins(raw.input_origins)
    || !isValidStoredOutputDigests(raw.output_digests)
    || (raw.witness_class !== undefined && !isWitnessClass(raw.witness_class))
    || (raw.witnessed_at_ms !== undefined
      && (typeof raw.witnessed_at_ms !== 'number' || !Number.isSafeInteger(raw.witnessed_at_ms)))) {
    fail('device_pe_fields');
  }
  if (params.allowedActorAddresses
    && !params.allowedActorAddresses.has(raw.actor_address.toLowerCase())) {
    fail('pe_actor_authority');
  }
  if (deviceSubmitPeHash(deviceSubmitPeContentFromStored(raw)) !== raw.hash) fail('device_pe_hash');
  return raw as DeviceSubmitStoredPe;
}

/**
 * @deprecated PE METER: pure validation of a COMPLETE chain the caller already holds (an owner's
 * own export, the legacy migration). No relay path may assemble an actor's whole chain to call it.
 */
export function validateCanonicalAgentPeChainSnapshots(params: {
  peSnapshots: readonly SnapshotLike[];
  tipSnapshot: TipSnapshotLike;
  agentId: string;
  walletId: string;
  expectedBirthPeId?: string;
  maxTimestampMs?: number;
  allowedActorAddresses?: ReadonlySet<string>;
}): ValidatedCanonicalAgentPeChain {
  if (!params.tipSnapshot.exists) fail('tip_missing');
  const tip = params.tipSnapshot.data();
  if (!tip || !plainRecord(tip)) fail('tip_shape');
  const tipKeys = Object.keys(tip).sort();
  const exactTip = ['hash', 'updated_at', 'user_id'].sort();
  const timestampTip = ['hash', 'last_pe_timestamp', 'updated_at', 'user_id'].sort();
  if ((tipKeys.join('\u0000') !== exactTip.join('\u0000')
      && tipKeys.join('\u0000') !== timestampTip.join('\u0000'))
    || typeof tip.hash !== 'string' || !SHA256.test(tip.hash)
    || tip.user_id !== params.agentId
    || !Number.isSafeInteger(tip.updated_at) || (tip.updated_at as number) < 0
    || (params.maxTimestampMs !== undefined && (tip.updated_at as number) > params.maxTimestampMs)
    || (tip.last_pe_timestamp !== undefined
      && (!Number.isSafeInteger(tip.last_pe_timestamp)
        || (tip.last_pe_timestamp as number) < 0))) {
    fail('tip_fields');
  }
  const byHash = new Map<string, AgentChainMemberPe>();
  for (const snapshot of params.peSnapshots) {
    if (!snapshot.exists) fail('pe_missing');
    const raw = snapshot.data();
    if (!raw) continue;
    // The unified agent chain has exactly TWO member shapes keyed on this
    // agent, and its readers pull them from TWO queries (agent_id and user_id):
    //   - agent_bank_generate_pe (generatePE): agent_id==user_id==agentId.
    //   - device_pe_submit (routes/devices.ts, agent-owned device): NO agent_id,
    //     user_id==agentId, wallet_id==walletId, hashed by deviceSubmitPeHash.
    // Everything else these queries surface is NOT a member and is SKIPPED, not
    // hard-failed:
    //   - relay_work_product / relay_authorization_decision / relay_request_decision /
    //     relay_agent_connect / relay_action carry an agent_id but chain under the
    //     HUMAN owner (the pre-existing 2026-08-19 skip);
    //   - the added user_id query can surface a coincidental-collision doc (a HUMAN
    //     device's device_pe_submit whose owner_user_id string equals this agentId,
    //     device_registration/revocation keyed on wallet_id, mobile/human/onramp/
    //     provisional) — bound out by user_id/wallet_id below.
    // Skipping a stray (rather than throwing) keeps the read robust; a GENUINE member
    // wrongly skipped still fails the prev_hash walk (predecessor_missing / tip_pe_missing)
    // below and never passes silently. A doc that BINDS to this chain but is corrupt is
    // hard-failed inside its validator.
    let pe: AgentChainMemberPe;
    if (raw.integration_source === 'agent_bank_generate_pe') {
      pe = validateCanonicalAgentStoredPe({
        raw,
        documentId: snapshot.id,
        agentId: params.agentId,
        walletId: params.walletId,
        maxTimestampMs: params.maxTimestampMs,
        allowedActorAddresses: params.allowedActorAddresses,
      });
    } else if (raw.integration_source === 'device_pe_submit'
      && raw.user_id === params.agentId
      && raw.wallet_id === params.walletId) {
      pe = validateDeviceSubmitStoredPe({
        raw,
        documentId: snapshot.id,
        agentId: params.agentId,
        walletId: params.walletId,
        maxTimestampMs: params.maxTimestampMs,
        allowedActorAddresses: params.allowedActorAddresses,
      });
    } else {
      continue;
    }
    if (byHash.has(pe.hash)) fail('duplicate_hash');
    byHash.set(pe.hash, pe);
  }
  const currentTip = byHash.get(tip.hash as string);
  if (!currentTip) fail('tip_pe_missing');
  if ((tip.updated_at as number) < currentTip.timestamp
    || (tip.last_pe_timestamp !== undefined
      && tip.last_pe_timestamp !== currentTip.timestamp)) {
    fail('tip_binding');
  }
  const chain: AgentChainMemberPe[] = [];
  const seen = new Set<string>();
  let current: AgentChainMemberPe | undefined = currentTip;
  while (current) {
    if (seen.has(current.hash)) fail('cycle');
    seen.add(current.hash);
    chain.push(current);
    if (current.prev_hash === '0x0000') break;
    current = byHash.get(current.prev_hash);
    if (!current) fail('predecessor_missing');
  }
  if (params.expectedBirthPeId
    && chain[chain.length - 1]?.id !== params.expectedBirthPeId) {
    fail('birth_binding');
  }
  const byId = new Map(chain.map((pe) => [pe.id, pe]));
  return {
    pes: chain,
    peIds: chain.map((pe) => pe.id),
    peHashes: chain.map((pe) => pe.hash),
    byId,
    tipHash: tip.hash as string,
  };
}

// PE METER : `readCanonicalAgentPeChain` (a query of the agent's WHOLE chain
// out of `provenance_envelopes`) and `assertPeInCanonicalAgentChain` were deleted: the relay no
// longer stores an actor's PEs, and no read may grow with an actor's history. Validate the
// identity PE an identity record pins with `readIdentityPe` / `validateIdentityPeSnapshots` below.

// =============================================================================
// PE METER — point reads of identity PEs
// =============================================================================
//
// An identity record (registration, rotation history, beneficiary relationship, badge outbox,
// governance vote) names the PE it rests on by id (and, where it pinned one, by hash). Since the
// meter, that PE's record lives in `identity_acts_v1/{pe_id}` (written in the same transaction as
// the actor's chain-tip advance); a PE sealed BEFORE the meter is its envelope, moved verbatim by
// the legacy migration into `identity_pes_legacy_v1`. Exactly one point read per PE — never a query over
// the actor's chain — so no validation is proportional to an actor's history.
//
// Fail closed: an identity act that exists but does not validate is REFUSED (never "fall back" to
// a legacy envelope under the same id); a PE that is in neither store is missing.

const IDENTITY_ACT_DOC_KEYS = Object.freeze([
  'schema', 'pe_id', 'actor_id', 'wallet_id', 'policy_action_type', 'act', 'created_at_ms',
] as const);
const IDENTITY_ACT_RECORD_KEYS = Object.freeze([
  'pe_id', 'pe_hash', 'prev_hash', 'timestamp', 'action_type', 'pricing',
] as const);

export interface IdentityPeRefs {
  readonly identity: DocumentReference;
  readonly legacy: DocumentReference;
}

export function identityPeRefs(db: Firestore, peId: string): IdentityPeRefs {
  return {
    identity: privateRetentionCollection(db, IDENTITY_ACTS_COLLECTION).doc(peId),
    legacy: privateRetentionCollection(db, LEGACY_IDENTITY_PES_COLLECTION).doc(peId),
  };
}

interface ExistsSnapshot {
  readonly exists: boolean;
  data(): unknown;
}

export interface IdentityPeBinding {
  readonly peId: string;
  /**
   * The hash the identity record pinned. `null` only for a record that names its PE by id alone
   * (a governance vote): the PE must then be self-consistent (its hash re-derives), which is the
   * only binding such a record ever carried.
   */
  readonly peHash: string | null;
  readonly agentId: string;
  readonly walletId: string;
  readonly maxTimestampMs?: number;
  readonly allowedActorAddresses?: ReadonlySet<string>;
}

/** Validate one identity PE from its two point-read snapshots (identity act first). */
export function validateIdentityPeSnapshots(
  snapshots: { readonly identity: ExistsSnapshot; readonly legacy: ExistsSnapshot },
  binding: IdentityPeBinding,
): CanonicalAgentStoredPe {
  if (!PE_ID.test(binding.peId)
    || (binding.peHash !== null && !SHA256.test(binding.peHash))) {
    fail('identity_pe_binding');
  }
  let pe: CanonicalAgentStoredPe;
  if (snapshots.identity.exists) {
    const raw = snapshots.identity.data() as Record<string, unknown> | undefined;
    // Exact shape: the identity act's own hash covers only its PE, so a field smuggled onto the
    // document or its act record (outside the hashed PE) is refused here, as an envelope's
    // unknown field always was.
    if (!plainRecord(raw) || !exactKeys(raw, IDENTITY_ACT_DOC_KEYS)
      || !plainRecord(raw.act) || !exactKeys(raw.act, IDENTITY_ACT_RECORD_KEYS)) {
      fail('identity_act_invalid');
    }
    const recordedHash = binding.peHash
      ?? (plainRecord(raw) && plainRecord(raw.act) && typeof raw.act.pe_hash === 'string'
        ? raw.act.pe_hash
        : '');
    try {
      pe = validateIdentityAct({
        raw,
        peId: binding.peId,
        peHash: recordedHash,
        actorId: binding.agentId,
        walletId: binding.walletId,
        maxTimestampMs: binding.maxTimestampMs,
      });
    } catch {
      return fail('identity_act_invalid');
    }
    if (!ADDRESS.test(pe.actor_address)) fail('identity_act_invalid');
  } else if (snapshots.legacy.exists) {
    pe = validateCanonicalAgentStoredPe({
      raw: snapshots.legacy.data() as Record<string, unknown> | undefined,
      documentId: binding.peId,
      agentId: binding.agentId,
      walletId: binding.walletId,
      maxTimestampMs: binding.maxTimestampMs,
    });
    if (binding.peHash !== null && pe.hash !== binding.peHash) fail('source_not_in_chain');
  } else {
    return fail('identity_pe_missing');
  }
  if (binding.allowedActorAddresses
    && !binding.allowedActorAddresses.has(pe.actor_address.toLowerCase())) {
    fail('pe_actor_authority');
  }
  return pe;
}

/** Point-read one identity PE (identity act, else its pre-meter envelope) and validate it. */
export async function readIdentityPe(
  db: Firestore,
  binding: IdentityPeBinding,
  get: (ref: DocumentReference) => Promise<ExistsSnapshot> = (ref) => ref.get(),
): Promise<CanonicalAgentStoredPe> {
  if (!PE_ID.test(binding.peId)) fail('identity_pe_binding');
  const refs = identityPeRefs(db, binding.peId);
  const [identity, legacy] = await Promise.all([get(refs.identity), get(refs.legacy)]);
  return validateIdentityPeSnapshots({ identity, legacy }, binding);
}

/** True when a PE id is already recorded in either store (identity act or pre-meter envelope). */
export async function identityPeExists(
  db: Firestore,
  peId: string,
  get: (ref: DocumentReference) => Promise<ExistsSnapshot> = (ref) => ref.get(),
): Promise<boolean> {
  const refs = identityPeRefs(db, peId);
  const [identity, legacy] = await Promise.all([get(refs.identity), get(refs.legacy)]);
  return identity.exists || legacy.exists;
}
