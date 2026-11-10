import { createHash } from 'crypto';
import { Interface } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { getAgreedBaseLogs, readAgreedBaseBlockHash, type CanonicalEconomicLog } from '../onchain/economic-discovery';
import { advanceRelayAct, priceRelayAct, readRelayActIntake } from '../meter/meter-relay-authored';
import { RECOURSE_COLLECTIONS } from './ownership';
import { recourseLifecycleSources, type LifecycleSource } from './lifecycle-sources';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';

export const LIFECYCLE_RECORDS = 'recourse_lifecycle_records_v1';
export const LIFECYCLE_CURSORS = 'recourse_lifecycle_cursors_v1';
export const LIFECYCLE_PENDING = 'recourse_lifecycle_pending_v1';
export const LIFECYCLE_EVENTS = {
  pool: new Interface([
    'event MembershipChanged(bytes32 indexed identity,bool joined,uint256 generation,uint256 month)',
    'event MonthlyObligationRecorded(bytes32 indexed identity,uint256 indexed generation,uint256 indexed month,uint256 burn,uint256 contribution)',
    'event MonthlyObligationCredited(bytes32 indexed identity,uint256 indexed generation,uint256 indexed month,uint256 burn,uint256 contribution)',
    'event ReserveContributed(bytes32 indexed identity,uint256 indexed generation,uint256 amount,uint256 shares)',
    'event ReserveRedeemed(bytes32 indexed identity,uint256 indexed generation,address destination,uint256 amount,uint256 shares)',
    'event RestorationDetermined(bytes32 indexed request,bytes32 indexed identity,bytes32 indexed occurrence,bool accepted,uint256 shortfall,bytes32 evidenceHash,uint256 revision)',
    'event RestorationAllocated(bytes32 indexed request,bytes32 indexed identity,uint256 requested,uint256 assigned)',
    'event RestorationWithdrawn(bytes32 indexed request,address indexed destination,uint256 amount)',
  ]),
  registry: new Interface([
    'event OwnershipBound(bytes32 indexed identity,address indexed account,address indexed kernel,bytes32 recoveryCommitment,bytes32 signingRoot,bytes32 digest)',
    'event RecoveredAddressBound(bytes32 indexed identity,address indexed account,address indexed kernel)',
  ]),
  restoration: new Interface(['event IdentityRestored(bytes32 indexed identity,address indexed destination,uint256 amount)',
    'event TheftReversed(bytes32 indexed request,bytes32 indexed identity,address indexed destination,uint256 amount,bytes32 evidenceHash)']),
} as const;
export interface LifecycleRecord { readonly id: string; readonly identity: string; readonly source: string; readonly transactionHash: string; readonly block: number; readonly blockHash: string; readonly events: readonly { name: string; logIndex: number; values: Readonly<Record<string, string | boolean>> }[] }

export function lifecycleRecords(source: LifecycleSource, logs: readonly CanonicalEconomicLog[], from: number, through: number,
  withdrawalOwners: ReadonlyMap<string, string> = new Map()): readonly LifecycleRecord[] {
  const grouped = new Map<string, LifecycleRecord>(), occurrences = new Set<string>();
  for (const log of logs) {
    if (log.removed || log.address !== source.address || log.blockNumber < from || log.blockNumber > through
      || !/^0x[0-9a-f]{64}$/.test(log.transactionHash) || !/^0x[0-9a-f]{64}$/.test(log.blockHash)
      || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0) throw Error('recourse_lifecycle_log_invalid');
    const occurrence = `${log.transactionHash}:${log.logIndex}`;
    if (occurrences.has(occurrence)) throw Error('recourse_lifecycle_log_duplicate');
    occurrences.add(occurrence);
    const decoded = LIFECYCLE_EVENTS[source.kind].parseLog({ topics: [...log.topics], data: log.data });
    if (!decoded) throw Error('recourse_lifecycle_log_invalid');
    const identity = decoded.name === 'RestorationWithdrawn' ? String(withdrawalOwners.get(String(decoded.args.request))) : String(decoded.args.identity);
    if (!/^0x[0-9a-f]{64}$/.test(identity) || /^0x0+$/.test(identity)) throw Error('recourse_lifecycle_identity_invalid');
    const values = Object.fromEntries(decoded.fragment.inputs.map((input, i) =>
      [input.name, typeof decoded.args[i] === 'boolean' ? decoded.args[i] as boolean : String(decoded.args[i]).toLowerCase()]));
    const event = { name: decoded.name, logIndex: log.logIndex, values };
    const id = createHash('sha256').update(JSON.stringify([8453, source.address, log.transactionHash, identity])).digest('hex');
    const old = grouped.get(id);
    if (old && (old.block !== log.blockNumber || old.blockHash !== log.blockHash)) throw Error('recourse_lifecycle_log_invalid');
    grouped.set(id, { id, identity, source: source.address, transactionHash: log.transactionHash, block: log.blockNumber,
      blockHash: log.blockHash, events: [...old?.events ?? [], event].sort((a, b) => a.logIndex - b.logIndex) });
  }
  return [...grouped.values()].sort((a, b) => a.block - b.block || a.events[0].logIndex - b.events[0].logIndex);
}
async function recordLifecycle(db: Firestore, record: LifecycleRecord): Promise<void> {
  const ref = db.collection(LIFECYCLE_RECORDS).doc(record.id), peId = `recourse_record_${record.id}`;
  const prior = await ref.get();
  if (prior.get('peHash')) {
    const intake = await readRelayActIntake(db, peId);
    if (intake) await priceRelayAct(db, intake);
    return;
  }
  const owner = await db.collection(RECOURSE_COLLECTIONS.identities).doc(record.identity).get();
  const ownerType: unknown = owner.get('ownerType'), actorId: unknown = owner.get('ownerId'), walletId: unknown = owner.get('walletId');
  if (!owner.exists || (ownerType !== 'human' && ownerType !== 'agent') || typeof actorId !== 'string'
    || typeof walletId !== 'string') throw Error('recourse_lifecycle_owner_unavailable');
  const timestamp = Date.now();
  try {
    const advanced = await advanceRelayAct(db, {
      actorId, walletId, ownerType, requiredRecipient: `${ownerType}:${actorId}`, peId, timestamp, actionType: 'recourse_record',
      content: { owner_id: actorId, wallet_id: walletId, witness: 'base_finalized', record },
      accrual: peHash => ({ peId, userId: actorId, actionType: 'recourse_record', integrationSource: 'recourse_chain',
        attestationDepth: 'software_verified', peHash, timestamp, ownerType, throwOnError: true }),
      atomicPrecondition: async tx => { if ((await tx.get(ref)).exists) throw Error('recourse_lifecycle_already_recorded'); },
      atomicCoWrite: (tx, context) => tx.create(ref, { identity: record.identity, peId, peHash: context.peHash,
        source: record.source, transactionHash: record.transactionHash, block: record.block, blockHash: record.blockHash }),
    });
    await priceRelayAct(db, advanced.intake);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'recourse_lifecycle_already_recorded') throw error;
    const intake = await readRelayActIntake(db, peId);
    if (intake) await priceRelayAct(db, intake);
  }
}
export interface LifecycleWatcherPort {
  sources: typeof recourseLifecycleSources; logs: typeof getAgreedBaseLogs; blockHash: typeof readAgreedBaseBlockHash;
  withdrawalOwners(source: LifecycleSource, logs: readonly CanonicalEconomicLog[]): Promise<ReadonlyMap<string, string>>;
  record(db: Firestore, record: LifecycleRecord): Promise<void>;
}
async function withdrawalOwners(source: LifecycleSource, logs: readonly CanonicalEconomicLog[]): Promise<ReadonlyMap<string, string>> {
  const owners = new Map<string, string>();
  if (source.kind !== 'pool') return owners;
  const abi = new Interface(['function restorationAllocations(bytes32) view returns(bytes32 identity,uint256 amount,bool withdrawn)']);
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw Error('recourse_rpc_operators_not_independent');
  for (const log of logs) {
    const decoded = LIFECYCLE_EVENTS.pool.parseLog({ topics: [...log.topics], data: log.data });
    if (decoded?.name !== 'RestorationWithdrawn') continue;
    const values: unknown[] = await Promise.all(legs.map(leg => leg.provider.send('eth_call', [{ to: source.address,
      data: abi.encodeFunctionData('restorationAllocations', [decoded.args.request]) }, { blockHash: log.blockHash, requireCanonical: true }])));
    if (typeof values[0] !== 'string' || values[0] !== values[1]) throw Error('recourse_lifecycle_rpc_disagreement');
    const allocation = abi.decodeFunctionResult('restorationAllocations', values[0]);
    if (allocation.withdrawn !== true || allocation.amount !== decoded.args.amount) throw Error('recourse_lifecycle_withdrawal_invalid');
    owners.set(String(decoded.args.request), String(allocation.identity));
  }
  return owners;
}
/** Canonical event intake and encrypted owner delivery have independent durable
 * queues. A missing owner key cannot prevent discovery of later owners/events.
 * Every retry re-verifies the public event before it authors a private PE. */
export async function runRecourseLifecycleWatcher(db: Firestore, port: LifecycleWatcherPort = {
  sources: recourseLifecycleSources, logs: getAgreedBaseLogs, blockHash: readAgreedBaseBlockHash, withdrawalOwners, record: recordLifecycle,
}): Promise<{ recorded: number; pendingSources: number }> {
  let recorded = 0, pendingSources = 0;
  const sources = await port.sources();
  const read = async (source: LifecycleSource, from: number, through: number) => {
    const topics: string[] = [];
    LIFECYCLE_EVENTS[source.kind].forEachEvent(event => topics.push(event.topicHash));
    const logs = await port.logs({ address: source.address, topics: [topics], fromBlock: from, toBlock: through });
    const records = lifecycleRecords(source, logs, from, through, await port.withdrawalOwners(source, logs));
    for (const record of records) if (await port.blockHash(record.block) !== record.blockHash) throw Error('recourse_lifecycle_reorg');
    return records;
  };
  for (const source of sources) {
    const ref = db.collection(LIFECYCLE_CURSORS).doc(`${source.kind}:${source.address}`), prior = await ref.get();
    const block: unknown = prior.get('block'), blockHash: unknown = prior.get('blockHash');
    if (prior.exists && (typeof block !== 'number' || !Number.isSafeInteger(block) || block < source.from - 1
      || typeof blockHash !== 'string' || await port.blockHash(block) !== blockHash)) throw Error('recourse_lifecycle_cursor_invalid');
    const from = prior.exists ? Number(block) + 1 : source.from;
    if (from > source.through) continue;
    const through = Math.min(source.through, from + 499), hash = await port.blockHash(through);
    if (!hash) throw Error('recourse_lifecycle_block_unavailable');
    for (const record of await read(source, from, through)) {
      await db.runTransaction(async tx => {
        const pending = db.collection(LIFECYCLE_PENDING).doc(record.id);
        const [queued, delivered] = await Promise.all([tx.get(pending), tx.get(db.collection(LIFECYCLE_RECORDS).doc(record.id))]);
        if (!queued.exists && !delivered.exists) tx.create(pending, { record, kind: source.kind, lastAttemptAtMs: 0 });
      });
    }
    if (await port.blockHash(through) !== hash) throw Error('recourse_lifecycle_reorg');
    await db.runTransaction(async tx => {
      const current = await tx.get(ref);
      if (prior.exists ? current.get('block') !== block || current.get('blockHash') !== blockHash : current.exists) throw Error('recourse_lifecycle_cursor_changed');
      tx.set(ref, { block: through, blockHash: hash });
    });
  }
  // Least-recently attempted first ensures permanently unavailable owners do
  // not starve later records, even when the pending queue exceeds one page.
  const pending = await db.collection(LIFECYCLE_PENDING).orderBy('lastAttemptAtMs', 'asc').limit(50).get();
  for (const row of pending.docs) {
    const stored = row.get('record') as LifecycleRecord;
    try {
      const source = sources.find(value => value.kind === row.get('kind') && value.address === stored.source
        && value.from <= stored.block && value.through >= stored.block);
      if (!source || stored.id !== row.id) throw Error('recourse_lifecycle_source_invalid');
      const verified = (await read(source, stored.block, stored.block)).find(value => value.id === row.id);
      if (!verified || !rpcChainFactsEqual(verified, stored)) throw Error('recourse_lifecycle_event_changed');
      await port.record(db, verified);
      await row.ref.delete(); ++recorded;
    } catch {
      await row.ref.update({ lastAttemptAtMs: Date.now() }); ++pendingSources;
    }
  }
  return { recorded, pendingSources };
}
