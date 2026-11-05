/**
 * PE meter cost pass (2026-10-04) — one-time: give the per-pair citation count of every
 * ring-flagged edge still on the relay its indexed `ring_flagged` marker (pairs folded before the
 * marker existed lack it). Dry run by default; `--execute` writes. Idempotent.
 *
 *   npx tsx scripts/pair-ring-flag-backfill.ts [--execute]
 */
import admin from 'firebase-admin';
import {
  CITATION_PAIR_COUNTS_COLLECTION,
  citationPairId,
  ORIGIN_REFERENCE_GRAPH_COLLECTION,
  type OriginEdge,
} from '../src/core/pvt/origin-reference-graph';
import { scriptDb } from './lib/script-db';

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  if (admin.apps.length === 0) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? 'provian-ai' });
  const db = scriptDb();
  const snap = await db.collection(ORIGIN_REFERENCE_GRAPH_COLLECTION).where('closed_loop', '==', true).get();
  const pairIds = new Set<string>();
  for (const doc of snap.docs) {
    const e = doc.data() as OriginEdge;
    if (typeof e.owner === 'string' && e.owner.length > 0) pairIds.add(citationPairId(e.signer, e.owner));
  }
  let flagged = 0;
  let missing = 0;
  for (const id of pairIds) {
    const ref = db.collection(CITATION_PAIR_COUNTS_COLLECTION).doc(id);
    const pair = await ref.get();
    if (!pair.exists) {
      missing += 1;
      continue;
    }
    if (pair.data()?.ring_flagged === true) continue;
    if (execute) await ref.set({ ring_flagged: true }, { merge: true });
    flagged += 1;
  }
  console.log(JSON.stringify({ execute, ring_edges: snap.size, pairs: pairIds.size, flagged, missing }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
