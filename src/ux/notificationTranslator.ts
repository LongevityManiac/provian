/**
 * Risk-to-Notification Translation Layer
 *
 * Converts internal risk assessment objects from the security engine
 * into plain-English notifications that non-technical users can understand.
 *
 * The security engine code is NOT modified. This layer sits on top.
 */

import type { ProvenanceEnvelope } from '../core/provenance/types';
import { generateCopy, generateDetailsExpander, type CopyContext } from './copyTemplates';

// =============================================================================
// INPUT / OUTPUT TYPES
// =============================================================================

/**
 * Risk assessment from the security engine - the input to this translator.
 * This is the bridge between the engine internals and user-facing copy.
 */
export interface RiskAssessment {
    /**
     * Composite anomaly score (0-100), supplied by the caller.
     *
     * NOT produced by any module in this tree: `AnomalyScorer` was deleted in
     * because it sat in no authorization path. This field is a copy INPUT for the
     * notification tier — whoever calls `translateNotification` provides it — and it
     * scores nothing on its own. Do not read it as evidence that anomaly scoring is
     * wired into a gate; it is not.
     */
    anomalyScore: number;
    /** Whether backend reclassified the action type */
    reclassified: boolean;
    /** Original action type before reclassification */
    originalActionType?: string;
    /** Action type after reclassification (or same as actionType if not reclassified) */
    reclassifiedActionType?: string;
    /** Reason for reclassification */
    reclassificationReason?: string;
    /** Whether ProvenanceChainAnalyzer detected a temporal anomaly */
    temporalAnomalyFired: boolean;
    /** Whether this is a previously unseen endpoint for this agent */
    isNewEndpoint: boolean;
    /** The destination URL or domain */
    endpoint?: string;
    /** Internal action type key */
    actionType: string;
    /** Data categories the bot wants to access/send */
    dataCategories: string[];
    /** Intent context from Phase 1 */
    intentContext?: {
        reasoningSummary?: string;
        externalInputsUsed?: string[];
    };
    /** PE chain for "why am I seeing this" expander */
    provenanceChain?: ProvenanceEnvelope[];
    /** Financial details (if applicable) */
    amount?: number;
    currency?: string;
    merchant?: string;
    /** Environment drift fields (Phase 4) */
    environmentDriftFields?: string[];
    /** Plugin name for skill install notifications */
    pluginName?: string;
}

export interface ButtonConfig {
    label: string;
    action: 'allow_once' | 'allow_always' | 'block' | 'keep_blocked' | 'show_details';
    isPrimary: boolean;
}

export interface UserNotification {
    /** Notification severity tier */
    tier: 1 | 2 | 3;
    /** Bold top line - the most important thing */
    headline: string;
    /** Plain English explanation */
    body: string;
    /** "Why am I seeing this?" expander content (for power users) */
    details?: string;
    /** Whether the bot was auto-paused (tier 3 only) */
    autoPaused: boolean;
}

// =============================================================================
// TIER CLASSIFICATION
// =============================================================================

/**
 * Classify a risk assessment into a notification tier.
 *
 * - Tier 1 (routine): New endpoint, low anomaly, no red flags
 * - Tier 2 (suspicious): Moderate anomaly OR reclassification OR temporal anomaly
 * - Tier 3 (serious): High anomaly OR multiple red flags combined
 */
export function classifyTier(assessment: RiskAssessment): 1 | 2 | 3 {
    const {
        anomalyScore,
        reclassified,
        temporalAnomalyFired,
        isNewEndpoint,
    } = assessment;

    // Tier 3: critical anomaly score
    if (anomalyScore >= 85) {
        return 3;
    }

    // Tier 3: multiple red flags combined
    if (temporalAnomalyFired && reclassified && anomalyScore > 60) {
        return 3;
    }

    // Tier 2: moderate-to-high anomaly
    if (anomalyScore >= 40) {
        return 2;
    }

    // Tier 2: reclassification alone
    if (reclassified) {
        return 2;
    }

    // Tier 2: temporal anomaly alone
    if (temporalAnomalyFired) {
        return 2;
    }

    // Tier 1: new endpoint, low anomaly, no red flags
    if (isNewEndpoint && anomalyScore < 40 && !reclassified && !temporalAnomalyFired) {
        return 1;
    }

    // Default to tier 1 for anything not caught above
    return 1;
}

// =============================================================================
// MAIN TRANSLATOR
// =============================================================================

/**
 * Convert a risk assessment from the security engine into a user notification.
 *
 * This is the core function of the UX translation layer.
 */
export function riskAssessmentToNotification(assessment: RiskAssessment): UserNotification {
    const tier = classifyTier(assessment);

    // Build copy context from assessment
    const copyCtx: CopyContext = {
        actionType: assessment.actionType,
        endpoint: assessment.endpoint,
        dataCategories: assessment.dataCategories,
        isNewEndpoint: assessment.isNewEndpoint,
        reclassified: assessment.reclassified,
        originalActionType: assessment.originalActionType,
        reclassifiedActionType: assessment.reclassifiedActionType,
        temporalAnomalyFired: assessment.temporalAnomalyFired,
        externalSources: assessment.intentContext?.externalInputsUsed,
        intentReasoning: assessment.intentContext?.reasoningSummary,
        environmentDriftFields: assessment.environmentDriftFields,
        pluginName: assessment.pluginName,
        amount: assessment.amount,
        currency: assessment.currency,
        merchant: assessment.merchant,
    };

    const { headline, body } = generateCopy(copyCtx, tier);

    // Generate "why am I seeing this?" expander
    const details = generateDetailsExpander({
        ...copyCtx,
        anomalyScore: assessment.anomalyScore,
        reclassificationReason: assessment.reclassificationReason,
    });

    return {
        tier,
        headline,
        body,
        details,
        autoPaused: tier === 3,
    };
}
