import { expect, it } from 'vitest';
import { Interface, sha256 } from 'ethers';
import { readOwnerChainState, verifyOwnerOperationReceipt, type OwnerChainNetwork } from './recourse-owner-chain';
import { OWNER_EXECUTOR_ABI, OWNER_KERNEL_ABI, ownerOperationIntent, type RecoveryOwnerOperation } from './recourse-owner-operation';
import type { ProtocolDeployment, PointerRpc } from './protocol-pointer';
const address = (byte: string) => `0x${byte.repeat(20)}`;
const hash = (byte: string) => `0x${byte.repeat(32)}`;
const operation: RecoveryOwnerOperation = { kernel: address('11'), destination: address('22'), identity: hash('33'), revision: '1', nonce: 0,
  proof: { recoverySecret: hash('44'), signingRoot: sha256(hash('55')), publicKey: hash('55'), signature: `0x${'66'.repeat(7856)}`,
    nextCommitment: hash('77'), nextSigningRoot: hash('88') } };
const transactionHash = hash('dd'), blockHash = hash('bb'), executor = address('cc');
const eventAbi = new Interface(['event OwnerAuthorizationConsumed(bytes32 indexed identity,uint256 nonce,bytes32 indexed intent,bytes32 nextCommitment,bytes32 nextSigningRoot)']);
const destinationAbi = new Interface(['function recoveredDestination(bytes32) view returns(address)', 'function previousAuthorization() view returns(address)']);
function network(options: { revision?: bigint; nonce?: number; root?: string; destination?: string; finalized?: string; reorg?: boolean; intent?: string;
  receipt?: 'failed' | 'missing' | 'duplicate' | 'wrong-emitter' | 'removed' | 'disagree'; retired?: boolean; ancestry?: 'linked' | 'unrelated' | 'cycle' } = {}): OwnerChainNetwork {
  const deployment = { addresses: { kernel: options.retired ? address('99') : operation.kernel }, revision: options.revision ?? 1n,
    blockHash, manifestHash: hash('aa') } as ProtocolDeployment;
  const rpc = (index: number): PointerRpc => ({ async request(method, params) {
    if (method === 'eth_call') {
      const call = params[0] as { to: string; data: string };
      const abi = call.to === operation.kernel || call.to === address('99') ? OWNER_KERNEL_ABI
        : (call.data === destinationAbi.encodeFunctionData('recoveredDestination', [operation.identity]) || call.data === destinationAbi.encodeFunctionData('previousAuthorization')) ? destinationAbi : OWNER_EXECUTOR_ABI;
      const parsed = abi.parseTransaction(call)!;
      const values: Record<string, readonly unknown[]> = { ownerAuthorization: [call.to === address('99') ? address('ee') : executor],
        previousAuthorization: [options.ancestry === 'linked' ? executor : options.ancestry === 'cycle' ? address('ee') : address('00')],
        ownerAuthorizationNonce: [options.nonce ?? 1], ownerRecoveryCommitment: [operation.proof.nextCommitment],
        ownerSigningRoot: [options.root ?? operation.proof.nextSigningRoot], recoveredDestination: [options.destination ?? operation.destination] };
      return abi.encodeFunctionResult(parsed.name, values[parsed.name]);
    }
    if (method === 'eth_getBlockByNumber') return params[0] === 'finalized' ? { number: options.finalized ?? '0x64' }
      : { number: '0x63', hash: options.reorg ? hash('ff') : blockHash };
    if (method === 'eth_getTransactionReceipt') {
      if (options.receipt === 'missing') return null;
      const event = eventAbi.encodeEventLog(eventAbi.getEvent('OwnerAuthorizationConsumed')!, [operation.identity, 0,
        options.intent ?? ownerOperationIntent(operation), operation.proof.nextCommitment, operation.proof.nextSigningRoot]);
      const log = { ...event, address: options.receipt === 'wrong-emitter' ? address('ee') : executor, blockHash, transactionHash,
        removed: options.receipt === 'removed' };
      return { transactionHash, blockNumber: '0x63', blockHash,
        status: options.receipt === 'failed' || options.receipt === 'disagree' && index === 1 ? '0x0' : '0x1',
        logs: options.receipt === 'duplicate' ? [log, log] : [log], providerAnnotation: index };
    }
    throw new Error('unexpected RPC');
  } });
  return { rpcs: [rpc(0), rpc(1)], deployment: async () => deployment };
}
it('installs only from the exact finalized owner operation and current independently read state', async () => {
  const state = await readOwnerChainState(operation.identity, network());
  expect(state).toMatchObject({ nonce: 1, commitment: operation.proof.nextCommitment, signingRoot: operation.proof.nextSigningRoot, executor });
  await expect(verifyOwnerOperationReceipt(operation, transactionHash, network())).resolves.toBeUndefined();
});
it('a newer manifest retaining the same kernel preserves finalized owner authorization', async () => {
  await expect(verifyOwnerOperationReceipt(operation, transactionHash, network({ revision: 2n }))).resolves.toBeUndefined();
  await expect(verifyOwnerOperationReceipt(operation, transactionHash, network({ revision: 0n }))).rejects.toThrow('state_mismatch');
});
it.each([
  { nonce: 0 }, { nonce: 2 }, { root: hash('99') }, { destination: address('99') }, { finalized: '0x62' },
  { reorg: true }, { intent: hash('99') }, { receipt: 'failed' as const }, { receipt: 'missing' as const },
  { receipt: 'duplicate' as const }, { receipt: 'wrong-emitter' as const }, { receipt: 'removed' as const }, { receipt: 'disagree' as const },
])('rejects substituted, stale, unfinalized or noncanonical recovery evidence %p', async options => {
  await expect(verifyOwnerOperationReceipt(operation, transactionHash, network(options))).rejects.toThrow();
});

it('an independently verified ordinary successor can complete installation from the earlier receipt', async () => {
  await expect(verifyOwnerOperationReceipt(operation, transactionHash, network({retired:true,revision:2n,ancestry:'linked'}))).resolves.toBeUndefined();
  for (const ancestry of ['unrelated','cycle'] as const) await expect(verifyOwnerOperationReceipt(operation,transactionHash,
    network({retired:true,revision:2n,ancestry}))).rejects.toThrow('unrelated_successor');
});
