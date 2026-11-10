import { AbiCoder, Interface, ZeroAddress, concat, keccak256, sha256 } from 'ethers';
import { BREAK_RECOVERY_ABI, type PreparedBreakRecovery } from './break-recovery';
import { readOwnerChainState, type OwnerChainNetwork } from './owner-chain';
import { OWNER_EXECUTOR_ABI } from './owner-operation';
import { readFinalizedReceipt } from './finalized-receipt';
const abi = new Interface([
  'event IdentityRestored(bytes32 indexed identity,address indexed destination,uint256 amount)',
  'event OwnerAuthorizationConsumed(bytes32 indexed identity,uint256 nonce,bytes32 indexed intent,bytes32 nextCommitment,bytes32 nextSigningRoot)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
/** Installation follows independent canonical proof, never a sponsor's success
 * response. Ordinary successors inherit the owner state; prove their ancestry
 * before accepting a receipt from the predecessor executor. */
export async function verifyBreakRecoveryReceipt(prepared: PreparedBreakRecovery, transactionHash: string,
  network: OwnerChainNetwork): Promise<void> {
  if (prepared.phase !== 'restore_balance' || !prepared.ownerIntent) throw Error('break_receipt_not_restoration');
  const operation = OWNER_EXECUTOR_ABI.parseTransaction({ data: prepared.data });
  if (!operation || operation.name !== 'execute' || operation.args.identity !== prepared.identity) throw Error('break_receipt_operation_invalid');
  const coder = AbiCoder.defaultAbiCoder();
  const payload = coder.decode(['uint8', 'bytes'], operation.args.payload);
  if (payload[0] !== 1n) throw Error('break_receipt_operation_invalid');
  const restored = coder.decode(['tuple(bytes32 identity,uint256 amount,bytes32 originalCommitment,address destination,bytes32 destinationKeyRoot,bytes32[] snapshotProof)'], payload[1])[0];
  if (restored.identity !== prepared.identity || restored.amount !== BigInt(prepared.amount)
    || String(restored.destination).toLowerCase() !== prepared.destination) throw Error('break_receipt_operation_invalid');
  const state = await readOwnerChainState(prepared.identity, network);
  const proof = operation.args.proof;
  if (state.commitment !== proof.nextCommitment || state.signingRoot !== proof.nextSigningRoot
    || state.destination !== prepared.destination) throw Error('break_receipt_state_mismatch');
  let tag = { blockHash: state.deployment.blockHash, requireCanonical: true };
  const call = async (to: string, iface: Interface, name: string, args: readonly unknown[] = []) => {
    const values = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_call', [{ to, data: iface.encodeFunctionData(name, args) }, tag])));
    if (typeof values[0] !== 'string' || values[0] !== values[1]) throw Error('break_receipt_rpc_disagreement');
    return iface.decodeFunctionResult(name, values[0])[0];
  };
  let ancestor = state.executor;
  const seen = new Set<string>();
  while (ancestor !== prepared.executor) {
    if (ancestor === ZeroAddress || seen.has(ancestor)) throw Error('break_receipt_unrelated_executor');
    seen.add(ancestor);
    ancestor = String(await call(ancestor, OWNER_EXECUTOR_ABI, 'previousAuthorization')).toLowerCase();
  }
  if (String(await call(prepared.executor, BREAK_RECOVERY_ABI, 'kernel')).toLowerCase() !== prepared.kernel
    || !await call(state.executor, BREAK_RECOVERY_ABI, 'restoredIdentity', [prepared.identity])) throw Error('break_receipt_state_mismatch');
  const accountHash = String(await call(state.executor, BREAK_RECOVERY_ABI, 'hashAccountCodeHash'));
  const codes = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_getCode', [prepared.destination, tag])));
  if (typeof codes[0] !== 'string' || codes[0] !== codes[1] || keccak256(codes[0]) !== accountHash
    || await call(prepared.destination, BREAK_RECOVERY_ABI, 'keyCommitment') !== restored.destinationKeyRoot) throw Error('break_receipt_destination_changed');
  const receipt = await readFinalizedReceipt(transactionHash, network);
  const parsed = receipt.logs.filter(log => log.address === prepared.executor).map(log => abi.parseLog(log)).filter(log => log !== null);
  const identityEvents = parsed.filter(log => log.name === 'IdentityRestored' && log.args.identity === prepared.identity
    && String(log.args.destination).toLowerCase() === prepared.destination && log.args.amount === BigInt(prepared.amount));
  const consumed = parsed.filter(log => log.name === 'OwnerAuthorizationConsumed' && log.args.identity === prepared.identity
    && log.args.intent === prepared.ownerIntent && log.args.nextCommitment === proof.nextCommitment && log.args.nextSigningRoot === proof.nextSigningRoot);
  if (identityEvents.length !== 1 || consumed.length !== 1 || consumed[0].args.nonce + 1n !== BigInt(state.nonce)) throw Error('break_receipt_outcome_missing');
  const computedIntent = sha256(coder.encode(['string','uint256','address','bytes32','bytes32','uint256','bytes32','bytes32','bytes32'],
    ['Provian restoration owner authorization',8453,prepared.kernel,prepared.identity,sha256(concat([proof.recoverySecret,proof.signingRoot])),
      consumed[0].args.nonce,operation.args.operationHash,proof.nextCommitment,proof.nextSigningRoot]));
  if (computedIntent !== prepared.ownerIntent) throw Error('break_receipt_intent_invalid');
  const mints = receipt.logs.filter(log => log.address === prepared.kernel).map(log => abi.parseLog(log)).filter(log => log?.name === 'Transfer'
    && log.args.from === ZeroAddress && String(log.args.to).toLowerCase() === prepared.destination);
  if (BigInt(prepared.amount) === 0n ? mints.length !== 0 : mints.length !== 1 || mints[0]!.args.value !== BigInt(prepared.amount)) throw Error('break_receipt_balance_missing');
  const latest = await readOwnerChainState(prepared.identity, network);
  if (latest.deployment.manifestHash !== state.deployment.manifestHash) throw Error('break_receipt_protocol_changed');
  if (latest.nonce !== state.nonce || latest.commitment !== state.commitment || latest.signingRoot !== state.signingRoot
    || latest.destination !== state.destination || latest.executor !== state.executor) throw Error('break_receipt_state_changed');
  tag = { blockHash: latest.deployment.blockHash, requireCanonical: true };
  if (await call(prepared.destination, BREAK_RECOVERY_ABI, 'keyCommitment') !== restored.destinationKeyRoot) throw Error('break_receipt_destination_changed');
}
