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
  assertCheckedBindingOperation, readConfirmedBinding, readAddressBinding } from './binding-operation';
import { bindingLaneKind, type BindingLanePorts } from './transaction-lane-kinds';
import { runRecourseLane, RECOURSE_LANE_COLLECTION } from './transaction-lane';
import { simulatedBase, laneTestWallet } from './__test-helpers__/lane-chain-fixture';
import type { OwnerOperationChain } from './owner-operation-queue';
import type { ProtocolDeployment } from '../protocol/pointer';

const address = (b: string) => `0x${b.repeat(20)}`, hash = (b: string) => `0x${b.repeat(32)}`;
const owner = new Wallet(hash('11')), attestorWallet = new Wallet(hash('22')), gasWallet = new Wallet(hash('33')); // Public test keys.
async function fixture(change = '', member = false) {
  // `priorBound`: the address was first bound by an earlier signature of the same owner, in block 50.
  const state = { registered: false, priorBound: false };
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
    // Head 0x6f: block 0x64 has exactly twelve confirmations.
    if (_method === 'eth_blockNumber') return '0x6f';
    if (_method === 'eth_getBlockByHash') return { hash: hash('bb'), number: '0x64', timestamp: `0x${timestamp.toString(16)}` };
    if (_method === 'eth_getCode') return state.registered ? '0x1234' : '0x';
    if (_method === 'eth_getBlockByNumber') return { hash: hash('bb'), number: '0x64' };
    if (_method === 'eth_getLogs') {
      const log = REGISTRY_ABI.encodeEventLog(REGISTRY_ABI.getEvent('OwnershipBound')!, [binding.identity,
        binding.address, binding.kernel, binding.recoveryCommitment, binding.signingRoot, hashMessage(ownershipBindingMessage(binding))]);
      return [{ ...log, address: address('dd'), blockNumber: '0x64', blockHash: hash('bb'), transactionHash: hash('ef'), logIndex: '0x2', removed: false }];
    }
    const call = args[0] as { to: string; data: string };
    // The already-bound check before signing reads the latest block; every other read is pinned.
    if (args[1] !== 'latest') expect(args[1]).toEqual({ blockHash: deployment.blockHash, requireCanonical: true });
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
      bindingBlock: state.registered ? 100n : 0n, boundBlock: state.priorBound ? 50n : state.registered ? 100n : 0n, ownerOf: binding.identity, balanceOf: 123n };
    return abi.encodeFunctionResult(parsed.name, [values[parsed.name]]);
  } };
  const signature = await owner.signMessage(ownershipBindingMessage(binding));
  const gas = laneTestWallet(), base = simulatedBase(gas.address);
  const ports: BindingLanePorts = { check: (store, b, sig, who, _chain, memberConsent) => checkBindingOperation(store, b, sig, who, chain, memberConsent),
    registration: b => readConfirmedBinding(b, chain), addressBinding: (b, tag) => readAddressBinding(b, tag, chain) };
  const kind = bindingLaneKind(db, attestor, ports);
  const signer = { address: gas.address.toLowerCase(), signTransaction: jest.fn((tx: Parameters<typeof gas.signTransaction>[0]) => gas.signTransaction(tx)) };
  const run = () => runRecourseLane({ db, signer, chain: base, kinds: [kind], workerId: `w-${Math.random()}`, now: base.now }, base.now() + 5_000);
  return { fake, db, binding, signature, chain, attestor, signer, base, run, state, timestamp };
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
test.each([0, 1])('binding crash retry rebroadcasts the exact persisted bytes and twelve-confirmation status %s releases its nonce', async status => {
  const f = await fixture();
  const id = await queueBindingOperation(f.db, f.binding, f.signature, f.attestor, f.chain);
  f.base.state.failBroadcasts = 1;
  expect(await f.run()).toMatchObject({ signed: 1, stopReason: 'recourse_lane_broadcast_failed' });
  const stored = f.fake.store.get(`${BINDING_OPERATIONS}/${id}`)!;
  expect(stored).toMatchObject({ status: 'submitted', laneNonce: 0, gasPayer: f.signer.address, gasSigner: f.signer.address });
  expect(f.fake.store.get(`${RECOURSE_LANE_COLLECTION}/${f.signer.address}`)).toMatchObject({ next_nonce: 1, open: { 0: { collection: BINDING_OPERATIONS, id } } });
  expect(await f.run()).toMatchObject({ signed: 0 });
  expect(f.signer.signTransaction).toHaveBeenCalledTimes(1);
  expect(f.base.state.broadcasts).toEqual([stored.signedTransaction]);
  f.base.state.status = () => status as 0 | 1;
  f.base.mine(); f.state.registered = status === 1;
  // Eleven confirmations: still open.
  f.base.advance(10);
  expect(await f.run()).toMatchObject({ confirmed: 0, failed: 0, open: 1 });
  f.base.advance(1);
  expect(await f.run()).toMatchObject(status ? { confirmed: 1 } : { failed: 1 });
  expect(f.fake.store.get(`${BINDING_OPERATIONS}/${id}`)?.status).toBe(status ? 'confirmed' : 'failed');
  expect(f.fake.store.get(`${RECOURSE_LANE_COLLECTION}/${f.signer.address}`)?.open).toEqual({});
  expect(f.fake.store.get(`${RECOURSE_COLLECTIONS.addresses}/${f.binding.address}`)?.chainBindingStatus).toBe(status ? 'confirmed' : undefined);
});
test('an address already bound to the same owner is never bound a second time', async () => {
  const f = await fixture();
  const id = await queueBindingOperation(f.db, f.binding, f.signature, f.attestor, f.chain);
  f.state.priorBound = true;
  expect(await f.run()).toMatchObject({ signed: 0, failed: 1, closedUnsigned: 1 });
  expect(f.fake.store.get(`${BINDING_OPERATIONS}/${id}`)).toMatchObject({ status: 'failed', terminalReason: 'binding_already_bound' });
  expect(f.signer.signTransaction).not.toHaveBeenCalled();
  expect(f.base.state.broadcasts).toHaveLength(0);
});
test('a re-signed binding that lands after the earlier one closes as a duplicate instead of holding a lane slot forever', async () => {
  const f = await fixture();
  const id = await queueBindingOperation(f.db, f.binding, f.signature, f.attestor, f.chain);
  expect(await f.run()).toMatchObject({ signed: 1 });
  // The earlier signature landed first (block 50); this one lands after it.
  f.base.mine(); f.state.priorBound = true; f.state.registered = true;
  f.base.advance(11);
  expect(await f.run()).toMatchObject({ confirmed: 1 });
  expect(f.fake.store.get(`${BINDING_OPERATIONS}/${id}`)).toMatchObject({ status: 'confirmed', terminalReason: 'binding_duplicate_of_prior' });
  expect(f.fake.store.get(`${RECOURSE_LANE_COLLECTION}/${f.signer.address}`)?.open).toEqual({});
  // The address record is confirmed by the earlier binding's own request, never by the duplicate.
  expect(f.fake.store.get(`${RECOURSE_COLLECTIONS.addresses}/${f.binding.address}`)?.chainBindingStatus).toBeUndefined();
});
test('exact consent executed by another submitter is reconciled without signing or a second broadcast', async () => {
  const f = await fixture();
  const id = await queueBindingOperation(f.db, f.binding, f.signature, f.attestor, f.chain);
  f.state.registered = true;
  expect(await f.run()).toMatchObject({ confirmed: 1, signed: 0, closedUnsigned: 1 });
  expect(f.fake.store.get(`${BINDING_OPERATIONS}/${id}`)).toMatchObject({ status: 'confirmed', terminalReason: 'binding_executed_by_other_submitter' });
  expect(f.signer.signTransaction).not.toHaveBeenCalled();
  expect(f.base.state.broadcasts).toHaveLength(0);
  expect(f.fake.store.get(`${RECOURSE_COLLECTIONS.addresses}/${f.binding.address}`)).toMatchObject({
    chainBindingStatus: 'confirmed', boundBlock: 100, boundBlockHash: hash('bb'), openingBalanceAtomic: '123' });
});
test('an expired owner signature closes without gas and never holds up the live binding behind it', async () => {
  const f = await fixture();
  const id = await queueBindingOperation(f.db, f.binding, f.signature, f.attestor, f.chain);
  // Age the request past its on-chain window (less the send margin).
  const row = f.fake.store.get(`${BINDING_OPERATIONS}/${id}`)!;
  f.fake.store.set(`${BINDING_OPERATIONS}/${id}`, { ...row, binding: { ...f.binding } });
  const expired = bindingLaneKind(f.db, f.attestor, { check: jest.fn(), registration: async () => null, now: () => f.binding.expiresAtMs - 1_000 });
  const report = await runRecourseLane({ db: f.db, signer: f.signer, chain: f.base, kinds: [expired], workerId: 'w' }, Date.now() + 5_000);
  expect(report).toMatchObject({ signed: 0, failed: 1, closedUnsigned: 1 });
  expect(f.fake.store.get(`${BINDING_OPERATIONS}/${id}`)).toMatchObject({ status: 'failed', terminalReason: 'binding_expired' });
  expect(f.fake.store.get(`${BINDING_OPERATIONS}/${id}`)?.laneQueueKey).toBeUndefined();
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
  f.base.state.failBroadcasts = 1;
  expect(await f.run()).toMatchObject({ signed: 1, stopReason: 'recourse_lane_broadcast_failed' });
  const stored = f.fake.store.get(`${BINDING_OPERATIONS}/${id}`)!;
  expect(await f.run()).toMatchObject({ signed: 0 });
  expect(f.signer.signTransaction).toHaveBeenCalledTimes(1);
  expect(f.base.state.broadcasts).toEqual([stored.signedTransaction]);
  expect(REGISTRY_ABI.parseTransaction({ data: stored.calldata as string })?.name).toBe('bindWithConsent');
});
test.each(['membershipTransition', 'membershipScanRequired'])('private owner freeze refuses new binding signatures: %s', async key => {
  const f = await fixture();
  f.fake.store.set(`${RECOURSE_COLLECTIONS.owners}/${hash('ab')}`, { ownerIdentity: hash('ab'), [key]: key === 'membershipScanRequired' ? true : hash('ee') });
  await expect(checkBindingOperation(f.db, f.binding, f.signature, f.attestor, f.chain)).rejects.toThrow('private_owner_pending');
  expect(f.attestor.signMessage).not.toHaveBeenCalled(); expect(f.attestor.signBytes).not.toHaveBeenCalled();
});
