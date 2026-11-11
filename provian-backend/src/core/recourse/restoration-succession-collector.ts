import { createHash } from 'crypto';
import type { LossSnapshot } from './loss-snapshot';
import type { RestorationEvidencePort } from './restoration-evidence';
import { classifyRestorationReceipt } from './restoration-evidence';
import type { HistoricalBalanceImport } from './restoration-balance-import';
import type { HistoricalRestorationInterval } from './restoration-receipt-interval';
import type { ReconstructedBreakPartition } from './restoration-break-partition';
import type { VerifiedBreakArtifact } from './break-artifact';
import type { RestorationSuccessionLineage } from './restoration-lineage';
import { restorationBalanceKey as key, type RestorationBalanceRef } from './restoration-bridge-ledger';
import { traceRestorationSuccession, type SuccessionTraceCheckpoint, type SuccessionTraceEvent } from './restoration-succession-trace';
import type { BaseTransactionEvidence } from '../onchain/economic-discovery';

export interface SuccessionCollectionPort {
  readonly evidence: RestorationEvidencePort;
  /** Includes independently authenticated executor implementations. */
  lineage(kernel: string): Promise<RestorationSuccessionLineage & { readonly block: number; readonly blockHash: string }>;
  artifact(origin: string): Promise<VerifiedBreakArtifact>;
  partition(origin: string, identity: string): Promise<ReconstructedBreakPartition | null>;
  balanceImport(predecessor: string, account: string, through: number): Promise<HistoricalBalanceImport | null>;
  restoration(kernel: string, identity: string, through: number): Promise<HistoricalRestorationInterval | null>;
  origin(kernel: string, pin: string): Promise<string>;
  /** Returns zero for independently proven empty code at this historical pin;
   * otherwise reads balanceOf from both chain providers. */
  openingBalance(kernel: string, account: string, pin: string): Promise<bigint>;
  manifest(): Promise<string>;
}
const zero = `0x${'0'.repeat(40)}`, zeroHash = `0x${'0'.repeat(64)}`;
const accountRef = (kernel: string, address: string): RestorationBalanceRef => ({ kind: 'account', kernel, address });
const entitlementRef = (origin: string, identity: string): RestorationBalanceRef => ({ kind: 'entitlement', origin, identity });
const digest = (value: unknown): string => `0x${createHash('sha256').update(JSON.stringify(value,
  (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item)).digest('hex')}`;
/** Collect only authenticated real token history and explicit succession
 * evidence. Portfolio ownership remains private; public bindings are examined
 * individually. Whole cutoff partitions retain clean and protected balances,
 * including unissued rights carried through repeated cryptographic breaks. */
export async function collectSuccessionCheckpoint(snapshot: LossSnapshot, port: SuccessionCollectionPort, throughBlock?: number) {
  const { evidence } = port, lineage = await port.lineage(snapshot.kernel);
  const finalized = await evidence.chain.finalizedBlock(), block = throughBlock ?? finalized;
  if (!Number.isSafeInteger(block) || block < snapshot.block || block > finalized || lineage.kernel !== await evidence.currentKernel()) {
    throw Error('recourse_collection_checkpoint_invalid');
  }
  const pins = new Map<number, string>();
  const pin = async (height: number): Promise<string> => {
    const existing = pins.get(height);
    if (existing) return existing;
    const value = await evidence.chain.blockHash(height);
    if (!value || !/^0x[0-9a-f]{64}$/.test(value)) throw Error('recourse_collection_checkpoint_invalid');
    pins.set(height, value); return value;
  };
  const blockHash = await pin(block);
  if (await pin(snapshot.block) !== snapshot.blockHash || await pin(lineage.block) !== lineage.blockHash) throw Error('recourse_collection_reorg');
  const generations = [{ kernel: snapshot.kernel, from: snapshot.block, through: lineage.migrations[0]?.cutoff ?? block },
    ...lineage.migrations.map((migration, index) => ({ kernel: migration.kernel, from: migration.cutoff + 1,
      through: lineage.migrations[index + 1]?.cutoff ?? block }))];
  if (generations.some((row, index) => row.from > row.through || row.through > block
    || index > 0 && lineage.migrations[index - 1].predecessor !== generations[index - 1].kernel)) throw Error('recourse_collection_generation_invalid');
  for (const migration of lineage.migrations) if (await pin(migration.cutoff) !== migration.cutoffHash) throw Error('recourse_collection_reorg');
  const owner = await evidence.privateOwner(snapshot.identity);
  if (owner === null) throw Error('recourse_collection_owner_missing');
  const authorization = await evidence.call(lineage.kernel, 'ownerAuthorization', [], blockHash);
  const restorationRevision = await evidence.call(authorization, 'restorationRevision', [], blockHash);
  if (!/^(0|[1-9][0-9]*)$/.test(restorationRevision) || BigInt(restorationRevision) >= (1n << 256n)) throw Error('recourse_collection_revision_invalid');
  const rows = new Map<string, SuccessionTraceCheckpoint['balances'][number]>();
  const owners = new Map<string, SuccessionTraceCheckpoint['owners'][number]>();
  const consumed = new Map<string, bigint>(), events = new Map<string, SuccessionTraceEvent>(), imports = new Set<string>();
  const transactions = new Map<string, BaseTransactionEvidence>(), artifacts = new Map<string, VerifiedBreakArtifact>();
  const queued = new Set<string>(), partitions = new Set<string>();
  type Task = { kind: 'account'; generation: number; address: string }
    | { kind: 'entitlement'; generation: number; origin: string; identity: string; amount: string };
  const tasks: Task[] = [];
  const enqueue = (task: Task): void => {
    const id = task.kind === 'account' ? key(accountRef(generations[task.generation].kernel, task.address))
      : `${key(entitlementRef(task.origin, task.identity))}:${task.generation}`;
    if (!queued.has(id)) { queued.add(id); tasks.push(task); }
  };
  const artifact = async (origin: string): Promise<VerifiedBreakArtifact> => {
    let value = artifacts.get(origin);
    if (!value) { value = await port.artifact(origin); artifacts.set(origin, value); }
    return value;
  };
  const addEvent = (id: string, event: SuccessionTraceEvent): void => {
    const prior = events.get(id);
    if (prior && digest(prior) !== digest(event)) throw Error('recourse_collection_event_conflict');
    events.set(id, event);
  };
  const consume = (ref: RestorationBalanceRef, amount: bigint): void => {
    const id = key(ref);
    if (consumed.has(id)) throw Error('recourse_collection_source_reused');
    consumed.set(id, amount);
  };
  const own = async (ref: RestorationBalanceRef, binding: string, proof: unknown): Promise<void> => {
    const bound = binding === zeroHash ? null : await evidence.privateOwner(binding);
    if (binding !== zeroHash && bound === null) throw Error('recourse_collection_owner_missing');
    const verified = ref.kind === 'account' ? await evidence.verifiedIdentity(ref.address) : null;
    if (verified && bound !== null && verified.identity !== bound) throw Error('recourse_collection_owner_conflict');
    if (binding === snapshot.identity || bound === owner || verified?.identity === owner) owners.set(key(ref), { ref, evidenceHash: digest({ proof, verified }) });
  };
  const schedulePartition = async (partition: ReconstructedBreakPartition): Promise<void> => {
    const target = entitlementRef(partition.origin, partition.owner.identity), id = key(target);
    if (partitions.has(id)) return;
    partitions.add(id);
    const generation = generations.findIndex(row => row.kernel === partition.predecessor);
    const migration = lineage.migrations[generation];
    if (generation < 0 || !migration || migration.kind !== 'cryptographic_break' || migration.executor !== partition.origin
      || migration.cutoff !== partition.cutoff || migration.cutoffHash !== partition.cutoffHash) throw Error('recourse_collection_partition_domain_invalid');
    const sources = partition.accounts.map(row => ({ ref: accountRef(partition.predecessor, row.address), amount: BigInt(row.amountAtomic) }));
    for (const row of partition.accounts) enqueue({ kind: 'account', generation, address: row.address });
    if (partition.carried) {
      const previous = partition.carried, ref = entitlementRef(previous.origin, previous.owner.identity);
      if (previous.owner.identity !== partition.owner.identity) throw Error('recourse_collection_partition_identity_invalid');
      if (previous.cutoff >= snapshot.block) await schedulePartition(previous);
      else if (!rows.has(key(ref))) rows.set(key(ref), { ref, openingAtomic: previous.owner.amount, closingAtomic: previous.owner.amount });
      sources.push({ ref, amount: BigInt(previous.owner.amount) });
    }
    for (const source of sources) consume(source.ref, source.amount);
    rows.set(id, { ref: target, closingAtomic: partition.owner.amount });
    await own(target, partition.owner.identity, partition);
    addEvent(`snapshot:${id}`, { kind: 'bridge', block: partition.cutoff, blockHash: partition.cutoffHash, logIndex: null,
      bridge: { kind: 'snapshot', kernel: partition.predecessor, origin: partition.origin, sources, destination: target }, evidenceHash: digest(partition) });
    enqueue({ kind: 'entitlement', generation: generation + 1, origin: partition.origin, identity: partition.owner.identity, amount: partition.owner.amount });
  };
  for (const row of snapshot.addresses) enqueue({ kind: 'account', generation: 0, address: row.address });
  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index], generation = generations[task.generation], migration = lineage.migrations[task.generation];
    const closingHash = await pin(generation.through);
    if (task.kind === 'entitlement') {
      const ref = entitlementRef(task.origin, task.identity);
      if (await port.origin(generation.kernel, closingHash) !== task.origin) throw Error('recourse_collection_origin_invalid');
      const restored = await port.restoration(generation.kernel, task.identity, generation.through);
      if (restored) {
        if (restored.bridge.origin !== task.origin || restored.bridge.sources.length !== 1
          || key(restored.bridge.sources[0].ref) !== key(ref) || restored.bridge.sources[0].amount !== BigInt(task.amount)
          || restored.bridge.destination.kind !== 'account' || restored.bridge.destination.kernel !== generation.kernel) throw Error('recourse_collection_restoration_invalid');
        consume(ref, BigInt(task.amount));
        if (restored.mintId) imports.add(restored.mintId);
        addEvent(`restoration:${key(ref)}`, { kind: 'bridge', block: restored.block, blockHash: restored.blockHash,
          logIndex: restored.logIndex, bridge: restored.bridge, evidenceHash: restored.evidenceHash });
        enqueue({ kind: 'account', generation: task.generation, address: restored.bridge.destination.address });
      } else if (migration) {
        if (migration.kind === 'ordinary') enqueue({ ...task, generation: task.generation + 1 });
        else {
          const partition = await port.partition(migration.executor, task.identity);
          if (!partition || !partition.carried || partition.carried.origin !== task.origin) throw Error('recourse_collection_carry_missing');
          await schedulePartition(partition);
        }
      }
      continue;
    }
    const { address } = task, ref = accountRef(generation.kernel, address), id = key(ref);
    const openingHash = await pin(generation.from - 1);
    const [opening, closing] = await Promise.all([port.openingBalance(generation.kernel, address, openingHash), evidence.chain.balance(generation.kernel, address, closingHash)]);
    // A successor may not exist before its cutoff. All of its opening balances
    // are zero; production ports must read this as a proven empty-code state.
    if (task.generation > 0 && opening !== 0n) throw Error('recourse_collection_successor_opening_invalid');
    const current = generation.kernel === lineage.kernel;
    const sequence = current ? await evidence.call(generation.kernel, 'outgoingSequence', [address], closingHash) : undefined;
    const encumbered = current && evidence.encumberedBalance ? await evidence.encumberedBalance(address, generation.kernel, closingHash) : undefined;
    rows.set(id, { ref, openingAtomic: opening.toString(), closingAtomic: closing.toString(), outgoingSequence: sequence, encumberedAtomic: encumbered });
    const registry = await evidence.call(generation.kernel, 'registryOperator', [], closingHash);
    const binding = await evidence.call(registry, 'ownerOf', [address], closingHash);
    await own(ref, binding, { registry, address, binding, closingHash });
    for (const transfer of await evidence.chain.transfers(generation.kernel, address, generation.from, generation.through)) {
      if (transfer.block < generation.from || transfer.block > generation.through || transfer.from !== address && transfer.to !== address) throw Error('recourse_collection_transfer_range_invalid');
      let tx = transactions.get(transfer.transactionHash);
      if (!tx) { tx = await evidence.transaction(transfer.transactionHash); transactions.set(transfer.transactionHash, tx); }
      const receipt = classifyRestorationReceipt(generation.kernel, transfer, tx);
      addEvent(`${generation.kernel}:${transfer.transactionHash}:${transfer.logIndex}`, { kind: 'transfer', kernel: generation.kernel,
        transfer: { ...transfer, receipt, witnessHash: tx.evidenceHash } });
      if (transfer.from === address && transfer.to !== zero) enqueue({ kind: 'account', generation: task.generation, address: transfer.to });
    }
    if (!migration) continue;
    const institution = migration.kind === 'cryptographic_break' ? (await artifact(migration.executor)).institutions.find(row => row.source === address) : undefined;
    if (migration.kind === 'ordinary' || institution) {
      const imported = await port.balanceImport(generation.kernel, address, generations[task.generation + 1].through);
      if (!imported) {
        if (closing !== 0n || institution) throw Error('recourse_collection_import_missing');
        enqueue({ kind: 'account', generation: task.generation + 1, address });
      } else {
        if (imported.bridge.sources.length !== 1 || key(imported.bridge.sources[0].ref) !== id
          || imported.bridge.sources[0].amount !== closing || imported.bridge.destination.kind !== 'account'
          || imported.bridge.destination.kernel !== migration.kernel) throw Error('recourse_collection_import_invalid');
        consume(ref, closing); imports.add(imported.mintId);
        addEvent(`import:${id}`, { kind: 'bridge', block: imported.block, blockHash: imported.blockHash,
          logIndex: imported.logIndex, bridge: imported.bridge, evidenceHash: imported.evidenceHash });
        enqueue({ kind: 'account', generation: task.generation + 1, address: imported.bridge.destination.address });
      }
    } else if (binding !== zeroHash) {
      const partition = await port.partition(migration.executor, binding);
      if (!partition || !partition.accounts.some(row => row.address === address && BigInt(row.amountAtomic) === closing)) throw Error('recourse_collection_partition_missing');
      await schedulePartition(partition);
    } else {
      const retired: RestorationBalanceRef = { kind: 'retired', kernel: generation.kernel, address };
      consume(ref, closing); rows.set(key(retired), { ref: retired, closingAtomic: closing.toString() });
      addEvent(`retired:${id}`, { kind: 'bridge', block: migration.cutoff, blockHash: migration.cutoffHash, logIndex: null,
        bridge: { kind: 'snapshot', kernel: generation.kernel, origin: migration.executor, sources: [{ ref, amount: closing }], destination: retired },
        evidenceHash: digest({ migration, registry, address, binding, closing }) });
    }
  }
  for (const [id, amount] of consumed) {
    const row = rows.get(id);
    if (!row || BigInt(row.closingAtomic) !== amount) throw Error('recourse_collection_source_balance_invalid');
    rows.set(id, { ...row, closingAtomic: '0' });
  }
  const checkpoint: SuccessionTraceCheckpoint = { executionKernel: lineage.kernel, block, blockHash, generations,
    events: [...events.entries()].filter(([id, event]) => event.kind !== 'transfer' || !imports.has(id)).map(([, event]) => event),
    balances: [...rows.values()], owners: [...owners.values()] };
  const trace = traceRestorationSuccession(snapshot, checkpoint);
  if (await port.manifest() !== lineage.manifestHash || await evidence.currentKernel() !== lineage.kernel) throw Error('recourse_collection_protocol_changed');
  for (const [height, expected] of pins) if (await evidence.chain.blockHash(height) !== expected) throw Error('recourse_collection_reorg');
  return { executionKernel: lineage.kernel, restorationRevision, checkpoint, trace };
}
