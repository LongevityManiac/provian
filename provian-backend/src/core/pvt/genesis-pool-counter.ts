/**
 * Q3 / C6 — the Genesis pool counter is MONOTONIC. One chokepoint, no reducers.
 *
 * `genesis_campaign_state/global.pool_minted_pvt` is the campaign's spend
 * counter: it is what the pool cap is checked against, and what
 * `C6_genesis_pool_ledger_exact` compares to the wallet-ledger total. Two paths
 * used to move it DOWN — the suppressed-reservation rollback, and a launch
 * cleanup script that decremented the counter with no matching ledger write —
 * and a counter that can go down is a counter whose cap can be re-opened.
 *
 * the standing rule (M0 §9-Q3): gate every writer monotonic, rather than remove the
 * cleanup script. So:
 *
 * - Every write of the counter passes `admitMonotonicPoolCounterWrite` first.
 * - Any proposed value BELOW the current one is REFUSED, under a named
 * verdict. There is no clamp, no "close enough", and no override flag —
 * an override would be exactly the authority this removes.
 * - The reversal family writes NOTHING rather than writing a decrease, so the
 * pool counter and the wallet/source ledgers can never diverge: all three
 * move together, upward, by the same granted amount, or none moves.
 *
 * UNKNOWN IS REFUSED, NOT COERCED. A previous value that is absent, NaN,
 * infinite, negative, or not a number does not fall back to zero — falling back
 * to zero is precisely how a counter gets reset, so it refuses under its own
 * verdict. The caller may not proceed on a refusal.
 *
 * REVERSIBILITY: this module adds refusals and nothing else. It grants no
 * authority, reads no key, sends no transaction, and has no configuration. To
 * undo it, revert the commit.
 *
 * SCANNER CONTRACT: `wp11/c6-downgrade-evidence.ts` re-derives, on every test
 * run, that no writer of the counter decrements. Every remaining write site is
 * textually an addition for that reason. Do not route a write through a helper
 * that hides the direction from that scan — the scan is the thing that keeps
 * this true after everyone has forgotten it is a rule.
 */

/** Named outcomes. Exactly one admits; every other value is a refusal. */
export type PoolCounterVerdict =
  | 'admitted_monotonic'
  | 'refused_decrease'
  | 'refused_previous_unknown'
  | 'refused_proposed_unknown';

export interface PoolCounterDecision {
  readonly admitted: boolean;
  readonly verdict: PoolCounterVerdict;
  /** The value that may be written. `null` on every refusal — never a fallback. */
  readonly next: number | null;
  /** Caller-supplied label for logs and errors, e.g. `reserveGenesisIssuance`. */
  readonly site: string;
}

/** Thrown when a caller uses the asserting form and the write is refused. */
export class GenesisPoolCounterMonotonicityError extends Error {
  readonly verdict: PoolCounterVerdict;
  readonly site: string;
  constructor(decision: PoolCounterDecision) {
    super(
      `Genesis pool counter write refused at ${decision.site}: ${decision.verdict}`,
    );
    this.name = 'GenesisPoolCounterMonotonicityError';
    this.verdict = decision.verdict;
    this.site = decision.site;
  }
}

/** A finite, non-negative, real number. Anything else is UNKNOWN. */
function isUsableCounterValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Decide whether the counter may move from `previous` to `proposed`.
 *
 * Both parameters are `unknown` on purpose: the violating cases this refuses
 * (absent document, NaN from a bad read, a negative value, a string) are exactly
 * the ones a narrower parameter type would make unconstructible in a test, and a
 * guard whose violation cannot be constructed has never been shown to work.
 * Callers keep their own narrow types at the call site.
 */
export function decideMonotonicPoolCounterWrite(
  previous: unknown,
  proposed: unknown,
  site: string,
): PoolCounterDecision {
  if (!isUsableCounterValue(previous)) {
    return { admitted: false, verdict: 'refused_previous_unknown', next: null, site };
  }
  if (!isUsableCounterValue(proposed)) {
    return { admitted: false, verdict: 'refused_proposed_unknown', next: null, site };
  }
  if (proposed < previous) {
    return { admitted: false, verdict: 'refused_decrease', next: null, site };
  }
  return { admitted: true, verdict: 'admitted_monotonic', next: proposed, site };
}

/**
 * Assert the move is admissible, or throw. Use this at a write site that is
 * inside a transaction: throwing aborts the transaction, so a refused counter
 * move cannot leave a half-applied ledger behind.
 */
export function admitMonotonicPoolCounterWrite(
  previous: unknown,
  proposed: unknown,
  site: string,
): number {
  const decision = decideMonotonicPoolCounterWrite(previous, proposed, site);
  if (!decision.admitted || decision.next === null) {
    throw new GenesisPoolCounterMonotonicityError(decision);
  }
  return decision.next;
}

/**
 * The single reason string every refused reversal reports. Reversals are not
 * "temporarily disabled" — a reversal is a decrease, and decreases are refused.
 */
export const POOL_COUNTER_REVERSAL_REFUSED =
  'genesis_pool_counter_is_monotonic: reversals are refused, so the counter and '
  + 'the wallet/source ledgers can never diverge. A reservation that produced no '
  + 'PVT stays consumed — the pool binds EARLIER, never later.';
