/**
 * AI Footprint Module - Core Types
 *
 * Extends the PE schema with energy estimation fields and defines
 * all data models for the footprint tracking system.
 *
 * Drop into: src/core/footprint/types.ts
 */

// ─────────────────────────────────────────────────────────────────
// PE SCHEMA EXTENSION
// Add `energy_estimate?: PEEnergyEstimate` to the ProvenanceEnvelope
// interface in src/core/provenance/types.ts
// ─────────────────────────────────────────────────────────────────

export type EnergyConfidence = 'measured' | 'corroborated' | 'estimated' | 'inferred';

export interface ProviderEnergyAnnotation {
  reportedWh?: number;
  hardwareClass?: string;
  pue?: number;
  gridCarbonIntensityGCO2?: number;
  gridRegion?: string;
}

export interface PEEnergyEstimate {
  estimatedWh: number;
  confidence: EnergyConfidence;
  method: EnergyEstimationMethod;
  providerAnnotation?: ProviderEnergyAnnotation;
  estimatedCO2g?: number;
}

export type EnergyEstimationMethod =
  | 'pe-token-count'
  | 'pe-resource-fields'
  | 'chat-import-chars'
  | 'manual-entry'
  | 'provider-disclosed'
  | 'device-metered';

// ─────────────────────────────────────────────────────────────────
// FOOTPRINT ENTRY
// ─────────────────────────────────────────────────────────────────

export type FootprintSource =
  | 'provian-agent'
  | 'provian-wallet'
  | 'provian-promise'
  | 'import-chatgpt'
  | 'import-claude'
  | 'import-gemini'
  | 'import-perplexity'
  | 'manual';

export interface FootprintEntry {
  id: string;
  timestamp: number;
  source: FootprintSource;
  totalWh: number;
  confidence: EnergyConfidence;
  method: EnergyEstimationMethod;
  charCount?: number;
  tokenCount?: number;
  imageCount?: number;
  videoSeconds?: number;
  envelopeId?: string;
  actionType?: string;
  providerId?: string;
  modelId?: string;
  note?: string;
  archived: boolean;
}

// ─────────────────────────────────────────────────────────────────
// AGGREGATION
// ─────────────────────────────────────────────────────────────────

export type TimeRange = 'day' | 'week' | 'month' | 'all';

export interface FootprintSummary {
  totalWh: number;
  entryCount: number;
  microwaveSeconds: number;
  phoneCharges: number;
  bySource: Partial<Record<FootprintSource, number>>;
  byConfidence: Partial<Record<EnergyConfidence, number>>;
  estimatedCO2g: number;
}

// ─────────────────────────────────────────────────────────────────
// ENERGY MODEL CONSTANTS (from @afp/core-lab)
// ─────────────────────────────────────────────────────────────────

export const ENERGY_CONSTANTS = {
  WH_PER_TEXT_TOKEN: 0.0004,
  WH_PER_IMAGE: 2.9,
  WH_PER_10SEC_VIDEO: 100,
  CHARS_PER_TOKEN: 4,
  WH_PER_PHONE_CHARGE: 12,
  MICROWAVE_SECONDS_PER_WH: 3.6,
  GLOBAL_AVG_CARBON_INTENSITY: 436,
} as const;
