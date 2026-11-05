import {publicProjection,publicProjectionId} from './projection-privacy';
import { privateRetentionCollection } from '../provenance/private-retention';
/**
 * Provian Commons - PE Publication & Consent
 *
 * Handles PE Public Projections, mutual publication consent, and the
 * three-tier privacy model enforcement.
 *
 * What the relay stores for a publication (`commons_published_pes/{relay_pe_id}`): the PUBLIC
 * projection only — the PE's identity fields (id, hash, prev hash, action type, relay-assigned
 * tier, timestamp, publisher), the redactable fields the owner chose to show, the publication
 * metadata, and the hash-only on-chain half of the inclusion proof. Never the PE itself (PE
 * METER: the owner presents it and its inclusion proof at publish / consent time).
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import stableStringify from 'json-stable-stringify';
import { generatePE } from '../agent-bank/pe-utils';
import { ValidationError, NotFoundError, ForbiddenError } from '../agent-bank/errors';
import { proveMeterFactInclusion } from '../meter/meter-fact-proof';
import { relayPeIdOfPe } from '../meter/cited-act';
import { METER_ACT_KEYS_COLLECTION } from '../meter/meter-store';
import { peHashOf, PE_V2_SCHEMA, type PeV2 } from '../meter/meter-wire';
import { hashEnvelopeHashLeaf } from '../pvt/merkle';
import { canonicalPeAnchorReadContract, type PeAnchorVerifyContract } from '../presentation/anchor-contract';
import {
  COMMONS_SAFETY_LIMITS,
  COMMONS_COLLECTIONS,
  type CommonsDeps,
  type PEProjectionAnchorProof,
  type PEPublicProjection,
  type PublicationConsent,
  type RedactionConfig,
  type PublishPERequest,
  type RequestConsentRequest,
} from './types';

const L = COMMONS_SAFETY_LIMITS;

// ─── Tier 3 Enforcement ─────────────────────────────────────────────────────
// These fields must NEVER appear when they are actor-, profile-, credential-,
// or PE-sourced, regardless of auth level. Enforcement is the final pass on
// every ordinary Commons response payload via the router-level middleware in
// routes/commons.ts. The sole semantic key-name exception is the static,
// allowlisted `/institutions` projection: its `description` values are protocol
// copy defined in feed.ts, never user/PE data. See the Provian Manual (docs/PROVIAN_MANUAL.md).

export const TIER_3_FIELDS: ReadonlySet<string> = new Set([
  'private_key',
  'secret',
  'api_key',
  'session_token',
  'connection_token',
  'kill_switch',
  'policy_config',
  'autonomy_settings',
  'wallet_balance',
  'behavioral_baseline',
  'anomaly_score',
  'telemetry',
  'recovery_config',
  'credential',
  // PE description/intent_text is private by default.
  // Users who own their work may opt in to publishing via redaction_config.show_intent_text.
  // This prevents corporate commit messages from leaking through Commons projections.
  'description',
  'intent_text',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Recursively remove TIER_3_FIELDS from any object, array, or nested
 * structure. Returns a new value; does not mutate input. Non-object values
 * pass through unchanged.
 */
export function stripTier3Fields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(stripTier3Fields) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (TIER_3_FIELDS.has(key)) continue;
      out[key] = stripTier3Fields(v);
    }
    return out as unknown as T;
  }
  return value;
}

// ─── PE Publication ─────────────────────────────────────────────────────────
//
// PE METER : the relay keeps no PE, so publishing one means its OWNER supplies
// it — the PE body plus the two-hop inclusion proof the device fetched once its day was anchored.
// The relay proves it against Base (`proveMeterFactInclusion`, the pe_fact presentation's own
// proof), checks the anchored batch leaf names the publisher, and stores ONLY what a publication
// always stored publicly: the projection (identity fields + the fields the owner chose to show),
// plus the hash-only on-chain half of the proof so anyone can re-verify the anchor.

/** Test seam: the PEAnchor read contract presented proofs verify against (default: Base). */
export interface PublicationOptions {
  readonly anchorContract?: PeAnchorVerifyContract | null;
}

interface ProvenPublication {
  readonly relayPeId: string;
  readonly pe: PeV2;
  readonly peHash: string;
  readonly anchorProof: PEProjectionAnchorProof;
}

function plainRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Prove a presented PE and that `ownerIds` holds it. The cited `pe_id` may be the PE's own id or
 * the relay's id for it; the projection is keyed by the relay's id (globally unique — a device's
 * own pe_id is not).
 */
async function proveOwnedPE(
  body: { pe_id: string; pe?: unknown; inclusion?: unknown },
  ownerIds: ReadonlySet<string>,
  options: PublicationOptions,
  forbiddenMessage: string,
): Promise<ProvenPublication> {
  if (typeof body?.pe_id !== 'string' || body.pe_id.length === 0) throw new ValidationError('pe_id is required');
  if (body.pe === undefined || body.inclusion === undefined) {
    throw new ValidationError('The relay keeps no PE: supply the PE (pe) and its inclusion proof (inclusion)');
  }
  const pe = body.pe as PeV2 | null;
  if (pe === null || typeof pe !== 'object' || Array.isArray(pe) || pe.schema !== PE_V2_SCHEMA) {
    throw new ValidationError('pe must be a provian.pe.v2 Provenance Envelope');
  }
  const peHash = peHashOf(pe);
  const proven = await proveMeterFactInclusion({
    claim: { pe_id: pe.pe_id, envelope_hash: peHash },
    pe,
    inclusion: body.inclusion,
    anchorContract: options.anchorContract === undefined ? canonicalPeAnchorReadContract() : options.anchorContract,
  });
  if (proven.status === 'refused') {
    if (proven.http >= 500) throw new Error(`pe_proof_unavailable: ${proven.reason}`);
    throw new ValidationError(`PE proof refused: ${proven.reason}`);
  }
  if (!ownerIds.has(proven.actorId)) throw new ForbiddenError(forbiddenMessage);
  const relayPeId = relayPeIdOfPe(proven.pe, peHash);
  if (body.pe_id !== proven.pe.pe_id && body.pe_id !== relayPeId) {
    throw new ValidationError('pe_id does not name the presented PE');
  }
  const leaf = proven.proof.leaf as { batch_leaf?: unknown; leaf_value?: unknown };
  const anchor = proven.proof.anchor as { batch_id?: unknown; day?: unknown; chain_id?: unknown };
  return {
    relayPeId,
    pe: proven.pe,
    peHash,
    anchorProof: {
      kind: 'meter_day',
      batch_id: String(anchor.batch_id),
      day: String(anchor.day),
      batch_leaf: String(leaf.batch_leaf),
      leaf_value: String(leaf.leaf_value),
      merkle_proof: [...proven.proof.merkle_proof],
      chain_id: typeof anchor.chain_id === 'number' ? anchor.chain_id : 8453,
    },
  };
}

export async function publishPE(
  deps: CommonsDeps,
  walletId: string,
  agentId: string,
  actorAddress: string | null,
  body: PublishPERequest,
  options: PublicationOptions = {},
): Promise<PEPublicProjection> {
  // Rate limit
  const rl = await deps.cache.checkRateLimit(
    `rl:commons:publish:${walletId}`,
    L.RATE_LIMIT_PE_PUBLISH,
    60,
  );
  if (!rl.allowed) {
    throw new ValidationError(`Rate limit exceeded. Retry after ${rl.retryAfter}s`);
  }

  // Verify Commons profile exists
  const profileDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.PROFILES)
    .doc(walletId)
    .get();
  if (!profileDoc.exists) {
    throw new ForbiddenError('Must be registered on the Commons to publish PEs');
  }

  // Prove the presented PE and that the publisher owns it (the anchored batch leaf names its actor:
  // the caller's agent id or wallet id).
  const proven = await proveOwnedPE(body, new Set([walletId, agentId]), options, 'Only the PE owner can publish it');
  const peId = proven.relayPeId;
  const pe = proven.pe;
  const peMeta = plainRecord(pe.metadata);

  // Check for counterparty - requires mutual consent.
  const counterpartyAddress = nonEmptyString(pe.counterparty_address);
  if (counterpartyAddress && body.redaction_config.show_counterparty) {
    // Check if consent exists and is approved
    const consentSnap = await deps.db
      .collection(COMMONS_COLLECTIONS.PUBLICATION_CONSENTS)
      .where('pe_id', '==', peId)
      .where('requesting_wallet_id', '==', walletId)
      .limit(1)
      .get();

    if (consentSnap.empty) {
      throw new ValidationError(
        'Mutual consent required to show counterparty. Use POST /v1/pe/request-consent first.',
      );
    }

    const consent = consentSnap.docs[0].data() as PublicationConsent;
    const allApproved = Object.values(consent.consent_status).every(s => s === 'approved');
    if (!allApproved) {
      throw new ValidationError('Not all parties have approved publication');
    }
  }

  // Check if already published
  const existingPub = await deps.db
    .collection(COMMONS_COLLECTIONS.PUBLISHED_PES)
    .doc(peId)
    .get();
  if (existingPub.exists) {
    throw new ValidationError('This PE is already published');
  }

  // Build redacted fields list
  const redacted_fields: string[] = [];
  if (!body.redaction_config.show_intent_text) redacted_fields.push('intent_text');
  if (!body.redaction_config.show_counterparty) redacted_fields.push('counterparty_wallet_id');
  if (!body.redaction_config.show_amount) redacted_fields.push('amount');
  if (!body.redaction_config.show_currency) redacted_fields.push('currency');
  if (!body.redaction_config.show_artifact_hash) redacted_fields.push('artifact_hash');

  // Canonical hash: the proven PE's own hash (the one its anchored act record commits to).
  const canonicalHash = proven.peHash;
  // The attestation tier is relay-assigned at pricing, never the PE's own claim: read it from the
  // act key while it lives (31 days); otherwise the lowest tier (Unknown = the most restrictive).
  const keySnap = await privateRetentionCollection(deps.db, METER_ACT_KEYS_COLLECTION).doc(peId).get();
  const keyRow = keySnap.exists ? plainRecord((keySnap.data() as { row?: unknown }).row) : {};
  const attestationTier = nonEmptyString(keyRow.attestationDepth) ?? 'software';

  // Sign the projection
  const projectionContent = {
    pe_id: peId,
    pe_hash: canonicalHash,
    published_by: walletId,
    redacted_fields,
    institution: body.institution,
    timestamp: Date.now(),
  };
  const projection_signature = crypto
    .createHash('sha256')
    .update(stableStringify(projectionContent) || '')
    .digest('hex');

  const now = new Date().toISOString();
  const projection: PEPublicProjection = {
    pe_id: peId,
    pe_hash: canonicalHash,
    // Content fields come from the proven PE the owner presented.
    prev_envelope_hash: pe.prev_hash,
    action_type: pe.action_type,
    attestation_tier: attestationTier,
    timestamp: new Date(pe.timestamp).toISOString(),
    actor_wallet_id: walletId,

    // Redactable fields (from the proven PE; only what the owner chose to show)
    intent_text: body.redaction_config.show_intent_text
      ? (body.redaction_config.intent_text_summary
        || nonEmptyString(pe.intent_text) || nonEmptyString(peMeta.intent_text) || null)
      : null,
    counterparty_wallet_id: body.redaction_config.show_counterparty
      ? counterpartyAddress
      : null,
    amount: body.redaction_config.show_amount
      ? ((peMeta.amount as number | null | undefined) ?? null)
      : null,
    currency: body.redaction_config.show_currency
      ? ((peMeta.currency as string | null | undefined) ?? null)
      : null,
    artifact_hash: body.redaction_config.show_artifact_hash
      ? ((peMeta.artifact_hash as string | null | undefined) ?? null)
      : null,

    // Publication metadata
    published_at: now,
    published_by: walletId,
    consent_parties: [walletId],
    redacted_fields,
    institution: body.institution,

    // Verification
    projection_signature,
    original_pe_exists: true,
    chain_position_verified: true,
    anchor_proof: proven.anchorProof,
  };

  await deps.db
    .collection(COMMONS_COLLECTIONS.PUBLISHED_PES)
    .doc(peId)
    .set(projection);

  // Update profile published PE count
  const { FieldValue } = await import('firebase-admin/firestore');
  await deps.db
    .collection(COMMONS_COLLECTIONS.PROFILES)
    .doc(walletId)
    .update({ published_pe_count: FieldValue.increment(1), updated_at: Date.now() });

  // Generate PE for the publication action
  await generatePE(deps, {
    walletId,
    agentId,
    actorAddress,
    actionType: 'commons_pe_published',
    metadata: {
      published_pe_id: peId,
      institution: body.institution,
      redacted_fields,
    },
  });

  return publicProjection(projection);
}

async function projectionDocument(deps:CommonsDeps,id:string):Promise<FirebaseFirestore.DocumentSnapshot> {
 const collection=deps.db.collection(COMMONS_COLLECTIONS.PUBLISHED_PES);
 if(!id.startsWith('projection_'))return collection.doc(id).get();
 const docs=await collection.get();
 const found=docs.docs.find(doc=>publicProjectionId(doc.id)===id);
 return found??collection.doc(id).get();
}

// ─── Unpublish PE ───────────────────────────────────────────────────────────

export async function unpublishPE(
  deps: CommonsDeps,
  walletId: string,
  peId: string,
): Promise<void> {
  const pubDoc = await projectionDocument(deps,peId);
  if (!pubDoc.exists) {
    throw new NotFoundError('Published PE not found');
  }

  const pubData = pubDoc.data() as PEPublicProjection;
  if (pubData.published_by !== walletId) {
    throw new ForbiddenError('Only the publisher can unpublish');
  }

  await pubDoc.ref.delete();

  // Decrement count
  const { FieldValue } = await import('firebase-admin/firestore');
  await deps.db
    .collection(COMMONS_COLLECTIONS.PROFILES)
    .doc(walletId)
    .update({ published_pe_count: FieldValue.increment(-1), updated_at: Date.now() });
}

// ─── Request Consent ────────────────────────────────────────────────────────

export async function requestConsent(
  deps: CommonsDeps,
  walletId: string,
  body: RequestConsentRequest,
  options: PublicationOptions & {
    /** The caller's agent id (an agent's PEs are owned by its agent id, not its wallet id). */
    readonly agentId?: string;
  } = {},
): Promise<PublicationConsent> {
  // PE METER: the owner presents the PE + its inclusion proof; the counterparty is read from the
  // proven PE, and the consent is keyed by the relay's id for it (the id publishPE checks).
  const owners = new Set<string>([walletId]);
  if (options.agentId) owners.add(options.agentId);
  const proven = await proveOwnedPE(body, owners, options, 'Only the PE owner can request consent');
  const peId = proven.relayPeId;

  // Identify counterparties.
  const counterpartyAddress = nonEmptyString(proven.pe.counterparty_address);
  if (!counterpartyAddress) {
    throw new ValidationError('This PE has no counterparty - consent not needed');
  }

  // Find counterparty wallet ID. agent_wallets.address is stored LOWERCASE, but
  // counterparty_address can arrive checksummed (e.g. an on-chain source from
  // inbound-usdc-watcher) — match the lowercase form so a counterparty that IS
  // an agent wallet is actually found (a checksummed value silently missed it).
  // Harmless when counterparty_address is a non-address (userId/merchant): it
  // won't match agent_wallets.address either way.
  const counterpartySnap = await deps.db.collection('agent_wallets')
    .where('address', '==', counterpartyAddress.toLowerCase())
    .limit(1)
    .get();

  const consentingWalletIds: string[] = [];
  if (!counterpartySnap.empty) {
    consentingWalletIds.push(counterpartySnap.docs[0].id);
  }

  if (consentingWalletIds.length === 0) {
    throw new ValidationError('Counterparty not found in the network');
  }

  const now = Date.now();
  const consentId = `consent_${uuidv4()}`;
  const consent: PublicationConsent = {
    consent_id: consentId,
    pe_id: peId,
    requesting_wallet_id: walletId,
    consenting_wallet_ids: consentingWalletIds,
    consent_status: Object.fromEntries(
      consentingWalletIds.map(id => [id, 'pending' as const]),
    ),
    redaction_config: body.redaction_config,
    institution: body.institution,
    requested_at: now,
    expires_at: now + L.CONSENT_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  };

  await deps.db
    .collection(COMMONS_COLLECTIONS.PUBLICATION_CONSENTS)
    .doc(consentId)
    .set(consent);

  return consent;
}

// ─── Respond to Consent ─────────────────────────────────────────────────────

export async function respondToConsent(
  deps: CommonsDeps,
  walletId: string,
  consentId: string,
  decision: 'approved' | 'denied',
): Promise<PublicationConsent> {
  const consentDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.PUBLICATION_CONSENTS)
    .doc(consentId)
    .get();
  if (!consentDoc.exists) {
    throw new NotFoundError('Consent request not found');
  }

  const consent = consentDoc.data() as PublicationConsent;

  // Verify this wallet is a consenting party
  if (!consent.consenting_wallet_ids.includes(walletId)) {
    throw new ForbiddenError('Not a consenting party for this request');
  }

  // Check not expired
  if (Date.now() > consent.expires_at) {
    throw new ValidationError('Consent request has expired');
  }

  // Check not already responded
  if (consent.consent_status[walletId] !== 'pending') {
    throw new ValidationError('Already responded to this consent request');
  }

  consent.consent_status[walletId] = decision;

  const updates: Record<string, unknown> = {
    [`consent_status.${walletId}`]: decision,
  };

  // Check if all responded
  const allResponded = Object.values(consent.consent_status).every(s => s !== 'pending');
  if (allResponded) {
    updates.resolved_at = Date.now();
  }

  await deps.db
    .collection(COMMONS_COLLECTIONS.PUBLICATION_CONSENTS)
    .doc(consentId)
    .update(updates);

  const updated = await deps.db
    .collection(COMMONS_COLLECTIONS.PUBLICATION_CONSENTS)
    .doc(consentId)
    .get();
  return updated.data() as PublicationConsent;
}

// ─── Get Pending Consents ───────────────────────────────────────────────────

export async function getPendingConsents(
  deps: CommonsDeps,
  walletId: string,
): Promise<PublicationConsent[]> {
  const now = Date.now();
  const snap = await deps.db
    .collection(COMMONS_COLLECTIONS.PUBLICATION_CONSENTS)
    .where('consenting_wallet_ids', 'array-contains', walletId)
    .where('expires_at', '>', now)
    .get();

  return snap.docs
    .map(d => d.data() as PublicationConsent)
    .filter(c => c.consent_status[walletId] === 'pending');
}

// ─── Verify Projection ─────────────────────────────────────────────────────

export async function verifyProjection(
  deps: CommonsDeps,
  peId: string,
  options: PublicationOptions = {},
): Promise<{ projection: PEPublicProjection; verified: boolean }> {
  if(!/^projection_[a-f0-9]{64}$/.test(peId))throw new NotFoundError('Published PE projection not found');
  const pubDoc = await projectionDocument(deps,peId);
  if (!pubDoc.exists) {
    throw new NotFoundError('Published PE projection not found');
  }

  const projection = pubDoc.data() as PEPublicProjection;

  // PE METER: the relay keeps no PE to compare against. A projection is verified by the anchor its
  // publisher proved it into: the stored batch leaf hashes to the anchored leaf, and PEAnchor on
  // Base still verifies that leaf under the day's batch id. A projection with no anchor proof (one
  // published before the meter) is not verifiable — `false`, never assumed.
  return { projection:publicProjection(projection), verified: await anchorProofVerifies(projection.anchor_proof, options) };
}

async function anchorProofVerifies(
  proof: PEProjectionAnchorProof | undefined,
  options: PublicationOptions,
): Promise<boolean> {
  if (!proof || proof.kind !== 'meter_day' || !Array.isArray(proof.merkle_proof)) return false;
  let expected: string;
  try {
    expected = hashEnvelopeHashLeaf(proof.batch_leaf);
  } catch {
    return false;
  }
  if (expected.toLowerCase() !== String(proof.leaf_value).toLowerCase()) return false;
  const contract = options.anchorContract === undefined ? canonicalPeAnchorReadContract() : options.anchorContract;
  if (contract === null) return false;
  try {
    return await contract.verifyPE(proof.batch_id, proof.leaf_value, [...proof.merkle_proof]);
  } catch {
    return false;
  }
}
