import { RESTORATION_REQUESTS } from './restoration-request';
import { AbiCoder, concat, sha256, Wallet, keccak256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import type { ProtocolDeployment } from '../protocol/pointer';
import { OWNER_EXECUTOR_ABI, OWNER_KERNEL_ABI, ownerOperationIntent, parseRecoveryOwnerOperation,
  recoveryOperationCall, recoveryOperationId, type RecoveryOwnerOperation } from './owner-operation';
import { queueOwnerOperation, checkOwnerOperation, assertCheckedOwnerOperation, OWNER_OPERATIONS, OWNER_SPONSOR_ABI, type OwnerOperationChain } from './owner-operation-queue';
import { RECOURSE_COLLECTIONS } from './ownership';
import { ownerOperationLaneKind, type OwnerLanePorts } from './transaction-lane-kinds';
import { runRecourseLane, RECOURSE_LANE_COLLECTION } from './transaction-lane';
import { SETTLEMENT_SIGNER_LEASES_COLLECTION } from '../pvt/settlement/durable-settlement-store';
import { simulatedBase, laneTestWallet, LANE_TEST_KEY } from './__test-helpers__/lane-chain-fixture';
import { RECOURSE_GAS_KEY_ENV } from './transaction-lane-key';
process.env[RECOURSE_GAS_KEY_ENV] = LANE_TEST_KEY;
const LANE = laneTestWallet().address.toLowerCase();
const address = (byte: string) => `0x${byte.repeat(20)}`;
const hash = (byte: string) => `0x${byte.repeat(32)}`;
function operation(): RecoveryOwnerOperation {
  return { kernel: address('11'), destination: address('22'), identity: hash('33'), nonce: 0, revision: '1',
    proof: { recoverySecret: hash('44'), signingRoot: sha256(hash('55')), publicKey: hash('55'),
      signature: `0x${'66'.repeat(7856)}`, nextCommitment: hash('77'), nextSigningRoot: hash('88') } };
}
function fixture(options: { stale?: boolean; denied?: boolean; revision?: bigint; gasPayer?: string; restoration?: RecoveryOwnerOperation['restoration']; operationRevision?: string; kernel?: string } = {}) {
  const op = { ...operation(), ...(options.operationRevision ? { revision: options.operationRevision } : {}), ...(options.kernel ? { kernel: options.kernel } : {}), ...(options.restoration ? { restoration: options.restoration } : {}) };
  const deployment = { addresses: { kernel: op.kernel, settlement:address('ee'),recoursePool:address('ff') }, revision: options.revision ?? 1n,
    blockHash: hash('aa'), manifestHash: hash('bb') } as ProtocolDeployment;
  const port: OwnerOperationChain = { deployment: async () => deployment, agree: jest.fn(async (_method, args) => {
    const call = args[0] as { to: string; data: string; from?: string };
    expect(args[1]).toEqual({ blockHash: deployment.blockHash, requireCanonical: true });
    const abi = call.to === op.kernel ? OWNER_KERNEL_ABI : call.to === address('ee') ? OWNER_SPONSOR_ABI : OWNER_EXECUTOR_ABI;
    const parsed = abi.parseTransaction(call)!;
    if (parsed.name === 'execute') {
      expect(call.to).toBe(address('cc')); expect(call.from).toBe(options.gasPayer ?? LANE);
      if (options.denied) throw new Error('onchain_hash_proof_refused');
      return '0x';
    }
    const values: Record<string, readonly unknown[]> = {
      ownerAuthorization: [address('cc')], operationalMinter: [address('ee')], submitter:[address('dd')],kernel:[op.kernel],pool:[address('ff')],
      ownerAuthorizationNonce: [options.stale ? 1 : 0], ownerSigningRoot: [op.proof.signingRoot],
      ownerRecoveryCommitment: [sha256(concat([op.proof.recoverySecret, op.proof.signingRoot]))],
      ownerAuthorizationDigest: [ownerOperationIntent(op)],
    };
    return abi.encodeFunctionResult(parsed.name, values[parsed.name]);
  }) };
  const fake = createFakeFirestore({ strictTransactionOrder: true });
  fake.store.set(`${RECOURSE_COLLECTIONS.identities}/${op.identity}`, { identity: op.identity, recoveryCommitment:
    sha256(concat([op.proof.recoverySecret, op.proof.signingRoot])), signingRoot: op.proof.signingRoot });
  return { op, port, fake, db: fake as unknown as Firestore };
}
test('actual executor simulation and chain and identity state are required before queueing', async () => {
  const { op, port, fake, db } = fixture();
  const result = await queueOwnerOperation(db, op, port);
  expect(result).toEqual({ id: recoveryOperationId(op), status: 'queued', transactionHash: null });
  // Gas comes from the Recourse lane, not the settlement submitter (0xdd…).
  expect(fake.store.get(`${OWNER_OPERATIONS}/${result.id}`)).toMatchObject({ operation: op, executor: address('cc'), gasPayer: LANE });
  expect((port.agree as jest.Mock).mock.calls.some(([, args]) => (args[0] as { data: string }).data === recoveryOperationCall(op))).toBe(true);
  const calls = (port.agree as jest.Mock).mock.calls.length;
  expect(await queueOwnerOperation(db, op, port)).toEqual(result);
  expect(port.agree).toHaveBeenCalledTimes(calls);
});
test.each([{ denied: true }, { stale: true }, { revision: 2n }])('invalid proof, nonce or deployment cannot enter the signing queue: %p', async options => {
  const { op, port, fake, db } = fixture(options);
  await expect(queueOwnerOperation(db, op, port)).rejects.toThrow();
  expect([...fake.store.keys()].filter(key => key.startsWith(OWNER_OPERATIONS))).toHaveLength(0);
});
test('arbitrary payloads, amounts, unknown fields and substituted roots are structurally refused', () => {
  const op = operation();
  for (const change of [{ kind: 0 }, { payload: '0x' }, { sources: [address('aa')] }, { amount: '1' },
    { nonce: -1 }, { revision: '0' }, { proof: { ...op.proof, signingRoot: hash('aa') } },
    { proof: { ...op.proof, signature: '0x1234' } }]) {
    expect(() => parseRecoveryOwnerOperation({ ...op, ...change })).toThrow('recourse_owner_operation_invalid');
  }
});
test('a deserialized checked result has no gasPayer capability', async () => {
  const { op, port } = fixture();
  const result = await checkOwnerOperation(op, port);
  expect(() => assertCheckedOwnerOperation(result)).not.toThrow();
  expect(() => assertCheckedOwnerOperation({ ...result })).toThrow('unverified');
});
test('an unregistered binding cannot be queued even when chain simulation succeeds', async () => {
  const { op, port, fake, db } = fixture();
  fake.store.set(`${RECOURSE_COLLECTIONS.identities}/${op.identity}`, { recoveryCommitment: hash('aa'), signingRoot: op.proof.signingRoot });
  await expect(queueOwnerOperation(db, op, port)).rejects.toThrow('identity_invalid');
  expect([...fake.store.keys()].filter(key => key.startsWith(OWNER_OPERATIONS))).toHaveLength(0);
});

test('the lane key may not be the settlement submitter', async () => {
  const { op, port } = fixture();
  await expect(checkOwnerOperation(op, port, address('dd'))).rejects.toThrow('gas_payer_invalid');
});

function workerFixture(restoration?: RecoveryOwnerOperation['restoration']) {
  const context = fixture({ restoration }), wallet = laneTestWallet(), base = simulatedBase(wallet.address);
  const signer = { address: LANE, signTransaction: jest.fn((tx: Parameters<typeof wallet.signTransaction>[0]) => wallet.signTransaction(tx)) };
  const ports: OwnerLanePorts = { check: (op, _port, gas) => checkOwnerOperation(op, context.port, gas),
    verify: jest.fn(async () => { throw new Error('recourse_authorization_receipt_missing'); }),
    executed: jest.fn(async () => null) };
  const run = (fence?: () => Promise<void>) => runRecourseLane({ db: context.db, signer, chain: base,
    kinds: [ownerOperationLaneKind(context.db, ports)], workerId: `w-${Math.random()}`, fence, now: base.now }, base.now() + 5_000);
  const lane = () => context.fake.store.get(`${RECOURSE_LANE_COLLECTION}/${LANE}`);
  const confirm = () => { base.mine(); base.advance(11); };
  return { ...context, signer, ports, base, run, lane, confirm };
}
test('crash after persistence keeps the nonce reserved and retries identical bytes', async () => {
  const f = workerFixture();
  const { id } = await queueOwnerOperation(f.db, f.op, f.port);
  f.base.state.failBroadcasts = 1;
  expect(await f.run()).toMatchObject({ signed: 1, stopReason: 'recourse_lane_broadcast_failed' });
  const persisted = f.fake.store.get(`${OWNER_OPERATIONS}/${id}`)!;
  expect(persisted).toMatchObject({ status: 'submitted', laneNonce: 0, gasPayer: LANE });
  expect(f.lane()).toMatchObject({ next_nonce: 1, open: { 0: { collection: OWNER_OPERATIONS, id } } });
  expect(await f.run()).toMatchObject({ signed: 0 });
  expect(f.signer.signTransaction).toHaveBeenCalledTimes(1);
  expect(f.base.state.broadcasts).toEqual([persisted.signedTransaction]);
  (f.ports.verify as jest.Mock).mockResolvedValueOnce({});
  f.confirm();
  expect(await f.run()).toMatchObject({ confirmed: 1 });
  expect(f.fake.store.get(`${OWNER_OPERATIONS}/${id}`)).toMatchObject({ status: 'confirmed', terminalReason: 'authorization_finalized' });
  expect(f.lane()?.open).toEqual({});
});
test('a signer failure before persistence leaves the operation queued and its nonce unallocated', async () => {
  const f = workerFixture();
  const { id } = await queueOwnerOperation(f.db, f.op, f.port);
  f.signer.signTransaction.mockRejectedValueOnce(new Error('signer_disconnected'));
  expect(await f.run()).toMatchObject({ signed: 0, stopReason: 'recourse_lane_sign_failed' });
  expect(f.fake.store.get(`${OWNER_OPERATIONS}/${id}`)?.status).toBe('queued');
  expect(f.lane()).toMatchObject({ next_nonce: 0, open: {} });
  expect(await f.run()).toMatchObject({ signed: 1 });
  expect(f.fake.store.get(`${OWNER_OPERATIONS}/${id}`)).toMatchObject({ status: 'submitted', laneNonce: 0 });
});
test('the lane never reads or writes a settlement signer lease, and a role fence stops signing', async () => {
  const f = workerFixture();
  const { id } = await queueOwnerOperation(f.db, f.op, f.port);
  f.fake.store.set(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${address('dd')}`, { owner: 'settlement', expires_at_ms: Date.now() + 60_000, pending_operation: 'batch' });
  expect(await f.run(async () => { throw Error('recourse_lane_key_shared'); })).toMatchObject({ signed: 0, stopReason: 'recourse_lane_key_shared' });
  expect(f.fake.store.get(`${OWNER_OPERATIONS}/${id}`)?.status).toBe('queued');
  expect(await f.run()).toMatchObject({ signed: 1 });
  expect(f.fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${address('dd')}`)).toEqual({ owner: 'settlement',
    expires_at_ms: expect.any(Number), pending_operation: 'batch' });
  expect(f.fake.store.has(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${LANE}`)).toBe(false);
});
test('tampered persisted transaction is never broadcast and never releases the nonce', async () => {
  const f = workerFixture();
  const { id } = await queueOwnerOperation(f.db, f.op, f.port);
  await f.run();
  const row = f.fake.store.get(`${OWNER_OPERATIONS}/${id}`)!;
  f.fake.store.set(`${OWNER_OPERATIONS}/${id}`, { ...row, transactionHash: hash('99') });
  f.base.state.inclusionFloor = 10n ** 30n; f.base.advance(12);
  const report = await f.run();
  expect(report.errors).toContain('recourse_lane_record_invalid:0');
  expect(f.base.state.broadcasts).toHaveLength(1);
  expect(f.lane()?.open).toEqual({ 0: { collection: OWNER_OPERATIONS, id } });
});
test.each([0, 1])('twelve-confirmation outcome %s releases the consumed nonce even when authorization is no longer current', async status => {
  const f = workerFixture();
  const { id } = await queueOwnerOperation(f.db, f.op, f.port);
  await f.run();
  f.base.state.status = () => status as 0 | 1;
  (f.ports.verify as jest.Mock).mockRejectedValue(new Error('recourse_authorization_superseded'));
  f.confirm();
  expect(await f.run()).toMatchObject(status ? { confirmed: 1 } : { failed: 1 });
  expect(f.fake.store.get(`${OWNER_OPERATIONS}/${id}`)?.status).toBe(status ? 'confirmed' : 'failed');
  expect(f.lane()?.open).toEqual({});
  expect(f.base.state.broadcasts).toHaveLength(1);
});
test('retired unsigned operation closes without a transaction; signed unresolved bytes do not', async () => {
  const f = workerFixture();
  const { id } = await queueOwnerOperation(f.db, f.op, f.port);
  f.ports.check = jest.fn(async () => { throw new Error('recourse_owner_operation_retired'); });
  expect(await f.run()).toMatchObject({ failed: 1, closedUnsigned: 1, signed: 0 });
  expect(f.fake.store.get(`${OWNER_OPERATIONS}/${id}`)).toMatchObject({ status: 'failed', terminalReason: 'recourse_owner_operation_retired' });
  expect(f.base.state.broadcasts).toHaveLength(0);
  expect(f.lane()).toMatchObject({ next_nonce: 0, open: {} });
});
test('a stale signed transaction keeps its nonce until a twelve-confirmation receipt proves consumption', async () => {
  const f = workerFixture();
  const { id } = await queueOwnerOperation(f.db, f.op, f.port);
  await f.run();
  f.ports.check = jest.fn(async () => { throw new Error('recourse_owner_operation_retired'); });
  // Not yet included after twelve blocks: the exact bytes are resent, never re-checked or re-signed.
  f.base.state.inclusionFloor = 10n ** 30n; f.base.advance(12);
  await f.run();
  expect(f.fake.store.get(`${OWNER_OPERATIONS}/${id}`)?.status).toBe('submitted');
  expect(f.lane()?.open).toEqual({ 0: { collection: OWNER_OPERATIONS, id } });
  expect(f.signer.signTransaction).toHaveBeenCalledTimes(1);
  expect(f.base.state.broadcasts).toHaveLength(2);
});

test('bounded owner scope is immutable and cannot queue without the independently prepared loss', async () => {
  const scope = { request: hash('ab'), lossHash: hash('ac'), maximumLoss: '100' };
  const { op, port, fake, db } = fixture({ restoration: scope });
  const decoded = OWNER_EXECUTOR_ABI.parseTransaction({ data: recoveryOperationCall(op) })!;
  expect(AbiCoder.defaultAbiCoder().decode(['uint8','bytes'], decoded.args.payload)[0]).toBe(3n);
  expect(recoveryOperationId(op)).not.toBe(recoveryOperationId({ ...op, restoration: { ...scope, maximumLoss: '101' } }));
  await expect(queueOwnerOperation(db, op, port)).rejects.toThrow('scope_unverified');
  const requestPath = `${RESTORATION_REQUESTS}/${scope.request}`;
  fake.store.set(requestPath, { identity: op.identity, snapshot: { kernel: op.kernel, addresses: [{ address: address('ee') }] }, scope: { ...scope, maximumLoss: '101' }, status: 'prepared' });
  await expect(queueOwnerOperation(db, op, port)).rejects.toThrow('scope_unverified');
  fake.store.set(requestPath, { identity: op.identity, snapshot: { kernel: op.kernel, addresses: [{ address: address('ee') }] }, scope, status: 'prepared' });
  const queued = await queueOwnerOperation(db, op, port);
  expect(fake.store.get(requestPath)).toMatchObject({ status: 'authorization_queued', destination: op.destination, ownerOperationId: queued.id });
  for (const changed of [{ ...scope, maximumLoss: '0' }, { ...scope, maximumLoss: (2n**256n).toString() }, { ...scope, sources: [] }]) {
    expect(() => parseRecoveryOwnerOperation({ ...op, restoration: changed })).toThrow('scope_invalid');
  }
});

test.each([false,true])('retired queued scope can follow a higher revision; historical kernel remains immutable (kernel change %s)', async kernelChange => {
  const scope = { request: hash('ab'), lossHash: hash('ac'), maximumLoss: '100' };
  const { op, port, fake, db, signer, ports, run } = workerFixture(scope);
  const requestPath = `${RESTORATION_REQUESTS}/${scope.request}`;
  fake.store.set(requestPath, { identity: op.identity, snapshot: { kernel: op.kernel, addresses: [{address: address('ee')}] }, scope, status: 'prepared' });
  const first = await queueOwnerOperation(db, op, port);
  const next = fixture({ restoration: scope, revision: 2n, operationRevision: '2', kernel: kernelChange ? address('12') : op.kernel });
  const originalAgree = next.port.agree;
  let parent = address('ed');
  next.port.agree = async (method,args) => {
    const call = args[0] as {to:string;data:string};
    if (kernelChange && call.to === op.kernel && call.data === OWNER_KERNEL_ABI.encodeFunctionData('ownerAuthorization')) return OWNER_KERNEL_ABI.encodeFunctionResult('ownerAuthorization',[address('ed')]);
    if (call.data === OWNER_EXECUTOR_ABI.encodeFunctionData('previousAuthorization')) return OWNER_EXECUTOR_ABI.encodeFunctionResult('previousAuthorization',[parent]);
    return originalAgree(method,args);
  };
  if(kernelChange) {
    parent = address('00');
    await expect(queueOwnerOperation(db,next.op,next.port)).rejects.toThrow('ancestry_invalid');
    parent = address('ed');
  }
  const second = await queueOwnerOperation(db,next.op,next.port);
  expect(second.id).not.toBe(first.id);
  expect(fake.store.get(requestPath)).toMatchObject({ ownerOperationId: second.id, snapshot: {kernel: op.kernel}, destination: op.destination });
  // Only the superseded operation is retired; its successor is checked against the new deployment.
  ports.check = async (value, _port, gas) => {
    if (recoveryOperationId(parseRecoveryOwnerOperation(value)) === first.id) throw new Error('recourse_owner_operation_retired');
    return checkOwnerOperation(value, next.port, gas);
  };
  await run();
  expect(fake.store.get(`${OWNER_OPERATIONS}/${first.id}`)?.status).toBe('failed');
  expect(fake.store.get(requestPath)).toMatchObject({ status:'authorization_queued',ownerOperationId:second.id });
  expect(fake.store.get(`${OWNER_OPERATIONS}/${second.id}`)).toMatchObject({ status:'submitted', laneNonce:0 });
  expect(signer.signTransaction).toHaveBeenCalledTimes(1);
});

test('sponsorship follows the verified settlement submitter and refuses mismatched kernel or pool wiring',async()=>{
  const f=fixture(), original=f.port.agree;
  let bad='kernel';
  f.port.agree=async(method,args)=>{
    const call=args[0] as {to:string;data:string};
    if(call.to===address('ee')&&call.data===OWNER_SPONSOR_ABI.encodeFunctionData(bad))return OWNER_SPONSOR_ABI.encodeFunctionResult(bad,[address('00')]);
    return original(method,args);
  };
  await expect(queueOwnerOperation(f.db,f.op,f.port)).rejects.toThrow('sponsor_binding_invalid');
  bad='pool';await expect(queueOwnerOperation(f.db,f.op,f.port)).rejects.toThrow('sponsor_binding_invalid');
  expect(f.fake.store.has(`${OWNER_OPERATIONS}/${recoveryOperationId(f.op)}`)).toBe(false);
});
test('external execution before sponsorship confirms the exact receipt without signing or spending sponsor gas',async()=>{
  const f=workerFixture();const {id}=await queueOwnerOperation(f.db,f.op,f.port);
  f.ports.check=async()=>{throw Error('recourse_owner_operation_stale');};
  const executed=jest.fn(async()=>({transactionHash:hash('ea'),superseded:false}));f.ports.executed=executed;
  expect(await f.run()).toMatchObject({confirmed:1,signed:0});
  expect(executed).toHaveBeenCalledWith(f.op,address('cc'),hash('aa'));
  expect(f.signer.signTransaction).not.toHaveBeenCalled();expect(f.base.state.broadcasts).toHaveLength(0);
  expect(f.fake.store.get(`${OWNER_OPERATIONS}/${id}`)).toMatchObject({status:'confirmed',transactionHash:hash('ea'),sponsoredTransactionHash:null});
});
test('an unconfirmed external execution remains retryable and signed sponsor bytes retain their nonce until reconciled',async()=>{
  const f=workerFixture();const {id}=await queueOwnerOperation(f.db,f.op,f.port);
  await f.run();
  const sponsoredHash=f.fake.store.get(`${OWNER_OPERATIONS}/${id}`)!.transactionHash;
  f.base.state.status=()=>0;f.confirm();
  f.ports.executed=jest.fn(async()=>{throw Error('recourse_authorization_not_finalized');});
  expect((await f.run()).errors).toContain('recourse_authorization_not_finalized:0');
  expect(f.lane()?.open).toEqual({0:{collection:OWNER_OPERATIONS,id}});
  f.ports.executed=async()=>({transactionHash:hash('ea'),superseded:true});
  expect(await f.run()).toMatchObject({confirmed:1});
  expect(f.fake.store.get(`${OWNER_OPERATIONS}/${id}`)).toMatchObject({transactionHash:hash('ea'),sponsoredTransactionHash:sponsoredHash,terminalReason:'authorization_superseded'});
  expect(f.lane()?.open).toEqual({});
  expect(f.signer.signTransaction).toHaveBeenCalledTimes(1);
});

test('a stale private commitment cannot veto current independently simulated recovery authority', async () => {
 const { op, port, fake, db } = fixture();
 fake.store.set(`${RECOURSE_COLLECTIONS.identities}/${op.identity}`, { identity: op.identity, recoveryCommitment: hash('aa'), signingRoot: hash('bb') });
 const result = await queueOwnerOperation(db, op, port);
 expect(result.status).toBe('queued');expect(fake.store.get(`${OWNER_OPERATIONS}/${result.id}`)?.identity).toBe(op.identity);
 const denied = fixture({denied:true});
 denied.fake.store.set(`${RECOURSE_COLLECTIONS.identities}/${op.identity}`, { identity: op.identity, recoveryCommitment: hash('aa'), signingRoot: hash('bb') });
 await expect(queueOwnerOperation(denied.db,denied.op,denied.port)).rejects.toThrow('onchain_hash_proof_refused');
});
