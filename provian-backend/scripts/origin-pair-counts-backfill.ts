import { singleScanQuery } from '../src/core/provenance/private-store';
/**
 * PE METER cost pass — fold every pre-existing citation edge into the per-pair counts, open the
 * readers' gate, then give the old edges their 31-day TTL (ruling item 7: the relay keeps
 * "citation relationships as per-pair counts", not edges).
 *
 * tsx scripts/origin-pair-counts-backfill.ts [--execute]
 *
 * Dry run (counts only) unless --execute. Run it ONCE after deploying the relay that writes
 * folded edges; until it completes, every reader of an actor's whole citation history keeps
 * reading the edges (`citationPairCountsReady`), so nothing reads a partial history. Idempotent
 * and resumable: an edge is counted in the same transaction that marks it folded, so a re-run
 * (or a crash part-way) counts nothing twice. See `foldUnfoldedOriginEdges`.
 */
import admin from 'firebase-admin';
import { FieldPath } from 'firebase-admin/firestore';
import {
  ORIGIN_REFERENCE_GRAPH_COLLECTION,
  foldUnfoldedOriginEdges,
  type OriginEdge,
} from '../src/core/pvt/origin-reference-graph';
import { scriptDb } from './lib/script-db';

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? 'provian-ai' });
const db = scriptDb();
const execute = process.argv.slice(2).includes('--execute');

async function dryRun(): Promise<void> {
  let scanned = 0;
  let unfolded = 0;
  let noTtl = 0;
  let after: string | null = null;
  const source = singleScanQuery(db.collection(ORIGIN_REFERENCE_GRAPH_COLLECTION).orderBy(FieldPath.documentId()));
  for (;;) {
    let query = source.limit(1000);
    if (after !== null) query = query.startAfter(after);
    const page = await query.get();
    if (page.empty) break;
    after = page.docs[page.docs.length - 1].id;
    for (const d of page.docs) {
      const e = d.data() as OriginEdge;
      scanned += 1;
      if (e.pair_folded !== true) unfolded += 1;
      if (e.expire_at === undefined) noTtl += 1;
    }
    if (page.size < 1000) break;
  }
  console.log(JSON.stringify({ mode: 'dry_run', scanned, unfolded, without_ttl: noTtl }));
}

async function main(): Promise<void> {
  if (!execute) {
    await dryRun();
    return;
  }
  const report = await foldUnfoldedOriginEdges(db, { nowMs: Date.now(), log: (m) => console.log(m) });
  console.log(JSON.stringify({ mode: 'execute', ...report }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
