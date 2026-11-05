import type { MeterActOutcome } from './meter-seal';

export interface BatchWorkBucket {
  total: number;
  by_type: Record<string, number>;
  by_witness_class: Record<string, number>;
  by_seal_status: Record<string, number>;
  by_type_status: Record<string, Record<string, number>>;
  by_capture_lane: Record<string, { total: number; earning_acts: number; record_points_atomic: string }>;
}
export interface BatchWorkSummary {
  readonly schema: 'provian.batch-work-summary.v1';
  readonly coverage_since_ms: number | null;
  readonly oldest_ms: number | null;
  readonly newest_ms: number | null;
  readonly days: Readonly<Record<string, BatchWorkBucket>>;
}
/** Count only outcomes admitted to the canonical actor counters. No act ids, bodies or prices
 * reconstructed from history. Status is the seal-time status; it is never called current status.
 */
export function batchWorkSummary(outcomes: readonly MeterActOutcome[]): BatchWorkSummary {
  const dictionary = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
  const days = dictionary<BatchWorkBucket>();
  let oldest: number | null = null, newest: number | null = null;
  const add = (map: Record<string, number>, key: string): void => { map[key] = (map[key] ?? 0) + 1; };
  for (const o of outcomes) {
    const row = o.row;
    const ts = Number(row.timestamp);
    if (!Number.isFinite(ts)) throw new Error('batch_work_summary_timestamp_invalid');
    const day = new Date(ts).toISOString().slice(0, 10);
    const b = days[day] ??= { total: 0, by_type: dictionary<number>(), by_witness_class: dictionary<number>(), by_seal_status: dictionary<number>(), by_type_status: dictionary<Record<string, number>>(), by_capture_lane: dictionary<{ total: number; earning_acts: number; record_points_atomic: string }>() };
    oldest = Math.min(oldest ?? ts, ts); newest = Math.max(newest ?? ts, ts);
    const type = String(row.actionType), status = String(row.mint_status ?? 'unknown');
    b.total++; add(b.by_type, type); add(b.by_seal_status, status);
    if (typeof row.witness_class === 'string') add(b.by_witness_class, row.witness_class);
    add(b.by_type_status[type] ??= dictionary<number>(), status);
    const lane = typeof row.capture_lane === 'string' ? row.capture_lane : 'unknown';
    const l = b.by_capture_lane[lane] ??= { total: 0, earning_acts: 0, record_points_atomic: '0' };
    l.total++;
    if (status === 'eligible' || status === 'minted') {
      l.earning_acts++;
      l.record_points_atomic = (BigInt(l.record_points_atomic) + BigInt(String(row.record_points_atomic ?? '0'))).toString();
    }
  }
  const rawCoverage = Number(process.env.METER_BATCH_SUMMARY_START_MS);
  return { schema: 'provian.batch-work-summary.v1', coverage_since_ms: Number.isSafeInteger(rawCoverage) && rawCoverage > 0 ? rawCoverage : null,
    oldest_ms: oldest, newest_ms: newest, days };
}
