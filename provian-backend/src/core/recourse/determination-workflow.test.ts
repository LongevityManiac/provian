import { assessRestoration } from './determination';
import { packetFixture } from './__test-helpers__/determination-fixture';
import { queueDetermination, runDeterminationWorkflow, DETERMINATION_WORKFLOWS, DETERMINATION_COORDINATION,
  type DeterminationWorkflowPort } from './determination-workflow';
import { recourseExecutionId, type RecourseExecutionCall } from './execution-transaction';

async function fixture() {
  const f = await packetFixture(), checked = assessRestoration(f.packet, f.judgment);
  await queueDetermination(f.db, checked);
  const plan = (kind: RecourseExecutionCall['kind']): RecourseExecutionCall => ({ kind,
    executor: `0x${'11'.repeat(20)}`, signer: `0x${'22'.repeat(20)}`, calldata: `0x${Buffer.from(kind).toString('hex')}`, manifestHash: `0x${'33'.repeat(32)}` });
  const completed = new Map<string, {status:'confirmed'; transactionHash:string}>();
  const port: DeterminationWorkflowPort = {
    recheck: jest.fn(async () => checked), prepare: jest.fn(async (_value, kind) => plan(kind)),
    recorded: jest.fn(async (_requests, kind) => plan(kind)),
    execute: jest.fn(async value => { const result = {status:'confirmed' as const, transactionHash:recourseExecutionId(value)}; completed.set(recourseExecutionId(value), result); return result; }),
    resume: jest.fn(async id => completed.get(id) ?? null), record: jest.fn(async () => {}),
  };
  return {...f, checked, port, completed, plan};
}
test('a lost execution response resumes the signed reversal and records one final result', async () => {
  const f = await fixture(), original = f.port.execute;
  f.port.execute = jest.fn(async plan => { const result = await original(plan); if (plan.kind === 'reverse') throw Error('response lost'); return result; });
  await expect(runDeterminationWorkflow(f.db,f.port)).rejects.toThrow('response lost');
  const row = f.fake.store.get(`${DETERMINATION_WORKFLOWS}/${f.ticket.request}`)!;
  expect(row.phase).toBe('attested'); expect(row.pending).toMatchObject({kind:'reverse'});
  f.port.execute = original;
  expect(await runDeterminationWorkflow(f.db,f.port)).toEqual({pending:false,completed:1});
  expect(f.port.prepare).toHaveBeenCalledTimes(2);
  expect(f.port.record).toHaveBeenCalledTimes(1);
  expect(f.fake.store.get(`${DETERMINATION_WORKFLOWS}/${f.ticket.request}`)?.phase).toBe('recorded');
  expect(await runDeterminationWorkflow(f.db,f.port)).toEqual({pending:false,completed:0});
});
test('all reversed requests in the durable cohort share one reserve allocation', async () => {
  const f = await fixture(), second = `0x${'55'.repeat(32)}`;
  const row = f.fake.store.get(`${DETERMINATION_WORKFLOWS}/${f.ticket.request}`)!;
  f.fake.store.set(`${DETERMINATION_WORKFLOWS}/${f.ticket.request}`,{...row,phase:'reversed',shortfall:'100'});
  f.fake.store.set(`${DETERMINATION_WORKFLOWS}/${second}`,{...row,request:second,phase:'reversed',shortfall:'200'});
  f.fake.store.set(f.path.replace(f.ticket.request,second),{...f.fake.store.get(f.path)});
  const original = f.port.execute;
  f.port.execute = jest.fn(async plan => plan.kind === 'allocate'
    ? {status:'submitted' as const,transactionHash:recourseExecutionId(plan)} : original(plan));
  expect(await runDeterminationWorkflow(f.db,f.port)).toEqual({pending:true,completed:0});
  expect(f.port.recorded).toHaveBeenCalledWith([f.ticket.request,second].sort(),'allocate');
  expect(f.port.record).not.toHaveBeenCalled();
  f.completed.set(recourseExecutionId(f.plan('allocate')),{status:'confirmed',transactionHash:recourseExecutionId(f.plan('allocate'))});
  f.port.execute = original;
  expect(await runDeterminationWorkflow(f.db,f.port)).toEqual({pending:false,completed:2});
  expect((f.port.recorded as jest.Mock).mock.calls.filter(call => call[1] === 'allocate')).toHaveLength(1);
});
test('a concurrent worker cannot split an active cohort or consume its reserve', async () => {
  const f = await fixture();
  f.fake.store.set(`${DETERMINATION_COORDINATION}/execution`,{owner:'other',expiresAtMs:Date.now()+60000,requests:[f.ticket.request]});
  await expect(runDeterminationWorkflow(f.db,f.port)).rejects.toThrow('worker_busy');
  expect(f.port.execute).not.toHaveBeenCalled();
});
test('a reverted transaction leaves the request for fresh evidence without blocking the next cohort', async () => {
  const f = await fixture();
  f.port.execute = jest.fn(async plan => ({status:'reverted' as const,transactionHash:recourseExecutionId(plan)}));
  expect(await runDeterminationWorkflow(f.db,f.port)).toEqual({pending:false,completed:0});
  expect(f.port.record).not.toHaveBeenCalled();
  expect(f.fake.store.get(f.path)?.status).toBe('under_determination');
  expect(f.fake.store.get(`${DETERMINATION_WORKFLOWS}/${f.ticket.request}`)?.phase).toBe('needs_review');
  expect(f.fake.store.get(`${DETERMINATION_COORDINATION}/execution`)?.requests).toEqual([]);
});

test('a missing owner mailbox key retains the outcome while releasing the monetary cohort', async () => {
  const f=await fixture();
  f.port.record=jest.fn(async()=>{throw Error('relay_act_owner_message_key_required');});
  expect(await runDeterminationWorkflow(f.db,f.port)).toEqual({pending:true,completed:0});
  expect(f.fake.store.get(`${DETERMINATION_COORDINATION}/execution`)?.requests).toEqual([]);
  expect(f.fake.store.get(`${DETERMINATION_WORKFLOWS}/${f.ticket.request}`)?.phase).toBe('delivered');
  const calls=(f.port.execute as jest.Mock).mock.calls.length;
  f.port.record=jest.fn(async()=>{});
  expect(await runDeterminationWorkflow(f.db,f.port)).toEqual({pending:false,completed:1});
  expect(f.port.execute).toHaveBeenCalledTimes(calls);
});

test('an already completed external withdrawal is recorded without signing another delivery',async()=>{
 const f=await fixture(),path=`${DETERMINATION_WORKFLOWS}/${f.ticket.request}`;
 f.fake.store.set(path,{...f.fake.store.get(path),phase:'allocated',shortfall:'100',transactions:{allocate:'allocation'}});
 f.port.delivered=jest.fn(async()=>({transactionHash:`0x${'77'.repeat(32)}`}));
 expect(await runDeterminationWorkflow(f.db,f.port)).toEqual({pending:false,completed:1});
 expect(f.port.execute).not.toHaveBeenCalled();
 expect(f.port.record).toHaveBeenCalledWith(f.ticket.request,{allocate:'allocation',deliver:`0x${'77'.repeat(32)}`});
});

test('fresh adjudication may replace a safely deferred finding but never an active execution',async()=>{
 const f=await fixture(),revised=assessRestoration(f.packet,{...f.judgment,reasoning:'Updated independently reviewed finding.'});
 await expect(queueDetermination(f.db,revised)).rejects.toThrow('already_queued');
 f.port.prepare=jest.fn(async()=>{throw Error('recourse_execution_stale');});
 await runDeterminationWorkflow(f.db,f.port);
 await queueDetermination(f.db,revised);
 expect(f.fake.store.get(`${DETERMINATION_WORKFLOWS}/${f.ticket.request}`)).toMatchObject({phase:'reviewed',pending:null,evidenceHash:revised.evidenceHash});
});

test('a lost membership-attestation response resumes before allocation without repeating reversal',async()=>{
 const f=await fixture(),original=f.port.execute;
 f.port.execute=jest.fn(async plan=>{const result=await original(plan);if(plan.kind==='eligibility')throw Error('response lost');return result;});
 await expect(runDeterminationWorkflow(f.db,f.port)).rejects.toThrow('response lost');
 expect(f.fake.store.get(`${DETERMINATION_WORKFLOWS}/${f.ticket.request}`)).toMatchObject({phase:'reversed',pending:{kind:'eligibility'}});
 f.port.execute=original;
 expect(await runDeterminationWorkflow(f.db,f.port)).toEqual({pending:false,completed:1});
 expect((f.port.prepare as jest.Mock).mock.calls.filter(call=>call[1]==='reverse')).toHaveLength(1);
 expect((f.port.recorded as jest.Mock).mock.calls.filter(call=>call[1]==='eligibility')).toHaveLength(1);
});

test('an unsigned allocation with a changed revision re-admits membership for the durable cohort',async()=>{
 const f=await fixture(),original=f.port.recorded;
 let stale=true;
 f.port.recorded=jest.fn(async(requests,kind,request)=>{
  if(kind==='allocate'&&stale){stale=false;throw Error('recourse_execution_membership_attestation_required');}
  return original(requests,kind,request);
 });
 expect(await runDeterminationWorkflow(f.db,f.port)).toEqual({pending:true,completed:0});
 expect(f.fake.store.get(`${DETERMINATION_WORKFLOWS}/${f.ticket.request}`)).toMatchObject({phase:'reversed',pending:null});
 expect(await runDeterminationWorkflow(f.db,f.port)).toEqual({pending:false,completed:1});
 expect((f.port.recorded as jest.Mock).mock.calls.filter(call=>call[1]==='eligibility')).toHaveLength(2);
 expect((f.port.prepare as jest.Mock).mock.calls.filter(call=>call[1]==='reverse')).toHaveLength(1);
});

test('full reversal admits membership before recording without allocating reserves',async()=>{
 const f=await fixture(),path=`${DETERMINATION_WORKFLOWS}/${f.ticket.request}`;
 f.fake.store.set(path,{...f.fake.store.get(path),phase:'reversed',shortfall:'0'});
 expect(await runDeterminationWorkflow(f.db,f.port)).toEqual({pending:false,completed:1});
 expect((f.port.recorded as jest.Mock).mock.calls.map(call=>call[1])).toEqual(['eligibility','record']);
});


test('a signed pending allocation error cannot erase its reservation or re-admit membership',async()=>{
 const f=await fixture(),path=`${DETERMINATION_WORKFLOWS}/${f.ticket.request}`;
 const pending={id:recourseExecutionId(f.plan('allocate')),kind:'allocate'};
 f.fake.store.set(path,{...f.fake.store.get(path),phase:'eligible',pending});
 f.port.resume=jest.fn(async()=>{throw Error('recourse_execution_membership_attestation_required');});
 await expect(runDeterminationWorkflow(f.db,f.port)).rejects.toThrow('membership_attestation_required');
 expect(f.fake.store.get(path)).toMatchObject({phase:'eligible',pending});
 expect(f.port.recorded).not.toHaveBeenCalled();
 expect(f.port.execute).not.toHaveBeenCalled();
});

test('a full reversal in a mixed cohort admits its current revision only after reserve allocation',async()=>{
 const f=await fixture(),path=`${DETERMINATION_WORKFLOWS}/${f.ticket.request}`,zero=`0x${'55'.repeat(32)}`;
 const row=f.fake.store.get(path)!;
 f.fake.store.set(path,{...row,phase:'reversed',shortfall:'100'});
 f.fake.store.set(`${DETERMINATION_WORKFLOWS}/${zero}`,{...row,request:zero,phase:'reversed',shortfall:'0'});
 f.fake.store.set(f.path.replace(f.ticket.request,zero),{...f.fake.store.get(f.path)});
 expect(await runDeterminationWorkflow(f.db,f.port)).toEqual({pending:false,completed:2});
 const calls=(f.port.recorded as jest.Mock).mock.calls;
 const allocation=calls.findIndex(call=>call[1]==='allocate');
 const zeroAdmission=calls.findIndex(call=>call[1]==='eligibility'&&call[2]===zero);
 expect(allocation).toBeGreaterThanOrEqual(0);
 expect(zeroAdmission).toBeGreaterThan(allocation);
 expect(calls[allocation][0]).toEqual([f.ticket.request]);
 expect(calls[zeroAdmission][0]).toEqual([zero]);
});
