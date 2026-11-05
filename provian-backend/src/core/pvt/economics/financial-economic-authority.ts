/**
 * Pure identity/count-only financial anti-farming authority.
 *
 * Deliberately no imports: callers cannot smuggle a price, quote, oracle,
 * exchange rate, token amount, or market-data dependency into this graph.
 *
 * the only count is the per-actor daily ceiling.
 * The per-(actor, counterparty) caps were removed — a per-pair count lands on
 * the honest heavy pair and does nothing against one-directional sends to
 * fresh addresses, which only a per-actor daily count bounds.
 */
export interface FinancialEconomicAuthorityInput {
  readonly counterpartyRequired: boolean;
  readonly counterpartyVerified: boolean;
  readonly dailyCount: number;
  readonly dailyCeiling: number | null;
}

export type FinancialEconomicCapReason =
  | 'unverifiable_counterparty'
  | 'daily_ceiling';

export interface FinancialEconomicAuthorityDecision {
  readonly capped: boolean;
  readonly reason: FinancialEconomicCapReason | null;
}

export function decideFinancialEconomicCaps(
  input: FinancialEconomicAuthorityInput,
): FinancialEconomicAuthorityDecision {
  if (input.counterpartyRequired && !input.counterpartyVerified) {
    return { capped: true, reason: 'unverifiable_counterparty' };
  }
  if (input.dailyCeiling !== null && input.dailyCount >= input.dailyCeiling) {
    return { capped: true, reason: 'daily_ceiling' };
  }
  return { capped: false, reason: null };
}
