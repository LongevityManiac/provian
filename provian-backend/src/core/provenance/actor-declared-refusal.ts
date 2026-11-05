/**
 * PEs prove provenance.
 *
 * "An agent declaring its own work has no path to a PE, minting or record-only."
 * Standing principle: a PE exists only when something other than the actor
 * vouches for it — the device observing the work, a counterparty, a forge, or
 * the chain. An actor's own claim about its work is never a PE, at any tier.
 *
 * Every agent-facing intake that would otherwise have recorded the actor's own
 * description of its work refuses with THIS code, before anything is written:
 * no PE, no record_only row, no chain-tip advance, no nonce or ledger claim.
 * Already-sealed PEs are untouched — this is an intake refusal only; it moves no
 * policy row, weight, or signed template.
 */
import type { Response } from 'express';

export const ACTOR_DECLARED_REFUSAL_CODE = 'actor_declared_work_is_not_a_pe' as const;

/** HTTP status for the refusal: the caller is authenticated, the act is not admissible. */
export const ACTOR_DECLARED_REFUSAL_STATUS = 403 as const;

export interface ActorDeclaredRefusalBody {
  readonly error: string;
  readonly code: typeof ACTOR_DECLARED_REFUSAL_CODE;
  readonly reason: string;
  readonly decision: 'non_actor_provenance_required';
}

/**
 * The one refusal body. `reason` names which rule refused (machine-readable,
 * snake_case); `error` is the human sentence.
 */
export function actorDeclaredRefusal(reason: string, detail?: string): ActorDeclaredRefusalBody {
  return {
    error: detail
      ?? 'An actor\'s own claim about its work is not a Provenance Envelope. A PE exists only when '
        + 'something other than the actor vouches for it: the device observing the work, a counterparty, a forge, '
        + 'or the chain.',
    code: ACTOR_DECLARED_REFUSAL_CODE,
    reason,
    decision: 'non_actor_provenance_required',
  };
}

export function refuseActorDeclared(res: Response, reason: string, detail?: string): void {
  res.status(ACTOR_DECLARED_REFUSAL_STATUS).json(actorDeclaredRefusal(reason, detail));
}
