/**
 * Provenance Module
 *
 * Provenance Envelope system for auditable action history.
 */

export { default as ProvenanceEnvelopeManager } from './ProvenanceEnvelopeManager';
export { default as PELifecycleManager } from './PELifecycleManager';
export { default as PECloudSync } from './PECloudSync';

export * from './types';
export * from './lifecycleTypes';

// PE Chain Analyzer (Phase 3: Behavioral Anomaly Detection)
export {
    default as ProvenanceChainAnalyzer,
    type ChainAnalysisResult,
    type ContaminationResult,
    type ClassificationMismatchResult,
    type TemporalAnomalyResult,
} from './ProvenanceChainAnalyzer';

// Re-export chain integrity types
export type { ChainIntegrityResult, EnvelopeContext } from './ProvenanceEnvelopeManager';

// Phase 4: Environment Attestation types (re-exported from types.ts via *)
// EnvironmentState, EnvironmentStateMetadata are already exported via `export * from './types'`
