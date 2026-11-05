/**
 * PVT - Milestone Tracking
 *
 * Tracks 7 network milestones that inform PVT minting readiness.
 * Queries Firestore collections and caches results in Redis (30s TTL).
 */

import type { AgentBankDeps, PVTMilestonesDocument } from '../agent-bank/types';
import { ARMED_ENV, ARMING_TOKEN } from './wp4/operator-runtime';

/**
 * `minting_active` RECONCILED TO THE ARMED TRUTH (B10/ sweep).
 *
 * It used to be `!!(PVT_CONTRACT_ADDRESS && PVT_MINTER_KEY)` (two retired
 * PVTv8 variables — wrong in both directions), then a `false` constant meaning
 * "no automatic mint runtime is exposed to callers". The residual left
 * the RECONCILIATION of this surface with openapi's `x-pvt9-runtime` open.
 * resolved it in the only direction the record supports: the field's
 * NAME asks "is minting active", and the answer is YES — the PVT9 rail is
 * armed, the daily settlement runner mints, and the successor kernel settled
 * its first batch on 2026-08-10. Publishing `false` was exactly the
 * wrong-direction error the earlier docblock named ("asserted no minting while
 * PVT9 has minted on Base mainnet").
 *
 * STILL TRUE AND UNCHANGED BY THIS FLIP: no caller-triggered mint exists —
 * settlement is scheduler/operator-invoked, and nothing here mints because a
 * caller asked. This field states that the RAIL mints, not that you can make
 * it mint.
 *
 * DERIVED (defect 4), not a constant: the same `PVT9_SETTLEMENT_ARMED`
 * arming token the settlement rail itself checks, so this surface and
 * `GET /v1/openapi.json`'s `x-pvt9-runtime.mint_active` (which derives from
 * the identical expression) cannot disagree, and an environment where the
 * rail is NOT armed answers false instead of publishing a fabricated true.
 */
function pvt9MintRailActive(): boolean {
  // Read per call (not at module load) so the answer tracks the live env —
  // the same instant the settlement route itself would consult it.
  return process.env[ARMED_ENV] === ARMING_TOKEN;
}

// =============================================================================
// MILESTONE TARGETS
// =============================================================================

const MILESTONES = {
  agent_wallets: 10000,
  completed_escrows: 1000,
  settled_promises: 500,
  pool_executions: 100,
  court_verdicts: 50,
  unique_pe_action_types: 20,
  governance_votes: 100,
} as const;

const CACHE_KEY = 'pvt:milestones';
const CACHE_TTL = 30; // seconds

// =============================================================================
// CHECK MILESTONES
// =============================================================================

/**
 * Query all 7 milestones and return progress + mint_ready boolean.
 * Results are cached in Redis for 30 seconds.
 */
export async function checkAllMilestones(
  deps: AgentBankDeps,
): Promise<PVTMilestonesDocument> {
  // Check cache
  const cached = await deps.cache.get<PVTMilestonesDocument>(CACHE_KEY);
  if (cached) {
    return cached;
  }

  // Query all milestones in parallel
  const [
    agentWallets,
    completedEscrows,
    settledPromises,
    poolExecutions,
    courtVerdicts,
    uniqueActionTypes,
    governanceVotes,
  ] = await Promise.all([
    countCollection(deps, 'agent_wallets'),
    countByStatus(deps, 'escrows', 'status', 'completed'),
    countByStatus(deps, 'promises', 'status', 'settled'),
    countByStatus(deps, 'pools', 'status', 'executed'),
    countByStatus(deps, 'court_disputes', 'status', 'resolved'),
    countUniqueActionTypes(deps),
    countCollection(deps, 'governance_votes'),
  ]);

  const milestones: PVTMilestonesDocument = {
    agent_wallets: { current: agentWallets, target: MILESTONES.agent_wallets },
    completed_escrows: { current: completedEscrows, target: MILESTONES.completed_escrows },
    settled_promises: { current: settledPromises, target: MILESTONES.settled_promises },
    pool_executions: { current: poolExecutions, target: MILESTONES.pool_executions },
    court_verdicts: { current: courtVerdicts, target: MILESTONES.court_verdicts },
    unique_pe_action_types: { current: uniqueActionTypes, target: MILESTONES.unique_pe_action_types },
    governance_votes: { current: governanceVotes, target: MILESTONES.governance_votes },
    // Informational only - minting is not gated on milestone completion.
    mint_ready: false,
    minting_active: pvt9MintRailActive(),
    last_updated: Date.now(),
  };

  // Check if all milestones are met
  milestones.mint_ready =
    agentWallets >= MILESTONES.agent_wallets &&
    completedEscrows >= MILESTONES.completed_escrows &&
    settledPromises >= MILESTONES.settled_promises &&
    poolExecutions >= MILESTONES.pool_executions &&
    courtVerdicts >= MILESTONES.court_verdicts &&
    uniqueActionTypes >= MILESTONES.unique_pe_action_types &&
    governanceVotes >= MILESTONES.governance_votes;

  // Cache result
  await deps.cache.set(CACHE_KEY, milestones, CACHE_TTL);

  return milestones;
}

// =============================================================================
// QUERY HELPERS
// =============================================================================

async function countCollection(
  deps: AgentBankDeps,
  collectionName: string,
): Promise<number> {
  const snapshot = await deps.db.collection(collectionName).count().get();
  return snapshot.data().count;
}

async function countByStatus(
  deps: AgentBankDeps,
  collectionName: string,
  field: string,
  value: string,
): Promise<number> {
  const snapshot = await deps.db
    .collection(collectionName)
    .where(field, '==', value)
    .count()
    .get();
  return snapshot.data().count;
}

/**
 * How many distinct action types the network has ACTUALLY produced (M7).
 *
 * WHAT THIS USED TO DO, AND WHY IT WAS WRONG. It sampled the newest 5,000
 * `pe_history` rows and counted the distinct `actionType` values in them. That is
 * not a network metric, it is a metric about the last 5,000 PEs — so a single
 * busy emitter OWNS it. One agent producing 5,000 `coding_session` PEs in a
 * burst would push every other type out of the sample and collapse the milestone
 * to ~1, and the number would then swing with traffic rather than with the thing
 * it claims to measure. It also got more wrong as the network grew, which is the
 * opposite of what a milestone should do.
 *
 * WHAT IT DOES NOW. `pe_type_catalog` already holds exactly one document per
 * action type ever observed — that is the collection's whole job, and every PE
 * path registers into it (`pe-type-catalog.ts`). Counting it is EXACT, immune to
 * emitter mix, and one aggregate query instead of a 5,000-document read.
 *
 * `observation_count > 0` is the load-bearing filter: `seedCatalog()` writes
 * every known type up front with `observation_count: 0`, so an unfiltered count
 * would report the size of the SEED LIST — a large constant that never moves —
 * rather than what the network has done. The inequality is on a single field, so
 * Firestore's automatic single-field index serves it; no index deploy.
 *
 * KNOWN, BOUNDED STALENESS, stated rather than hidden: observations of an
 * already-catalogued type are buffered in memory and flushed periodically
 * (`flushPendingObservations`), so a SEEDED type's very first observation is not
 * reflected until the next flush. A newly-registered type is created with
 * `observation_count: 1` and counts immediately. Bounded by the flush interval,
 * and strictly better than a sampling bias that grows without bound.
 */
async function countUniqueActionTypes(deps: AgentBankDeps): Promise<number> {
  const cached = await deps.cache.get<number>('pvt:unique_action_types');
  if (cached !== null) {
    return cached;
  }

  const snapshot = await deps.db
    .collection('pe_type_catalog')
    .where('observation_count', '>', 0)
    .count()
    .get();

  const count = snapshot.data().count;
  await deps.cache.set('pvt:unique_action_types', count, CACHE_TTL);
  return count;
}
