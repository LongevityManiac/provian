import type { Firestore } from 'firebase-admin/firestore';
import { getAgreedBaseLogs, ERC20_TRANSFER_TOPIC, type CanonicalEconomicLog } from '../onchain/economic-discovery';
import { currentProtocolDeployment } from '../protocol/runtime';
import { createRecourseChainPort, type RecourseChainPort } from './chain-ledger';
import { advanceOwnershipLedger } from './ledger-store';
import { RECOURSE_COLLECTIONS } from './ownership';

const CURSORS = 'recourse_ledger_cursors';
const HASH = /^0x[0-9a-f]{64}$/;
export interface LedgerWatcherPort {
  readonly chain: RecourseChainPort;
  logs(kernel: string, from: number, through: number): Promise<readonly CanonicalEconomicLog[]>;
}
function productionPort(): LedgerWatcherPort {
  return { chain: createRecourseChainPort(), logs: (kernel, from, through) =>
    getAgreedBaseLogs({ address: kernel, topics: [ERC20_TRANSFER_TOPIC], fromBlock: from, toBlock: through }) };
}

/** Scans token activity once, then resolves only addresses touched by that activity.
 * Idle holders cause no per-wallet polling. The shared cursor advances only after
 * every affected registered address has committed its own verified ledger. */
export async function runOwnershipLedgerWatcher(db: Firestore, port: LedgerWatcherPort = productionPort()):
Promise<{ readonly through?: number; readonly updated: number; readonly idle?: boolean }> {
  const kernel = (await currentProtocolDeployment()).addresses.kernel.toLowerCase();
  const finalized = await port.chain.finalizedBlock();
  let updated = 0;
  // Confirmation can arrive after the shared scan has passed the bind block.
  // Catch those addresses up independently before resuming the global cursor.
  const newlyBound = await db.collection(RECOURSE_COLLECTIONS.addresses).where('kernel', '==', kernel)
    .where('chainBindingStatus', '==', 'confirmed').where('ledgerNeedsCatchup', '==', true).limit(20).get();
  for (const document of newlyBound.docs) {
    const address = String(document.get('address'));
    const checkpoint = await advanceOwnershipLedger(db, address, finalized, port.chain);
    await db.runTransaction(async tx => {
      const ref = db.collection(RECOURSE_COLLECTIONS.addresses).doc(address), current = await tx.get(ref);
      const value = current.get('checkpoint') as { block?: number; blockHash?: string } | undefined;
      if (current.get('bindingDigest') !== document.get('bindingDigest') || value?.block !== checkpoint.block
        || value?.blockHash !== checkpoint.blockHash) throw new Error('recourse_watcher_binding_changed');
      tx.update(ref, { ledgerNeedsCatchup: false });
    });
    ++updated;
  }
  const cursorRef = db.collection(CURSORS).doc(kernel);
  const cursorDoc = await cursorRef.get();
  const cursor = cursorDoc.exists ? cursorDoc.data() as { block: number; blockHash: string } : undefined;
  let initial: number;
  if (cursor) {
    if (!Number.isSafeInteger(cursor.block) || cursor.block < 0 || !HASH.test(cursor.blockHash)
      || await port.chain.blockHash(cursor.block) !== cursor.blockHash) throw new Error('recourse_watcher_cursor_invalid');
    initial = cursor.block;
  } else {
    const first = await db.collection(RECOURSE_COLLECTIONS.addresses).where('chainBindingStatus', '==', 'confirmed').orderBy('boundBlock', 'asc').limit(1).get();
    if (first.empty) return { updated, idle: true };
    const block: unknown = first.docs[0].get('boundBlock');
    if (typeof block !== 'number' || !Number.isSafeInteger(block) || block < 0) throw new Error('recourse_watcher_binding_invalid');
    initial = block;
  }
  if (initial >= finalized) return { through: initial, updated, idle: updated === 0 };
  // Transport work is bounded per invocation; persisted cursors continue on the next run.
  const through = Math.min(finalized, initial + 500);
  const throughHash = await port.chain.blockHash(through);
  if (!throughHash) throw new Error('recourse_watcher_block_unavailable');
  const logs = await port.logs(kernel, initial + 1, through);
  const addresses = new Set<string>();
  const occurrences = new Set<string>();
  for (const log of logs) {
    const occurrence = `${log.transactionHash}:${log.logIndex}`;
    if (log.removed || log.address !== kernel || log.topics.length !== 3 || log.topics[0] !== ERC20_TRANSFER_TOPIC
      || log.blockNumber <= initial || log.blockNumber > through || occurrences.has(occurrence)
      || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) throw new Error('recourse_watcher_log_invalid');
    occurrences.add(occurrence);
    for (const topic of log.topics.slice(1)) {
      if (!/^0x0{24}[0-9a-f]{40}$/.test(topic)) throw new Error('recourse_watcher_log_invalid');
      const address = `0x${topic.slice(26)}`;
      if (address !== `0x${'0'.repeat(40)}`) addresses.add(address);
    }
  }
  for (const address of addresses) {
    const doc = await db.collection(RECOURSE_COLLECTIONS.addresses).doc(address).get();
    if (!doc.exists) continue;
    if (doc.get('chainBindingStatus') !== 'confirmed') continue;
    if (doc.get('kernel') !== kernel) throw new Error('recourse_kernel_invalid');
    const bound: unknown = doc.get('boundBlock');
    if (typeof bound !== 'number' || !Number.isSafeInteger(bound)) throw new Error('recourse_watcher_binding_invalid');
    if (bound > through) continue; // Binding happened after this finalized interval.
    const checkpoint: unknown = doc.get('checkpoint');
    if (checkpoint && typeof checkpoint === 'object' && 'block' in checkpoint
      && typeof checkpoint.block === 'number' && checkpoint.block >= through) continue;
    await advanceOwnershipLedger(db, address, through, port.chain);
    ++updated;
  }
  if (await port.chain.blockHash(through) !== throughHash) throw new Error('recourse_watcher_reorg');
  await db.runTransaction(async tx => {
    const current = await tx.get(cursorRef);
    if (cursor ? current.get('block') !== cursor.block || current.get('blockHash') !== cursor.blockHash : current.exists) {
      throw new Error('recourse_watcher_cursor_changed');
    }
    tx.set(cursorRef, { block: through, blockHash: throughHash });
  });
  return { through, updated };
}
