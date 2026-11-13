import { Interface, Wallet, keccak256, hashMessage, verifyMessage, getBytes } from 'ethers';
import { memberBindingSigningHash } from './member-binding';
import { standingMembershipSigningHash } from './membership-authorization';
import { joinPrivateMembership, type PrivateCalendarRules } from './private-membership-calendar';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C } from './private-membership-reservation';
import { utcCalendarMonth } from './calendar-month';
import { readPrivateCalendarRules } from './private-calendar-rules';
jest.mock('./private-calendar-rules', () => ({ readPrivateCalendarRules: jest.fn() }));
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
async function fixture(change = '', member = false) {
  const state = { registered: false };
  const timestamp = Math.floor(Date.now() / 1000);
  const rules: PrivateCalendarRules = () => ({ ruleHash: hash('a1'), rule: { schema: 'provian-recourse-membership/v1', chainId: 8453,
    pointer: address('aa'), firstMonth: 0, participationBurnAtomic: '100', noEarningsContributionAtomic: '100', earningsBps: 100 } });
  (readPrivateCalendarRules as jest.Mock).mockResolvedValue(rules);
  const fake = createFakeFirestore({ strictTransactionOrder: true }), db = fake as unknown as Firestore;
  const binding: OwnershipBinding = { address: owner.address.toLowerCase(), identity: hash('44'),
    recoveryCommitment: hash('55'), signingRoot: hash('66'), kernel: address('77'), nonce: hash('88'), expiresAtMs: Date.now() + 300000 };
  fake.store.set(`${RECOURSE_COLLECTIONS.identities}/${binding.identity}`, { recoveryCommitment: binding.recoveryCommitment,
    signingRoot: binding.signingRoot, recoveryGeneration: 0, ownerIdentity: hash('ab') });
  fake.store.set(`${RECOURSE_COLLECTIONS.addresses}/${binding.address}`, { identity: binding.identity, kernel: binding.kernel, recoveryGeneration: 0, ownerIdentity: hash('ab') });
  fake.store.set(`${RECOURSE_COLLECTIONS.owners}/${hash('ab')}`, { ownerIdentity: hash('ab') });
  const deployment = { addresses: { kernel: binding.kernel, recoursePool: address('99') }, revision: 1n,
    pointer: address('aa'), blockHash: hash('bb'), manifestHash: hash('cc') } as ProtocolDeployment;
  if (member) fake.store.set(`${C.owners}/${hash('ab')}`, { ownerIdentity: hash('ab'), version: 1, pendingReservation: null, needsScan: false,
    checkpoint: { pool: address('99'), block: 100, blockHash: hash('bb') }, episode: joinPrivateMembership(null, utcCalendarMonth(timestamp), rules) });
  const abi = new Interface(['function registryOperator() view returns(address)', 'function restorationAuthority() view returns(address)', 'function balanceOf(address) view returns(uint256)',
    ...REGISTRY_ABI.fragments]);
  const attestor = { address: attestorWallet.address.toLowerCase(), signMessage: jest.fn((message: string) => attestorWallet.signMessage(message)), signBytes: jest.fn((bytes: Uint8Array) => attestorWallet.signMessage(bytes)) };
  const chain: OwnerOperationChain = { deployment: async () => deployment, agree: async (_method, args) => {
    if (_method === 'eth_getBlockByHash') return { hash: hash('bb'), number: '0x64', timestamp: `0x${timestamp.toString(16)}` };
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
    if (parsed.name === 'bind' || parsed.name === 'bindWithConsent') {
      expect(call.to).toBe(address('dd'));
      if (change === 'simulation') throw new Error('signature_refused');
      expect(verifyMessage(ownershipBindingMessage(binding), parsed.args[1])).toBe(owner.address);
      if (parsed.name === 'bindWithConsent') {
        const consent = { binding: parsed.args[4].consent[0], account: String(parsed.args[4].consent[1]).toLowerCase(), nonce: String(parsed.args[4].consent[2]), joined: parsed.args[4].consent[3], revision: String(parsed.args[4].consent[4]), ruleHash: parsed.args[4].consent[5], expiresAt: String(parsed.args[4].consent[6]) };
        const authorization={consent,admissionMonth:'23640',rejoinPayments:[],fixedChargePayer:parsed.args[4].fixedChargePayer,burnLimit:String(parsed.args[4].burnLimit),reserveLimit:String(parsed.args[4].reserveLimit),earningsBpsLimit:Number(parsed.args[4].earningsBpsLimit),exitCommitment:parsed.args[4].exitCommitment,exitSalt:parsed.args[4].exitSalt};
        const domain = { chainId: '8453', pointer: deployment.pointer, kernel: binding.kernel, pool: address('99') };
        expect(verifyMessage(getBytes(memberBindingSigningHash(domain, address('dd'), binding, authorization)), parsed.args[2])).toBe(attestorWallet.address);
        expect(verifyMessage(getBytes(standingMembershipSigningHash(domain, authorization)), parsed.args[5])).toBe(owner.address);
        expect(verifyMessage(getBytes(standingMembershipSigningHash(domain, authorization)), parsed.args[6])).toBe(attestorWallet.address);
      } else expect(verifyMessage(ownershipBindingMessage(binding), parsed.args[2])).toBe(attestorWallet.address);
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
  const ports: BindingWorkerPorts = { check: (store, b, sig, who, _chain, memberConsent) => checkBindingOperation(store, b, sig, who, chain, memberConsent),
    finalized: jest.fn(async () => null), registration: b => readConfirmedBinding(b, chain) };
  return { fake, db, binding, signature, chain, attestor, signer, ports, state, timestamp };
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

test('an active member must sign atomic consent; queue and crash retry preserve both mandates', async () => {
  const f = await fixture('', true), consent = { binding: f.binding.identity, account: f.binding.address, nonce: '0', joined: true,
    revision: '1', ruleHash: hash('a1'), expiresAt: String(f.timestamp + 200) };
  const authorization={consent,admissionMonth:'23640',rejoinPayments:[],fixedChargePayer:false,burnLimit:'0',reserveLimit:'0',earningsBpsLimit:100,exitCommitment:hash('a2'),exitSalt:hash('a3')};
  const member = { authorization, ownerSignature: await owner.signMessage(getBytes(standingMembershipSigningHash(
    { chainId: '8453', pointer: address('aa'), kernel: f.binding.kernel, pool: address('99') }, authorization))) };
  await expect(checkBindingOperation(f.db, f.binding, f.signature, f.attestor, f.chain)).rejects.toThrow('member_consent_required');
  expect(f.attestor.signBytes).not.toHaveBeenCalled();
  const id = await queueBindingOperation(f.db, f.binding, f.signature, f.attestor, f.chain, member);
  expect(f.fake.store.get(`${BINDING_OPERATIONS}/${id}`)?.memberConsent).toMatchObject(member);
  (f.signer.broadcast as jest.Mock).mockRejectedValueOnce(Error('connection_lost'));
  await expect(executeBindingOperation(f.db, id, f.signer, f.attestor, f.ports)).rejects.toThrow('connection_lost');
  const stored = f.fake.store.get(`${BINDING_OPERATIONS}/${id}`)!;
  expect(await executeBindingOperation(f.db, id, f.signer, f.attestor, f.ports)).toBe('submitted');
  expect(f.signer.sign).toHaveBeenCalledTimes(1);
  expect(f.signer.broadcast).toHaveBeenNthCalledWith(2, stored.signedTransaction);
  expect(REGISTRY_ABI.parseTransaction({ data: stored.calldata as string })?.name).toBe('bindWithConsent');
});
test.each(['membershipTransition', 'membershipScanRequired'])('private owner freeze refuses new binding signatures: %s', async key => {
  const f = await fixture();
  f.fake.store.set(`${RECOURSE_COLLECTIONS.owners}/${hash('ab')}`, { ownerIdentity: hash('ab'), [key]: key === 'membershipScanRequired' ? true : hash('ee') });
  await expect(checkBindingOperation(f.db, f.binding, f.signature, f.attestor, f.chain)).rejects.toThrow('private_owner_pending');
  expect(f.attestor.signMessage).not.toHaveBeenCalled(); expect(f.attestor.signBytes).not.toHaveBeenCalled();
});
