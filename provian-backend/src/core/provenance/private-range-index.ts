import type { DocumentData } from 'firebase-admin/firestore';
/** Operational timestamps/cursor only; no amount, identity or work content. */
export const PRIVATE_RANGE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  github_webhook_inbox_v1: ['available_at'],
  mint_compliance_events_v1: ['location_expires_at_ms'],
  wallet_jurisdiction_sessions_v1: ['retention_until_ms'],
  pvt9_claim_ledger_v1: ['created_at'],
  pvt9_settlement_batches_v1: ['updated_at', 'cursor_end_n'],
};
export function privateRecordRange(collection: string, data: DocumentData): Record<string, number> {
  const out: Record<string, number> = {};
  for (const field of PRIVATE_RANGE_FIELDS[collection] ?? []) {
    const value: unknown = data[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('private_range_field_invalid');
    out[field] = value;
  }
  return out;
}
