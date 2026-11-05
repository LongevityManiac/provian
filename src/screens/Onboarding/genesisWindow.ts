/**
 * Genesis campaign window — the clock that retires the onboarding Genesis step.
 *
 * The Genesis slide is a campaign surface, not a permanent part of the story, so
 * it expires on its own rather than waiting for someone to remember to delete it.
 * A "remove this later" comment is not a plan; it is a defect with no deadline
 * attached. When the window closes the step, its hero image, and its accent drop
 * out of the flow automatically and the flow returns to five steps.
 *
 * `GENESIS_WINDOW_END_MS` mirrors `window.end_ms` in the approved policy record
 * `provian-backend/src/core/pvt/policy/proposed-genesis-policy.ts`
 * (2027-01-01T00:00:00Z — open through 2026-12-31,), which is the value STATUS.md also carries. It is
 * duplicated here as a literal because the mobile bundle cannot import backend
 * policy; `genesisWindow.test.ts` pins it so the two cannot drift silently.
 *
 * NOTE: `config/pvt9-base.json`'s `chain_observed_reference_only` block is
 * declared `authority: none` and nothing reads it. The approved policy record is
 * the source of truth here; moved the close to 2027-01-01T00:00:00Z on the
 * successor kernel, whose on-chain `genesisEndsAt` is the same instant.
 *
 * Copy never states the date. This clock only decides whether the step renders.
 *
 * Shutdown coverage : if Provian announces a shutdown date D before this close, the
 * relay stops admitting Genesis at D (`PVT_ACCRUAL_END_MS`). Onboarding runs before a wallet
 * exists and reads no relay signal, so the shutdown procedure ships an app release with
 * `GENESIS_WINDOW_END_MS` set to D (and `genesisWindow.test.ts`, which pins it) at the
 * announcement.
 */

/** 2027-01-01T00:00:00Z — approved Genesis window close (open through 2026-12-31,). */
export const GENESIS_WINDOW_END_MS = 1_798_761_600_000;

/**
 * GENESIS IS ARMED AND ADMITTING. Do not add a second "is it really live?" flag
 * here — one was added on 2026-08-04 and was WRONG, and it hid a live campaign.
 *
 * The single live gate is `proposedArmedGenesisWindow()` in
 * `provian-backend/src/core/pvt/genesis-award-state-machine.ts`, which opens only
 * when ALL of these hold in `proposed-genesis-policy.ts` verified true:
 *
 * arming.state === 'armed_by_explicit_pvt9_activation'
 * arming.grants_enabled === true
 * window.approval.status === 'wp12_launch_dates_explicitly_approved'
 * every bounty launch_armed && explicit_pvt9_launch_activation
 * window 2026-08-03 → 2026-12-31 (end_ms 2027-01-01T00:00:00Z)
 *
 * Two things that look like liveness signals and are NOT:
 * - `GENESIS_CAMPAIGN_POLICY` as a Cloud Run env var. It has never been one;
 * the campaign is not configured through the environment. Its absence there
 * proves nothing.
 * - Firestore `pvt_config/genesis_campaign` with `enabled: false`. That is the
 * RETIRED Phase-0 config (pool caps, decay, funding bounties, all removed by
 * /). It does not gate the PVT9 Genesis lane.
 *
 * So the only thing this module decides is whether the approved window has
 * closed. Check the backend gate above before ever changing that.
 */

/**
 * True while the Genesis campaign step should still be shown.
 *
 * Fail-closed on an unusable clock: a NaN or non-finite `nowMs` retires the step
 * rather than showing a campaign that may already be over.
 */
export function isGenesisWindowOpen(nowMs: number = Date.now()): boolean {
    if (!Number.isFinite(nowMs)) return false;
    return nowMs < GENESIS_WINDOW_END_MS;
}
