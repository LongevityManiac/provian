/**
 * Test helpers: seed what the PE meter's batch commit leaves behind for an act — its 31-day act
 * key and its contribution to the economic aggregates — into the in-memory fake Firestore, so a
 * READ surface can be tested against the meter's real state shape without running the commit.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { PEHistoryDocument } from '../../../pe-history';
import type { FakeFirestore } from '../../pvt/__test-helpers__/fake-firestore';
import {
  ECONOMIC_AGGREGATE_SCHEMA_VERSION,
  EconomicAggregateWriter,
  PE_HISTORY_AGGREGATE_MARKER_FIELD,
} from '../../pvt/policy/economic-aggregate';
import { METER_ACT_KEYS_COLLECTION } from '../meter-store';

/** The act-key document for a priced row (the shape `meter-seal.ts` writes). */
export function actKeyDocFor(row: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const peId = String(row.peId);
  return {
    schema: 'provian.meter-act-key.v1',
    relay_pe_id: peId,
    client_pe_id: `client_${peId}`,
    pe_hash: 'a'.repeat(64),
    prev_hash: '0'.repeat(64),
    device_id: 'dev_test',
    batch_hash: 'b'.repeat(64),
    actor_id: row.userId,
    timestamp: row.timestamp,
    action_type: row.actionType,
    row,
    legs: null,
    unit: 'none',
    held_reason: null,
    side: {},
    created_at_ms: row.timestamp,
    facts: null,
    beneficiary_id: typeof row.beneficiary_wallet_id === 'string' ? row.beneficiary_wallet_id : null,
    expire_at: null,
    ...extra,
  };
}

/** Seed act keys only (no aggregate). */
export function seedActKeys(fake: FakeFirestore, rows: readonly Record<string, unknown>[]): void {
  for (const row of rows) fake.store.set(`${METER_ACT_KEYS_COLLECTION}/${String(row.peId)}`, actKeyDocFor(row));
}

/**
 * Seed rows as the batch commit would: each row born marked, its act key written, and its
 * contribution applied to every identity it is read under — in one fake transaction.
 */
export async function seedMeteredRows(
  fake: FakeFirestore,
  rows: readonly PEHistoryDocument[],
  nowMs: number,
  options: { readonly withActKeys?: boolean } = {},
): Promise<PEHistoryDocument[]> {
  const marked = rows.map((r) => ({
    ...(r as unknown as Record<string, unknown>),
    [PE_HISTORY_AGGREGATE_MARKER_FIELD]: ECONOMIC_AGGREGATE_SCHEMA_VERSION,
  }) as unknown as PEHistoryDocument);
  const db = fake as unknown as Firestore;
  await fake.runTransaction(async (txn) => {
    const writer = new EconomicAggregateWriter(
      db as unknown as ConstructorParameters<typeof EconomicAggregateWriter>[0],
      txn as unknown as ConstructorParameters<typeof EconomicAggregateWriter>[1],
      nowMs,
    );
    await writer.load(EconomicAggregateWriter.identitiesOf(...marked));
    for (const row of marked) writer.applyRow(row, 1);
    writer.commit();
  });
  if (options.withActKeys !== false) seedActKeys(fake, marked as unknown as Record<string, unknown>[]);
  return marked;
}
