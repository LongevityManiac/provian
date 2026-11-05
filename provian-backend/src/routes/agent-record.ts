/**
 * Agent Passport — the public Provenance Record (beneficiary routing, agent-first launch).
 *
 * GET /v1/agents/:identifier/record — the Provenance Record (JSON)
 * GET /v1/agents/:identifier/badge.svg — embeddable README badge (SVG)
 *
 * Public, unauthenticated, PUBLIC_LAUNCH-gated (404 pre-flip, same convention
 * as the OpenAPI/ecosystem discovery routes). The record is the N=1 trust
 * wedge: a verifiable aggregate track record for one agent, consumable by
 * anyone deciding whether to transact with it.
 *
 * Tier-3 discipline (Security Invariant: TIER_3_FIELDS in
 * core/commons/publication.ts): every field is allowlist-projected through the
 * same loaders the public profile uses — never balances, policy configs,
 * telemetry, credentials, guardian info, linked-human identifiers, API-key
 * material, or raw PE metadata. As belt-and-braces the router also wraps
 * res.json in stripTier3Fields (the Commons pattern), so a future field
 * addition that trips the denylist is dropped even if a projection misses it.
 */

import { Router, Request, Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../cache';
import {
  computePEStats,
  loadPVTAccrual,
  ownerAggregationKeys,
  loadBondSignal,
  loadBurnVouchCount,
  loadCommonsSignal,
  MAX_PE_SCAN,
  type PEStats,
  type BondSignal,
  type CommonsSignal,
  type PVTAccrualStats,
} from './agent-profile';
import {
  resolveRecordSubject,
  type RecordSubject,
} from '../core/public-record/resolve';
import {
  summarizeChainVerifiedActivity,
  type ChainVerifiedActivitySummary,
} from '../core/public-record/financial-activity';
import { stripTier3Fields } from '../core/commons/publication';
import { isAgentRecordDiscoveryAdmissible } from './middleware/public-launch-gate';
import { PE_CATEGORIES } from '../core/pvt/pe-weight-framework';
import { ELIGIBILITY_DISCLAIMER } from '../core/pvt/estimate';
import {
  getPublicApiBaseUrl,
  makeAgentProfileUrl,
  makeAgentProvenanceUrl,
} from '../provenance-links';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentRecordDeps {
  db: Firestore;
  cache: RedisCache;
}

interface CourtSummary {
  bond_claims_against: {
    total: number;
    upheld: number;
    dismissed: number;
    open: number;
  };
  general_disputes: {
    filed_by_agent: number;
    against_agent: number;
    resolved_against_agent: number;
  };
  arbitration_cases: number;
}

interface PromiseSummary {
  issued: number;
  settled: number;
  defaulted: number;
  /** settled / (settled + defaulted); null until at least one promise resolved. */
  fulfillment_rate: number | null;
}

interface ProvenanceRecordResponse {
  record_type: 'provenance_record';
  record_version: 1;
  identifier: string;
  found: boolean;
  matched_by: RecordSubject['matched_by'];
  agent: {
    wallet_id: string | null;
    agent_id: string | null;
    display_name: string | null;
    platform: string | null;
    status: string | null;
    created_at: number | null;
    wallet_age_days: number | null;
    address: string | null;
    linked_to_human: boolean;
    external_address: RecordSubject['externalLink'];
  };
  provenance: {
    pe_count: number;
    source: 'pvt_accrual' | 'actor_stats' | 'none';
    total_estimated_pvt: number;
    families: Record<string, number>;
    action_types: Record<string, number>;
    attestation_tiers: Record<string, number>;
    first_pe_at: number | null;
    last_pe_at: number | null;
    active_days: number;
    scanned_window: { pe_count: number; limit: number };
  };
  financial: ChainVerifiedActivitySummary;
  bond: {
    bonded: boolean;
    healthy: boolean;
    autonomy_level: 2 | 3 | null;
    amount_pvt: string | null;
    renewal_deadline: number | null;
  };
  court: CourtSummary;
  promises: PromiseSummary;
  vouches: { count: number; burn_vouch_count: number };
  commons: { member: boolean };
  links: {
    record: string;
    badge: string;
    profile: string;
    provenance: string;
  };
  disclaimers: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECORD_CACHE_TTL_SECONDS = 300;
const NOT_FOUND_CACHE_TTL_SECONDS = 60;
const MAX_IDENTIFIER_LENGTH = 200;

const RECORD_DISCLAIMERS = [
  'Public aggregate Provenance Record. Legacy estimated-PVT fields are non-settled compatibility projections and do not mint. The PVT kernel is live on Base; every act of work mints once at its best-supported value through batch settlement (standard earnings on a schedule Provian sets, currently every 30 days, Genesis grants daily), and a record here is not a balance and creates no right to PVT.',
  ELIGIBILITY_DISCLAIMER,
  'Financial summaries include chain-verified events only; self-reported activity is excluded.',
];

// Invert the category membership map once: action_type -> family. Types not
// in the seed map fall back to the 'uncategorized' family — a public grouping
// label, not an eligibility judgment.
const ACTION_TYPE_FAMILY: Record<string, string> = (() => {
  const inverted: Record<string, string> = {};
  for (const [family, types] of Object.entries(PE_CATEGORIES)) {
    for (const type of types) inverted[type] = family;
  }
  return inverted;
})();

function familiesFromActionTypes(actionTypes: Record<string, number>): Record<string, number> {
  const families: Record<string, number> = {};
  for (const [type, count] of Object.entries(actionTypes)) {
    const family = ACTION_TYPE_FAMILY[type] ?? 'uncategorized';
    families[family] = (families[family] ?? 0) + count;
  }
  return families;
}

// ---------------------------------------------------------------------------
// Loaders (court + promises — counts only, mirroring the agent-bank queries)
// ---------------------------------------------------------------------------

async function loadCourtSummary(db: Firestore, walletId: string | null): Promise<CourtSummary> {
  const empty: CourtSummary = {
    bond_claims_against: { total: 0, upheld: 0, dismissed: 0, open: 0 },
    general_disputes: { filed_by_agent: 0, against_agent: 0, resolved_against_agent: 0 },
    arbitration_cases: 0,
  };
  if (!walletId) return empty;

  try {
    const [claimsSnap, filedSnap, againstSnap, arbitratorDoc] = await Promise.all([
      db.collection('bond_claims').where('respondent_wallet_id', '==', walletId).get(),
      db.collection('general_disputes').where('filed_by', '==', walletId).get(),
      db.collection('general_disputes').where('respondent', '==', walletId).get(),
      db.collection('arbitrators').doc(walletId).get(),
    ]);

    const summary: CourtSummary = {
      bond_claims_against: { total: 0, upheld: 0, dismissed: 0, open: 0 },
      general_disputes: {
        filed_by_agent: filedSnap.size,
        against_agent: againstSnap.size,
        resolved_against_agent: 0,
      },
      arbitration_cases: 0,
    };

    for (const doc of claimsSnap.docs) {
      const status = (doc.data() as { status?: string }).status;
      summary.bond_claims_against.total += 1;
      if (status === 'upheld') summary.bond_claims_against.upheld += 1;
      else if (status === 'dismissed') summary.bond_claims_against.dismissed += 1;
      else if (status === 'filed') summary.bond_claims_against.open += 1;
    }

    for (const doc of againstSnap.docs) {
      const resolution = (doc.data() as { resolution?: string }).resolution;
      if (resolution === 'upheld' || resolution === 'partial') {
        summary.general_disputes.resolved_against_agent += 1;
      }
    }

    if (arbitratorDoc.exists) {
      const cases = (arbitratorDoc.data() as { total_cases?: number }).total_cases;
      summary.arbitration_cases = typeof cases === 'number' && Number.isFinite(cases) ? cases : 0;
    }

    return summary;
  } catch (error) {
    console.warn('[AgentRecord] Court summary unavailable:', error);
    return empty;
  }
}

async function loadPromiseSummary(db: Firestore, walletId: string | null): Promise<PromiseSummary> {
  const empty: PromiseSummary = { issued: 0, settled: 0, defaulted: 0, fulfillment_rate: null };
  if (!walletId) return empty;

  try {
    // Same three queries as agent-bank's borrower snapshot.
    const [issued, settled, defaulted] = await Promise.all([
      db.collection('promises').where('borrower_wallet_id', '==', walletId).get().then(s => s.size),
      db.collection('promises')
        .where('borrower_wallet_id', '==', walletId)
        .where('status', '==', 'settled')
        .get().then(s => s.size),
      db.collection('promises')
        .where('borrower_wallet_id', '==', walletId)
        .where('status', '==', 'defaulted')
        .get().then(s => s.size),
    ]);

    const resolved = settled + defaulted;
    return {
      issued,
      settled,
      defaulted,
      fulfillment_rate: resolved > 0 ? Math.round((settled / resolved) * 1000) / 1000 : null,
    };
  } catch (error) {
    console.warn('[AgentRecord] Promise summary unavailable:', error);
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Record assembly
// ---------------------------------------------------------------------------

function makeRecordUrl(identifier: string): string {
  return `${getPublicApiBaseUrl()}/v1/agents/${encodeURIComponent(identifier)}/record`;
}

function makeBadgeUrl(identifier: string): string {
  return `${getPublicApiBaseUrl()}/v1/agents/${encodeURIComponent(identifier)}/badge.svg`;
}

function notFoundRecord(identifier: string): ProvenanceRecordResponse {
  return {
    record_type: 'provenance_record',
    record_version: 1,
    identifier,
    found: false,
    matched_by: null,
    agent: {
      wallet_id: null,
      agent_id: null,
      display_name: null,
      platform: null,
      status: null,
      created_at: null,
      wallet_age_days: null,
      address: null,
      linked_to_human: false,
      external_address: null,
    },
    provenance: {
      pe_count: 0,
      source: 'none',
      total_estimated_pvt: 0,
      families: {},
      action_types: {},
      attestation_tiers: {},
      first_pe_at: null,
      last_pe_at: null,
      active_days: 0,
      scanned_window: { pe_count: 0, limit: MAX_PE_SCAN },
    },
    financial: {
      chain_verified_only: true,
      usdc: {
        inbound_count: 0,
        outbound_count: 0,
        inbound_volume_bucket: 'none',
        outbound_volume_bucket: 'none',
      },
      x402: { settlements_observed: 0, volume_bucket: 'none' },
      verified_transfers: { count: 0, by_currency: {} },
      first_activity_at: null,
      last_activity_at: null,
      scanned_window: { limit: MAX_PE_SCAN },
    },
    bond: { bonded: false, healthy: false, autonomy_level: null, amount_pvt: null, renewal_deadline: null },
    court: {
      bond_claims_against: { total: 0, upheld: 0, dismissed: 0, open: 0 },
      general_disputes: { filed_by_agent: 0, against_agent: 0, resolved_against_agent: 0 },
      arbitration_cases: 0,
    },
    promises: { issued: 0, settled: 0, defaulted: 0, fulfillment_rate: null },
    vouches: { count: 0, burn_vouch_count: 0 },
    commons: { member: false },
    links: {
      record: makeRecordUrl(identifier),
      badge: makeBadgeUrl(identifier),
      profile: makeAgentProfileUrl(identifier),
      provenance: makeAgentProvenanceUrl(identifier),
    },
    disclaimers: RECORD_DISCLAIMERS,
  };
}

function buildRecordResponse(params: {
  identifier: string;
  subject: RecordSubject;
  stats: PEStats;
  accrual: PVTAccrualStats;
  bond: BondSignal;
  commons: CommonsSignal | null;
  vouchCount: number;
  burnVouchCount: number;
  financial: ChainVerifiedActivitySummary;
  court: CourtSummary;
  promises: PromiseSummary;
}): ProvenanceRecordResponse {
  const { identifier, subject, stats, accrual, bond, commons, vouchCount, burnVouchCount, financial, court, promises } = params;
  const resolved = subject.resolved!;

  const peCount = accrual.exists && accrual.totalPEs > 0 ? accrual.totalPEs : stats.peCount;
  const source: 'pvt_accrual' | 'actor_stats' | 'none' =
    accrual.exists && accrual.totalPEs > 0
      ? 'pvt_accrual'
      : stats.peCount > 0
        ? 'actor_stats'
        : 'none';
  const totalEstimatedPvt = accrual.exists && accrual.totalEstimatedPVT > 0
    ? Math.round(accrual.totalEstimatedPVT * 100) / 100
    : stats.scannedEstimatedPvt;

  const createdAt = subject.createdAt;
  const walletAgeDays = createdAt !== null
    ? Math.max(0, Math.floor((Date.now() - createdAt) / (1000 * 60 * 60 * 24)))
    : (stats.activitySummary.first_pe_at !== null ? stats.activitySummary.chain_age_days : null);

  return {
    record_type: 'provenance_record',
    record_version: 1,
    identifier,
    found: true,
    matched_by: subject.matched_by,
    agent: {
      wallet_id: resolved.walletId,
      agent_id: resolved.agentId,
      display_name: resolved.displayName,
      platform: subject.platform,
      status: subject.status,
      created_at: createdAt,
      wallet_age_days: walletAgeDays,
      address: resolved.walletAddress,
      // Boolean ONLY — the linked human's identity is Tier-3 (never expose
      // linked_human_user_id / _wallet_id / _address).
      linked_to_human: resolved.hasHumanLink,
      external_address: subject.externalLink,
    },
    provenance: {
      pe_count: peCount,
      source,
      total_estimated_pvt: totalEstimatedPvt,
      families: familiesFromActionTypes(stats.actionTypeBreakdown),
      action_types: stats.actionTypeBreakdown,
      attestation_tiers: stats.attestationTiers,
      first_pe_at: stats.activitySummary.first_pe_at,
      last_pe_at: stats.activitySummary.last_pe_at ?? accrual.lastPETimestamp,
      active_days: stats.activitySummary.active_days,
      scanned_window: { pe_count: stats.peCount, limit: MAX_PE_SCAN },
    },
    financial,
    bond: {
      bonded: bond.bond_active,
      healthy: bond.bond_healthy,
      autonomy_level: bond.autonomy_level,
      amount_pvt: bond.amount_pvt,
      renewal_deadline: bond.renewal_deadline,
    },
    court,
    promises,
    // A7 : burn-vouches (costly, PVT-destroying) surfaced beside the
    // free vouch count — the work package audit's own O4 close-action.
    vouches: { count: vouchCount, burn_vouch_count: burnVouchCount },
    commons: {
      member: commons?.status === 'active',
    },
    links: {
      record: makeRecordUrl(identifier),
      badge: makeBadgeUrl(identifier),
      profile: makeAgentProfileUrl(identifier),
      provenance: makeAgentProvenanceUrl(identifier),
    },
    disclaimers: RECORD_DISCLAIMERS,
  };
}

async function loadRecord(
  db: Firestore,
  cache: RedisCache,
  identifier: string,
): Promise<ProvenanceRecordResponse> {
  // v2 excludes platform:test identities from every public lookup.
  const cacheKey = `agent_record:v2:${identifier}`;
  const cached = await cache.get<ProvenanceRecordResponse>(cacheKey);
  if (cached) return cached;

  const subject = await resolveRecordSubject(db, identifier);
  if (!subject.found || !subject.resolved) {
    const response = notFoundRecord(identifier);
    await cache.set(cacheKey, response, NOT_FOUND_CACHE_TTL_SECONDS);
    return response;
  }

  const resolved = subject.resolved;
  const [stats, accrual, bond, commons, vouchCount, burnVouchCount, financial, court, promises] = await Promise.all([
    // Both PE chains (agent_id + wallet_id) — single-key aggregation makes
    // device-path activity invisible; see ownerAggregationKeys in agent-profile.
    computePEStats(db, ownerAggregationKeys(resolved)),
    loadPVTAccrual(db, ownerAggregationKeys(resolved)),
    loadBondSignal(db, resolved.walletId),
    loadCommonsSignal(db, resolved.walletId),
    // F27 (S2 2026-09-10): the vouch signal is burn-vouches only — the free
    // `commons_vouches` rows are no longer counted (the free vouch path is
    // retired). `count` and `burn_vouch_count` both derive from
    // commons_burn_vouches.
    loadBurnVouchCount(db, resolved.agentId ?? null),
    loadBurnVouchCount(db, resolved.agentId ?? null),
    resolved.userId
      ? summarizeChainVerifiedActivity(db, resolved.userId)
      : Promise.resolve(notFoundRecord(identifier).financial),
    loadCourtSummary(db, resolved.walletId),
    loadPromiseSummary(db, resolved.walletId),
  ]);

  const response = buildRecordResponse({
    identifier,
    subject,
    stats,
    accrual,
    bond,
    commons,
    vouchCount,
    burnVouchCount,
    financial,
    court,
    promises,
  });

  await cache.set(cacheKey, response, RECORD_CACHE_TTL_SECONDS);
  return response;
}

// ---------------------------------------------------------------------------
// Badge rendering
// ---------------------------------------------------------------------------

const TIER_DISPLAY_ORDER: Array<{ key: string; label: string }> = [
  { key: 'hardware_full', label: 'hardware' },
  { key: 'full_stack', label: 'full-stack' },
  { key: 'compute_tee', label: 'tee' },
  { key: 'hardware_partial', label: 'hw-partial' },
  { key: 'hardware', label: 'hardware' },
  { key: 'corroborated', label: 'corroborated' },
  { key: 'software_verified', label: 'sw-verified' },
  { key: 'software', label: 'software' },
  { key: 'social', label: 'social' },
];

function highestTierLabel(tiers: Record<string, number>): string | null {
  for (const { key, label } of TIER_DISPLAY_ORDER) {
    if ((tiers[key] ?? 0) > 0) return label;
  }
  return null;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderBadgeSvg(label: string, value: string, valueColor: string): string {
  // Shields-style flat badge; ~6.2px per char at 11px Verdana plus padding.
  const labelWidth = Math.round(label.length * 6.2) + 12;
  const valueWidth = Math.round(value.length * 6.2) + 12;
  const width = labelWidth + valueWidth;
  const l = escapeXml(label);
  const v = escapeXml(value);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${l}: ${v}">`
    + `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>`
    + `<clipPath id="r"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>`
    + `<g clip-path="url(#r)">`
    + `<rect width="${labelWidth}" height="20" fill="#555"/>`
    + `<rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${valueColor}"/>`
    + `<rect width="${width}" height="20" fill="url(#s)"/>`
    + `</g>`
    + `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`
    + `<text x="${labelWidth / 2}" y="14">${l}</text>`
    + `<text x="${labelWidth + valueWidth / 2}" y="14">${v}</text>`
    + `</g>`
    + `</svg>`;
}

function badgeFromRecord(record: ProvenanceRecordResponse): string {
  if (!record.found) {
    return renderBadgeSvg('provian record', 'unknown agent', '#9f9f9f');
  }
  const peCount = record.provenance.pe_count;
  if (peCount === 0) {
    return renderBadgeSvg('provian record', 'no PEs yet', '#9f9f9f');
  }
  const tier = highestTierLabel(record.provenance.attestation_tiers) ?? 'software';
  const bonded = record.bond.bonded ? 'bonded' : 'unbonded';
  const value = `${peCount} PEs · ${tier} · ${bonded}`;
  return renderBadgeSvg('provian record', value, record.bond.bonded ? '#3fb950' : '#4c8cd1');
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createAgentRecordRouter(deps: AgentRecordDeps): Router {
  const { db, cache } = deps;
  const router = Router();

  // Belt-and-braces Tier-3 sanitizer on every JSON response from this router
  // (same pattern as the Commons router). The record is allowlist-built, so
  // this should never fire — but a denylisted key must not survive even if a
  // future loader change slips one in.
  router.use((_req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => originalJson(stripTier3Fields(body))) as typeof res.json;
    next();
  });

  const gateAndValidate = (req: Request, res: Response): string | null => {
    // Public launch opens this to everyone; before the flip any key-bearing MCP
    // onboarding caller may also read it (get_agent_record's primary path), judged
    // by the same rule that admits /mcp (open on MCP_AGENT_ONBOARDING;
    // retired the key allowlist). Anonymous (keyless) callers still 404 pre-flip.
    // See isAgentRecordDiscoveryAdmissible.
    if (!isAgentRecordDiscoveryAdmissible(req)) {
      res.status(404).json({ error: 'not found' });
      return null;
    }
    const { identifier } = req.params;
    if (!identifier || identifier.length > MAX_IDENTIFIER_LENGTH) {
      res.status(400).json({ error: 'Invalid identifier' });
      return null;
    }
    return identifier;
  };

  router.get('/:identifier/record', async (req: Request, res: Response) => {
    try {
      const identifier = gateAndValidate(req, res);
      if (identifier === null) return;

      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const rateLimit = await cache.checkRateLimit(`rl:agent-record:${clientIp}`, 60, 60);
      if (!rateLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: rateLimit.retryAfter });
        return;
      }

      const record = await loadRecord(db, cache, identifier);
      res.status(record.found ? 200 : 404).json(record);
    } catch (error) {
      console.error('[AgentRecord] Error:', error);
      res.status(500).json({ error: 'Record lookup failed' });
    }
  });

  router.get('/:identifier/badge.svg', async (req: Request, res: Response) => {
    try {
      const identifier = gateAndValidate(req, res);
      if (identifier === null) return;

      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const rateLimit = await cache.checkRateLimit(`rl:agent-badge:${clientIp}`, 120, 60);
      if (!rateLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: rateLimit.retryAfter });
        return;
      }

      const record = await loadRecord(db, cache, identifier);
      const svg = badgeFromRecord(record);

      // README embeds are fetched through caching proxies (GitHub camo);
      // Cache-Control is what makes the badge cheap in the wild.
      res.set('Cache-Control', record.found ? 'public, max-age=300' : 'public, max-age=60');
      res.set('Content-Type', 'image/svg+xml; charset=utf-8');
      res.status(200).send(svg);
    } catch (error) {
      console.error('[AgentRecord] Badge error:', error);
      res.status(500).json({ error: 'Badge render failed' });
    }
  });

  return router;
}
