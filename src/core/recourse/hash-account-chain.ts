import { keccak256 } from 'ethers';
import type { OwnerChainNetwork } from './owner-chain';
import { BREAK_RECOVERY_ABI } from './break-recovery';
import { HASH_ACCOUNT_ABI, hashAccountCall, hashAccountOutcome, type SignedHashAccountOperation } from './hash-account';
import { readFinalizedReceipt } from './finalized-receipt';
export async function readHashAccountState(account: string, network: OwnerChainNetwork): Promise<{
  root: string; nonce: string; manifestHash: string; blockHash: string;
}> {
  if (!/^0x[0-9a-f]{40}$/.test(account)) throw Error('hash_wallet_account_invalid');
  const deployment = await network.deployment(), tag = { blockHash: deployment.blockHash, requireCanonical: true };
  const agreed = async (method: string, params: readonly unknown[]): Promise<string> => {
    const values = await Promise.all(network.rpcs.map(rpc => rpc.request(method, params)));
    if (typeof values[0] !== 'string' || values[0] !== values[1]) throw Error('hash_wallet_rpc_disagreement');
    return values[0];
  };
  const executor = String(BREAK_RECOVERY_ABI.decodeFunctionResult('ownerAuthorization', await agreed('eth_call', [
    { to: deployment.addresses.kernel, data: BREAK_RECOVERY_ABI.encodeFunctionData('ownerAuthorization') }, tag]))[0]).toLowerCase();
  const runtime = String(BREAK_RECOVERY_ABI.decodeFunctionResult('hashAccountCodeHash', await agreed('eth_call', [
    { to: executor, data: BREAK_RECOVERY_ABI.encodeFunctionData('hashAccountCodeHash') }, tag]))[0]);
  if (keccak256(await agreed('eth_getCode', [account, tag])) !== runtime) throw Error('hash_wallet_runtime_invalid');
  const root = String(HASH_ACCOUNT_ABI.decodeFunctionResult('keyCommitment', await agreed('eth_call', [
    { to: account, data: HASH_ACCOUNT_ABI.encodeFunctionData('keyCommitment') }, tag]))[0]);
  const nonce = String(HASH_ACCOUNT_ABI.decodeFunctionResult('nonce', await agreed('eth_call', [
    { to: account, data: HASH_ACCOUNT_ABI.encodeFunctionData('nonce') }, tag]))[0]);
  if ((await network.deployment()).manifestHash !== deployment.manifestHash) throw Error('hash_wallet_protocol_changed');
  return { root, nonce, manifestHash: deployment.manifestHash, blockHash: deployment.blockHash };
}
export async function readHashAccountDepartureRoot(account:string,network:OwnerChainNetwork):Promise<{root:string;manifestHash:string}>{
  const state=await readHashAccountState(account,network);
  const values=await Promise.all(network.rpcs.map(rpc=>rpc.request('eth_call',[{to:account,
    data:HASH_ACCOUNT_ABI.encodeFunctionData('departureKeyCommitment')},{blockHash:state.blockHash,requireCanonical:true}])));
  if(typeof values[0]!=='string'||values[0]!==values[1])throw Error('hash_wallet_rpc_disagreement');
  const root=String(HASH_ACCOUNT_ABI.decodeFunctionResult('departureKeyCommitment',values[0])[0]);
  if(/^0x0+$/.test(root)||(await network.deployment()).manifestHash!==state.manifestHash)throw Error('hash_wallet_protocol_changed');
  return {root,manifestHash:state.manifestHash};
}
/** The outer transaction can succeed while its target call fails. Both outcomes
 * consume the signing key; verify the exact calldata and rotate in either case. */
export async function verifyHashAccountReceipt(operation: SignedHashAccountOperation, transactionHash: string,
  network: OwnerChainNetwork): Promise<'succeeded' | 'target_failed'> {
  const receipt = await readFinalizedReceipt(transactionHash, network);
  const transactions = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_getTransactionByHash', [transactionHash])));
  const calldata = hashAccountCall(operation);
  for (const raw of transactions) {
    if (!raw || typeof raw !== 'object') throw Error('hash_wallet_transaction_invalid');
    const tx = raw as Record<string, unknown>;
    if (tx.hash !== transactionHash || tx.blockHash !== receipt.blockHash || typeof tx.to !== 'string'
      || tx.to.toLowerCase() !== operation.account || tx.input !== calldata || tx.value !== '0x0') throw Error('hash_wallet_transaction_invalid');
  }
  const result = hashAccountOutcome(operation, receipt.logs);
  const state = await readHashAccountState(operation.account, network);
  if (state.root !== operation.nextCommitment || BigInt(state.nonce) !== BigInt(operation.nonce) + 1n) throw Error('hash_wallet_receipt_state_mismatch');
  return result;
}

export async function verifyHashAccountVariantReceipt(operations: readonly SignedHashAccountOperation[], transactionHash: string,
  network: OwnerChainNetwork): Promise<{ operation: SignedHashAccountOperation; outcome: 'succeeded' | 'target_failed' }> {
  const replies = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_getTransactionByHash', [transactionHash])));
  const inputs = replies.map(raw => raw && typeof raw === 'object' ? (raw as Record<string, unknown>).input : undefined);
  if (typeof inputs[0] !== 'string' || inputs[0] !== inputs[1]) throw Error('hash_wallet_transaction_invalid');
  const candidates = operations.filter(operation => hashAccountCall(operation) === inputs[0]);
  // Identical original/cancellation calldata is the same on-chain operation.
  // Prefer the original entry so its ordinary success label stays consistent.
  if (candidates.length === 0) throw Error('hash_wallet_transaction_invalid');
  const operation = candidates[0];
  return { operation, outcome: await verifyHashAccountReceipt(operation, transactionHash, network) };
}
