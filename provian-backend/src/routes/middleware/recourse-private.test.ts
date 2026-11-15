import express, { type Request } from 'express';
import http from 'supertest';
import { execFileSync } from 'child_process';
import { AbiCoder, concat, sha256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../../core/pvt/__test-helpers__/fake-firestore';
import { RECOURSE_COLLECTIONS } from '../../core/recourse/ownership';
import { privateRecourseIntent } from '../../core/recourse/private-access';
import { OWNER_EXECUTOR_ABI } from '../../core/recourse/owner-operation';
import { OWNER_OPERATIONS } from '../../core/recourse/owner-operation-queue';
import { BREAK_DEPLOYMENTS } from '../../core/recourse/break-deployment-queue';
import * as deploymentQueue from '../../core/recourse/break-deployment-queue';
import * as deploymentRuntime from '../../core/recourse/break-deployment-runtime';
import { BREAK_REGISTRATIONS } from '../../core/recourse/break-registration';
import { BREAK_RESTORATIONS } from '../../core/recourse/break-restoration-queue';
import { BREAK_RESTORATION_TUPLE } from '../../core/recourse/break-restoration-data';
import { authenticatePrivateRecourse } from './recourse-private';
import { createRecourseRouter } from '../recourse';
import type { AgentBankDeps } from '../../core/agent-bank/types';
// Each case signs real SLH-DSA envelopes in child processes. A two-core CI runner
// running suites in parallel takes several times the local duration.
const SIGNING_TEST_TIMEOUT_MS = 300_000;
jest.setTimeout(SIGNING_TEST_TIMEOUT_MS);

// Bridge CommonJS Jest to the production cryptography, never a true stub.
jest.mock('@noble/post-quantum/slh-dsa.js', () => ({ slh_dsa_sha2_128s: {
  verify: (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => {
    const { execFileSync } = jest.requireActual<typeof import('child_process')>('child_process');
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
      "import{readFileSync}from'node:fs';import{slh_dsa_sha2_128s as s}from'@noble/post-quantum/slh-dsa.js';const a=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify(s.verify(...a.map(x=>new Uint8Array(x)))));"],
    { input: JSON.stringify([[...signature], [...message], [...publicKey]]), encoding: 'utf8' })) as boolean;
  },
} }));
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const identity = h(1), other = h(2), id = h(3), nowMs = Date.now();
const publicKey = execFileSync(process.execPath, ['--input-type=module', '-e',
  "import{slh_dsa_sha2_128s as s}from'@noble/post-quantum/slh-dsa.js';console.log('0x'+Buffer.from(s.keygen(new Uint8Array(48).fill(1)).publicKey).toString('hex'));"], { encoding: 'utf8' }).trim();
const credential = { version: 1 as const, identity, publicKey, recoverySecret: h(4),
  commitment: sha256(concat([h(4), sha256(publicKey)])), issuedAtMs: nowMs };
const signatures = new Map<string, string>();
function envelope(path: string, request: unknown = null) {
  const digest = privateRecourseIntent(credential, path, request);
  let signature = signatures.get(digest);
  if (!signature) {
    signature = execFileSync(process.execPath, ['--input-type=module', '-e',
      "import{slh_dsa_sha2_128s as s}from'@noble/post-quantum/slh-dsa.js';const k=s.keygen(new Uint8Array(48).fill(1));console.log('0x'+Buffer.from(s.sign(Buffer.from(process.argv[1].slice(2),'hex'),k.secretKey,{extraEntropy:false})).toString('hex'));", digest], { encoding: 'utf8' }).trim();
    signatures.set(digest, signature);
  }
  return { authorization: { ...credential, signature }, request };
}
function inputs(owner: string) {
  const proof = { recoverySecret: h(4), signingRoot: sha256(publicKey), nextCommitment: h(5),
    nextSigningRoot: h(6), publicKey, signature: `0x${'11'.repeat(7856)}` };
  const operation = { kernel: a(1), revision: '1', identity: owner, destination: a(2), nonce: 0, proof };
  const deployment = { kind: 'deploy', breakOrigin: a(1), factory: a(2), account: a(3), initialRoot: h(5), identity: owner,
    amount: '50', commitment: credential.commitment, proof: [], recoverySecret: h(4), signingRoot: proof.signingRoot, publicKey, signature: proof.signature };
  const registration = { deployment, kernel: a(1) };
  const coder = AbiCoder.defaultAbiCoder();
  const payload = coder.encode(['uint8', 'bytes'], [1, coder.encode([BREAK_RESTORATION_TUPLE],
    [[owner, 50, credential.commitment, a(3), h(5), []]])]);
  const restoration = { kernel: a(1), ownerIntent: h(7), data: OWNER_EXECUTOR_ABI.encodeFunctionData('execute', [owner, h(7), proof, payload]) };
  return { operation, deployment, registration, restoration };
}
function fixture(owner = identity) {
  const fake = createFakeFirestore(), data = inputs(owner), app = express();
  fake.store.set(`${RECOURSE_COLLECTIONS.identities}/${identity}`, { identity, recoveryCommitment: credential.commitment });
  fake.store.set(`${OWNER_OPERATIONS}/${id}`, { operation: data.operation });
  fake.store.set(`${BREAK_DEPLOYMENTS}/${id}`, { request: data.deployment });
  fake.store.set(`${BREAK_REGISTRATIONS}/${id}`, { request: data.registration });
  fake.store.set(`${BREAK_RESTORATIONS}/${id}`, { identity: owner });
  let observed: Request | undefined;
  const downstream = jest.fn();
  app.use(express.json({ limit: '256kb' }));
  app.use((req, _res, next) => { observed = req; req.rawBody = 'sensitive'; next(); });
  app.use(authenticatePrivateRecourse(fake as unknown as Firestore));
  app.use((req, res) => { downstream(req.body); res.json({ reached: true }); });
  return { app, fake, downstream, observed: () => observed };
}

test('all private namespaces refuse anonymous access and legacy GET/HEAD, including Express path aliases', async () => {
  const f = fixture();
  const paths = [`owner-recovery-state/${identity}/2`, `break-entitlements/${a(1)}/${identity}`, `break-recovery-state/${a(1)}/${identity}`,
    'owner-operations/recovery', `owner-operations/${id}`, 'break-deployments', `break-deployments/${id}`,
    'break-registrations', `break-registrations/${id}`, 'break-restorations', `break-restorations/${id}`, `break-restorations/${id}/receipt`];
  for (const path of paths) {
    for (const variant of [path, path.toUpperCase(), `${path}/`]) {
      expect((await http(f.app).get(`/${variant}`)).status).toBe(404);
      expect((await http(f.app).head(`/${variant}`)).status).toBe(404);
      expect((await http(f.app).post(`/${variant}`).send({})).status).toBe(404);
    }
  }
  expect(f.downstream).not.toHaveBeenCalled();
  expect(f.observed()?.body).toBeUndefined(); expect(f.observed()?.rawBody).toBeUndefined();
});
test('signed discovery succeeds, but changed target, method, body or signature never reaches the handler', async () => {
  const f = fixture(), path = `break-entitlements/${a(1)}/${identity}`, signed = envelope(path);
  const result = await http(f.app).post(`/${path}`).send(signed);
  expect(result.status).toBe(200); expect(result.headers['cache-control']).toBe('no-store');
  expect(f.downstream).toHaveBeenCalledWith(null); f.downstream.mockClear();
  for (const body of [{ ...signed, request: { changed: true } }, { ...signed, extra: true },
    { ...signed, authorization: { ...signed.authorization, signature: `0x${'00'.repeat(7856)}` } }]) {
    expect((await http(f.app).post(`/${path}`).send(body)).status).toBe(404);
  }
  expect((await http(f.app).post(`/${path.replace(identity, other)}`).send(signed)).status).toBe(404);
  expect((await http(f.app).post(`/${path}/`).send(signed)).status).toBe(404);
  expect((await http(f.app).get(`/${path}`).send(signed)).status).toBe(404);
  expect(f.downstream).not.toHaveBeenCalled();
});
test('every operation ID and receipt is bound to the stored owner, not the credential owner', async () => {
  for (const name of ['owner-operations', 'break-deployments', 'break-registrations', 'break-restorations']) {
    for (const suffix of name === 'break-restorations' ? ['', '/receipt'] : ['']) {
      const path = `${name}/${id}${suffix}`, body = suffix ? { transactionHash: h(9) } : null, signed = envelope(path, body);
      const own = fixture(), stranger = fixture(other);
      expect((await http(own.app).post(`/${path}`).send(signed)).status).toBe(200);
      expect((await http(stranger.app).post(`/${path}`).send(signed)).status).toBe(404);
      expect(stranger.downstream).not.toHaveBeenCalled();
      stranger.fake.store.clear();
      expect((await http(stranger.app).post(`/${path}`).send(signed)).status).toBe(404);
    }
  }
}, SIGNING_TEST_TIMEOUT_MS);
test('submission bodies must name the authenticated owner before queue or worker execution', async () => {
  for (const [path, field] of [['owner-operations/recovery', 'operation'], ['break-deployments', 'deployment'],
    ['break-registrations', 'registration'], ['break-restorations', 'restoration']] as const) {
    const f = fixture();
    expect((await http(f.app).post(`/${path}`).send(envelope(path, inputs(identity)[field]))).status).toBe(200);
    f.downstream.mockClear();
    expect((await http(f.app).post(`/${path}`).send(envelope(path, inputs(other)[field]))).status).toBe(404);
    expect(f.downstream).not.toHaveBeenCalled();
  }
}, SIGNING_TEST_TIMEOUT_MS);
test('published rules and aggregate resources remain outside private recovery authorization', async () => {
  const f = fixture();
  for (const path of ['resources', `membership-rules/${h(1)}`]) expect((await http(f.app).get(`/${path}`)).status).toBe(200);
  expect(f.downstream).toHaveBeenCalledTimes(2);
});
test('the production router mounts the private gate before its actual status handler', async () => {
  const f = fixture(), app = express(), path = `owner-operations/${id}`;
  const row = f.fake.store.get(`${OWNER_OPERATIONS}/${id}`)!;
  f.fake.store.set(`${OWNER_OPERATIONS}/${id}`, { ...row, status: 'queued', transactionHash: null });
  app.use(express.json({ limit: '256kb' }));
  app.use('/v1/recourse', createRecourseRouter({ db: f.fake as unknown as Firestore } as AgentBankDeps,
    (_req, res) => { res.status(401).json({ error: 'owner_auth_required' }); }));
  expect((await http(app).get(`/v1/recourse/${path}`)).status).toBe(404);
  expect((await http(app).post(`/v1/recourse/${path}`).send({})).status).toBe(404);
  const response = await http(app).post(`/v1/recourse/${path}`).send(envelope(path));
  expect(response.status).toBe(200); expect(response.body).toEqual({ id, status: 'queued', transactionHash: null });
  f.fake.store.set(`${OWNER_OPERATIONS}/${id}`, { ...row, operation: inputs(other).operation, status: 'queued', transactionHash: null });
  expect((await http(app).post(`/v1/recourse/${path}`).send(envelope(path))).status).toBe(404);
});

test('mounted replacement submission and status retain private owner authentication and scrub request material', async () => {
  const f=fixture(),app=express(),path='break-deployments';
  const {amount:_amount,proof:_proof,...common}=inputs(identity).deployment;
  const replacement={...common,kind:'replacement',kernel:a(1),revision:'1',nonce:1};
  const status={id,status:'queued' as const,transactionHash:null};
  f.fake.store.set(`${BREAK_DEPLOYMENTS}/${id}`,{request:replacement,...status});
  const queued=jest.spyOn(deploymentQueue,'queueBreakDeployment').mockResolvedValue(status);
  const worker=jest.spyOn(deploymentRuntime,'runBreakDeploymentWorker').mockResolvedValue(null);
  app.use(express.json({limit:'256kb'}));
  app.use('/v1/recourse',createRecourseRouter({db:f.fake as unknown as Firestore} as AgentBankDeps,
    (_req,res)=>{res.status(401).json({error:'owner_auth_required'});}));
  try {
    expect((await http(app).post(`/v1/recourse/${path}`).send(envelope(path,replacement))).status).toBe(200);
    expect(queued).toHaveBeenCalledWith(f.fake,replacement);expect(worker).toHaveBeenCalledTimes(1);
    queued.mockClear();worker.mockClear();
    const foreign={...replacement,identity:other};
    expect((await http(app).post(`/v1/recourse/${path}`).send(envelope(path,foreign))).status).toBe(404);
    expect((await http(app).post(`/v1/recourse/${path}`).send({request:replacement})).status).toBe(404);
    const signed=envelope(path,replacement);
    expect((await http(app).post(`/v1/recourse/${path}`).send({...signed,request:{...replacement,nonce:2}})).status).toBe(404);
    expect(queued).not.toHaveBeenCalled();expect(worker).not.toHaveBeenCalled();
    const lookup=`${path}/${id}`;
    expect((await http(app).post(`/v1/recourse/${lookup}`).send(envelope(lookup))).body).toEqual(status);
    f.fake.store.set(`${BREAK_DEPLOYMENTS}/${id}`,{request:foreign,...status});
    expect((await http(app).post(`/v1/recourse/${lookup}`).send(envelope(lookup))).status).toBe(404);
  } finally {queued.mockRestore();worker.mockRestore();}
},30000);

test('mounted later-recovery discovery requires a signed matching binding, nonce and empty body', async () => {
 const f=fixture(),app=express(),path=`owner-recovery-state/${identity}/2`;
 app.use(express.json({limit:'256kb'}));
 app.use('/v1/recourse',createRecourseRouter({db:f.fake as unknown as Firestore} as AgentBankDeps,
  (_req,res)=>{res.status(401).json({error:'owner_auth_required'});}));
 const response=await http(app).post(`/v1/recourse/${path}`).send(envelope(path));
 expect(response.status).toBe(200);expect(response.body).toEqual({identity,nonce:2,relayCommitment:credential.commitment,candidates:[]});
 for(const target of [`owner-recovery-state/${other}/2`,`owner-recovery-state/${identity}/3`])
  expect((await http(app).post(`/v1/recourse/${target}`).send(envelope(path))).status).toBe(404);
 const foreign=`owner-recovery-state/${other}/2`;
 expect((await http(app).post(`/v1/recourse/${foreign}`).send(envelope(foreign))).status).toBe(404);
 expect((await http(app).post(`/v1/recourse/${path}`).send(envelope(path,{changed:true}))).status).toBe(404);
 expect(response.headers['cache-control']).toBe('no-store');
},30000);

test('mounted restoration history requires a signed exact binding and no request body',async()=>{
 const f=fixture(),app=express(),path=`restoration-history/${identity}`;
 app.use(express.json({limit:'256kb'}));
 app.use('/v1/recourse',createRecourseRouter({db:f.fake as unknown as Firestore} as AgentBankDeps,
  (_req,res)=>{res.status(401).json({error:'owner_auth_required'});}));
 const response=await http(app).post(`/v1/recourse/${path}`).send(envelope(path));
 expect(response.status).toBe(200);expect(response.body).toEqual({identity,candidates:[]});
 expect(response.headers['cache-control']).toBe('no-store');
 expect((await http(app).get(`/v1/recourse/${path}`)).status).toBe(404);
 expect((await http(app).post(`/v1/recourse/${path}`).send({request:null})).status).toBe(404);
 const foreign=`restoration-history/${other}`;
 expect((await http(app).post(`/v1/recourse/${foreign}`).send(envelope(path))).status).toBe(404);
 expect((await http(app).post(`/v1/recourse/${foreign}`).send(envelope(foreign))).status).toBe(404);
 expect((await http(app).post(`/v1/recourse/${path}`).send(envelope(path,{changed:true}))).status).toBe(404);
},30000);
