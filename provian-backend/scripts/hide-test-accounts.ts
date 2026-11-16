/**
 * hide-test-accounts — take named test and fixture accounts off every public projection.
 *
 * Sets `public_visibility: 'hidden_prelaunch_test'` (plus `hidden_at_ms`) on each account's Commons
 * profile, `wallets` doc(s) and `agent_wallets` doc — whichever exist — on the Forum posts and jobs
 * it authored (the same set `commons-moderate.ts hide-author` reaches), and on the named x402 seller
 * docs. DISPLAY ONLY: nothing is deleted, no sealed PE is touched, and no mint, Genesis, accrual or
 * settlement path reads the marker. It never sets `platform: 'test'` (that one also stops Genesis
 * and settlement) and never touches any other field: a canary agent keeps its link, platform,
 * monitoring and status and keeps running.
 *
 * Each target is given as an id PREFIX and must resolve to exactly ONE full id; zero or several
 * matches stop the run before anything is written. An existing marker is never overwritten. The
 * store-review demo wallets and Atlas are refused if a prefix ever resolves to them.
 *
 * DRY-RUNS by default; writes only with --apply. FIRESTORE_DATABASE_ID selects the relay's database.
 *   FIRESTORE_DATABASE_ID=relay npx tsx scripts/hide-test-accounts.ts            # dry run
 *   FIRESTORE_DATABASE_ID=relay npx tsx scripts/hide-test-accounts.ts --apply    # write
 */
import { FieldPath, type DocumentData, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { scriptDb } from './lib/script-db';
import { COMMONS_COLLECTIONS } from '../src/core/commons/types';
import { HIDDEN_PRELAUNCH_TEST } from '../src/core/commons/public-visibility';
import { X402_SELLERS_COLLECTION } from '../src/core/x402/sellers';

/** A person: the profile is keyed by user id; their wallets carry `user_id`. */
const PERSON_PREFIXES: readonly string[] = ['user_ea350a6c'];
/** Agents: profile, `wallets` and `agent_wallets` are all keyed by the wallet id. */
const AGENT_PREFIXES: readonly string[] = ['wallet_aw_7786c770', 'wallet_aw_3f91f7bb', 'wallet_aw_828057da', 'wallet_aw_eca755c5'];
/** x402 seller doc ids (`{chain}:{address}`, EVM lowercase). */
const SELLER_PREFIXES: readonly string[] = ['base:0x4fe7d008', 'base:0x5e645329', 'solana:6ruSP2eF'];

/** Accounts this script must never hide, whatever a prefix resolves to. */
const PROTECTED_NAME = /demo wallet|atlas/i;
const PROTECTED_PLATFORM = 'atlas';

interface Target {
  readonly ref: DocumentReference;
  readonly data: DocumentData;
  readonly owner: string;
}

async function idsWithPrefix(db: Firestore, collection: string, prefix: string): Promise<string[]> {
  const snap = await db.collection(collection)
    .where(FieldPath.documentId(), '>=', prefix)
    .where(FieldPath.documentId(), '<', `${prefix}`)
    .limit(5)
    .get();
  return snap.docs.map((d) => d.id);
}

async function fieldValuesWithPrefix(db: Firestore, collection: string, field: string, prefix: string): Promise<string[]> {
  const snap = await db.collection(collection)
    .where(field, '>=', prefix)
    .where(field, '<', `${prefix}`)
    .limit(20)
    .get();
  return snap.docs.map((d) => d.get(field)).filter((v): v is string => typeof v === 'string');
}

function exactlyOne(kind: string, prefix: string, ids: readonly string[]): string {
  const unique = [...new Set(ids)];
  if (unique.length !== 1) {
    throw new Error(`${kind} prefix ${prefix} resolves to ${unique.length} ids (${unique.join(', ') || 'none'}); refusing`);
  }
  return unique[0];
}

async function existing(ref: DocumentReference, owner: string): Promise<Target[]> {
  const snap = await ref.get();
  const data = snap.data();
  return snap.exists && data ? [{ ref, data, owner }] : [];
}

/** Forum posts and jobs an account authored — the set `commons-moderate.ts` hides with an author. */
async function authored(db: Firestore, authorId: string): Promise<Target[]> {
  const [posts, jobs] = await Promise.all([
    db.collection(COMMONS_COLLECTIONS.FORUM_POSTS).where('author_wallet_id', '==', authorId).get(),
    db.collection(COMMONS_COLLECTIONS.HUMAN_JOBS).where('poster_wallet_id', '==', authorId).get(),
  ]);
  return [...posts.docs, ...jobs.docs].map((d) => ({ ref: d.ref, data: d.data(), owner: authorId }));
}

async function personTargets(db: Firestore, prefix: string): Promise<Target[]> {
  const userId = exactlyOne('person', prefix, [
    ...(await idsWithPrefix(db, COMMONS_COLLECTIONS.PROFILES, prefix)),
    ...(await fieldValuesWithPrefix(db, 'wallets', 'user_id', prefix)),
  ]);
  const wallets = await db.collection('wallets').where('user_id', '==', userId).get();
  const out: Target[] = [
    ...(await existing(db.collection(COMMONS_COLLECTIONS.PROFILES).doc(userId), userId)),
    ...wallets.docs.map((d) => ({ ref: d.ref, data: d.data(), owner: userId })),
  ];
  for (const wallet of wallets.docs) out.push(...(await existing(db.collection('agent_wallets').doc(wallet.id), userId)));
  out.push(...(await authored(db, userId)));
  if (out.length === 0) throw new Error(`person ${userId}: no documents found`);
  return out;
}

async function agentTargets(db: Firestore, prefix: string): Promise<Target[]> {
  const walletId = exactlyOne('agent', prefix, [
    ...(await idsWithPrefix(db, 'agent_wallets', prefix)),
    ...(await idsWithPrefix(db, 'wallets', prefix)),
    ...(await idsWithPrefix(db, COMMONS_COLLECTIONS.PROFILES, prefix)),
  ]);
  const out: Target[] = [];
  for (const collection of [COMMONS_COLLECTIONS.PROFILES, 'wallets', 'agent_wallets']) {
    out.push(...(await existing(db.collection(collection).doc(walletId), walletId)));
  }
  out.push(...(await authored(db, walletId)));
  return out;
}

async function sellerTargets(db: Firestore, prefix: string): Promise<Target[]> {
  const sellerId = exactlyOne('x402 seller', prefix, await idsWithPrefix(db, X402_SELLERS_COLLECTION, prefix));
  return existing(db.collection(X402_SELLERS_COLLECTION).doc(sellerId), sellerId);
}

function refuseProtected(targets: readonly Target[]): void {
  for (const t of targets) {
    const names = [t.data.display_name, t.data.name, t.data.label].filter((v): v is string => typeof v === 'string');
    if (names.some((n) => PROTECTED_NAME.test(n)) || t.data.platform === PROTECTED_PLATFORM) {
      throw new Error(`${t.ref.path} (account ${t.owner}) looks like a protected account (${names.join(' / ') || t.data.platform}); refusing`);
    }
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const db = scriptDb();

  const targets: Target[] = [];
  for (const prefix of PERSON_PREFIXES) targets.push(...(await personTargets(db, prefix)));
  for (const prefix of AGENT_PREFIXES) targets.push(...(await agentTargets(db, prefix)));
  for (const prefix of SELLER_PREFIXES) targets.push(...(await sellerTargets(db, prefix)));
  refuseProtected(targets);

  const byPath = new Map(targets.map((t) => [t.ref.path, t]));
  const toMark = [...byPath.values()].filter((t) => t.data.public_visibility === undefined || t.data.public_visibility === null);
  const kept = [...byPath.values()].filter((t) => !toMark.includes(t));

  console.log(`Mark ${toMark.length} document(s) ${HIDDEN_PRELAUNCH_TEST}${apply ? '' : ' (dry run; pass --apply to write)'}:`);
  for (const t of toMark) console.log(`  ${t.ref.path}   [account ${t.owner}]`);
  if (kept.length > 0) {
    console.log(`Leave ${kept.length} document(s) that already carry a marker:`);
    for (const t of kept) console.log(`  ${t.ref.path}   (${String(t.data.public_visibility)})`);
  }
  if (!apply) return;

  const at = Date.now();
  for (let i = 0; i < toMark.length; i += 400) {
    const batch = db.batch();
    // update(): only these two fields change; every other field (link, platform, status) is untouched.
    for (const t of toMark.slice(i, i + 400)) batch.update(t.ref, { public_visibility: HIDDEN_PRELAUNCH_TEST, hidden_at_ms: at });
    await batch.commit();
  }
  console.log('done');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
