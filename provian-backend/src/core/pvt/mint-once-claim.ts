import { FieldPath, Firestore as NativeFirestore } from 'firebase-admin/firestore';
import { rawPrivateFirestore, isPrivateFirestore, privateStorageId } from '../provenance/private-store';
import {privateRetentionCollection,PRIVATE_ID_COLLECTIONS,protectedRetentionId,PRIVATE_RETENTION_STATE_COLLECTION,PRIVATE_RETENTION_STATE_DOC} from '../provenance/private-retention';
/**
 * Exact, crash-safe mint-once and novelty claims.
 *
 * A prepared plan is read-only. Its canonical claim and the owning PE history
 * row are committed in one Firestore transaction by writePEHistory. If another
 * writer wins between preparation and commit, the transaction throws a stable
 * race error and recordPEAccrual recomputes the complete economic snapshot.
 */

import crypto from 'crypto';
import stableStringify from 'json-stable-stringify';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { readActRowInTransaction } from '../meter/act-row-store';
import { BatchOccurrences, batchOccurrencesFor, crossWitnessOccurrenceDigest } from '../meter/batch-occurrences';
import {
  SOLANA_CLAIM_INSTRUCTION_EVENT,
  SOLANA_CLAIM_SIGNATURE,
  SOLANA_CLAIM_SUBJECT,
} from '../external-address/solana-keys';

export const MINT_ONCE_CLAIM_SCHEMA_VERSION = 'pvt-mint-once-claim/v1' as const;
export const MINT_ONCE_EVIDENCE_SCHEMA_VERSION = 'pvt-mint-once-evidence/v1' as const;
export class ClosedCrossWitnessOccurrenceError extends Error {
  constructor() { super('cross_witness_occurrence_already_counted'); }
}

export type MintOnceClaimKind =
  | 'artifact'
  | 'commit'
  | 'x402'
  | 'occurrence'
  | 'financial_settlement'
  | 'device_occurrence'
  | 'completion';

const COLLECTION_BY_KIND: Readonly<Record<MintOnceClaimKind, string>> = Object.freeze({
  artifact: 'artifact_novelty_claims',
  commit: 'commit_mint_claims',
  x402: 'x402_tx_mint_claims',
  // one verified sovereign agent-work occurrence mints once. Keyed by
  // (earning agent address, occurrence_id) so an agent cannot replay the same
  // occurrence for a second mint; distinct agents may use the same occurrence
  // string (different work, different subject).
  occurrence: 'occurrence_mint_claims',
  // B11 (; closes the residual): one canonical on-chain financial
  // settlement mints once ACROSS SOURCES for the whole priced chain-financial
  // family (send / receive / swap / agent_* transfers) — keyed
  // (settling address, txHash), the exact x402 shape generalized. x402 keeps
  // its own kind/collection (claims already exist there); the two kinds can
  // never collide on one canonical event because classification produces one
  // action type per event and each type claims exactly one kind.
  financial_settlement: 'financial_settlement_mint_claims',
  // the HARD per-occurrence mint-once for BODY-BOUND device-witnessed
  // compute work (compute_session / inference_session / agent_tool_orchestration
  // / agent_api_orchestration). The exact parallel of the sovereign `occurrence`
  // kind for a device witness: keyed (economic actor, sha256(canonical event)),
  // so an identical body-bound replay collides and mints 0 (Build A used only
  // the SOFT per-UTC-day artifact-novelty claim, which floored at 0.3× and reset
  // daily — a replay minted again). Its own collection so a device replay can
  // never collide with a sovereign occurrence or a financial settlement, and a
  // binding violation is attributable to the right kind.
  device_occurrence: 'device_occurrence_mint_claims',
  // (completion earning): ONE job completion mints ONCE across its TWO
  // witnesses — the on-chain escrow release the completion watcher observes
  // (`escrow_completed` / `escrow_resolved` released to the recipient) and the
  // off-chain counterparty confirmation the pending-evidence resolver verifies
  // (the deliverer's `human_job_delivered` promoted on the poster's
  // `human_job_completed`). Keyed (beneficiary economic actor, canonical
  // completion id — `escrow:<escrow_id>` when the job carries an escrow, else
  // `human_job:<job_id>`; see `completion-claim.ts`), so both sources collide on
  // the same document whichever arrives first. Its own collection so a
  // completion can never collide with a commit / occurrence / financial claim
  // and a binding violation is attributable to the right kind.
  completion: 'completion_mint_claims',
});
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const TX_HASH = /^0x[a-f0-9]{64}$/;
// B11 : the LOG-GRANULAR canonical event identity —
// `chainId:txHash:logIndex`, the exact `canonicalLogIdentity` form.
// One transaction can carry several canonical events; keying a claim on the
// bare tx would collapse them (review defect 1), so the financial-settlement
// kind accepts this form as its primary event id. Lowercased by canonicalInput.
const CHAIN_LOG_EVENT = /^\d{1,10}:0x[a-f0-9]{64}:\d{1,6}$/;
// The sovereign occurrence id, LOWERCASED by canonicalInput (mirrors the SDK's
// OCCURRENCE_ID_RE charset). 8–200 chars, no newline (canonical-message safe).
const OCCURRENCE = /^[a-z0-9_.:@/=+\-]{8,200}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const COMMITMENT = /^sha256:[a-f0-9]{64}$/;
// the canonical completion id — EXACTLY one of the three forms
// `completion-claim.ts` derives, lowercased by canonicalInput. `escrow:` is the
// relay's escrow document id (`esc_<uuid>`), `human_job:` the Commons job id
// (`hjob_<uuid>`), and `escrow_onchain:` the chain-qualified bytes32 id for a
// release whose escrow the relay never recorded. Anything else is refused.
const COMPLETION_EVENT =
  /^(?:escrow:esc_[a-z0-9-]{1,120}|human_job:hjob_[a-z0-9-]{1,120}|escrow_onchain:\d{1,10}:0x[a-f0-9]{64})$/;

export interface MintOnceClaimDocument {
  readonly schema_version: typeof MINT_ONCE_CLAIM_SCHEMA_VERSION;
  readonly claim_id: string;
  readonly claim_kind: MintOnceClaimKind;
  readonly subject_id: string;
  readonly event_id: string;
  readonly scope_id: string | null;
  readonly owner_pe_id: string;
  readonly owner_user_id: string;
  readonly created_at_ms: number;
}

export interface MintOnceClaimEvidence {
  readonly schema_version: typeof MINT_ONCE_EVIDENCE_SCHEMA_VERSION;
  readonly relation: 'owner' | 'duplicate';
  readonly claim: MintOnceClaimDocument;
}

export interface PreparedMintOnceClaim {
  readonly claim_collection: string;
  readonly current_pe_id: string;
  readonly current_user_id: string;
  readonly evidence: MintOnceClaimEvidence;
  /**
   * present ONLY for a cross-witness commit TAKEOVER: a strictly-higher-
   * base-weight witness (the forge, base 3.0×) claiming an incumbent daemon's
   * (base 1.0×) not-yet-settled `(user, commit_sha)` slot. When set, `evidence`
   * carries the NEW owner claim (relation `owner`, `owner_pe_id` = the taker),
   * and this names the incumbent whose claim doc is OVERWRITTEN and whose
   * `pe_history.mint_status` is demoted `eligible → corroborated_duplicate`, all
   * in the one `writePEHistory` transaction (see `commit-takeover.ts`). The
   * generic `inspectPreparedMintOnceClaimInTransaction` treats an existing doc
   * with a different owner as a race and refuses; the takeover is the deliberate
   * exception and takes its OWN in-transaction path.
   */
  readonly commit_takeover?: {
    readonly incumbent_pe_id: string;
    readonly incumbent_claim: MintOnceClaimDocument;
  };
  /**
   * present ONLY for a cross-witness COMPLETION takeover: the on-chain
   * escrow release (the best-supported witness of a job's completion, the
   * completion watcher's verified `escrow_completed` / `escrow_resolved`)
   * claiming a slot the resolver-promoted off-chain confirmation witness
   * (`human_job_delivered`) currently owns. Same discipline as `commit_takeover`
   * the incumbent's claim doc is re-owned and its `mint_status` demoted in the
   * one `writePEHistory` transaction, refused if the incumbent has registered
   * for settlement (see `completion-takeover.ts`). The direction is FIXED:
   * on-chain over off-chain, never the reverse.
   */
  readonly completion_takeover?: {
    readonly incumbent_pe_id: string;
    readonly incumbent_claim: MintOnceClaimDocument;
  };
}

export interface MintOnceClaimTransactionDecision {
  readonly collection: string;
  readonly claimId: string;
  readonly physicalId?:string;
  readonly documentToCreate: MintOnceClaimDocument | null;
}

export class MintOnceClaimRaceError extends Error {
  constructor() {
    super('mint_once_claim_race');
    this.name = 'MintOnceClaimRaceError';
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length
    && actual.every((key, index) => key === canonical[index]);
}

function claimIdFor(
  kind: MintOnceClaimKind,
  subjectId: string,
  eventId: string,
  scopeId: string | null,
): string {
  const key = kind === 'artifact'
    ? `${subjectId}:${scopeId ?? ''}:${eventId}`
    : `${subjectId}:${eventId}`;
  return sha256(key);
}

function validateKindBinding(claim: MintOnceClaimDocument): void {
  if (claim.claim_kind === 'artifact') {
    if (claim.subject_id !== claim.owner_user_id
      || !SHA256.test(claim.event_id)
      || !DAY.test(claim.scope_id ?? '')) {
      throw new Error('mint_once_claim_artifact_binding_invalid');
    }
    return;
  }
  if (claim.scope_id !== null) throw new Error('mint_once_claim_scope_invalid');
  if (claim.claim_kind === 'commit') {
    if (claim.subject_id !== claim.owner_user_id || !GIT_COMMIT.test(claim.event_id)) {
      throw new Error('mint_once_claim_commit_binding_invalid');
    }
    return;
  }
  if (claim.claim_kind === 'occurrence') {
    // Subject is the earning agent ADDRESS (not owner_user_id, which is the
    // agent's economic-actor id) — the x402 shape, not the commit shape.
    if (!ADDRESS.test(claim.subject_id) || !OCCURRENCE.test(claim.event_id)) {
      throw new Error('mint_once_claim_occurrence_binding_invalid');
    }
    return;
  }
  if (claim.claim_kind === 'financial_settlement') {
    // B11: (settling address, canonical event). The PRIMARY event form is the
    // log-granular `chainId:txHash:logIndex` (two transfers in one tx are two
    // events — review defect 1); a bare txHash is also accepted for a
    // genuinely tx-granular producer. Named separately from x402 so a
    // violation is attributable to the right kind.
    // follow-up: or a Solana settlement — (`solana:<key hex>`,
    // `solana:<signature hex>:<instruction index>`), never mixed with an EVM form.
    const evm = ADDRESS.test(claim.subject_id)
      && (CHAIN_LOG_EVENT.test(claim.event_id) || TX_HASH.test(claim.event_id));
    const solana = SOLANA_CLAIM_SUBJECT.test(claim.subject_id)
      && SOLANA_CLAIM_INSTRUCTION_EVENT.test(claim.event_id);
    if (!evm && !solana) {
      throw new Error('mint_once_claim_financial_settlement_binding_invalid');
    }
    return;
  }
  if (claim.claim_kind === 'device_occurrence') {
    // (economic actor, sha256(canonical event)). Subject is the
    // owner_user_id — the COMMIT shape (one actor mints each canonical event
    // once), NOT the address shape — because the device body-binding proves
    // WHO observed the work and the actor is that owner. The event is the
    // sha256 of the canonical event id the device-witnessed overlay derives
    // (`${action_type}:${trace_id|session_lineage}`), so a replay of the exact
    // body-bound submission produces the identical claim id and records 0.
    if (claim.subject_id !== claim.owner_user_id || !SHA256.test(claim.event_id)) {
      throw new Error('mint_once_claim_device_occurrence_binding_invalid');
    }
    return;
  }
  if (claim.claim_kind === 'completion') {
    // (beneficiary economic actor, canonical completion id). The COMMIT
    // shape (subject is the owner_user_id): the deliverer's economic actor is
    // the same `agent_id`/user id whether the watcher (agent_wallets by the
    // recipient address) or the resolver (the sealed `human_job_delivered` row)
    // names it, so the two witnesses of one job collide on one document.
    if (claim.subject_id !== claim.owner_user_id || !COMPLETION_EVENT.test(claim.event_id)) {
      throw new Error('mint_once_claim_completion_binding_invalid');
    }
    return;
  }
  // x402: (payer address, settlement tx) — or, follow-up, a Solana payer and
  // settlement signature (`solana:<key hex>`, `solana:<signature hex>`), never mixed.
  const evmX402 = ADDRESS.test(claim.subject_id) && TX_HASH.test(claim.event_id);
  const solanaX402 = SOLANA_CLAIM_SUBJECT.test(claim.subject_id) && SOLANA_CLAIM_SIGNATURE.test(claim.event_id);
  if (!evmX402 && !solanaX402) {
    throw new Error('mint_once_claim_x402_binding_invalid');
  }
}

/**
 * The claim collection a kind lives in. Exported so a sibling module that must
 * name the collection (the takeover paths re-own a claim document in place)
 * reads THIS table rather than restating a literal — the redeclared-
 * literal shape, where a rename here would leave the takeover writing to a
 * collection nothing reads.
 */
export function mintOnceClaimCollectionFor(kind: MintOnceClaimKind): string {
  return COLLECTION_BY_KIND[kind];
}

/**
 * The document id a (kind, subject, event[, scope]) claim lands on, derived
 * EXACTLY as `prepareMintOnceClaim` derives it (`canonicalInput` normalization
 * the address-keyed kinds lowercase their subject, every event id is
 * lowercased — then `claimIdFor`). Exported so a reader that must locate a
 * claim WITHOUT preparing one (the pending-cache backfill's pre-promotion slot
 * inspection) binds to this single derivation rather than restating the hash
 * the redeclared-literal shape, where a change to the id scheme here
 * would leave the inspector reading a document nothing writes.
 */
export function mintOnceClaimDocId(
  kind: MintOnceClaimKind,
  subjectId: string,
  eventId: string,
  scopeId: string | null = null,
): string {
  const subject = kind === 'x402' || kind === 'occurrence' || kind === 'financial_settlement'
    ? subjectId.trim().toLowerCase()
    : subjectId.trim();
  return claimIdFor(kind, subject, eventId.trim().toLowerCase(), scopeId);
}

export function parseClaim(value: unknown, expectedId?: string): MintOnceClaimDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('mint_once_claim_invalid');
  }
  // PE meter (2026-10-03): a claim may carry its Firestore TTL timestamp (`expire_at`, occurrence
  // time + 31 days — the ruled 30-day key lifetime). It is storage metadata, never part of the
  // claim's identity, evidence or comparison, so it is stripped before anything reads the claim.
  const { expire_at: _ttl, ...raw } = value as Record<string, unknown>;
  if (!exactKeys(raw, [
    'schema_version', 'claim_id', 'claim_kind', 'subject_id', 'event_id',
    'scope_id', 'owner_pe_id', 'owner_user_id', 'created_at_ms',
  ])) {
    throw new Error('mint_once_claim_schema_mismatch');
  }
  const claim = raw as unknown as MintOnceClaimDocument;
  if (claim.schema_version !== MINT_ONCE_CLAIM_SCHEMA_VERSION
    || !Object.prototype.hasOwnProperty.call(COLLECTION_BY_KIND, claim.claim_kind)
    || typeof claim.subject_id !== 'string' || claim.subject_id.length === 0
    || typeof claim.event_id !== 'string' || claim.event_id.length === 0
    || (claim.scope_id !== null && typeof claim.scope_id !== 'string')
    || typeof claim.owner_pe_id !== 'string' || claim.owner_pe_id.length === 0
    || typeof claim.owner_user_id !== 'string' || claim.owner_user_id.length === 0
    || !Number.isSafeInteger(claim.created_at_ms) || claim.created_at_ms < 0
    || claim.claim_id !== claimIdFor(
      claim.claim_kind,
      claim.subject_id,
      claim.event_id,
      claim.scope_id,
    )
    || (expectedId !== undefined && claim.claim_id !== expectedId)) {
    throw new Error('mint_once_claim_binding_invalid');
  }
  validateKindBinding(claim);
  return claim;
}

function parseEvidence(value: unknown): MintOnceClaimEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('mint_once_evidence_invalid');
  }
  const raw = value as Record<string, unknown>;
  if (!exactKeys(raw, ['schema_version', 'relation', 'claim'])) {
    throw new Error('mint_once_evidence_schema_mismatch');
  }
  const evidence = raw as unknown as MintOnceClaimEvidence;
  const claim = parseClaim(evidence.claim);
  if (evidence.schema_version !== MINT_ONCE_EVIDENCE_SCHEMA_VERSION
    || !['owner', 'duplicate'].includes(evidence.relation)) {
    throw new Error('mint_once_evidence_invalid');
  }
  return { ...evidence, claim };
}

function evidenceOrder(a: MintOnceClaimEvidence, b: MintOnceClaimEvidence): number {
  return a.claim.claim_kind.localeCompare(b.claim.claim_kind);
}

export function canonicalMintOnceClaimEvidence(
  value: readonly MintOnceClaimEvidence[] | null | undefined,
): MintOnceClaimEvidence[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > 3) {
    throw new Error('mint_once_evidence_array_invalid');
  }
  const parsed = value.map(parseEvidence);
  const kinds = parsed.map((item) => item.claim.claim_kind);
  if (new Set(kinds).size !== kinds.length) {
    throw new Error('mint_once_evidence_duplicate_kind');
  }
  const canonical = [...parsed].sort(evidenceOrder);
  if (stableStringify(value) !== stableStringify(canonical)) {
    throw new Error('mint_once_evidence_order_invalid');
  }
  return canonical;
}

export function hashMintOnceClaimEvidence(
  evidence: readonly MintOnceClaimEvidence[],
): string | null {
  const canonical = canonicalMintOnceClaimEvidence(evidence);
  if (canonical.length === 0) return null;
  return `sha256:${sha256(stableStringify(canonical) ?? '')}`;
}

export function assertMintOnceClaimEvidence(params: {
  peId: string;
  userId: string;
  evidence: readonly MintOnceClaimEvidence[] | null | undefined;
  evidenceHash: string | null | undefined;
  exactDuplicate: boolean;
  uniqueArtifact: boolean;
  eligible: boolean;
  /**
   * : a single-lane act takes no claim document; its duplicate / novelty flags are
   * its first-sighting result inside its batch. When present, the act must carry NO claim
   * evidence and the sealed flags must equal these.
   */
  singleLaneSighting?: { readonly exactDuplicate: boolean; readonly uniqueArtifact: boolean };
}): MintOnceClaimEvidence[] {
  const evidence = canonicalMintOnceClaimEvidence(params.evidence);
  if (params.singleLaneSighting !== undefined) {
    if (evidence.length > 0) throw new Error('mint_once_single_lane_act_has_claim_evidence');
    if (params.evidenceHash !== null && params.evidenceHash !== undefined) {
      throw new Error('mint_once_evidence_commitment_mismatch');
    }
    if (params.exactDuplicate !== params.singleLaneSighting.exactDuplicate
      || params.uniqueArtifact !== params.singleLaneSighting.uniqueArtifact) {
      throw new Error('mint_once_evidence_economic_binding_mismatch');
    }
    if (params.eligible && params.exactDuplicate) throw new Error('mint_once_evidence_duplicate_eligible');
    return evidence;
  }
  const expectedHash = hashMintOnceClaimEvidence(evidence);
  if ((expectedHash === null && params.evidenceHash !== null && params.evidenceHash !== undefined)
    || (expectedHash !== null && (!COMMITMENT.test(params.evidenceHash ?? '')
      || params.evidenceHash !== expectedHash))) {
    throw new Error('mint_once_evidence_commitment_mismatch');
  }
  for (const item of evidence) {
    const owns = item.claim.owner_pe_id === params.peId;
    if ((item.relation === 'owner') !== owns
      || (owns && item.claim.owner_user_id !== params.userId)) {
      throw new Error('mint_once_evidence_history_binding_mismatch');
    }
  }
  const duplicateEconomicEvent = evidence.some((item) =>
    item.claim.claim_kind !== 'artifact' && item.relation === 'duplicate');
  const artifact = evidence.find((item) => item.claim.claim_kind === 'artifact');
  if (params.exactDuplicate !== duplicateEconomicEvent
    || params.uniqueArtifact !== (artifact?.relation === 'owner')) {
    throw new Error('mint_once_evidence_economic_binding_mismatch');
  }
  if (params.eligible && evidence.some((item) =>
    item.claim.claim_kind !== 'artifact' && item.relation === 'duplicate')) {
    throw new Error('mint_once_evidence_duplicate_eligible');
  }
  return evidence;
}

function canonicalInput(input: {
  kind: MintOnceClaimKind;
  subjectId: string;
  eventId: string;
  scopeId?: string | null;
  peId: string;
  userId: string;
  nowMs: number;
}): Omit<MintOnceClaimDocument, 'schema_version' | 'claim_id'> {
  const subjectId = input.kind === 'x402' || input.kind === 'occurrence'
    || input.kind === 'financial_settlement'
    ? input.subjectId.trim().toLowerCase()
    : input.subjectId.trim();
  const eventId = input.eventId.trim().toLowerCase();
  const scopeId = input.scopeId ?? null;
  const candidate = {
    claim_kind: input.kind,
    subject_id: subjectId,
    event_id: eventId,
    scope_id: scopeId,
    owner_pe_id: input.peId,
    owner_user_id: input.userId,
    created_at_ms: input.nowMs,
  } as const;
  parseClaim({
    schema_version: MINT_ONCE_CLAIM_SCHEMA_VERSION,
    claim_id: claimIdFor(input.kind, subjectId, eventId, scopeId),
    ...candidate,
  });
  return candidate;
}

/** Only this batch's certified absent slots; native creates remain the atomic race guard. */
const batchAbsences = new WeakMap<Firestore, Set<string>>();
const absentPlans = new WeakSet<PreparedMintOnceClaim>();
export function isAbsentBatchClaim(plan: PreparedMintOnceClaim): boolean { return absentPlans.has(plan); }
export async function primeBatchCommitClaims(db: Firestore, ids: readonly string[]): Promise<void> {
  const raw = rawPrivateFirestore(db);
  if (!ids.length || !(raw instanceof NativeFirestore)) return;
  const privateStore = isPrivateFirestore(db);
  if (privateStore) {
    const state = (await raw.collection('private_retention_state_v1').doc('d554').get()).data();
    if (state?.opaque_ids_ready !== true || state?.opaque_records_complete !== true) return;
  }
  const collection = mintOnceClaimCollectionFor('commit'), absent = new Set<string>();
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30), physical = chunk.map(id => privateStore ? privateStorageId(collection, id) : id);
    const found = new Set((await raw.collection(collection).where(FieldPath.documentId(), 'in', physical).get()).docs.map(d => d.id));
    chunk.forEach((id, j) => { if (!found.has(physical[j])) absent.add(collection + '/' + id); });
  }
  batchAbsences.set(db, absent);
}
export function isSparseClaimCollision(db: Firestore, error: unknown): boolean {
  if ((error as { code?: unknown })?.code !== 6) return false;
  const text = String((error as { details?: unknown })?.details ?? '') + String((error as { message?: unknown })?.message ?? '');
  return [...(batchAbsences.get(db) ?? [])].some(path => {
    const at = path.indexOf('/'), collection = path.slice(0, at), id = path.slice(at + 1);
    return text.includes(collection + '/' + id) || text.includes(collection + '/' + privateStorageId(collection, id));
  });
}

export async function prepareMintOnceClaim(
  db: Firestore,
  input: {
    kind: MintOnceClaimKind;
    subjectId: string;
    eventId: string;
    scopeId?: string | null;
    peId: string;
    userId: string;
    nowMs: number;
  },
): Promise<PreparedMintOnceClaim> {
  const canonical = canonicalInput(input);
  const claimId = claimIdFor(
    canonical.claim_kind,
    canonical.subject_id,
    canonical.event_id,
    canonical.scope_id,
  );
  const collection = COLLECTION_BY_KIND[canonical.claim_kind];
  const retained=db.collection(collection);
  const absent = batchAbsences.get(db)?.has(collection + '/' + claimId) === true;
  const snap = absent ? null : await retained.doc(claimId).get();
  let claim: MintOnceClaimDocument;
  if (snap?.exists) {
    claim = parseClaim(snap.data(), claimId);
    if (claim.claim_kind !== canonical.claim_kind
      || claim.subject_id !== canonical.subject_id
      || claim.event_id !== canonical.event_id
      || claim.scope_id !== canonical.scope_id) {
      throw new Error('mint_once_claim_lookup_binding_mismatch');
    }
    if (claim.owner_pe_id === canonical.owner_pe_id
      && claim.owner_user_id !== canonical.owner_user_id) {
      throw new Error('mint_once_claim_owner_identity_mismatch');
    }
  } else {
    if (canonical.claim_kind !== 'artifact') {
      const occurrences = batchOccurrencesFor(db);
      const carried = occurrences !== undefined || rawPrivateFirestore(db) instanceof NativeFirestore || (await db.collection('meter_occurrence_carry_v1').doc('live').get()).get('complete') === true;
      if (carried && await (occurrences ?? new BatchOccurrences(db)).contains(canonical.subject_id, canonical.claim_kind === 'device_occurrence' ? canonical.event_id : crossWitnessOccurrenceDigest(collection, claimId))) {
        throw new ClosedCrossWitnessOccurrenceError();
      }
    }
    claim = parseClaim({
      schema_version: MINT_ONCE_CLAIM_SCHEMA_VERSION,
      claim_id: claimId,
      ...canonical,
    }, claimId);
  }
  const relation = claim.owner_pe_id === canonical.owner_pe_id ? 'owner' : 'duplicate';
  const plan = Object.freeze({
    claim_collection: collection,
    current_pe_id: canonical.owner_pe_id,
    current_user_id: canonical.owner_user_id,
    evidence: Object.freeze({
      schema_version: MINT_ONCE_EVIDENCE_SCHEMA_VERSION,
      relation,
      claim: Object.freeze({ ...claim }),
    }),
  });
  if (absent) absentPlans.add(plan);
  return plan;
}

function assertPreparedPlan(plan: PreparedMintOnceClaim): void {
  const evidence = parseEvidence(plan.evidence);
  if (plan.claim_collection !== COLLECTION_BY_KIND[evidence.claim.claim_kind]
    || plan.current_pe_id.length === 0
    || plan.current_user_id.length === 0
    || (evidence.relation === 'owner'
      && (evidence.claim.owner_pe_id !== plan.current_pe_id
        || evidence.claim.owner_user_id !== plan.current_user_id))
    || (evidence.relation === 'duplicate'
      && evidence.claim.owner_pe_id === plan.current_pe_id)) {
    throw new Error('mint_once_prepared_plan_invalid');
  }
}

export async function inspectPreparedMintOnceClaimInTransaction(
  db: Firestore,
  txn: Transaction,
  plan: PreparedMintOnceClaim,
): Promise<MintOnceClaimTransactionDecision> {
  assertPreparedPlan(plan);
  const expected = plan.evidence.claim;
  if (absentPlans.has(plan)) return { collection: plan.claim_collection, claimId: expected.claim_id, physicalId: expected.claim_id, documentToCreate: expected };
  const retained=db.collection(plan.claim_collection);
  const snap=await txn.get(retained.doc(expected.claim_id));
  const physicalId=expected.claim_id;
  if (!snap.exists) {
    if (plan.evidence.relation !== 'owner') throw new MintOnceClaimRaceError();
    return {
      collection: plan.claim_collection,
      claimId: expected.claim_id,
      physicalId,
      documentToCreate: expected,
    };
  }
  const current = parseClaim(snap.data(), expected.claim_id);
  if (stableStringify(current) !== stableStringify(expected)) {
    throw new MintOnceClaimRaceError();
  }
  if (plan.evidence.relation === 'duplicate') {
    // PE meter (2026-10-03): the winner's row lives in its 31-day act key, or (pre-meter) in
    // pe_history. Neither present means the winner's record was retired with the claim still
    // standing — the slot stays owned: this act is a duplicate and mints nothing. That is the
    // safe direction (never a second mint); a claim and its act key are created in ONE
    // transaction and expire together, so a live claim without its owner cannot be an orphan.
    const winnerHandle = await readActRowInTransaction(db, txn, current.owner_pe_id);
    if (winnerHandle === null) {
      return {
        collection: plan.claim_collection,
        claimId: expected.claim_id,
        documentToCreate: null,
      };
    }
    const winnerData = winnerHandle.row;
    if (winnerData.peId !== current.owner_pe_id
      || winnerData.userId !== current.owner_user_id) {
      throw new Error('mint_once_claim_owner_history_missing');
    }
    const winnerEvidence = canonicalMintOnceClaimEvidence(
      winnerData.mint_once_claim_evidence as MintOnceClaimEvidence[] | null | undefined,
    );
    const ownerEvidence = winnerEvidence.find((item) =>
      item.relation === 'owner'
      && stableStringify(item.claim) === stableStringify(current));
    if (!ownerEvidence
      || winnerData.mint_once_claim_evidence_hash !== hashMintOnceClaimEvidence(winnerEvidence)) {
      throw new Error('mint_once_claim_owner_history_binding_invalid');
    }
  }
  return {
    collection: plan.claim_collection,
    claimId: expected.claim_id,
    documentToCreate: null,
  };
}

export function applyMintOnceClaimDecision(
  db: Firestore,
  txn: Transaction,
  decision: MintOnceClaimTransactionDecision,
  /** PE meter: the claim's TTL (occurrence time + 31 days). Absent on the pre-meter path. */
  expireAt?: FirebaseFirestore.Timestamp,
): void {
  if (decision.documentToCreate !== null) {
    txn.create(
      db.collection(decision.collection).doc(decision.physicalId??decision.claimId),
      {
        ...(decision.documentToCreate as unknown as FirebaseFirestore.DocumentData),
        ...(expireAt !== undefined && (decision.documentToCreate.claim_kind === 'artifact' || batchOccurrencesFor(db) !== undefined) ? { expire_at: expireAt } : {}),
      },
    );
  }
}

export function utcDayScope(timestampMs: number): string {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new Error('mint_once_artifact_timestamp_invalid');
  }
  return new Date(timestampMs).toISOString().slice(0, 10);
}

/** A held owner keeps its exact ownership evidence until recovery completes. Only then retire
 * lookup metadata; the permanent fingerprint remains the duplicate guard. All reads precede writes. */
export async function prepareRetireRecoveredMintOnceMetadata(db: Firestore, txn: Transaction,
  peId: string, evidenceValue: unknown, expireAt: FirebaseFirestore.Timestamp): Promise<() => void> {
  const writes: FirebaseFirestore.DocumentReference[] = [];
  // Cleanup never decides recovery. An unrecognized older ownership record stays retained.
  let evidenceList: MintOnceClaimEvidence[];
  try {
    if (evidenceValue != null && !Array.isArray(evidenceValue)) return () => {};
    evidenceList = canonicalMintOnceClaimEvidence(evidenceValue == null ? [] : evidenceValue.map(parseEvidence));
  } catch { return () => {}; }
  if (!evidenceList.length) return () => {};
  const occurrences = new BatchOccurrences(db);
  for (const evidence of evidenceList) {
    if (evidence.relation !== 'owner' || evidence.claim.claim_kind === 'artifact' || evidence.claim.owner_pe_id !== peId) continue;
    const ref = db.collection(COLLECTION_BY_KIND[evidence.claim.claim_kind]).doc(evidence.claim.claim_id), snap = await txn.get(ref);
    if (!snap.exists) continue;
    let current: MintOnceClaimDocument;
    try { current = parseClaim(snap.data(), evidence.claim.claim_id); } catch { continue; }
    if (stableStringify(current) === stableStringify(evidence.claim)) {
      await occurrences.remember(current.subject_id, current.claim_kind === 'device_occurrence' ? current.event_id : crossWitnessOccurrenceDigest(COLLECTION_BY_KIND[current.claim_kind], current.claim_id));
      writes.push(ref);
    }
  }
  await occurrences.inspect(txn);
  return () => { occurrences.commit(txn); for (const ref of writes) txn.update(ref, { expire_at: expireAt }); };
}
