import type { Firestore } from 'firebase-admin/firestore';
import { Interface } from 'ethers';
import { currentProtocolDeployment } from '../protocol/runtime';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
import { getAgreedBaseLogs, verifyBaseTransactionEvidence, type BaseTransactionEvidence, type CanonicalEconomicLog } from '../onchain/economic-discovery';
import { createRecourseChainPort, type RecourseChainPort } from './chain-ledger';
import { readRestorationSuccessionLineage, type RestorationSuccessionLineage } from './restoration-lineage';
import { readStoredBreakArtifact } from './break-artifact-store';
import type { VerifiedBreakArtifact } from './break-artifact';
import { authenticateRestorationExecutor, type RestorationExecutorRuntimePort } from './restoration-executor-runtime';
import { RESTORATION_RECEIPT_EVENTS, verifyHistoricalRestorationInterval, type HistoricalRestorationInterval } from './restoration-receipt-interval';

const abi = new Interface(['function ownerAuthorization() view returns(address)', 'function kernel() view returns(address)',
  'function breakOrigin() view returns(address)', 'function lastGoodBlock() view returns(uint256)',
  'function previousAuthorization() view returns(address)', 'function restoredIdentity(bytes32) view returns(bool)',
  'function predecessor() view returns(address)', 'function restorationRoot() view returns(bytes32)']);
const zero = `0x${'0'.repeat(40)}`, hash = /^0x[0-9a-f]{64}$/;
type Method = 'ownerAuthorization' | 'kernel' | 'breakOrigin' | 'lastGoodBlock' | 'previousAuthorization' | 'restoredIdentity' | 'predecessor' | 'restorationRoot';
export interface HistoricalBreakReceiptPort {
  readonly chain: Pick<RecourseChainPort, 'blockHash' | 'finalizedBlock'>;
  manifest(): Promise<string>;
  lineage(kernel: string): Promise<RestorationSuccessionLineage & { readonly block: number; readonly blockHash: string }>;
  authenticateExecutor(executor: string, kernel: string, pin: string): Promise<void>;
  artifact(origin: string): Promise<VerifiedBreakArtifact>;
  call(target: string, method: Method, args: readonly unknown[], pin: string): Promise<unknown>;
  logs(executor: string, identity: string, from: number, through: number): Promise<readonly CanonicalEconomicLog[]>;
  transaction(hash: string): Promise<BaseTransactionEvidence>;
}
function address(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw Error('recourse_break_receipt_domain_invalid');
  return value.toLowerCase();
}
/** Read the one local restoration of a binding in this kernel's execution
 * generation. An ordinary successor may execute a previous break entitlement;
 * inherited completed restorations return null here and remain in their own
 * generation's history. No current owner key/nonce is used as historical proof. */
export async function readHistoricalBreakRestoration(kernel: string, identity: string, through: number,
  port: HistoricalBreakReceiptPort): Promise<HistoricalRestorationInterval | null> {
  kernel = address(kernel);
  if (kernel === zero || !hash.test(identity) || /^0x0+$/.test(identity) || !Number.isSafeInteger(through)
    || through < 1 || through > await port.chain.finalizedBlock()) throw Error('recourse_break_receipt_checkpoint_invalid');
  // Authenticate historical membership and exclude the discarded tail beyond
  // the immediate successor cutoff before interpreting any execution.
  const lineage = await port.lineage(kernel), manifest = lineage.manifestHash;
  const next = lineage.migrations[0];
  if (next ? next.predecessor !== kernel || through > next.cutoff : lineage.kernel !== kernel) {
    throw Error('recourse_break_receipt_discarded_history');
  }
  const pin = await port.chain.blockHash(through);
  if (!pin || !hash.test(pin)) throw Error('recourse_break_receipt_checkpoint_invalid');
  const call = (target: string, method: Method, args: readonly unknown[] = []) => port.call(target, method, args, pin);
  const executor = address(await call(kernel, 'ownerAuthorization'));
  if (executor === zero || address(await call(executor, 'kernel')) !== kernel) throw Error('recourse_break_receipt_domain_invalid');
  await port.authenticateExecutor(executor, kernel, pin);
  const origin = address(await call(executor, 'breakOrigin'));
  if (origin === zero) throw Error('recourse_break_receipt_origin_missing');
  const cutoff = await call(executor, 'lastGoodBlock');
  if (typeof cutoff !== 'bigint' || cutoff < 1n || cutoff >= BigInt(through)) throw Error('recourse_break_receipt_checkpoint_invalid');
  const artifact = await port.artifact(origin);
  if (address(await call(origin, 'predecessor')) !== artifact.domain.predecessor
    || await call(origin, 'lastGoodBlock') !== BigInt(artifact.domain.block)
    || await call(origin, 'restorationRoot') !== artifact.domain.root) throw Error('recourse_break_receipt_artifact_mismatch');
  const previous = address(await call(executor, 'previousAuthorization'));
  const inherited = previous === zero ? false : await call(previous, 'restoredIdentity', [identity]);
  const restored = await call(executor, 'restoredIdentity', [identity]);
  if (typeof inherited !== 'boolean' || typeof restored !== 'boolean' || inherited && !restored) throw Error('recourse_break_receipt_state_invalid');
  const logs = await port.logs(executor, identity, Number(cutoff) + 1, through);
  const local = restored && !inherited;
  if (logs.length !== (local ? 1 : 0)) throw Error('recourse_break_receipt_history_incomplete');
  let result: HistoricalRestorationInterval | null = null;
  if (local) {
    const log = logs[0], owner = artifact.owners.find(row => row.identity === identity);
    if (!owner || log.removed || log.address !== executor || log.blockNumber <= Number(cutoff) || log.blockNumber > through
      || !Number.isSafeInteger(log.blockNumber) || !Number.isSafeInteger(log.logIndex)
      || await port.chain.blockHash(log.blockNumber) !== log.blockHash) throw Error('recourse_break_receipt_event_invalid');
    const tx = await port.transaction(log.transactionHash);
    const included = tx.logs.find(item => item.logIndex === log.logIndex);
    if (tx.transactionHash !== log.transactionHash || tx.blockHash !== log.blockHash || tx.blockNumber !== log.blockNumber
      || !included || JSON.stringify(included) !== JSON.stringify(log)) throw Error('recourse_break_receipt_inclusion_invalid');
    result = verifyHistoricalRestorationInterval({ kernel, executor, origin, owner, transaction: tx, logIndex: log.logIndex });
  }
  if (await port.manifest() !== manifest) throw Error('recourse_break_receipt_protocol_changed');
  if (result && await port.chain.blockHash(result.block) !== result.blockHash) throw Error('recourse_break_receipt_reorg');
  if (await port.chain.blockHash(through) !== pin || await port.chain.blockHash(lineage.block) !== lineage.blockHash) throw Error('recourse_break_receipt_reorg');
  return result;
}
export function historicalBreakReceiptPort(db: Firestore): HistoricalBreakReceiptPort {
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw Error('recourse_rpc_operators_not_independent');
  const agree = async (method: string, params: readonly unknown[]): Promise<string> => {
    const replies: unknown[] = await Promise.all(legs.map(leg => leg.provider.send(method, [...params])));
    if (typeof replies[0] !== 'string' || !rpcChainFactsEqual(replies[0], replies[1])) throw Error('recourse_break_receipt_rpc_disagreement');
    return replies[0];
  };
  const call = async (target: string, method: Method, args: readonly unknown[], pin: string): Promise<unknown> => {
    const reply = await agree('eth_call', [{ to: target, data: abi.encodeFunctionData(method, args) }, { blockHash: pin, requireCanonical: true }]);
    return abi.decodeFunctionResult(method, reply)[0];
  };
  const runtimePort: RestorationExecutorRuntimePort = {
    code: (account, pin) => agree('eth_getCode', [account, { blockHash: pin, requireCanonical: true }]),
    kernelExecutor: async (kernel, pin) => address(await call(kernel, 'ownerAuthorization', [], pin)),
  };
  const authenticateExecutor = (executor: string, kernel: string, pin: string) => authenticateRestorationExecutor(executor, kernel, pin, runtimePort);
  return { chain: createRecourseChainPort(),
    async lineage(kernel) {
      const lineage = await readRestorationSuccessionLineage(kernel);
      // Preserve the original readiness checkpoint. A later resolver result
      // with the same manifest cannot replace an orphaned earlier checkpoint.
      // Successor cutoffs are execution authority too: authenticate all the
      // implementations that supply the lineage, not only the queried emitter.
      for (const step of lineage.migrations) await authenticateExecutor(step.executor, step.kernel, lineage.blockHash);
      await authenticateExecutor(lineage.executor, lineage.kernel, lineage.blockHash);
      return lineage;
    },
    manifest: async () => (await currentProtocolDeployment({ fresh: true })).manifestHash, authenticateExecutor,
    artifact: origin => readStoredBreakArtifact(db, origin), transaction: hash => verifyBaseTransactionEvidence({ transactionHash: hash }), call,
    logs: (executor, identity, from, through) => getAgreedBaseLogs({ address: executor,
      topics: [RESTORATION_RECEIPT_EVENTS.getEvent('IdentityRestored')!.topicHash, identity], fromBlock: from, toBlock: through }),
  };
}
