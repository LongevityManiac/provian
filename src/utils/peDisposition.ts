import { translate } from '../i18n/translate';
/**
 * peDisposition — the per-PE earning DISPOSITION and its display chip.
 *
 * MONEY-SAFETY RULE (the whole reason this file exists): a shown earning figure
 * is ONLY ever the eligible-only settlement projection (`currentSettlementProjectionPVT`)
 * or, on the detail screen, the exact Genesis reserved GROSS — NEVER a record-points
 * sum. Record points are not PVT; a `record_only` PE mints 0 no matter how large its
 * points, so its points must never appear as earnings anywhere.
 *
 * The relay's `mint_status` has 17 values (pe-history.ts). This collapses them into
 * the small set the UI renders. An unrecognized / missing status maps to `unknown`,
 * which renders NO earning claim (never overclaims a legacy or unmapped row).
 *
 * COLOR RULE (theme.ts header — PLATINUM OWNS THE ASSET, AMBER OWNS THE MOMENT):
 * a chip that names PVT as an asset (`earning` = will mint PVT, `minted` = PVT
 * settled) is COLORS.platinum. `pending` is a status (COLORS.warning, the amber
 * status semantic) and `record_only` is muted text. Never amber for the asset.
 */

import { COLORS } from '../constants/theme';

export type PEDisposition = 'earning' | 'pending' | 'minted' | 'record_only' | 'unknown';

/**
 * Collapse the relay's 17-value `mint_status` into a display disposition.
 *  - earning     : sealed eligible (or actively minting) → will mint.
 *  - minted      : already settled on-chain.
 *  - pending     : recorded and may still become eligible (deferred / under review /
 *                  awaiting epoch headroom / beneficiary or cache pending).
 *  - record_only : recorded, never mints (record-only, ineligible, duplicate,
 *                  farm-capped, no observable output, unverified x402).
 *  - unknown     : null / unrecognized (legacy rows) → render no earning claim.
 */
export function normalizeMintStatus(mintStatus: string | null | undefined): PEDisposition {
    switch (mintStatus) {
        case 'eligible':
        case 'minting':
            return 'earning';
        case 'minted':
            return 'minted';
        case 'deferred':
        case 'pending_evidence':
        case 'pending_review':
        case 'pending_cache':
        case 'pending_compliance':
        case 'genesis_epoch_deferred':
        case 'epoch_headroom_deferred':
        case 'settlement_retry_deferred':
        case 'beneficiary_pending':
            return 'pending';
        case 'record_only':
        case 'ineligible':
        case 'skipped_no_output':
        case 'corroborated_duplicate':
        case 'farm_capped':
        case 'x402_unverified':
            return 'record_only';
        default:
            return 'unknown';
    }
}

export interface EarningChip {
    disposition: PEDisposition;
    /** Chip text, e.g. "Earns ~1.2 PVT · pending", "No separate mint", "Minted". */
    label: string;
    /** Theme color for the chip foreground/border. */
    color: string;
    /** Subtle background tint for the chip. */
    backgroundColor: string;
    /**
     * item 09: the tap-through explanation for the chip (what a bottom
     * sheet shows when the row's chip is tapped). Present for `record_only` the
     * canonical mint-once explanation — so "No separate mint"
     * is never two bare words. `explainerKey` is the i18n key the app resolves;
     * `explainer` is the English fallback shipped with this module.
     */
    explainerKey?: string;
    explainer?: string;
    /** Public status page an agent/human can open for the row's action type. */
    statusUrl?: string;
}

/** Public earning-type registry page. */
export const PROPOSALS_STATUS_URL = 'https://provian.ai/proposals';

/** Inputs the chip needs. All amounts are display strings from the relay. */
export interface EarningChipInput {
    mintStatus: string | null | undefined;
    /**
     * The eligible-only settlement projection (rate × eligible points). NULL when
     * no live settlement-factor is available — which is the current state, so the
     * chip shows "pending" without a number rather than a wrong one. NEVER pass
     * a record-points value here.
     */
    currentSettlementProjectionPVT?: string | null;
}

const TINT = (hex: string): string => `${hex}22`;

/**
 * Build the earning chip for a PE row. Returns null for the `unknown` disposition
 * so a legacy/unmapped row renders no chip rather than an unfounded claim.
 */
export function buildEarningChip(input: EarningChipInput): EarningChip | null {
    if (input.mintStatus === 'pending_compliance') {
        return {
            disposition: 'pending',
            label: translate('pe.disposition.complianceHold.label', 'Mint held'),
            color: COLORS.warning,
            backgroundColor: TINT(COLORS.warning),
            explainerKey: 'pe.disposition.complianceHold.explainer',
            explainer: translate('pe.disposition.complianceHold.explainer', 'Minting is held under the jurisdiction policy. Your sealed value is kept. It mints automatically through normal settlement when the hold lifts.'),
        };
    }
    return chipForDisposition(
        normalizeMintStatus(input.mintStatus),
        input.currentSettlementProjectionPVT,
    );
}

/**
 * Build a chip directly from a display disposition (used for a commit GROUP, whose
 * disposition is the best-of across its member PEs). The amount, when shown, is
 * still only the eligible-only projection — never record points.
 */
export function chipForDisposition(
    disposition: PEDisposition,
    projectionPVT?: string | null,
): EarningChip | null {
    const amount = projectionPVT;
    const hasAmount = typeof amount === 'string' && amount.length > 0 && amount !== '0.0' && amount !== '0';

    switch (disposition) {
        case 'earning':
            return {
                disposition,
                label: hasAmount ? translate('pe.disposition.earningAmount', `Earns ~${amount} PVT · pending`, { amount }) : translate('pe.disposition.earning', 'Earning · pending'),
                color: COLORS.platinum,
                backgroundColor: TINT(COLORS.platinum),
            };
        case 'minted':
            return {
                disposition,
                label: translate('pe.disposition.minted', 'Minted ✓'),
                color: COLORS.platinum,
                backgroundColor: TINT(COLORS.platinum),
            };
        case 'pending':
            return {
                disposition,
                label: translate('pe.disposition.pending', 'Pending'),
                color: COLORS.warning,
                backgroundColor: TINT(COLORS.warning),
            };
        case 'record_only':
            return {
                disposition,
                label: translate('pe.disposition.recordOnly.label', 'No separate mint'),
                color: COLORS.textSecondary,
                backgroundColor: TINT(COLORS.textSecondary),
                explainerKey: 'pe.disposition.recordOnly.explainer',
                explainer: translate('pe.disposition.recordOnly.explainer', "This envelope is sealed proof in your chain. It does not mint separately because its value lands on another PE, it is a circular PVT-cost event, it is a denial, failure, expiry, no-op, security, policy, or identity event, or it is the unknown-action fallback. Your underlying act of work still mints once at its best-supported value."),
                statusUrl: PROPOSALS_STATUS_URL,
            };
        case 'unknown':
        default:
            return null;
    }
}
