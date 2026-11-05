/**
 * Retired compatibility boundary for the pre-PVT9 Genesis payout helper.
 *
 * Final 75/75/25 awards must enter through genesis-award-state-machine so the
 * qualifying act, reservation, exact snapshot, PE, and retry state are durable.
 * Historical funding/first-transaction/sustained call sites receive an explicit
 * zero result; direct attempts to route a current leg through this legacy helper
 * are rejected.
 */

import type { AgentBankDeps } from '../agent-bank/types';
import type { GenesisAnyEventType } from './genesis-campaign';
import { RETIRED_GENESIS_ACTION_TYPES } from './policy/proposed-genesis-policy';

export interface GenesisPayoutParams {
  walletId: string;
  agentId: string;
  actorAddress: string;
  eventType: GenesisAnyEventType;
  walletCreatedAtMs: number;
  counterpartyAddress?: string | null;
  fundingSourceAddress?: string | null;
  fundingUsd?: number;
  baseMetadata?: Record<string, unknown>;
  now?: number;
}

export interface GenesisPayoutResult {
  peId: string;
  peHash: string;
  bountyPvt: number;
  reason: string;
}

export async function payGenesisBounty(
  _deps: AgentBankDeps,
  params: GenesisPayoutParams,
): Promise<GenesisPayoutResult> {
  if ((RETIRED_GENESIS_ACTION_TYPES as readonly string[]).includes(params.eventType)) {
    return {
      peId: '',
      peHash: '',
      bountyPvt: 0,
      reason: 'retired_genesis_action_record_only',
    };
  }
  throw new Error(
    `legacy_genesis_payout_path_rejected:${params.eventType}; use genesis-award-state-machine`,
  );
}
