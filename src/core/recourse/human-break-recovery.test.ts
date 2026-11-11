vi.mock('./human-recovery', () => ({ resumeHumanRecoveryForRestore: async () => null, replaceHumanAccountForRestore: (...args: unknown[]) => f.replace(...args),
  recoverHumanAccountFromBackup: (...args: unknown[]) => f.independent(...args) }));
import { beforeEach, expect, test, vi } from 'vitest';
import { sha256 } from 'ethers';
import type { BiometricAction } from '../security/biometricAction';
import type { OwnerChainNetwork } from './owner-chain';
import { recoverHumanBreak, recoverHumanAuxiliaryBreak, discoverHumanAccountForRestore } from './human-break-recovery';

const f = vi.hoisted(() => ({ storage:new Map<string,string>(), badReceipt:false, badUser:false, badEntitlement:false,
  spendingLost:false, typedSpendingLoss:false, ownerNonce:1, independent:vi.fn(), replacementAddress:null as string|null,
  replace:vi.fn(), discoverError:false, requests:[] as string[], phases:[] as string[], credentials:vi.fn(), proof:vi.fn(),
  privateGenerations:[] as number[], firstBoundGeneration:0, snapshotSeed:21, secrets:[] as Uint8Array[], cancelled:false, builds:0, historyChanged:false, restored:false, relayRestored:false,
  auxiliaryRequestId:null as string|null, random:10 }));
const h = (n: number) => `0x${n.toString(16).padStart(64,'0')}`, a = (n: number) => `0x${n.toString(16).padStart(40,'0')}`;
const identity=h(1), origin=a(2), destination=a(3), kernel=a(4), tx=h(5);
const prepared = () => ({phase:'restore_balance' as const,kernel,executor:a(6),authority:a(7),manifestHash:h(8),
  identity,destination,amount:'200',data:'0x1234',ownerIntent:h(9)});
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY:1,
  getItemAsync:async (key:string) => f.storage.get(key) ?? null,
  setItemAsync:async (key:string,value:string) => { f.storage.set(key,value); } }));
vi.mock('expo-crypto', () => ({getRandomBytes:() => new Uint8Array(32).fill(f.random++)}));
vi.mock('../security/biometricAction', () => ({assertBiometricAction:() => { if(f.cancelled) throw Error('biometric_ended'); }}));
vi.mock('../protocol/runtime', () => ({ownerChainNetwork:() => ({})}));
vi.mock('./human-secret', () => ({humanRecoverySecret:(_m:string,g:number)=>new Uint8Array(32).fill(30+g),humanRecoverySigningSeed:(_m:string,g:number)=>new Uint8Array(32).fill(40+g),humanBreakKey:(_m:string,_c:unknown,purpose:string) => {
  const key=new Uint8Array(32).fill(purpose==='spending'?11:purpose==='recovery-secret'?12:13);f.secrets.push(key);return key;
}}));
vi.mock('./human-break-history', () => ({
  discoverHumanIdentityHistory:async () => ({identity:h(1),points:[{breakOrigin:f.historyChanged?a(99):a(2)}]}),
  discoverAddressIdentityHistory:async (account:string) => {
    expect(account).toBe(a(10));return {identity:h(1),points:[{breakOrigin:f.historyChanged?a(99):a(2)}]};
  },
  discoverHistoricalCurveGeneration:async () => 2,
  recoverHumanHistoricalMaterial:async () => {const secret=new Uint8Array(32).fill(20),signingSeed=new Uint8Array(32).fill(f.snapshotSeed);
    f.secrets.push(secret,signingSeed); return {secret,signingSeed};},
}));
vi.mock('./human-account', () => ({discoverHumanHashAccountSelection:async (_m:string,_i:string,_r:string,_n:unknown,g:number) => {
  expect(g).toBe(2);return {kind:'hash',evm:a(3),generation:g,hashAccount:{breakOrigin:a(2)}};
}}));
vi.mock('./human-discovery', () => ({discoverHumanAccount:async () => {
  if(f.spendingLost)throw Error('recourse_hash_account_key_mismatch');
  if(f.discoverError)throw Error('recourse_break_restoration_required');
  return {identity:h(1),selection:{kind:'hash',evm:f.replacementAddress??a(3),generation:2,hashAccount:{breakOrigin:a(2)}}};
}}));
vi.mock('./break-recovery', () => ({readBreakRecoveryContext:async () => a(2),
  prepareBreakRecovery:async (input:{persistBeforePublishing:(b:unknown)=>Promise<void>}) => {
    ++f.builds;await input.persistBeforePublishing({destination:a(3)});return prepared();
}}));
vi.mock('./break-deployment-proof', () => ({prepareBreakDeploymentRequest:async (input:{persistBeforePublishing:(b:unknown)=>Promise<void>}) => {
  await input.persistBeforePublishing({account:a(3)});return {};
}}));
vi.mock('./free-break-recovery', () => ({recoverFreeBreak:async (input:{
  pendingRestoration:()=>Promise<unknown>;prepareDeployment:()=>Promise<unknown>;prepareRecovery:(d:string)=>Promise<unknown>;
  transport:{request:(path:string,body?:unknown)=>Promise<unknown>};
}) => {
  const pending=await input.pendingRestoration();
  if(!pending){await input.prepareDeployment();await input.prepareRecovery(a(3));}
  const journal=JSON.parse([...f.storage.values()][0]);
  expect(journal.destination).toBe(a(3));expect(journal.prepared.ownerIntent).toBe(h(9));
  await input.transport.request('break-restorations',{});
  return {prepared:prepared(),transactionHash:h(5)};
}}));
vi.mock('./break-restoration-data', () => ({parseBreakRestorationRequest:(v:unknown)=>v,
  breakRestorationDetails:()=>({identity:h(1),destination:a(3),amount:'200',destinationKeyRoot:sha256(new Uint8Array(32).fill(11)),
    proof:{recoverySecret:h(20),signingRoot:h(21),nextCommitment:sha256(new Uint8Array(32).fill(12)),nextSigningRoot:sha256(new Uint8Array(32).fill(13))}})}));
vi.mock('./owner-chain', () => ({readOwnerChainState:async () => ({nonce:f.ownerNonce,destination:f.restored?a(3):a(0)})}));
vi.mock('./break-recovery-receipt', async importOriginal => {
  const original = await importOriginal<typeof import('./break-recovery-receipt')>();
  return { ...original, verifyBreakRecoveryReceipt:async () => {
    if(f.badReceipt)throw Error('receipt_unverified');
    if(f.typedSpendingLoss)throw new original.BreakRecoverySpendingKeyChanged();
  }};
});
vi.mock('./hash-account-deployment', () => ({discoverHashAccount:async () => ({account:a(3),nonce:'0',currentRoot:sha256(new Uint8Array(32).fill(11))})}));
vi.mock('./hash-authorization', () => ({recoverySigningRoot:async (key:Uint8Array)=>sha256(key),recoveryCommitment:(key:Uint8Array)=>sha256(key)}));
vi.mock('./hash-account', () => ({signHashAccountMessage:async ()=> '0xsignature'}));
vi.mock('../../services/RelayAPIService', () => ({default:{
  getMeterDeviceId:async ()=>'device',setAuthSecret:f.credentials,recordAddressProofAuthorization:f.proof,
  recourseRequest:async(route:string,body?:Record<string,unknown>)=>{
    f.requests.push(route);
    if(route==='ownership')return {identity:f.badUser?h(1):h(99),addresses:[{identity:h(1),address:a(10),recoveryGeneration:0,chainBindingStatus:'confirmed'},
      ...(f.auxiliaryRequestId?[{identity:h(1),address:a(3),recoveryGeneration:1,chainBindingStatus:'confirmed',
        recoveryRequestId:f.auxiliaryRequestId,authorizationTxHash:h(5)}]:[])]};
    if(route==='recover-address') {
      expect(body).toMatchObject({destinationKind:'hash',authorizationNonce:0,destination:a(3),authorizationTxHash:h(5)});
      expect(body).not.toHaveProperty('authSecret');expect(body).not.toHaveProperty('deviceId');
      if(f.auxiliaryRequestId && f.auxiliaryRequestId!==body?.requestId)throw Error('recourse_authorization_superseded');
      f.auxiliaryRequestId=String(body?.requestId);
      return {identity:h(1),destination:a(3),generation:1};
    }
    throw Error('unexpected_route');
  },
  recourseRecoveryRequest:async (route:string,body?:Record<string,unknown>, privateAccess?: {identity:string;secret:Uint8Array;signingSeed:Uint8Array}) => {
    if (route !== 'recover-human') {
      expect(privateAccess?.identity).toBe(h(1));
      expect(privateAccess?.secret.length).toBe(32); expect(privateAccess?.signingSeed.length).toBe(32);
      const generation=privateAccess!.secret[0]-30; f.privateGenerations.push(generation);
      if (generation !== f.firstBoundGeneration || privateAccess!.signingSeed[0] !== 40+generation) throw Error('recourse_private_unavailable');
    }
    f.requests.push(route);
    if(route.startsWith('break-recovery-state/'))return {identity:h(1),origin:a(2),relayDestination:f.relayRestored?a(3):a(99),
      candidates:[{prepared:prepared(),transactionHash:h(5)}]};
    if(route.startsWith('break-entitlements/'))return {identity:f.badEntitlement?h(99):h(1),amount:'200',commitment:h(20),proof:[]};
    if(route==='recover-human'){
      expect(body).toMatchObject({destinationKind:'hash',authorizationNonce:0,destination:a(3),authorizationTxHash:h(5)});
      return {identity:h(1),userId:f.badUser?'':'owner',destination:a(3),generation:1};
    }
    return {};
  },
}}));
beforeEach(()=>{f.storage.clear();f.requests=[];f.privateGenerations=[];f.firstBoundGeneration=0;f.snapshotSeed=21;f.secrets=[];f.badReceipt=false;f.badUser=false;f.badEntitlement=false;
  f.typedSpendingLoss=false;f.ownerNonce=1;f.independent.mockReset();f.replacementAddress=null;
  f.cancelled=false;f.builds=0;f.historyChanged=false;f.discoverError=false;f.restored=false;f.relayRestored=false;f.credentials.mockClear();f.proof.mockClear();f.auxiliaryRequestId=null;f.random=10;});
const action={} as BiometricAction,network={deployment:async()=>({manifestHash:h(8)})} as OwnerChainNetwork;
test('an auxiliary break restores its own hash account and lineage without changing primary credentials or selection',async()=>{
  const result=await recoverHumanAuxiliaryBreak('test backup',action,{identity,originAddress:a(10)},{network});
  expect(result).toEqual({identity,destination});
  expect(f.credentials).not.toHaveBeenCalled();expect(f.proof).not.toHaveBeenCalled();
  expect(f.requests).toContain('recover-address');expect(f.requests).not.toContain('recover-human');
  const key=[...f.storage.keys()][0];expect(key.endsWith('_aux')).toBe(true);
  expect(JSON.parse(f.storage.get(key)!).bindingInstalled).toBe(true);
  expect(f.secrets.every(s=>s.every(b=>b===0))).toBe(true);
  await recoverHumanAuxiliaryBreak('test backup',action,{identity,originAddress:a(10)},{network});
  expect(f.builds).toBe(1);expect(f.credentials).not.toHaveBeenCalled();
});
test('auxiliary break recovery refuses primary bindings and unverified receipts before the relay cut',async()=>{
  f.badUser=true;
  await expect(recoverHumanAuxiliaryBreak('test backup',action,{identity,originAddress:a(10)},{network})).rejects.toThrow('auxiliary_binding_invalid');
  expect(f.builds).toBe(0);
  f.badUser=false;f.badReceipt=true;
  await expect(recoverHumanAuxiliaryBreak('test backup',action,{identity,originAddress:a(10)},{network})).rejects.toThrow('receipt_unverified');
  expect(f.requests).not.toContain('recover-address');expect(f.credentials).not.toHaveBeenCalled();
});
test('a completed auxiliary relay cut survives loss of the local journal without replaying consumed authority under a new request',async()=>{
  await recoverHumanAuxiliaryBreak('test backup',action,{identity,originAddress:a(10)},{network});
  const requestId=f.auxiliaryRequestId;
  f.storage.clear();f.restored=true;f.relayRestored=true;
  await expect(recoverHumanAuxiliaryBreak('test backup',action,{identity,originAddress:a(10)},{network})).resolves.toEqual({identity,destination});
  expect(f.auxiliaryRequestId).toBe(requestId);expect(f.builds).toBe(1);expect(f.credentials).not.toHaveBeenCalled();
  expect(JSON.parse([...f.storage.values()][0]).requestId).toBe(requestId);
});
test('retains exact intent before publication, verifies restoration, installs only matching credentials and wipes derived secrets',async()=>{
  const result=await recoverHumanBreak('test backup',action,{network});
  expect(result.selection.evm).toBe(destination);expect(f.credentials).toHaveBeenCalledOnce();
  expect(JSON.parse([...f.storage.values()][0]).credentialsInstalled).toBe(true);
  expect(f.secrets.length).toBeGreaterThan(4);expect(f.secrets.every(s=>s.every(b=>b===0))).toBe(true);
});
test('a relay confirmation cannot install credentials when independent receipt verification fails',async()=>{
  f.badReceipt=true;await expect(recoverHumanBreak('test backup',action,{network})).rejects.toThrow('receipt_unverified');
  expect(f.requests).not.toContain('recover-human');expect(f.credentials).not.toHaveBeenCalled();
  expect(f.secrets.every(s=>s.every(b=>b===0))).toBe(true);
});
test('an interrupted credential response resumes the same receipt and request without new restoration',async()=>{
  f.badUser=true;await expect(recoverHumanBreak('test backup',action,{network})).rejects.toThrow('reply_invalid');
  const request=JSON.parse([...f.storage.values()][0]).requestId;
  expect(f.credentials).not.toHaveBeenCalled();expect(f.builds).toBe(1);
  f.badUser=false;await discoverHumanAccountForRestore('test backup',action,network);
  expect(f.builds).toBe(1);expect(JSON.parse([...f.storage.values()][0]).requestId).toBe(request);
  expect(f.credentials).toHaveBeenCalledOnce();
});
test('unrestored discovery enters free restoration while an installed journal does not repeat it',async()=>{
  f.discoverError=true;await discoverHumanAccountForRestore('test backup',action,network);
  f.discoverError=false;await discoverHumanAccountForRestore('test backup',action,network);
  expect(f.builds).toBe(1);expect(f.credentials).toHaveBeenCalledOnce();
});
test('a fresh device completes the relay cut from an independently verified public receipt with no local journal',async()=>{
  f.restored=true;
  expect(f.storage.size).toBe(0);
  const result=await discoverHumanAccountForRestore('test backup',action,network);
  expect(result?.identity).toBe(identity);expect(result?.selection?.evm).toBe(destination);
  expect(f.builds).toBe(0);expect(f.requests).not.toContain('break-restorations');
  expect(f.credentials).toHaveBeenCalledOnce();expect(JSON.parse([...f.storage.values()][0]).credentialsInstalled).toBe(true);
});
test('a fresh device rejects a relay-supplied completed receipt when independent chain verification fails',async()=>{
  f.restored=true;f.badReceipt=true;
  await expect(discoverHumanAccountForRestore('test backup',action,network)).rejects.toThrow('receipt_unverified');
  expect(f.credentials).not.toHaveBeenCalled();expect(f.requests).not.toContain('recover-human');
});
test('already migrated relay records use ordinary fresh hash-signature credential recovery without repeating the address cut',async()=>{
  f.restored=true;f.relayRestored=true;
  await discoverHumanAccountForRestore('test backup',action,network);
  expect(f.credentials).not.toHaveBeenCalled();expect(f.builds).toBe(0);expect(f.storage.size).toBe(0);
});
test.each(['identity','origin','biometric'] as const)('rejects changed %s before any owner proof is published',async kind=>{
  f.badEntitlement=kind==='identity';f.historyChanged=kind==='origin';f.cancelled=kind==='biometric';
  await expect(recoverHumanBreak('test backup',action,{network})).rejects.toThrow();
  expect(f.requests).not.toContain('break-restorations');expect(f.credentials).not.toHaveBeenCalled();
});

test.each([21,61])('a newer snapshot signing seed %s never replaces the retained relay read credential',async snapshotSeed=>{
  f.snapshotSeed=snapshotSeed;
  await recoverHumanBreak('original backup',{} as BiometricAction);
  expect(f.requests).toContain('break-restorations');
  expect(f.privateGenerations.length).toBeGreaterThan(1);
  expect(f.privateGenerations.every(g=>g===0)).toBe(true);
});
test('a seed first bound at a later curve generation retries only private authorization refusals',async()=>{
  f.firstBoundGeneration=1;
  await recoverHumanBreak('original backup',{} as BiometricAction);
  expect(f.privateGenerations.slice(0,2)).toEqual([0,1]);
  expect(f.credentials).toHaveBeenCalled();
});

test('restoring a backup with a stolen hash spending root invokes independent replacement recovery only for that exact failure',async()=>{
 f.spendingLost=true;f.replace.mockResolvedValue({identity,selection:{evm:a(90)}});
 try{expect(await discoverHumanAccountForRestore('test backup',action,network)).toEqual({identity,selection:{evm:a(90)}});
  expect(f.replace).toHaveBeenCalledWith('test backup',action,network);
 }finally{f.spendingLost=false;f.replace.mockReset();}
});

test.each([false,true])('verified initial spending theft resumes independent recovery (auxiliary=%s)',async auxiliary=>{
  f.typedSpendingLoss=true;
  f.independent.mockImplementation(async()=>{f.replacementAddress=a(90);return {destination:a(90),requestId:h(90)};});
  const run=()=>auxiliary?recoverHumanAuxiliaryBreak('test backup',action,{identity,originAddress:a(10)},{network})
    :recoverHumanBreak('test backup',action,{network});
  const result=await run();
  expect('destination' in result?result.destination:result.selection.evm).toBe(a(90));
  expect(f.independent).toHaveBeenCalledWith('test backup',action,network,
    auxiliary?{signal:undefined,auxiliaryBinding:identity}:{signal:undefined});
  const journal=JSON.parse([...f.storage.values()][0]);
  expect(journal.replacementStarted).toBe(true);expect(journal.credentialsInstalled).not.toBe(true);
  expect(journal.bindingInstalled).not.toBe(true);
  expect(f.requests).not.toContain('recover-human');expect(f.requests).not.toContain('recover-address');
  expect(f.secrets.every(s=>s.every(b=>b===0))).toBe(true);
  // A crash after consuming the next owner nonce resumes its existing journal.
  f.ownerNonce=2;await run();expect(f.builds).toBe(1);expect(f.independent).toHaveBeenCalledTimes(2);
});
test('fresh-device verified theft discovery uses independent recovery without repeating free balance restoration',async()=>{
  f.restored=true;f.typedSpendingLoss=true;
  f.independent.mockImplementation(async()=>{f.replacementAddress=a(90);return {destination:a(90),requestId:h(90)};});
  expect((await recoverHumanBreak('test backup',action,{network})).selection.evm).toBe(a(90));
  expect(f.builds).toBe(0);expect(f.requests).not.toContain('break-restorations');
});
test('ordinary receipt failures and changed owner nonces never enter the initial-theft recovery branch',async()=>{
  f.badReceipt=true;
  await expect(recoverHumanBreak('test backup',action,{network})).rejects.toThrow('receipt_unverified');
  expect(f.independent).not.toHaveBeenCalled();
  f.badReceipt=false;f.typedSpendingLoss=true;f.ownerNonce=2;
  await expect(recoverHumanBreak('test backup',action,{network})).rejects.toThrow();
  expect(f.independent).not.toHaveBeenCalled();
  expect(JSON.parse([...f.storage.values()][0]).replacementStarted).toBeUndefined();
});
test('interrupted independent recovery keeps a resume marker without falsely installing initial credentials',async()=>{
  f.typedSpendingLoss=true;f.independent.mockRejectedValueOnce(Error('reply_lost'));
  await expect(recoverHumanBreak('test backup',action,{network})).rejects.toThrow('reply_lost');
  f.ownerNonce=2;
  f.independent.mockImplementation(async()=>{f.replacementAddress=a(90);return {destination:a(90),requestId:h(90)};});
  expect((await recoverHumanBreak('test backup',action,{network})).selection.evm).toBe(a(90));
  expect(f.builds).toBe(1);expect(f.credentials).not.toHaveBeenCalled();
});
