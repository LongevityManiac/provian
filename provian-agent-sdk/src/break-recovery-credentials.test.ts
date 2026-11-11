import { deriveBoundRecoveryCredential } from './recourse-address-credential';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sha256, toUtf8Bytes } from 'ethers';
import { provisionBreakRecovery,prepareAgentBreakRecovery,recoverAgentBreakCredentials,readActiveHashWallet } from './break-recovery-store';
import { encryptKeystore,saveKeystore } from './keystore';
import { generateAgentKeyPair } from './wallet';
import { recoveryCommitment,recoverySigningRoot } from './recourse-hash-authorization';
import { prepareBreakRecovery,type PreparedBreakRecovery } from './break-recovery';
import { verifyBreakRecoveryReceipt } from './break-recovery-receipt';
import { readHashAccountState } from './hash-account-chain';
import type { OwnerChainNetwork } from './recourse-owner-chain';
vi.mock('./break-recovery',()=>({prepareBreakRecovery:vi.fn(),readBreakRecoveryContext:async()=>`0x${'22'.repeat(20)}`}));
vi.mock('./break-recovery-receipt',()=>({verifyBreakRecoveryReceipt:vi.fn()}));
vi.mock('./recourse-owner-chain',()=>({readOwnerChainState:async()=>({nonce:1})}));
vi.mock('./hash-account-chain',()=>({readHashAccountState:vi.fn()}));
vi.mock('./break-restoration-data',()=>({parseBreakRestorationRequest:(v:unknown)=>v,
  breakRestorationDetails:()=>({proof:{recoverySecret:`0x${'44'.repeat(32)}`,signingRoot:`0x${'55'.repeat(32)}`,
    nextCommitment:`0x${'66'.repeat(32)}`,nextSigningRoot:`0x${'77'.repeat(32)}`},destinationKeyRoot:`0x${'88'.repeat(32)}`})}));
vi.mock('./hash-account',async original=>({...await original<typeof import('./hash-account')>(),signHashAccountMessage:async()=>`0x${'99'.repeat(7888)}`}));
vi.mock('./recourse-binding-chain', () => ({ readAddressRecoveryBinding: async () => `0x${'94'.repeat(32)}` }));
const walletId='wallet_aw_break_credentials',identity=`0x${'94'.repeat(32)}`;
const context=`0x${'22'.repeat(20)}`,destination=`0x${'33'.repeat(20)}`,tx=`0x${'aa'.repeat(32)}`,passphrase='TEST ONLY credentials backup';
const network={}as OwnerChainNetwork;
let directory:string,commitment:string,prepared:PreparedBreakRecovery;
beforeEach(async()=>{
  vi.resetAllMocks();directory=fs.mkdtempSync(path.join(os.tmpdir(),'provian-break-credentials-'));
  const material=new Uint8Array(64);material.fill(0x44,0,32);material.fill(0x55,32);
  const derived=deriveBoundRecoveryCredential(material,identity,'0');
  commitment=recoveryCommitment(derived.recoverySecret,await recoverySigningRoot(derived.signingSeed));
  const root=await provisionBreakRecovery({directory,passphrase,identity,commitment,context});
  saveKeystore(encryptKeystore({...generateAgentKeyPair(),walletId,passphrase,recoverySecret:'44'.repeat(32),recoverySigningSeed:'55'.repeat(32),
    kdfParams:{N:1024,r:8,p:1,dklen:32}}),path.join(directory,'agent-keystore.json'));
  prepared={phase:'restore_balance',kernel:destination,executor:destination,authority:destination,identity,destination,amount:'100',
    manifestHash:commitment,ownerIntent:commitment,data:'0x12'};
  vi.mocked(prepareBreakRecovery).mockImplementation(async args=>{await args.persistBeforePublishing({kernel:destination,identity,destination,
    destinationSigningSeed:args.destinationSigningSeed,nextRecoverySecret:args.nextRecoverySecret,nextRecoverySigningSeed:args.nextRecoverySigningSeed,operationHash:commitment});return prepared;});
  await prepareAgentBreakRecovery({directory,passphrase,destination,network,entitlement:{identity,commitment,amount:'100',proof:[]}});
  vi.mocked(readHashAccountState).mockResolvedValue({root:root.signingRoot,nonce:'0',manifestHash:commitment,blockHash:tx});
});
afterEach(()=>fs.rmSync(directory,{recursive:true,force:true}));
const input=()=>({directory,passphrase,identity,commitment,transactionHash:tx,network});
test('a lost credential reply retains the exact encrypted pair for retry and leaves the legacy keystore untouched',async()=>{
  const old=fs.readFileSync(path.join(directory,'agent-keystore.json'),'utf8'),bodies:Record<string,unknown>[]=[];
  let fail=true;
  const transport={request:async(route:string,raw?:unknown)=>{
    expect(route).toBe('recover-agent');const body=raw as Record<string,unknown>;bodies.push(body);
    expect(body).toMatchObject({identity,destination,destinationKind:'hash',publicKey:`hash:${destination}`,authorizationNonce:0});
    const record=fs.readFileSync(path.join(directory,'break-recoveries',`${identity.slice(2)}-${commitment.slice(2)}-${context.slice(2)}.json`),'utf8');
    expect(record).not.toContain(String(body.apiSecret));
    if(fail)throw Error('reply lost');return {walletId,destination,generation:1};
  }};
  await expect(recoverAgentBreakCredentials({...input(),transport})).rejects.toThrow('reply lost');
  expect(fs.existsSync(path.join(directory,'agent-credentials.json'))).toBe(false);expect(readActiveHashWallet(directory)).toBeNull();
  fail=false;await recoverAgentBreakCredentials({...input(),transport});
  expect(bodies[1].requestId).toBe(bodies[0].requestId);expect(bodies[1].apiKey).toBe(bodies[0].apiKey);expect(bodies[1].apiSecret).toBe(bodies[0].apiSecret);
  const installed=JSON.parse(fs.readFileSync(path.join(directory,'agent-credentials.json'),'utf8'));
  expect(installed).toMatchObject({wallet_id:walletId,address:destination,api_secret:bodies[0].apiSecret});
  expect(fs.statSync(path.join(directory,'agent-credentials.json')).mode&0o777).toBe(0o600);
  expect(fs.readFileSync(path.join(directory,'agent-keystore.json'),'utf8')).toBe(old);
});
test('unverified receipts and substituted relay identities never install credentials',async()=>{
  const transport={request:vi.fn(async()=>({walletId:'another-wallet',destination,generation:1}))};
  vi.mocked(verifyBreakRecoveryReceipt).mockRejectedValueOnce(Error('unfinalized'));
  await expect(recoverAgentBreakCredentials({...input(),transport})).rejects.toThrow('unfinalized');expect(transport.request).not.toHaveBeenCalled();
  await expect(recoverAgentBreakCredentials({...input(),transport})).rejects.toThrow('reply_invalid');
  expect(fs.existsSync(path.join(directory,'agent-credentials.json'))).toBe(false);expect(readActiveHashWallet(directory)).toBeNull();
});
