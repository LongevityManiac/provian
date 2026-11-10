import { beforeEach, expect, test, vi } from 'vitest';
import { sha256 } from 'ethers';
import type { BiometricAction } from '../security/biometricAction';
import type { OwnerChainNetwork } from './owner-chain';
import { recoverHumanBreak, discoverHumanAccountForRestore } from './human-break-recovery';

const f = vi.hoisted(() => ({ storage:new Map<string,string>(), badReceipt:false, badUser:false, badEntitlement:false,
  discoverError:false, requests:[] as string[], phases:[] as string[], credentials:vi.fn(), proof:vi.fn(),
  secrets:[] as Uint8Array[], cancelled:false, builds:0, historyChanged:false, restored:false, relayRestored:false }));
const h = (n: number) => `0x${n.toString(16).padStart(64,'0')}`, a = (n: number) => `0x${n.toString(16).padStart(40,'0')}`;
const identity=h(1), origin=a(2), destination=a(3), kernel=a(4), tx=h(5);
const prepared = () => ({phase:'restore_balance' as const,kernel,executor:a(6),authority:a(7),manifestHash:h(8),
  identity,destination,amount:'200',data:'0x1234',ownerIntent:h(9)});
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY:1,
  getItemAsync:async (key:string) => f.storage.get(key) ?? null,
  setItemAsync:async (key:string,value:string) => { f.storage.set(key,value); } }));
vi.mock('expo-crypto', () => ({getRandomBytes:() => new Uint8Array(32).fill(10)}));
vi.mock('../security/biometricAction', () => ({assertBiometricAction:() => { if(f.cancelled) throw Error('biometric_ended'); }}));
vi.mock('../protocol/runtime', () => ({ownerChainNetwork:() => ({})}));
vi.mock('./ownership', () => ({humanOwnershipIdentity:(user:string) => user==='owner'?h(1):h(999)}));
vi.mock('./human-secret', () => ({humanBreakKey:(_m:string,_c:unknown,purpose:string) => {
  const key=new Uint8Array(32).fill(purpose==='spending'?11:purpose==='recovery-secret'?12:13);f.secrets.push(key);return key;
}}));
vi.mock('./human-break-history', () => ({
  discoverHumanIdentityHistory:async () => ({identity:h(1),points:[{breakOrigin:f.historyChanged?a(99):a(2)}]}),
  discoverHistoricalCurveGeneration:async () => 2,
  recoverHumanHistoricalMaterial:async () => {const secret=new Uint8Array(32).fill(20),signingSeed=new Uint8Array(32).fill(21);
    f.secrets.push(secret,signingSeed); return {secret,signingSeed};},
}));
vi.mock('./human-account', () => ({discoverHumanHashAccountSelection:async (_m:string,_i:string,_r:string,_n:unknown,g:number) => {
  expect(g).toBe(2);return {kind:'hash',evm:a(3),generation:g,hashAccount:{breakOrigin:a(2)}};
}}));
vi.mock('./human-discovery', () => ({discoverHumanAccount:async () => {
  if(f.discoverError)throw Error('recourse_break_restoration_required');
  return {identity:h(1),selection:{kind:'hash',evm:a(3),hashAccount:{breakOrigin:a(2)}}};
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
vi.mock('./owner-chain', () => ({readOwnerChainState:async () => ({nonce:1,destination:f.restored?a(3):a(0)})}));
vi.mock('./break-recovery-receipt', () => ({verifyBreakRecoveryReceipt:async () => {if(f.badReceipt)throw Error('receipt_unverified');}}));
vi.mock('./hash-account-deployment', () => ({discoverHashAccount:async () => ({account:a(3),nonce:'0',currentRoot:sha256(new Uint8Array(32).fill(11))})}));
vi.mock('./hash-authorization', () => ({recoverySigningRoot:async (key:Uint8Array)=>sha256(key),recoveryCommitment:(key:Uint8Array)=>sha256(key)}));
vi.mock('./hash-account', () => ({signHashAccountMessage:async ()=> '0xsignature'}));
vi.mock('../../services/RelayAPIService', () => ({default:{
  getMeterDeviceId:async ()=>'device',setAuthSecret:f.credentials,recordAddressProofAuthorization:f.proof,
  recourseRecoveryRequest:async (route:string,body?:Record<string,unknown>) => {
    f.requests.push(route);
    if(route.startsWith('break-recovery-state/'))return {identity:h(1),origin:a(2),relayDestination:f.relayRestored?a(3):a(99),
      candidates:[{prepared:prepared(),transactionHash:h(5)}]};
    if(route.startsWith('break-entitlements/'))return {identity:f.badEntitlement?h(99):h(1),amount:'200',commitment:h(20),proof:[]};
    if(route==='recover-human'){
      expect(body).toMatchObject({destinationKind:'hash',authorizationNonce:0,destination:a(3),authorizationTxHash:h(5)});
      return {userId:f.badUser?'other':'owner',destination:a(3),generation:1};
    }
    return {};
  },
}}));
beforeEach(()=>{f.storage.clear();f.requests=[];f.secrets=[];f.badReceipt=false;f.badUser=false;f.badEntitlement=false;
  f.cancelled=false;f.builds=0;f.historyChanged=false;f.discoverError=false;f.restored=false;f.relayRestored=false;f.credentials.mockClear();f.proof.mockClear();});
const action={} as BiometricAction,network={deployment:async()=>({manifestHash:h(8)})} as OwnerChainNetwork;
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
