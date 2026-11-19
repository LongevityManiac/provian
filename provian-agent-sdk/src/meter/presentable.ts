/**
 * PE METER — the PEs this device can present now.
 *
 * A pe_fact presentation carries the PE and its two-hop proof, so only a PE in a batch whose day is
 * anchored on Base (a verified proof is kept for that batch) can be presented. This lists those PEs
 * from ONE store — the live device's, opened by the caller — newest first, so an agent picks a PE
 * the presentation will accept instead of searching the files. A store left on the machine by an
 * earlier device is never read here: its PEs cannot be presented from this device.
 */

import { batchLeafOf } from '../meter-wire';
import type { PeStore } from './pe-store';

export interface PresentablePe {
  readonly pe_id: string;
  readonly pe_hash: string;
  readonly action_type: string;
  readonly timestamp: number;
  /** The anchored day (UTC) that proves it. */
  readonly day: string;
}

export const PRESENTABLE_PES_DEFAULT_LIMIT = 20;

/** Up to `limit` presentable PEs in `store`, newest first. */
export async function listPresentablePes(store: PeStore, options: { readonly limit?: number } = {}): Promise<PresentablePe[]> {
  const limit = Math.max(1, Math.min(options.limit ?? PRESENTABLE_PES_DEFAULT_LIMIT, 500));
  const proofs = (await store.listProofs()).filter((p) => p.verified);
  const batches = (await store.listBatches())
    .filter((b) => !b.adopted && b.acts_root !== null && b.actor_id !== null && b.count > 0)
    .sort((a, b) => b.first_index - a.first_index);
  const out: PresentablePe[] = [];
  for (const batch of batches) {
    const leaf = batchLeafOf({ device_id: store.deviceId, actor_id: batch.actor_id!, seq: batch.seq, batch_hash: batch.batch_hash, acts_root: batch.acts_root! });
    const anchor = proofs.find((p) => p.seq === batch.seq && p.batch_hash === batch.batch_hash && p.acts_root === batch.acts_root
      && p.actor_id === batch.actor_id && p.batch_leaf === leaf);
    if (!anchor) continue;
    const pes = await store.readPes(batch.first_index, batch.count);
    for (let i = pes.length - 1; i >= 0 && out.length < limit; i--) {
      const pe = pes[i].pe;
      out.push({ pe_id: pe.pe_id, pe_hash: pe.pe_hash, action_type: pe.action_type, timestamp: pe.timestamp, day: anchor.anchor.day });
    }
    if (out.length >= limit) break;
  }
  return out;
}
