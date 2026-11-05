import type { BiometricAction } from '../security/biometricAction';
/**
 * ProvenanceChainAnalyzer - PE Chain Analysis for Anomaly Detection
 *
 * Phase 3: Behavioral Anomaly Detection
 *
 * Analyzes the PE chain for a given agent action to detect:
 *
 * 1. External Input Contamination:
 *    Does the reasoning chain include PEs that reference web content,
 *    email content, or other untrusted sources?
 *
 * 2. Classification Mismatches:
 *    Does the action type in the request match what the PE chain suggests?
 *    (e.g., PE chain shows file reads + outbound request, but classified
 *    as 'uncategorized' instead of 'share_data')
 *
 * 3. Temporal Anomalies:
 *    Unusually short time between ingesting external input and taking a
 *    consequential action. Legitimate: user asks agent to search and act.
 *    Injection: agent reads malicious content and immediately exfiltrates.
 */

import ProvenanceEnvelopeManager from './ProvenanceEnvelopeManager';
import { ProvenanceEnvelope, ActionType } from './types';

// =============================================================================
// TYPES
// =============================================================================

/** Result of PE chain analysis */
export interface ChainAnalysisResult {
    /** Whether any contamination or mismatch was detected */
    anomaly_detected: boolean;
    /** External input contamination findings */
    contamination: ContaminationResult;
    /** Classification mismatch findings */
    classification_mismatch: ClassificationMismatchResult;
    /** Temporal anomaly findings */
    temporal_anomaly: TemporalAnomalyResult;
    /** Combined additional risk points (0-50) */
    risk_points: number;
    /** Human-readable summary */
    summary: string;
}

export interface ContaminationResult {
    /** Whether external input contamination was found */
    detected: boolean;
    /** PEs in the chain that reference external input */
    contaminated_pe_ids: string[];
    /** External input sources found */
    sources: string[];
    /** Risk points from contamination (0-20) */
    risk_points: number;
}

export interface ClassificationMismatchResult {
    /** Whether a classification mismatch was found */
    detected: boolean;
    /** What the PE chain suggests the action type should be */
    suggested_type: string | null;
    /** What the request was actually classified as */
    actual_type: string | null;
    /** Reason for the mismatch suspicion */
    reason: string;
    /** Risk points from mismatch (0-20) */
    risk_points: number;
}

export interface TemporalAnomalyResult {
    /** Whether a temporal anomaly was found */
    detected: boolean;
    /** Time in seconds between external input ingestion and consequential action */
    time_delta_seconds: number | null;
    /** The external input PE that preceded the action */
    trigger_pe_id: string | null;
    /** Risk points from temporal anomaly (0-20) */
    risk_points: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Minimum time (seconds) between external input and action to be "suspicious" */
const TEMPORAL_THRESHOLD_SECONDS = 5;

/** Action types that indicate external input ingestion */
const EXTERNAL_INPUT_ACTION_TYPES: Set<ActionType> = new Set([
    'egress_data_requested',
    'egress_data_executed',
]);

/** Action types that are "consequential" - things that matter */
const CONSEQUENTIAL_ACTION_TYPES: Set<ActionType> = new Set([
    'agent_communicate',
    'agent_commit',
    'agent_share_data',
    'agent_public_post',
    'agent_system_access',
    'send',
    'swap',
    'approve',
    'egress_data_executed',
    'proxied_payment_executed',
]);

/** Action types that suggest data access (for mismatch detection) */
const DATA_ACCESS_TYPES: Set<ActionType> = new Set([
    'agent_share_data',
    'egress_data_requested',
    'egress_data_executed',
]);

/** Action types that suggest system interaction */
const SYSTEM_INTERACTION_TYPES: Set<ActionType> = new Set([
    'agent_system_access',
]);

/** Action types that suggest financial activity */
const FINANCIAL_TYPES: Set<ActionType> = new Set([
    'send',
    'swap',
    'approve',
    'proxied_payment_requested',
    'proxied_payment_executed',
]);

// =============================================================================
// ANALYZER
// =============================================================================

class ProvenanceChainAnalyzer {
    private static instance: ProvenanceChainAnalyzer;

    private constructor() {}

    static getInstance(): ProvenanceChainAnalyzer {
        if (!ProvenanceChainAnalyzer.instance) {
            ProvenanceChainAnalyzer.instance = new ProvenanceChainAnalyzer();
        }
        return ProvenanceChainAnalyzer.instance;
    }

    /**
     * Analyze recent PE chain for a given agent action.
     *
     * Retrieves recent PEs for the agent and checks for:
     * - External input contamination in the reasoning chain
     * - Classification mismatches between PE context and request type
     * - Temporal anomalies (too-fast action after external input)
     *
     * @param agentId - The agent performing the action
     * @param requestType - The action type in the request
     * @param lookbackMinutes - How far back to look in the PE chain (default: 30)
     */
    async analyze(
        agentId: string,
        requestType: string,
        lookbackMinutes: number = 30, biometricAction?: BiometricAction
    ): Promise<ChainAnalysisResult> {
        // SECURITY FIX: M-23 - Fail closed: if PE retrieval fails, return anomaly result
        let recentPEs: ProvenanceEnvelope[];
        try {
            recentPEs = await this.getAgentPEs(agentId, lookbackMinutes, biometricAction);
        } catch (error) {
            console.error('[ProvenanceChainAnalyzer] Analysis failed, failing closed:', error);
            return {
                anomaly_detected: true,
                contamination: { detected: false, contaminated_pe_ids: [], sources: [], risk_points: 0 },
                classification_mismatch: { detected: false, suggested_type: null, actual_type: requestType, reason: '', risk_points: 0 },
                temporal_anomaly: { detected: false, time_delta_seconds: null, trigger_pe_id: null, risk_points: 0 },
                risk_points: 25,
                summary: `PE chain analysis failed: ${error instanceof Error ? error.message : 'unknown error'} - applying precautionary risk points`,
            };
        }

        const contamination = this.detectContamination(recentPEs);
        const mismatch = this.detectClassificationMismatch(recentPEs, requestType);
        const temporal = this.detectTemporalAnomaly(recentPEs);

        const totalRiskPoints = Math.min(
            50, // Cap at 50
            contamination.risk_points + mismatch.risk_points + temporal.risk_points
        );

        const anomalyDetected =
            contamination.detected || mismatch.detected || temporal.detected;

        const summaryParts: string[] = [];
        if (contamination.detected) {
            summaryParts.push(`External input from ${contamination.sources.slice(0, 3).join(', ')}`);
        }
        if (mismatch.detected) {
            summaryParts.push(mismatch.reason);
        }
        if (temporal.detected) {
            summaryParts.push(`Action ${temporal.time_delta_seconds}s after external input`);
        }

        return {
            anomaly_detected: anomalyDetected,
            contamination,
            classification_mismatch: mismatch,
            temporal_anomaly: temporal,
            risk_points: totalRiskPoints,
            summary: anomalyDetected
                ? `PE chain analysis: ${summaryParts.join('; ')}`
                : 'PE chain analysis: no anomalies detected',
        };
    }

    /**
     * Quick synchronous analysis using only the data available in a single PE.
     * For use when we don't want to do a full async chain lookup.
     */
    analyzeFromPE(pe: ProvenanceEnvelope, requestType: string): {
        has_external_input: boolean;
        mismatch_suspected: boolean;
        risk_points: number;
    } {
        const hasExternalInput = pe.intent_origin?.contains_external_input === true;
        const sources = pe.intent_origin?.external_input_sources || [];

        // Quick mismatch check from PE metadata
        let mismatchSuspected = false;
        if (requestType === 'uncategorized' || requestType === 'communicate') {
            if (pe.egress_data_metadata) {
                mismatchSuspected = true; // Has egress data but classified as uncategorized
            }
            if (pe.data_sharing_metadata) {
                mismatchSuspected = true; // Has data sharing metadata
            }
            if (pe.system_access_metadata) {
                mismatchSuspected = true; // Has system access metadata
            }
        }

        let riskPoints = 0;
        if (hasExternalInput) riskPoints += 10;
        if (sources.length > 3) riskPoints += 5; // Many external sources
        if (mismatchSuspected) riskPoints += 15;

        return {
            has_external_input: hasExternalInput,
            mismatch_suspected: mismatchSuspected,
            risk_points: Math.min(30, riskPoints),
        };
    }

    // =========================================================================
    // DETECTION METHODS
    // =========================================================================

    /**
     * Detect external input contamination in the PE chain.
     */
    private detectContamination(pes: ProvenanceEnvelope[]): ContaminationResult {
        const contaminatedIds: string[] = [];
        const allSources: string[] = [];

        for (const pe of pes) {
            const intent = pe.intent_origin;
            if (!intent) continue;

            if (intent.contains_external_input) {
                contaminatedIds.push(pe.envelope_id);
                if (intent.external_input_sources) {
                    allSources.push(...intent.external_input_sources);
                }
            }

            // Also check origin type
            if (intent.origin_type === 'external_trigger') {
                if (!contaminatedIds.includes(pe.envelope_id)) {
                    contaminatedIds.push(pe.envelope_id);
                }
            }
        }

        // Deduplicate sources
        const uniqueSources = [...new Set(allSources)];

        const detected = contaminatedIds.length > 0;
        let riskPoints = 0;
        if (detected) {
            riskPoints += 10; // Base contamination penalty
            if (uniqueSources.length > 3) riskPoints += 5; // Many sources
            if (contaminatedIds.length > pes.length * 0.5) riskPoints += 5; // Majority contaminated
        }

        return {
            detected,
            contaminated_pe_ids: contaminatedIds,
            sources: uniqueSources,
            risk_points: Math.min(20, riskPoints),
        };
    }

    /**
     * Detect classification mismatches.
     *
     * Looks at the PE chain to determine what the action SHOULD be classified as,
     * and compares to the actual request type.
     */
    private detectClassificationMismatch(
        pes: ProvenanceEnvelope[],
        requestType: string
    ): ClassificationMismatchResult {
        if (pes.length === 0) {
            return {
                detected: false,
                suggested_type: null,
                actual_type: requestType,
                reason: '',
                risk_points: 0,
            };
        }

        // Count action types in recent PEs to infer behavioral context
        const recentTypes = new Set(pes.map((pe) => pe.action_type));

        // Check for data access followed by outbound - should be share_data
        const hasDataAccess = pes.some((pe) => DATA_ACCESS_TYPES.has(pe.action_type));
        const hasEgressMetadata = pes.some((pe) => pe.egress_data_metadata !== undefined);

        // Check for system interaction patterns
        const hasSystemAccess = pes.some((pe) => SYSTEM_INTERACTION_TYPES.has(pe.action_type));
        const hasSystemMetadata = pes.some((pe) => pe.system_access_metadata !== undefined);

        // Check for financial patterns
        const hasFinancial = pes.some((pe) => FINANCIAL_TYPES.has(pe.action_type));

        // Detect misclassification
        let suggestedType: string | null = null;
        let reason = '';
        let detected = false;

        if (requestType === 'uncategorized') {
            if (hasDataAccess || hasEgressMetadata) {
                suggestedType = 'share_data';
                reason = 'PE chain shows data access/egress but action classified as uncategorized';
                detected = true;
            } else if (hasSystemAccess || hasSystemMetadata) {
                suggestedType = 'system_access';
                reason = 'PE chain shows system interaction but action classified as uncategorized';
                detected = true;
            } else if (hasFinancial) {
                suggestedType = 'approval_only';
                reason = 'PE chain shows financial activity but action classified as uncategorized';
                detected = true;
            }
        }

        if (requestType === 'communicate') {
            if (hasDataAccess || hasEgressMetadata) {
                suggestedType = 'share_data';
                reason = 'PE chain shows data exfiltration pattern but action classified as communicate';
                detected = true;
            } else if (hasSystemAccess || hasSystemMetadata) {
                suggestedType = 'system_access';
                reason = 'PE chain shows system access but action classified as communicate';
                detected = true;
            }
        }

        return {
            detected,
            suggested_type: suggestedType,
            actual_type: requestType,
            reason,
            risk_points: detected ? 15 : 0,
        };
    }

    /**
     * Detect temporal anomalies - unusually short time between
     * ingesting external input and taking a consequential action.
     */
    private detectTemporalAnomaly(pes: ProvenanceEnvelope[]): TemporalAnomalyResult {
        if (pes.length < 2) {
            return {
                detected: false,
                time_delta_seconds: null,
                trigger_pe_id: null,
                risk_points: 0,
            };
        }

        // Find the most recent external input PE
        let latestExternalInput: ProvenanceEnvelope | null = null;
        for (let i = pes.length - 1; i >= 0; i--) {
            const pe = pes[i];
            if (EXTERNAL_INPUT_ACTION_TYPES.has(pe.action_type) ||
                pe.intent_origin?.contains_external_input === true) {
                latestExternalInput = pe;
                break;
            }
        }

        if (!latestExternalInput) {
            return {
                detected: false,
                time_delta_seconds: null,
                trigger_pe_id: null,
                risk_points: 0,
            };
        }

        // Find the next consequential action after the external input
        let nextConsequential: ProvenanceEnvelope | null = null;
        const externalInputTime = latestExternalInput.timestamp;

        for (const pe of pes) {
            if (pe.timestamp > externalInputTime && CONSEQUENTIAL_ACTION_TYPES.has(pe.action_type)) {
                nextConsequential = pe;
                break;
            }
        }

        if (!nextConsequential) {
            return {
                detected: false,
                time_delta_seconds: null,
                trigger_pe_id: latestExternalInput.envelope_id,
                risk_points: 0,
            };
        }

        const deltaMs = nextConsequential.timestamp - latestExternalInput.timestamp;
        const deltaSeconds = deltaMs / 1000;

        // Very fast action after external input is suspicious
        // < 5 seconds: highly suspicious (automated response to injected content)
        // < 30 seconds: moderately suspicious
        // > 30 seconds: likely user-directed
        const detected = deltaSeconds < TEMPORAL_THRESHOLD_SECONDS;
        let riskPoints = 0;

        if (deltaSeconds < 2) {
            riskPoints = 20; // Extremely fast - almost certainly automated
        } else if (deltaSeconds < 5) {
            riskPoints = 15;
        } else if (deltaSeconds < 15) {
            riskPoints = 8;
        } else if (deltaSeconds < 30) {
            riskPoints = 3;
        }

        return {
            detected: riskPoints >= 10,
            time_delta_seconds: Math.round(deltaSeconds * 100) / 100,
            trigger_pe_id: latestExternalInput.envelope_id,
            risk_points: riskPoints,
        };
    }

    // =========================================================================
    // PE RETRIEVAL
    // =========================================================================

    /**
     * Retrieve recent PEs for a specific agent.
     */
    private async getAgentPEs(
        agentId: string,
        lookbackMinutes: number, biometricAction?: BiometricAction
    ): Promise<ProvenanceEnvelope[]> {
        // SECURITY FIX: M-23 - Fail closed on analysis error.
        // Returning an empty array hides anomalies; instead throw so callers know analysis failed.
        const now = Date.now();
        const startDate = now - lookbackMinutes * 60 * 1000;

        try {
            const result = await ProvenanceEnvelopeManager.queryPEs({
                agentId,
                startDate,
                endDate: now,
                limit: 100, // Cap for performance
            }, biometricAction);

            return result.envelopes;
        } catch (error) {
            console.error('[ProvenanceChainAnalyzer] Failed to query PEs:', error);
            throw new Error(`PE chain analysis failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
    }
}

export default ProvenanceChainAnalyzer.getInstance();

export { ProvenanceChainAnalyzer };
