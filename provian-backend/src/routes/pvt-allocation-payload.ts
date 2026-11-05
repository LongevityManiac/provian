/**
 * The `GET /v1/pvt/allocation/:wallet_id` response body, in one place.
 *
 * WHY THIS IS A MODULE. The legacy router built this object TWICE — once in the
 * human-wallet branch and once in the agent-wallet branch — as two ~40-line
 * copies that happened to agree. The PVT9-era public read surface would have
 * made a third. Three copies of a response shape is three chances for one of
 * them to drift while every test that binds to a different copy stays green.
 *
 * This is presentation only: it computes nothing, reads nothing, and decides
 * nothing about eligibility, minting, or authority.
 */

import {
  atomicToSafeDisplayNumber,
  type EconomicAccrualProjection,
} from '../core/pvt/policy/economic-projection';

export interface AllocationPayloadInput {
  readonly walletId: string;
  readonly onChainBalance: string;
  readonly accrual: EconomicAccrualProjection;
  readonly unmintedPeCount: number;
  readonly mintedPeCount: number;
}

export function buildAllocationPayload(
  input: AllocationPayloadInput,
): Record<string, unknown> {
  const { walletId, onChainBalance, accrual, unmintedPeCount, mintedPeCount } = input;
  return {
    wallet_id: walletId,
    on_chain_balance: onChainBalance,
    record_points: atomicToSafeDisplayNumber(accrual.totalRecordPointsAtomic),
    record_points_atomic: accrual.totalRecordPointsAtomic,
    record_points_label: 'sealed_record_points_not_pvt',
    current_settlement_projection: accrual.currentSettlementProjection === null
      ? {
        available: false,
        is_final: false,
        label: 'current_settlement_projection_non_final',
        unavailable_reason: accrual.currentSettlementProjectionUnavailableReason,
      }
      : {
        available: true,
        is_final: false,
        label: accrual.currentSettlementProjection.label,
        total_pvt: atomicToSafeDisplayNumber(
          accrual.totalCurrentSettlementProjectionAtomic!,
        ),
        total_pvt_atomic: accrual.totalCurrentSettlementProjectionAtomic,
        projected_at_ms: accrual.currentSettlementProjection.projectedAtMs,
        factor_vintage: accrual.currentSettlementProjection.factorVintage,
      },
    exact_genesis_reserved_gross_pvt:
      atomicToSafeDisplayNumber(accrual.exactGenesisReservedGrossAtomic),
    exact_genesis_reserved_gross_atomic: accrual.exactGenesisReservedGrossAtomic,
    total_pes: accrual.totalPEs,
    pes_by_category: accrual.pesByCategory,
    record_points_by_category: Object.fromEntries(
      Object.entries(accrual.recordPointsByCategoryAtomic)
        .map(([category, amount]) => [category, atomicToSafeDisplayNumber(amount)]),
    ),
    record_points_by_category_atomic: accrual.recordPointsByCategoryAtomic,
    current_settlement_projection_by_category_atomic:
      accrual.currentSettlementProjectionByCategoryAtomic,
    unminted_pe_count: unmintedPeCount,
    minted_pe_count: mintedPeCount,
    weekly_pes: accrual.weeklyPEs,
    integrity_failures: accrual.integrityFailures,
    projection_failures: accrual.projectionFailures,
  };
}
