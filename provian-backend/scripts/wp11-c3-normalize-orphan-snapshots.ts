/**
 * cutover reconciliation/the ONE authorized C3 normalization write.
 *
 * C3 (`C3_recipients_resolve`) fails on exactly two legacy orphan snapshots in
 * `pvt_mint_batch_snapshots`, each holding ONE mixed-case EIP-55 entry in its
 * contributor_addresses array. Only that casing is normalized; the scope
 * does not waive reconciliation or change any committed leaf.
 *
 * SCOPE, STATED EXACTLY:
 * - Two pinned documents, one pinned field (`contributor_addresses`), one
 * pinned before-value and its lowercase after-value each. Any live value
 * that is not byte-identical to the pinned BEFORE (or already the pinned
 * AFTER, which reports done and writes nothing) REFUSES the whole run.
 * - `leaves[].walletAddress` is DELIBERATELY untouched: the leaves are the
 * merkle-committed data behind `merkle_root`, and rewriting committed
 * evidence to satisfy a checker is the corrective-write shape hard stop 4
 * exists to refuse. C2/C3 read leaves case-insensitively or not at all.
 * - This is NOT part of the read-only cutover surface and never will be:
 * `CUTOVER_READ_ONLY_MODULES` does not include it, and the reconciliation
 * itself remains incapable of writing.
 *
 * Default is a DRY RUN that prints the exact before/after and writes nothing.
 * `--execute` performs the transactional update and re-reads to verify.
 */
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { scriptDb } from './lib/script-db';

export const SNAPSHOTS_COLLECTION = 'pvt_mint_batch_snapshots';

export interface C3Normalization {
  readonly doc_id: string;
  readonly field: 'contributor_addresses';
  readonly before: readonly string[];
  readonly after: readonly string[];
}

/**
 * The two authorized normalizations, pinned to the values read live on
 * 2026-07-28 (dry run report d0f899af1e1c…). The after-value is the lowercase
 * of the before-value and nothing else — asserted below, not assumed.
 */
export const AUTHORIZED_C3_NORMALIZATIONS: readonly C3Normalization[] = [
  {
    doc_id: '0x4b953d26337b235a9a86fea056bb4e09b9df1d74d2d0dbeea60e0ed97f513177',
    field: 'contributor_addresses',
    before: ['0xD395c8f59131a4736aa4d9eE6e5dEb8fDA07Ce0a'],
    after: ['0xd395c8f59131a4736aa4d9ee6e5deb8fda07ce0a'],
  },
  {
    doc_id: '0xace10848e897fd3cda142143d75742164a4d5340e26a7a506bef38a83b6dd056',
    field: 'contributor_addresses',
    before: ['0xD395c8f59131a4736aa4d9eE6e5dEb8fDA07Ce0a'],
    after: ['0xd395c8f59131a4736aa4d9ee6e5deb8fda07ce0a'],
  },
];

/** A casing-only change: after === lowercase(before), same length, same order. */
export function isCasingOnlyChange(
  before: readonly string[],
  after: readonly string[],
): boolean {
  return before.length === after.length
    && before.every((value, index) => value.toLowerCase() === after[index])
    && after.every((value) => value === value.toLowerCase());
}

type DocState = 'needs_normalization' | 'already_normalized' | 'unexpected';

export function classifyLiveValue(
  live: unknown,
  pinned: C3Normalization,
): DocState {
  if (!Array.isArray(live)) return 'unexpected';
  const same = (a: readonly unknown[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((v, i) => v === b[i]);
  if (same(live, pinned.before)) return 'needs_normalization';
  if (same(live, pinned.after)) return 'already_normalized';
  return 'unexpected';
}

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');

  for (const pin of AUTHORIZED_C3_NORMALIZATIONS) {
    if (!isCasingOnlyChange(pin.before, pin.after)) {
      throw new Error(`c3_pin_not_casing_only: ${pin.doc_id}`);
    }
  }

  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault(), projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'provian-ai' });
  }
  const db = scriptDb();

  console.log(`C3 normalization ${execute ? 'EXECUTE' : 'DRY RUN (no write)'} — ${AUTHORIZED_C3_NORMALIZATIONS.length} pinned docs`);

  for (const pin of AUTHORIZED_C3_NORMALIZATIONS) {
    const ref = db.collection(SNAPSHOTS_COLLECTION).doc(pin.doc_id);
    const snap = await ref.get();
    if (!snap.exists) throw new Error(`c3_doc_missing: ${pin.doc_id}`);
    const live = snap.data()?.[pin.field];
    const state = classifyLiveValue(live, pin);
    console.log(`--- ${pin.doc_id}`);
    console.log(`    live   : ${JSON.stringify(live)}`);
    console.log(`    state  : ${state}`);
    if (state === 'unexpected') {
      // The live value matches neither the pinned before nor the pinned after.
      // The pin is stale or the store moved — either way this run has no
      // authority over the value it is looking at. Refuse everything.
      throw new Error(
        `c3_live_value_unexpected: ${pin.doc_id} — live value matches neither the pinned `
        + 'before nor after; NO write performed on any document',
      );
    }
    if (state === 'already_normalized') {
      console.log('    action : none (already normalized)');
      continue;
    }
    console.log(`    before : ${JSON.stringify(pin.before)}`);
    console.log(`    after  : ${JSON.stringify(pin.after)}`);
    if (!execute) {
      console.log('    action : WOULD update contributor_addresses (dry run)');
      continue;
    }
    await db.runTransaction(async (txn) => {
      const fresh = await txn.get(ref);
      const freshLive = fresh.data()?.[pin.field];
      if (classifyLiveValue(freshLive, pin) !== 'needs_normalization') {
        throw new Error(`c3_live_value_moved_during_txn: ${pin.doc_id}`);
      }
      txn.update(ref, { [pin.field]: [...pin.after] });
    });
    const verify = await ref.get();
    const after = verify.data()?.[pin.field];
    if (classifyLiveValue(after, pin) !== 'already_normalized') {
      throw new Error(`c3_post_write_verification_failed: ${pin.doc_id}`);
    }
    console.log('    action : UPDATED and re-read verified');
  }
  console.log(execute ? 'C3 normalization COMPLETE.' : 'Dry run complete. Re-run with --execute to write.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[wp11-c3-normalize-orphan-snapshots] failed:', err);
    process.exit(1);
  });
}
