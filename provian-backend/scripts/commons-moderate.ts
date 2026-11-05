/**
 * commons-moderate — act on a "Report to Provian" (Terms §16.6, Commons conduct).
 *
 * Removes reported content, or a whole account, from every Commons view by setting the
 * `hidden_moderation` marker (`src/core/commons/public-visibility.ts`). Display only: nothing is
 * deleted, no sealed PE is touched, and no mint, Genesis, accrual or settlement path reads the
 * marker. `restore` clears it.
 *
 *   hide-post <postId>        one Forum post or reply
 *   hide-author <walletId>    every Forum post, reply and job by that author, their Commons
 *                             profile, and their wallet in the Directory and leaderboards
 *   restore-post <postId> | restore-author <walletId>
 *
 * DRY-RUNS by default; writes only with --apply. FIRESTORE_DATABASE_ID selects the relay's database.
 *   FIRESTORE_DATABASE_ID=relay npx tsx scripts/commons-moderate.ts hide-post <postId> --apply
 */
import { FieldValue, type DocumentReference } from 'firebase-admin/firestore';
import { scriptDb } from './lib/script-db';
import { COMMONS_COLLECTIONS } from '../src/core/commons/types';
import { HIDDEN_MODERATION } from '../src/core/commons/public-visibility';

const db = scriptDb();

async function authorRefs(walletId: string): Promise<DocumentReference[]> {
  const refs: DocumentReference[] = [];
  const posts = await db.collection(COMMONS_COLLECTIONS.FORUM_POSTS).where('author_wallet_id', '==', walletId).get();
  refs.push(...posts.docs.map((d) => d.ref));
  const jobs = await db.collection(COMMONS_COLLECTIONS.HUMAN_JOBS).where('poster_wallet_id', '==', walletId).get();
  refs.push(...jobs.docs.map((d) => d.ref));
  for (const collection of [COMMONS_COLLECTIONS.PROFILES, 'wallets', 'agent_wallets']) {
    const ref = db.collection(collection).doc(walletId);
    if ((await ref.get()).exists) refs.push(ref);
  }
  return refs;
}

async function main(): Promise<void> {
  const [command, id] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const apply = process.argv.includes('--apply');
  if (!command || !id || !/^(hide|restore)-(post|author)$/.test(command)) {
    console.error('usage: commons-moderate.ts hide-post|hide-author|restore-post|restore-author <id> [--apply]');
    process.exit(2);
  }
  const hide = command.startsWith('hide');
  let refs: DocumentReference[];
  if (command.endsWith('post')) {
    const ref = db.collection(COMMONS_COLLECTIONS.FORUM_POSTS).doc(id);
    if (!(await ref.get()).exists) throw new Error(`no Forum post ${id}`);
    refs = [ref];
  } else {
    refs = await authorRefs(id);
    if (refs.length === 0) throw new Error(`nothing found for author ${id}`);
  }
  // Never overwrite or clear another marker (a prelaunch fixture, a revoked burn): hide only what is
  // public now, restore only what this script hid.
  const current = await Promise.all(refs.map(async (ref) => (await ref.get()).data()?.public_visibility));
  refs = refs.filter((_, i) => (hide ? current[i] === undefined || current[i] === null : current[i] === HIDDEN_MODERATION));
  console.log(`${hide ? 'Hide' : 'Restore'} ${refs.length} document(s)${apply ? '' : ' (dry run; pass --apply to write)'}:`);
  for (const ref of refs) console.log(`  ${ref.path}`);
  if (!apply) return;
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + 400)) {
      batch.update(ref, hide
        ? { public_visibility: HIDDEN_MODERATION, moderated_at_ms: Date.now() }
        : { public_visibility: FieldValue.delete(), moderated_at_ms: FieldValue.delete() });
    }
    await batch.commit();
  }
  console.log('done');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
