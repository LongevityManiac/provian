import { createHash } from 'crypto';
import type { TransferEvent } from './ownership';
import type { LossSnapshot } from './loss-snapshot';

/** These classifications are constructed by the relay's independent evidence
 * verifier, never accepted from the restoration-request body. Unknown evidence
 * cannot authorize destruction at a recipient. */
export interface TracedTransfer extends TransferEvent {
  readonly receipt: 'gratuitous' | 'witnessed_exchange' | 'unresolved' | 'custody_succession';
  readonly witnessHash: string;
}
export interface TraceCheckpoint {
  readonly block: number;
  readonly blockHash: string;
  /** Complete canonical Transfer history of every reached address, including
   * clean incoming funds, with each balance independently reconciled. */
  readonly transfers: readonly TracedTransfer[];
  /** Independently verified current, prior and recovered addresses of the same
   * owner. This is distinct from the portfolio bound before the reported loss. */
  readonly ownerAliases: readonly { readonly address: string; readonly evidenceHash: string }[];
  readonly accounts: readonly {
    readonly address: string;
    readonly openingAtomic: string;
    readonly closingAtomic: string;
    readonly outgoingSequence: string;
    /** Block-pinned, token-specific obligations independently read on-chain. */
    readonly encumberedAtomic?: string;
  }[];
}
export interface RestorationTrace {
  readonly sources: readonly { readonly address: string; readonly amountAtomic: string; readonly outgoingSequence: string }[];
  readonly reversibleAtomic: string;
  readonly shortfallAtomic: string;
  readonly returnedAtomic: string;
  readonly witnessedExchangeAtomic: string;
  readonly destroyedAtomic: string;
  readonly checkpointHash: string;
  readonly evidenceHash: string;
}
const ZERO = `0x${'0'.repeat(40)}`;
const addressPattern = /^0x[0-9a-f]{40}$/;
const hashPattern = /^0x[0-9a-f]{64}$/;
function amount(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('recourse_trace_amount_invalid');
  return BigInt(value);
}
const minimum = (a: bigint, b: bigint) => a < b ? a : b;
const digest = (value: unknown) => `0x${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

/** Published tracing rule: follow the recorded outflow in chain order. When
 * tainted and unrelated PVT mix, an outgoing transfer carries the traced amount
 * first, up to its size. A witnessed exchange ends that trail; a gratuitous
 * receipt continues it. Returns to the owner reduce the outstanding loss. No
 * new receipt can replenish a spent trail, and no source contributes more than
 * its reconciled current balance. Source outgoing-sequence fences make this
 * exact checkpoint unusable if any source spends before execution.
 *
 * This function establishes reachability, NOT whether a theft occurred. Its
 * output cannot itself admit evidence, sign a reversal or allocate the reserve.
 */
export function traceRestoration(snapshot: LossSnapshot, checkpoint: TraceCheckpoint): RestorationTrace {
  if (!Number.isSafeInteger(checkpoint.block) || checkpoint.block < snapshot.block
    || !hashPattern.test(checkpoint.blockHash)) throw new Error('recourse_trace_checkpoint_invalid');
  const lossOwners = new Set(snapshot.addresses.map(row => row.address));
  const owners = new Set(lossOwners);
  for (const alias of checkpoint.ownerAliases) {
    if (!addressPattern.test(alias.address) || alias.address === ZERO || !hashPattern.test(alias.evidenceHash)) throw new Error('recourse_trace_alias_invalid');
    owners.add(alias.address);
  }
  const events = [...checkpoint.transfers].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const positions = new Set<string>();
  const blockHashes = new Map<number, string>();
  const balances = new Map<string, bigint>();
  const accountRows = new Map(checkpoint.accounts.map(row => [row.address, row]));
  if (accountRows.size !== checkpoint.accounts.length) throw new Error('recourse_trace_account_duplicate');
  for (const row of checkpoint.accounts) {
    if (!addressPattern.test(row.address) || row.address === ZERO) throw new Error('recourse_trace_account_invalid');
    amount(row.outgoingSequence); amount(row.closingAtomic);
    if (row.encumberedAtomic !== undefined) amount(row.encumberedAtomic);
    balances.set(row.address, amount(row.openingAtomic));
  }
  const traced = new Map<string, bigint>();
  // Protected or unresolved trails cannot be reversed, but are still followed
  // so a later return to the owner cannot also receive a reserve allocation.
  const protectedTrail = new Map<string, bigint>();
  let returnedAfterLoss = 0n, exchanged = 0n, destroyed = 0n;
  const expectedOutflows = new Map(snapshot.outflows.map(event => [`${event.block}:${event.logIndex}`, event]));
  const seenOutflows = new Set<string>();
  for (const event of events) {
    const key = `${event.block}:${event.logIndex}`;
    if (!Number.isSafeInteger(event.block) || event.block < snapshot.block || event.block > checkpoint.block
      || !Number.isSafeInteger(event.logIndex) || event.logIndex < 0 || positions.has(key)
      || !hashPattern.test(event.blockHash) || !hashPattern.test(event.transactionHash)
      || !addressPattern.test(event.from) || !addressPattern.test(event.to)
      || !hashPattern.test(event.witnessHash)) throw new Error('recourse_trace_event_invalid');
    positions.add(key);
    const previousHash = blockHashes.get(event.block);
    if (previousHash && previousHash !== event.blockHash
      || event.block === snapshot.block && event.blockHash !== snapshot.blockHash
      || event.block === checkpoint.block && event.blockHash !== checkpoint.blockHash) throw new Error('recourse_trace_reorg');
    blockHashes.set(event.block, event.blockHash);
    const quantity = amount(event.amountAtomic);
    if (balances.has(event.from)) {
      const next = balances.get(event.from)! - quantity;
      if (next < 0n) throw new Error('recourse_trace_history_incomplete');
      balances.set(event.from, next);
    }
    if (balances.has(event.to)) balances.set(event.to, balances.get(event.to)! + quantity);
    const expected = expectedOutflows.get(key);
    if (expected) {
      if (expected.transactionHash !== event.transactionHash || expected.from !== event.from
        || expected.to !== event.to || expected.amountAtomic !== event.amountAtomic) throw new Error('recourse_trace_loss_mismatch');
      seenOutflows.add(key);
    }
    if (event.block === snapshot.block && event.logIndex < snapshot.firstOutflowLogIndex || event.from === event.to) continue;
    const originalLoss = expected !== undefined && lossOwners.has(event.from) && !lossOwners.has(event.to);
    const reversibleCarry = originalLoss ? quantity : minimum(traced.get(event.from) ?? 0n, quantity);
    const protectedCarry = originalLoss ? 0n : minimum(protectedTrail.get(event.from) ?? 0n, quantity - reversibleCarry);
    const carried = reversibleCarry + protectedCarry;
    if (!originalLoss) {
      if (reversibleCarry !== 0n) traced.set(event.from, traced.get(event.from)! - reversibleCarry);
      if (protectedCarry !== 0n) protectedTrail.set(event.from, protectedTrail.get(event.from)! - protectedCarry);
    }
    if (carried === 0n) continue;
    if (owners.has(event.to)) {
      // The snapshot nets same-transaction refunds only for its original
      // portfolio. A later-bound alias was excluded there and must offset here.
      // A new purchase from the victim is earned consideration, not restitution.
      // Only an evidenced gratuitous return offsets the original loss.
      if ((owners.has(event.from) || event.receipt === 'gratuitous' || event.receipt === 'custody_succession')
        && (event.transactionHash !== snapshot.transactionHash || !lossOwners.has(event.to))) returnedAfterLoss += carried;
    } else if (event.to === ZERO) {
      destroyed += carried;
    } else {
      if (!accountRows.has(event.to)) throw new Error('recourse_trace_recipient_history_missing');
      if (event.receipt === 'gratuitous' || event.receipt === 'custody_succession') {
        traced.set(event.to, (traced.get(event.to) ?? 0n) + reversibleCarry);
        protectedTrail.set(event.to, (protectedTrail.get(event.to) ?? 0n) + protectedCarry);
      } else {
        if (event.receipt === 'witnessed_exchange') exchanged += reversibleCarry;
        // Unknown consideration blocks destruction, never the member's request.
        protectedTrail.set(event.to, (protectedTrail.get(event.to) ?? 0n) + carried);
      }
    }
  }
  if (seenOutflows.size !== expectedOutflows.size) throw new Error('recourse_trace_loss_missing');
  for (const row of checkpoint.accounts) {
    if (balances.get(row.address) !== amount(row.closingAtomic)) throw new Error('recourse_trace_history_incomplete');
  }
  for (const account of new Set([...traced.keys(), ...protectedTrail.keys()])) {
    if ((traced.get(account) ?? 0n) + (protectedTrail.get(account) ?? 0n) > amount(accountRows.get(account)!.closingAtomic)) {
      throw new Error('recourse_trace_history_incomplete');
    }
  }
  const originalLoss = amount(snapshot.lossAtomic);
  const returned = minimum(originalLoss, returnedAfterLoss);
  const outstanding = originalLoss - returned;
  const candidates = [...traced].map(([account, value]): [string, bigint] => {
    const row = accountRows.get(account)!;
    const balance = amount(row.closingAtomic), encumbered = amount(row.encumberedAtomic ?? '0');
    return [account, minimum(value, balance > encumbered ? balance - encumbered : 0n)];
  }).filter(([account, value]) => value > 0n && !owners.has(account))
    .sort(([a], [b]) => a.localeCompare(b));
  let reachable = 0n;
  for (const [account, value] of candidates) {
    if (value > amount(accountRows.get(account)!.closingAtomic)) throw new Error('recourse_trace_history_incomplete');
    reachable += value;
  }
  const reversible = minimum(reachable, outstanding);
  // Same-transaction refunds can come from clean funds. Distribute the reduced
  // outstanding amount across reachable sources without exceeding that loss.
  let assigned = 0n, cumulative = 0n;
  const sources = candidates.map(([account, value]) => {
    cumulative += value;
    const allocation = cumulative * reversible / reachable - assigned;
    assigned += allocation;
    return { address: account, amountAtomic: allocation.toString(), outgoingSequence: accountRows.get(account)!.outgoingSequence };
  }).filter(row => row.amountAtomic !== '0');
  const result = { sources, reversibleAtomic: reversible.toString(), shortfallAtomic: (outstanding - reversible).toString(),
    returnedAtomic: returned.toString(), witnessedExchangeAtomic: exchanged.toString(), destroyedAtomic: destroyed.toString(),
    checkpointHash: checkpoint.blockHash };
  return { ...result, evidenceHash: digest({ rule: 'provian restoration tracing', loss: snapshot.evidenceHash,
    checkpoint: { ...checkpoint, transfers: events, ownerAliases: [...checkpoint.ownerAliases].sort((a, b) => a.address.localeCompare(b.address)), accounts: [...checkpoint.accounts].sort((a, b) => a.address.localeCompare(b.address)) }, result }) };
}
