/**
 * Agent Profile - Public Provenance Record
 *
 * Public endpoint (no auth) that returns a trust-legible profile for any agent,
 * whether they have a full agent wallet, a provisional wallet, or are identified
 * by agent_id/display_name. The profile is aggregate-only: it exposes PE counts,
 * legacy participation projections, and trust signals without dumping raw
 * private PE details.
 *
 * Endpoints:
 *   GET /:identifier/profile
 *   GET /:identifier/provenance
 */

import { Router, Request, Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../cache';
import { makeAgentProfileUrl, makeAgentProvenanceUrl } from '../provenance-links';
import { agentRecordDiscoveryGate, appClientDiscoveryGate } from './middleware/public-launch-gate';
import { countActiveAuthorMappingsForAgent } from '../core/agent-attribution/author-mappings';
import { isTestPlatformWallet } from '../core/pvt/genesis-award-state-machine';
import { readActorStats } from '../core/pvt/actor-stats';
import { readActorMeterTotals } from '../core/meter/actor-meter-totals';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentProfileDeps {
  db: Firestore;
  cache: RedisCache;
}

type WalletType = 'agent_wallet' | 'provisional' | 'not_found';
type PublicRecord = Record<string, unknown>;
type PublicBadge = string | PublicRecord;

// Exported types/loaders below are shared with the public Provenance Record
// surface (routes/agent-record.ts) so both endpoints project through the SAME
// aggregate-only guards — never widen a loader's output with raw doc fields.
export type AttestationTiers = Record<string, number> & {
  software: number;
  software_verified: number;
  hardware: number;
  hardware_partial: number;
  hardware_full: number;
  full_stack: number;
  corroborated: number;
};

export interface ActivitySummary {
  first_pe_at: number | null;
  last_pe_at: number | null;
  chain_age_days: number;
  active_days: number;
}

export interface BondSignal {
  has_bond: boolean;
  bond_active: boolean;
  bond_healthy: boolean;
  autonomy_level: 2 | 3 | null;
  bond_id: string | null;
  amount_pvt: string | null;
  renewal_deadline: number | null;
}

export interface CommonsSignal {
  status: string | null;
  attestation_tier: string | null;
  identity_verification_level: string | null;
  promise_fulfillment_rate: number | null;
  court_record: PublicRecord | null;
  published_pe_count: number | null;
  commons_join_date: number | null;
}

interface TrustSignals {
  has_human_link: boolean;
  human_attestations: number;
  unique_artifact_invokers: number;
  vouch_count: number;
  /** A7 : costly burn-vouches, counted separately from free vouches. */
  burn_vouch_count: number;
  performance_bond_posted: boolean;
  bond_healthy: boolean;
  commons_member: boolean;
  identity_verification_level: string | null;
  agent_identity: boolean;
  device_attested_agent_identity: boolean;
  key_anchored_author_mappings: number;
}

interface IdentitySignal {
  owner_type: string | null;
  is_agent_identity: boolean;
  device_attested: boolean;
  active_agent_owned_devices: number;
  key_anchored_author_mappings: number;
  attribution_model: 'agent_owned_device' | 'agent_key_or_owned_device' | 'public_record_only';
}

interface ProvenanceSummary {
  pe_count: number;
  total_estimated_pvt: number;
  source: 'pvt_accrual' | 'actor_stats' | 'provisional_wallet' | 'none';
  category_breakdown: Record<string, number>;
  estimated_pvt_by_category: Record<string, number>;
  latest_attestation_depth: string | null;
  last_pe_at: number | null;
  scanned_window: {
    pe_count: number;
    estimated_pvt: number;
    limit: number;
    includes_legacy_field_fallback: boolean;
  };
}

interface AgentProfileResponse {
  identifier: string;
  wallet_type: WalletType;
  wallet_id: string | null;
  agent_id: string | null;
  display_name: string | null;
  owner_type: string | null;
  wallet_address: string | null;
  pe_count: number;
  estimated_pvt: number;
  attestation_tiers: AttestationTiers;
  action_type_breakdown: Record<string, number>;
  activity_summary: ActivitySummary;
  provenance: ProvenanceSummary;
  trust_signals: TrustSignals;
  identity: IdentitySignal;
  bond: BondSignal;
  commons: CommonsSignal | null;
  badges: PublicBadge[];
  claimed: boolean;
  public_url: string;
  provenance_url: string;
  links: {
    profile: string;
    provenance: string;
  };
  disclaimer: string;
}

export interface ResolvedIdentifier {
  type: WalletType;
  userId: string | null;
  walletId: string | null;
  agentId: string | null;
  displayName: string | null;
  ownerType: string | null;
  walletAddress: string | null;
  badges: PublicBadge[];
  hasHumanLink: boolean;
  claimed: boolean;
  estimatedPvtFromDoc: number;
}

export interface PEStats {
  peCount: number;
  scannedEstimatedPvt: number;
  attestationTiers: AttestationTiers;
  actionTypeBreakdown: Record<string, number>;
  activitySummary: ActivitySummary;
  humanAttestations: number;
  uniqueArtifactInvokers: number;
  usedLegacyFieldFallback: boolean;
}

export interface PVTAccrualStats {
  exists: boolean;
  totalPEs: number;
  totalEstimatedPVT: number;
  categoryBreakdown: Record<string, number>;
  estimatedPVTByCategory: Record<string, number>;
  lastPETimestamp: number | null;
  attestationDepth: string | null;
}

interface ArtifactSignal {
  humanAttestationCount: number;
  uniqueInvokerCount: number;
}

interface DeviceIdentitySignal {
  activeAgentOwnedDevices: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_TTL_SECONDS = 300; // 5 minutes
const NOT_FOUND_CACHE_TTL_SECONDS = 60;
export const MAX_PE_SCAN = 1000;
const MAX_IDENTIFIER_LENGTH = 200;

const PROFILE_DISCLAIMER =
  'Public aggregate provenance record. Legacy estimated-PVT fields are non-settled compatibility projections and do not mint. The PVT kernel is live on Base; every act of work mints once at its best-supported value through batch settlement (standard earnings on a schedule Provian sets, currently every 30 days, Genesis grants daily), and a record here is not a balance and creates no right to PVT.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): PublicRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as PublicRecord;
  }
  return {};
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function nullableNumberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanField(value: unknown): boolean {
  return value === true;
}

function numberRecord(value: unknown): Record<string, number> {
  const source = asRecord(value);
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(source)) {
    const n = numberField(raw);
    if (n !== 0) result[key] = n;
  }
  return result;
}

function badgesField(value: unknown): PublicBadge[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((badge): PublicBadge | null => {
      if (typeof badge === 'string') return badge === 'insured_agent' ? { id: 'performance_bond', name: 'Performance Bond Posted', description: 'Posted a PVT performance bond. Collateral, not insurance.' } : badge;
      if (badge && typeof badge === 'object' && !Array.isArray(badge)) {
        const record = badge as PublicRecord;
        return record.id === 'insured_agent' ? { ...record, id: 'performance_bond', name: 'Performance Bond Posted', description: 'Posted a PVT performance bond. Collateral, not insurance.' } : record;
      }
      return null;
    })
    .filter((badge): badge is PublicBadge => badge !== null);
}

function timestampField(value: unknown): number | null {
  const direct = nullableNumberField(value);
  if (direct !== null) return direct;

  if (value && typeof value === 'object') {
    const maybeTimestamp = value as { toMillis?: () => number; seconds?: number };
    if (typeof maybeTimestamp.toMillis === 'function') {
      const millis = maybeTimestamp.toMillis();
      return Number.isFinite(millis) ? millis : null;
    }
    if (typeof maybeTimestamp.seconds === 'number' && Number.isFinite(maybeTimestamp.seconds)) {
      return maybeTimestamp.seconds * 1000;
    }
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function emptyAttestationTiers(): AttestationTiers {
  return {
    software: 0,
    software_verified: 0,
    hardware: 0,
    hardware_partial: 0,
    hardware_full: 0,
    full_stack: 0,
    corroborated: 0,
  };
}

function emptyActivitySummary(): ActivitySummary {
  return {
    first_pe_at: null,
    last_pe_at: null,
    chain_age_days: 0,
    active_days: 0,
  };
}

export function emptyBondSignal(): BondSignal {
  return {
    has_bond: false,
    bond_active: false,
    bond_healthy: false,
    autonomy_level: null,
    bond_id: null,
    amount_pvt: null,
    renewal_deadline: null,
  };
}

export function emptyPVTAccrualStats(): PVTAccrualStats {
  return {
    exists: false,
    totalPEs: 0,
    totalEstimatedPVT: 0,
    categoryBreakdown: {},
    estimatedPVTByCategory: {},
    lastPETimestamp: null,
    attestationDepth: null,
  };
}

export function emptyPEStats(): PEStats {
  return {
    peCount: 0,
    scannedEstimatedPvt: 0,
    attestationTiers: emptyAttestationTiers(),
    actionTypeBreakdown: {},
    activitySummary: emptyActivitySummary(),
    humanAttestations: 0,
    uniqueArtifactInvokers: 0,
    usedLegacyFieldFallback: false,
  };
}

function emptyIdentitySignal(ownerType: string | null = null): IdentitySignal {
  return {
    owner_type: ownerType,
    is_agent_identity: ownerType === 'agent',
    device_attested: false,
    active_agent_owned_devices: 0,
    key_anchored_author_mappings: 0,
    attribution_model: ownerType === 'agent' ? 'agent_owned_device' : 'public_record_only',
  };
}

function resolveOwnerType(data: PublicRecord, fallback: string): string {
  return stringField(data.owner_type)
    || stringField(data.ownerType)
    || stringField(data.participant_type)
    || fallback;
}

export function resolvedFromAgentWallet(docId: string, data: PublicRecord): ResolvedIdentifier {
  const walletId = stringField(data.id) || docId;
  const agentId = stringField(data.agent_id) || walletId;
  return {
    type: 'agent_wallet',
    userId: agentId,
    walletId,
    agentId,
    displayName: stringField(data.display_name) || agentId,
    ownerType: resolveOwnerType(data, 'agent'),
    walletAddress: stringField(data.address),
    badges: badgesField(data.badges),
    hasHumanLink: Boolean(
      stringField(data.linked_human_wallet_id)
      || stringField(data.linked_human_user_id)
      || stringField(data.linked_human_address),
    ),
    claimed: true,
    estimatedPvtFromDoc: numberField(data.estimated_pvt),
  };
}

function notFoundIdentifier(): ResolvedIdentifier {
  return {
    type: 'not_found',
    userId: null,
    walletId: null,
    agentId: null,
    displayName: null,
    ownerType: null,
    walletAddress: null,
    badges: [],
    hasHumanLink: false,
    claimed: false,
    estimatedPvtFromDoc: 0,
  };
}

/**
 * Resolve the identifier to a wallet document.
 * Order: wallet_id, provisional wallet, agent_id, display_name.
 */
export async function resolveIdentifier(
  db: Firestore,
  identifier: string,
): Promise<ResolvedIdentifier> {
  if (identifier.startsWith('wallet_aw_')) {
    const doc = await db.collection('agent_wallets').doc(identifier).get();
    if (doc.exists) {
      const data = asRecord(doc.data());
      return isTestPlatformWallet(data)
        ? notFoundIdentifier()
        : resolvedFromAgentWallet(doc.id, data);
    }
  }

  const provDoc = await db.collection('provisional_wallets').doc(identifier).get();
  if (provDoc.exists) {
    const data = asRecord(provDoc.data());
    return {
      type: 'provisional',
      userId: `provisional_${identifier}`,
      walletId: null,
      agentId: identifier,
      displayName: identifier,
      ownerType: 'provisional_agent',
      walletAddress: null,
      badges: [],
      hasHumanLink: false,
      claimed: booleanField(data.claimed),
      estimatedPvtFromDoc: numberField(data.estimated_pvt),
    };
  }

  const agentIdSnap = await db.collection('agent_wallets')
    .where('agent_id', '==', identifier)
    .limit(1)
    .get();
  if (!agentIdSnap.empty) {
    const doc = agentIdSnap.docs[0];
    const data = asRecord(doc.data());
    return isTestPlatformWallet(data)
      ? notFoundIdentifier()
      : resolvedFromAgentWallet(doc.id, data);
  }

  const displayNameSnap = await db.collection('agent_wallets')
    .where('display_name', '==', identifier)
    .limit(100)
    .get();
  if (!displayNameSnap.empty) {
    const publicDoc = displayNameSnap.docs.find((doc) => !isTestPlatformWallet(asRecord(doc.data())));
    if (publicDoc) {
      return resolvedFromAgentWallet(publicDoc.id, asRecord(publicDoc.data()));
    }
  }

  return notFoundIdentifier();
}

/**
 * One agent, two PE chains (verified live 2026-07-07): agent-API-path PEs
 * (wallet_created, external_address_proven, genesis_signup, relay actions)
 * accrue under the AGENT_ID, while device-path PEs (device_register, PEs
 * sent in a device batch, POST /v1/meter/batch, with device credentials) and the
 * genesis_device_link grant accrue under the WALLET_ID. The public record
 * must aggregate BOTH owner keys or device-attributed activity is invisible.
 * Keys are distinct identifiers, and every act and pvt_accrual doc carries
 * exactly one owner key, so merging never double-counts a document.
 *
 * Exported (with loadPVTAccrual/computePEStats) for the public record
 * surfaces in agent-record.ts — every consumer of accrual/PE stats must
 * aggregate over these keys, never a single userId.
 */
export function ownerAggregationKeys(resolved: ResolvedIdentifier): string[] {
  const keys = [resolved.userId, resolved.walletId].filter((k): k is string => Boolean(k));
  return [...new Set(keys)];
}

function sumNumberRecords(into: Record<string, number>, add: Record<string, number>): void {
  for (const [key, value] of Object.entries(add)) {
    into[key] = (into[key] || 0) + value;
  }
}

export async function loadPVTAccrual(db: Firestore, ownerKeys: string[]): Promise<PVTAccrualStats> {
  if (ownerKeys.length === 0) return emptyPVTAccrualStats();

  const merged = emptyPVTAccrualStats();
  let depthTimestamp: number | null = null;

  for (const key of ownerKeys) {
    const doc = await db.collection('pvt_accrual').doc(key).get();
    if (!doc.exists) continue;

    const data = asRecord(doc.data());
    merged.exists = true;
    merged.totalPEs += numberField(data.totalPEs);
    merged.totalEstimatedPVT += numberField(data.totalEstimatedPVT);
    sumNumberRecords(merged.categoryBreakdown, numberRecord(data.pesByCategory));
    sumNumberRecords(merged.estimatedPVTByCategory, numberRecord(data.estimatedPVTByCategory));

    const lastTs = timestampField(data.lastPETimestamp);
    if (lastTs !== null && (merged.lastPETimestamp === null || lastTs > merged.lastPETimestamp)) {
      merged.lastPETimestamp = lastTs;
    }
    // attestationDepth: the most recently active chain's depth wins.
    const depth = stringField(data.attestationDepth);
    if (depth && (depthTimestamp === null || (lastTs !== null && lastTs > depthTimestamp))) {
      merged.attestationDepth = depth;
      depthTimestamp = lastTs;
    }
  }

  // Cross-chain float sums otherwise leak artifacts (74.9 + 24.96 =
  // 99.86000000000001) onto the public surface; totals are rounded downstream
  // in pickProfileTotals, per-category values only here.
  for (const [key, value] of Object.entries(merged.estimatedPVTByCategory)) {
    merged.estimatedPVTByCategory[key] = Math.round(value * 100) / 100;
  }

  return merged;
}

/**
 * Public profile stats from RUNNING TOTALS, merged across every owner key the identity accrues
 * under (agent_id chain + wallet_id device chain — see ownerAggregationKeys).
 *
 * PE METER : the relay keeps no PEs, so nothing here scans an
 * identity's history. Per owner key it reads two documents: `actor_stats_v1` (PE count, the
 * action-type breakdown, first/last PE, active days, `corroboration_signal` acts) and
 * `actor_meter_totals_v1` (acts by sealed attestation tier, acts carrying a corroboration). The
 * keys are disjoint (a PE has exactly one owner key), so counts sum; `active_days` takes the
 * larger of the keys' counts (two chains active on one day must not count it twice).
 */
export async function computePEStats(
  db: Firestore,
  ownerKeys: string[],
): Promise<PEStats> {
  if (ownerKeys.length === 0) return emptyPEStats();

  const keys = [...new Set(ownerKeys)];
  const [statsDocs, totalsDocs] = await Promise.all([
    Promise.all(keys.map((key) => readActorStats(db, key))),
    Promise.all(keys.map((key) => readActorMeterTotals(db, key))),
  ]);

  const tiers = emptyAttestationTiers();
  const actionTypes: Record<string, number> = {};
  let peCount = 0;
  let firstPeAt: number | null = null;
  let lastPeAt: number | null = null;
  let activeDays = 0;
  let humanAttestations = 0;

  for (const stats of statsDocs) {
    peCount += stats.pe_count;
    for (const [type, n] of Object.entries(stats.by_type)) actionTypes[type] = (actionTypes[type] ?? 0) + n;
    if (stats.first_pe_at_ms !== null && (firstPeAt === null || stats.first_pe_at_ms < firstPeAt)) firstPeAt = stats.first_pe_at_ms;
    if (stats.last_pe_at_ms !== null && (lastPeAt === null || stats.last_pe_at_ms > lastPeAt)) lastPeAt = stats.last_pe_at_ms;
    activeDays = Math.max(activeDays, stats.active_days);
    humanAttestations += stats.by_type.corroboration_signal ?? 0;
  }
  for (const totals of totalsDocs) {
    for (const [tier, n] of Object.entries(totals.by_attestation_tier)) tiers[tier] = (tiers[tier] || 0) + n;
    humanAttestations += totals.corroborated;
  }

  const chainAgeDays = firstPeAt !== null
    ? Math.floor((Date.now() - firstPeAt) / (1000 * 60 * 60 * 24))
    : 0;

  return {
    peCount,
    // Running totals carry no estimated PVT; `pvt_accrual` (loadPVTAccrual) is the PVT source.
    scannedEstimatedPvt: 0,
    attestationTiers: tiers,
    actionTypeBreakdown: actionTypes,
    activitySummary: {
      first_pe_at: firstPeAt,
      last_pe_at: lastPeAt,
      chain_age_days: chainAgeDays,
      active_days: activeDays,
    },
    humanAttestations,
    // The real value is supplied by the commons_artifacts artifactSignal via Math.max in
    // buildResponse. Kept in the shape so the response field stays stable.
    uniqueArtifactInvokers: 0,
    usedLegacyFieldFallback: false,
  };
}

export async function loadCommonsSignal(db: Firestore, walletId: string | null): Promise<CommonsSignal | null> {
  if (!walletId) return null;

  try {
    const doc = await db.collection('commons_profiles').doc(walletId).get();
    if (!doc.exists) return null;

    const data = asRecord(doc.data());
    return {
      status: stringField(data.status),
      attestation_tier: stringField(data.attestation_tier),
      identity_verification_level: stringField(data.identity_verification_level),
      promise_fulfillment_rate: nullableNumberField(data.promise_fulfillment_rate),
      court_record: Object.keys(asRecord(data.court_record)).length > 0 ? asRecord(data.court_record) : null,
      published_pe_count: nullableNumberField(data.published_pe_count),
      commons_join_date: timestampField(data.commons_join_date),
    };
  } catch (error) {
    console.warn('[AgentProfile] Commons signal unavailable:', error);
    return null;
  }
}

// F27 (S2 2026-09-10): loadVouchCount (the free `commons_vouches` reader) was
// removed — free vouches are no longer a trust signal (the free vouch path is
// retired; see burn-vouch.ts /). The public vouch signal is
// loadBurnVouchCount (commons_burn_vouches) only.

/**
 * A7 (; the work package audit's own O4 close-action): burn-vouches — the costly,
 * skin-in-the-game signal (the voucher destroyed real PVT) — were invisible on
 * the public record, which counted only the free `commons_vouches`. Burn-vouch
 * rows key the TARGET by agent_id (`core/commons/burn-vouch.ts`), not wallet_id.
 */
export async function loadBurnVouchCount(db: Firestore, agentId: string | null): Promise<number> {
  if (!agentId) return 0;

  try {
    const snap = await db.collection('commons_burn_vouches')
      .where('target_agent_id', '==', agentId)
      .get();
    return typeof snap.size === 'number' ? snap.size : snap.docs.length;
  } catch (error) {
    console.warn('[AgentProfile] Burn-vouch signal unavailable:', error);
    return 0;
  }
}

async function loadArtifactSignal(db: Firestore, walletId: string | null): Promise<ArtifactSignal> {
  if (!walletId) return { humanAttestationCount: 0, uniqueInvokerCount: 0 };

  try {
    const snap = await db.collection('commons_artifacts')
      .where('creator_wallet_id', '==', walletId)
      .limit(100)
      .get();

    let humanAttestationCount = 0;
    let uniqueInvokerCount = 0;
    for (const doc of snap.docs) {
      const data = asRecord(doc.data());
      if (booleanField(data.deprecated)) continue;
      humanAttestationCount += numberField(data.human_attestation_count);
      uniqueInvokerCount += numberField(data.unique_invoker_count);
    }
    return { humanAttestationCount, uniqueInvokerCount };
  } catch (error) {
    console.warn('[AgentProfile] Artifact signal unavailable:', error);
    return { humanAttestationCount: 0, uniqueInvokerCount: 0 };
  }
}

export async function loadBondSignal(db: Firestore, walletId: string | null): Promise<BondSignal> {
  if (!walletId) return emptyBondSignal();

  try {
    const snap = await db.collection('bonds')
      .where('agent_wallet_id', '==', walletId)
      .limit(20)
      .get();

    const active = snap.docs
      .map(doc => asRecord(doc.data()))
      .find(data => stringField(data.status) === 'active');

    if (!active) return emptyBondSignal();

    const renewalDeadline = timestampField(active.renewal_deadline);
    const autonomyLevel = numberField(active.autonomy_level);
    return {
      has_bond: true,
      bond_active: true,
      bond_healthy: renewalDeadline !== null && Date.now() <= renewalDeadline,
      autonomy_level: autonomyLevel === 2 || autonomyLevel === 3 ? autonomyLevel : null,
      bond_id: stringField(active.bond_id),
      amount_pvt: stringField(active.amount_pvt),
      renewal_deadline: renewalDeadline,
    };
  } catch (error) {
    console.warn('[AgentProfile] Bond signal unavailable:', error);
    return emptyBondSignal();
  }
}

async function loadDeviceIdentitySignal(
  db: Firestore,
  resolved: ResolvedIdentifier,
): Promise<DeviceIdentitySignal> {
  if (!resolved.userId) return { activeAgentOwnedDevices: 0 };
  try {
    const snap = await db.collection('devices')
      .where('owner_user_id', '==', resolved.userId)
      .where('owner_type', '==', 'agent')
      .where('status', '==', 'active')
      .get();
    return {
      activeAgentOwnedDevices: typeof snap.size === 'number' ? snap.size : snap.docs.length,
    };
  } catch (error) {
    console.warn('[AgentProfile] Device identity signal unavailable:', error);
    return { activeAgentOwnedDevices: 0 };
  }
}

async function loadIdentitySignal(
  db: Firestore,
  resolved: ResolvedIdentifier,
): Promise<IdentitySignal> {
  const [deviceSignal, keyAnchoredMappings] = await Promise.all([
    loadDeviceIdentitySignal(db, resolved),
    countActiveAuthorMappingsForAgent(db, resolved.walletId).catch((error) => {
      console.warn('[AgentProfile] Author mapping signal unavailable:', error);
      return 0;
    }),
  ]);
  const isAgentIdentity = resolved.ownerType === 'agent' || resolved.type === 'agent_wallet';
  const deviceAttested = deviceSignal.activeAgentOwnedDevices > 0;
  return {
    owner_type: resolved.ownerType,
    is_agent_identity: isAgentIdentity,
    device_attested: deviceAttested,
    active_agent_owned_devices: deviceSignal.activeAgentOwnedDevices,
    key_anchored_author_mappings: keyAnchoredMappings,
    attribution_model: keyAnchoredMappings > 0
      ? 'agent_key_or_owned_device'
      : deviceAttested
        ? 'agent_owned_device'
        : 'public_record_only',
  };
}

function withIdentityBadges(badges: PublicBadge[], identity: IdentitySignal): PublicBadge[] {
  if (!identity.is_agent_identity) return badges;
  const hasAgentIdentityBadge = badges.some((badge) => {
    if (typeof badge === 'string') return badge === 'agent_identity';
    return badge.id === 'agent_identity';
  });
  if (hasAgentIdentityBadge) return badges;
  return [
    ...badges,
    {
      id: 'agent_identity',
      source: 'owner_type',
      owner_type: 'agent',
      device_attested: identity.device_attested,
      key_anchored_author_mappings: identity.key_anchored_author_mappings,
    },
  ];
}

function pickProfileTotals(
  resolved: ResolvedIdentifier,
  stats: PEStats,
  accrual: PVTAccrualStats,
): { peCount: number; estimatedPvt: number; source: ProvenanceSummary['source'] } {
  if (accrual.exists && (accrual.totalPEs > 0 || accrual.totalEstimatedPVT > 0)) {
    return {
      peCount: accrual.totalPEs,
      estimatedPvt: Math.round(accrual.totalEstimatedPVT * 100) / 100,
      source: 'pvt_accrual',
    };
  }

  if (stats.peCount > 0) {
    return {
      peCount: stats.peCount,
      estimatedPvt: stats.scannedEstimatedPvt,
      source: 'actor_stats',
    };
  }

  if (resolved.estimatedPvtFromDoc > 0) {
    return {
      peCount: 0,
      estimatedPvt: Math.round(resolved.estimatedPvtFromDoc * 100) / 100,
      source: 'provisional_wallet',
    };
  }

  return { peCount: 0, estimatedPvt: 0, source: 'none' };
}

function mergeActivitySummary(stats: PEStats, accrual: PVTAccrualStats): ActivitySummary {
  if (stats.activitySummary.last_pe_at !== null || accrual.lastPETimestamp === null) {
    return stats.activitySummary;
  }

  return {
    ...stats.activitySummary,
    last_pe_at: accrual.lastPETimestamp,
  };
}

function buildResponse(params: {
  identifier: string;
  resolved: ResolvedIdentifier;
  stats: PEStats;
  accrual: PVTAccrualStats;
  commons: CommonsSignal | null;
  vouchCount: number;
  burnVouchCount: number;
  artifactSignal: ArtifactSignal;
  identity: IdentitySignal;
  bond: BondSignal;
}): AgentProfileResponse {
  const {
    identifier,
    resolved,
    stats,
    accrual,
    commons,
    vouchCount,
    burnVouchCount,
    artifactSignal,
    identity,
    bond,
  } = params;

  const totals = pickProfileTotals(resolved, stats, accrual);
  const activitySummary = mergeActivitySummary(stats, accrual);
  const profileUrl = makeAgentProfileUrl(identifier);
  const provenanceUrl = makeAgentProvenanceUrl(identifier);

  return {
    identifier,
    wallet_type: resolved.type,
    wallet_id: resolved.walletId,
    agent_id: resolved.agentId,
    display_name: resolved.displayName,
    owner_type: resolved.ownerType,
    wallet_address: resolved.walletAddress,
    pe_count: totals.peCount,
    estimated_pvt: totals.estimatedPvt,
    attestation_tiers: stats.attestationTiers,
    action_type_breakdown: stats.actionTypeBreakdown,
    activity_summary: activitySummary,
    provenance: {
      pe_count: totals.peCount,
      total_estimated_pvt: totals.estimatedPvt,
      source: totals.source,
      category_breakdown: accrual.categoryBreakdown,
      estimated_pvt_by_category: accrual.estimatedPVTByCategory,
      latest_attestation_depth: accrual.attestationDepth,
      last_pe_at: activitySummary.last_pe_at,
      scanned_window: {
        pe_count: stats.peCount,
        estimated_pvt: stats.scannedEstimatedPvt,
        limit: MAX_PE_SCAN,
        includes_legacy_field_fallback: stats.usedLegacyFieldFallback,
      },
    },
    trust_signals: {
      has_human_link: resolved.hasHumanLink,
      human_attestations: stats.humanAttestations + artifactSignal.humanAttestationCount,
      unique_artifact_invokers: Math.max(stats.uniqueArtifactInvokers, artifactSignal.uniqueInvokerCount),
      vouch_count: vouchCount,
      burn_vouch_count: burnVouchCount,
      performance_bond_posted: bond.bond_active && bond.bond_healthy,
      bond_healthy: bond.bond_healthy,
      commons_member: commons?.status === 'active',
      identity_verification_level: commons?.identity_verification_level ?? null,
      agent_identity: identity.is_agent_identity,
      device_attested_agent_identity: identity.device_attested,
      key_anchored_author_mappings: identity.key_anchored_author_mappings,
    },
    identity,
    bond,
    commons,
    badges: withIdentityBadges(resolved.badges, identity),
    claimed: resolved.claimed,
    public_url: profileUrl,
    provenance_url: provenanceUrl,
    links: {
      profile: profileUrl,
      provenance: provenanceUrl,
    },
    disclaimer: PROFILE_DISCLAIMER,
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createAgentProfileRouter(deps: AgentProfileDeps): Router {
  const { db, cache } = deps;
  const router = Router();

  // Public discovery gate, applied PER ROUTE. These two routes served 200 to an
  // anonymous caller with PUBLIC_LAUNCH=false, disclosing the agent roster
  // (and, through the badge list, that Genesis exists).
  //
  // NOT `router.use(...)`. This router is mounted at `app.use('/v1/agents',
  // ...)` BEFORE the authenticated `/v1/agents/:agentId` routes and before
  // `/v1/agents/directory`, so router-level middleware answering 404 would
  // swallow those too. A gate must close ITS OWN routes and let everything
  // else fall through untouched.
  // `/provenance` is the agent-to-agent LOOKUP surface (burn-to-present READS):
  // an agent may read ANOTHER agent's full public provenance record at launch
  // without the PUBLIC_LAUNCH flip. `appClientDiscoveryGate` admits any Bearer
  // credential pre-flip (an anonymous public-web caller still 404s) and everyone
  // at the flip. The data is the same public record post-flip; the human-wallet
  // privacy boundary (resolve.ts: humans are never resolvable) is unchanged, so
  // this exposes agent records only, exactly as a public chain read would.
  const gate = appClientDiscoveryGate();
  // `/profile` is get_agent_record's fallback path, so it takes the same
  // onboarding-allowlist exemption as `/record`: an allowlisted MCP key may read
  // it pre-launch.
  const recordFallbackGate = agentRecordDiscoveryGate();

  const handleProfileLookup = async (req: Request, res: Response): Promise<void> => {
    try {
      const { identifier } = req.params;

      if (!identifier || identifier.length > MAX_IDENTIFIER_LENGTH) {
        res.status(400).json({ error: 'Invalid identifier' });
        return;
      }

      // v2 excludes platform:test identities from every public lookup.
      const cacheKey = `agent_profile:v2:${identifier}`;
      const cached = await cache.get<AgentProfileResponse>(cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }

      const resolved = await resolveIdentifier(db, identifier);
      if (resolved.type === 'not_found') {
        const notFoundResponse = buildResponse({
          identifier,
          resolved,
          stats: emptyPEStats(),
          accrual: emptyPVTAccrualStats(),
          commons: null,
          vouchCount: 0,
          burnVouchCount: 0,
          artifactSignal: { humanAttestationCount: 0, uniqueInvokerCount: 0 },
          identity: emptyIdentitySignal(resolved.ownerType),
          bond: emptyBondSignal(),
        });

        await cache.set(cacheKey, notFoundResponse, NOT_FOUND_CACHE_TTL_SECONDS);
        res.json(notFoundResponse);
        return;
      }

      const [accrual, stats, commons, vouchCount, burnVouchCount, artifactSignal, identity, bond] = await Promise.all([
        loadPVTAccrual(db, ownerAggregationKeys(resolved)),
        computePEStats(db, ownerAggregationKeys(resolved)),
        loadCommonsSignal(db, resolved.walletId),
        // F27 (S2 2026-09-10): the vouch signal is burn-vouches only — the free
        // `commons_vouches` rows are no longer counted (the free vouch path is
        // retired). vouch_count and burn_vouch_count both derive from
        // commons_burn_vouches.
        loadBurnVouchCount(db, resolved.agentId),
        loadBurnVouchCount(db, resolved.agentId),
        loadArtifactSignal(db, resolved.walletId),
        loadIdentitySignal(db, resolved),
        loadBondSignal(db, resolved.walletId),
      ]);

      const response = buildResponse({
        identifier,
        resolved,
        stats,
        accrual,
        commons,
        vouchCount,
        burnVouchCount,
        artifactSignal,
        identity,
        bond,
      });

      await cache.set(cacheKey, response, CACHE_TTL_SECONDS);
      res.json(response);
    } catch (error) {
      console.error('[AgentProfile] Error:', error);
      res.status(500).json({ error: 'Profile lookup failed' });
    }
  };

  router.get('/:identifier/profile', recordFallbackGate, handleProfileLookup);
  router.get('/:identifier/provenance', gate, handleProfileLookup);

  return router;
}
