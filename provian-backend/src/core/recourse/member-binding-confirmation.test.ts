import { createHash } from 'crypto';
import { Interface, hashMessage } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { fixture, a, h, old, tx as txHash, pointer } from './__test-helpers__/membership-receipt-fixture';
import { confirmBindingRegistration, readConfirmedBinding, REGISTRY_ABI } from './binding-operation';
import { MEMBERSHIP_RECEIPT_ABI } from './membership-receipt';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C } from './private-membership-reservation';
import { RECOURSE_COLLECTIONS as R, ownershipBindingMessage } from './ownership';
import type { OwnerOperationChain } from './owner-operation-queue';
import type { ProtocolDeployment } from '../protocol/pointer';
jest.mock('../onchain/rpc-provider', () => ({ getOperatorBoundRpcLegs: jest.fn() }));
jest.mock('../protocol/runtime', () => ({ currentProtocolDeployment: async () => ({ addresses: { recoursePool: '0x000000000000000000000000000000000000006c' } }) }));
jest.mock('../protocol/pointer-pin.generated', () => ({ PROTOCOL_POINTER_PIN: {
  address: '0x0000000000000000000000000000000000000001', runtimeHash: require('ethers').keccak256('0x6000'),
} }));
async function setup() {
  const f = fixture(), fake = createFakeFirestore({ strictTransactionOrder: true, rejectUndefinedValues: true }), db = fake as unknown as Firestore;
  const binding = { identity: h(2), address: a(3), kernel: old[0], signingRoot: h(4), recoveryCommitment: h(5), nonce: h(6), expiresAtMs: 2000000000000 };
  const member = { authorization: { admissionMonth:'23640',rejoinPayments:[],fixedChargePayer:false,burnLimit:'0',reserveLimit:'0',earningsBpsLimit:100,exitCommitment:h(11),exitSalt:h(12),consent: { binding: h(2), account: a(3), nonce: '0', joined: true, revision: '1', ruleHash: h(9), expiresAt: '2000000000' } }, ownerSignature: '0x12' };
  const consentLog = MEMBERSHIP_RECEIPT_ABI.encodeEventLog(MEMBERSHIP_RECEIPT_ABI.getEvent('AddressConsentChanged')!, [h(2), 1, true, 0]);
  f.state.effects = [{ logIndex: '0x5', ...consentLog }];
  const abi = new Interface([...REGISTRY_ABI.fragments, 'function registryOperator() view returns(address)', 'function balanceOf(address) view returns(uint256)']);
  const chain: OwnerOperationChain = { deployment: async () => ({ addresses: { kernel: old[0] }, pointer } as ProtocolDeployment),
    agree: async (method, args) => {
      if (method === 'eth_blockNumber') return '0x6f';
      if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: h(100) };
      if (method === 'eth_getCode') return '0x6000';
      if (method === 'eth_getLogs') return [{ address: a(999), blockNumber: '0x64', blockHash: h(100), logIndex: '0x4', transactionHash: txHash, removed: false,
        ...REGISTRY_ABI.encodeEventLog(REGISTRY_ABI.getEvent('OwnershipBound')!, [binding.identity, binding.address, binding.kernel,
          binding.recoveryCommitment, binding.signingRoot, hashMessage(ownershipBindingMessage(binding))]) }];
      const call = args[0] as { data: string }, parsed = abi.parseTransaction(call)!;
      const values: Record<string, unknown> = { registryOperator: a(999), bindingBlock: 100, boundBlock: 100, ownerOf: h(2), balanceOf: 123 };
      return abi.encodeFunctionResult(parsed.name, [values[parsed.name]]);
    } };
  fake.store.set(`${R.addresses}/${a(3)}`, { ...binding, ownerIdentity: h(500), chainBindingStatus: 'pending' });
  fake.store.set(`${R.owners}/${h(500)}`, { ownerIdentity: h(500) });
  fake.store.set(`${C.owners}/${h(500)}`, { version: 1, pendingReservation: h(501), episode: { immutable: true } });
  const proof = (await readConfirmedBinding(binding, chain))!;
  return { f, fake, db, proof, member };
}
test('atomic confirmation records the authentic consent once, freezes new signatures and leaves an earlier reservation intact', async () => {
  const s = await setup(), original = JSON.stringify(s.fake.store.get(`${C.owners}/${h(500)}`));
  await confirmBindingRegistration(s.db, s.proof, s.member);
  const id = `0x${createHash('sha256').update(JSON.stringify([old[0], old[8], txHash, 5])).digest('hex')}`;
  expect(s.fake.store.get(`${C.effects}/${id}`)).toMatchObject({ ownerIdentity: h(500), bindingDigest: s.proof.digest, block: 100 });
  expect(s.fake.store.get(`${R.owners}/${h(500)}`)?.membershipScanRequired).toBe(true);
  expect(JSON.stringify(s.fake.store.get(`${C.owners}/${h(500)}`))).toBe(original);
  s.fake.store.set(`${R.owners}/${h(500)}`, { ownerIdentity: h(500), membershipScanRequired: false });
  await confirmBindingRegistration(s.db, s.proof, s.member);
  expect(s.fake.store.get(`${R.owners}/${h(500)}`)?.membershipScanRequired).toBe(false);
  s.fake.store.set(`${C.effects}/${id}`, { ownerIdentity: h(501), bindingDigest: s.proof.digest });
  await expect(confirmBindingRegistration(s.db, s.proof, s.member)).rejects.toThrow('effect_replay');
});
test('missing, earlier, wrong-nonce or wrong-binding consent cannot confirm atomic membership', async () => {
  const s = await setup(), original = [...s.f.state.effects];
  for (const effects of [[], [{ ...original[0], logIndex: '0x3' }]]) {
    s.f.state.effects = effects;
    await expect(confirmBindingRegistration(s.db, s.proof, s.member)).rejects.toThrow();
    expect(s.fake.store.get(`${R.addresses}/${a(3)}`)?.chainBindingStatus).toBe('pending');
  }
  s.f.state.effects = original;
  for (const consent of [{ ...s.member.authorization.consent, nonce: '1' }, { ...s.member.authorization.consent, binding: h(9) }, { ...s.member.authorization.consent, account: a(9) }])
    await expect(confirmBindingRegistration(s.db, s.proof, { ...s.member, authorization:{...s.member.authorization,consent} })).rejects.toThrow('effect_missing');
  await expect(confirmBindingRegistration(s.db, { ...s.proof }, s.member)).rejects.toThrow('unverified');
});
