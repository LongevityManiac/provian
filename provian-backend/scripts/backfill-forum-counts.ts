/**
 * backfill-forum-counts — forum redesign: give every stored forum post the tree + ranking
 * fields the new feed, comment tree and replies inbox read (`root_post_id`, `depth`,
 * `parent_author_wallet_id`, `reply_count`, `comment_count`, `score`, `hot_score`), derived from the
 * posts themselves — never from the incremental counters it is repairing.
 *
 * The derivation is the pure, unit-tested `planForumBackfill` (src/core/commons/forum-backfill.ts);
 * this script only reads, prints, and (with --apply) writes the plan. IDEMPOTENT: it writes only the
 * fields whose stored value differs from the derived one, so a second run plans nothing. Replies
 * created between the read and the write are counted by the live writer's own transactional
 * increments; a re-run after the deploy settles any in-flight drift.
 *
 * CUTOVER ORDER: deploy the indexes (firestore.indexes.json) and code, then run this once.
 *
 * DRY-RUNS by default; writes only with --apply.
 *
 * Usage:
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/backfill-forum-counts.ts # dry run
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/backfill-forum-counts.ts --apply # LIVE
 */

import admin from 'firebase-admin';
import { COMMONS_COLLECTIONS, type CommonsForumPost } from '../src/core/commons/types';
import { planForumBackfill, type BackfillRow } from '../src/core/commons/forum-backfill';
import { scriptDb } from './lib/script-db';

admin.initializeApp();
const db = scriptDb();

async function readAllPosts(): Promise<BackfillRow[]> {
  const rows: BackfillRow[] = [];
  const PAGE = 500;
  let last: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db.collection(COMMONS_COLLECTIONS.FORUM_POSTS)
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(PAGE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    for (const doc of snap.docs) rows.push({ id: doc.id, data: doc.data() as Partial<CommonsForumPost> });
    if (snap.size < PAGE) break;
    last = snap.docs[snap.docs.length - 1];
  }
  return rows;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(`Mode: ${apply ? 'APPLY (live writes)' : 'DRY RUN'}\n`);

  const rows = await readAllPosts();
  const plan = planForumBackfill(rows);
  const topLevel = rows.filter((r) => !r.data.parent_post_id).length;
  console.log(`Forum posts: ${rows.length} (${topLevel} top-level, ${rows.length - topLevel} replies); rows to update: ${plan.length}`);
  for (const { id, update } of plan) console.log(`  ${id}: ${JSON.stringify(update)}`);

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write.');
    return;
  }

  let batch = db.batch();
  let ops = 0;
  for (const { id, update } of plan) {
    batch.update(db.collection(COMMONS_COLLECTIONS.FORUM_POSTS).doc(id), update);
    ops += 1;
    if (ops === 400) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  console.log(`Done. Updated ${plan.length} rows.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
