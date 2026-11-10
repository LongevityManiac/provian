import { createHash } from 'crypto';
import { registeredBalanceAt, type RegisteredAddress, type TransferEvent } from './ownership';
import { snapshotRegisteredBalance, createRecourseChainPort, type RecourseChainPort } from './chain-ledger';

export interface LossSnapshot {
  readonly identity: string; readonly kernel: string; readonly block: number; readonly blockHash: string;
  readonly transactionHash: string; readonly firstOutflowLogIndex: number;
  readonly recordedBalanceAtomic: string;
  readonly lossAtomic: string;
  readonly addresses: readonly { readonly address: string; readonly balanceAtomic: string; readonly bindingDigest: string }[];
  readonly outflows: readonly TransferEvent[];
  readonly occurrence: string; readonly evidenceHash: string;
}

/** A loss is anchored to an observed token outflow, never a supplied amount.
 * All outflows from bound addresses in the transaction form one occurrence.
 * The portfolio is measured immediately before its first outflow. The loss
 * excludes untouched holdings and offsets returns within the same transaction. */
export async function snapshotReportedLoss(identity: string, transactionHash: string, block: number,
  bindings: readonly RegisteredAddress[], chain: RecourseChainPort = createRecourseChainPort()): Promise<LossSnapshot> {
  if (!/^0x[0-9a-f]{64}$/.test(identity) || !/^0x[0-9a-f]{64}$/.test(transactionHash)
    || !Number.isSafeInteger(block) || block < 1 || bindings.length === 0) throw new Error('recourse_loss_input_invalid');
  const canonical = [...bindings].sort((a, b) => a.address.localeCompare(b.address));
  const kernel = canonical[0].kernel;
  const seen = new Set<string>();
  for (const binding of canonical) {
    if (binding.identity !== identity || binding.kernel !== kernel || seen.has(binding.address)) throw new Error('recourse_loss_binding_invalid');
    seen.add(binding.address);
  }
  const admitted = canonical.filter(binding => binding.boundBlock < block || binding.boundBlock === block
    && Number.isSafeInteger(binding.boundLogIndex) && binding.boundLogIndex! >= 0);
  if (admitted.length === 0 || block > await chain.finalizedBlock()) throw new Error('recourse_loss_not_finalized_or_bound');
  const blockHash = await chain.blockHash(block);
  if (!blockHash) throw new Error('recourse_loss_block_unavailable');
  const histories: { binding: RegisteredAddress; before: bigint; events: readonly TransferEvent[] }[] = [];
  for (const binding of admitted) {
    const previousHash = binding.boundBlock === block ? await chain.blockHash(block - 1) : null;
    if (binding.boundBlock === block && (!previousHash || binding.boundBlockHash !== blockHash)) throw new Error('recourse_loss_binding_invalid');
    const previous = binding.boundBlock === block
      ? { throughBlockHash: previousHash!, balanceAtomic: (await chain.balance(kernel, binding.address, previousHash!)).toString() }
      : await snapshotRegisteredBalance(binding, block - 1, chain);
    const events = await chain.transfers(kernel, binding.address, block, block);
    const baseline = { ...binding, boundBlock: block - 1, boundBlockHash: previous.throughBlockHash,
      openingBalanceAtomic: previous.balanceAtomic };
    const end = registeredBalanceAt(baseline, events, block);
    if (events.some(event => event.blockHash !== blockHash)
      || end.balanceAtomic !== await chain.balance(kernel, binding.address, blockHash)) throw new Error('recourse_loss_ledger_incomplete');
    histories.push({ binding, before: BigInt(previous.balanceAtomic), events });
  }
  const candidateOutflows = histories.flatMap(({ binding, events }) => events.filter(event => event.transactionHash === transactionHash
    && event.from === binding.address && (binding.boundBlock < block || event.logIndex > binding.boundLogIndex!) && event.to !== binding.address && BigInt(event.amountAtomic) > 0n))
    .sort((a, b) => a.logIndex - b.logIndex);
  // Transfers between this owner's bound addresses are not a portfolio loss.
  const boundBefore = (binding: RegisteredAddress, logIndex: number): boolean =>
    binding.boundBlock < block || binding.boundLogIndex! < logIndex;
  const externalOutflows = candidateOutflows.filter(event => !admitted.some(binding =>
    binding.address === event.to && boundBefore(binding, event.logIndex)));
  if (externalOutflows.length === 0) throw new Error('recourse_loss_outflow_missing');
  const firstOutflowLogIndex = externalOutflows[0].logIndex;
  // An address bound later in this very transaction cannot enlarge the portfolio
  // that existed at the loss. Later independently verified owner aliases are
  // considered by tracing as returned funds, never as additional stolen holdings.
  const portfolio = histories.filter(({ binding }) => boundBefore(binding, firstOutflowLogIndex));
  const admittedAddresses = new Set(portfolio.map(({ binding }) => binding.address));
  const outflows = candidateOutflows.filter(event => admittedAddresses.has(event.from));
  let total = 0n;
  const addresses = portfolio.map(({ binding, before, events }) => {
    let balance = before;
    for (const event of events) {
      if (event.logIndex >= firstOutflowLogIndex) break;
      const amount = BigInt(event.amountAtomic);
      if (event.from === binding.address) balance -= amount;
      if (event.to === binding.address) balance += amount;
    }
    if (balance < 0n) throw new Error('recourse_loss_ledger_incomplete');
    total += balance;
    return { address: binding.address, balanceAtomic: balance.toString(), bindingDigest: binding.bindingDigest };
  });
  if (total <= 0n) throw new Error('recourse_loss_balance_empty');
  const uniqueEvents = new Map<number, TransferEvent>();
  for (const { events } of portfolio) for (const event of events) {
    if (event.transactionHash === transactionHash && event.logIndex >= firstOutflowLogIndex) uniqueEvents.set(event.logIndex, event);
  }
  let loss = 0n;
  for (const event of uniqueEvents.values()) {
    const fromOwner = admittedAddresses.has(event.from), toOwner = admittedAddresses.has(event.to);
    if (fromOwner && !toOwner) loss += BigInt(event.amountAtomic);
    if (!fromOwner && toOwner) loss -= BigInt(event.amountAtomic);
  }
  if (loss <= 0n) throw new Error('recourse_loss_net_outflow_missing');
  if (loss > total) throw new Error('recourse_loss_ledger_incomplete');
  const digest = (value: unknown) => `0x${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
  const occurrence = digest(['provian recourse loss transaction', identity, kernel, transactionHash]);
  const evidence = { identity, kernel, block, blockHash, transactionHash, firstOutflowLogIndex,
    recordedBalanceAtomic: total.toString(), lossAtomic: loss.toString(), addresses, outflows, occurrence };
  if (await chain.blockHash(block) !== blockHash) throw new Error('recourse_loss_reorg');
  return { ...evidence, evidenceHash: digest(evidence) };
}
