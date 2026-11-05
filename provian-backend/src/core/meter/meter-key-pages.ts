import { Timestamp } from 'firebase-admin/firestore';
import type { MeterActKeyDoc } from './meter-act-key';
export const METER_KEY_PAGES = 'meter_key_pages_v1';
export interface MeterKeyPage {
  schema: 'provian.meter-key-page.v1';
  batch_hash: string;
  actor_id: string;
  keys: Record<string, MeterActKeyDoc>;
  expire_at: FirebaseFirestore.Timestamp | null;
}
export function meterKeyPointer(key: MeterActKeyDoc, page: string): Record<string, unknown> {
  const { row: _row, side: _side, facts: _facts, legs: _legs, ...fields } = key;
  return { ...fields, _meter_key_page: page };
}
export function buildMeterKeyPages(batchHash: string, actorId: string, keys: readonly MeterActKeyDoc[]): { id: string; page: MeterKeyPage }[] {
  const pages: { id: string; page: MeterKeyPage }[] = [];
  let current: MeterActKeyDoc[] = [], size = 0;
  const flush = (): void => {
    if (!current.length) return;
    pages.push({ id: batchHash + '~' + pages.length, page: { schema: 'provian.meter-key-page.v1', batch_hash: batchHash, actor_id: actorId,
      keys: Object.fromEntries(current.map(key => [key.relay_pe_id, key])),
      expire_at: current.some(key => key.expire_at == null) ? null : Timestamp.fromMillis(Math.max(...current.map(key => key.expire_at!.toMillis()))) } });
    current = []; size = 0;
  };
  for (const key of keys) {
    const bytes = Buffer.byteLength(JSON.stringify(key));
    if (current.length && size + bytes > 600_000) flush();
    current.push(key); size += bytes;
  }
  flush(); return pages;
}
