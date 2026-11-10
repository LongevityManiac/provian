import { Interface, concat, sha256 } from 'ethers';
import type { PointerRpc, ProtocolDeployment } from '../protocol/pointer';
import { OWNER_EXECUTOR_ABI, OWNER_KERNEL_ABI, ownerOperationIntent, type RecoveryOwnerOperation } from './owner-operation';

export interface OwnerChainNetwork {
  readonly rpcs: readonly [PointerRpc, PointerRpc];
  deployment(): Promise<ProtocolDeployment>;
}
export interface OwnerChainState {
  readonly deployment: ProtocolDeployment; readonly executor: string;
  readonly nonce: number; readonly commitment: string; readonly signingRoot: string; readonly destination: string;
}
const destinationAbi = new Interface(['function recoveredDestination(bytes32) view returns(address)', 'function previousAuthorization() view returns(address)']);
const eventAbi = new Interface(['event OwnerAuthorizationConsumed(bytes32 indexed identity,uint256 nonce,bytes32 indexed intent,bytes32 nextCommitment,bytes32 nextSigningRoot)']);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('recourse_owner_chain_invalid');
  return value as Record<string, unknown>;
}
function quantity(value: unknown): number {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new Error('recourse_owner_chain_invalid');
  const n = Number(BigInt(value));
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('recourse_owner_chain_invalid');
  return n;
}
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)])) : v;
  return JSON.stringify(sort(value));
}
async function agreed(network: OwnerChainNetwork, method: string, params: readonly unknown[]): Promise<unknown> {
  const values = await Promise.all(network.rpcs.map(rpc => rpc.request(method, params)));
  if (canonical(values[0]) !== canonical(values[1])) throw new Error('recourse_owner_chain_disagreement');
  return values[0];
}
export async function readOwnerChainState(identity: string, network: OwnerChainNetwork): Promise<OwnerChainState> {
  if (!/^0x[0-9a-f]{64}$/.test(identity)) throw new Error('recourse_owner_identity_invalid');
  const deployment = await network.deployment();
  const tag = { blockHash: deployment.blockHash, requireCanonical: true };
  const call = async (address: string, abi: Interface, method: string, args: readonly unknown[]) => {
    const result = await agreed(network, 'eth_call', [{ to: address, data: abi.encodeFunctionData(method, args) }, tag]);
    if (typeof result !== 'string') throw new Error('recourse_owner_chain_invalid');
    return abi.decodeFunctionResult(method, result);
  };
  const executor = String((await call(deployment.addresses.kernel, OWNER_KERNEL_ABI, 'ownerAuthorization', []))[0]).toLowerCase();
  if (/^0x0{40}$/.test(executor)) throw new Error('recourse_owner_executor_invalid');
  const [nonce, commitment, signingRoot, destination] = await Promise.all([
    call(executor, OWNER_EXECUTOR_ABI, 'ownerAuthorizationNonce', [identity]),
    call(executor, OWNER_EXECUTOR_ABI, 'ownerRecoveryCommitment', [identity]),
    call(executor, OWNER_EXECUTOR_ABI, 'ownerSigningRoot', [identity]),
    call(executor, destinationAbi, 'recoveredDestination', [identity]),
  ]);
  if (nonce[0] >= BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('recourse_owner_nonce_invalid');
  if ((await network.deployment()).manifestHash !== deployment.manifestHash) throw new Error('recourse_owner_protocol_changed');
  return { deployment, executor, nonce: Number(nonce[0]), commitment: String(commitment[0]),
    signingRoot: String(signingRoot[0]), destination: String(destination[0]).toLowerCase() };
}
/** The relay cannot cause a local credential installation by inventing a receipt.
 * Only this independent finalized transaction and exact current owner state permit it. */
export async function verifyOwnerOperationReceipt(operation: RecoveryOwnerOperation, transactionHash: string,
  network: OwnerChainNetwork): Promise<void> {
  if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) throw new Error('recourse_owner_receipt_invalid');
  const state = await readOwnerChainState(operation.identity, network);
  if (state.deployment.revision < BigInt(operation.revision) || state.nonce !== operation.nonce + 1
    || state.commitment !== operation.proof.nextCommitment || state.signingRoot !== operation.proof.nextSigningRoot
    || state.destination !== operation.destination) throw new Error('recourse_owner_receipt_state_mismatch');
  const results = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_getTransactionReceipt', [transactionHash])));
  // Only consumed chain facts participate; provider-specific receipt annotations do not.
  const facts = (raw: unknown) => {
    const receipt = object(raw);
    if (!Array.isArray(receipt.logs)) throw new Error('recourse_owner_receipt_invalid');
    return { hash: receipt.transactionHash, block: receipt.blockNumber, blockHash: receipt.blockHash, status: receipt.status,
      logs: receipt.logs.map(rawLog => { const log = object(rawLog); return { address: log.address, topics: log.topics,
        data: log.data, blockHash: log.blockHash, transactionHash: log.transactionHash, removed: log.removed === true }; }) };
  };
  const receipt = facts(results[0]);
  if (canonical(receipt) !== canonical(facts(results[1])) || receipt.hash !== transactionHash || quantity(receipt.status) !== 1
    || typeof receipt.blockHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(receipt.blockHash)) throw new Error('recourse_owner_receipt_invalid');
  const block = quantity(receipt.block);
  const finalized = await Promise.all(network.rpcs.map(async rpc => quantity(object(await rpc.request('eth_getBlockByNumber', ['finalized', false])).number)));
  if (block > Math.min(...finalized)) throw new Error('recourse_owner_receipt_not_finalized');
  const blocks = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_getBlockByNumber', [`0x${block.toString(16)}`, false])));
  if (blocks.some(b => object(b).hash !== receipt.blockHash)) throw new Error('recourse_owner_receipt_reorg');
  let receiptExecutor = state.executor;
  if (state.deployment.addresses.kernel.toLowerCase() !== operation.kernel) {
    const raw = await agreed(network, 'eth_call', [{ to: operation.kernel,
      data: OWNER_KERNEL_ABI.encodeFunctionData('ownerAuthorization') }, { blockHash: receipt.blockHash, requireCanonical: true }]);
    if (typeof raw !== 'string') throw new Error('recourse_owner_chain_invalid');
    receiptExecutor = String(OWNER_KERNEL_ABI.decodeFunctionResult('ownerAuthorization', raw)[0]).toLowerCase();
    let ancestor = state.executor;
    const seen = new Set<string>();
    while (ancestor !== receiptExecutor) {
      if (!/^0x[0-9a-f]{40}$/.test(ancestor) || /^0x0{40}$/.test(ancestor) || seen.has(ancestor)) throw new Error('recourse_owner_receipt_unrelated_successor');
      seen.add(ancestor);
      const result = await agreed(network, 'eth_call', [{ to: ancestor,
        data: destinationAbi.encodeFunctionData('previousAuthorization') }, { blockHash: state.deployment.blockHash, requireCanonical: true }]);
      if (typeof result !== 'string') throw new Error('recourse_owner_chain_invalid');
      ancestor = String(destinationAbi.decodeFunctionResult('previousAuthorization', result)[0]).toLowerCase();
    }
  }
  const topic = eventAbi.getEvent('OwnerAuthorizationConsumed')!.topicHash;
  const intent = ownerOperationIntent(operation);
  let matches = 0;
  for (const log of receipt.logs) {
    if (typeof log.address !== 'string' || log.address.toLowerCase() !== receiptExecutor || !Array.isArray(log.topics) || log.topics[0] !== topic) continue;
    if (log.removed || log.blockHash !== receipt.blockHash || log.transactionHash !== transactionHash || typeof log.data !== 'string'
      || !log.topics.every(t => typeof t === 'string')) throw new Error('recourse_owner_receipt_invalid');
    const decoded = eventAbi.parseLog({ data: log.data, topics: log.topics as string[] })!;
    if (decoded.args.identity === operation.identity && decoded.args.intent === intent && decoded.args.nonce === BigInt(operation.nonce)
      && decoded.args.nextCommitment === operation.proof.nextCommitment && decoded.args.nextSigningRoot === operation.proof.nextSigningRoot) ++matches;
  }
  if (matches !== 1) throw new Error('recourse_owner_receipt_intent_missing');
  if ((await network.deployment()).manifestHash !== state.deployment.manifestHash) throw new Error('recourse_owner_protocol_changed');
  if (sha256(concat([operation.proof.recoverySecret, operation.proof.signingRoot])) === state.commitment) throw new Error('recourse_owner_receipt_unconsumed');
}
