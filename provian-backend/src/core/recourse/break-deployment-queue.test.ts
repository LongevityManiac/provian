import { execFileSync } from 'node:child_process';
import { AbiCoder, Interface, concat, sha256, Wallet, keccak256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { acquireSignerLease, SETTLEMENT_SIGNER_LEASES_COLLECTION, type SettlementDb } from '../pvt/settlement/durable-settlement-store';
import { executeBreakDeployment, type BreakDeploymentSigner, type BreakDeploymentWorkerPorts } from './break-deployment-worker';
import { BREAK_REGISTRATIONS, checkBreakRegistration, assertCheckedBreakRegistration, queueBreakRegistration,
  executeBreakRegistration } from './break-registration';
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
  expect(plan).toMatchObject({ executor: a(4), gasPayer: a(13), alreadyDeployed: false, id: breakDeploymentDigest(request) });
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
test('registration worker persists the exact proof call before broadcast and never signs twice on retry', async () => {
  const wallet = new Wallet(`0x${'12'.repeat(32)}`), address = wallet.address.toLowerCase();
  const fake = createFakeFirestore({ strictTransactionOrder: true }), db = fake as unknown as Firestore;
  const chain = port('registration', address), value = { deployment: request, kernel: a(1) };
  const queued = await queueBreakRegistration(db, value, chain);
  const signer = { address,
    sign: jest.fn((plan: Awaited<ReturnType<typeof checkBreakRegistration>>) => wallet.signTransaction({ chainId: 8453,
      type: 2, nonce: 5, to: plan.executor, data: plan.calldata, value: 0, gasLimit: 3_000_000, maxFeePerGas: 2, maxPriorityFeePerGas: 1 })),
    broadcast: jest.fn(async (raw: string) => {
      expect(fake.store.get(`${BREAK_REGISTRATIONS}/${queued.id}`)?.signedTransaction).toBe(raw); return keccak256(raw);
    }) };
  const ports = { check: (input: unknown) => checkBreakRegistration(input, chain), finalized: jest.fn(async () => null) };
  expect(await executeBreakRegistration(db, queued.id, signer, ports)).toBe('submitted');
  expect(await executeBreakRegistration(db, queued.id, signer, ports)).toBe('submitted');
  expect(signer.sign).toHaveBeenCalledTimes(1);
});

async function workerFixture(replacement = false) {
  const wallet = new Wallet(`0x${'12'.repeat(32)}`), address = wallet.address.toLowerCase();
  const fake = createFakeFirestore({ strictTransactionOrder: true }), db = fake as unknown as Firestore;
  const chain = port(replacement ? 'replacement' : 'valid', address), queued = await queueBreakDeployment(db, replacement ? replacementRequest() : request, chain);
  const signer: BreakDeploymentSigner = { address,
    sign: jest.fn(plan => wallet.signTransaction({ chainId: 8453, type: 2, nonce: 3, to: plan.executor, data: plan.calldata,
      value: 0, gasLimit: 3_000_000, maxFeePerGas: 2, maxPriorityFeePerGas: 1 })),
    broadcast: jest.fn(async raw => {
      expect(fake.store.get(`${BREAK_DEPLOYMENTS}/${queued.id}`)?.signedTransaction).toBe(raw);
      expect(fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${address}`)?.pending_operation).toBe(queued.id);
      return keccak256(raw);
    }) };
  const ports: BreakDeploymentWorkerPorts = { check: value => checkBreakDeployment(value, chain), finalized: jest.fn(async () => null) };
  return { db, fake, signer, ports, id: queued.id, wallet };
}
test('deployment retries retain one signed nonce and finish only after independent finality', async () => {
  const { db, fake, signer, ports, id } = await workerFixture();
  expect(await executeBreakDeployment(db, id, signer, ports)).toBe('submitted');
  expect(await executeBreakDeployment(db, id, signer, ports)).toBe('submitted');
  expect(signer.sign).toHaveBeenCalledTimes(1); expect(signer.broadcast).toHaveBeenCalledTimes(2);
  const row = fake.store.get(`${BREAK_DEPLOYMENTS}/${id}`)!;
  (ports.finalized as jest.Mock).mockResolvedValue({ transactionHash: row.transactionHash, blockHash: h(40), block: 100, status: 1 });
  expect(await executeBreakDeployment(db, id, signer, ports)).toBe('confirmed');
  expect(fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${signer.address}`)?.pending_operation).toBe(null);
  expect(signer.sign).toHaveBeenCalledTimes(1); expect(signer.broadcast).toHaveBeenCalledTimes(2);
});
test('a lost broadcast response resumes identical persisted bytes, and a final revert consumes the reservation', async () => {
  const { db, fake, signer, ports, id } = await workerFixture();
  (signer.broadcast as jest.Mock).mockRejectedValueOnce(Error('response_lost'));
  await expect(executeBreakDeployment(db, id, signer, ports)).rejects.toThrow('response_lost');
  const raw = fake.store.get(`${BREAK_DEPLOYMENTS}/${id}`)!.signedTransaction;
  expect(await executeBreakDeployment(db, id, signer, ports)).toBe('submitted');
  expect(signer.broadcast).toHaveBeenLastCalledWith(raw); expect(signer.sign).toHaveBeenCalledTimes(1);
  (ports.finalized as jest.Mock).mockResolvedValue({ transactionHash: keccak256(String(raw)), blockHash: h(40), block: 100, status: 0 });
  expect(await executeBreakDeployment(db, id, signer, ports)).toBe('failed');
  expect(fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${signer.address}`)?.pending_operation).toBe(null);
  await expect(queueBreakDeployment(db, request, port('valid', signer.address), async () => null)).rejects.toThrow('retry_unreconciled');
  expect(await queueBreakDeployment(db, request, port('valid', signer.address), ports.finalized)).toMatchObject({ status: 'queued', transactionHash: null });
  expect(fake.store.get(`${BREAK_DEPLOYMENT_ATTEMPTS}/${id}_${keccak256(String(raw))}`)).toMatchObject({
    signedTransaction: raw, transactionHash: keccak256(String(raw)), status: 'finalized_revert' });
  expect(fake.store.get(`${BREAK_DEPLOYMENTS}/${id}`)?.signedTransaction).toBeUndefined();
});
test('an unfinalized receipt retains the reservation and never signs another transaction', async () => {
  const { db, fake, signer, ports, id } = await workerFixture();
  await executeBreakDeployment(db, id, signer, ports);
  (ports.finalized as jest.Mock).mockRejectedValue(Error('recourse_transaction_not_finalized'));
  expect(await executeBreakDeployment(db, id, signer, ports)).toBe('submitted');
  expect(fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${signer.address}`)?.pending_operation).toBe(id);
  expect(signer.sign).toHaveBeenCalledTimes(1); expect(signer.broadcast).toHaveBeenCalledTimes(1);
});
test('another reserved operation cannot share the gas nonce', async () => {
  const { db, fake, signer, ports, id } = await workerFixture();
  fake.store.set(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${signer.address}`, { pending_operation: h(99), expires_at_ms: 0 });
  await expect(executeBreakDeployment(db, id, signer, ports)).rejects.toThrow('signer_busy');
  expect(signer.sign).not.toHaveBeenCalled(); expect(signer.broadcast).not.toHaveBeenCalled();
});
test('a crash after reservation can retire an unsigned obsolete plan without blocking settlement', async () => {
  const { db, fake, signer, ports, id } = await workerFixture();
  (signer.sign as jest.Mock).mockRejectedValueOnce(Error('signer_crashed'));
  await expect(executeBreakDeployment(db, id, signer, ports)).rejects.toThrow('signer_crashed');
  expect(fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${signer.address}`)?.pending_operation).toBe(id);
  expect(fake.store.get(`${BREAK_DEPLOYMENTS}/${id}`)?.signedTransaction).toBeUndefined();
  ports.check = jest.fn(async () => { throw Error('break_deployment_retired'); });
  expect(await executeBreakDeployment(db, id, signer, ports)).toBe('failed');
  expect(await acquireSignerLease(db as unknown as SettlementDb, { signer: signer.address, workerId: 'settlement', nowMs: Date.now(), leaseTtlMs: 120_000 })).toMatchObject({ kind: 'acquired' });
  expect(signer.broadcast).not.toHaveBeenCalled();
});
test('one break entitlement cannot sponsor multiple destinations, but an obsolete unsigned choice is replaceable', async () => {
  const { db, fake, signer, id } = await workerFixture();
  const alternative = { ...request, initialRoot: h(99), account: a(6) };
  alternative.signature = execFileSync(process.execPath, ['--input-type=module', '-e',
    "import {slh_dsa_sha2_128s as s} from '@noble/post-quantum/slh-dsa.js'; const k=s.keygen(new Uint8Array(48).fill(1)); console.log('0x'+Buffer.from(s.sign(Buffer.from(process.argv[1].slice(2),'hex'),k.secretKey,{extraEntropy:false})).toString('hex'));", breakDeploymentDigest(alternative)], { encoding: 'utf8' }).trim();
  const chain = port('valid', signer.address);
  await expect(queueBreakDeployment(db, alternative, chain)).rejects.toThrow('destination_selected');
  const old = fake.store.get(`${BREAK_DEPLOYMENTS}/${id}`)!;
  fake.store.set(`${BREAK_DEPLOYMENTS}/${id}`, { ...old, status: 'failed', signedTransaction: '0x12' });
  await expect(queueBreakDeployment(db, alternative, chain)).rejects.toThrow('destination_selected');
  fake.store.set(`${BREAK_DEPLOYMENTS}/${id}`, { ...old, status: 'failed' });
  expect(await queueBreakDeployment(db, alternative, chain)).toMatchObject({ id: breakDeploymentDigest(alternative), status: 'queued' });
});
test.each(['target', 'value', 'data', 'chain'])('a signer cannot substitute %s in a sponsored deployment', async field => {
  const { db, signer, ports, id, wallet } = await workerFixture();
  (signer.sign as jest.Mock).mockImplementation(plan => wallet.signTransaction({ chainId: field === 'chain' ? 1 : 8453,
    type: 2, nonce: 3, to: field === 'target' ? a(99) : plan.executor, data: field === 'data' ? '0x' : plan.calldata,
    value: field === 'value' ? 1 : 0, gasLimit: 3_000_000, maxFeePerGas: 2, maxPriorityFeePerGas: 1 }));
  await expect(executeBreakDeployment(db, id, signer, ports)).rejects.toThrow('signed_mismatch');
  expect(signer.broadcast).not.toHaveBeenCalled();
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
  expect(await checkBreakDeployment(replacement, port('replacement'))).toMatchObject({executor:a(4),gasPayer:a(13),alreadyDeployed:false});
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

test('replacement worker keeps a signed attempt across owner advance but releases an obsolete unsigned reservation', async () => {
 const signed=await workerFixture(true);
 (signed.signer.broadcast as jest.Mock).mockRejectedValueOnce(Error('response_lost'));
 await expect(executeBreakDeployment(signed.db,signed.id,signed.signer,signed.ports)).rejects.toThrow('response_lost');
 const raw=String(signed.fake.store.get(`${BREAK_DEPLOYMENTS}/${signed.id}`)!.signedTransaction);
 signed.ports.check=jest.fn(async()=>{throw Error('break_deployment_owner_changed');});
 expect(await executeBreakDeployment(signed.db,signed.id,signed.signer,signed.ports)).toBe('submitted');
 expect(signed.signer.sign).toHaveBeenCalledTimes(1);expect(signed.signer.broadcast).toHaveBeenLastCalledWith(raw);expect(signed.ports.check).not.toHaveBeenCalled();
 (signed.ports.finalized as jest.Mock).mockResolvedValue({transactionHash:keccak256(raw),blockHash:h(40),block:100,status:1});
 expect(await executeBreakDeployment(signed.db,signed.id,signed.signer,signed.ports)).toBe('confirmed');
 const unsigned=await workerFixture(true);
 (unsigned.signer.sign as jest.Mock).mockRejectedValueOnce(Error('signer_crashed'));
 await expect(executeBreakDeployment(unsigned.db,unsigned.id,unsigned.signer,unsigned.ports)).rejects.toThrow('signer_crashed');
 unsigned.ports.check=value=>checkBreakDeployment(value,port('replacement-nonce',unsigned.signer.address));
 expect(await executeBreakDeployment(unsigned.db,unsigned.id,unsigned.signer,unsigned.ports)).toBe('failed');
 expect(unsigned.signer.broadcast).not.toHaveBeenCalled();expect(unsigned.fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${unsigned.signer.address}`)?.pending_operation).toBeNull();
});
