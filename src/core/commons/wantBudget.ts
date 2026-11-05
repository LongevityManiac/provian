/**
 * wantBudget — the wants board's optional max budget (`budget_max_pvt`).
 *
 * On the wire `budget_max_pvt` is PVT ATOMIC units: a base-10 integer string, 18 decimals — the same
 * unit as every PVT rate on the relay (`hourly_rate_pvt`, `service_rate_pvt`, a human job's
 * `budget_pvt`), because the relay's fit score compares it directly against a fulfiller's atomic
 * `hourly_rate_pvt` (`provian-backend/src/core/commons/wants.ts::computeBudgetFit`). A person types
 * PVT ("20", "20.5"); this module converts that to atomic units before anything is sent, and maps the
 * relay's refusal codes to translation keys so the post form never shows a raw code.
 */
import { parsePvtInput, formatPvtExact } from './pvtAmountInput';

export type WantBudgetParse =
  | { ok: true; atomic: string | null }
  | { ok: false };

/**
 * Parse what the person typed into the budget field. Empty = no budget (`atomic: null`). Otherwise a
 * positive PVT amount (`pvtAmountInput.parsePvtInput`: at most 18 places, a decimal comma only where it
 * cannot be a thousands separator, never throws), returned as the atomic-unit string the relay expects.
 * Zero, a sign, letters, "1,000", more than 18 places, or an absurdly long number are refused.
 */
export function parseWantBudget(input: string): WantBudgetParse {
  const parsed = parsePvtInput(input);
  if (!parsed.ok) return parsed.reason === 'empty' ? { ok: true, atomic: null } : { ok: false };
  if (parsed.atomic <= 0n) return { ok: false };
  return { ok: true, atomic: parsed.atomic.toString() };
}

/** A want's budget for display, exact ("20", "20.5", "0.001"), or null when it has none / is malformed / zero. */
export function formatWantBudget(atomic: string | null | undefined): string | null {
  if (typeof atomic !== 'string' || !/^\d+$/.test(atomic)) return null;
  const n = BigInt(atomic);
  return n > 0n ? formatPvtExact(n) : null;
}

/**
 * The translation key for a failed want post. Known relay codes map to a specific message; anything
 * else (an unknown code, a network error) maps to the generic failure — never the raw text.
 */
export function wantPostErrorKey(err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  const status = (err as { status?: unknown } | null)?.status;
  if (message === 'budget_max_pvt_invalid') return 'commons.wantBudgetInvalid';
  if (message.startsWith('outcome_')) return 'commons.wantOutcomeInvalid';
  if (message.startsWith('capabilities_')) return 'commons.wantCapabilitiesInvalid';
  if (status === 429) return 'commons.wantRateLimited';
  return 'commons.wantPostFailed';
}
