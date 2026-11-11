vi.mock('./human-recovery-discovery', () => ({ discoverPendingHumanRecovery: async () => state.discovered }));
vi.mock('./human-discovery', () => ({ discoverHumanAccount: async () => ({ identity: h('91'), selection: { evm: state.destination } }) }));
import { beforeEach, expect, it, vi } from 'vitest';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { Wallet, concat, sha256, hexlify, toUtf8Bytes } from 'ethers';
import { recoverHumanAccount, resumeHumanRecoveryForRestore } from './human-recovery';
import { recoveryOperationId } from './owner-operation';
import { humanBreakKey, humanRecoverySecret, humanRecoverySigningSeed } from './human-secret';
import type { BiometricAction } from '../security/biometricAction';

const state = vi.hoisted(() => ({ memory: new Map<string, string>(), failReceipt: false, loseResponse: false,
  discovered: null as unknown, afterBreak: false, deployFailure: false, destinationStolen: false, privateUnavailable: false, ownerResponseLost: false, nonce: 0, destination: '', random: 17, revision: 1n, refuseQueue: false, crashReplacement: false,
  calls: [] as { path: string; body: unknown }[], installed: [] as unknown[], credentials: [] as unknown[] }));
const mnemonic = 'test test test test test test test test test test test junk';
const action = 'approved' as unknown as BiometricAction;
const h = (byte: string) => `0x${byte.repeat(32)}`;
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device',
  getItemAsync: async (key: string) => state.memory.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    state.memory.set(key, value);
    if (state.crashReplacement && JSON.parse(value).revision === '2') { state.crashReplacement = false; throw new Error('replacement_crash'); }
  } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (size: number) => new Uint8Array(size).fill(state.random++) }));
vi.mock('../security/biometricAction', () => ({ assertBiometricAction: (value: unknown) => { if (value !== 'approved') throw new Error('biometric_required'); } }));
vi.mock('../wallet/SeedManager', () => ({ default: { getMnemonic: async () => 'test test test test test test test test test test test junk' } }));
vi.mock('../protocol/runtime', () => ({ ownerChainNetwork: () => ({}) }));
vi.mock('./human-break-history', () => ({
  discoverHumanIdentityHistory: async () => ({ identity: h('91'), points: [{ breakOrigin: state.afterBreak ? `0x${'55'.repeat(20)}` : `0x${'00'.repeat(20)}` }] }),
  discoverHistoricalCurveGeneration: async () => 4,
}));
vi.mock('./break-recovery', () => ({ readBreakRecoveryContext: async () => {
  if (!state.afterBreak) throw Error('break_recovery_unavailable');
  return `0x${'55'.repeat(20)}`;
} }));
vi.mock('./human-replacement-account', () => {
  class ReplacementSpendingKeyChangedError extends Error {}
  return { ReplacementSpendingKeyChangedError,
  prepareHumanReplacementAccount: async (_mnemonic: string, identity: string) => ({ identity, breakOrigin: `0x${'55'.repeat(20)}`,
    nonce: state.nonce, account: `0x${(state.nonce + 10).toString(16).padStart(40, '0')}`, initialRoot: h('aa'), accountGeneration: String(state.nonce + 1) }),
  deployHumanReplacementAccount: async (_mnemonic: string, plan: unknown, _action: unknown, _network: unknown, retain: (plan: unknown) => Promise<void>) => {
    await retain(plan); state.calls.push({ path: 'deploy', body: plan });
    if (state.deployFailure) { state.deployFailure = false; throw Error('deployment_interrupted'); }
  },
  signHumanReplacementDestination: async (_mnemonic: string, plan: unknown, message: string) => {
    if (state.destinationStolen) { state.destinationStolen = false; throw new ReplacementSpendingKeyChangedError(); }
    state.calls.push({ path: 'destination-proof', body: { plan, message } }); return `0x${'77'.repeat(7888)}`;
  },
}; });
vi.mock('./human-account', async original => {
  const actual = await original<typeof import('./human-account')>();
  return { ...actual, installHumanHashAccountSelection: async (...args: unknown[]) => { state.installed.push(args); }, installHumanAccountSelection: async (_mnemonic: string, selection: unknown) => { state.installed.push(selection); } };
});
vi.mock('./hash-authorization', () => ({
  recoverySigningRoot: async (seed: Uint8Array) => sha256(sha256(seed)),
  recoveryCommitment: (secret: Uint8Array, root: string) => sha256(concat([secret, root])),
  signRecoveryIntent: async (seed: Uint8Array, intent: string, journal: { reserve(root: string, intent: string): Promise<void> }) => {
    await journal.reserve(sha256(sha256(seed)), intent);
    return { signingRoot: sha256(sha256(seed)), publicKey: sha256(seed), signature: `0x${'33'.repeat(7856)}` };
  },
}));
function recoveryKey(identity: string, nonce: number, purpose: 'recovery-secret' | 'recovery-signing'): Uint8Array {
  return state.afterBreak ? humanBreakKey(mnemonic, { identity, breakOrigin: `0x${'55'.repeat(20)}`, chainId: '8453' }, purpose, String(nonce))
    : (purpose === 'recovery-secret' ? humanRecoverySecret : humanRecoverySigningSeed)(mnemonic, nonce, identity);
}
vi.mock('./owner-chain', () => ({
  readOwnerChainState: async (identity: string) => ({ nonce: state.nonce, destination: state.destination,
    commitment: sha256(concat([recoveryKey(identity, state.nonce, 'recovery-secret'), sha256(sha256(recoveryKey(identity, state.nonce, 'recovery-signing')))])),
    signingRoot: sha256(sha256(recoveryKey(identity, state.nonce, 'recovery-signing'))),
    deployment: { addresses: { kernel: `0x${'44'.repeat(20)}` }, revision: state.revision } }),
  verifyOwnerOperationReceipt: async () => { if (state.failReceipt) throw new Error('invalid_receipt'); },
}));
vi.mock('../security/ActionWallet', () => ({ ActionWallet: Wallet }));
vi.mock('../../services/RelayAPIService', () => ({ default: {
  getMeterDeviceId: async () => 'device',
  setAuthSecret: async (...value: unknown[]) => { state.credentials.push(value); },
  recordAddressProofAuthorization: async () => {},
  recourseRequest: async(path:string,body:unknown)=>{
    state.calls.push({path,body});
    if(path==='ownership') return { identity: h('91'), addresses: [
      { identity: h('92'), chainBindingStatus: 'confirmed' }, { identity: h('93'), chainBindingStatus: 'confirmed' }] };
    if(path==='recover-address') {
      if(state.loseResponse) { state.loseResponse=false; throw Error('response_lost'); }
      const input=body as {identity:string;destination:string};
      return {identity:input.identity,destination:input.destination,generation:state.nonce};
    }
    if(path!=='restoration-intents')throw Error('unexpected_request');
    const input=body as {transactionHash:string;block:number};
    return {request:input.transactionHash,lossHash:sha256(toUtf8Bytes(JSON.stringify(input))),maximumLoss:'100',kernel:`0x${'44'.repeat(20)}`};
  },
  recourseRecoveryRequest: async (path: string, body: unknown, privateAccess?: {identity:string;secret:Uint8Array;signingSeed:Uint8Array}) => {
    if (path.startsWith('owner-operations/')) {
      expect([h('91'),h('92'),h('93')]).toContain(privateAccess?.identity);
      expect(privateAccess?.secret.length).toBe(32); expect(privateAccess?.signingSeed.length).toBe(32);
    }
    state.calls.push({ path, body });
    if (state.privateUnavailable) { state.privateUnavailable = false; throw Error('recourse_private_unavailable'); }
    if (path === 'owner-operations/recovery') {
      if (state.refuseQueue) { state.refuseQueue = false; throw new Error('queue_unavailable'); }
      const operation = body as Parameters<typeof recoveryOperationId>[0];
      state.nonce = operation.nonce + 1; state.destination = operation.destination;
      if (state.ownerResponseLost) { state.ownerResponseLost = false; throw Error('owner_response_lost'); }
      // Real parser/operation ID is tested in its own suite; use it here too.
      return { id: recoveryOperationId(body as Parameters<typeof recoveryOperationId>[0]), status: 'confirmed', transactionHash: h('66') };
    }
    if (state.loseResponse) { state.loseResponse = false; throw new Error('response_lost'); }
    const input = body as { destination: string };
    return { identity: h('91'), userId: 'user-recovery', destination: input.destination, generation: 1 };
  },
} }));
beforeEach(() => {
  state.destinationStolen = false; state.privateUnavailable = false; state.discovered = null; state.afterBreak = false; state.deployFailure = false; state.ownerResponseLost = false;
  state.memory.clear(); state.failReceipt = false; state.loseResponse = false; state.nonce = 0; state.destination = ''; state.random = 17;
  state.calls = []; state.installed = []; state.credentials = []; state.revision = 1n; state.refuseQueue = false; state.crashReplacement = false;
});
it('recovers an auxiliary binding with its own journal and key without installing primary credentials', async () => {
  const options={auxiliaryBinding:h('92'),lossTransaction:h('77'),lossBlock:100};
  state.loseResponse=true;
  await expect(recoverHumanAccount(action,options)).rejects.toThrow('response_lost');
  const first=await recoverHumanAccount(action,options);
  expect(await recoverHumanAccount(action,options)).toEqual(first);
  expect(state.credentials).toEqual([]); expect(state.installed).toEqual([]);
  const requests=state.calls.filter(c=>c.path==='recover-address').map(c=>c.body as Record<string,unknown>);
  expect(requests).toHaveLength(2);
  expect(requests[0].identity).toBe(h('92'));expect(requests[0].destination).toBe(first.destination);
  expect(requests[1].requestId).toBe(requests[0].requestId);
  expect(requests[0]).not.toHaveProperty('authSecret');expect(requests[0]).not.toHaveProperty('deviceId');
  expect(state.calls.find(c=>c.path==='restoration-intents')?.body).toEqual({identity:h('92'),transactionHash:h('77'),block:100});
  expect(state.calls.some(c=>c.path==='recover-human')).toBe(false);
  state.nonce=0;state.destination='';
  const sibling=await recoverHumanAccount(action,{...options,auxiliaryBinding:h('93')});
  expect(sibling.destination).not.toBe(first.destination);
  expect([...state.memory.keys()].filter(k=>k.includes('_aux_'))).toHaveLength(2);
});
it('refuses primary or unknown bindings on the auxiliary path before signing any owner operation',async()=>{
  for(const auxiliaryBinding of [h('91'),h('94')]) {
    await expect(recoverHumanAccount(action,{auxiliaryBinding})).rejects.toThrow('auxiliary_binding_invalid');
  }
  expect(state.calls.every(c=>c.path==='ownership')).toBe(true);
  expect(state.installed).toEqual([]);expect(state.credentials).toEqual([]);expect(state.memory.size).toBe(0);
});
it('replaces an unexecuted stale pointer revision safely, including a crash after the replacement write', async () => {
  state.refuseQueue = true;
  await expect(recoverHumanAccount(action)).rejects.toThrow('queue_unavailable');
  state.revision = 2n; state.crashReplacement = true;
  await expect(recoverHumanAccount(action)).rejects.toThrow('replacement_crash');
  await expect(recoverHumanAccount(action)).resolves.toHaveProperty('destination');
  const requests = state.calls.filter(call => call.path === 'owner-operations/recovery').map(call => call.body as Record<string, unknown>);
  expect(requests.map(request => request.revision)).toEqual(['1', '2']);
  expect(requests[0].destination).toBe(requests[1].destination);
  expect(state.credentials).toHaveLength(1);
});
it('serializes concurrent recovery attempts across a lost server response without replacing the winning journal', async () => {
  state.loseResponse = true;
  const results = await Promise.allSettled([recoverHumanAccount(action), recoverHumanAccount(action)]);
  expect(results.map(result => result.status)).toEqual(['rejected', 'fulfilled']);
  const requests = state.calls.filter(call => call.path === 'recover-human').map(call => call.body as Record<string, unknown>);
  expect(requests).toHaveLength(2);
  expect(requests[0].authSecret).toBe(requests[1].authSecret);
  expect(requests[0].requestId).toBe(requests[1].requestId);
  expect(state.credentials).toHaveLength(1);
});
it('resumes one loss but creates a fresh destination for a later loss', async () => {
  const first = await recoverHumanAccount(action, { lossTransaction: h('77'),lossBlock:100 });
  expect(await recoverHumanAccount(action, { lossTransaction: h('77'),lossBlock:100 })).toEqual(first);
  const second = await recoverHumanAccount(action, { lossTransaction: h('88'),lossBlock:200 });
  expect(second.destination).not.toBe(first.destination);
  expect(second.requestId).not.toBe(first.requestId);
  expect(state.credentials).toHaveLength(2);
  expect(state.calls.filter(call=>call.path==='restoration-intents')).toHaveLength(2);
  const operations=state.calls.filter(call=>call.path==='owner-operations/recovery').map(call=>call.body as {restoration:{request:string;maximumLoss:string}});
  expect(operations.map(value=>value.restoration)).toEqual([
    expect.objectContaining({request:h('77'),maximumLoss:'100'}),expect.objectContaining({request:h('88'),maximumLoss:'100'}),
  ]);
});
it('refuses an invalid or changed loss block before another owner authorization can leave',async()=>{
  await expect(recoverHumanAccount(action,{lossTransaction:h('77'),lossBlock:0})).rejects.toThrow('loss_block_invalid');
  expect(state.calls).toHaveLength(0);
  await recoverHumanAccount(action,{lossTransaction:h('77'),lossBlock:100});
  const count=state.calls.length;
  await expect(recoverHumanAccount(action,{lossTransaction:h('77'),lossBlock:101})).rejects.toThrow('loss_block_changed');
  expect(state.calls).toHaveLength(count);
});
it('credential generation is independent of the authorization nonce, and a superseded journal cannot restore an old address', async () => {
  state.nonce = 4;
  await expect(recoverHumanAccount(action)).resolves.toHaveProperty('destination');
  state.destination = `0x${'99'.repeat(20)}`; state.nonce = 6;
  await expect(recoverHumanAccount(action)).rejects.toThrow('superseded');
  expect(state.credentials).toHaveLength(1);
});
it('never installs credentials or a signing selector without the independently verified receipt', async () => {
  state.failReceipt = true;
  await expect(recoverHumanAccount(action)).rejects.toThrow('invalid_receipt');
  expect(state.installed).toEqual([]); expect(state.credentials).toEqual([]);
  expect(state.calls.some(call => call.path === 'recover-human')).toBe(false);
});
it('retries a lost response with the same destination, credentials and intent, retaining the seed', async () => {
  state.loseResponse = true;
  await expect(recoverHumanAccount(action)).rejects.toThrow('response_lost');
  expect(state.installed).toEqual([]);
  const result = await recoverHumanAccount(action);
  const requests = state.calls.filter(call => call.path === 'recover-human').map(call => call.body as Record<string, unknown>);
  expect(requests).toHaveLength(2);
  for (const key of ['destination', 'authSecret', 'requestId', 'authorizationTxHash']) expect(requests[0][key]).toBe(requests[1][key]);
  const hd = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
  const expected = new Wallet(hexlify(hd.derive("m/44'/60'/1'/0/0").privateKey!)).address.toLowerCase();
  expect(result.destination).toBe(expected);
  expect(state.credentials).toHaveLength(1); expect(state.installed).toHaveLength(1);
  expect(JSON.stringify([...state.memory])).not.toContain(mnemonic);
});

it('replaces a stolen hash account with independent recovery keys, retains interrupted deployment and preserves Solana selection', async () => {
  state.afterBreak = true; state.nonce = 2; state.deployFailure = true;
  await expect(recoverHumanAccount(action)).rejects.toThrow('deployment_interrupted');
  expect(state.calls.some(call => call.path.startsWith('owner-operations/'))).toBe(false);
  const retained = JSON.parse([...state.memory.values()][0]);
  state.ownerResponseLost = true;
  await expect(recoverHumanAccount(action)).rejects.toThrow('owner_response_lost');
  state.loseResponse = true;
  await expect(recoverHumanAccount(action)).rejects.toThrow('response_lost');
  expect(state.installed).toEqual([]);
  const result = await recoverHumanAccount(action);
  expect(result.destination).toBe(retained.replacement.account);
  const operations = state.calls.filter(call => call.path === 'owner-operations/recovery').map(call => call.body);
  expect(operations).toHaveLength(2); expect(operations[1]).toEqual(operations[0]);
  expect(state.calls.filter(call => call.path === 'deploy')).toHaveLength(2);
  const requests = state.calls.filter(call => call.path === 'recover-human').map(call => call.body as Record<string, unknown>);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({ destinationKind: 'hash', authorizationNonce: 2, requestId: retained.requestId, authSecret: retained.authSecret });
  expect(requests[0]).not.toHaveProperty('breakDestinationRoot');
  expect(state.calls.filter(call => call.path === 'destination-proof').every(call =>
    (call.body as { message: string }).message.endsWith('destination-signature:hash'))).toBe(true);
  expect(state.installed).toEqual([[mnemonic, h('91'), retained.requestId, action, {}, 4]]);
  expect(state.credentials).toHaveLength(1);
  expect(await recoverHumanAccount(action)).toEqual(result);
});
it('post-break auxiliary restoration uses its own hash destination and never installs primary credentials', async () => {
  state.afterBreak = true; state.nonce = 3;
  const result = await recoverHumanAccount(action, { auxiliaryBinding: h('92'), lossTransaction: h('88'), lossBlock: 123 });
  const request = state.calls.find(call => call.path === 'recover-address')!.body as Record<string, unknown>;
  expect(request).toMatchObject({ identity: h('92'), destination: result.destination, destinationKind: 'hash', authorizationNonce: 3 });
  expect(request).not.toHaveProperty('authSecret'); expect(request).not.toHaveProperty('breakDestinationRoot');
  expect(state.credentials).toEqual([]); expect(state.installed).toEqual([]);
  const second = await recoverHumanAccount(action, { auxiliaryBinding: h('92'), newRecovery: true });
  expect(second.destination).not.toBe(result.destination);
  expect(state.calls.filter(call => call.path === 'deploy')).toHaveLength(2);
});
it('copies queued recovery options before the caller can select a different binding or loss', async () => {
  const options = { auxiliaryBinding: h('92'), lossTransaction: h('77'), lossBlock: 100 };
  const result = recoverHumanAccount(action, options);
  options.auxiliaryBinding = h('93'); options.lossBlock = 200;
  await result;
  expect(state.calls.find(call => call.path === 'restoration-intents')?.body).toEqual({ identity: h('92'), transactionHash: h('77'), block: 100 });
});

it('refuses a superseded replacement journal before publishing another owner operation', async () => {
  state.afterBreak = true; state.nonce = 2; state.deployFailure = true;
  await expect(recoverHumanAccount(action)).rejects.toThrow('deployment_interrupted');
  state.nonce = 3; state.destination = `0x${'99'.repeat(20)}`;
  await expect(recoverHumanAccount(action)).rejects.toThrow('replacement_state_changed');
  expect(state.calls.some(call => call.path === 'owner-operations/recovery')).toBe(false);
  expect(state.installed).toEqual([]); expect(state.credentials).toEqual([]);
});
it('never installs a hash selector or relay credentials on an unverified replacement receipt', async () => {
  state.afterBreak = true; state.nonce = 2; state.failReceipt = true;
  await expect(recoverHumanAccount(action)).rejects.toThrow('invalid_receipt');
  expect(state.installed).toEqual([]); expect(state.credentials).toEqual([]);
  expect(state.calls.some(call => call.path === 'recover-human')).toBe(false);
});

it('a restored seed finishes a verified later receipt using fresh credentials without submitting another owner operation', async () => {
  state.afterBreak = true; state.nonce = 2; state.loseResponse = true;
  await expect(recoverHumanAccount(action, { lossTransaction: h('77'), lossBlock: 100 })).rejects.toThrow('response_lost');
  const original = JSON.parse([...state.memory.values()][0]);
  const operation = state.calls.find(call => call.path === 'owner-operations/recovery')!.body;
  state.discovered = { identity: original.identity, operation, transactionHash: original.authorizationTxHash,
    replacement: original.replacement, legacyGeneration: 4, lossTransaction: original.lossTransaction, lossBlock: original.lossBlock };
  state.memory.clear(); state.calls = []; state.random = 101;
  state.loseResponse = true;
  await expect(resumeHumanRecoveryForRestore(mnemonic, action, {} as import('./owner-chain').OwnerChainNetwork)).rejects.toThrow('response_lost');
  const retained = JSON.parse([...state.memory.values()][0]);
  expect(retained.requestId).not.toBe(original.requestId);
  expect(retained.authorizationTxHash).toBe(original.authorizationTxHash);
  state.discovered = null;
  const result = await resumeHumanRecoveryForRestore(mnemonic, action, {} as import('./owner-chain').OwnerChainNetwork);
  expect(result?.selection?.evm).toBe(original.replacement.account);
  expect(state.calls.some(call => call.path === 'deploy' || call.path === 'owner-operations/recovery')).toBe(false);
  expect(await recoverHumanAccount(action, { lossTransaction: h('77'), lossBlock: 100 })).toEqual({ destination: original.replacement.account, requestId: retained.requestId });
  expect(state.calls.some(call => call.path === 'owner-operations/recovery')).toBe(false);
  expect(state.credentials).toHaveLength(1);
  const requests = state.calls.filter(call => call.path === 'recover-human').map(call => call.body as Record<string, unknown>);
  expect(requests).toHaveLength(2); expect(requests[0].requestId).toBe(requests[1].requestId);
});

it('an interrupted relay key cut can use historical private credentials while the owner proof stays current',async()=>{
 state.afterBreak=true;state.nonce=2;state.privateUnavailable=true;
 await recoverHumanAccount(action);
 const submissions=state.calls.filter(call=>call.path==='owner-operations/recovery');
 expect(submissions).toHaveLength(2);expect(submissions[1].body).toEqual(submissions[0].body);
 expect(state.credentials).toHaveLength(1);
});
it('a new break archives an unexecuted old-domain journal instead of reusing its curve authorization',async()=>{
 state.refuseQueue=true;await expect(recoverHumanAccount(action)).rejects.toThrow('queue_unavailable');
 const old=JSON.parse([...state.memory.values()][0]);
 state.afterBreak=true;state.nonce=1;state.calls=[];
 await recoverHumanAccount(action);
 const archived=[...state.memory.entries()].find(([key])=>key.includes('_retired_'));
 expect(archived).toBeDefined();expect(JSON.parse(archived![1])).toEqual(old);
 const request=state.calls.find(call=>call.path==='recover-human')!.body as Record<string,unknown>;
 expect(request.destinationKind).toBe('hash');expect(request.requestId).not.toBe(old.requestId);
});

it.each([undefined,h('92')])('a replacement stolen during an interrupted relay cut rotates only the destination and retains the bounded loss: %s',async(auxiliaryBinding)=>{
 state.afterBreak=true;state.nonce=2;state.loseResponse=true;
 const options={lossTransaction:h('77'),lossBlock:100,auxiliaryBinding};
 await expect(recoverHumanAccount(action,options)).rejects.toThrow('response_lost');
 const original=JSON.parse([...state.memory.values()][0]);
 state.destinationStolen=true;
 const recovered=await recoverHumanAccount(action,options);
 expect(recovered.destination).not.toBe(original.replacement.account);
 const operations=state.calls.filter(call=>call.path==='owner-operations/recovery').map(call=>call.body as Record<string,unknown>);
 expect(operations).toHaveLength(2);expect(operations[0]).toHaveProperty('restoration');expect(operations[1]).not.toHaveProperty('restoration');
 const current=JSON.parse([...state.memory.entries()].find(([key])=>!key.includes('_superseded_'))![1]);
 expect(current.continuedRestoration).toEqual(original.restoration);expect(current.lossTransaction).toBe(h('77'));expect(current.lossBlock).toBe(100);
 expect(await recoverHumanAccount(action,options)).toEqual(recovered);
 expect(state.credentials).toHaveLength(auxiliaryBinding?0:1);
});

it('losing the journal again after a kind2 replacement preserves the earlier kind3 request without a third authorization',async()=>{
 state.afterBreak=true;state.nonce=2;state.loseResponse=true;
 const options={lossTransaction:h('77'),lossBlock:100};
 await expect(recoverHumanAccount(action,options)).rejects.toThrow('response_lost');
 const original=JSON.parse([...state.memory.values()][0]);
 state.destinationStolen=true;state.loseResponse=true;
 await expect(recoverHumanAccount(action,options)).rejects.toThrow('response_lost');
 const latest=JSON.parse([...state.memory.entries()].find(([key])=>!key.includes('_superseded_'))![1]);
 const operation=state.calls.filter(call=>call.path==='owner-operations/recovery').at(-1)!.body;
 state.discovered={identity:latest.identity,operation,transactionHash:latest.authorizationTxHash,replacement:latest.replacement,
  legacyGeneration:4,continuedLosses:[{restoration:original.restoration,transactionHash:h('77'),block:100}]};
 state.memory.clear();state.calls=[];
 await resumeHumanRecoveryForRestore(mnemonic,action,{}as import('./owner-chain').OwnerChainNetwork);
 const recovered=await recoverHumanAccount(action,options);
 expect(recovered.destination).toBe(latest.replacement.account);
 expect(state.calls.some(call=>call.path==='deploy'||call.path==='owner-operations/recovery')).toBe(false);
});

it('a completed relay cut with a lost response reuses its verified request ID and old loss without changing credentials',async()=>{
 state.afterBreak=true;state.nonce=2;await recoverHumanAccount(action,{lossTransaction:h('77'),lossBlock:100});
 const old=JSON.parse([...state.memory.values()][0]);
 const operation=state.calls.find(call=>call.path==='owner-operations/recovery')!.body;
 state.discovered={identity:old.identity,operation,transactionHash:old.authorizationTxHash,replacement:old.replacement,
  legacyGeneration:4,completedRequestId:old.requestId,lossTransaction:old.lossTransaction,lossBlock:old.lossBlock};
 state.memory.clear();state.calls=[];state.credentials=[];state.installed=[];
 await resumeHumanRecoveryForRestore(mnemonic,action,{}as import('./owner-chain').OwnerChainNetwork);
 expect(await recoverHumanAccount(action,{lossTransaction:h('77'),lossBlock:100})).toEqual({destination:old.replacement.account,requestId:old.requestId});
 expect(state.calls).toEqual([]);expect(state.credentials).toEqual([]);expect(state.installed).toEqual([]);
});
