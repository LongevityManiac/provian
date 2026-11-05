/**
 * ONE-OFF remediation (NOT a standing job): purge pe_history for users who
 * invoked DELETE /v1/user/data BEFORE the field-name fix landed.
 *
 * Background: DELETE /v1/user/data deleted pe_history by snake `user_id` (it is
 * keyed by camelCase `userId`), so it matched ZERO pe_history docs — a user's
 * entire PE history silently survived "Delete All Data" (right-to-erasure
 * failure). The endpoint DID delete the `users` doc + provenance_envelopes +
 * agents/sessions/transactions correctly. So an affected user is one whose
 * `users` doc is gone but whose pe_history (userId=…) still exists.
 *
 * There is NO Firestore audit trail of who invoked the endpoint — the ONLY
 * authoritative record is Cloud Logging. Extract the affected userIds with:
 *
 *   gcloud logging read \
 *     'resource.type="cloud_run_revision" AND
 *      textPayload:"[UserDataDeletion] Starting deletion for user"' \
 *     --project=provian-ai --freshness=400d --format='value(textPayload)' \
 *     | sed -E 's/.*for user //' | sort -u
 *
 * Feed that list to this script. It DRY-RUNS by default (logs what it WOULD
 * delete + counts); it deletes only with --apply, and ONLY for ids whose `users`
 * doc is absent (the genuine-deletion safety guard) — never for a live user.
 *
 * Usage:
 *   tsx scripts/purge-orphaned-pe-history.ts --users=<id1>,<id2>,...        # dry run
 *   tsx scripts/purge-orphaned-pe-history.ts --users-file=./affected.txt    # dry run (one id per line)
 *   tsx scripts/purge-orphaned-pe-history.ts --users-file=./affected.txt --apply   # LIVE purge (confirmed)
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { scriptDb } from './lib/script-db';

admin.initializeApp();
const db = scriptDb();

interface Args {
  userIds: string[];
  apply: boolean;
  discover: boolean;
}

function parseArgs(argv: string[]): Args {
  let userIds: string[] = [];
  let apply = false;
  let discover = false;
  for (const a of argv.slice(2)) {
    if (a === '--apply') apply = true;
    else if (a === '--discover') discover = true;
    else if (a.startsWith('--users=')) {
      userIds = a.slice('--users='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a.startsWith('--users-file=')) {
      const raw = readFileSync(a.slice('--users-file='.length), 'utf8');
      userIds = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }
  }
  return { userIds: [...new Set(userIds)], apply, discover };
}

async function countPeHistory(userId: string): Promise<number> {
  const snap = await db.collection('pe_history').where('userId', '==', userId).count().get();
  return snap.data().count;
}

async function countProvenanceEnvelopes(userId: string): Promise<number> {
  const snap = await db.collection('provenance_envelopes').where('user_id', '==', userId).count().get();
  return snap.data().count;
}

/**
 * Retention-proof, data-driven discovery (when Cloud Logging no longer has the
 * [UserDataDeletion] lines): a genuine deletion victim has surviving pe_history
 * BUT no provenance_envelopes (those were deleted by the correct `user_id`
 * field) AND no `users` doc. Normal users/agents/provisional ids all retain
 * their provenance_envelopes, so they do NOT match this signature.
 */
async function discoverOrphanUserIds(): Promise<string[]> {
  const userIds = new Set<string>();
  let last: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db.collection('pe_history').orderBy('userId').limit(1000);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const d of snap.docs) {
      const uid = (d.data() as { userId?: unknown }).userId;
      if (typeof uid === 'string' && uid.length > 0) userIds.add(uid);
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 1000) break;
  }

  const orphans: string[] = [];
  for (const uid of userIds) {
    const [envCount, userDoc] = await Promise.all([
      countProvenanceEnvelopes(uid),
      db.collection('users').doc(uid).get(),
    ]);
    if (envCount === 0 && !userDoc.exists) orphans.push(uid);
  }
  console.log(`[discover] distinct pe_history userIds=${userIds.size}, orphan candidates=${orphans.length}`);
  return orphans;
}

async function deletePeHistory(userId: string): Promise<number> {
  let deleted = 0;
  // Page through (delete removes docs from the filter, so re-query advances).
  for (;;) {
    const snap = await db.collection('pe_history').where('userId', '==', userId).limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.size;
  }
  return deleted;
}

async function main(): Promise<void> {
  const { userIds: explicitIds, apply, discover } = parseArgs(process.argv);
  let userIds = explicitIds;
  if (discover) {
    const found = await discoverOrphanUserIds();
    userIds = [...new Set([...userIds, ...found])];
  }
  if (userIds.length === 0) {
    if (discover) {
      console.log('[purge] DRY-RUN COMPLETE — discover found 0 orphan userIds. Nothing to purge.');
      return;
    }
    console.error('No userIds provided. Pass --discover, --users=<csv>, or --users-file=<path>. See header.');
    process.exit(2);
  }

  console.log(`[purge] mode=${apply ? 'APPLY (LIVE)' : 'DRY-RUN'} | candidate userIds=${userIds.length}`);

  let affected = 0;            // genuine deletion victims (pe_history>0, no envelopes, no users doc)
  let skippedLive = 0;         // users doc still exists → NOT purged
  let skippedEmpty = 0;        // no surviving pe_history (already clean)
  let skippedHasEnvelopes = 0; // provenance_envelopes still exist → NOT a deletion victim → NOT purged
  let totalDocs = 0;           // pe_history docs that would be / were deleted

  for (const userId of userIds) {
    const [peCount, envCount, userDoc] = await Promise.all([
      countPeHistory(userId),
      countProvenanceEnvelopes(userId),
      db.collection('users').doc(userId).get(),
    ]);
    if (userDoc.exists) {
      console.warn(`[purge] SKIP ${userId}: users doc still exists (live user) — pe_history=${peCount}`);
      skippedLive++;
      continue;
    }
    if (peCount === 0) {
      skippedEmpty++;
      continue;
    }
    // Safety: only purge a userId whose provenance_envelopes are ALSO gone — that
    // is the deletion-victim signature. If envelopes survive, this is a normal
    // user/agent, NOT a Delete-All-Data victim; never nuke their PE history.
    if (envCount > 0) {
      console.warn(`[purge] SKIP ${userId}: ${envCount} provenance_envelopes still exist — NOT a deletion victim`);
      skippedHasEnvelopes++;
      continue;
    }
    affected++;
    totalDocs += peCount;
    if (apply) {
      const deleted = await deletePeHistory(userId);
      console.log(`[purge] DELETED ${deleted} pe_history docs for ${userId}`);
    } else {
      console.log(`[purge] WOULD DELETE ${peCount} pe_history docs for ${userId} (no envelopes, no users doc)`);
    }
  }

  console.log(
    `\n[purge] ${apply ? 'APPLIED' : 'DRY-RUN COMPLETE'} — affected users=${affected}, ` +
    `pe_history docs ${apply ? 'deleted' : 'to delete'}=${totalDocs}, ` +
    `skipped(live users)=${skippedLive}, skipped(already-clean)=${skippedEmpty}, ` +
    `skipped(has envelopes)=${skippedHasEnvelopes}`,
  );
  if (!apply) console.log('[purge] No data changed. Re-run with --apply to purge.');
}

main().catch((err) => {
  console.error('[purge] failed:', err);
  process.exit(1);
});
