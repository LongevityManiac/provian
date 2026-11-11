import { createHash } from 'crypto';
import type { LossSnapshot } from './loss-snapshot';
import type { RestorationTrace, TracedTransfer } from './restoration-trace';
import { applyRestorationBalanceBridge, restorationBalanceKey as key, type RestorationBalanceRef,
  type RestorationBalanceBridge, type RestorationBridgeLedger, type RestorationComponents } from './restoration-bridge-ledger';

export type SuccessionTraceEvent =
  | { readonly kind: 'transfer'; readonly kernel: string; readonly transfer: TracedTransfer }
  | { readonly kind: 'bridge'; readonly block: number; readonly blockHash: string;
      /** null denotes the snapshot at the end of the cutoff block, not a log. */
      readonly logIndex: number | null; readonly bridge: RestorationBalanceBridge; readonly evidenceHash: string };
export interface SuccessionTraceCheckpoint {
  readonly executionKernel: string; readonly block: number; readonly blockHash: string;
  readonly generations: readonly { readonly kernel: string; readonly from: number; readonly through: number }[];
  readonly events: readonly SuccessionTraceEvent[];
  readonly owners: readonly { readonly ref: RestorationBalanceRef; readonly evidenceHash: string }[];
  /** A consumed historical account closes at zero in this accounting ledger;
   * its actual cutoff balance is the bridge's independently checked whole source.
   * Future entitlements/retired references omit openingAtomic and are created
   * only by their authenticated snapshot bridge. */
  readonly balances: readonly { readonly ref: RestorationBalanceRef; readonly openingAtomic?: string;
    readonly closingAtomic: string; readonly outgoingSequence?: string; readonly encumberedAtomic?: string }[];
}
const zero = `0x${'0'.repeat(40)}`, hash = /^0x[0-9a-f]{64}$/;
const min = (a: bigint, b: bigint) => a < b ? a : b;
const ref = (kernel: string, address: string): RestorationBalanceRef => ({ kind: 'account', kernel, address });
function amount(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) >= (1n << 256n)) throw Error('recourse_succession_trace_amount_invalid');
  return BigInt(value);
}
function position(event: SuccessionTraceEvent): readonly [number, number] {
  return event.kind === 'transfer' ? [event.transfer.block, event.transfer.logIndex] : [event.block, event.logIndex ?? Number.MAX_SAFE_INTEGER];
}
function encode(value: unknown): string {
  return JSON.stringify(value, (_name, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
}
/** Chronological accounting over independently authenticated generation ranges,
 * token logs and typed snapshot/import/restoration bridges. Only real balances
 * on the execution kernel can become reversal sources. Unissued entitlements,
 * old token balances and protected exchange proceeds retain their provenance
 * without becoming spendable current PVT. This function is not an evidence or
 * authorization boundary; its collector must establish every chain fact. */
export function traceRestorationSuccession(snapshot: LossSnapshot, checkpoint: SuccessionTraceCheckpoint): RestorationTrace {
  if (!Number.isSafeInteger(checkpoint.block) || checkpoint.block < snapshot.block || !hash.test(checkpoint.blockHash)
    || checkpoint.generations.length === 0) throw Error('recourse_succession_trace_checkpoint_invalid');
  const generations = new Map<string, { from: number; through: number; index: number }>();
  for (const [index, generation] of checkpoint.generations.entries()) {
    key(ref(generation.kernel, snapshot.addresses[0]?.address ?? zero));
    if (generations.has(generation.kernel) || !Number.isSafeInteger(generation.from) || !Number.isSafeInteger(generation.through)
      || generation.from > generation.through || generation.from !== (index === 0 ? snapshot.block : checkpoint.generations[index - 1].through + 1)) {
      throw Error('recourse_succession_trace_generation_invalid');
    }
    generations.set(generation.kernel, { ...generation, index });
  }
  const first = checkpoint.generations[0], last = checkpoint.generations[checkpoint.generations.length - 1];
  if (first.kernel !== snapshot.kernel || last.kernel !== checkpoint.executionKernel || last.through !== checkpoint.block) throw Error('recourse_succession_trace_generation_invalid');
  const rows = new Map<string, SuccessionTraceCheckpoint['balances'][number]>(), initial = new Map<string, RestorationComponents>();
  for (const row of checkpoint.balances) {
    const id = key(row.ref);
    if (rows.has(id) || row.ref.kind !== 'entitlement' && !generations.has(row.ref.kernel)) throw Error('recourse_succession_trace_balance_invalid');
    amount(row.closingAtomic);
    if (row.outgoingSequence !== undefined) amount(row.outgoingSequence);
    if (row.encumberedAtomic !== undefined) amount(row.encumberedAtomic);
    if (row.ref.kind === 'account' && row.ref.kernel === checkpoint.executionKernel && row.outgoingSequence === undefined) throw Error('recourse_succession_trace_sequence_missing');
    if (row.openingAtomic !== undefined) initial.set(id, { balance: amount(row.openingAtomic), reversible: 0n, protected: 0n });
    rows.set(id, row);
  }
  let ledger: RestorationBridgeLedger = { balances: initial, consumed: new Set() };
  const originalOwners = new Set(snapshot.addresses.map(row => key(ref(snapshot.kernel, row.address))));
  if ([...originalOwners].some(id => !rows.has(id))) throw Error('recourse_succession_trace_loss_owner_missing');
  const owners = new Set(originalOwners);
  for (const owner of checkpoint.owners) {
    if (!hash.test(owner.evidenceHash)) throw Error('recourse_succession_trace_owner_invalid');
    owners.add(key(owner.ref));
  }
  const events = [...checkpoint.events].sort((a, b) => { const left = position(a), right = position(b); return left[0] - right[0] || left[1] - right[1] || (a.kind === 'bridge' && b.kind === 'bridge' ? key(a.bridge.destination).localeCompare(key(b.bridge.destination)) : 0); });
  const positions = new Set<string>(), pins = new Map<number, string>();
  const expected = new Map(snapshot.outflows.map(outflow => [`${outflow.block}:${outflow.logIndex}`, outflow])), seen = new Set<string>();
  let returned = 0n, exchanged = 0n, destroyed = 0n;
  const set = (id: string, value: RestorationComponents): void => {
    if (!rows.has(id) || ledger.consumed.has(id) || value.balance < 0n || value.reversible < 0n || value.protected < 0n
      || value.reversible + value.protected > value.balance) throw Error('recourse_succession_trace_history_incomplete');
    const balances = new Map(ledger.balances); balances.set(id, value); ledger = { ...ledger, balances };
  };
  const get = (id: string): RestorationComponents => {
    const value = ledger.balances.get(id);
    if (!value || ledger.consumed.has(id)) throw Error('recourse_succession_trace_history_incomplete');
    return value;
  };
  for (const event of events) {
    const [block, index] = position(event), blockHash = event.kind === 'transfer' ? event.transfer.blockHash : event.blockHash;
    if (!Number.isSafeInteger(block) || block < snapshot.block || block > checkpoint.block || !Number.isSafeInteger(index) || index < 0
      || !hash.test(blockHash) || pins.has(block) && pins.get(block) !== blockHash
      || block === snapshot.block && blockHash !== snapshot.blockHash || block === checkpoint.block && blockHash !== checkpoint.blockHash) throw Error('recourse_succession_trace_event_invalid');
    pins.set(block, blockHash);
    // Several independent owner partitions share an end-of-block snapshot.
    const positionKey = `${block}:${index}:${event.kind === 'bridge' && event.logIndex === null ? key(event.bridge.destination) : ''}`;
    if (positions.has(positionKey)) throw Error('recourse_succession_trace_event_duplicate');
    positions.add(positionKey);
    if (event.kind === 'bridge') {
      const bridge = event.bridge, sourceGeneration = generations.get(bridge.kernel);
      if (!hash.test(event.evidenceHash) || !sourceGeneration || !rows.has(key(bridge.destination))) throw Error('recourse_succession_trace_bridge_invalid');
      if (bridge.kind === 'snapshot') {
        if (event.logIndex !== null || block !== sourceGeneration.through || sourceGeneration.index + 1 >= checkpoint.generations.length) throw Error('recourse_succession_trace_bridge_invalid');
      } else {
        const destinationGeneration = bridge.destination.kind === 'account' ? generations.get(bridge.destination.kernel) : null;
        if (event.logIndex === null || !destinationGeneration || block < destinationGeneration.from || block > destinationGeneration.through
          || bridge.kind === 'succession' && destinationGeneration.index !== sourceGeneration.index + 1) throw Error('recourse_succession_trace_bridge_invalid');
      }
      const destination = key(bridge.destination), before = ledger.balances.get(destination);
      ledger = applyRestorationBalanceBridge(ledger, bridge);
      const after = get(destination);
      if (owners.has(destination)) {
        const reversible = after.reversible - (before?.reversible ?? 0n), protectedValue = after.protected - (before?.protected ?? 0n);
        returned += reversible + protectedValue;
        set(destination, { ...after, reversible: after.reversible - reversible, protected: after.protected - protectedValue });
      }
      continue;
    }
    const transfer = event.transfer, generation = generations.get(event.kernel);
    if (!generation || block < generation.from || block > generation.through || !hash.test(transfer.transactionHash)
      || !hash.test(transfer.witnessHash) || !['gratuitous', 'witnessed_exchange', 'unresolved', 'custody_succession'].includes(transfer.receipt)) throw Error('recourse_succession_trace_transfer_invalid');
    const from = transfer.from === zero ? null : key(ref(event.kernel, transfer.from));
    const to = transfer.to === zero ? null : key(ref(event.kernel, transfer.to));
    const quantity = amount(transfer.amountAtomic), source = from === null || !rows.has(from) ? null : get(from), destination = to === null ? null : get(to);
    const outflow = event.kernel === snapshot.kernel ? expected.get(`${block}:${index}`) : undefined;
    if (outflow) {
      if (outflow.transactionHash !== transfer.transactionHash || outflow.from !== transfer.from || outflow.to !== transfer.to
        || outflow.amountAtomic !== transfer.amountAtomic) throw Error('recourse_succession_trace_loss_mismatch');
      seen.add(`${block}:${index}`);
    }
    if (source && source.balance < quantity) throw Error('recourse_succession_trace_history_incomplete');
    if (from === to) continue;
    const beforeLoss = block === snapshot.block && index < snapshot.firstOutflowLogIndex;
    const originalLoss = !beforeLoss && outflow !== undefined && from !== null && originalOwners.has(from) && (to === null || !originalOwners.has(to));
    const reversible = beforeLoss ? 0n : originalLoss ? quantity : min(source?.reversible ?? 0n, quantity);
    const protectedValue = beforeLoss || originalLoss ? 0n : min(source?.protected ?? 0n, quantity - reversible), carried = reversible + protectedValue;
    if (source && from !== null) set(from, { balance: source.balance - quantity,
      reversible: source.reversible - (originalLoss ? 0n : reversible), protected: source.protected - protectedValue });
    let incomingReversible = 0n, incomingProtected = 0n;
    if (carried !== 0n) {
      if (to !== null && owners.has(to)) {
        if ((from !== null && owners.has(from) || transfer.receipt === 'gratuitous' || transfer.receipt === 'custody_succession')
          && (transfer.transactionHash !== snapshot.transactionHash || !originalOwners.has(to))) returned += carried;
      } else if (to === null) destroyed += carried;
      else if (transfer.receipt === 'gratuitous' || transfer.receipt === 'custody_succession') { incomingReversible = reversible; incomingProtected = protectedValue; }
      else { incomingProtected = carried; if (transfer.receipt === 'witnessed_exchange') exchanged += reversible; }
    }
    if (destination && to !== null) set(to, { balance: destination.balance + quantity,
      reversible: destination.reversible + incomingReversible, protected: destination.protected + incomingProtected });
  }
  if (seen.size !== expected.size) throw Error('recourse_succession_trace_loss_missing');
  for (const [id, row] of rows) {
    const value = ledger.balances.get(id);
    if (!value || value.balance !== amount(row.closingAtomic)) throw Error('recourse_succession_trace_history_incomplete');
  }
  if (ledger.balances.size !== rows.size) throw Error('recourse_succession_trace_history_incomplete');
  const original = amount(snapshot.lossAtomic), returnedValue = min(original, returned), outstanding = original - returnedValue;
  const candidates = [...rows].flatMap(([id, row]) => {
    if (row.ref.kind !== 'account' || row.ref.kernel !== checkpoint.executionKernel || owners.has(id)) return [];
    const value = ledger.balances.get(id)!, encumbered = amount(row.encumberedAtomic ?? '0');
    const reachable = min(value.reversible, value.balance > encumbered ? value.balance - encumbered : 0n);
    return reachable === 0n ? [] : [{ address: row.ref.address, reachable, sequence: row.outgoingSequence! }];
  }).sort((a, b) => a.address.localeCompare(b.address));
  const reachable = candidates.reduce((total, row) => total + row.reachable, 0n), reversible = min(reachable, outstanding);
  let assigned = 0n, cumulative = 0n;
  const sources = candidates.map(row => { cumulative += row.reachable; const allocation = cumulative * reversible / reachable - assigned;
    assigned += allocation; return { address: row.address, amountAtomic: allocation.toString(), outgoingSequence: row.sequence }; }).filter(row => row.amountAtomic !== '0');
  const result = { sources, reversibleAtomic: reversible.toString(), shortfallAtomic: (outstanding - reversible).toString(),
    returnedAtomic: returnedValue.toString(), witnessedExchangeAtomic: exchanged.toString(), destroyedAtomic: destroyed.toString(), checkpointHash: checkpoint.blockHash };
  return { ...result, evidenceHash: `0x${createHash('sha256').update(encode({ rule: 'provian restoration tracing across succession', loss: snapshot.evidenceHash,
    checkpoint: { ...checkpoint, events, balances: [...checkpoint.balances].sort((a, b) => key(a.ref).localeCompare(key(b.ref))),
      owners: [...checkpoint.owners].sort((a, b) => key(a.ref).localeCompare(key(b.ref))) }, result })).digest('hex')}` };
}
