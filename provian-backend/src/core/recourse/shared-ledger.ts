import type { Firestore } from 'firebase-admin/firestore';
import { createHash } from 'crypto';
import type { TransferEvent } from './ownership';
import type { RecourseChainPort } from './chain-ledger';

export const SHARED_LEDGER_CURSORS = 'recourse_shared_ledger_cursors_v1';
export const SHARED_LEDGER_TRANSFERS = 'recourse_shared_transfers_v1';
export interface SharedLedgerCursor { readonly fromBlock: number; readonly block: number; readonly blockHash: string }
export async function sharedLedgerCursor(db: Firestore, kernel: string, chain: RecourseChainPort): Promise<SharedLedgerCursor | undefined> {
  const row = await db.collection(SHARED_LEDGER_CURSORS).doc(kernel).get();
  if (!row.exists) return undefined;
  const cursor = row.data() as SharedLedgerCursor;
  if (!Number.isSafeInteger(cursor.fromBlock) || cursor.fromBlock < 1 || !Number.isSafeInteger(cursor.block)
    || cursor.block < cursor.fromBlock - 1 || !/^0x[0-9a-f]{64}$/.test(cursor.blockHash)
    || await chain.blockHash(cursor.block) !== cursor.blockHash) throw Error('recourse_shared_cursor_invalid');
  return cursor;
}
/** Store both participants, including addresses whose binding is confirmed later.
 * The coverage cursor is committed only after all immutable rows are durable. */
export async function storeSharedTransfer(db: Firestore, kernel: string, address: string, event: TransferEvent): Promise<void> {
  const id = createHash('sha256').update(JSON.stringify([kernel, address, event.transactionHash, event.logIndex])).digest('hex');
  const ref = db.collection(SHARED_LEDGER_TRANSFERS).doc(id), record = { kernel, address, ...event };
  await db.runTransaction(async tx => {
    const saved = await tx.get(ref);
    if (saved.exists) {
      if (Object.entries(record).some(([key, value]) => saved.get(key) !== value)) throw Error('recourse_shared_event_conflict');
    } else tx.create(ref, record);
  });
}
/** The shared watcher has already compared every log on both providers. A fresh
 * canonical coverage check and the caller's exact-hash balance check remain mandatory. */
export async function indexedLedgerChain(db: Firestore, kernel: string, from: number, through: number,
  chain: RecourseChainPort): Promise<RecourseChainPort> {
  const cursor = await sharedLedgerCursor(db, kernel, chain);
  if (!cursor || from < cursor.fromBlock || through > cursor.block) throw Error('recourse_shared_ledger_not_current');
  return { ...chain, async transfers(token, address, first, last) {
    if (token !== kernel || first < from || last > through) throw Error('recourse_shared_ledger_range');
    const rows = await db.collection(SHARED_LEDGER_TRANSFERS).where('kernel', '==', kernel).where('address', '==', address)
      .where('block', '>=', first).where('block', '<=', last).orderBy('block').get();
    return rows.docs.map(row => {
      const value = row.data();
      return { block: value.block, blockHash: value.blockHash, transactionHash: value.transactionHash,
        logIndex: value.logIndex, from: value.from, to: value.to, amountAtomic: value.amountAtomic } as TransferEvent;
    }).sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  } };
}
