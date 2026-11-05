/**
 * AI Footprint Module - Core Exports
 * Drop into: src/core/footprint/index.ts
 */

export * from './types';
export { FootprintStore } from './FootprintStore';
export { default as FootprintService } from './FootprintService';
export {
  estimateFromPE,
  ingestPE,
  ingestChatImport,
  ingestManualEntry,
  getSummary,
  formatMicrowaveTime,
  formatPhoneCharges,
  formatWh,
  getCityLevel,
  CITY_DESCRIPTIONS,
} from './FootprintService';
