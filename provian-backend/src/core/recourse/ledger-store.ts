import type { Firestore } from 'firebase-admin/firestore';
import { createHash } from 'crypto';
import { snapshotRegisteredBalance, createRecourseChainPort, type RecourseChainPort } from './chain-ledger';
import { RECOURSE_COLLECTIONS, type RegisteredAddress } from './ownership';
import { currentProtocolDeployment } from '../protocol/runtime';

export interface LedgerCheckpoint {
  readonly block: number; readonly blockHash: string; readonly balanceAtomic: string;
  readonly mintedAtomic: string; readonly receivedAtomic: string;
}

/** Immutable evidence is written before moving its address cursor. Failed cursor commits
 * leave harmless evidence rows; retries validate those exact bytes rather than overwrite. */
export async function advanceOwnershipLedger(db: Firestore, address: string, through: number,
  chain: RecourseChainPort = createRecourseChainPort()): Promise<LedgerCheckpoint> {
  const ref = db.collection(RECOURSE_COLLECTIONS.addresses).doc(address);
  const document = await ref.get();
  if (!document.exists) throw new Error('recourse_address_unbound');
  const binding = document.data() as RegisteredAddress & { checkpoint?: LedgerCheckpoint };
  if (binding.chainBindingStatus !== 'confirmed') throw new Error('recourse_address_binding_pending');
  if (binding.kernel !== (await currentProtocolDeployment()).addresses.kernel.toLowerCase()) throw new Error('recourse_kernel_invalid');
  const previous = binding.checkpoint;
  if (previous && through < previous.block) throw new Error('recourse_cursor_rewind');
  const baseline: RegisteredAddress = previous ? { ...binding, boundBlock: previous.block,
    boundBlockHash: previous.blockHash, openingBalanceAtomic: previous.balanceAtomic } : binding;
  const snapshot = await snapshotRegisteredBalance(baseline, through, chain);
  for (const event of snapshot.events) {
    const key = createHash('sha256').update(JSON.stringify([binding.kernel, address, event.transactionHash, event.logIndex])).digest('hex');
    const eventRef = db.collection(RECOURSE_COLLECTIONS.events).doc(key);
    const record = { identity: binding.identity, address, kernel: binding.kernel, ...event,
      inbound: event.to === address ? (event.from === `0x${'0'.repeat(40)}` ? 'minted' : 'received') : null };
    await db.runTransaction(async transaction => {
      const existing = await transaction.get(eventRef);
      if (existing.exists) {
        const stored = existing.data();
        if (!stored || Object.entries(record).some(([field, value]) => stored[field] !== value)) throw new Error('recourse_ledger_evidence_conflict');
      } else transaction.create(eventRef, record);
    });
  }
  const checkpoint: LedgerCheckpoint = { block: through, blockHash: snapshot.throughBlockHash,
    balanceAtomic: snapshot.balanceAtomic,
    mintedAtomic: (BigInt(previous?.mintedAtomic ?? '0') + BigInt(snapshot.mintedAtomic)).toString(),
    receivedAtomic: (BigInt(previous?.receivedAtomic ?? '0') + BigInt(snapshot.receivedAtomic)).toString() };
  await db.runTransaction(async transaction => {
    const current = await transaction.get(ref);
    const currentCheckpoint = current.get('checkpoint') as LedgerCheckpoint | undefined;
    const unchanged = previous === undefined ? currentCheckpoint === undefined : currentCheckpoint !== undefined
      && Object.entries(previous).every(([key, value]) => currentCheckpoint[key as keyof LedgerCheckpoint] === value);
    if (current.get('bindingDigest') !== binding.bindingDigest
      || !unchanged) throw new Error('recourse_cursor_changed');
    transaction.update(ref, { checkpoint });
  });
  return checkpoint;
}
