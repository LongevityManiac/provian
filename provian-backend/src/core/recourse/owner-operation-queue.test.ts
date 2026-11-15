import { RESTORATION_REQUESTS } from './restoration-request';
import { AbiCoder, concat, sha256, Wallet, keccak256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import type { ProtocolDeployment } from '../protocol/pointer';
import { OWNER_EXECUTOR_ABI, OWNER_KERNEL_ABI, ownerOperationIntent, parseRecoveryOwnerOperation,
  recoveryOperationCall, recoveryOperationId, type RecoveryOwnerOperation } from './owner-operation';
import { queueOwnerOperation, checkOwnerOperation, assertCheckedOwnerOperation, OWNER_OPERATIONS, OWNER_SPONSOR_ABI, type OwnerOperationChain } from './owner-operation-queue';
import { RECOURSE_COLLECTIONS } from './ownership';
import { executeOwnerOperation, type OwnerOperationSigner, type OwnerOperationWorkerPorts } from './owner-operation-worker';
import { acquireSignerLease, SETTLEMENT_SIGNER_LEASES_COLLECTION, SETTLEMENT_BATCHES_COLLECTION,
  SETTLEMENT_BATCH_SCHEMA, SETTLEMENT_CYCLES_COLLECTION, type SettlementDb } from '../pvt/settlement/durable-settlement-store';
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
      expect(call.to).toBe(address('cc')); expect(call.from).toBe(options.gasPayer ?? address('dd'));
      if (options.denied) throw new Error('onchain_hash_proof_refused');
      return '0x';
    }
    const values: Record<string, readonly unknown[]> = {
      ownerAuthorization: [address('cc')], operationalMinter: [address('ee')], submitter:[options.gasPayer ?? address('dd')],kernel:[op.kernel],pool:[address('ff')],
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
  expect(fake.store.get(`${OWNER_OPERATIONS}/${result.id}`)).toMatchObject({ operation: op, executor: address('cc'), gasPayer: address('dd') });
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

function workerFixture(restoration?: RecoveryOwnerOperation['restoration']) {
  // Public deterministic test key, never a deployment signer.
  const wallet = new Wallet(`0x${'12'.repeat(32)}`);
  const context = fixture({ gasPayer: wallet.address.toLowerCase(), restoration });
  const signer: OwnerOperationSigner = { address: wallet.address.toLowerCase(),
    sign: jest.fn(plan => wallet.signTransaction({ type: 2, chainId: 8453, nonce: 3, to: plan.executor,
      data: plan.calldata, value: 0, gasLimit: 3_000_000, maxFeePerGas: 2, maxPriorityFeePerGas: 1 })),
    broadcast: jest.fn(async raw => keccak256(raw)) };
  const ports: OwnerOperationWorkerPorts = { check: op => checkOwnerOperation(op, context.port),
    finalized: jest.fn(async () => null),
    verify: jest.fn(async () => { throw new Error('recourse_authorization_receipt_missing'); }) };
  return { ...context, signer, ports };
}
test('crash after persistence keeps the nonce reserved across lease expiry and retries identical bytes', async () => {
  const { op, port, fake, db, signer, ports } = workerFixture();
  const { id } = await queueOwnerOperation(db, op, port);
  (signer.broadcast as jest.Mock).mockRejectedValueOnce(new Error('connection_lost'));
  await expect(executeOwnerOperation(db, id, signer, ports)).rejects.toThrow('connection_lost');
  const persisted = fake.store.get(`${OWNER_OPERATIONS}/${id}`)!;
  expect(persisted.status).toBe('submitted');
  expect(persisted.signedTransaction).toBeTruthy();
  expect(await acquireSignerLease(fake as unknown as SettlementDb, { signer: signer.address, workerId: 'settlement',
    nowMs: Date.now() + 1_000_000, leaseTtlMs: 120_000 })).toMatchObject({ kind: 'refused', reason: 'operation_reserved' });
  await expect(executeOwnerOperation(db, hash('99'), signer, ports)).rejects.toThrow('signer_busy');
  expect(await executeOwnerOperation(db, id, signer, ports)).toBe('submitted');
  expect(signer.sign).toHaveBeenCalledTimes(1);
  expect(signer.broadcast).toHaveBeenNthCalledWith(2, persisted.signedTransaction);
  (ports.verify as jest.Mock).mockResolvedValueOnce({});
  (ports.finalized as jest.Mock).mockResolvedValueOnce({ status: 1 });
  expect(await executeOwnerOperation(db, id, signer, ports)).toBe('confirmed');
  expect(fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${signer.address}`)?.pending_operation).toBeNull();
  expect(await acquireSignerLease(fake as unknown as SettlementDb, { signer: signer.address, workerId: 'settlement',
    nowMs: Date.now(), leaseTtlMs: 120_000 })).toMatchObject({ kind: 'acquired' });
});
test('crash before signature persistence still reserves the exact operation', async () => {
  const { op, port, fake, db, signer, ports } = workerFixture();
  const { id } = await queueOwnerOperation(db, op, port);
  (signer.sign as jest.Mock).mockRejectedValueOnce(new Error('signer_disconnected'));
  await expect(executeOwnerOperation(db, id, signer, ports)).rejects.toThrow('signer_disconnected');
  expect(fake.store.get(`${OWNER_OPERATIONS}/${id}`)?.status).toBe('queued');
  expect(fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${signer.address}`)?.pending_operation).toBe(id);
  await expect(executeOwnerOperation(db, hash('99'), signer, ports)).rejects.toThrow('signer_busy');
  expect(await executeOwnerOperation(db, id, signer, ports)).toBe('submitted');
});
test.each(['same', 'missing'])('unbroadcast settlement reservation blocks recovery signing: %s', async kind => {
  const { op, port, fake, db, signer, ports } = workerFixture();
  const { id } = await queueOwnerOperation(db, op, port);
  fake.store.set(`${SETTLEMENT_BATCHES_COLLECTION}/batch`, { schema_version: SETTLEMENT_BATCH_SCHEMA,
    status: 'reserved', cycle_id: 'cycle', reserved_nonce: 3, cursor_start: '0' });
  if (kind === 'same') fake.store.set(`${SETTLEMENT_CYCLES_COLLECTION}/cycle`, { signer: signer.address });
  await expect(executeOwnerOperation(db, id, signer, ports)).rejects.toThrow('settlement_reserved');
  expect(signer.sign).not.toHaveBeenCalled();
});
test('tampered persisted transaction is never broadcast and never releases the nonce', async () => {
  const { op, port, fake, db, signer, ports } = workerFixture();
  const { id } = await queueOwnerOperation(db, op, port);
  await executeOwnerOperation(db, id, signer, ports);
  const row = fake.store.get(`${OWNER_OPERATIONS}/${id}`)!;
  fake.store.set(`${OWNER_OPERATIONS}/${id}`, { ...row, transactionHash: hash('99') });
  await expect(executeOwnerOperation(db, id, signer, ports)).rejects.toThrow('hash_mismatch');
  expect(signer.broadcast).toHaveBeenCalledTimes(1);
  expect(fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${signer.address}`)?.pending_operation).toBe(id);
});
test.each([0, 1])('finalized outcome %s releases the consumed nonce even when authorization is no longer current', async status => {
  const { op, port, fake, db, signer, ports } = workerFixture();
  const { id } = await queueOwnerOperation(db, op, port);
  await executeOwnerOperation(db, id, signer, ports);
  (ports.finalized as jest.Mock).mockResolvedValue({ status });
  (ports.verify as jest.Mock).mockRejectedValue(new Error('recourse_authorization_superseded'));
  expect(await executeOwnerOperation(db, id, signer, ports)).toBe(status ? 'confirmed' : 'failed');
  expect(fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${signer.address}`)?.pending_operation).toBeNull();
  expect(signer.broadcast).toHaveBeenCalledTimes(1);
});
test('retired unsigned operation can release its reservation; signed unresolved bytes cannot', async () => {
  const { op, port, fake, db, signer, ports } = workerFixture();
  const { id } = await queueOwnerOperation(db, op, port);
  (signer.sign as jest.Mock).mockRejectedValueOnce(new Error('signer_disconnected'));
  await expect(executeOwnerOperation(db, id, signer, ports)).rejects.toThrow('signer_disconnected');
  ports.check = jest.fn(async () => { throw new Error('recourse_owner_operation_retired'); });
  expect(await executeOwnerOperation(db, id, signer, ports)).toBe('failed');
  expect(fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${signer.address}`)?.pending_operation).toBeNull();
  expect(signer.broadcast).not.toHaveBeenCalled();
});
test('a stale signed transaction keeps its reservation until a finalized receipt proves nonce consumption', async () => {
  const { op, port, fake, db, signer, ports } = workerFixture();
  const { id } = await queueOwnerOperation(db, op, port);
  await executeOwnerOperation(db, id, signer, ports);
  ports.check = jest.fn(async () => { throw new Error('recourse_owner_operation_retired'); });
  expect(await executeOwnerOperation(db, id, signer, ports)).toBe('submitted');
  expect(fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${signer.address}`)?.pending_operation).toBe(id);
  expect(signer.sign).toHaveBeenCalledTimes(1);
  expect(signer.broadcast).toHaveBeenCalledTimes(2);
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
  const { op, port, fake, db, signer, ports } = workerFixture(scope);
  const requestPath = `${RESTORATION_REQUESTS}/${scope.request}`;
  fake.store.set(requestPath, { identity: op.identity, snapshot: { kernel: op.kernel, addresses: [{address: address('ee')}] }, scope, status: 'prepared' });
  const first = await queueOwnerOperation(db, op, port);
  const next = fixture({ restoration: scope, gasPayer: signer.address, revision: 2n, operationRevision: '2', kernel: kernelChange ? address('12') : op.kernel });
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
  ports.check = async () => {throw new Error('recourse_owner_operation_retired');};
  expect(await executeOwnerOperation(db,first.id,signer,ports)).toBe('failed');
  expect(fake.store.get(requestPath)).toMatchObject({ status:'authorization_queued',ownerOperationId:second.id });
  expect(signer.sign).not.toHaveBeenCalled();
  expect(fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${signer.address}`)?.pending_operation).toBeNull();
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
  expect(await executeOwnerOperation(f.db,id,f.signer,f.ports)).toBe('confirmed');
  expect(executed).toHaveBeenCalledWith(f.op,address('cc'),hash('aa'));
  expect(f.signer.sign).not.toHaveBeenCalled();expect(f.signer.broadcast).not.toHaveBeenCalled();
  expect(f.fake.store.get(`${OWNER_OPERATIONS}/${id}`)).toMatchObject({status:'confirmed',transactionHash:hash('ea'),sponsoredTransactionHash:null});
});
test('an unfinalized external execution remains retryable and signed sponsor bytes retain their nonce until reconciled',async()=>{
  const f=workerFixture();const {id}=await queueOwnerOperation(f.db,f.op,f.port);
  await executeOwnerOperation(f.db,id,f.signer,f.ports);
  const sponsoredHash=f.fake.store.get(`${OWNER_OPERATIONS}/${id}`)!.transactionHash;
  (f.ports.finalized as jest.Mock).mockResolvedValue({status:0});
  f.ports.executed=jest.fn(async()=>{throw Error('recourse_authorization_not_finalized');});
  await expect(executeOwnerOperation(f.db,id,f.signer,f.ports)).rejects.toThrow('not_finalized');
  expect(f.fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${f.signer.address}`)?.pending_operation).toBe(id);
  f.ports.executed=async()=>({transactionHash:hash('ea'),superseded:true});
  expect(await executeOwnerOperation(f.db,id,f.signer,f.ports)).toBe('confirmed');
  expect(f.fake.store.get(`${OWNER_OPERATIONS}/${id}`)).toMatchObject({transactionHash:hash('ea'),sponsoredTransactionHash:sponsoredHash,terminalReason:'authorization_superseded'});
  expect(f.fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${f.signer.address}`)?.pending_operation).toBeNull();
  expect(f.signer.sign).toHaveBeenCalledTimes(1);
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
