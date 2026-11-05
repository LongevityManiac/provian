/**
 * Live-value recipient guard.
 *
 * WHY THIS EXISTS (finding (a); remediated here).
 * The variable now named `KEEPER_FORBIDDEN_SIGNER_ADDRESS` (formerly
 * `PROVIAN_TREASURY_ADDRESS`) carried two contradictory meanings at once. Three
 * consumers used it PROTECTIVELY — `escrow-release.ts`, `pool-keeper.ts` and
 * `bond-keeper.ts` put it in a *forbidden* set so a keeper key can never also be
 * the treasury key. The fourth, `routes/agent-wallet.ts`, used it as a
 * DESTINATION: the 0x `swapFeeRecipient` at 25 bps on every agent swap quote,
 * collected on the buy token. On the live relay that variable resolved to
 * `0xD395c8f59131a4736aa4d9eE6e5dEb8fDA07Ce0a` the excluded administrative EOA whose
 * key has an unresolved plaintext-exposure history, and which the mobile
 * `src/core/fees/FeeConfig.ts` names in as many words as an address that must
 * not receive live value. Every agent swap was routing an integrator fee to it.
 *
 * THE SPLIT THIS MODULE ENFORCES.
 * `KEEPER_FORBIDDEN_SIGNER_ADDRESS` has keeper-identity / forbidden-set semantics
 * ONLY — it names a key that must never be a signer, not a place value goes. Its
 * name says so; the old name read as a destination.
 * Destinations that actually RECEIVE value are named in
 * `LIVE_VALUE_RECIPIENT_VARS` below, and no exposed-key address may resolve as
 * one. The two roles can no longer be moved by the same variable.
 *
 * SINCE 2026-09-25 `SWAP_FEE_RECIPIENT` receives the 25 bps fee on EVERY 0x swap, human
 * (`/api/proxy/zerox/allowance-holder/quote`) and agent (`/v1/agent/wallet/:id/swap`), and must
 * EQUAL `PROVIAN_TREASURY` below, not merely avoid the exposed EOA
 * (`resolveEvmSwapFeeRecipient` in core/swap/swap-fees.ts). The Solana and LI.FI fee recipients
 * are pinned in that module.
 *
 * ENFORCEMENT IS IN TWO PLACES ON PURPOSE.
 * Boot (`assertNoExposedKeyAsLiveValueRecipient` in server.ts) catches a bad
 * deploy early, and request time (`assertLiveValueRecipient` at the 0x quote
 * site) is the gate that actually cannot be bypassed — a relay booted with the
 * variable unset would pass the boot check vacuously, so the fetch site checks
 * again where the value is about to move. This mirrors the repo's standing rule
 * that outbound enforcement lives where the fetch happens.
 */

/**
 * The exposed excluded administrative EOA. Lowercased for comparison.
 *
 * Provenance: `docs/SECRET_INVENTORY_2026-05-15.md` records the plaintext
 * exposure and `src/core/fees/FeeConfig.ts` (mobile) states the must-not-receive
 * rule.
 *
 * `escrow-release.ts`, `pool-keeper.ts` and `bond-keeper.ts` USED to hardcode
 * this address independently; collapsed all three onto
 * `FORBIDDEN_KEEPER_IDENTITIES` below, so there is now exactly one declaration
 * and three importers. `live-value-recipients.test.ts` asserts each of the three
 * still imports and uses it, and that none has reintroduced a private address
 * literal — the drift risk moved from divergent copies to a dropped import.
 */
export const EXPOSED_LEGACY_EOA = '0xd395c8f59131a4736aa4d9ee6e5deb8fda07ce0a';

/**
 * The Provian treasury. Lowercased for comparison.
 *
 * `feeWallet` / `provianTechWallet` / `provianTreasury` on the successor kernel and all five institution deployment
 * institutions, and the production `SWAP_FEE_RECIPIENT`. It RECEIVES value, which is exactly why it
 * must never also be a hot keeper key.
 */
export const PROVIAN_TREASURY = '0x086e0f377af1245b8888540f39e99a42a7daf1da';

/**
 * Addresses that must never be a keeper / release / signer identity, by reason.
 *
 * WHY THIS IS HARDCODED RATHER THAN ENV-DERIVED. The three keeper guards each read
 * `KEEPER_FORBIDDEN_SIGNER_ADDRESS` into their forbidden set AND then hardcode the exposed EOA
 * unconditionally. That made the env entry for the exposed EOA redundant, and left whichever
 * address the variable did NOT name uncovered. Since only one variable exists and there are two
 * addresses that must be excluded, env alone cannot cover both — so both are pinned here and the
 * env read stays as an additional belt-and-suspenders layer.
 *
 * Getting this wrong is not theoretical: before the treasury that receives every fee in the
 * system was in no forbidden set at all, so `ESCROW_RELEASE_KEY`/`POOL_KEEPER_KEY`/`BOND_KEEPER_KEY`
 * could have been set to the treasury key and every guard would have passed.
 */
export const FORBIDDEN_KEEPER_IDENTITIES: ReadonlyMap<string, string> = new Map([
  [EXPOSED_LEGACY_EOA, 'exposed Provian legacy admin wallet (plaintext-exposure history)'],
  [PROVIAN_TREASURY, 'Provian treasury — it RECEIVES live value and must never be a hot keeper key'],
]);

/**
 * Env var naming one more address no keeper / release key may resolve to: a privileged key
 * identity (set to the treasury), never a payout destination. Read only by the three keeper
 * guards (`escrow-release.ts`, `pool-keeper.ts`, `bond-keeper.ts`) through
 * `keeperForbiddenSignerEntries` below.
 */
export const KEEPER_FORBIDDEN_SIGNER_VAR = 'KEEPER_FORBIDDEN_SIGNER_ADDRESS';

/**
 * The same variable's former name. Still read because the deployed relay environment carries
 * it; once the deployed environment sets `KEEPER_FORBIDDEN_SIGNER_ADDRESS` and drops this name,
 * remove it here.
 */
export const LEGACY_KEEPER_FORBIDDEN_SIGNER_VAR = 'PROVIAN_TREASURY_ADDRESS';

/**
 * The env-configured forbidden keeper identities, lowercased, with their reason. Both names are
 * read and both are forbidden when both are set: the set only ever grows, so a half-finished
 * rename can never drop an exclusion.
 */
export function keeperForbiddenSignerEntries(
  env: Record<string, string | undefined> = process.env,
): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const varName of [KEEPER_FORBIDDEN_SIGNER_VAR, LEGACY_KEEPER_FORBIDDEN_SIGNER_VAR]) {
    const raw = env[varName];
    if (raw && raw.trim()) entries.push([raw.trim().toLowerCase(), `treasury key identity (${varName})`]);
  }
  return entries;
}

/**
 * Addresses that must never receive live value, by reason.
 *
 * Keyed lowercase. Additions here are load-bearing: anything listed is refused
 * as a destination at boot AND at the point of use.
 */
export const FORBIDDEN_VALUE_RECIPIENTS: ReadonlyMap<string, string> = new Map([
  [
    EXPOSED_LEGACY_EOA,
    'Provian\'s legacy admin wallet 0xD395c8… — its key has an unresolved plaintext-exposure history ' +
      '(docs/SECRET_INVENTORY_2026-05-15.md), so it must not receive live value',
  ],
]);

/**
 * Env vars naming a destination that RECEIVES live value.
 *
 * SINGLE SOURCE OF TRUTH — the boot guard, the request-time guard and the test
 * suite all read this one list. Do not restate it anywhere; a second copy is
 * exactly the self-referential-control defect the run contract names.
 *
 * `KEEPER_FORBIDDEN_SIGNER_ADDRESS` (and its former name) is deliberately NOT here. It names a key identity
 * for forbidden-set checks, not a payout destination. Adding it back would
 * re-merge the two roles this module exists to separate.
 */
export const LIVE_VALUE_RECIPIENT_VARS: readonly string[] = ['SWAP_FEE_RECIPIENT'];

export interface RecipientViolation {
  /** Env var that resolved to a forbidden address. */
  varName: string;
  /** The offending value, as configured (original casing preserved). */
  address: string;
  /** Why this address may not receive value. */
  reason: string;
}

export interface LiveValueRecipientAudit {
  /**
   * How many of the audited vars were actually SET.
   *
   * Load-bearing. A universally-quantified claim over an empty population is
   * not a pass — `status` reports `vacuous` rather than `ok` when this is 0, so
   * a guard that checked nothing can never read as a guard that found nothing.
   */
  evaluated: number;
  /** Vars that were set, with their configured values. */
  resolved: Array<{ varName: string; address: string }>;
  /** Vars that resolved to a forbidden recipient. */
  violations: RecipientViolation[];
  status: 'ok' | 'vacuous' | 'violation';
}

const norm = (a: string | undefined): string => (a ?? '').trim().toLowerCase();

/**
 * Audit an environment's live-value recipient configuration.
 *
 * `env` and `varNames` are parameters rather than reads of `process.env` and the
 * module constant so a violating configuration is CONSTRUCTIBLE in a test — the
 * run contract's "unreachable branch" rule. Production passes `process.env` and
 * the default list.
 */
export function auditLiveValueRecipients(
  env: Record<string, string | undefined>,
  varNames: readonly string[] = LIVE_VALUE_RECIPIENT_VARS,
): LiveValueRecipientAudit {
  const resolved: Array<{ varName: string; address: string }> = [];
  const violations: RecipientViolation[] = [];

  for (const varName of varNames) {
    const raw = env[varName];
    if (!raw || !raw.trim()) continue;

    const address = raw.trim();
    resolved.push({ varName, address });

    const reason = FORBIDDEN_VALUE_RECIPIENTS.get(norm(address));
    if (reason) {
      violations.push({ varName, address, reason });
    }
  }

  const status: LiveValueRecipientAudit['status'] =
    violations.length > 0 ? 'violation' : resolved.length === 0 ? 'vacuous' : 'ok';

  return { evaluated: resolved.length, resolved, violations, status };
}

/**
 * Boot guard. Throws when any live-value recipient resolves to a forbidden
 * address.
 *
 * Does NOT throw on a vacuous audit: an unset `SWAP_FEE_RECIPIENT` closes the
 * swap path structurally (the route 500s before quoting), so there is no value
 * to misroute. The caller is expected to surface `vacuous` as a non-pass in its
 * logs — see server.ts.
 */
export function assertNoExposedKeyAsLiveValueRecipient(
  env: Record<string, string | undefined> = process.env,
): LiveValueRecipientAudit {
  const audit = auditLiveValueRecipients(env);

  if (audit.status === 'violation') {
    const detail = audit.violations
      .map((v) => `  - ${v.varName}=${v.address}: ${v.reason}`)
      .join('\n');
    throw new Error(
      `[live-value-recipients] REFUSING TO ROUTE VALUE TO AN EXPOSED KEY (${audit.violations.length}):\n${detail}\n` +
        'Repoint the variable to the Provian treasury 0x086e0F377af1245B8888540f39e99A42a7daF1dA. ' +
        'KEEPER_FORBIDDEN_SIGNER_ADDRESS is a keeper-identity variable and is not a payout destination.',
    );
  }

  return audit;
}

/**
 * Request-time guard for a single resolved recipient, used at the point where
 * value is about to move. Throws with the same reason text as the boot guard.
 */
export function assertLiveValueRecipient(varName: string, address: string): void {
  const reason = FORBIDDEN_VALUE_RECIPIENTS.get(norm(address));
  if (reason) {
    throw new Error(
      `[live-value-recipients] ${varName} resolves to ${address}, which is ${reason}. Refusing to route value.`,
    );
  }
}
