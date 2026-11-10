import { recoveryOperationHash, parseRestorationScope } from './owner-operation';
import { AbiCoder, Interface, sha256 } from 'ethers';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import type { EconomicStateRpcLeg } from '../onchain/economic-state';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';

export const RECOVERY_KERNEL_ABI = new Interface(['function ownerAuthorization() view returns(address)']);
export const RECOVERY_AUTH_ABI = new Interface([
  'function ownerAuthorizationNonce(bytes32) view returns(uint256)',
  'function ownerRecoveryCommitment(bytes32) view returns(bytes32)',
  'function ownerSigningRoot(bytes32) view returns(bytes32)',
  'function recoveredDestination(bytes32) view returns(address)',
  'function previousAuthorization() view returns(address)',
  'function breakOrigin() view returns(address)',
  'function predecessor() view returns(address)',
  'function lastGoodBlock() view returns(uint256)',
  'event IdentityRestored(bytes32 indexed identity,address indexed destination,uint256 amount)',
  'event RestorationIntentAuthorized(bytes32 indexed request,bytes32 indexed identity,address indexed destination,bytes32 lossHash,uint256 maximumLoss,bytes32 intentHash)',
  'event OwnerAuthorizationConsumed(bytes32 indexed identity,uint256 nonce,bytes32 indexed intent,bytes32 nextCommitment,bytes32 nextSigningRoot)',
]);
const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
export interface RecoveryAuthorizationInput {
  readonly currentKernel?: string;
  readonly kernel: string; readonly identity: string; readonly destination: string;
  readonly consumedCommitment: string; readonly nextCommitment: string; readonly nextSigningRoot: string;
  readonly nonce: number; readonly transactionHash: string;
  /** Selects the independently verified kind-1 break restoration digest. */
  readonly breakDestinationRoot?: string;
  readonly expectedIntent?: string;
}
export interface RecoveryAuthorizationEvidence {
  readonly transactionHash: string; readonly block: number; readonly blockHash: string;
  readonly authorization: string; readonly generation: number;
  readonly accountingBlock?: number; readonly accountingBlockHash?: string;
}
const authenticatedEvidence = new WeakMap<RecoveryAuthorizationEvidence, RecoveryAuthorizationInput>();
const breakContexts = new WeakMap<RecoveryAuthorizationEvidence, string>();
/** Only evidence produced by the verifier in this process may authorize a
 * transaction transition. Deserialized/client-asserted verification is refused. */
export function assertRecoveryAuthorization(evidence: RecoveryAuthorizationEvidence,
  fields: Pick<RecoveryAuthorizationInput, 'identity' | 'destination' | 'consumedCommitment' | 'nextCommitment' | 'nextSigningRoot'>): void {
  const checked = authenticatedEvidence.get(evidence);
  if (!checked || Object.entries(fields).some(([key, value]) => checked[key as keyof RecoveryAuthorizationInput] !== value)) {
    throw new Error('recourse_authorization_unverified');
  }
}
export function recoveryAuthorizationBreakOrigin(evidence: RecoveryAuthorizationEvidence): string | null {
  if (!authenticatedEvidence.has(evidence)) throw Error('recourse_authorization_unverified');
  return breakContexts.get(evidence) ?? null;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('recourse_authorization_reply_invalid');
  return value as Record<string, unknown>;
}
function number(value: unknown): number {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new Error('recourse_authorization_reply_invalid');
  const n = Number(BigInt(value));
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('recourse_authorization_reply_invalid');
  return n;
}
/** A successful, canonical independent-owner operation is required before relay
 * credentials change. Neither an asserted receipt nor a revealed preimage suffices. */
export async function verifyRecoveryAuthorization(input: RecoveryAuthorizationInput,
  testLegs?: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg]): Promise<RecoveryAuthorizationEvidence> {
  if (![input.identity, input.consumedCommitment, input.nextCommitment, input.nextSigningRoot, input.transactionHash].every(v => HASH.test(v))
    || !ADDRESS.test(input.kernel) || (input.currentKernel !== undefined && !ADDRESS.test(input.currentKernel)) || !ADDRESS.test(input.destination) || !Number.isSafeInteger(input.nonce)
    || input.nonce < 0 || input.nonce >= Number.MAX_SAFE_INTEGER
    || (input.expectedIntent !== undefined && !HASH.test(input.expectedIntent))
    || (input.breakDestinationRoot !== undefined && (!HASH.test(input.breakDestinationRoot) || /^0x0+$/.test(input.breakDestinationRoot)))) throw new Error('recourse_authorization_input_invalid');
  const configured = testLegs ? undefined : getOperatorBoundRpcLegs('base');
  const legs: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] = testLegs ?? [
    { operatorId: configured![0].operatorId, send: (method, params) => configured![0].provider.send(method, [...params]) },
    { operatorId: configured![1].operatorId, send: (method, params) => configured![1].provider.send(method, [...params]) },
  ];
  if (!legs[0].operatorId || !legs[1].operatorId || legs[0].operatorId === legs[1].operatorId) throw new Error('recourse_rpc_operators_not_independent');
  const agree = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const values = await Promise.all(legs.map(leg => leg.send(method, params)));
    if (!rpcChainFactsEqual(values[0], values[1])) throw new Error('recourse_authorization_rpc_disagreement');
    return values[0];
  };
  if (number(await agree('eth_chainId', [])) !== 8453) throw new Error('recourse_rpc_chain_invalid');
  const receiptValue = await agree('eth_getTransactionReceipt', [input.transactionHash]);
  if (receiptValue === null) throw new Error('recourse_authorization_receipt_missing');
  const receipt = object(receiptValue);
  if (receipt.transactionHash !== input.transactionHash || number(receipt.status) !== 1
    || typeof receipt.blockHash !== 'string' || !HASH.test(receipt.blockHash) || !Array.isArray(receipt.logs)) throw new Error('recourse_authorization_receipt_invalid');
  const block = number(receipt.blockNumber);
  const finalized = await Promise.all(legs.map(async leg => number(object(await leg.send('eth_getBlockByNumber', ['finalized', false])).number)));
  if (block > Math.min(...finalized)) throw new Error('recourse_authorization_not_finalized');
  const blockTag = `0x${block.toString(16)}`;
  if (object(await agree('eth_getBlockByNumber', [blockTag, false])).hash !== receipt.blockHash) throw new Error('recourse_authorization_reorg');
  const call = async (address: string, abi: Interface, method: string, args: readonly unknown[], tag: unknown) => {
    const raw = await agree('eth_call', [{ to: address, data: abi.encodeFunctionData(method, args) }, tag]);
    if (typeof raw !== 'string') throw new Error('recourse_authorization_reply_invalid');
    return abi.decodeFunctionResult(method, raw);
  };
  const authorization = String((await call(input.kernel, RECOVERY_KERNEL_ABI, 'ownerAuthorization', [],
    { blockHash: receipt.blockHash, requireCanonical: true }))[0]).toLowerCase();
  if (!ADDRESS.test(authorization) || /^0x0{40}$/.test(authorization)) throw new Error('recourse_authorization_contract_invalid');
  let operation = recoveryOperationHash(input.identity, input.destination);
  let verifiedBreakOrigin: string | undefined;
  const ticketTopic = RECOVERY_AUTH_ABI.getEvent('RestorationIntentAuthorized')!.topicHash;
  let tickets = 0;
  for (const raw of receipt.logs) {
    const log = object(raw);
    if (typeof log.address !== 'string' || log.address.toLowerCase() !== authorization
      || !Array.isArray(log.topics) || log.topics[0] !== ticketTopic) continue;
    if (log.removed === true || log.transactionHash !== input.transactionHash || log.blockHash !== receipt.blockHash
      || typeof log.data !== 'string' || !log.topics.every(t => typeof t === 'string')) throw new Error('recourse_authorization_log_invalid');
    const decoded = RECOVERY_AUTH_ABI.parseLog({ topics: log.topics as string[], data: log.data });
    if (decoded?.args.identity !== input.identity || String(decoded.args.destination).toLowerCase() !== input.destination) continue;
    const scope = parseRestorationScope({ request: String(decoded.args.request), lossHash: String(decoded.args.lossHash), maximumLoss: String(decoded.args.maximumLoss) });
    operation = recoveryOperationHash(input.identity, input.destination, scope);
    if (operation !== decoded.args.intentHash || ++tickets !== 1) throw new Error('recourse_authorization_intent_invalid');
  }
  if (input.breakDestinationRoot !== undefined) {
    if (tickets !== 0) throw Error('recourse_authorization_intent_invalid');
    const restorationTopic = RECOVERY_AUTH_ABI.getEvent('IdentityRestored')!.topicHash;
    let restoredAmount: bigint | undefined;
    for (const raw of receipt.logs) {
      const log = object(raw);
      if (typeof log.address !== 'string' || log.address.toLowerCase() !== authorization
        || !Array.isArray(log.topics) || log.topics[0] !== restorationTopic) continue;
      if (log.removed === true || log.transactionHash !== input.transactionHash || log.blockHash !== receipt.blockHash
        || typeof log.data !== 'string' || !log.topics.every(t => typeof t === 'string')) throw Error('recourse_authorization_log_invalid');
      const event = RECOVERY_AUTH_ABI.parseLog({ topics: log.topics as string[], data: log.data })!;
      if (event.args.identity !== input.identity || String(event.args.destination).toLowerCase() !== input.destination) continue;
      if (restoredAmount !== undefined) throw Error('recourse_authorization_restoration_duplicate');
      restoredAmount = event.args.amount as bigint;
    }
    if (restoredAmount === undefined) throw Error('recourse_authorization_restoration_missing');
    const receiptTag = { blockHash: receipt.blockHash, requireCanonical: true };
    const origin = String((await call(authorization, RECOVERY_AUTH_ABI, 'breakOrigin', [], receiptTag))[0]).toLowerCase();
    if (!ADDRESS.test(origin) || /^0x0+$/.test(origin)) throw Error('recourse_authorization_break_origin_invalid');
    verifiedBreakOrigin = origin;
    const previous = (await call(origin, RECOVERY_AUTH_ABI, 'predecessor', [], receiptTag))[0];
    const lastGood = (await call(origin, RECOVERY_AUTH_ABI, 'lastGoodBlock', [], receiptTag))[0];
    operation = sha256(AbiCoder.defaultAbiCoder().encode(
      ['string', 'bytes32', 'uint256', 'address', 'bytes32', 'address', 'uint256'],
      ['Provian cryptographic break', input.identity, restoredAmount, input.destination, input.breakDestinationRoot, previous, lastGood]));
  }
  const intent = sha256(AbiCoder.defaultAbiCoder().encode(
    ['string', 'uint256', 'address', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32', 'bytes32'],
    ['Provian restoration owner authorization', 8453, input.kernel, input.identity, input.consumedCommitment,
      input.nonce, operation, input.nextCommitment, input.nextSigningRoot]));
  const topic = RECOVERY_AUTH_ABI.getEvent('OwnerAuthorizationConsumed')!.topicHash;
  if (input.expectedIntent !== undefined && input.expectedIntent !== intent) throw Error('recourse_authorization_intent_invalid');
  let matched = 0;
  for (const raw of receipt.logs) {
    const log = object(raw);
    if (typeof log.address !== 'string' || log.address.toLowerCase() !== authorization
      || !Array.isArray(log.topics) || log.topics[0] !== topic) continue;
    if (log.removed === true || log.transactionHash !== input.transactionHash || log.blockHash !== receipt.blockHash
      || typeof log.data !== 'string' || !log.topics.every(t => typeof t === 'string')) throw new Error('recourse_authorization_log_invalid');
    const decoded = RECOVERY_AUTH_ABI.parseLog({ topics: log.topics as string[], data: log.data });
    if (decoded?.args.identity === input.identity && decoded.args.nonce === BigInt(input.nonce)
      && decoded.args.intent === intent && decoded.args.nextCommitment === input.nextCommitment
      && decoded.args.nextSigningRoot === input.nextSigningRoot) ++matched;
  }
  if (matched !== 1) throw new Error('recourse_authorization_intent_missing');
  const heads = await Promise.all(legs.map(async leg => number(await leg.send('eth_blockNumber', []))));
  const head = Math.min(...heads), headTag = `0x${head.toString(16)}`;
  const headHash = object(await agree('eth_getBlockByNumber', [headTag, false])).hash;
  if (typeof headHash !== 'string' || !HASH.test(headHash) || head < block) throw new Error('recourse_authorization_head_invalid');
  const tag = { blockHash: headHash, requireCanonical: true };
  const currentKernel = input.currentKernel ?? input.kernel;
  let currentAuthorization = authorization;
  let accountingBlock: number | undefined, accountingBlockHash: string | undefined;
  if (currentKernel !== input.kernel) {
    currentAuthorization = String((await call(currentKernel, RECOVERY_KERNEL_ABI, 'ownerAuthorization', [], tag))[0]).toLowerCase();
    let ancestor = currentAuthorization;
    const seen = new Set<string>();
    while (ancestor !== authorization) {
      if (!ADDRESS.test(ancestor) || /^0x0{40}$/.test(ancestor) || seen.has(ancestor)) throw new Error('recourse_authorization_unrelated_successor');
      seen.add(ancestor);
      ancestor = String((await call(ancestor, RECOVERY_AUTH_ABI, 'previousAuthorization', [], tag))[0]).toLowerCase();
    }
    // Begin the successor ledger at its actual deployment, not at the old
    // authorization block where the new token did not yet exist. Every later
    // import and transfer is then observed by the normal Transfer reducer.
    const codeAt = async (height: number): Promise<boolean> => {
      const b = object(await agree('eth_getBlockByNumber', [`0x${height.toString(16)}`, false]));
      if (typeof b.hash !== 'string' || !HASH.test(b.hash)) throw new Error('recourse_authorization_reply_invalid');
      const code = await agree('eth_getCode', [currentKernel, { blockHash: b.hash, requireCanonical: true }]);
      if (typeof code !== 'string' || !/^0x([0-9a-f]{2})*$/i.test(code)) throw new Error('recourse_authorization_reply_invalid');
      return code !== '0x';
    };
    if (!await codeAt(head)) throw new Error('recourse_authorization_contract_invalid');
    let left = 0, right = head;
    while (left < right) { const middle = left + Math.floor((right - left) / 2); if (await codeAt(middle)) right = middle; else left = middle + 1; }
    accountingBlock = Math.max(left, block);
    accountingBlockHash = String(object(await agree('eth_getBlockByNumber', [`0x${accountingBlock.toString(16)}`, false])).hash);
  }
  const [nonce, commitment, root, destination] = await Promise.all([
    call(currentAuthorization, RECOVERY_AUTH_ABI, 'ownerAuthorizationNonce', [input.identity], tag),
    call(currentAuthorization, RECOVERY_AUTH_ABI, 'ownerRecoveryCommitment', [input.identity], tag),
    call(currentAuthorization, RECOVERY_AUTH_ABI, 'ownerSigningRoot', [input.identity], tag),
    call(currentAuthorization, RECOVERY_AUTH_ABI, 'recoveredDestination', [input.identity], tag),
  ]);
  if (object(await agree('eth_getBlockByNumber', [headTag, false])).hash !== headHash
    || object(await agree('eth_getBlockByNumber', [blockTag, false])).hash !== receipt.blockHash) throw new Error('recourse_authorization_reorg');
  if (nonce[0] !== BigInt(input.nonce + 1) || commitment[0] !== input.nextCommitment
    || root[0] !== input.nextSigningRoot || String(destination[0]).toLowerCase() !== input.destination) throw new Error('recourse_authorization_superseded');
  const evidence = { transactionHash: input.transactionHash, block, blockHash: receipt.blockHash, authorization, generation: input.nonce + 1,
    ...(accountingBlock === undefined ? {} : { accountingBlock, accountingBlockHash }) };
  authenticatedEvidence.set(evidence, { ...input });
  if (verifiedBreakOrigin) breakContexts.set(evidence, verifiedBreakOrigin);
  return evidence;
}
