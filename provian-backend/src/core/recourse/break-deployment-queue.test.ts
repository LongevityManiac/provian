import { execFileSync } from 'node:child_process';
import { AbiCoder, Interface, concat, sha256, Wallet, keccak256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { BREAK_REGISTRATIONS, checkBreakRegistration, assertCheckedBreakRegistration, queueBreakRegistration,
  breakRegistrationAdapter } from './break-registration';
import { breakDeploymentAdapter, sponsoredLaneKind } from './transaction-lane-kinds';
import { runRecourseLane, RECOURSE_LANE_COLLECTION, type LaneKind } from './transaction-lane';
import { simulatedBase, laneTestWallet, LANE_TEST_KEY } from './__test-helpers__/lane-chain-fixture';
import { RECOURSE_GAS_KEY_ENV } from './transaction-lane-key';
process.env[RECOURSE_GAS_KEY_ENV] = LANE_TEST_KEY;
const LANE = laneTestWallet().address.toLowerCase();
import { BREAK_DEPLOYMENTS, BREAK_DEPLOYMENT_ATTEMPTS, queueBreakDeployment, checkBreakDeployment, assertCheckedBreakDeployment } from './break-deployment-queue';
import { breakDeploymentDigest, replacementDeploymentDigest, type ReplacementDeploymentRequest, type BreakDeploymentRequest } from './break-deployment-data';
import type { OwnerOperationChain } from './owner-operation-queue';
import type { ProtocolDeployment } from '../protocol/pointer';
// Jest's CommonJS VM cannot load this ESM package. The test bridge executes the
// actual verifier in Node, with public test material only; it does not replace
// cryptographic verification with an always-true mock.
jest.mock('@noble/post-quantum/slh-dsa.js', () => ({ slh_dsa_sha2_128s: {
  verify: (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => {
    const { execFileSync } = jest.requireActual<typeof import('node:child_process')>('node:child_process');
    const output = execFileSync(process.execPath, ['--input-type=module', '-e',
      "import {readFileSync} from 'node:fs'; import {slh_dsa_sha2_128s as s} from '@noble/post-quantum/slh-dsa.js'; const x=JSON.parse(readFileSync(0,'utf8')); console.log(JSON.stringify(s.verify(...x.map(v=>new Uint8Array(v)))));"],
    { input: JSON.stringify([[...signature], [...message], [...publicKey]]), encoding: 'utf8' });
    return JSON.parse(output) as boolean;
  },
} }));
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`, h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const abi = new Interface(['function ownerAuthorization() view returns(address)', 'function kernel() view returns(address)',
  'function breakOrigin() view returns(address)', 'function predecessor() view returns(address)', 'function lastGoodBlock() view returns(uint256)',
  'function restorationRoot() view returns(bytes32)', 'function hashAccountFactory() view returns(address)',
  'function accountAddress(bytes32) view returns(address)', 'function deploy(bytes32) returns(address)',
  'function operationalMinter() view returns(address)', 'function submitter() view returns(address)', 'function pool() view returns(address)',
  'function ownerAuthorizationNonce(bytes32) view returns(uint256)', 'function recoveredDestination(bytes32) view returns(address)',
  'function hashAccountCodeHash() view returns(bytes32)', 'function restoredIdentity(bytes32) view returns(bool)',
  'function ownerRecoveryCommitment(bytes32) view returns(bytes32)', 'function ownerSigningRoot(bytes32) view returns(bytes32)',
  'function registerBreakOwner(bytes32,uint256,bytes32,bytes32,bytes32[])']);
let request: BreakDeploymentRequest, leaf: string;
beforeAll(() => {
  const publicKey = execFileSync(process.execPath, ['--input-type=module', '-e',
    "import {slh_dsa_sha2_128s as s} from '@noble/post-quantum/slh-dsa.js'; console.log('0x'+Buffer.from(s.keygen(new Uint8Array(48).fill(1)).publicKey).toString('hex'));"], { encoding: 'utf8' }).trim();
  const signingRoot = sha256(publicKey), recoverySecret = h(22), commitment = sha256(concat([recoverySecret, signingRoot]));
  request = { kind: 'deploy', breakOrigin: a(3), factory: a(4), account: a(5), initialRoot: h(6), identity: h(7), amount: '100',
    commitment, proof: [], recoverySecret, signingRoot, publicKey, signature: '0x' };
  const signature = execFileSync(process.execPath, ['--input-type=module', '-e',
    "import {slh_dsa_sha2_128s as s} from '@noble/post-quantum/slh-dsa.js'; const k=s.keygen(new Uint8Array(48).fill(1)); console.log('0x'+Buffer.from(s.sign(Buffer.from(process.argv[1].slice(2),'hex'),k.secretKey,{extraEntropy:false})).toString('hex'));", breakDeploymentDigest(request)], { encoding: 'utf8' }).trim();
  request = { ...request, signature };
  leaf = sha256(AbiCoder.defaultAbiCoder().encode(['string','address','uint256','bytes32','uint256','bytes32'],
    ['Provian restoration', a(8), 100, request.identity, request.amount, commitment]));
});
function port(mode = 'valid', gasPayer = a(13)): OwnerOperationChain {
  return { async deployment() { return { addresses: { kernel: a(1), settlement: a(9), recoursePool: a(10) },
    blockHash: h(11), manifestHash: h(12), revision: 4n } as ProtocolDeployment; }, async agree(method, params) {
    expect(params.at(-1)).toEqual({ blockHash: h(11), requireCanonical: true });
    if (method === 'eth_getCode') return mode.startsWith('registration') ? '0x6000' : '0x';
    const call = abi.parseTransaction({ data: (params[0] as { data: string }).data })!;
    if (call.name === 'registerBreakOwner') {
      expect(call.args[0]).toBe(request.identity); expect(call.args[2]).toBe(request.recoverySecret);
      return '0x';
    }
    const account = (call.name === 'accountAddress' || call.name === 'deploy') && call.args[0] !== h(6) ? a(6) : a(5);
    const values: Record<string, unknown> = { ownerAuthorizationNonce: mode === 'replacement-nonce' ? 2 : 1, recoveredDestination: mode === 'replacement-destination' ? a(5) : a(44), ownerAuthorization: a(2), kernel: a(1), breakOrigin: a(3),
      hashAccountFactory: mode === 'factory' ? a(99) : a(4), accountAddress: account, predecessor: a(8), lastGoodBlock: 100,
      restorationRoot: mode === 'proof' ? h(99) : leaf, operationalMinter: a(9), submitter: gasPayer, pool: a(10),
      deploy: mode === 'simulation' ? a(99) : account, hashAccountCodeHash: keccak256('0x6000'),
      restoredIdentity: mode === 'registration-restored', ownerRecoveryCommitment: mode === 'registration-owner' ? h(99)
        : mode === 'registration-done' || mode.startsWith('replacement') ? request.commitment : h(0), ownerSigningRoot: request.signingRoot };
    return abi.encodeFunctionResult(call.name, [values[call.name]]);
  } };
}
test('only a real independent-owner signature and exact snapshot/factory produce a gas-spend capability', async () => {
  const plan = await checkBreakDeployment(request, port());
  // The settlement submitter (a(13)) is verified but never pays; the Recourse lane does.
  expect(plan).toMatchObject({ executor: a(4), gasPayer: LANE, alreadyDeployed: false, id: breakDeploymentDigest(request) });
  await expect(checkBreakDeployment(request, port(), a(13))).rejects.toThrow('sponsor_invalid');
  expect(() => assertCheckedBreakDeployment(plan)).not.toThrow();
  expect(() => assertCheckedBreakDeployment({ ...plan })).toThrow('unverified');
  expect(abi.parseTransaction({ data: plan.calldata })!.args[0]).toBe(request.initialRoot);
});
test('free registration uses only the current executor and snapshot-backed commitment after account deployment', async () => {
  const value = { deployment: request, kernel: a(1) };
  const plan = await checkBreakRegistration(value, port('registration'));
  expect(plan).toMatchObject({ executor: a(2), alreadyRegistered: false });
  expect(abi.parseTransaction({ data: plan.calldata })!.name).toBe('registerBreakOwner');
  expect(() => assertCheckedBreakRegistration(plan)).not.toThrow();
  expect(() => assertCheckedBreakRegistration({ ...plan })).toThrow('unverified');
  for (const mode of ['registration-done', 'registration-restored']) {
    expect(await checkBreakRegistration(value, port(mode))).toMatchObject({ alreadyRegistered: true });
  }
  await expect(checkBreakRegistration(value, port())).rejects.toThrow('account_unavailable');
  await expect(checkBreakRegistration(value, port('registration-owner'))).rejects.toThrow('owner_changed');
  await expect(checkBreakRegistration({ ...value, kernel: a(99) }, port('registration'))).rejects.toThrow('retired');
  await expect(checkBreakRegistration({ ...value, target: a(99) }, port('registration'))).rejects.toThrow('invalid');
});
function laneFor(db: Firestore, kind: LaneKind) {
  const wallet = laneTestWallet(), base = simulatedBase(wallet.address);
  const signer = { address: LANE, signTransaction: jest.fn((tx: Parameters<typeof wallet.signTransaction>[0]) => wallet.signTransaction(tx)) };
  const run = () => runRecourseLane({ db, signer, chain: base, kinds: [kind], workerId: `w-${Math.random()}`, now: base.now }, base.now() + 5_000);
  return { base, signer, run, wallet, confirm: () => { base.mine(); base.advance(11); } };
}
test('registration persists the exact proof call before broadcast and never signs twice on retry', async () => {
  const fake = createFakeFirestore({ strictTransactionOrder: true }), db = fake as unknown as Firestore;
  const chain = port('registration'), value = { deployment: request, kernel: a(1) };
  const queued = await queueBreakRegistration(db, value, chain);
  const l = laneFor(db, sponsoredLaneKind('break_registration', breakRegistrationAdapter(input => checkBreakRegistration(input, chain))));
  l.base.state.failBroadcasts = 1;
  expect(await l.run()).toMatchObject({ signed: 1 });
  const raw = fake.store.get(`${BREAK_REGISTRATIONS}/${queued.id}`)?.signedTransaction;
  expect(await l.run()).toMatchObject({ signed: 0 });
  expect(l.signer.signTransaction).toHaveBeenCalledTimes(1);
  expect(l.base.state.broadcasts).toEqual([raw]);
});

async function workerFixture(replacement = false) {
  const fake = createFakeFirestore({ strictTransactionOrder: true }), db = fake as unknown as Firestore;
  const chain = port(replacement ? 'replacement' : 'valid'), queued = await queueBreakDeployment(db, replacement ? replacementRequest() : request, chain);
  const ports = { check: jest.fn((value: unknown) => checkBreakDeployment(value, chain)) };
  const l = laneFor(db, sponsoredLaneKind('break_deployment', breakDeploymentAdapter(value => ports.check(value))));
  const lane = () => fake.store.get(`${RECOURSE_LANE_COLLECTION}/${LANE}`);
  return { db, fake, ports, id: queued.id, ...l, lane };
}
test('deployment retries retain one signed nonce and finish only at twelve confirmations', async () => {
  const f = await workerFixture();
  expect(await f.run()).toMatchObject({ signed: 1 });
  // Seconds later nothing is resent; twelve blocks later the still-unincluded bytes are.
  expect(await f.run()).toMatchObject({ signed: 0, open: 1 });
  expect(f.base.state.broadcasts).toHaveLength(1);
  f.base.state.inclusionFloor = 10n ** 30n; f.base.advance(12);
  expect(await f.run()).toMatchObject({ signed: 0, open: 1 });
  expect(f.signer.signTransaction).toHaveBeenCalledTimes(1); expect(f.base.state.broadcasts).toHaveLength(2);
  f.base.state.inclusionFloor = 0n;
  f.base.mine(); f.base.advance(10);
  expect(await f.run()).toMatchObject({ confirmed: 0, open: 1 });
  f.base.advance(1);
  expect(await f.run()).toMatchObject({ confirmed: 1, open: 0 });
  expect(f.fake.store.get(`${BREAK_DEPLOYMENTS}/${f.id}`)?.status).toBe('confirmed');
  expect(f.signer.signTransaction).toHaveBeenCalledTimes(1); expect(f.base.state.broadcasts).toHaveLength(2);
});
test('a lost broadcast resumes identical persisted bytes, and a confirmed revert consumes the reservation', async () => {
  const f = await workerFixture();
  f.base.state.failBroadcasts = 1;
  expect(await f.run()).toMatchObject({ signed: 1, stopReason: 'recourse_lane_broadcast_failed' });
  const raw = f.fake.store.get(`${BREAK_DEPLOYMENTS}/${f.id}`)!.signedTransaction;
  await f.run();
  expect(f.base.state.broadcasts).toEqual([raw]); expect(f.signer.signTransaction).toHaveBeenCalledTimes(1);
  f.base.state.status = () => 0; f.confirm();
  expect(await f.run()).toMatchObject({ failed: 1 });
  expect(f.lane()?.open).toEqual({});
  await expect(queueBreakDeployment(f.db, request, port('valid'), async () => null)).rejects.toThrow('retry_unreconciled');
  expect(await queueBreakDeployment(f.db, request, port('valid'), value => f.base.confirmed(value))).toMatchObject({ status: 'queued', transactionHash: null });
  expect(f.fake.store.get(`${BREAK_DEPLOYMENT_ATTEMPTS}/${f.id}_${keccak256(String(raw))}`)).toMatchObject({
    signedTransaction: raw, transactionHash: keccak256(String(raw)), status: 'finalized_revert' });
  expect(f.fake.store.get(`${BREAK_DEPLOYMENTS}/${f.id}`)?.signedTransaction).toBeUndefined();
});
test('a requeue is refused while the lane still holds the signed nonce', async () => {
  const f = await workerFixture();
  await f.run();
  const row = f.fake.store.get(`${BREAK_DEPLOYMENTS}/${f.id}`)!;
  // Even a row marked failed cannot be requeued while its nonce is open in the lane.
  f.fake.store.set(`${BREAK_DEPLOYMENTS}/${f.id}`, { ...row, status: 'failed' });
  f.base.state.status = () => 0; f.confirm();
  await expect(queueBreakDeployment(f.db, request, port('valid'), value => f.base.confirmed(value))).rejects.toThrow('retry_unreconciled');
});
test('a receipt short of twelve confirmations retains the reservation and never signs another transaction', async () => {
  const f = await workerFixture();
  await f.run(); f.base.mine(); f.base.advance(5);
  expect(await f.run()).toMatchObject({ signed: 0, confirmed: 0, open: 1 });
  expect(f.lane()?.open).toEqual({ 0: { collection: BREAK_DEPLOYMENTS, id: f.id } });
  expect(f.signer.signTransaction).toHaveBeenCalledTimes(1); expect(f.base.state.broadcasts).toHaveLength(1);
});
test('another writer on the lane key stops all signing', async () => {
  const f = await workerFixture();
  // The lane has already allocated through nonce 0; a transaction it never signed then consumes it.
  f.fake.store.set(`${RECOURSE_LANE_COLLECTION}/${LANE}`, { signer: LANE, next_nonce: 0, open: {}, owner: null, expires_at_ms: 0 });
  f.base.foreign();
  expect(await f.run()).toMatchObject({ signed: 0, stopReason: 'recourse_lane_nonce_foreign' });
  expect(f.signer.signTransaction).not.toHaveBeenCalled(); expect(f.base.state.broadcasts).toHaveLength(0);
  // A brand-new lane refuses to start over another writer's pending transaction.
  const fresh = await workerFixture();
  fresh.base.state.mempool.set(0, 'foreign');
  await expect(fresh.run()).rejects.toThrow('recourse_lane_nonce_foreign');
});
test('a signer crash reserves nothing and an obsolete unsigned plan then closes without blocking anything', async () => {
  const f = await workerFixture();
  f.signer.signTransaction.mockRejectedValueOnce(Error('signer_crashed'));
  expect(await f.run()).toMatchObject({ stopReason: 'recourse_lane_sign_failed' });
  expect(f.lane()).toMatchObject({ next_nonce: 0, open: {} });
  expect(f.fake.store.get(`${BREAK_DEPLOYMENTS}/${f.id}`)?.signedTransaction).toBeUndefined();
  f.ports.check.mockImplementation(async () => { throw Error('break_deployment_retired'); });
  expect(await f.run()).toMatchObject({ failed: 1, closedUnsigned: 1 });
  expect(f.base.state.broadcasts).toHaveLength(0);
});
test('one break entitlement cannot sponsor multiple destinations, but an obsolete unsigned choice is replaceable', async () => {
  const { db, fake, id } = await workerFixture();
  const alternative = { ...request, initialRoot: h(99), account: a(6) };
  alternative.signature = execFileSync(process.execPath, ['--input-type=module', '-e',
    "import {slh_dsa_sha2_128s as s} from '@noble/post-quantum/slh-dsa.js'; const k=s.keygen(new Uint8Array(48).fill(1)); console.log('0x'+Buffer.from(s.sign(Buffer.from(process.argv[1].slice(2),'hex'),k.secretKey,{extraEntropy:false})).toString('hex'));", breakDeploymentDigest(alternative)], { encoding: 'utf8' }).trim();
  const chain = port('valid');
  await expect(queueBreakDeployment(db, alternative, chain)).rejects.toThrow('destination_selected');
  const old = fake.store.get(`${BREAK_DEPLOYMENTS}/${id}`)!;
  fake.store.set(`${BREAK_DEPLOYMENTS}/${id}`, { ...old, status: 'failed', signedTransaction: '0x12' });
  await expect(queueBreakDeployment(db, alternative, chain)).rejects.toThrow('destination_selected');
  fake.store.set(`${BREAK_DEPLOYMENTS}/${id}`, { ...old, status: 'failed' });
  expect(await queueBreakDeployment(db, alternative, chain)).toMatchObject({ id: breakDeploymentDigest(alternative), status: 'queued' });
});
test.each(['target', 'value', 'data', 'chain'])('a signer cannot substitute %s in a sponsored deployment', async field => {
  const f = await workerFixture();
  f.signer.signTransaction.mockImplementation(tx => f.wallet.signTransaction({ ...tx, chainId: field === 'chain' ? 1 : 8453,
    to: field === 'target' ? a(99) : tx.to, data: field === 'data' ? '0x' : tx.data, value: field === 'value' ? 1 : 0 }));
  const report = await f.run();
  expect(report).toMatchObject({ signed: 0, stopReason: 'recourse_lane_sign_failed' });
  expect(report.errors.some(e => e.startsWith('recourse_lane_signed_mismatch'))).toBe(true);
  expect(f.base.state.broadcasts).toHaveLength(0);
  expect(f.fake.store.get(`${BREAK_DEPLOYMENTS}/${f.id}`)?.signedTransaction).toBeUndefined();
});
test.each(['factory', 'proof', 'simulation'])('refuses %s substitution with a valid owner signature', async mode => {
  await expect(checkBreakDeployment(request, port(mode))).rejects.toThrow();
});
test('changing the intended account, root, amount or identity invalidates the real owner signature', async () => {
  for (const patch of [{ account: a(99) }, { initialRoot: h(99) }, { amount: '101' }, { identity: h(99) }, { recoverySecret: h(99) }]) {
    await expect(checkBreakDeployment({ ...request, ...patch }, port())).rejects.toThrow('owner_proof_invalid');
  }
  await expect(checkBreakDeployment({ ...request, proof: [], admin: true }, port())).rejects.toThrow('request_invalid');
});

function replacementRequest(overrides: Partial<ReplacementDeploymentRequest> = {}): ReplacementDeploymentRequest {
  const { amount: _amount, proof: _proof, ...common } = request;
  const replacement: ReplacementDeploymentRequest = { ...common, kind: 'replacement', kernel: a(1), revision: '4', nonce: 1, ...overrides };
  const signature = execFileSync(process.execPath, ['--input-type=module', '-e',
    "import {slh_dsa_sha2_128s as s} from '@noble/post-quantum/slh-dsa.js'; const k=s.keygen(new Uint8Array(48).fill(1)); console.log('0x'+Buffer.from(s.sign(Buffer.from(process.argv[1].slice(2),'hex'),k.secretKey,{extraEntropy:false})).toString('hex'));", replacementDeploymentDigest(replacement)], { encoding: 'utf8' }).trim();
  return { ...replacement, signature };
}
test('replacement deployment requires current independent owner authority and refuses retired, replayed or same-account requests', async () => {
  const replacement = replacementRequest();
  expect(await checkBreakDeployment(replacement, port('replacement'))).toMatchObject({executor:a(4),gasPayer:LANE,alreadyDeployed:false});
  await expect(checkBreakDeployment(replacement, port('replacement-nonce'))).rejects.toThrow('owner_changed');
  await expect(checkBreakDeployment(replacement, port('replacement-destination'))).rejects.toThrow('destination_invalid');
  await expect(checkBreakDeployment(replacementRequest({revision:'3'}),port('replacement'))).rejects.toThrow('retired');
  await expect(checkBreakDeployment(replacement,port('valid'))).rejects.toThrow('owner_changed');
  await expect(checkBreakDeployment({...replacement,account:a(6)},port('replacement'))).rejects.toThrow('owner_proof_invalid');
});
test('one sponsored replacement destination is retained per authorization nonce without blocking a later recovery', async () => {
  const db=createFakeFirestore() as unknown as Firestore;
  const first=replacementRequest();await queueBreakDeployment(db,first,port('replacement'));
  const other=replacementRequest({initialRoot:h(88),account:a(6)});
  await expect(queueBreakDeployment(db,other,port('replacement'))).rejects.toThrow('destination_selected');
  const later=replacementRequest({initialRoot:h(88),account:a(6),nonce:2});
  expect(await queueBreakDeployment(db,later,port('replacement-nonce'))).toMatchObject({status:'queued'});
});

test('replacement keeps a signed attempt across owner advance but closes an obsolete unsigned one', async () => {
 const signed=await workerFixture(true);
 signed.base.state.failBroadcasts=1;
 await signed.run();
 const raw=String(signed.fake.store.get(`${BREAK_DEPLOYMENTS}/${signed.id}`)!.signedTransaction);
 signed.ports.check.mockClear();signed.ports.check.mockImplementation(async()=>{throw Error('break_deployment_owner_changed');});
 expect(await signed.run()).toMatchObject({signed:0,open:1});
 expect(signed.signer.signTransaction).toHaveBeenCalledTimes(1);expect(signed.base.state.broadcasts).toEqual([raw]);expect(signed.ports.check).not.toHaveBeenCalled();
 signed.confirm();
 expect(await signed.run()).toMatchObject({confirmed:1});
 const unsigned=await workerFixture(true);
 unsigned.signer.signTransaction.mockRejectedValueOnce(Error('signer_crashed'));
 await unsigned.run();
 unsigned.ports.check.mockImplementation(value=>checkBreakDeployment(value,port('replacement-nonce')));
 expect(await unsigned.run()).toMatchObject({failed:1,closedUnsigned:1});
 expect(unsigned.base.state.broadcasts).toHaveLength(0);expect(unsigned.lane()).toMatchObject({next_nonce:0,open:{}});
});
