/**
 * Agent Bank - PE Type Catalog Enrichment
 *
 * Catalog enrichment operations on the pe_type_catalog collection. PE type
 * creation itself is PERMISSIONLESS - any valid identifier is accepted at PE
 * submission time (see conformance.ts + pe-type-catalog.ts). This module
 * powers the discovery/documentation layer on top of that catalog.
 *
 * Operations:
 *   - enrichPECatalogType - attach description + use_case + suggested metadata
 *   - listPECatalogTypes - browse the catalog with filters
 *   - getPECatalogType - fetch a single entry
 *   - upvotePECatalogType - endorse an entry (signal, not a gate)
 *
 * HTTP routes accept human wallet auth, agent API-key auth, or Commons
 * session token (see routes/pe-proposals.ts). Legacy HTTP aliases
 * (/propose-type, /proposals, /proposals/:id/upvote) are preserved for
 * backward compatibility.
 *
 * Firestore collection: pe_type_catalog/
 * Legacy collection: pe_type_proposals/ - no longer written to
 */

import type {
  AgentBankDeps,
  ProposePETypeRequest,
} from './types';
import { ValidationError, NotFoundError } from './errors';

import { generatePE } from './pe-utils';
import {
  inferCategory,
  type PETypeCatalogEntry,
  type PETypeStatus,
} from '../provenance/pe-type-catalog';

// Identifier regex (matches conformance layer - alphanumeric + underscores or
// namespace format). More permissive than the old SNAKE_CASE_REGEX to align
// with the permissionless model.
const IDENTIFIER_REGEX = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const NAMESPACE_REGEX = /^[a-z][a-z0-9]*:[a-z][a-z0-9_]*$/;

function isValidTypeName(name: string): boolean {
  return IDENTIFIER_REGEX.test(name) || NAMESPACE_REGEX.test(name);
}

// =============================================================================
// ENRICH CATALOG TYPE (was: proposePEType)
// =============================================================================

/**
 * Add or update documentation on a PE type in the catalog. This is NOT an
 * approval gate - any type that has been submitted is already accepted. This
 * endpoint lets the community document types for discovery.
 *
 * If the type does not yet exist in the catalog, a new entry is created
 * (caller-declared rather than observation-driven - this is the "reserve a
 * namespace" flow).
 */
export async function enrichPECatalogType(
  deps: AgentBankDeps,
  walletId: string,
  agentId: string,
  actorAddress: string | null,
  body: ProposePETypeRequest,
): Promise<PETypeCatalogEntry> {
  if (!body.type_name || typeof body.type_name !== 'string') {
    throw new ValidationError('type_name is required');
  }
  if (!isValidTypeName(body.type_name)) {
    throw new ValidationError('type_name must be a valid identifier (alphanumeric + underscores) or namespace:action_name');
  }
  if (body.type_name.length > 64) {
    throw new ValidationError('type_name must be 64 characters or fewer');
  }
  if (!body.description || typeof body.description !== 'string' || body.description.length > 500) {
    throw new ValidationError('description is required (max 500 chars)');
  }
  if (!body.use_case || typeof body.use_case !== 'string' || body.use_case.length > 1000) {
    throw new ValidationError('use_case is required (max 1000 chars)');
  }

  // Optional: suggested_category + suggested_tier
  const suggestedCategory = body.suggested_category;
  const suggestedTier = body.suggested_tier;
  if (suggestedTier !== undefined) {
    if (typeof suggestedTier !== 'number' || suggestedTier < 0 || suggestedTier > 5) {
      throw new ValidationError('suggested_tier must be 0-5');
    }
  }

  const now = Date.now();
  const ref = deps.db.collection('pe_type_catalog').doc(body.type_name);
  const snap = await ref.get();

  const isNamespace = body.type_name.includes(':');
  const baseEntry: PETypeCatalogEntry = snap.exists
    ? (snap.data() as PETypeCatalogEntry)
    : {
        action_type: body.type_name,
        first_observed_at: now,
        first_observed_by_wallet: walletId,
        category: inferCategory(body.type_name),
        observation_count: 0,
        status: 'active',
        source: isNamespace ? 'namespace' : 'auto_registered',
      };

  // Merge documentation fields. If documentation was previously written by
  // someone else, update in place (community-editable wiki model).
  const updated: PETypeCatalogEntry = {
    ...baseEntry,
    description: body.description,
    use_case: body.use_case,
    suggested_category: suggestedCategory ?? baseEntry.suggested_category,
    suggested_tier: suggestedTier ?? baseEntry.suggested_tier,
    first_doc_at: baseEntry.first_doc_at ?? now,
    first_doc_by_wallet: baseEntry.first_doc_by_wallet ?? walletId,
  };

  await ref.set(updated, { merge: true });

  // Generate a PE for the enrichment action. Retains pe_type_proposed action
  // type for PE-chain compatibility.
  try {
    await generatePE(deps, {
      walletId,
      agentId,
      actorAddress: actorAddress ?? '',
      actionType: 'pe_type_proposed',
      metadata: {
        type_name: body.type_name,
        action: 'catalog_enrichment',
      },
    });
  } catch {
    // Best-effort - catalog enrichment should not fail if PE generation fails
  }

  return updated;
}

// =============================================================================
// LIST CATALOG TYPES
// =============================================================================

export async function listPECatalogTypes(
  deps: AgentBankDeps,
  filter?: { category?: string; source?: string; status?: string },
  limit: number = 50,
  offset: number = 0,
): Promise<PETypeCatalogEntry[]> {
  const colRef = deps.db.collection('pe_type_catalog');
  let query: FirebaseFirestore.Query = colRef.orderBy('observation_count', 'desc');

  if (filter?.category) query = query.where('category', '==', filter.category);
  if (filter?.source) query = query.where('source', '==', filter.source);
  if (filter?.status) query = query.where('status', '==', filter.status);

  query = query.limit(limit).offset(offset);
  const snap = await query.get();
  return snap.docs.map((doc) => doc.data() as PETypeCatalogEntry);
}

// =============================================================================
// GET CATALOG TYPE
// =============================================================================

export async function getPECatalogType(
  deps: AgentBankDeps,
  typeName: string,
): Promise<PETypeCatalogEntry> {
  const snap = await deps.db.collection('pe_type_catalog').doc(typeName).get();
  if (!snap.exists) {
    throw new NotFoundError('PE type not found in catalog');
  }
  return snap.data() as PETypeCatalogEntry;
}

// =============================================================================
// DOCUMENTED PE-TYPE PROPOSALS (Commons "PE Types" governance tab)
// =============================================================================

/**
 * Client view of a community-documented PE type, shaped for the Commons
 * "PE Types" tab. `proposal_id == action_type` (the catalog doc id) so the
 * client's upvote — POST /v1/pe/proposals/:id/upvote → upvotePECatalogType(name)
 * — lands on the right entry.
 */
export interface PETypeProposalView {
  proposal_id: string;
  action_type: string;
  description: string;
  use_case: string;
  upvotes: number;
  status: PETypeStatus;
  proposer_wallet_id: string;
  created_at: number;
}

/**
 * The "PE Types" tab surface: community-DOCUMENTED catalog entries only.
 *
 * Only enrichPECatalogType (the "document/reserve a type" flow) stamps
 * `first_doc_at`; seed + auto-registered observations never do. Ordering by
 * `first_doc_at` therefore returns documented proposals exclusively (Firestore
 * omits docs missing the orderBy field) — the catalog's 190+ undocumented
 * observed types stay out. Results are re-sorted by upvotes desc (then
 * most-recently-documented) so demand signal floats to the top.
 *
 * NOTE on the prior bug: the route used to read the dead `pe_type_proposals`
 * collection (migrated to `pe_type_catalog`, "no longer written to"), so the
 * tab was always empty even when reachable.
 */
export async function listDocumentedPETypeProposals(
  deps: AgentBankDeps,
  limit: number = 50,
): Promise<PETypeProposalView[]> {
  const snap = await deps.db
    .collection('pe_type_catalog')
    .orderBy('first_doc_at', 'desc')
    .limit(limit)
    .get();

  return snap.docs
    .map((d) => d.data() as PETypeCatalogEntry)
    // Documented-only. On real Firestore orderBy('first_doc_at') already excludes
    // entries missing the field; this explicit guard makes the intent self-evident
    // and keeps the function correct regardless of the query backend.
    .filter((e) => e.first_doc_at != null)
    .map((e) => ({
      proposal_id: e.action_type,
      action_type: e.action_type,
      description: e.description ?? '',
      use_case: e.use_case ?? '',
      upvotes: e.upvotes ?? 0,
      status: e.status,
      proposer_wallet_id: e.first_doc_by_wallet ?? e.first_observed_by_wallet,
      created_at: e.first_doc_at ?? e.first_observed_at,
    }))
    .sort((a, b) => b.upvotes - a.upvotes);
}

// =============================================================================
// UPVOTE CATALOG TYPE
// =============================================================================

/**
 * Upvote a catalog entry as a signal of community interest. Does not gate
 * anything - PE types are permissionless. One upvote per wallet.
 */
export async function upvotePECatalogType(
  deps: AgentBankDeps,
  walletId: string,
  typeName: string,
): Promise<PETypeCatalogEntry> {
  const ref = deps.db.collection('pe_type_catalog').doc(typeName);
  const { FieldValue } = await import('firebase-admin/firestore');

  const updated = await deps.db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) {
      throw new NotFoundError('PE type not found in catalog');
    }
    const data = snap.data() as PETypeCatalogEntry;
    const voters = data.voters ?? [];
    if (voters.includes(walletId)) {
      throw new ValidationError('Already upvoted this type');
    }
    txn.update(ref, {
      upvotes: FieldValue.increment(1),
      voters: FieldValue.arrayUnion(walletId),
    });
    return {
      ...data,
      upvotes: (data.upvotes ?? 0) + 1,
      voters: [...voters, walletId],
    };
  });

  return updated;
}

