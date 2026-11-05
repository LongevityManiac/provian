/**
 * PE Type Catalog - Permissionless PE Type Registry
 *
 * PE types are permissionless. Any valid identifier is accepted. This module
 * auto-registers new types on first observation and tracks observation counts
 * for discovery. It does NOT gate acceptance - gating happens in the conformance
 * layer (which accepts any valid identifier).
 *
 * Catalog entry shape:
 *   {
 *     action_type: string,
 *     first_observed_at: number,
 *     first_observed_by_wallet: string,
 *     category: string,            // inferred from catalog or 'uncategorized'
 *     observation_count: number,   // incremented on each PE (batched)
 *     status: 'active',
 *     source: 'seed' | 'auto_registered' | 'namespace',
 *     description?: string,        // community-supplied documentation
 *     use_case?: string,           // community-supplied
 *     suggested_category?: string, // community-supplied
 *     suggested_tier?: number,     // community-supplied (0-5)
 *     upvotes?: number,            // community endorsement
 *     voters?: string[],           // wallet IDs that upvoted
 *     first_doc_at?: number,       // when documentation was first added
 *     first_doc_by_wallet?: string,
 *   }
 *
 * Write batching:
 *   Observation counts are batched in-memory and flushed periodically to avoid
 *   a Firestore write on every PE. The in-memory counter is a best-effort counter
 *   - on crash, a few thousand unflushed observations may be lost, which is
 *   acceptable for a discovery/analytics feature.
 */

import admin from 'firebase-admin';
import { relayDb } from '../../firestore-db';
import { CATALOG_ACTION_TYPES } from '../../routes/conformance';

// =============================================================================
// TYPES
// =============================================================================

export type PETypeSource = 'seed' | 'auto_registered' | 'namespace';
export type PETypeStatus = 'active' | 'deprecated';

export interface PETypeCatalogEntry {
  action_type: string;
  first_observed_at: number;
  first_observed_by_wallet: string;
  category: string;
  observation_count: number;
  status: PETypeStatus;
  source: PETypeSource;
  description?: string;
  use_case?: string;
  suggested_category?: string;
  suggested_tier?: number;
  upvotes?: number;
  voters?: string[];
  first_doc_at?: number;
  first_doc_by_wallet?: string;
}

// =============================================================================
// CATEGORY INFERENCE
// =============================================================================

/**
 * Map seed action types to categories. These mirror the category definitions
 * in pe-weight-framework.ts and are kept minimal; the framework is the source
 * of truth for category → tier mapping.
 */
const SEED_TYPE_CATEGORIES: Record<string, string> = {
  // financial
  send: 'financial', swap: 'financial', stake: 'financial', receive: 'financial',
  onramp: 'financial', approve: 'financial', x402_payment: 'financial',
  escrow_created: 'financial', escrow_funded: 'financial', escrow_completed: 'financial',
  escrow_disputed: 'financial', escrow_resolved: 'financial',
  promise_created: 'financial', promise_accepted: 'financial', promise_fulfilled: 'financial',
  promise_broken: 'financial', promise_disputed: 'financial',
  promise_funded: 'financial', promise_settled: 'financial', promise_defaulted: 'financial',
  pool_created: 'financial', pool_contributed: 'financial', pool_executed: 'financial',
  pool_refunded: 'financial',
  proxied_payment_requested: 'financial', proxied_payment_approved: 'financial',
  proxied_payment_executed: 'financial', proxied_payment_failed: 'financial',
  agent_authorization: 'financial',

  // compute
  coding_session: 'compute', code: 'compute', refactor: 'compute',
  test_run: 'compute', deployment: 'compute', research: 'compute',
  document: 'compute', agent_action: 'compute',

  // social
  agent_communicate: 'social', agent_public_post: 'social',
  social_post_approved: 'social', social_post_denied: 'social',
  commons_post_created: 'social', commons_post_replied: 'social',
  commons_vote_cast: 'social', commons_vouch_given: 'social',
  commons_vouch_received: 'social',

  // governance
  governance_proposal_created: 'governance', governance_vote_cast: 'governance',
  governance_proposal_executed: 'governance', governance_proposal_cancelled: 'governance',
  governance_premint_weight_set: 'governance',
  court_vote_cast: 'governance', court_verdict: 'governance',
  court_panel_assigned: 'governance', court_majority_bonus: 'governance',
  court_minority_vote: 'governance', court_escalated: 'governance',
  court_general_dispute_filed: 'governance', court_general_dispute_resolved: 'governance',
  court_evidence_submitted: 'governance',
  pvt_governance_proposed: 'governance', pvt_governance_voted: 'governance',

  // security
  device_register: 'security', device_revoke: 'security',
  credential_added: 'security', credential_updated: 'security',
  credential_frozen: 'security', credential_unfrozen: 'security',
  credential_deleted: 'security', credential_released: 'security',
  credential_injected: 'security', credential_release_expired: 'security',
  credential_release_used: 'security',
  emergency_stop: 'security', anomaly_detected: 'security',
  environment_attestation: 'security', environment_drift_detected: 'security',
  skill_install_requested: 'security',
  agent_session_started: 'security', agent_session_suspended: 'security',
  agent_session_revoked: 'security',
  policy_created: 'security', policy_updated: 'security',
  friction_escalation: 'security',

  // institutional
  agent_marketplace: 'institutional', agent_court: 'institutional',
  agent_governance: 'institutional', agent_labor_market: 'institutional',
  agent_compute_market: 'institutional', agent_reputation_system: 'institutional',
  agent_ecosystem_uncategorized: 'institutional',
  bond_posted: 'institutional', bond_renewed: 'institutional',
  bond_slashed: 'institutional', bond_withdrawn: 'institutional',
  bond_topped_up: 'institutional', bond_abandonment_processed: 'institutional',
  bond_claim_filed: 'institutional', bond_claim_resolved: 'institutional',
  insurance_claim_filed: 'institutional', insurance_claim_resolved: 'institutional',
  // Agent Insurance: reserved pre-launch to prevent name-squatting via
  // permissionless registration. ProvianAgentInsurance contract not yet built.
  agent_insurance_pool_created: 'institutional',
  agent_insurance_premium_paid: 'institutional',
  agent_insurance_payout_executed: 'institutional',
  agent_capabilities_registered: 'institutional',
  job_posted: 'institutional', job_applied: 'institutional',
  job_accepted: 'institutional', job_delivered: 'institutional',
  webhook_subscribed: 'institutional', pe_type_proposed: 'institutional',
  human_job_posted: 'institutional', human_job_applied: 'institutional',
  human_job_accepted: 'institutional', human_job_delivered: 'institutional',
  human_job_completed: 'institutional', human_job_rated: 'institutional',

  // infrastructure
  wallet_created: 'infrastructure', agent_wallet_created: 'infrastructure',
  agent_wallet_funded: 'infrastructure',
  agent_first_transaction: 'infrastructure', agent_sustained_activity: 'infrastructure',
  // Retired PVTv8 compatibility records for human-wallet funding/activity.
  // They remain valid PE types but are record-only and mint zero PVT in PVT9.
  wallet_funded: 'infrastructure',
  wallet_first_transaction: 'infrastructure', wallet_sustained_activity: 'infrastructure',
  external_address_proven: 'infrastructure',
  pvt_batch_minted: 'infrastructure', pvt_epoch_advanced: 'infrastructure',
  pvt_pe_anchored: 'infrastructure',
  pvt_fee_burned: 'infrastructure', pvt_reputation_staked: 'infrastructure',
  pvt_reputation_unstaked: 'infrastructure', pvt_reputation_slashed: 'infrastructure',
  pvt_burned_voluntary: 'infrastructure',
  badge_earned: 'infrastructure', agent_invite_sent: 'infrastructure',
  invite_accepted: 'infrastructure',


  // Witness 3 - relay-witnessed external service events (push-with-signature, Tier A custody).
  // Namespaced types are normally routed to 'social' by inferCategory; we override
  // these to land in their natural categories so the catalog/discovery surface is
  // accurate. Connector code does not exist yet.
  'service:github_commit': 'compute',
  'service:github_pr_merged': 'compute',
  'service:gitlab_push': 'compute',
  'service:gitlab_mr_merged': 'compute',
  'service:bitbucket_push': 'compute',
  'service:bitbucket_pr_merged': 'compute',
  service_install_created: 'infrastructure',
  service_install_revoked: 'infrastructure',
};

/**
 * Infer the category for a new or namespaced action type. Falls back to
 * 'uncategorized' for unknown flat types. Namespaced types (containing ':')
 * are routed to 'social' by default (agent chatter/actions).
 */
export function inferCategory(actionType: string): string {
  if (SEED_TYPE_CATEGORIES[actionType]) return SEED_TYPE_CATEGORIES[actionType];
  if (actionType.includes(':')) return 'social'; // namespaced agent types
  return 'uncategorized';
}

// =============================================================================
// IN-MEMORY COUNTER CACHE (write batching)
// =============================================================================

interface PendingObservation {
  count: number;
  lastWalletId: string;
  lastTimestamp: number;
}

const pendingCounts: Map<string, PendingObservation> = new Map();
const knownTypes: Set<string> = new Set();
let flushTimer: NodeJS.Timeout | null = null;
const FLUSH_INTERVAL_MS = 30_000; // flush every 30s

/**
 * Start the periodic flush timer. Safe to call multiple times (idempotent).
 */
export function startCatalogFlushTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushPendingObservations().catch((e) => {
      console.error('[PETypeCatalog] flush error:', e);
    });
  }, FLUSH_INTERVAL_MS);
  // Allow the process to exit even if the timer is still scheduled
  if (flushTimer.unref) flushTimer.unref();
}

/**
 * Flush in-memory counts to Firestore. Called periodically and at shutdown.
 */
export async function flushPendingObservations(): Promise<void> {
  if (pendingCounts.size === 0) return;
  const db = relayDb();
  const toFlush = new Map(pendingCounts);
  pendingCounts.clear();

  const ops: Promise<unknown>[] = [];
  for (const [actionType, pending] of toFlush.entries()) {
    const ref = db.collection('pe_type_catalog').doc(actionType);
    ops.push(ref.set(
      { observation_count: admin.firestore.FieldValue.increment(pending.count) },
      { merge: true },
    ).catch((e) => {
      console.error(`[PETypeCatalog] flush failed for ${actionType}:`, e);
    }));
  }
  await Promise.all(ops);
}

// =============================================================================
// RECORD OBSERVATION (called on every PE)
// =============================================================================

/**
 * Record an observation of an action type. If the type is new, create a catalog
 * entry. Otherwise, buffer an increment to observation_count for batched flush.
 *
 * This is fire-and-forget safe - errors are logged but do not throw.
 */
export async function recordActionTypeObservation(
  actionType: string,
  walletId: string,
): Promise<void> {
  try {
    if (!actionType || typeof actionType !== 'string') return;

    // Fast path: if we've already seen this type in this process, just buffer
    if (knownTypes.has(actionType)) {
      const existing = pendingCounts.get(actionType);
      if (existing) {
        existing.count += 1;
        existing.lastWalletId = walletId;
        existing.lastTimestamp = Date.now();
      } else {
        pendingCounts.set(actionType, {
          count: 1,
          lastWalletId: walletId,
          lastTimestamp: Date.now(),
        });
      }
      return;
    }

    // First observation in this process - check Firestore
    const db = relayDb();
    const ref = db.collection('pe_type_catalog').doc(actionType);
    const snap = await ref.get();

    if (snap.exists) {
      // Already registered - mark as known and buffer
      knownTypes.add(actionType);
      pendingCounts.set(actionType, {
        count: 1,
        lastWalletId: walletId,
        lastTimestamp: Date.now(),
      });
      return;
    }

    // New type - create catalog entry
    const isSeed = CATALOG_ACTION_TYPES.includes(actionType);
    const isNamespace = actionType.includes(':');
    const source: PETypeSource = isSeed ? 'seed' : isNamespace ? 'namespace' : 'auto_registered';
    const category = inferCategory(actionType);

    const entry: PETypeCatalogEntry = {
      action_type: actionType,
      first_observed_at: Date.now(),
      first_observed_by_wallet: walletId,
      category,
      observation_count: 1,
      status: 'active',
      source,
    };

    // Use create-only semantics so concurrent observers don't stomp on each other
    try {
      await ref.create(entry);
    } catch {
      // Concurrent create - the other writer won; increment our count instead
      await ref.set(
        { observation_count: admin.firestore.FieldValue.increment(1) },
        { merge: true },
      );
    }
    knownTypes.add(actionType);
  } catch (err) {
    // Fire-and-forget - never throw
    console.error('[PETypeCatalog] observation error:', err);
  }
}

// =============================================================================
// SEED CATALOG
// =============================================================================

/**
 * Seed the pe_type_catalog collection with all CATALOG_ACTION_TYPES entries.
 * Safe to call on every startup - uses create-only semantics and skips entries
 * that already exist.
 */
export async function seedCatalog(): Promise<{ seeded: number; skipped: number }> {
  const db = relayDb();
  let seeded = 0;
  let skipped = 0;

  const BATCH_SIZE = 400;
  for (let i = 0; i < CATALOG_ACTION_TYPES.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const slice = CATALOG_ACTION_TYPES.slice(i, i + BATCH_SIZE);
    const refs = slice.map((t) => db.collection('pe_type_catalog').doc(t));
    const snaps = await db.getAll(...refs);

    for (let j = 0; j < slice.length; j += 1) {
      const actionType = slice[j];
      const snap = snaps[j];
      if (snap.exists) {
        skipped += 1;
        continue;
      }
      const entry: PETypeCatalogEntry = {
        action_type: actionType,
        first_observed_at: Date.now(),
        first_observed_by_wallet: 'system:seed',
        category: inferCategory(actionType),
        observation_count: 0,
        status: 'active',
        source: 'seed',
      };
      batch.set(refs[j], entry);
      seeded += 1;
    }
    await batch.commit();
  }
  return { seeded, skipped };
}

// =============================================================================
// LOOKUP (used by weight framework for category resolution)
// =============================================================================

interface CachedCategory {
  category: string;
  expiresAt: number;
}
const categoryLookupCache: Map<string, CachedCategory> = new Map();
const CATEGORY_TTL_MS = 5 * 60_000; // 5 minutes

/**
 * Get the category for an action type. Returns 'uncategorized' if not in the
 * catalog (which shouldn't happen in practice since recordActionTypeObservation
 * runs on every PE, but is handled gracefully for calls from outside the
 * submission path).
 *
 * Cached for 5 minutes per type.
 */
export async function getCategoryForActionType(actionType: string): Promise<string> {
  const now = Date.now();
  const cached = categoryLookupCache.get(actionType);
  if (cached && cached.expiresAt > now) return cached.category;

  try {
    const db = relayDb();
    const snap = await db.collection('pe_type_catalog').doc(actionType).get();
    const category = snap.exists
      ? ((snap.data()?.category as string | undefined) ?? inferCategory(actionType))
      : inferCategory(actionType);
    categoryLookupCache.set(actionType, { category, expiresAt: now + CATEGORY_TTL_MS });
    return category;
  } catch {
    return inferCategory(actionType);
  }
}

/**
 * Invalidate the category lookup cache for one type (or all types if omitted).
 */
export function invalidateCategoryCache(actionType?: string): void {
  if (actionType) {
    categoryLookupCache.delete(actionType);
  } else {
    categoryLookupCache.clear();
  }
}
