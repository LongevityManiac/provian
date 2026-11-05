/**
 * the ONE historical pre- writeback, applied once.
 *
 * The first mint settled before existed, and its batch completed
 * ledger writebacks (`writebacks_complete: true`), so the live writeback and
 * its crash repair will never revisit it: the settled Genesis grant's
 * pe_history doc still reads `mint_status: 'eligible'` in the claim source.
 * This script applies EXACTLY the writeback shape to THAT ONE document,
 * pinned by id, batch, and transaction — nothing enumerated, nothing scanned.
 *
 * The distinct minted_via backfill marker identifies the one-off repair
 * separately from the live writeback path.
 *
 * Dry-run by default (prints before-state and the exact patch). `--execute`
 * performs one transaction that re-verifies the pre-state in-txn (peId match,
 * `mint_status === 'eligible'`) and refuses anything else, then re-reads.
 */
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { scriptDb } from './lib/script-db';

/** Pinned from the live batch doc, read 2026-07-28 (see DECISIONS). */
const PE_ID = 'pe_genesis_6cd358a0dc2b0d02757a243e68cc2a3aa3e27e7746fbf40c5684f0b23dd169a8';
const BATCH_ID = '0xe7f7ce01943e8acda3f43e201dc7404c98be99a79f4f5d779c880d94befafc2a';
const TX_HASH = '0xc3b60016bf1dfbdb6284001914e3dd418a3f4f4065ba3ca4ff1cb5e1c5f7b8be';
/** The batch doc's own final write time — the durable settled-record stamp. */
const SETTLED_AT = 1_785_171_843_719;

const PATCH = {
  mint_status: 'minted',
  settled_batch_id: BATCH_ID,
  settled_tx_hash: TX_HASH,
  settled_at: SETTLED_AT,
  minted_via: 'pvt9_settlement_d151_backfill',
} as const;

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault(), projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'provian-ai' });
  }
  const db = scriptDb();
  const ref = db.collection('pe_history').doc(PE_ID);

  const before = await ref.get();
  if (!before.exists) throw new Error(`refused: pe_history/${PE_ID} does not exist`);
  const beforeData = before.data() as Record<string, unknown>;
  console.log('BEFORE mint_status =', JSON.stringify(beforeData.mint_status));
  console.log('BEFORE settled markers =', JSON.stringify({
    settled_batch_id: beforeData.settled_batch_id ?? null,
    settled_tx_hash: beforeData.settled_tx_hash ?? null,
    settled_at: beforeData.settled_at ?? null,
    minted_via: beforeData.minted_via ?? null,
  }));
  console.log('PATCH =', JSON.stringify(PATCH));

  if (!execute) {
    console.log('DRY RUN — no write. Re-run with --execute to apply.');
    return;
  }

  await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) throw new Error('refused_in_txn: doc vanished');
    const data = snap.data() as Record<string, unknown>;
    if (data.peId !== PE_ID) throw new Error(`refused_in_txn: peId mismatch (${String(data.peId)})`);
    if (data.mint_status !== 'eligible') {
      throw new Error(`refused_in_txn: mint_status is ${JSON.stringify(data.mint_status)}, expected 'eligible'`);
    }
    txn.set(ref, PATCH, { merge: true });
  });

  const after = await ref.get();
  const afterData = after.data() as Record<string, unknown>;
  console.log('AFTER mint_status =', JSON.stringify(afterData.mint_status));
  console.log('AFTER settled markers =', JSON.stringify({
    settled_batch_id: afterData.settled_batch_id,
    settled_tx_hash: afterData.settled_tx_hash,
    settled_at: afterData.settled_at,
    minted_via: afterData.minted_via,
  }));
}

main().catch((error) => {
  console.error('[d151-backfill] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
