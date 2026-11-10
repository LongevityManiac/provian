import { Interface, Wallet, keccak256, hashMessage, verifyMessage } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { RECOURSE_COLLECTIONS, ownershipBindingMessage, type OwnershipBinding } from './ownership';
import { BINDING_OPERATIONS, REGISTRY_ABI, checkBindingOperation, queueBindingOperation,
  assertCheckedBindingOperation, readConfirmedBinding } from './binding-operation';
import { executeBindingOperation, type BindingGasSigner, type BindingWorkerPorts } from './binding-worker';
import { acquireSignerLease, SETTLEMENT_SIGNER_LEASES_COLLECTION, type SettlementDb } from '../pvt/wp4/durable-settlement-store';
import type { OwnerOperationChain } from './owner-operation-queue';
import type { ProtocolDeployment } from '../protocol/pointer';

const address = (b: string) => `0x${b.repeat(20)}`, hash = (b: string) => `0x${b.repeat(32)}`;
const owner = new Wallet(hash('11')), attestorWallet = new Wallet(hash('22')), gasWallet = new Wallet(hash('33')); // Public test keys.
async function fixture(change = '') {
  const state = { registered: false };
  const fake = createFakeFirestore({ strictTransactionOrder: true }), db = fake as unknown as Firestore;
  const binding: OwnershipBinding = { address: owner.address.toLowerCase(), identity: hash('44'),
    recoveryCommitment: hash('55'), signingRoot: hash('66'), kernel: address('77'), nonce: hash('88'), expiresAtMs: Date.now() + 300000 };
  fake.store.set(`${RECOURSE_COLLECTIONS.identities}/${binding.identity}`, { recoveryCommitment: binding.recoveryCommitment,
    signingRoot: binding.signingRoot, recoveryGeneration: 0 });
  fake.store.set(`${RECOURSE_COLLECTIONS.addresses}/${binding.address}`, { identity: binding.identity, kernel: binding.kernel, recoveryGeneration: 0 });
  const deployment = { addresses: { kernel: binding.kernel, recoursePool: address('99') }, revision: 1n,
    pointer: address('aa'), blockHash: hash('bb'), manifestHash: hash('cc') } as ProtocolDeployment;
  const abi = new Interface(['function registryOperator() view returns(address)', 'function restorationAuthority() view returns(address)', 'function balanceOf(address) view returns(uint256)',
    ...REGISTRY_ABI.fragments]);
  const attestor = { address: attestorWallet.address.toLowerCase(), signMessage: jest.fn((message: string) => attestorWallet.signMessage(message)) };
  const chain: OwnerOperationChain = { deployment: async () => deployment, agree: async (_method, args) => {
    if (_method === 'eth_getCode') return state.registered ? '0x1234' : '0x';
    if (_method === 'eth_getBlockByNumber') return { hash: hash('bb'), number: '0x64' };
    if (_method === 'eth_getLogs') {
      const log = REGISTRY_ABI.encodeEventLog(REGISTRY_ABI.getEvent('OwnershipBound')!, [binding.identity,
        binding.address, binding.kernel, binding.recoveryCommitment, binding.signingRoot, hashMessage(ownershipBindingMessage(binding))]);
      return [{ ...log, address: address('dd'), blockNumber: '0x64', blockHash: hash('bb'), transactionHash: hash('ef'), logIndex: '0x2', removed: false }];
    }
    const call = args[0] as { to: string; data: string };
    expect(args[1]).toEqual({ blockHash: deployment.blockHash, requireCanonical: true });
    const parsed = abi.parseTransaction(call)!;
    if (parsed.name === 'bind') {
      expect(call.to).toBe(address('dd'));
      if (change === 'simulation') throw new Error('signature_refused');
      expect(verifyMessage(ownershipBindingMessage(binding), parsed.args[1])).toBe(owner.address);
      expect(verifyMessage(ownershipBindingMessage(binding), parsed.args[2])).toBe(attestorWallet.address);
      return '0x';
    }
    const values: Record<string, unknown> = { registryOperator: change === 'pool' && call.to === address('99') ? address('ee') : address('dd'),
      restorationAuthority: change === 'collapsed' ? attestor.address : address('ee'),
      identityAttestor: change === 'signer' ? owner.address : attestor.address, pointer: change === 'pointer' ? address('ee') : deployment.pointer,
      bindingBlock: state.registered ? 100n : 0n, boundBlock: 100n, ownerOf: binding.identity, balanceOf: 123n };
    return abi.encodeFunctionResult(parsed.name, [values[parsed.name]]);
  } };
  const signature = await owner.signMessage(ownershipBindingMessage(binding));
  const signer: BindingGasSigner = { address: gasWallet.address.toLowerCase(),
    sign: jest.fn(plan => gasWallet.signTransaction({ type: 2, chainId: 8453, nonce: 3, to: plan.executor, data: plan.calldata,
      value: 0, gasLimit: 300000, maxFeePerGas: 2, maxPriorityFeePerGas: 1 })),
    broadcast: jest.fn(async raw => keccak256(raw)) };
  const ports: BindingWorkerPorts = { check: (store, b, sig, who) => checkBindingOperation(store, b, sig, who, chain),
    finalized: jest.fn(async () => null), registration: b => readConfirmedBinding(b, chain) };
  return { fake, db, binding, signature, chain, attestor, signer, ports, state };
}
test('binding queue requires admitted owner roots, independent attestation and exact on-chain simulation', async () => {
  const f = await fixture();
  const id = await queueBindingOperation(f.db, f.binding, f.signature, f.attestor, f.chain);
  expect(id).toBe(hashMessage(ownershipBindingMessage(f.binding)));
  expect(f.fake.store.get(`${BINDING_OPERATIONS}/${id}`)).toMatchObject({ status: 'queued', binding: f.binding });
  const plan = await checkBindingOperation(f.db, f.binding, f.signature, f.attestor, f.chain);
  expect(() => assertCheckedBindingOperation({ ...plan })).toThrow('unverified');
});
test.each(['pool', 'collapsed', 'signer', 'pointer', 'simulation'])('refuses invalid binding authority: %s', async change => {
  const f = await fixture(change);
  await expect(queueBindingOperation(f.db, f.binding, f.signature, f.attestor, f.chain)).rejects.toThrow();
  expect([...f.fake.store.keys()].filter(k => k.startsWith(BINDING_OPERATIONS))).toHaveLength(0);
});
test('recovery-root replacement or cross-owner binding cannot acquire an identity signature', async () => {
  const f = await fixture();
  for (const patch of [{ recoveryCommitment: hash('ab') }, { identity: hash('ab') }, { signingRoot: hash('ab') }]) {
    await expect(checkBindingOperation(f.db, { ...f.binding, ...patch }, f.signature, f.attestor, f.chain)).rejects.toThrow('owner_mismatch');
  }
  expect(f.attestor.signMessage).not.toHaveBeenCalled();
});
test.each([0, 1])('binding crash retry preserves exact bytes and finalized status %s releases its nonce', async status => {
  const f = await fixture();
  const id = await queueBindingOperation(f.db, f.binding, f.signature, f.attestor, f.chain);
  (f.signer.broadcast as jest.Mock).mockRejectedValueOnce(new Error('connection_lost'));
  await expect(executeBindingOperation(f.db, id, f.signer, f.attestor, f.ports)).rejects.toThrow('connection_lost');
  const stored = f.fake.store.get(`${BINDING_OPERATIONS}/${id}`)!;
  expect(await acquireSignerLease(f.fake as unknown as SettlementDb, { signer: f.signer.address, workerId: 'settlement',
    nowMs: Date.now() + 1_000_000, leaseTtlMs: 120000 })).toMatchObject({ kind: 'refused', reason: 'operation_reserved' });
  expect(await executeBindingOperation(f.db, id, f.signer, f.attestor, f.ports)).toBe('submitted');
  expect(f.signer.sign).toHaveBeenCalledTimes(1);
  expect(f.signer.broadcast).toHaveBeenNthCalledWith(2, stored.signedTransaction);
  (f.ports.finalized as jest.Mock).mockResolvedValue({ status });
  f.state.registered = status === 1;
  expect(await executeBindingOperation(f.db, id, f.signer, f.attestor, f.ports)).toBe(status ? 'confirmed' : 'failed');
  expect(f.fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${f.signer.address}`)?.pending_operation).toBeNull();
  expect(f.fake.store.get(`${RECOURSE_COLLECTIONS.addresses}/${f.binding.address}`)?.chainBindingStatus).toBe(status ? 'confirmed' : undefined);
});
test('exact consent executed by another submitter is reconciled without signing or a second broadcast', async () => {
  const f = await fixture();
  const id = await queueBindingOperation(f.db, f.binding, f.signature, f.attestor, f.chain);
  f.state.registered = true;
  expect(await executeBindingOperation(f.db, id, f.signer, f.attestor, f.ports)).toBe('confirmed');
  expect(f.signer.sign).not.toHaveBeenCalled();
  expect(f.signer.broadcast).not.toHaveBeenCalled();
  expect(f.fake.store.get(`${RECOURSE_COLLECTIONS.addresses}/${f.binding.address}`)).toMatchObject({
    chainBindingStatus: 'confirmed', boundBlock: 100, boundBlockHash: hash('bb'), openingBalanceAtomic: '123' });
});
