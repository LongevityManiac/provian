/**
 * FootprintService - Energy Estimation Engine
 *
 * Computes energy estimates from PE data and imported chat histories.
 * Bridges @afp/core-lab calculations into the Provian PE ecosystem.
 *
 * Drop into: src/core/footprint/FootprintService.ts
 */

import {
  ENERGY_CONSTANTS,
  EnergyConfidence,
  EnergyEstimationMethod,
  FootprintEntry,
  FootprintSource,
  FootprintSummary,
  PEEnergyEstimate,
  TimeRange,
} from './types';
import { FootprintStore } from './FootprintStore';
import type { ProvenanceEnvelope } from '../provenance/types';

const {
  WH_PER_TEXT_TOKEN,
  WH_PER_IMAGE,
  WH_PER_10SEC_VIDEO,
  CHARS_PER_TOKEN,
  WH_PER_PHONE_CHARGE,
  MICROWAVE_SECONDS_PER_WH,
  GLOBAL_AVG_CARBON_INTENSITY,
} = ENERGY_CONSTANTS;

// ─────────────────────────────────────────────────────────────────
// ESTIMATION FUNCTIONS (ported from @afp/core-lab)
// ─────────────────────────────────────────────────────────────────

export function estimateTextWh(charCount: number): number {
  const tokens = Math.ceil(charCount / CHARS_PER_TOKEN);
  return tokens * WH_PER_TEXT_TOKEN;
}

export function estimateTokenWh(tokenCount: number): number {
  return tokenCount * WH_PER_TEXT_TOKEN;
}

export function estimateImageWh(imageCount: number): number {
  return imageCount * WH_PER_IMAGE;
}

export function estimateVideoWh(videoSeconds: number): number {
  return (videoSeconds / 10) * WH_PER_10SEC_VIDEO;
}

export function getMicrowaveSeconds(totalWh: number): number {
  return totalWh * MICROWAVE_SECONDS_PER_WH;
}

export function getPhoneCharges(totalWh: number): number {
  return totalWh / WH_PER_PHONE_CHARGE;
}

export function estimateCO2g(totalWh: number, gridIntensity?: number): number {
  const intensity = gridIntensity ?? GLOBAL_AVG_CARBON_INTENSITY;
  return (totalWh / 1000) * intensity;
}

// ─────────────────────────────────────────────────────────────────
// ANALOGY FORMATTING
// ─────────────────────────────────────────────────────────────────

export function formatMicrowaveTime(seconds: number): string {
  if (seconds < 1) return '< 1 sec';
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (secs === 0) return `${mins} min`;
  return `${mins} min ${secs} sec`;
}

export function formatPhoneCharges(charges: number): string {
  if (charges < 0.01) return '< 0.01';
  if (charges < 1) return charges.toFixed(2);
  if (charges < 10) return charges.toFixed(1);
  return Math.round(charges).toString();
}

export function formatWh(wh: number): string {
  if (wh < 0.001) return '< 0.001 Wh';
  if (wh < 1) return `${wh.toFixed(3)} Wh`;
  if (wh < 1000) return `${wh.toFixed(1)} Wh`;
  return `${(wh / 1000).toFixed(2)} kWh`;
}

// ─────────────────────────────────────────────────────────────────
// PE → ENERGY ESTIMATE
// ─────────────────────────────────────────────────────────────────

/**
 * Extract energy estimate from a ProvenanceEnvelope.
 * Uses the best available data in the PE to compute watt-hours.
 */
export function estimateFromPE(pe: ProvenanceEnvelope): PEEnergyEstimate {
  // If PE already has a provider-disclosed energy annotation, use it
  const existing = (pe as any).energy_estimate as PEEnergyEstimate | undefined;
  if (existing?.confidence === 'measured' || existing?.confidence === 'corroborated') {
    return existing;
  }

  // Otherwise estimate from PE metadata
  let wh = 0;
  let method: EnergyEstimationMethod = 'pe-token-count';
  let confidence: EnergyConfidence = 'estimated';

  // Agent actions carry the richest data
  if (pe.action_type === 'agent_action' || pe.action_type === 'agent_authorization') {
    // Parse intent_text length as a proxy for token volume
    const intentChars = pe.intent_text?.length ?? 0;
    wh += estimateTextWh(intentChars);

    // If the PE has simulation_summary, that's additional compute
    if (pe.simulation_summary) {
      wh += estimateTextWh(pe.simulation_summary.length);
    }

    confidence = 'estimated';
  }
  // Wallet transactions have minimal compute footprint
  else if (['send', 'swap', 'stake', 'onramp', 'receive'].includes(pe.action_type)) {
    // Transaction verification compute is minimal - ~0.001-0.01 Wh
    wh = 0.005;
    confidence = 'inferred';
    method = 'pe-resource-fields';
  }
  // Promise actions
  else if (pe.action_type.startsWith('promise_') || pe.action_type === 'agreement' || pe.action_type === 'agreement_settled') {
    wh = 0.001; // Negligible compute
    confidence = 'inferred';
    method = 'pe-resource-fields';
  }
  // Default: minimal estimate
  else {
    const textChars = (pe.intent_text?.length ?? 0) + (pe.simulation_summary?.length ?? 0);
    wh = textChars > 0 ? estimateTextWh(textChars) : 0.001;
    confidence = 'inferred';
  }

  const co2 = estimateCO2g(wh);

  return {
    estimatedWh: wh,
    confidence,
    method,
    estimatedCO2g: co2,
  };
}

/**
 * Determine the FootprintSource from a PE action type.
 */
function sourceFromPE(pe: ProvenanceEnvelope): FootprintSource {
  if (pe.action_type === 'agent_action' || pe.action_type === 'agent_authorization' ||
      pe.action_type.startsWith('agent_')) {
    return 'provian-agent';
  }
  if (pe.action_type.startsWith('promise_') || pe.action_type === 'agreement' ||
      pe.action_type === 'agreement_settled') {
    return 'provian-promise';
  }
  return 'provian-wallet';
}

// ─────────────────────────────────────────────────────────────────
// PE INGESTION - call this after every PE is created
// ─────────────────────────────────────────────────────────────────

/**
 * Process a newly created PE and record its energy footprint.
 * Call from ProvenanceEnvelopeManager.createEnvelope() after signing.
 */
export async function ingestPE(pe: ProvenanceEnvelope): Promise<void> {
  const estimate = estimateFromPE(pe);
  const entry: Omit<FootprintEntry, 'id'> = {
    timestamp: pe.timestamp,
    source: sourceFromPE(pe),
    totalWh: estimate.estimatedWh,
    confidence: estimate.confidence,
    method: estimate.method,
    charCount: pe.intent_text?.length,
    envelopeId: pe.envelope_id,
    actionType: pe.action_type,
    archived: false,
  };

  await FootprintStore.addEntry(entry);
}

// ─────────────────────────────────────────────────────────────────
// CHAT IMPORT - reuses @afp/core-lab logic
// ─────────────────────────────────────────────────────────────────

export interface ChatImportData {
  provider: 'chatgpt' | 'claude' | 'gemini' | 'perplexity';
  charCount: number;
  imageCount: number;
  videoSeconds: number;
  note?: string;
}

const PROVIDER_TO_SOURCE: Record<string, FootprintSource> = {
  chatgpt: 'import-chatgpt',
  claude: 'import-claude',
  gemini: 'import-gemini',
  perplexity: 'import-perplexity',
};

export async function ingestChatImport(data: ChatImportData): Promise<FootprintEntry> {
  const textWh = estimateTextWh(data.charCount);
  const imageWh = estimateImageWh(data.imageCount);
  const videoWh = estimateVideoWh(data.videoSeconds);
  const totalWh = textWh + imageWh + videoWh;

  const entry: Omit<FootprintEntry, 'id'> = {
    timestamp: Date.now(),
    source: PROVIDER_TO_SOURCE[data.provider] ?? 'manual',
    totalWh,
    confidence: 'inferred',
    method: 'chat-import-chars',
    charCount: data.charCount,
    imageCount: data.imageCount,
    videoSeconds: data.videoSeconds,
    providerId: data.provider,
    note: data.note,
    archived: false,
  };

  return FootprintStore.addEntry(entry);
}

// ─────────────────────────────────────────────────────────────────
// MANUAL ENTRY
// ─────────────────────────────────────────────────────────────────

export interface ManualEntryData {
  tokens?: number;
  charCount?: number;
  images?: number;
  videoSeconds?: number;
  source?: string;
  note?: string;
}

export async function ingestManualEntry(data: ManualEntryData): Promise<FootprintEntry> {
  let tokenWh = 0;
  if (data.charCount && data.charCount > 0) {
    tokenWh = estimateTextWh(data.charCount);
  } else if (data.tokens && data.tokens > 0) {
    tokenWh = estimateTokenWh(data.tokens);
  }
  const imageWh = estimateImageWh(data.images ?? 0);
  const videoWh = estimateVideoWh(data.videoSeconds ?? 0);
  const totalWh = tokenWh + imageWh + videoWh;

  const entry: Omit<FootprintEntry, 'id'> = {
    timestamp: Date.now(),
    source: 'manual',
    totalWh,
    confidence: 'inferred',
    method: 'manual-entry',
    charCount: data.charCount,
    tokenCount: data.tokens,
    imageCount: data.images,
    videoSeconds: data.videoSeconds,
    note: data.note,
    archived: false,
  };

  return FootprintStore.addEntry(entry);
}

// ─────────────────────────────────────────────────────────────────
// SUMMARY / AGGREGATION
// ─────────────────────────────────────────────────────────────────

function getTimestampForRange(range: TimeRange): number | undefined {
  if (range === 'all') return undefined;
  const now = Date.now();
  switch (range) {
    case 'day': return now - 24 * 60 * 60 * 1000;
    case 'week': return now - 7 * 24 * 60 * 60 * 1000;
    case 'month': return now - 30 * 24 * 60 * 60 * 1000;
  }
}

export async function getSummary(range: TimeRange): Promise<FootprintSummary> {
  const since = getTimestampForRange(range);
  const entries = await FootprintStore.getEntries(since);

  const totalWh = entries.reduce((sum, e) => sum + e.totalWh, 0);
  const bySource: Partial<Record<FootprintSource, number>> = {};
  const byConfidence: Partial<Record<EnergyConfidence, number>> = {};

  for (const entry of entries) {
    bySource[entry.source] = (bySource[entry.source] ?? 0) + entry.totalWh;
    byConfidence[entry.confidence] = (byConfidence[entry.confidence] ?? 0) + entry.totalWh;
  }

  return {
    totalWh,
    entryCount: entries.length,
    microwaveSeconds: getMicrowaveSeconds(totalWh),
    phoneCharges: getPhoneCharges(totalWh),
    bySource,
    byConfidence,
    estimatedCO2g: estimateCO2g(totalWh),
  };
}

// ─────────────────────────────────────────────────────────────────
// WATTLING CITY LEVEL (from AI Footprint)
// ─────────────────────────────────────────────────────────────────

export function getCityLevel(wh: number): number {
  if (wh < 2) return 1;
  if (wh < 10) return 2;
  if (wh < 50) return 3;
  if (wh < 100) return 4;
  if (wh < 250) return 5;
  if (wh < 500) return 6;
  if (wh < 1000) return 7;
  if (wh < 2500) return 8;
  if (wh < 5000) return 9;
  return 10;
}

export const CITY_DESCRIPTIONS: Record<number, string> = {
  1: 'A quiet village begins',
  2: 'A few lights flicker on',
  3: 'The town is taking shape',
  4: 'Streets are getting busy',
  5: 'A small city emerges',
  6: 'The skyline is growing',
  7: 'A thriving metropolis',
  8: 'The city never sleeps',
  9: 'A megacity of energy',
  10: 'Maximum Wattage',
};

// ─────────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────────

const FootprintService = {
  estimateTextWh,
  estimateTokenWh,
  estimateImageWh,
  estimateVideoWh,
  getMicrowaveSeconds,
  getPhoneCharges,
  estimateCO2g,
  formatMicrowaveTime,
  formatPhoneCharges,
  formatWh,
  estimateFromPE,
  ingestPE,
  ingestChatImport,
  ingestManualEntry,
  getSummary,
  getCityLevel,
};

export default FootprintService;
