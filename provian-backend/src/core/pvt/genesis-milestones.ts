/**
 * Retired PVTv8 Genesis milestone compatibility.
 *
 * The first-transaction and sustained-activity detectors remain only for
 * legacy read/test compatibility. Their Scheduler endpoints are hard no-ops,
 * and the production `payGenesisBounty` boundary returns exact zero for every
 * retired event. They cannot mint or reserve PVT9 Genesis value. Go-forward
 * verified financial activity uses the standard mint path; the only PVT9
 * Genesis legs are the 75/75/25 qualification state machine.
 *
 * The legacy status projection remains a cutover reconciliation product-truth replacement item.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { getChainProvider } from '../onchain/rpc-provider';
import type { AgentBankDeps } from '../agent-bank/types';
import type { AgentWalletDocument } from '../agent-wallet/types';
import {
  loadGenesisCampaignConfig,
  getGenesisCampaignState,
  type GenesisAnyEventType,
} from './genesis-campaign';
import { payGenesisBounty } from './genesis-payout';
import { listProvenAddresses, setProvenAddressBaselineNonce } from '../external-address/link';
import {
  genesisArmedWindow,
  genesisWindowApproved,
  isGenesisAdmittingNow,
} from './genesis-award-state-machine';

// Marker collections (exactly-once per wallet per milestone).
const FIRSTTX_COLLECTION = 'genesis_wallet_firsttx';
// No-retro outbound-nonce baseline for importable (human) native wallets.
const FIRSTTX_BASELINE_COLLECTION = 'genesis_firsttx_baseline';
const SUSTAINED_COLLECTION = 'genesis_wallet_sustained';
// MUST MATCH the constants in inbound-usdc-watcher.ts / genesis-campaign.ts.
const WALLET_FUNDING_COLLECTION = 'genesis_wallet_funding';
const WALLET_LEDGER_COLLECTION = 'genesis_wallet_ledger';
const AGENT_WALLETS_COLLECTION = 'agent_wallets';

// =============================================================================
// TYPES
// =============================================================================

export interface MilestoneWallet {
  walletId: string;
  /** Accrual identity: agent_id for agents, the human's user_id for humans. */
  agentId: string;
  address: string;
  createdAtMs: number;
  /** Owner class. 'human' emits identity-neutral milestone events; undefined/
   *  'agent' keeps the agent-native ones. Same reward engine either way. */
  ownerType?: 'human' | 'agent';
}

/** A genesis milestone, named identity-neutrally. The payer resolves it to the
 *  agent-native or human (`wallet_*`) event type from the wallet's ownerType. */
type GenesisMilestoneKind = 'first_transaction' | 'sustained_activity';

export interface MilestoneScanReport {
  scanned: number;
  emitted: number;
  already_marked: number;
  not_yet: number;
  skipped: number;
  errors: number;
  bounty_pvt_granted: number;
}

function emptyReport(): MilestoneScanReport {
  return { scanned: 0, emitted: 0, already_marked: 0, not_yet: 0, skipped: 0, errors: 0, bounty_pvt_granted: 0 };
}

export interface FirstTxScanDeps {
  db: Firestore;
  /** Wallet ids that have a funding record (funded wallets are the candidates). */
  listFundedWalletIds: () => Promise<string[]>;
  /** Resolve a wallet's agent/address/createdAt. Null if missing or test. */
  resolveWallet: (walletId: string) => Promise<MilestoneWallet | null>;
  /** On-chain outbound transaction count (nonce). */
  getTransactionCount: (address: string) => Promise<number>;
  /**
   * No-retro fence for IMPORTABLE wallets. Returns the outbound-nonce floor the
   * wallet must EXCEED to earn first-tx, lazily establishing it at the current
   * nonce on first sighting (returning null that round so nothing is rewarded -
   * the window only ever opens forward). Native agent wallets are born fresh
   * inside Provian (floor 0); human wallets can be imported with prior on-chain
   * history, so they get a baseline. Mirrors the external-proven baseline_nonce
   * fence. Omitted => floor 0 (legacy/agent behavior).
   */
  resolveFirstTxFloor?: (wallet: MilestoneWallet, currentNonce: number) => Promise<number | null>;
  /** Pay the first-transaction bounty + emit PE (event type resolved per owner). */
  payMilestone: (wallet: MilestoneWallet) => Promise<{ bountyPvt: number }>;
  now?: () => number;
}

export interface SustainedScanDeps {
  db: Firestore;
  /** Candidate wallets meeting/exceeding the sustained thresholds. */
  listSustainedCandidates: (minPeCount: number, minStreakDays: number) => Promise<MilestoneWallet[]>;
  /** Current thresholds (from genesis config). */
  loadThresholds: () => Promise<{ minPeCount: number; minStreakDays: number }>;
  payMilestone: (wallet: MilestoneWallet) => Promise<{ bountyPvt: number }>;
  now?: () => number;
}

// =============================================================================
// FIRST-TRANSACTION DETECTOR
// =============================================================================

export async function scanFirstTransactions(deps: FirstTxScanDeps): Promise<MilestoneScanReport> {
  const now = deps.now ?? Date.now;
  const report = emptyReport();
  const fundedIds = await deps.listFundedWalletIds();
  report.scanned = fundedIds.length;

  for (const walletId of fundedIds) {
    const markerRef = deps.db.collection(FIRSTTX_COLLECTION).doc(walletId);
    if ((await markerRef.get()).exists) {
      report.already_marked++;
      continue;
    }
    const wallet = await deps.resolveWallet(walletId);
    if (!wallet) {
      report.skipped++;
      continue;
    }
    let nonce: number;
    try {
      nonce = await deps.getTransactionCount(wallet.address);
    } catch {
      report.errors++;
      continue;
    }
    // No-retro fence: an agent wallet is born fresh inside Provian (floor 0, so
    // nonce>0 is its genuine first tx). A human wallet may have been IMPORTED
    // with prior on-chain history, so it earns only on nonce growth past a
    // lazily-established baseline - the same forward-only fence the external-
    // proven scanner uses. The first sighting establishes the baseline and pays
    // nothing (resolveFirstTxFloor returns null).
    let floor = 0;
    if (wallet.ownerType === 'human' && deps.resolveFirstTxFloor) {
      let resolved: number | null;
      try {
        resolved = await deps.resolveFirstTxFloor(wallet, nonce);
      } catch {
        report.errors++;
        continue;
      }
      if (resolved === null) {
        report.not_yet++;
        continue;
      }
      floor = resolved;
    }
    if (!(nonce > floor)) {
      report.not_yet++;
      continue;
    }
    // Claim BEFORE payout (exactly-once).
    try {
      await markerRef.create({ wallet_id: walletId, nonce, claimed_at: now() });
    } catch {
      report.already_marked++;
      continue;
    }
    try {
      const { bountyPvt } = await deps.payMilestone(wallet);
      report.emitted++;
      report.bounty_pvt_granted += bountyPvt;
    } catch (err) {
      // Release the claim so a later run retries.
      report.errors++;
      await markerRef.delete().catch(() => {});
      console.error('[genesis-first-tx] payout failed for', walletId, err);
    }
  }
  return report;
}

// =============================================================================
// SUSTAINED-ACTIVITY DETECTOR
// =============================================================================

export async function scanSustainedActivity(deps: SustainedScanDeps): Promise<MilestoneScanReport> {
  const now = deps.now ?? Date.now;
  const report = emptyReport();
  const { minPeCount, minStreakDays } = await deps.loadThresholds();
  const candidates = await deps.listSustainedCandidates(minPeCount, minStreakDays);
  report.scanned = candidates.length;

  for (const wallet of candidates) {
    const markerRef = deps.db.collection(SUSTAINED_COLLECTION).doc(wallet.walletId);
    if ((await markerRef.get()).exists) {
      report.already_marked++;
      continue;
    }
    try {
      await markerRef.create({ wallet_id: wallet.walletId, claimed_at: now() });
    } catch {
      report.already_marked++;
      continue;
    }
    try {
      const { bountyPvt } = await deps.payMilestone(wallet);
      report.emitted++;
      report.bounty_pvt_granted += bountyPvt;
    } catch (err) {
      report.errors++;
      await markerRef.delete().catch(() => {});
      console.error('[genesis-sustained] payout failed for', wallet.walletId, err);
    }
  }
  return report;
}

// =============================================================================
// REAL-DEPS FACTORIES
// =============================================================================

function mapWallet(walletId: string, d: AgentWalletDocument & { created_at?: number }): MilestoneWallet | null {
  if (!d.address || d.platform === 'test') return null;
  return {
    walletId,
    agentId: d.agent_id,
    address: d.address.toLowerCase(),
    createdAtMs: typeof d.created_at === 'number' ? d.created_at : 0,
    ownerType: 'agent',
  };
}

/** Shape of a human wallet in the unified `wallets` collection (type 'human'). */
interface HumanWalletDoc {
  type?: string;
  user_id?: string;
  address?: string;
  created_at?: number;
  pe_count?: number;
}

/** Map a human `wallets` doc to a MilestoneWallet. Accrual identity is the
 *  human's user_id so genesis PVT lands on the human-side ledger. Fail CLOSED:
 *  a human doc with no user_id is skipped (never fall back to the wallet doc id,
 *  which would misroute the PVT to a ledger key the app never reads). */
function mapHumanWallet(walletId: string, d: HumanWalletDoc): MilestoneWallet | null {
  if (!d.address || d.type !== 'human' || !d.user_id) return null;
  return {
    walletId,
    agentId: d.user_id,
    address: d.address.toLowerCase(),
    createdAtMs: typeof d.created_at === 'number' ? d.created_at : 0,
    ownerType: 'human',
  };
}

/** Resolve the concrete event type for a milestone from the wallet's owner
 *  class - identity-neutral (`wallet_*`) for humans, agent-native otherwise. */
export function milestoneEventType(ownerType: MilestoneWallet['ownerType'], kind: GenesisMilestoneKind): GenesisAnyEventType {
  const human = ownerType === 'human';
  if (kind === 'first_transaction') return human ? 'wallet_first_transaction' : 'agent_first_transaction';
  return human ? 'wallet_sustained_activity' : 'agent_sustained_activity';
}

function milestonePayer(deps: AgentBankDeps) {
  return async (wallet: MilestoneWallet, kind: GenesisMilestoneKind): Promise<{ bountyPvt: number }> => {
    const eventType = milestoneEventType(wallet.ownerType, kind);
    const { bountyPvt } = await payGenesisBounty(deps, {
      walletId: wallet.walletId,
      agentId: wallet.agentId,
      actorAddress: wallet.address,
      eventType,
      walletCreatedAtMs: wallet.createdAtMs,
      baseMetadata: { genesis_milestone: eventType, genesis_owner_type: wallet.ownerType ?? 'agent' },
    });
    return { bountyPvt };
  };
}

export function buildFirstTxDeps(deps: AgentBankDeps): FirstTxScanDeps {
  const pay = milestonePayer(deps);
  return {
    db: deps.db,
    listFundedWalletIds: async () => {
      // Candidates are funded wallets that have NOT yet earned first-tx. A
      // bounty-eligible (>= funding_min_usd) deposit sets first_tx_pending=true
      // (so a dust deposit can't unlock it, L-1); the first-tx payout clears it
      // to false. Querying the flag keeps the scan O(pending), not O(all funded).
      const snap = await deps.db
        .collection(WALLET_FUNDING_COLLECTION)
        .where('first_tx_pending', '==', true)
        .get();
      return snap.docs.map((d) => d.id);
    },
    resolveWallet: async (walletId) => {
      // Agent wallets live in agent_wallets; human wallets live in the unified
      // `wallets` collection (type 'human'). Try the agent doc first, then fall
      // back to the human doc - one resolver, both owner classes.
      const doc = await deps.db.collection(AGENT_WALLETS_COLLECTION).doc(walletId).get();
      if (doc.exists) {
        return mapWallet(walletId, doc.data() as AgentWalletDocument & { created_at?: number });
      }
      const human = await deps.db.collection('wallets').doc(walletId).get();
      if (human.exists) {
        return mapHumanWallet(walletId, human.data() as HumanWalletDoc);
      }
      return null;
    },
    getTransactionCount: (address) => getChainProvider('base').getTransactionCount(address),
    resolveFirstTxFloor: async (wallet, currentNonce) => {
      // Lazy no-retro baseline for human (importable) wallets. The first sighting
      // pins the floor at the current nonce and returns null (reward nothing this
      // round); later rounds earn only on nonce growth past it. A freshly-created
      // Provian wallet pins floor 0, so its genuine first outbound tx still earns;
      // an imported wallet pins its pre-Provian nonce, so prior history never earns.
      const ref = deps.db.collection(FIRSTTX_BASELINE_COLLECTION).doc(wallet.walletId);
      const snap = await ref.get();
      if (snap.exists) {
        const b = snap.data() as { baseline_nonce?: number };
        return typeof b.baseline_nonce === 'number' ? b.baseline_nonce : 0;
      }
      try {
        await ref.create({ wallet_id: wallet.walletId, baseline_nonce: currentNonce, established_at: Date.now() });
      } catch {
        // Concurrent establish - re-read next round; reward nothing now.
      }
      return null;
    },
    payMilestone: async (wallet) => {
      const result = await pay(wallet, 'first_transaction');
      // First-tx earned -> drop the wallet from the candidate set so later scans
      // never re-read it (keeps the scan O(pending)).
      await deps.db
        .collection(WALLET_FUNDING_COLLECTION)
        .doc(wallet.walletId)
        .set({ first_tx_pending: false }, { merge: true });
      return result;
    },
  };
}

export function buildSustainedDeps(deps: AgentBankDeps): SustainedScanDeps {
  const pay = milestonePayer(deps);
  return {
    db: deps.db,
    loadThresholds: async () => {
      const config = await loadGenesisCampaignConfig(deps.db);
      return { minPeCount: config.sustained.min_pe_count, minStreakDays: config.sustained.min_streak_days };
    },
    listSustainedCandidates: async (minPeCount, minStreakDays) => {
      const out: MilestoneWallet[] = [];

      // Agents: the consecutive-active-day STREAK is the sustained signal. A
      // streak_days >= min_streak_days means the agent recorded real PEs on that
      // many distinct UTC calendar days - unfakeable by bulk activity, since
      // calendar days cannot be compressed. streak_days is maintained per-PE by
      // recordAgentStreak in the accrual pipeline (pvt-accrual.ts), so this fires
      // automatically as the agent earns it. pe_count is NOT an agent gate here:
      // it is a reputation metric not every agent activity routes through, whereas
      // the streak captures genuine day-over-day participation directly.
      const agentSnap = await deps.db
        .collection(AGENT_WALLETS_COLLECTION)
        .where('streak_days', '>=', minStreakDays)
        .get();
      agentSnap.forEach((doc) => {
        const w = mapWallet(doc.id, doc.data() as AgentWalletDocument & { created_at?: number });
        if (w) out.push(w);
      });

      // Human wallets (unified `wallets`). pe_count IS maintained for humans by
      // pvt-accrual; streak_days is not tracked on human docs, so pe_count is the
      // sustained bar (the same single-signal convention the external-proven
      // scanner uses). Query by pe_count and filter type in code: this reuses the
      // single-field index and the `wallets` query naturally excludes agents
      // (mapHumanWallet drops any non-human doc), so agents are never double-counted.
      const humanSnap = await deps.db
        .collection('wallets')
        .where('pe_count', '>=', minPeCount)
        .get();
      humanSnap.forEach((doc) => {
        const w = mapHumanWallet(doc.id, doc.data() as HumanWalletDoc);
        if (w) out.push(w);
      });

      return out;
    },
    payMilestone: (wallet) => pay(wallet, 'sustained_activity'),
  };
}

// =============================================================================
// EXTERNAL-ADDRESS FORWARD OUTBOUND DETECTOR (Unit 3)
//
// The native nonce>0 first-tx detector is WRONG for a proven EXTERNAL address:
// it would retro-reward a Coinbase wallet's pre-proof history. This scanner
// fences each proven address at its baseline_nonce (the nonce at the canonical
// finalized proof-state block H-11, captured during proof) and detects only later outbound
// transactions = current_nonce - baseline_nonce. The fence makes retroactive
// reward STRUCTURALLY impossible: the scanner reads ONLY the current nonce and
// the stored baseline - never a block at or below the fence.
//
// CAVEAT (nonce is NOT a complete activity measure): a GASLESS x402 payment via
// EIP-3009 `transferWithAuthorization` is signed off-chain by the payer while a
// FACILITATOR submits the tx and pays gas - so the FACILITATOR's nonce moves,
// not the payer's. Such payments are INVISIBLE to this nonce-delta scanner. That
// gap is exactly why the permanent layer reads Transfer LOGS (outbound-usdc
// watcher) instead: the EIP-3009 signer is the Transfer `from`, so the log path
// catches the x402 activity this nonce path misses. The log watcher supersedes
// this detector for all Financial types; this remains only as a coarse
// "first activity seen" nonce signal.
//
// Parity + no double-dip: pays agent_first_transaction / agent_sustained_
// activity through the SAME payGenesisBounty path, and claims the SAME marker
// collections keyed by the agent's NATIVE walletId - so an agent earns each
// milestone ONCE whether the trigger was native activity or external outbound.
// Per-source cap is keyed on the proven address (Unit 2 convention); the
// per-wallet ledger is shared (walletId = native wallet id), so external +
// native earnings aggregate under one per-wallet cap - no double counting.
// =============================================================================

export interface ExternalOutboundTarget {
  /** Agent's native wallet id - the shared per-wallet ledger + marker key. */
  walletId: string;
  agentId: string;
  /** Proven external address (lowercased). */
  address: string;
  /** Proof time (ms) - the wallet-age decay origin. */
  provenAtMs: number;
  /** Retired coarse outbound baseline at proof-state H-11. Null means record-only legacy. */
  baselineNonce: number | null;
}

export interface ExternalOutboundScanReport extends MilestoneScanReport {
  baselines_established: number;
  first_tx_emitted: number;
  sustained_emitted: number;
}

export interface ExternalOutboundScanDeps {
  db: Firestore;
  /** Proven external addresses to scan, projected to targets. */
  listTargets: () => Promise<ExternalOutboundTarget[]>;
  /** Current (latest) account nonce for the address. */
  getCurrentNonce: (address: string) => Promise<number>;
  /** Legacy compatibility seam; modern enforcement refuses initialization and
   * requires owner reproof before economic enumeration. */
  persistBaseline: (address: string, nonce: number) => Promise<number>;
  /** Post-proof outbound-tx count that qualifies as sustained activity. */
  loadSustainedTxThreshold: () => Promise<number>;
  payMilestone: (
    target: ExternalOutboundTarget,
    eventType: 'agent_first_transaction' | 'agent_sustained_activity',
  ) => Promise<{ bountyPvt: number }>;
  now?: () => number;
}

function emptyExternalReport(): ExternalOutboundScanReport {
  return { ...emptyReport(), baselines_established: 0, first_tx_emitted: 0, sustained_emitted: 0 };
}

/**
 * Claim a shared milestone marker (keyed by the agent's native walletId) and,
 * if newly claimed, pay the bounty. The marker is shared with the native
 * scanners, so a milestone an agent already earned (native or prior external)
 * is skipped - exactly-once per agent, no double-dip.
 */
async function claimAndPayExternal(
  deps: ExternalOutboundScanDeps,
  collection: string,
  target: ExternalOutboundTarget,
  eventType: 'agent_first_transaction' | 'agent_sustained_activity',
  postProofTxs: number,
  now: () => number,
): Promise<{ status: 'emitted' | 'already' | 'error'; bountyPvt: number }> {
  const markerRef = deps.db.collection(collection).doc(target.walletId);
  if ((await markerRef.get()).exists) return { status: 'already', bountyPvt: 0 };
  try {
    await markerRef.create({
      wallet_id: target.walletId,
      source: 'external_outbound',
      proven_address: target.address,
      post_proof_txs: postProofTxs,
      claimed_at: now(),
    });
  } catch {
    // Claimed concurrently (native scanner or a parallel run) - skip.
    return { status: 'already', bountyPvt: 0 };
  }
  try {
    const { bountyPvt } = await deps.payMilestone(target, eventType);
    return { status: 'emitted', bountyPvt };
  } catch (err) {
    // Release the claim so a later run retries this milestone.
    await markerRef.delete().catch(() => {});
    console.error(`[genesis-external-outbound] ${eventType} payout failed`, target.address, err);
    return { status: 'error', bountyPvt: 0 };
  }
}

/**
 * Reward post-proof outbound activity for proven external addresses. Fenced by
 * baseline_nonce; exactly-once per agent per milestone via shared markers.
 */
export async function scanExternalOutboundMilestones(
  deps: ExternalOutboundScanDeps,
): Promise<ExternalOutboundScanReport> {
  const now = deps.now ?? Date.now;
  const report = emptyExternalReport();
  const targets = await deps.listTargets();
  report.scanned = targets.length;
  const sustainedThreshold = await deps.loadSustainedTxThreshold();

  for (const t of targets) {
    let currentNonce: number;
    try {
      currentNonce = await deps.getCurrentNonce(t.address);
    } catch {
      report.errors++;
      continue;
    }

    // A missing baseline is record-only legacy evidence. A latest-state read
    // cannot silently initialize economic authority; owner reproof is required.
    if (t.baselineNonce === null || t.baselineNonce === undefined) {
      report.errors++;
      continue;
    }

    // Defensive observability: current >= baseline ALWAYS holds in normal
    // operation (the nonce is monotonic and baseline was captured at/after the
    // proof block). A current < baseline reading can only come from a
    // stale/reorged RPC read or a corrupted baseline - the fence still holds
    // (we reward nothing this round), but surface it so an operator can
    // reconcile rather than silently masking a data-integrity anomaly.
    if (currentNonce < t.baselineNonce) {
      console.warn('[genesis-external-outbound] current nonce below baseline (stale read or corrupted baseline)', {
        address: t.address,
        current_nonce: currentNonce,
        baseline_nonce: t.baselineNonce,
      });
    }

    const postProofTxs = Math.max(0, currentNonce - t.baselineNonce);
    if (postProofTxs < 1) {
      report.not_yet++;
      continue;
    }

    const first = await claimAndPayExternal(deps, FIRSTTX_COLLECTION, t, 'agent_first_transaction', postProofTxs, now);
    if (first.status === 'emitted') {
      report.emitted++;
      report.first_tx_emitted++;
      report.bounty_pvt_granted += first.bountyPvt;
    } else if (first.status === 'already') {
      report.already_marked++;
    } else {
      report.errors++;
    }

    if (postProofTxs >= sustainedThreshold) {
      const sus = await claimAndPayExternal(deps, SUSTAINED_COLLECTION, t, 'agent_sustained_activity', postProofTxs, now);
      if (sus.status === 'emitted') {
        report.emitted++;
        report.sustained_emitted++;
        report.bounty_pvt_granted += sus.bountyPvt;
      } else if (sus.status === 'error') {
        report.errors++;
      }
      // 'already' (agent earned sustained via native or a prior round) is the
      // no-double-dip path - not counted as an error.
    }
  }

  return report;
}

export function buildExternalOutboundDeps(deps: AgentBankDeps): ExternalOutboundScanDeps {
  const payExternalMilestone = async (
    target: ExternalOutboundTarget,
    eventType: 'agent_first_transaction' | 'agent_sustained_activity',
  ): Promise<{ bountyPvt: number }> => {
    const { bountyPvt } = await payGenesisBounty(deps, {
      walletId: target.walletId,
      agentId: target.agentId,
      actorAddress: target.address,
      eventType,
      walletCreatedAtMs: target.provenAtMs,
      // Per-proven-source cap (Unit 2 convention): bound by the proven address.
      fundingSourceAddress: target.address,
      baseMetadata: {
        genesis_milestone: eventType,
        external_proven: true,
        proven_address: target.address,
        source_type: 'external_outbound',
      },
    });
    return { bountyPvt };
  };

  return {
    db: deps.db,
    listTargets: async () => {
      const proven = await listProvenAddresses(deps.db);
      return proven.map((rec) => ({
        walletId: rec.wallet_id,
        agentId: rec.agent_id,
        address: rec.address.toLowerCase(),
        provenAtMs: rec.proven_at_ms,
        baselineNonce: rec.baseline_nonce,
      }));
    },
    getCurrentNonce: (address) => getChainProvider('base').getTransactionCount(address),
    persistBaseline: (address, nonce) => setProvenAddressBaselineNonce(deps.db, address, nonce),
    loadSustainedTxThreshold: async () => {
      const config = await loadGenesisCampaignConfig(deps.db);
      // Reuse the sustained PE-count bar as the post-proof outbound-tx bar: both
      // mean "N units of sustained activity". For an external address the
      // on-chain signal is outbound tx count, not Provian PE count.
      return Math.max(1, config.sustained.min_pe_count);
    },
    payMilestone: payExternalMilestone,
  };
}

// =============================================================================
// PART E: AGENT-FACING STATUS
// =============================================================================

/**
 * cutover reconciliation product/API truth: the Genesis status projection is a LEGACY RECORD
 * surface and can no longer present anything as live or pending PVT9 state.
 *
 * Retired fields (deleted, not zeroed — deletion is the only retirement that
 * cannot be re-presented as PVT9 state): the funded/first_transaction/
 * sustained_activity ladder booleans, `next_milestone`, and the whole
 * `campaign` block (`enabled` / `window_open` / `pool_remaining_pvt` /
 * `pool_exhausted`). the controlling zero-carry decision every legacy
 * Genesis record is controlled test data excluded from PVT9, so a "remaining
 * pool" or "next bounty" reading is untrue by construction. What remains is
 * the historical issuance record plus the current PVT9 posture read from the
 * generated base config (fail-closed seam; epoch zero is armed on chain, see the config subject_note).
 */
export interface GenesisWalletStatus {
  wallet_id: string;
  schema: 'genesis-wallet-status/v3-legacy-record';
  /** Constant true: this projection is retired PVTv8 record-only test history. */
  legacy_record_only: true;
  /**
   * PVT the retired legacy test campaign issued to this wallet. A historical
   * record under the controlling zero-carry decision — never a PVT9 balance,
   * backlog, or pending mint.
   */
  genesis_pvt_earned_record: number;
  /**
   * Current PVT9 Genesis posture sourced from the campaign manifest and the runtime
   * activation doc — the activation truth — NOT the runtime boundary generated config, whose
   * genesis.armed/window_approved are fail-closed nulls that do not reflect reality.
   */
  pvt9: {
    genesis_armed: boolean;
    genesis_window_approved: boolean;
    /** Grant persistence live NOW — the signed activation doc admits an in-window act. */
    genesis_grants_live: boolean;
    /** The armed campaign window, or null when Genesis is not armed. */
    genesis_window: { start_ms: number; end_ms: number } | null;
  };
}

/**
 * The wallet's legacy Genesis issuance record + current PVT9 posture.
 * Read-only; carries no qualification, payment, or pool state.
 */
export async function getGenesisWalletStatus(db: Firestore, walletId: string): Promise<GenesisWalletStatus> {
  const ledgerSnap = await db.collection(WALLET_LEDGER_COLLECTION).doc(walletId).get();
  const earned = ledgerSnap.exists
    ? (typeof (ledgerSnap.data() as { issued_pvt?: number }).issued_pvt === 'number'
        ? (ledgerSnap.data() as { issued_pvt: number }).issued_pvt
        : 0)
    : 0;

  const armedWindow = genesisArmedWindow();
  return {
    wallet_id: walletId,
    schema: 'genesis-wallet-status/v3-legacy-record',
    legacy_record_only: true,
    genesis_pvt_earned_record: earned,
    pvt9: {
      genesis_armed: armedWindow !== null,
      genesis_window_approved: genesisWindowApproved(),
      genesis_grants_live: await isGenesisAdmittingNow(db),
      genesis_window: armedWindow === null ? null : {
        start_ms: armedWindow.startMs,
        end_ms: armedWindow.endMs,
      },
    },
  };
}
