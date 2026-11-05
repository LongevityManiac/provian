import type { Firestore } from 'firebase-admin/firestore';

export const PE_BUG_SIGNAL_COLLECTION = 'ops_pe_bug_signals_v1';
export const PE_BUG_SIGNAL_SCHEMA = 'ops-pe-bug-signal/v1';

export interface PeBugSignal {
  readonly schema_version: typeof PE_BUG_SIGNAL_SCHEMA;
  readonly pe_id: string;
  readonly sealed_value_atomic: string;
  readonly configured_threshold_atomic: string;
  readonly recorded_at_ms: number;
  readonly created_at_ms: number;
  readonly delivered_at_ms: number | null;
  readonly delivery_attempts: number;
}

export function buildPeBugSignal(input: {
  peId: string;
  sealedValueAtomic: string;
  thresholdAtomic: bigint;
  recordedAtMs: number;
}): PeBugSignal | null {
  if (BigInt(input.sealedValueAtomic) < input.thresholdAtomic) return null;
  return {
    schema_version: PE_BUG_SIGNAL_SCHEMA,
    pe_id: input.peId,
    sealed_value_atomic: input.sealedValueAtomic,
    configured_threshold_atomic: input.thresholdAtomic.toString(),
    recorded_at_ms: input.recordedAtMs,
    created_at_ms: input.recordedAtMs,
    delivered_at_ms: null,
    delivery_attempts: 0,
  };
}
