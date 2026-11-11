import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { prepareRestorationRequest, submitRestorationRequest, RESTORATION_REQUESTS, type RestorationEvidencePorts } from './restoration-request';
import { RECOURSE_COLLECTIONS } from './ownership';
import type { RecoursePoolState } from './pool-state';
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const identity = h(1), recoveryId = h(2), txHash = h(3), requestId = h(4);
const destination = `0x${'55'.repeat(20)}`, old = `0x${'66'.repeat(20)}`, kernel = `0x${'77'.repeat(20)}`;
function fixture() {
  const fake = createFakeFirestore({ strictTransactionOrder: true });
  fake.store.set(`${RECOURSE_COLLECTIONS.identities}/${identity}`, { recoveryGeneration: 1, recoveryCommitment: h(9) });
  fake.store.set(`${RECOURSE_COLLECTIONS.recoveries}/${recoveryId}`, { identity, destination, generation: 1, nextCommitment: h(9), authorizationTxHash: h(50) });
  fake.store.set(`${RECOURSE_COLLECTIONS.addresses}/${destination}`, { identity, address: destination, kernel,
    recoveryGeneration: 1, openingBalanceAtomic: '0', bindingDigest: h(10), boundBlock: 30, chainBindingStatus: 'confirmed' });
  fake.store.set(`${RECOURSE_COLLECTIONS.addresses}/${old}`, { identity, address: old, kernel,
    recoveryGeneration: 0, openingBalanceAtomic: '100', bindingDigest: h(11), boundBlock: 10, chainBindingStatus: 'confirmed' });
  const snapshot = jest.fn<ReturnType<RestorationEvidencePorts['snapshot']>, Parameters<RestorationEvidencePorts['snapshot']>>(async () => ({
    identity, kernel, transactionHash: txHash, block: 20, blockHash: h(20), firstOutflowLogIndex: 2,
    recordedBalanceAtomic: '100', lossAtomic: '100', addresses: [{ address: old, balanceAtomic: '100', bindingDigest: h(11) }],
    outflows: [], occurrence: requestId, evidenceHash: h(12),
  }));
  const ports: RestorationEvidencePorts = { snapshot, membership: async () => ({ active: true, periodIndex: 0,
    unpaidAtomic: '0', completedNonissuanceMonths: [], evidenceHash: h(13), lossTimestamp: 100 }),
    pool: async () => ({ outcomeRevision: '2' } as RecoursePoolState),
    ticket: async () => ({...(fake.store.get(`${RESTORATION_REQUESTS}/${requestId}`)?.scope as import('./owner-operation').RestorationScope),identity,destination,currentDestination:destination}) };
  return { fake, db: fake as unknown as Firestore, ports, snapshot,
    input: { transactionHash: txHash, block: 20, recoveryRequestId: recoveryId, restorationRequestId: requestId } };
}
test('loads the whole registry portfolio and deduplicates the observed occurrence', async () => {
  const { fake, db, input, ports, snapshot } = fixture();
  await prepareRestorationRequest(db, identity, input, ports);
  const key = `${RESTORATION_REQUESTS}/${requestId}`;
  fake.store.set(key, { ...fake.store.get(key), destination, authorizationTxHash: h(50), status: 'awaiting_determination' });
  expect(await submitRestorationRequest(db, identity, input, ports)).toEqual({ requestId, status: 'awaiting_determination' });
  expect(snapshot.mock.calls[0][3].map(binding => binding.address).sort()).toEqual([destination, old].sort());
  expect(await submitRestorationRequest(db, identity, input, ports)).toEqual({ requestId, status: 'awaiting_determination' });
  expect([...fake.store.keys()].filter(key => key.startsWith(`${RESTORATION_REQUESTS}/`))).toHaveLength(1);
  expect(fake.store.get(`${RESTORATION_REQUESTS}/${requestId}`)).toMatchObject({ observedOutcomeRevision: '2', destination,
    snapshot: { recordedBalanceAtomic: '100' }, status: 'awaiting_determination' });
});
test('foreign recovery and a known lapse before loss cannot produce an accepted request', async () => {
  const { fake, db, input, ports } = fixture();
  await expect(submitRestorationRequest(db, h(99), input, ports)).rejects.toThrow('recovery_required');
  await prepareRestorationRequest(db,identity,input,ports);
  const key=`${RESTORATION_REQUESTS}/${requestId}`;fake.store.set(key,{...fake.store.get(key),destination,authorizationTxHash:h(50),status:'awaiting_determination'});
  await expect(submitRestorationRequest(db, identity, input, { ...ports,
    membership: async () => ({ active: false, periodIndex: null, unpaidAtomic: '0',
      completedNonissuanceMonths: [], evidenceHash: h(13), lossTimestamp: 100 }) })).rejects.toThrow('not_member_at_loss');
  expect(fake.store.get(key)?.recoveryRequestId).toBeUndefined();
});
test('a concurrent recovery invalidates the stale destination before request persistence', async () => {
  const { fake, db, input, ports } = fixture();
  await prepareRestorationRequest(db, identity, input, ports);
  const key = `${RESTORATION_REQUESTS}/${requestId}`;
  fake.store.set(key, { ...fake.store.get(key), destination, authorizationTxHash: h(50), status: 'awaiting_determination' });
  await expect(submitRestorationRequest(db, identity, input, { ...ports, pool: async () => {
    fake.store.set(`${RECOURSE_COLLECTIONS.identities}/${identity}`, { recoveryGeneration: 2, recoveryCommitment: h(99) });
    return { outcomeRevision: '2' } as RecoursePoolState;
  } })).rejects.toThrow('identity_changed');
  expect(fake.store.get(key)?.recoveryRequestId).toBeUndefined();
});

test('ordinary credential recovery, unsigned preparation and a different authorization cannot create a theft request', async () => {
  const { fake, db, input, ports } = fixture();
  await expect(submitRestorationRequest(db, identity, input, ports)).rejects.toThrow('scope_unverified');
  await prepareRestorationRequest(db, identity, input, ports);
  await expect(submitRestorationRequest(db, identity, input, ports)).rejects.toThrow('scope_unverified');
  const key = `${RESTORATION_REQUESTS}/${requestId}`;
  fake.store.set(key, { ...fake.store.get(key), destination, authorizationTxHash: h(51), status: 'awaiting_determination' });
  await expect(submitRestorationRequest(db, identity, input, ports)).rejects.toThrow('scope_unverified');
  expect(fake.store.get(key)?.recoveryRequestId).toBeUndefined();
});

test('one-action preparation fixes the independently observed loss and admits no member-supplied amount', async () => {
  const { fake, db, input, ports, snapshot } = fixture();
  const scope = await prepareRestorationRequest(db, identity, input, ports);
  expect(scope).toMatchObject({ request: requestId, maximumLoss: '100', kernel });
  expect(scope.lossHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(snapshot.mock.calls[0][3]).toHaveLength(2);
  expect(fake.store.get(`${RESTORATION_REQUESTS}/${requestId}`)).toMatchObject({ status: 'prepared', scope: { maximumLoss: '100' } });
  expect(await prepareRestorationRequest(db, identity, input, ports)).toEqual(scope);
  await expect(prepareRestorationRequest(db, identity, input, { ...ports, snapshot: async (...args) => ({ ...await snapshot(...args), lossAtomic: '101' }) })).rejects.toThrow('conflict');
});
test('preparation rejects a lapse and zero-loss report before any owner operation', async () => {
  const { fake, db, input, ports, snapshot } = fixture();
  await expect(prepareRestorationRequest(db, identity, input, { ...ports, membership: async (...args) => ({ ...await ports.membership(...args), active: false }) })).rejects.toThrow('not_member_at_loss');
  await expect(prepareRestorationRequest(db, identity, input, { ...ports, snapshot: async (...args) => ({ ...await snapshot(...args), lossAtomic: '0' }) })).rejects.toThrow('scope_invalid');
  expect(fake.store.has(`${RESTORATION_REQUESTS}/${requestId}`)).toBe(false);
});

test('a later verified recovery carries the existing ticket to the new owner destination without another loss authorization',async()=>{
 const f=fixture();const prepared=await prepareRestorationRequest(f.db,identity,{transactionHash:txHash,block:20},f.ports);
 const key=`${RESTORATION_REQUESTS}/${requestId}`,priorDestination=`0x${'44'.repeat(20)}`;
 f.fake.store.set(key,{...f.fake.store.get(key),destination:priorDestination,authorizationTxHash:h(49),status:'awaiting_determination'});
 const ticket=jest.fn().mockResolvedValue({...prepared,identity,destination:priorDestination,currentDestination:destination});
 await expect(submitRestorationRequest(f.db,identity,f.input,{...f.ports,ticket})).resolves.toEqual({requestId,status:'awaiting_determination'});
 expect(f.fake.store.get(key)).toMatchObject({destination:priorDestination,authorizationTxHash:h(49),recoveryDestination:destination,recoveryRequestId:recoveryId});
 ticket.mockResolvedValue({...prepared,identity,destination:priorDestination,currentDestination:old});
 await expect(submitRestorationRequest(f.db,identity,f.input,{...f.ports,ticket})).rejects.toThrow('scope_unverified');
 ticket.mockResolvedValue({...prepared,identity,destination:priorDestination,currentDestination:destination,maximumLoss:'101'});
 await expect(submitRestorationRequest(f.db,identity,f.input,{...f.ports,ticket})).rejects.toThrow('scope_unverified');
});

test('submission preserves exact prior-kernel evidence across a break and checks the current imported ticket',async()=>{
 const f=fixture(),prepared=await prepareRestorationRequest(f.db,identity,f.input,f.ports),key=`${RESTORATION_REQUESTS}/${requestId}`;
 const retained=f.fake.store.get(key)!,priorDestination=`0x${'44'.repeat(20)}`;
 f.fake.store.set(key,{...retained,destination:priorDestination,authorizationTxHash:h(49),status:'awaiting_determination'});
 f.fake.store.get(`${RECOURSE_COLLECTIONS.addresses}/${destination}`)!.kernel=`0x${'88'.repeat(20)}`;
 f.snapshot.mockRejectedValue(Error('mixed_retired_current_bindings'));
 const ticket=jest.fn().mockResolvedValue({...prepared,identity,destination:priorDestination,currentDestination:destination});
 expect(await submitRestorationRequest(f.db,identity,f.input,{...f.ports,ticket})).toEqual({requestId,status:'awaiting_determination'});
 expect(f.snapshot).toHaveBeenCalledTimes(1);
 expect(ticket).toHaveBeenCalledWith(kernel,requestId);
 expect(f.fake.store.get(key)).toMatchObject({evidence:retained.evidence,snapshot:retained.snapshot,membership:retained.membership,scope:retained.scope});
 ticket.mockRejectedValue(Error('imported_ticket_absent'));
 await expect(submitRestorationRequest(f.db,identity,f.input,{...f.ports,ticket})).rejects.toThrow('imported_ticket_absent');
});
test('retained evidence tampering and a concurrent scope rewrite cannot complete submission',async()=>{
 for(const mode of ['bytes','snapshot','concurrent'] as const){
  const f=fixture();await prepareRestorationRequest(f.db,identity,f.input,f.ports);
  const key=`${RESTORATION_REQUESTS}/${requestId}`,row=f.fake.store.get(key)!;
  Object.assign(row,{destination,authorizationTxHash:h(50),status:'awaiting_determination'});
  if(mode==='bytes')row.evidence=String(row.evidence)+' ';
  if(mode==='snapshot')row.snapshot={...(row.snapshot as object),lossAtomic:'101'};
  const ports=mode==='concurrent'?{...f.ports,pool:async()=>{f.fake.store.set(key,{...row,evidence:String(row.evidence)+' '});return {outcomeRevision:'2'}as RecoursePoolState;}}:f.ports;
  await expect(submitRestorationRequest(f.db,identity,f.input,ports)).rejects.toThrow();
  expect(f.fake.store.get(key)?.recoveryRequestId).toBeUndefined();
 }
});

test('an exact surviving request remains selectable beside obsolete or prepared occurrences for the same transaction',async()=>{
 const f=fixture();await prepareRestorationRequest(f.db,identity,f.input,f.ports);
 const key=`${RESTORATION_REQUESTS}/${requestId}`,row=f.fake.store.get(key)!;
 Object.assign(row,{destination,authorizationTxHash:h(50),status:'awaiting_determination'});
 f.fake.store.set(`${RESTORATION_REQUESTS}/${h(99)}`,{...row,scope:{...(row.scope as object),request:h(99)},status:'prepared'});
 expect(await submitRestorationRequest(f.db,identity,f.input,f.ports)).toEqual({requestId,status:'awaiting_determination'});
 await expect(submitRestorationRequest(f.db,identity,{...f.input,restorationRequestId:h(99)},f.ports)).rejects.toThrow();
 await expect(submitRestorationRequest(f.db,identity,{...f.input,restorationRequestId:h(98)},f.ports)).rejects.toThrow('scope_unverified');
});
