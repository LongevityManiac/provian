import { Interface, keccak256 } from 'ethers';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { getAgreedBaseLogs, readAgreedBaseBlockHash } from '../onchain/economic-discovery';
import { RECOURSE_POOL_ABI } from './pool-state';
import { membershipAtLoss, type PoolMembershipEvent, type LossMembershipEvidence, type HistoricalMonthlyInvoice } from './membership-at-loss';
import type { LossSnapshot } from './loss-snapshot';
import { utcCalendarMonth } from './calendar-month';
import { currentProtocolDeployment } from '../protocol/runtime';

/** Canonical events, with exact transaction/log order, are the membership rule's
 * evidence. No minimum balance or continuous allowance is inferred. */
export async function readLossMembership(snapshot: LossSnapshot): Promise<LossMembershipEvidence & { readonly lossTimestamp: number }> {
  const deployment = await currentProtocolDeployment();
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw new Error('recourse_rpc_operators_not_independent');
  const headers: unknown[] = await Promise.all(legs.map(leg=>leg.provider.send('eth_getBlockByHash',[deployment.blockHash,false])));
  const heights = headers.map(header=>{
    if (!header || typeof header !== 'object' || !('hash' in header) || header.hash !== deployment.blockHash
      || !('number' in header) || typeof header.number !== 'string' || !/^0x[0-9a-f]+$/i.test(header.number)) throw new Error('recourse_membership_block_invalid');
    const height=Number(BigInt(header.number));
    if (!Number.isSafeInteger(height) || height < snapshot.block) throw new Error('recourse_membership_block_invalid');
    return height;
  });
  const head=heights[0];
  if (heights[1] !== head || await readAgreedBaseBlockHash(head) !== deployment.blockHash) throw new Error('recourse_membership_reorg');
  const headTag = { blockHash: deployment.blockHash, requireCanonical: true };
  const tag = { blockHash: snapshot.blockHash, requireCanonical: true };
  const historyAbi = new Interface(['function poolSnapshot() view returns(address predecessor,uint256 blockNumber,bytes32 root,uint256 entries,bool afterBreak)']);
  const agreed = async (method: string, params: readonly unknown[]): Promise<string> => {
    const values: unknown[] = await Promise.all(legs.map(leg => leg.provider.send(method, [...params])));
    if (typeof values[0] !== 'string' || values[0] !== values[1]) throw new Error('recourse_membership_rpc_disagreement');
    return values[0];
  };
  // The immutable snapshot predecessor links are rooted in the verified current
  // pointer. Scan original events on each pool; import events do not invent a
  // later joining date or lose the within-block order of the original join.
  const segments: { address: string; from: number; through: number }[] = [];
  let address = deployment.addresses.recoursePool.toLowerCase(), through = snapshot.block;
  let lossPool: string | undefined;
  const seen = new Set<string>();
  while (address !== `0x${'0'.repeat(40)}`) {
    if (seen.has(address)) throw new Error('recourse_pool_history_cycle');
    seen.add(address);
    const code = await agreed('eth_getCode', [address, headTag]);
    if (code === '0x' || (segments.length === 0 && seen.size === 1
      && keccak256(code) !== deployment.runtimeHashes[8])) throw new Error('recourse_pool_runtime_mismatch');
    const ancestry = historyAbi.decodeFunctionResult('poolSnapshot', await agreed('eth_call', [{to:address,
      data:historyAbi.encodeFunctionData('poolSnapshot')}, headTag]));
    const predecessor = String(ancestry[0]).toLowerCase(), cutoff = Number(ancestry[1]);
    if (!Number.isSafeInteger(cutoff) || cutoff < 0 || (predecessor !== `0x${'0'.repeat(40)}` && cutoff >= head)) throw new Error('recourse_pool_history_invalid');
    if (through > cutoff) {
      let left = cutoff, right = head;
      while (left < right) {
        const middle = left + Math.floor((right-left)/2);
        if (await agreed('eth_getCode',[address,`0x${middle.toString(16)}`]) === '0x') left=middle+1; else right=middle;
      }
      if (left < 1 || await agreed('eth_getCode',[address,`0x${(left-1).toString(16)}`]) !== '0x'
        || keccak256(await agreed('eth_getCode',[address,`0x${left.toString(16)}`])) !== keccak256(code)) throw new Error('recourse_pool_history_invalid');
      if (left <= through) {
        segments.push({address,from:left,through});
        if (!lossPool) lossPool=address;
      }
    }
    through=Math.min(through,cutoff); address=predecessor;
  }
  if (!lossPool) throw new Error('recourse_loss_predates_pool');
  const token = RECOURSE_POOL_ABI.decodeFunctionResult('token', await agreed('eth_call', [{to:lossPool,
    data:RECOURSE_POOL_ABI.encodeFunctionData('token')},tag]));
  if (String(token[0]).toLowerCase() !== snapshot.kernel) throw new Error('recourse_pool_token_mismatch');
  const config = { address:lossPool };
  const timestamps = new Map<number, { hash: string; timestamp: number }>();
  const timestampAt = async (block: number, hash: string): Promise<number> => {
    const cached = timestamps.get(block);
    if (cached) {
      if (cached.hash !== hash) throw new Error('recourse_membership_reorg');
      return cached.timestamp;
    }
    const headers: unknown[] = await Promise.all(legs.map(leg => leg.provider.send('eth_getBlockByHash', [hash, false])));
    const times = headers.map(header => {
      if (!header || typeof header !== 'object' || !('hash' in header) || header.hash !== hash
        || !('number' in header) || typeof header.number !== 'string' || BigInt(header.number) !== BigInt(block)
        || !('timestamp' in header) || typeof header.timestamp !== 'string') throw new Error('recourse_membership_block_invalid');
      const value = Number(BigInt(header.timestamp));
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('recourse_membership_block_invalid');
      return value;
    });
    if (times[0] !== times[1] || await readAgreedBaseBlockHash(block) !== hash) throw new Error('recourse_membership_reorg');
    timestamps.set(block, { hash, timestamp: times[0] });
    return times[0];
  };
  const topics = ['MembershipChanged'].map(name => RECOURSE_POOL_ABI.getEvent(name)!.topicHash);
  const events: PoolMembershipEvent[] = [];
  for (const segment of [...segments].reverse()) for (let from = segment.from; from <= segment.through; from += 500) {
    const logs = await getAgreedBaseLogs({ address: segment.address, topics: [topics, snapshot.identity],
      fromBlock: from, toBlock: Math.min(from + 499, segment.through) });
    for (const log of logs) {
      if (log.blockNumber === snapshot.block && log.logIndex >= snapshot.firstOutflowLogIndex) continue;
      if (log.removed || log.address !== segment.address) throw new Error('recourse_membership_log_invalid');
      const decoded = RECOURSE_POOL_ABI.parseLog({ topics: [...log.topics], data: log.data });
      if (!decoded || String(decoded.args[0]).toLowerCase() !== snapshot.identity) throw new Error('recourse_membership_log_invalid');
      const position = { block: log.blockNumber, logIndex: log.logIndex, blockHash: log.blockHash,
        transactionHash: log.transactionHash, timestamp: await timestampAt(log.blockNumber, log.blockHash) };
      if (decoded.name !== 'MembershipChanged') throw new Error('recourse_membership_log_invalid');
      events.push({ ...position, enrolled: Boolean(decoded.args[1]), generation: Number(decoded.args[2]) });
    }
  }
  const lossTimestamp = await timestampAt(snapshot.block, snapshot.blockHash);
  events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const invoices: HistoricalMonthlyInvoice[] = [];
  const last = events[events.length - 1];
  if (last?.enrolled) {
    const call = async (method: string, args: readonly unknown[]) => {
      const results: unknown[] = await Promise.all(legs.map(leg => leg.provider.send('eth_call', [{ to: config.address,
        data: RECOURSE_POOL_ABI.encodeFunctionData(method, args) }, tag])));
      if (typeof results[0] !== 'string' || results[0] !== results[1]) throw new Error('recourse_membership_rpc_disagreement');
      return RECOURSE_POOL_ABI.decodeFunctionResult(method, results[0]);
    };
    for (let month = utcCalendarMonth(last.timestamp); month < utcCalendarMonth(lossTimestamp); ++month) {
      const o = await call('obligations', [snapshot.identity, last.generation, month]);
      const rule = o[0] ? null : (await call('monthlyRule', [month]))[0];
      invoices.push({ month, earnings: Boolean(o[1]), burnDue: String(o[0] ? o[2] : rule[1]),
        contributionDue: String(o[1] ? o[3] : o[0] ? o[6] : rule[2]), burnPaid: String(o[4]), contributionPaid: String(o[5]) });
    }
  }
  const result = membershipAtLoss(snapshot.identity, events, { block: snapshot.block, blockHash: snapshot.blockHash,
    logIndex: snapshot.firstOutflowLogIndex, timestamp: lossTimestamp }, invoices);
  if (await readAgreedBaseBlockHash(snapshot.block) !== snapshot.blockHash) throw new Error('recourse_membership_reorg');
  if ((await currentProtocolDeployment()).manifestHash !== deployment.manifestHash) throw new Error('recourse_membership_checkpoint_changed');
  return { ...result, lossTimestamp };
}
