/**
 * Immutable beneficiary routing evidence for a single PE.
 *
 * The monetary snapshot commits the record-time linkage class and exact agent
 * share BPS, but intentionally contains no database identifiers or addresses.
 * This companion commitment binds those economic factors to the authoritative
 * human wallet/user/address resolved at record time. Minting never treats the
 * mutable legacy `beneficiary_wallet_id` or floating `pvt_split` fields as
 * standalone routing authority.
 */

import crypto from 'crypto';
import stableStringify from 'json-stable-stringify';

import type { BeneficiaryCacheEntry } from './beneficiary';
import {
  canonicalAgentBeneficiaryShareBps,
  type AgentBeneficiaryShareBps,
} from '../agent-wallet/beneficiary-relationship';

export interface BeneficiaryRoutingSnapshot {
  readonly schema_version: 'beneficiary-routing/v1';
  readonly pe_id: string;
  readonly economic_actor_id: string;
  readonly recorded_at_ms: number;
  readonly human_wallet_id: string;
  readonly human_user_id: string;
  readonly human_address: string;
  readonly agent_share_bps: AgentBeneficiaryShareBps;
}

export interface LegacyPvtSplit {
  readonly total: number;
  readonly agent_share: number;
  readonly human_share: number;
  readonly ratio: number;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const COMMITMENT = /^sha256:[a-f0-9]{64}$/;

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length
    && actual.every((key, index) => key === canonical[index]);
}

function parseRoutingSnapshot(value: unknown): BeneficiaryRoutingSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('beneficiary_routing_snapshot_invalid');
  }
  const raw = value as Record<string, unknown>;
  if (!exactKeys(raw, [
    'schema_version', 'pe_id', 'economic_actor_id', 'recorded_at_ms',
    'human_wallet_id', 'human_user_id', 'human_address', 'agent_share_bps',
  ])) {
    throw new Error('beneficiary_routing_snapshot_schema_mismatch');
  }
  const snapshot = raw as unknown as BeneficiaryRoutingSnapshot;
  if (snapshot.schema_version !== 'beneficiary-routing/v1'
    || !snapshot.pe_id
    || !snapshot.economic_actor_id
    || !Number.isSafeInteger(snapshot.recorded_at_ms)
    || snapshot.recorded_at_ms < 0
    || !snapshot.human_wallet_id
    || !snapshot.human_user_id
    || !ADDRESS.test(snapshot.human_address)
    || canonicalAgentBeneficiaryShareBps({ bps: snapshot.agent_share_bps }) === null) {
    throw new Error('beneficiary_routing_snapshot_invalid');
  }
  return snapshot;
}

export function createBeneficiaryRoutingSnapshot(params: {
  peId: string;
  economicActorId: string;
  recordedAtMs: number;
  beneficiary: BeneficiaryCacheEntry;
}): BeneficiaryRoutingSnapshot | null {
  if (!params.beneficiary.linked) return null;
  const humanAddress = params.beneficiary.humanAddress?.toLowerCase() ?? '';
  const agentShareBps = canonicalAgentBeneficiaryShareBps({
    bps: params.beneficiary.agentShareBps,
  });
  if (agentShareBps === null) throw new Error('beneficiary_routing_bps_invalid');
  return parseRoutingSnapshot({
    schema_version: 'beneficiary-routing/v1',
    pe_id: params.peId,
    economic_actor_id: params.economicActorId,
    recorded_at_ms: params.recordedAtMs,
    human_wallet_id: params.beneficiary.humanWalletId,
    human_user_id: params.beneficiary.humanUserId,
    human_address: humanAddress,
    agent_share_bps: agentShareBps,
  });
}

export function hashBeneficiaryRoutingSnapshot(
  snapshot: BeneficiaryRoutingSnapshot,
): string {
  const parsed = parseRoutingSnapshot(snapshot);
  return `sha256:${sha256(stableStringify(parsed) ?? '')}`;
}

function assertLegacySplit(
  split: LegacyPvtSplit | null | undefined,
  agentShareBps: AgentBeneficiaryShareBps,
): void {
  if (!split
    || !Number.isFinite(split.total) || split.total < 0
    || !Number.isFinite(split.agent_share) || split.agent_share < 0
    || !Number.isFinite(split.human_share) || split.human_share < 0
    || !Number.isFinite(split.ratio)
    || canonicalAgentBeneficiaryShareBps({ legacyRatio: split.ratio }) !== agentShareBps) {
    throw new Error('beneficiary_routing_legacy_split_invalid');
  }
  const tolerance = Math.max(1e-12, Math.abs(split.total) * 1e-12);
  if (Math.abs((split.agent_share + split.human_share) - split.total) > tolerance
    || Math.abs(split.agent_share - (split.total * agentShareBps / 10_000)) > tolerance) {
    throw new Error('beneficiary_routing_legacy_split_mismatch');
  }
}

/**
 * Rebind the committed route to the exact PE/economic snapshot and its legacy
 * display mirrors. Returns the authoritative route or null for a genuinely
 * unsplit PE. Fixed Genesis grants explicitly bypass linked-agent routing.
 */
export function assertBeneficiaryRoutingEvidence(params: {
  peId: string;
  economicActorId: string;
  recordedAtMs: number;
  linkageState: string;
  beneficiaryAgentShareBps: number;
  fixedGrantSource: string;
  routingSnapshot: BeneficiaryRoutingSnapshot | null | undefined;
  routingSnapshotHash: string | null | undefined;
  beneficiaryWalletId: string | null | undefined;
  pvtSplit: LegacyPvtSplit | null | undefined;
}): BeneficiaryRoutingSnapshot | null {
  const fixedGrant = params.fixedGrantSource === 'genesis_campaign_reservation';
  const linked = params.linkageState === 'beneficiary_linked' && !fixedGrant;
  if (!linked) {
    if (params.routingSnapshot !== null && params.routingSnapshot !== undefined
      || params.routingSnapshotHash !== null && params.routingSnapshotHash !== undefined
      || params.beneficiaryWalletId !== null && params.beneficiaryWalletId !== undefined
      || params.pvtSplit !== null && params.pvtSplit !== undefined) {
      throw new Error('beneficiary_routing_unexpected_split');
    }
    return null;
  }

  const snapshot = parseRoutingSnapshot(params.routingSnapshot);
  const committedAgentShareBps = canonicalAgentBeneficiaryShareBps({
    bps: params.beneficiaryAgentShareBps,
  });
  if (!COMMITMENT.test(params.routingSnapshotHash ?? '')
    || committedAgentShareBps === null
    || params.routingSnapshotHash !== hashBeneficiaryRoutingSnapshot(snapshot)
    || snapshot.pe_id !== params.peId
    || snapshot.economic_actor_id !== params.economicActorId
    || snapshot.recorded_at_ms !== params.recordedAtMs
    || snapshot.agent_share_bps !== committedAgentShareBps
    || params.beneficiaryWalletId !== snapshot.human_user_id) {
    throw new Error('beneficiary_routing_binding_mismatch');
  }
  assertLegacySplit(params.pvtSplit, snapshot.agent_share_bps);
  return snapshot;
}
