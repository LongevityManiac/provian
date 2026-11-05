/**
 * Pure display helpers for Commons human jobs.
 *
 * Lives in core/commons (not the screen) so the compensation/budget formatting
 * can be unit-tested under vitest without an RN render harness, and so the list
 * screen and the management screen format amounts identically.
 *
 * C8 (Pass-2 Human-Jobs seams): Phase-1 human jobs carry a canonical
 * `budget_pvt` (BigInt 18-decimal atomic string). The old formatter only knew
 * about the deprecated `compensation_amount` / `pvt_amount` fields, so every
 * fixed-PVT job rendered "Negotiable". This helper formats `budget_pvt` first.
 */

/** Just the compensation-bearing fields of a HumanJob — keeps this module decoupled. */
export interface HumanJobCompensationFields {
  budget_pvt?: string;
  /** USDC budget in dollars (≤ 6 decimals). */
  budget_usdc?: number;
  currency?: 'pvt' | 'usdc';
  compensation_amount?: number;
  compensation_currency?: string;
  pvt_amount?: number;
}

const PVT_18D = 10n ** 18n;
const PVT_2DP = 10n ** 16n; // 1e16 → two-decimal granularity

/**
 * Format a PVT atomic-unit (18d) string into a human "N" or "N.dd" PVT-less
 * number string. Trims a trailing ".00" so whole PVT amounts read cleanly.
 * Returns null for empty / zero / malformed input so callers can fall through.
 */
export function formatPvtAtomic(atomic: string | undefined | null): string | null {
  if (atomic == null || atomic === '' || atomic === '0') return null;
  let n: bigint;
  try {
    n = BigInt(atomic);
  } catch {
    return null;
  }
  if (n <= 0n) return null;
  const whole = n / PVT_18D;
  const frac = (n % PVT_18D) / PVT_2DP; // 0..99
  if (frac === 0n) return whole.toString();
  return `${whole.toString()}.${frac.toString().padStart(2, '0')}`;
}

/**
 * Compensation label for a job card. Priority:
 *   1. budget_pvt (canonical Phase-1 PVT escrow amount)
 *   2. legacy USDC compensation_amount (+ currency)
 *   3. legacy pvt_amount (precision-lossy number field)
 *   4. "Negotiable" when nothing is set.
 */
/** Format a USDC dollar amount: "25 USDC", "12.50 USDC", "0.000001 USDC". Null when unusable. */
export function formatUsdcAmount(amount: number | undefined | null): string | null {
  if (amount == null || !Number.isFinite(amount) || amount <= 0) return null;
  const fixed = amount.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  const [whole, frac = ''] = fixed.split('.');
  const shown = frac.length === 0 ? whole : `${whole}.${frac.length === 1 ? `${frac}0` : frac}`;
  return `${shown} USDC`;
}

export function formatHumanJobCompensation(job: HumanJobCompensationFields): string {
  if (job.currency === 'usdc' || (job.budget_usdc != null && !job.budget_pvt)) {
    const usdc = formatUsdcAmount(job.budget_usdc);
    if (usdc != null) return usdc;
  }
  const pvt = formatPvtAtomic(job.budget_pvt);
  if (pvt != null) {
    return `${pvt} PVT`;
  }
  if (job.compensation_amount != null) {
    const currency = job.compensation_currency?.toUpperCase() ?? 'USDC';
    return `${job.compensation_amount} ${currency}`;
  }
  if (job.pvt_amount != null) {
    return `${job.pvt_amount} PVT`;
  }
  return 'Negotiable';
}
