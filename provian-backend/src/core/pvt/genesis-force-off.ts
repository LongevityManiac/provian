/**
 * THE GENESIS DEPLOY-LEVEL BREAK-GLASS — one predicate, one source.
 *
 * `GENESIS_CAMPAIGN_FORCE_OFF` was documented everywhere as the Genesis kill switch: CLAUDE.md
 * cites it, `genesis-campaign.ts` calls it "a deploy-level break-glass", the admin readout
 * reports it, and STATUS.md tracked its value across milestones. It gated nothing that could
 * originate a grant. Its only refusal lived in `reserveGenesisIssuance`, a function with ZERO
 * production callers; the three armed fixed-grant legs run through
 * `shouldPersistGenesisQualification`, which never read it.
 *
 * A gate whose only deny sits in dead code is worse than no gate. No gate is a known gap. This
 * read as protection in every document that mentioned it, and setting it to `true` — as
 * production had — bought exactly nothing while looking like a closed rail.
 *
 * So it is WIRED rather than retired: the name now means what it always claimed to. It is
 * consulted by `shouldPersistGenesisQualification`, the one predicate every Genesis origination
 * path actually passes through, and by the campaign config loader as before.
 *
 * FAIL SAFE, NOT FAIL CLOSED, AND DELIBERATELY SO. Only the exact strings `'true'` and `'1'`
 * engage the break-glass, matching the behaviour `genesis-campaign.ts` has always had. An unset
 * or mangled variable leaves Genesis RUNNING, because this is a kill switch and not an arming
 * key: a deploy that loses an env var must not silently stop a live campaign. The arming
 * decision is made by the activation document, which fails closed on its own.
 */

/** The deploy-level break-glass variable. */
export const GENESIS_FORCE_OFF_ENV = 'GENESIS_CAMPAIGN_FORCE_OFF';

/**
 * True when the deploy-level Genesis break-glass is engaged.
 *
 * Both call sites — the campaign config loader and the persist gate — MUST use this function so
 * the switch cannot be honoured in one path and ignored in the other, which is the exact shape
 * of the defect it is fixing.
 */
export function isGenesisForcedOff(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const v = env[GENESIS_FORCE_OFF_ENV];
  return v === 'true' || v === '1';
}
