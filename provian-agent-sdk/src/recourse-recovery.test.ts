import { withBoundRecoveryMaterial } from './recourse-agent-credential';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encryptKeystore, saveKeystore, loadKeystore, withRecoverySecret, withRecoveryMaterial } from './keystore';
import { generateAgentKeyPair } from './wallet';
import { recoveryCommitment, recoverySigningRoot } from './recourse-hash-authorization';
import { recoveryOperationId, type RecoveryOwnerOperation } from './recourse-owner-operation';
import { requireConfiguredPvt9Runtime } from './pvt9-base-config.generated';
import { recoverRecourseAgent, withArchivedRecoveryMaterial, archivedAgentRestorations } from './recourse-recovery';
// Each recovery now performs both the chain signature and private HTTP proof.
vi.setConfig({ testTimeout: 20000 });
const routing = vi.hoisted(() => ({ context: vi.fn(), recover: vi.fn() }));
vi.mock('./break-recovery', () => ({ readBreakRecoveryContext: (...args: unknown[]) => routing.context(...args) }));
vi.mock('./agent-hash-recovery', () => ({ recoverHashRecourseAgent: (...args: unknown[]) => routing.recover(...args) }));
vi.mock('./recourse-binding-chain', () => ({ readAddressRecoveryBinding: async () => `0x${'92'.repeat(32)}` }));
const network = vi.hoisted(() => ({ fetch: vi.fn(), state: vi.fn(), verify: vi.fn(), queue: vi.fn() }));
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});
vi.mock('./guarded-fetch', () => ({ guardedFetcher: () => async (url: string, options: RequestInit) => {
  if (url.endsWith('/owner-operations/recovery')) return network.queue(url, options);
  return network.fetch(url, options);
} }));
vi.mock('./protocol-runtime', () => ({ ownerChainNetwork: () => ({}), currentProtocolDeployment: async () => ({ addresses: { kernel: requireConfiguredPvt9Runtime().address } }) }));
vi.mock('./recourse-owner-chain', () => ({ readOwnerChainState: (...args: unknown[]) => network.state(...args),
  verifyOwnerOperationReceipt: (...args: unknown[]) => network.verify(...args) }));
let directory: string;
const passphrase = 'test recovery backup passphrase';
const walletId = 'wallet_aw_recovery_test';
beforeEach(async () => {
  routing.context.mockReset(); routing.recover.mockReset(); routing.context.mockRejectedValue(Error('break_recovery_unavailable'));
  network.fetch.mockReset(); network.state.mockReset(); network.verify.mockReset(); network.queue.mockReset();
  network.verify.mockResolvedValue(undefined);
  network.queue.mockImplementation(async (_url: string, options: RequestInit) => {
    const operation = JSON.parse(String(options.body)).request as RecoveryOwnerOperation;
    return { ok: true, json: async () => ({ id: recoveryOperationId(operation), status: 'confirmed', transactionHash: `0x${'de'.repeat(32)}` }) };
  });
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recourse-recovery-'));
  saveKeystore(encryptKeystore({ ...generateAgentKeyPair(), walletId, passphrase,
    recoverySecret: '17'.repeat(32), kdfParams: { N: 1024, r: 8, p: 1, dklen: 32 } }), path.join(directory, 'agent-keystore.json'));
  const current = loadKeystore(path.join(directory, 'agent-keystore.json'))!;
  const material = await withBoundRecoveryMaterial(current, passphrase, `0x${'92'.repeat(32)}`, async (secret, seed) => {
    const signingRoot = await recoverySigningRoot(seed);
    return { signingRoot, commitment: recoveryCommitment(secret, signingRoot) };
  });
  network.state.mockResolvedValue({ ...material, nonce: 0, deployment: { revision: 1n, addresses: { kernel: requireConfiguredPvt9Runtime().address } } });
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
const input = () => ({ relayUrl: 'https://relay.example', directory, passphrase });
it('retains one destination and credential pair after a lost response, then installs exactly that identity', { timeout: 25000 }, async () => {
  const requests: Record<string, unknown>[] = [];
  network.fetch.mockImplementation(async (_url: string, options: RequestInit) => {
    const request = JSON.parse(String(options.body)) as Record<string, unknown>;
    requests.push(request);
    const journal = fs.readFileSync(path.join(directory, 'recourse-recovery.json'), 'utf8');
    expect(journal).not.toContain(String(request.apiSecret));
    expect(journal).not.toContain('17'.repeat(32));
    expect(journal).not.toContain(passphrase);
    if (requests.length === 1) throw new Error('response lost after commit');
    return { ok: true, json: async () => ({ walletId, destination: request.destination, generation: 1 }) };
  });
  const old = loadKeystore(path.join(directory, 'agent-keystore.json'))!;
  await expect(recoverRecourseAgent(input())).rejects.toThrow('response lost');
  expect(loadKeystore(path.join(directory, 'agent-keystore.json'))).toEqual(old);
  const result = await recoverRecourseAgent(input());
  for (const field of ['requestId', 'destination', 'nextCommitment', 'apiKey', 'apiSecret', 'preimage']) expect(requests[1][field]).toBe(requests[0][field]);
  const next = loadKeystore(path.join(directory, 'agent-keystore.json'))!;
  expect(next.address.toLowerCase()).toBe(result.destination);
  expect(await withRecoverySecret(next, passphrase, value => Buffer.from(value).toString('hex'))).not.toBe('17'.repeat(32));
  expect(JSON.parse(fs.readFileSync(path.join(directory, 'agent-credentials.json'), 'utf8')).api_secret).toBe(requests[0].apiSecret);
  const refreshed = JSON.stringify({ wallet_id: walletId, address: result.destination, api_key: 'newer-key', api_secret: 'newer-secret' });
  fs.writeFileSync(path.join(directory, 'agent-credentials.json'), refreshed, { mode: 0o600 });
  expect(await recoverRecourseAgent(input())).toEqual(result);
  expect(fs.readFileSync(path.join(directory, 'agent-credentials.json'), 'utf8')).toBe(refreshed);
  expect(network.fetch).toHaveBeenCalledTimes(2);
  const identity = String(requests[0].identity);
  const oldCommitment = await withBoundRecoveryMaterial(old, passphrase, identity, async (secret, seed) => recoveryCommitment(secret, await recoverySigningRoot(seed)));
  const use = vi.fn(async (secret: Uint8Array) => Buffer.from(secret).toString('hex'));
  const lookup = { directory, passphrase, identity, commitment: oldCommitment };
  const expectedSecret = await withBoundRecoveryMaterial(old, passphrase, identity, secret => Buffer.from(secret).toString('hex'));
  expect(expectedSecret).not.toBe('17'.repeat(32));
  expect(await withArchivedRecoveryMaterial(lookup, use)).toEqual({ found: true, value: expectedSecret });
  expect(await withArchivedRecoveryMaterial({ ...lookup, commitment: String(requests[0].nextCommitment) }, use)).toEqual({ found: true, value: expect.any(String) });
  const auxiliary = `0x${'95'.repeat(32)}`;
  const auxiliaryMaterial = await withBoundRecoveryMaterial(old, passphrase, auxiliary, async (secret, seed) => ({
    commitment: recoveryCommitment(secret, await recoverySigningRoot(seed)), secret: Buffer.from(secret).toString('hex'),
  }));
  expect(await withArchivedRecoveryMaterial({ ...lookup, identity: auxiliary, commitment: auxiliaryMaterial.commitment }, use))
    .toEqual({ found: true, value: auxiliaryMaterial.secret });
  expect(auxiliaryMaterial.secret).not.toBe(expectedSecret);
  use.mockClear();
  expect(await withArchivedRecoveryMaterial({ ...lookup, identity: `0x${'ff'.repeat(32)}` }, use)).toEqual({ found: false });
  expect(await withArchivedRecoveryMaterial({ ...lookup, commitment: `0x${'ff'.repeat(32)}` }, use)).toEqual({ found: false });
  expect(use).not.toHaveBeenCalled();
  const archive = path.join(directory, 'recoveries'); fs.mkdirSync(archive, { mode: 0o700 });
  const archivedFile = path.join(archive, `${requests[0].requestId}.json`);
  fs.renameSync(path.join(directory, 'recourse-recovery.json'), archivedFile);
  expect(await withArchivedRecoveryMaterial(lookup, use)).toEqual({ found: true, value: expectedSecret });
  await expect(withArchivedRecoveryMaterial({ ...lookup, passphrase: 'wrong' }, use)).rejects.toThrow();
  fs.renameSync(archivedFile, path.join(archive, `0x${'fe'.repeat(32)}.json`));
  await expect(withArchivedRecoveryMaterial(lookup, use)).rejects.toThrow('binding mismatch');
});
it('refuses a substituted response without installing the new key', async () => {
  const old = loadKeystore(path.join(directory, 'agent-keystore.json'))!;
  network.fetch.mockResolvedValue({ ok: true, json: async () => ({ walletId, destination: old.address, generation: 1 }) });
  await expect(recoverRecourseAgent(input())).rejects.toThrow('response binding mismatch');
  expect(loadKeystore(path.join(directory, 'agent-keystore.json'))).toEqual(old);
});
it('refuses to replace a completed journal until the archive parent is durable', { timeout: 25000 }, async () => {
  network.fetch.mockImplementation(async (_url: string, options: RequestInit) => {
    const request = JSON.parse(String(options.body));
    return { ok: true, json: async () => ({ walletId, destination: request.destination, generation: 1 }) };
  });
  await recoverRecourseAgent(input());
  const file = path.join(directory, 'recourse-recovery.json');
  const before = fs.readFileSync(file, 'utf8');
  const parent = fs.statSync(directory);
  const actual = await vi.importActual<typeof import('fs')>('fs');
  vi.mocked(fs.fsyncSync).mockImplementation(fd => {
    const stat = fs.fstatSync(fd);
    if (stat.isDirectory() && stat.ino === parent.ino && stat.dev === parent.dev) throw Error('archive parent sync failed');
    actual.fsyncSync(fd);
  });
  try {
    await expect(recoverRecourseAgent({ ...input(), newRecovery: true })).rejects.toThrow('archive parent sync failed');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.join(directory, 'recoveries'))).toEqual([]);
    expect(network.fetch).toHaveBeenCalledTimes(1);
  } finally { vi.mocked(fs.fsyncSync).mockImplementation(actual.fsyncSync); }
});
it('a bad backup password fails before network contact or replacement', async () => {
  const old = loadKeystore(path.join(directory, 'agent-keystore.json'))!;
  await expect(recoverRecourseAgent({ ...input(), passphrase: 'wrong' })).rejects.toThrow();
  expect(network.fetch).not.toHaveBeenCalled();
  expect(loadKeystore(path.join(directory, 'agent-keystore.json'))).toEqual(old);
});

it('a relay-invented authorization receipt cannot install replacement credentials', async () => {
  const old = loadKeystore(path.join(directory, 'agent-keystore.json'))!;
  network.verify.mockRejectedValue(new Error('recourse_owner_receipt_intent_missing'));
  await expect(recoverRecourseAgent(input())).rejects.toThrow('intent_missing');
  expect(loadKeystore(path.join(directory, 'agent-keystore.json'))).toEqual(old);
  expect(network.fetch).not.toHaveBeenCalled();
});
it('lost authorization response resumes the exact signed operation without replacing the active key', async () => {
  const old = loadKeystore(path.join(directory, 'agent-keystore.json'))!;
  network.queue.mockRejectedValueOnce(new Error('authorization response lost'));
  await expect(recoverRecourseAgent(input())).rejects.toThrow('authorization response lost');
  const first = JSON.parse(String(network.queue.mock.calls[0][1].body)).request;
  network.fetch.mockImplementation(async (_url: string, options: RequestInit) => {
    const request = JSON.parse(String(options.body));
    expect(request.authorizationNonce).toBe(first.nonce);
    expect(request.authorizationTxHash).toBe(`0x${'de'.repeat(32)}`);
    return { ok: true, json: async () => ({ walletId, destination: request.destination, generation: 1 }) };
  });
  expect(loadKeystore(path.join(directory, 'agent-keystore.json'))).toEqual(old);
  await recoverRecourseAgent(input());
  expect(JSON.parse(String(network.queue.mock.calls[1][1].body)).request).toEqual(first);
  expect(network.state).toHaveBeenCalledTimes(2);
});
it('rebuilds an unexecuted stale-revision payload without changing its signed consequence', { timeout: 25000 }, async () => {
  network.queue.mockRejectedValueOnce(new Error('response lost before submission'));
  await expect(recoverRecourseAgent(input())).rejects.toThrow('response lost');
  const first = JSON.parse(String(network.queue.mock.calls[0][1].body)).request as RecoveryOwnerOperation;
  const current = await network.state();
  network.state.mockResolvedValue({ ...current, deployment: { ...current.deployment, revision: 2n } });
  network.fetch.mockImplementation(async (_url: string, options: RequestInit) => {
    const request = JSON.parse(String(options.body));
    return { ok: true, json: async () => ({ walletId, destination: request.destination, generation: 1 }) };
  });
  await recoverRecourseAgent(input());
  const second = JSON.parse(String(network.queue.mock.calls[1][1].body)).request as RecoveryOwnerOperation;
  expect(second).toEqual({ ...first, revision: '2' });
});
it('prepares and signs one bounded loss scope, then resumes without a second authorization', { timeout: 30000 }, async () => {
  const scope = { request: `0x${'ab'.repeat(32)}`, lossHash: `0x${'bc'.repeat(32)}`, maximumLoss: '99' };
  const kernel = requireConfiguredPvt9Runtime().address.toLowerCase();
  const transactionHash = `0x${'cd'.repeat(32)}`;
  let submissions=0;let cut:Record<string,unknown>|undefined;
  network.fetch.mockImplementation(async (url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body)) as Record<string, unknown>;
    if (url.endsWith('/restoration-intents')) {
      expect(body).toEqual({ transactionHash, block: 100 });
      expect(options.headers).toMatchObject({ Authorization: 'Bearer old-api:old-secret' });
      return { ok: true, json: async () => ({ ...scope, kernel }) };
    }
    if(url.endsWith('/restoration-requests')) {
      submissions++;expect(cut).toBeDefined();
      expect(options.headers).toMatchObject({Authorization:`Bearer ${cut!.apiKey}:${cut!.apiSecret}`});
      expect(body).toEqual({identity:cut!.identity,transactionHash,block:100,recoveryRequestId:cut!.requestId,restorationRequestId:scope.request});
      if(submissions===1)throw Error('restoration response lost after commit');
      return {ok:true,json:async()=>({requestId:submissions===2?`0x${'ff'.repeat(32)}`:scope.request,status:'awaiting_determination'})};
    }
    cut=body;return { ok: true, json: async () => ({ walletId, destination: body.destination, generation: 1 }) };
  });
  const request = { ...input(), restoration: { transactionHash, block: 100, apiKey: 'old-api', apiSecret: 'old-secret' } };
  await expect(recoverRecourseAgent(request)).rejects.toThrow('restoration response lost');
  const installed=fs.readFileSync(path.join(directory,'agent-keystore.json'),'utf8');
  await expect(recoverRecourseAgent({...request,newRecovery:true})).rejects.toThrow('response binding mismatch');
  expect(fs.existsSync(path.join(directory,'recoveries'))).toBe(false);expect(network.queue).toHaveBeenCalledTimes(1);
  const result = await recoverRecourseAgent(request);
  expect(fs.readFileSync(path.join(directory,'agent-keystore.json'),'utf8')).toBe(installed);
  expect(submissions).toBe(3);
  expect(result.restorationRequestId).toBe(scope.request);
  const operation = JSON.parse(String(network.queue.mock.calls[0][1].body)).request as RecoveryOwnerOperation;
  expect(operation.restoration).toEqual(scope);
  expect(operation.destination).toBe(result.destination);
  expect(await recoverRecourseAgent(request)).toEqual(result);
  expect(network.queue).toHaveBeenCalledTimes(1);
  expect(network.fetch).toHaveBeenCalledTimes(5);
  const lookup={directory,passphrase,identity:operation.identity};
  expect(archivedAgentRestorations(lookup)).toEqual([{transactionHash,block:100,kernel,scope}]);
  const archive=path.join(directory,'recoveries');fs.mkdirSync(archive,{mode:0o700});
  fs.renameSync(path.join(directory,'recourse-recovery.json'),path.join(archive,`${cut!.requestId}.json`));
  expect(archivedAgentRestorations(lookup)).toEqual([{transactionHash,block:100,kernel,scope}]);
  expect(archivedAgentRestorations({...lookup,identity:`0x${'ff'.repeat(32)}`})).toEqual([]);
  await expect(async()=>archivedAgentRestorations({...lookup,passphrase:'wrong passphrase'})).rejects.toThrow();
});
it('a prepared loss from a retired kernel never reaches owner signing or queueing', async () => {
  network.fetch.mockResolvedValue({ ok: true, json: async () => ({ request: `0x${'ab'.repeat(32)}`,
    lossHash: `0x${'bc'.repeat(32)}`, maximumLoss: '99', kernel: `0x${'99'.repeat(20)}` }) });
  const old = loadKeystore(path.join(directory, 'agent-keystore.json'))!;
  await expect(recoverRecourseAgent({ ...input(), restoration: { transactionHash: `0x${'cd'.repeat(32)}`, block: 100,
    apiKey: 'old-api', apiSecret: 'old-secret' } })).rejects.toThrow('snapshot kernel changed');
  expect(network.queue).not.toHaveBeenCalled();
  expect(loadKeystore(path.join(directory, 'agent-keystore.json'))).toEqual(old);
});
it('re-signs a queued bounded intent after ordinary succession while preserving the historical loss and destination', {timeout:30000},async()=>{
 const scope={request:`0x${'ab'.repeat(32)}`,lossHash:`0x${'bc'.repeat(32)}`,maximumLoss:'99'};
 const originalKernel=requireConfiguredPvt9Runtime().address.toLowerCase(),nextKernel=`0x${'99'.repeat(20)}`;
 const transactionHash=`0x${'cd'.repeat(32)}`;
 network.fetch.mockImplementation(async(url:string,options:RequestInit)=>{
  if(url.endsWith('/restoration-intents'))return {ok:true,json:async()=>({...scope,kernel:originalKernel})};
  if(url.endsWith('/restoration-requests'))return {ok:true,json:async()=>({requestId:scope.request,status:'awaiting_determination'})};
  const body=JSON.parse(String(options.body));return {ok:true,json:async()=>({walletId,destination:body.destination,generation:1})};
 });
 const request={...input(),restoration:{transactionHash,block:100,apiKey:'old-api',apiSecret:'old-secret'}};
 network.queue.mockRejectedValueOnce(Error('submission response lost'));
 await expect(recoverRecourseAgent(request)).rejects.toThrow('response lost');
 const first=JSON.parse(String(network.queue.mock.calls[0][1].body)).request as RecoveryOwnerOperation;
 const oldState=await network.state();network.state.mockResolvedValue({...oldState,deployment:{revision:2n,addresses:{kernel:nextKernel}}});
 await recoverRecourseAgent(request);
 const second=JSON.parse(String(network.queue.mock.calls[1][1].body)).request as RecoveryOwnerOperation;
 expect(second.kernel).toBe(nextKernel);expect(second.revision).toBe('2');expect(second.destination).toBe(first.destination);
 expect(second.restoration).toEqual(scope);expect(second.proof.nextCommitment).toBe(first.proof.nextCommitment);
 expect(second.proof.signature).not.toBe(first.proof.signature);
 expect(network.fetch.mock.calls.filter(([url])=>String(url).endsWith('/restoration-intents'))).toHaveLength(1);
});

it('routes post-break recovery without creating a curve journal and fails closed on unavailable verification', async()=>{
 const original=fs.readFileSync(path.join(directory,'agent-keystore.json'),'utf8');
 routing.context.mockRejectedValueOnce(Error('RPC disagreement'));
 await expect(recoverRecourseAgent(input())).rejects.toThrow('RPC disagreement');expect(routing.recover).not.toHaveBeenCalled();expect(network.fetch).not.toHaveBeenCalled();
 routing.context.mockResolvedValueOnce(`0x${'11'.repeat(20)}`);const result={walletId,destination:`0x${'22'.repeat(20)}`,generation:3};routing.recover.mockResolvedValueOnce(result);
 expect(await recoverRecourseAgent({...input(),newRecovery:true})).toEqual(result);expect(routing.recover).toHaveBeenCalledWith(expect.objectContaining({newRecovery:true,passphrase,directory}));
 expect(fs.existsSync(path.join(directory,'recourse-recovery.json'))).toBe(false);expect(fs.readFileSync(path.join(directory,'agent-keystore.json'),'utf8')).toBe(original);
});
