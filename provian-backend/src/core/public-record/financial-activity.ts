/**
 * Chain-verified financial activity summary (beneficiary routing/bond lifecycle, agent-first launch).
 *
 * Summarizes ONLY chain-witnessed financial events for one agent identity — the events the
 * relay's own collectors witnessed on-chain:
 *
 * - inbound USDC: `receive` acts from the inbound-USDC watcher (metadata.activity_mapped)
 * - outbound USDC: `send` / `swap` / `stake` acts from the outbound-USDC watcher
 * (metadata.chain_verified)
 * - x402: `x402_payment` acts with metadata.chain_verified (an x402 settlement is
 * also an outbound USDC transfer)
 * - transfers: `agent_token_transfer` / `agent_native_transfer` acts from
 * POST /v1/agent/wallet/:id/transfer/record, re-verified on-chain (metadata.verified)
 *
 * PE METER : the relay keeps no PEs, so this is no longer a scan of the
 * identity's stored envelopes. Each such act's financial FACT (kind, USD amount, currency,
 * executing address — figures, never content) is derived at seal from the RELAY-authored act only
 * (`actFactsOf(..., { relayAuthored: true })`; a device's metadata is never trusted for it) and
 * folded once into the actor's running totals (`actor_meter_totals_v1`, all addresses and per
 * address). This read is one point read.
 *
 *, carried: an unsolicited `receive` no recipient-authored relationship to its
 * counterparty — never counts. The verdict is decided ONCE, at accrual (prospective only; an
 * `unsolicited_receive_record_only` disposition is terminal), and the total counts a receive only
 * with a known, non-unsolicited disposition (a missing one fails closed). A receive HELD for an
 * unresolvable authorship check (`pending_review`) is counted when it leaves its hold with a
 * non-unsolicited disposition — never while held, never twice (`held-acts.ts`).
 *
 * Output discipline: counts, volume BUCKETS, and timestamps only. Never raw metadata, never
 * counterparties, never tx hashes, never exact totals — the caller is an unauthenticated public
 * endpoint.
 */

import type { Firestore } from 'firebase-admin/firestore';
import {
  readActorMeterTotals,
  type FinancialTotals,
} from '../meter/actor-meter-totals';

/** Retained in the response shape for compatibility; the summary is a running total now. */
export const FINANCIAL_SCAN_LIMIT = 1000;

/** USDC volume buckets — coarse by design (public surface, no exact totals). */
export type VolumeBucket = 'none' | 'under_10' | '10_100' | '100_1k' | '1k_10k' | '10k_plus';

export interface ChainVerifiedActivitySummary {
  chain_verified_only: true;
  usdc: {
    inbound_count: number;
    outbound_count: number;
    inbound_volume_bucket: VolumeBucket;
    outbound_volume_bucket: VolumeBucket;
  };
  x402: {
    settlements_observed: number;
    volume_bucket: VolumeBucket;
  };
  verified_transfers: {
    count: number;
    by_currency: Record<string, number>;
  };
  first_activity_at: number | null;
  last_activity_at: number | null;
  scanned_window: { limit: number };
}

export function emptyChainVerifiedActivity(): ChainVerifiedActivitySummary {
  return {
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
    scanned_window: { limit: FINANCIAL_SCAN_LIMIT },
  };
}

export function bucketUsdcVolume(totalUsd: number): VolumeBucket {
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) return 'none';
  if (totalUsd < 10) return 'under_10';
  if (totalUsd < 100) return '10_100';
  if (totalUsd < 1_000) return '100_1k';
  if (totalUsd < 10_000) return '1k_10k';
  return '10k_plus';
}

/** The public projection of a financial total: counts, buckets, timestamps — never exact sums. */
export function summarizeFinancialTotals(totals: FinancialTotals): ChainVerifiedActivitySummary {
  const summary = emptyChainVerifiedActivity();
  summary.usdc.inbound_count = totals.inbound_count;
  summary.usdc.outbound_count = totals.outbound_count;
  summary.usdc.inbound_volume_bucket = bucketUsdcVolume(totals.inbound_usd);
  summary.usdc.outbound_volume_bucket = bucketUsdcVolume(totals.outbound_usd);
  summary.x402.settlements_observed = totals.x402_count;
  summary.x402.volume_bucket = bucketUsdcVolume(totals.x402_usd);
  summary.verified_transfers.count = totals.transfer_count;
  summary.verified_transfers.by_currency = { ...totals.transfers_by_currency };
  summary.first_activity_at = totals.first_at_ms;
  summary.last_activity_at = totals.last_at_ms;
  return summary;
}

/**
 * Summarize the chain-verified financial activity attributed to one agent identity, optionally
 * filtered to events executed by one address (lowercase; the watchers stamp the watched address
 * as the act's actor address, and transfer/record the verified sender). An act without an actor
 * address never matches a filter (fail closed).
 */
export async function summarizeChainVerifiedActivity(
  db: Firestore,
  agentId: string,
  options?: { addressFilter?: string },
): Promise<ChainVerifiedActivitySummary> {
  let totals;
  try {
    totals = await readActorMeterTotals(db, agentId);
  } catch (error) {
    console.warn('[PublicRecord] financial activity totals unavailable:', error);
    return emptyChainVerifiedActivity();
  }
  const addressFilter = options?.addressFilter?.toLowerCase() ?? null;
  if (addressFilter === null) return summarizeFinancialTotals(totals.financial);
  const byAddress = totals.financial_by_address[addressFilter];
  return byAddress === undefined ? emptyChainVerifiedActivity() : summarizeFinancialTotals(byAddress);
}
