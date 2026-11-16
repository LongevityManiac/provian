import { matchesPlannedCall } from '../onchain/builder-code';
import { Interface, Transaction, keccak256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { currentProtocolDeployment } from '../protocol/runtime';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
import { getAgreedBaseLogs, readAgreedBaseBlockHash, type CanonicalEconomicLog } from '../onchain/economic-discovery';
import { RECOURSE_POOL_ABI } from './pool-abi';
import { DETERMINATION_WORKFLOWS } from './determination-workflow';
import { RESTORATION_REQUESTS } from './restoration-request';
import { RECOURSE_EXECUTIONS, recourseExecutionId, type RecourseExecutionCall } from './execution-transaction';
import { finalizedOwnerTransaction, RECOURSE_CONFIRMATIONS } from './transaction-finality';

const history = new Interface(['function poolSnapshot() view returns(address predecessor,uint256 blockNumber,bytes32 root,uint256 entries,bool afterBreak)']);
const ZERO = `0x${'0'.repeat(40)}`;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('recourse_withdrawal_rpc_invalid');
  return value as Record<string, unknown>;
}
function height(value: unknown): number {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw Error('recourse_withdrawal_rpc_invalid');
  const n = Number(BigInt(value));
  if (!Number.isSafeInteger(n) || n < 0) throw Error('recourse_withdrawal_rpc_invalid');
  return n;
}
/** An owner or another gas payer can withdraw an allocation before our worker.
 * Discover that actual finalized event through the current pool's immutable
 * ancestry, including imported allocations. This never releases our own
 * outstanding sponsored nonce or manufactures a signer transaction record. */
export async function findPoolWithdrawal(db: Firestore, request: string): Promise<CanonicalEconomicLog | null> {
  const [workflow, submitted] = await Promise.all([
    db.collection(DETERMINATION_WORKFLOWS).doc(request).get(), db.collection(RESTORATION_REQUESTS).doc(request).get(),
  ]);
  const transactions = workflow.get('transactions') as Record<string, string> | undefined;
  const identity: unknown = submitted.get('identity');
  if (!workflow.exists || !submitted.exists || !transactions?.allocate || typeof identity !== 'string') throw Error('recourse_withdrawal_allocation_missing');
  const rows = await db.collection(RECOURSE_EXECUTIONS).where('transactionHash', '==', transactions.allocate).get();
  if (rows.size !== 1) throw Error('recourse_withdrawal_allocation_missing');
  const row = rows.docs[0], plan = row.get('plan') as RecourseExecutionCall, raw: unknown = row.get('signedTransaction');
  if (!plan || plan.kind !== 'allocate' || row.id !== recourseExecutionId(plan) || typeof raw !== 'string'
    || keccak256(raw) !== transactions.allocate || row.get('status') !== 'confirmed') throw Error('recourse_withdrawal_allocation_invalid');
  const tx = Transaction.from(raw);
  if (!matchesPlannedCall(tx.data, plan.calldata) || tx.to?.toLowerCase() !== plan.executor || tx.from?.toLowerCase() !== plan.signer) throw Error('recourse_withdrawal_allocation_invalid');
  const allocation = await finalizedOwnerTransaction(raw);
  if (!allocation || allocation.status !== 1) throw Error('recourse_withdrawal_allocation_not_finalized');
  const deployment = await currentProtocolDeployment(), legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw Error('recourse_rpc_operators_not_independent');
  const agree = async (method: string, params: readonly unknown[]) => {
    const results: unknown[] = await Promise.all(legs.map(leg => leg.provider.send(method, [...params])));
    if (!rpcChainFactsEqual(results[0], results[1])) throw Error('recourse_withdrawal_rpc_disagreement');
    return results[0];
  };
  const tag = {blockHash:deployment.blockHash,requireCanonical:true};
  const call = async (address: string, abi: Interface, method: string, args: readonly unknown[] = []) => {
    const value = await agree('eth_call', [{to:address,data:abi.encodeFunctionData(method,args)},tag]);
    if (typeof value !== 'string') throw Error('recourse_withdrawal_rpc_invalid');
    return abi.decodeFunctionResult(method,value);
  };
  const pool = deployment.addresses.recoursePool.toLowerCase();
  const balance = await call(pool, RECOURSE_POOL_ABI, 'restorationAllocations', [request]);
  if (balance.identity !== identity) throw Error('recourse_withdrawal_identity_invalid');
  if (!balance.withdrawn) return null;
  const heads = await Promise.all(legs.map(async leg => height(await leg.provider.send('eth_blockNumber',[]))));
  let through = Math.min(...heads) - (RECOURSE_CONFIRMATIONS - 1), address = pool;
  const seen = new Set<string>(), matches: CanonicalEconomicLog[] = [];
  let previousCutoff=Number.MAX_SAFE_INTEGER;
  let reachedAllocationPool = false;
  while (address !== ZERO && through >= allocation.block) {
    if (seen.has(address)) throw Error('recourse_withdrawal_history_cycle');
    seen.add(address);
    const ancestry = await call(address, history, 'poolSnapshot');
    const predecessor = String(ancestry.predecessor).toLowerCase(), cutoff = Number(ancestry.blockNumber);
    if (!Number.isSafeInteger(cutoff) || cutoff < 0 || cutoff>=previousCutoff) throw Error('recourse_withdrawal_history_invalid');
    previousCutoff=cutoff;
    if (address === plan.executor) reachedAllocationPool = true;
    for (let from = Math.max(allocation.block, cutoff + 1); from <= through; from += 500) {
      const logs = await getAgreedBaseLogs({address,topics:[RECOURSE_POOL_ABI.getEvent('RestorationWithdrawn')!.topicHash,request],
        fromBlock:from,toBlock:Math.min(from+499,through)});
      for (const log of logs) {
        if (log.removed || log.address !== address || await readAgreedBaseBlockHash(log.blockNumber) !== log.blockHash) throw Error('recourse_withdrawal_log_invalid');
        const event = RECOURSE_POOL_ABI.parseLog({topics:[...log.topics],data:log.data});
        if (!event || event.args.request !== request || event.args.amount !== balance.amount) throw Error('recourse_withdrawal_amount_invalid');
        const receipt = object(await agree('eth_getTransactionReceipt',[log.transactionHash]));
        if (receipt.transactionHash !== log.transactionHash || receipt.blockHash !== log.blockHash || height(receipt.status) !== 1
          || height(receipt.blockNumber) !== log.blockNumber || !Array.isArray(receipt.logs)
          || !receipt.logs.some(entry => {
            const item=object(entry);
            return height(item.logIndex)===log.logIndex && item.address===log.address && item.data===log.data
              && rpcChainFactsEqual(item.topics,log.topics);
          })) throw Error('recourse_withdrawal_receipt_invalid');
        matches.push(log);
      }
    }
    if (reachedAllocationPool) break;
    through = Math.min(through, cutoff); address = predecessor;
  }
  if (!reachedAllocationPool || matches.length > 1) throw Error('recourse_withdrawal_history_invalid');
  if ((await currentProtocolDeployment({ fresh: true })).manifestHash !== deployment.manifestHash) throw Error('recourse_withdrawal_pointer_changed');
  if (matches[0] && await readAgreedBaseBlockHash(matches[0].blockNumber) !== matches[0].blockHash) throw Error('recourse_withdrawal_log_invalid');
  return matches[0] ?? null;
}
