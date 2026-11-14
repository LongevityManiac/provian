import type { Firestore } from 'firebase-admin/firestore';
import { getAgreedBaseLogs, ERC20_TRANSFER_TOPIC, type CanonicalEconomicLog } from '../onchain/economic-discovery';
import { currentProtocolDeployment } from '../protocol/runtime';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { createRecourseChainPort, type RecourseChainPort } from './chain-ledger';
import { advanceOwnershipLedger } from './ledger-store';
import { RECOURSE_COLLECTIONS, type TransferEvent } from './ownership';
import { SHARED_LEDGER_CURSORS, sharedLedgerCursor, storeSharedTransfer } from './shared-ledger';

export interface LedgerWatcherPort {
  readonly chain: RecourseChainPort;
  birth(kernel: string, through: number): Promise<number>;
  logs(kernel: string, from: number, through: number): Promise<readonly CanonicalEconomicLog[]>;
}
function productionPort(): LedgerWatcherPort {
  return { chain: createRecourseChainPort(), logs: (kernel, from, through) =>
    getAgreedBaseLogs({ address: kernel, topics: [ERC20_TRANSFER_TOPIC], fromBlock: from, toBlock: through }),
    async birth(kernel, through) {
      const legs = getOperatorBoundRpcLegs('base');
      if (legs[0].operatorId === legs[1].operatorId) throw Error('recourse_rpc_operators_not_independent');
      const code = async (block: number) => {
        const values: unknown[] = await Promise.all(legs.map(leg => leg.provider.send('eth_getCode', [kernel, `0x${block.toString(16)}`])));
        if (typeof values[0] !== 'string' || values[0] !== values[1]) throw Error('recourse_watcher_birth_disagreement');
        return values[0];
      };
      const runtime = await code(through);
      if (runtime === '0x') throw Error('recourse_watcher_birth_unavailable');
      let left = 1, right = through;
      while (left < right) {
        const mid = left + Math.floor((right - left) / 2);
        if (await code(mid) === '0x') left = mid + 1; else right = mid;
      }
      if (await code(left - 1) !== '0x' || await code(left) !== runtime) throw Error('recourse_watcher_birth_invalid');
      return left;
    } };
}

/** One global scan persists all transfers, including late-bound addresses. Wallet
 * projections are retryable consumers; they never repeat the shared RPC scan. */
export async function runOwnershipLedgerWatcher(db: Firestore, port: LedgerWatcherPort = productionPort()):
Promise<{ readonly through?: number; readonly updated: number; readonly idle?: boolean }> {
  const kernel = (await currentProtocolDeployment()).addresses.kernel.toLowerCase();
  const finalized = await port.chain.finalizedBlock();
  const cursor = await sharedLedgerCursor(db, kernel, port.chain);
  const fromBlock = cursor?.fromBlock ?? await port.birth(kernel, finalized);
  const initial = cursor?.block ?? fromBlock - 1;
  if (initial > finalized) throw Error('recourse_watcher_finality_rewind');
  if (initial < finalized) {
    // The transport chunks requests to each provider's limit; the scheduler
    // advances to its fixed finalized target rather than falling behind by design.
    const throughHash = await port.chain.blockHash(finalized);
    if (!throughHash) throw Error('recourse_watcher_block_unavailable');
    const logs = await port.logs(kernel, initial + 1, finalized);
    const occurrences = new Set<string>(), blocks = new Map<number, string>(), affected = new Set<string>();
    for (const log of logs) {
      const occurrence = `${log.transactionHash}:${log.logIndex}`;
      if (log.removed || log.address !== kernel || log.topics.length !== 3 || log.topics[0] !== ERC20_TRANSFER_TOPIC
        || log.blockNumber <= initial || log.blockNumber > finalized || occurrences.has(occurrence)
        || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || !/^0x[0-9a-f]{64}$/.test(log.transactionHash)
        || !/^0x[0-9a-f]{64}$/.test(log.blockHash) || !/^0x[0-9a-fA-F]{64}$/.test(log.data)
        || log.topics.slice(1).some(topic => !/^0x0{24}[0-9a-f]{40}$/.test(topic))) throw Error('recourse_watcher_log_invalid');
      occurrences.add(occurrence);
      const priorHash = blocks.get(log.blockNumber);
      if (priorHash && priorHash !== log.blockHash) throw Error('recourse_watcher_reorg');
      blocks.set(log.blockNumber, log.blockHash);
    }
    for (const [block, hash] of blocks) if (await port.chain.blockHash(block) !== hash) throw Error('recourse_watcher_reorg');
    for (const log of logs) {
      const event: TransferEvent = { block: log.blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash,
        logIndex: log.logIndex, from: `0x${log.topics[1].slice(26)}`, to: `0x${log.topics[2].slice(26)}`, amountAtomic: BigInt(log.data).toString() };
      for (const address of new Set([event.from, event.to])) {
        if (address === `0x${'0'.repeat(40)}`) continue;
        await storeSharedTransfer(db, kernel, address, event);
        affected.add(address);
      }
    }
    // Mark consumers before publishing coverage. A crash leaves retryable work,
    // never a cursor that silently skipped an affected wallet.
    for (const address of affected) await db.runTransaction(async tx => {
      const ref = db.collection(RECOURSE_COLLECTIONS.addresses).doc(address), row = await tx.get(ref);
      if (row.exists && row.get('kernel') === kernel && row.get('chainBindingStatus') === 'confirmed')
        tx.update(ref, { ledgerNeedsCatchup: true, ledgerDirtyThrough: Math.max(finalized, Number(row.get('ledgerDirtyThrough') ?? 0)) });
    });
    if (await port.chain.blockHash(finalized) !== throughHash) throw Error('recourse_watcher_reorg');
    const ref = db.collection(SHARED_LEDGER_CURSORS).doc(kernel);
    await db.runTransaction(async tx => {
      const current = await tx.get(ref);
      if (cursor ? current.get('block') !== cursor.block || current.get('blockHash') !== cursor.blockHash : current.exists)
        throw Error('recourse_watcher_cursor_changed');
      tx.set(ref, { fromBlock, block: finalized, blockHash: throughHash });
    });
  }
  let updated = 0;
  const pending = await db.collection(RECOURSE_COLLECTIONS.addresses).where('kernel', '==', kernel)
    .where('chainBindingStatus', '==', 'confirmed').where('ledgerNeedsCatchup', '==', true).limit(20).get();
  for (const document of pending.docs) {
    const address = String(document.get('address'));
    if (Number(document.get('boundBlock')) > finalized) continue;
    const checkpoint = await advanceOwnershipLedger(db, address, finalized, port.chain);
    await db.runTransaction(async tx => {
      const ref = db.collection(RECOURSE_COLLECTIONS.addresses).doc(address), current = await tx.get(ref);
      const value = current.get('checkpoint') as { block?: number; blockHash?: string } | undefined;
      const coverage = await tx.get(db.collection(SHARED_LEDGER_CURSORS).doc(kernel));
      if (current.get('bindingDigest') !== document.get('bindingDigest') || value?.block !== checkpoint.block
        || value?.blockHash !== checkpoint.blockHash) throw Error('recourse_watcher_binding_changed');
      // A concurrent scan may have found newer activity while this projection ran.
      if (coverage.get('block') === checkpoint.block && Number(current.get('ledgerDirtyThrough') ?? 0) <= checkpoint.block) tx.update(ref, { ledgerNeedsCatchup: false });
    });
    ++updated;
  }
  return { through: finalized, updated, ...(initial === finalized ? { idle: updated === 0 } : {}) };
}
