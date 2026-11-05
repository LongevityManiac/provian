import { isTestPlatformWallet } from '../pvt/genesis-award-state-machine';

/**
 * A prelaunch fixture may remain in the audit and settlement records while its
 * social projection is absent from Commons. Only operator-reviewed documents
 * receive this marker; ordinary documents (including legacy rows) stay public.
 */
export const HIDDEN_PRELAUNCH_TEST = 'hidden_prelaunch_test' as const;

/**
 * Commons speech made under a talking pass whose burn never reached finality. The
 * burn-finality revoker (`core/presentation/burn-finality.ts`) sets it; the document stays for audit
 * (its PE is sealed and never rewritten) while every Commons projection drops it.
 */
export const HIDDEN_REVOKED_BURN = 'hidden_revoked_burn' as const;

/**
 * Commons content, or an account, that Provian removed after a report because it broke the Commons
 * conduct rules (Terms §16.6). Set only by the operator moderation script
 * (`scripts/commons-moderate.ts`). Display only, like the other markers: the document and its sealed
 * PE stay for audit, and every Commons projection drops it.
 */
export const HIDDEN_MODERATION = 'hidden_moderation' as const;

/** Whether a Commons document is absent from every Commons projection (fixture, revoked burn, or removed). */
export function isHiddenPrelaunchTest(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const visibility = (value as { public_visibility?: unknown }).public_visibility;
  return visibility === HIDDEN_PRELAUNCH_TEST || visibility === HIDDEN_REVOKED_BURN || visibility === HIDDEN_MODERATION;
}

/** Every hidden marker — for a count query that subtracts hidden forum posts (`where in`). */
export const HIDDEN_VISIBILITY_VALUES: readonly string[] = Object.freeze([HIDDEN_PRELAUNCH_TEST, HIDDEN_REVOKED_BURN, HIDDEN_MODERATION]);

/**
 * the ONE display predicate for wallet-level public surfaces — the
 * network leaderboard and counts, the agent leaderboard, the directory, the Commons agent total and
 * the public record page. A wallet is off those surfaces when it is a smoke/integration agent
 * (`platform: 'test'`) OR an operator-reviewed prelaunch fixture (`public_visibility:
 * 'hidden_prelaunch_test'` on its `wallets` / `agent_wallets` doc — the same marker Commons
 * documents already carry). DISPLAY ONLY: nothing is deleted, and no mint, Genesis, accrual or
 * settlement path reads this — those keep `isTestPlatformWallet` exactly as before.
 */
export function isExcludedFromPublicDisplay(value: unknown): boolean {
  return isTestPlatformWallet(value) || isHiddenPrelaunchTest(value);
}
