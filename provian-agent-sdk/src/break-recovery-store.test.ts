import { hashDeliveryId } from './hash-account-delivery';
import { deriveBoundRecoveryCredential } from './recourse-address-credential';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hexlify, getBytes, hashMessage } from 'ethers';
import { hashAccountContractDigest, hashAccountDepartureDigest } from './hash-account-data';
import { signActiveHashWalletMessage, signBoundHashWalletMessage, signBoundHashWalletDeparture, withAgentHashRecoveryRecord, readActiveHashWalletDelivery } from './break-recovery-store';
import { recoveryCommitment, recoverySigningRoot } from './recourse-hash-authorization';
import { provisionBreakRecovery, prepareAgentBreakRecovery, completeAgentBreakRecovery, readActiveHashWallet, prepareActiveHashWalletOperation, completeActiveHashWalletOperation, cancelActiveHashWalletOperation, pendingActiveHashWalletOperations } from './break-recovery-store';
import { readHashAccountState, readHashAccountDepartureRoot, verifyHashAccountVariantReceipt } from './hash-account-chain';
import { assertCurrentProtocolTransaction } from './protocol-transaction';
import { verifyBreakRecoveryReceipt } from './break-recovery-receipt';
import { prepareBreakRecovery, readBreakRecoveryContext, type BreakRecoveryInput, type PreparedBreakRecovery } from './break-recovery';
import { encryptKeystore, saveKeystore } from './keystore';
import { generateAgentKeyPair } from './wallet';
import type { ProtocolDeployment } from './protocol-pointer';
import { readOwnerChainState, type OwnerChainNetwork } from './recourse-owner-chain';
vi.mock('./recourse-owner-chain', async original => ({...await original<typeof import('./recourse-owner-chain')>(),readOwnerChainState:vi.fn()}));
vi.mock('./hash-account-chain',()=>({readHashAccountState:vi.fn(),readHashAccountDepartureRoot:vi.fn(),verifyHashAccountVariantReceipt:vi.fn()}));
vi.mock('./protocol-transaction',()=>({assertCurrentProtocolTransaction:vi.fn()}));
vi.mock('./break-recovery-receipt',()=>({verifyBreakRecoveryReceipt:vi.fn()}));
vi.mock('./break-recovery',()=>({prepareBreakRecovery:vi.fn(),readBreakRecoveryContext:vi.fn(async()=>`0x${'66'.repeat(20)}`)}));
vi.mock('fs',async importOriginal=>{
 const actual=await importOriginal<typeof import('fs')>();
 return {...actual,fsyncSync:vi.fn(actual.fsyncSync)};
});
let commitment: string, derivedSecret: string, derivedSeed: string;
beforeAll(async () => {
 const root=new Uint8Array(64);root.fill(0x44,0,32);root.fill(0x55,32);
 const derived=deriveBoundRecoveryCredential(root,id,'0');
 derivedSecret=hexlify(derived.recoverySecret);derivedSeed=hexlify(derived.signingSeed);
 commitment = recoveryCommitment(derived.recoverySecret, await recoverySigningRoot(derived.signingSeed));
});
const id=`0x${'11'.repeat(32)}`,context=`0x${'66'.repeat(20)}`,destination=`0x${'33'.repeat(20)}`,passphrase='TEST ONLY break backup';
let directory:string;
beforeEach(()=>{directory=fs.mkdtempSync(path.join(os.tmpdir(),'provian-break-backup-'));vi.clearAllMocks();vi.mocked(prepareBreakRecovery).mockReset();vi.mocked(readBreakRecoveryContext).mockResolvedValue(context);});
afterEach(()=>fs.rmSync(directory,{recursive:true,force:true}));
const input=()=>({directory,passphrase,identity:id,commitment,context});
const file=()=>path.join(directory,'break-recoveries',`${id.slice(2)}-${commitment.slice(2)}-${context.slice(2)}.json`);
it('provisions once, persists ciphertext at 0600, and refuses wrong-password or damaged-backup replacement',async()=>{
 const root=await provisionBreakRecovery(input()),before=fs.readFileSync(file(),'utf8');
 expect(await provisionBreakRecovery(input())).toEqual(root);expect(fs.readFileSync(file(),'utf8')).toBe(before);
 expect(fs.statSync(file()).mode&0o777).toBe(0o600);expect(before).not.toContain('destinationSigningSeed');
 await expect(provisionBreakRecovery({...input(),passphrase:'wrong passphrase'})).rejects.toThrow();expect(fs.readFileSync(file(),'utf8')).toBe(before);
 fs.writeFileSync(file(),'broken');await expect(provisionBreakRecovery(input())).rejects.toThrow();expect(fs.readFileSync(file(),'utf8')).toBe('broken');
});
it('refuses symlink-backed material without touching its target',async()=>{
 await provisionBreakRecovery(input());const target=path.join(directory,'target');fs.renameSync(file(),target);fs.symlinkSync(target,file());
 const before=fs.readFileSync(target,'utf8');await expect(provisionBreakRecovery(input())).rejects.toThrow();expect(fs.readFileSync(target,'utf8')).toBe(before);
});
it('does not publish a root until the backup directory and its ancestor links have been fsynced',async()=>{
 const actual=await vi.importActual<typeof import('fs')>('fs');
 const parent=fs.statSync(path.dirname(directory));
 vi.mocked(fs.fsyncSync).mockImplementation(fd=>{
  const stat=fs.fstatSync(fd);
  if(stat.isDirectory()&&stat.ino===parent.ino&&stat.dev===parent.dev)throw Error('parent sync failed');
  actual.fsyncSync(fd);
 });
 try {await expect(provisionBreakRecovery(input())).rejects.toThrow('parent sync failed');expect(fs.existsSync(file())).toBe(false);}
 finally {vi.mocked(fs.fsyncSync).mockImplementation(actual.fsyncSync);}
 expect((await provisionBreakRecovery(input())).signingRoot).toMatch(/^0x[0-9a-f]{64}$/);
});
it('persists the same destination and replacement keys before publication, retains them across lost replies, and leaves the old wallet intact',async()=>{
 await provisionBreakRecovery(input());
 const keystoreFile=path.join(directory,'agent-keystore.json');saveKeystore(encryptKeystore({...generateAgentKeyPair(),walletId:'wallet_aw_break_test',passphrase,
  recoverySecret:'44'.repeat(32),recoverySigningSeed:'55'.repeat(32),kdfParams:{N:1024,r:8,p:1,dklen:32}}),keystoreFile);
 const original=fs.readFileSync(keystoreFile,'utf8'),seen:string[]=[];let fail=true;
 vi.mocked(prepareBreakRecovery).mockImplementation(async (args:BreakRecoveryInput):Promise<PreparedBreakRecovery>=>{
  expect(args.expectedBreakOrigin).toBe(context);
  expect(hexlify(args.recoverySecret)).toBe(derivedSecret);expect(hexlify(args.recoverySigningSeed)).toBe(derivedSeed);
  seen.push(hexlify(args.destinationSigningSeed));
  await args.persistBeforePublishing({kernel:destination,identity:id,destination,operationHash:commitment,
   destinationSigningSeed:args.destinationSigningSeed,nextRecoverySecret:args.nextRecoverySecret,nextRecoverySigningSeed:args.nextRecoverySigningSeed});
  expect(fs.readFileSync(file(),'utf8')).not.toContain(seen[0].slice(2));
  if(fail)throw Error('lost reply');
  return {phase:'register_owner',kernel:destination,executor:destination,authority:destination,manifestHash:commitment,identity:id,destination,amount:'50',data:'0x',ownerIntent:null};
 });
 const rpc={request:async()=>{throw Error('unexpected RPC');}};
 const network:OwnerChainNetwork={rpcs:[rpc,rpc],deployment:async()=>{throw Error('unexpected deployment');}};
 const request={directory,passphrase,destination,network,entitlement:{identity:id,amount:'50',commitment,proof:[]}};
 await expect(prepareAgentBreakRecovery(request)).rejects.toThrow('lost reply');
 await expect(prepareAgentBreakRecovery({...request,destination:`0x${'66'.repeat(20)}`})).rejects.toThrow('destination_changed');
 fail=false;expect((await prepareAgentBreakRecovery(request)).phase).toBe('register_owner');expect(seen[1]).toBe(seen[0]);
 expect(fs.readFileSync(keystoreFile,'utf8')).toBe(original);
});

it('activates only after verified restoration, durably retains every key and can resume activation after a lost reply',async()=>{
 await provisionBreakRecovery(input());
 const keystoreFile=path.join(directory,'agent-keystore.json');
 saveKeystore(encryptKeystore({...generateAgentKeyPair(),walletId:'wallet_aw_break_test',passphrase,
  recoverySecret:'44'.repeat(32),recoverySigningSeed:'55'.repeat(32),kdfParams:{N:1024,r:8,p:1,dklen:32}}),keystoreFile);
 const original=fs.readFileSync(keystoreFile,'utf8');
 let nextCommitment='',expectedSecret='',expectedSigningSeed='';
 const prepared:PreparedBreakRecovery={phase:'restore_balance',kernel:destination,executor:destination,authority:destination,manifestHash:commitment,identity:id,destination,amount:'50',data:'0x',ownerIntent:commitment};
 vi.mocked(prepareBreakRecovery).mockImplementation(async args=>{
  if (!nextCommitment) {
    nextCommitment=recoveryCommitment(args.nextRecoverySecret,await recoverySigningRoot(args.nextRecoverySigningSeed));
    expectedSecret=hexlify(args.nextRecoverySecret);expectedSigningSeed=hexlify(args.nextRecoverySigningSeed);
  } else if(args.entitlement.commitment===commitment) {
    expect(hexlify(args.recoverySecret)).toBe(derivedSecret);expect(hexlify(args.recoverySigningSeed)).toBe(derivedSeed);
  } else {
    expect(hexlify(args.recoverySecret)).toBe(expectedSecret);expect(hexlify(args.recoverySigningSeed)).toBe(expectedSigningSeed);
  }
  await args.persistBeforePublishing({kernel:destination,identity:id,destination,operationHash:commitment,
   destinationSigningSeed:args.destinationSigningSeed,nextRecoverySecret:args.nextRecoverySecret,nextRecoverySigningSeed:args.nextRecoverySigningSeed});
  return prepared;
 });
 const rpc={request:async()=>{throw Error('unexpected RPC');}};
 const network:OwnerChainNetwork={rpcs:[rpc,rpc],deployment:async()=>{throw Error('unexpected deployment');}};
 await prepareAgentBreakRecovery({directory,passphrase,destination,network,entitlement:{identity:id,amount:'50',commitment,proof:[]}});
 const before=fs.readFileSync(file(),'utf8'),transactionHash=`0x${'77'.repeat(32)}`;
 const complete={...input(),transactionHash,network};
 vi.mocked(verifyBreakRecoveryReceipt).mockRejectedValueOnce(Error('unfinalized'));
 await expect(completeAgentBreakRecovery(complete)).rejects.toThrow('unfinalized');
 expect(readActiveHashWallet(directory)).toBeNull();expect(fs.readFileSync(file(),'utf8')).toBe(before);
 vi.mocked(verifyBreakRecoveryReceipt).mockResolvedValue(undefined);
 const active=await completeAgentBreakRecovery(complete);
 expect(verifyBreakRecoveryReceipt).toHaveBeenLastCalledWith(prepared,transactionHash,network);
 expect(readActiveHashWallet(directory)).toEqual(active);expect(await completeAgentBreakRecovery(complete)).toEqual(active);
 expect(fs.readFileSync(keystoreFile,'utf8')).toBe(original);expect((await provisionBreakRecovery(input())).signingRoot).toMatch(/^0x[0-9a-f]{64}$/);
 await expect(completeAgentBreakRecovery({...complete,transactionHash:`0x${'88'.repeat(32)}`})).rejects.toThrow('receipt_changed');
 expect(readActiveHashWallet(directory)).toEqual(active);
 // A later cryptographic break uses the active recovery generation, not the
 // preserved EOA's original secret. Provisioning never overwrites either.
 const secondContext=`0x${'88'.repeat(20)}`;
 vi.mocked(readBreakRecoveryContext).mockResolvedValue(secondContext);
 await provisionBreakRecovery({...input(),commitment:nextCommitment,context:secondContext});
 await prepareAgentBreakRecovery({directory,passphrase,destination,network,entitlement:{identity:id,amount:'50',commitment:nextCommitment,proof:[]}});
 // A new break whose last-good snapshot precedes the first restoration needs
 // the old commitment but a fresh destination journal, never the old account.
 const rollbackContext=`0x${'99'.repeat(20)}`;
 const fresh=await provisionBreakRecovery({...input(),context:rollbackContext});
 expect(fresh.signingRoot).not.toBe((await provisionBreakRecovery(input())).signingRoot);
 vi.mocked(readBreakRecoveryContext).mockResolvedValue(rollbackContext);
 await prepareAgentBreakRecovery({directory,passphrase,destination,network,entitlement:{identity:id,amount:'50',commitment,proof:[]}});
 expect(readActiveHashWallet(directory)).toEqual(active);expect(fs.readFileSync(keystoreFile,'utf8')).toBe(original);
});

it('reserves one exact hash-wallet spend, keeps the next seed on retry and advances it even when the target fails',async()=>{
 const root=await provisionBreakRecovery(input());
 saveKeystore(encryptKeystore({...generateAgentKeyPair(),walletId:'wallet_aw_break_test',passphrase,
  recoverySecret:'44'.repeat(32),recoverySigningSeed:'55'.repeat(32),kdfParams:{N:1024,r:8,p:1,dklen:32}}),path.join(directory,'agent-keystore.json'));
 vi.mocked(prepareBreakRecovery).mockImplementation(async args=>{
  await args.persistBeforePublishing({kernel:destination,identity:id,destination,operationHash:commitment,
   destinationSigningSeed:args.destinationSigningSeed,nextRecoverySecret:args.nextRecoverySecret,nextRecoverySigningSeed:args.nextRecoverySigningSeed});
  return {phase:'restore_balance',kernel:destination,executor:destination,authority:destination,manifestHash:commitment,identity:id,destination,amount:'50',data:'0x',ownerIntent:commitment};
 });
 const rpc={request:async()=>{throw Error('unexpected RPC');}};
 const network:OwnerChainNetwork={rpcs:[rpc,rpc],deployment:async()=>{throw Error('unexpected deployment');}};
 await prepareAgentBreakRecovery({directory,passphrase,destination,network,entitlement:{identity:id,amount:'50',commitment,proof:[]}});
 vi.mocked(verifyBreakRecoveryReceipt).mockResolvedValue(undefined);
 await completeAgentBreakRecovery({...input(),transactionHash:`0x${'77'.repeat(32)}`,network});
 vi.mocked(assertCurrentProtocolTransaction).mockResolvedValue({manifestHash:commitment} as ProtocolDeployment);
 vi.mocked(readHashAccountState).mockResolvedValue({root:root.signingRoot,nonce:'0',manifestHash:commitment,blockHash:commitment});
 const request={directory,passphrase,network,call:{target:`0x${'88'.repeat(20)}`,value:'0',callGas:'100000',data:'0x'}};
 vi.mocked(assertCurrentProtocolTransaction).mockResolvedValueOnce({manifestHash:commitment} as ProtocolDeployment).mockRejectedValueOnce(Error('pointer changed after persistence'));
 await expect(prepareActiveHashWalletOperation(request)).rejects.toThrow('pointer changed after persistence');
 const discovered=await pendingActiveHashWalletOperations({directory,passphrase});
 expect(discovered.operation).not.toBeNull();const operation=discovered.operation!;
 const retry=await prepareActiveHashWalletOperation(request);
 expect(retry.nextCommitment).toBe(operation.nextCommitment);expect(retry.nonce).toBe('0');
 await expect(prepareActiveHashWalletOperation({...request,call:{...request.call,value:'1'}})).rejects.toThrow('exact_operation_pending');
 const transactionHash=`0x${'99'.repeat(32)}`;
 vi.mocked(verifyHashAccountVariantReceipt).mockRejectedValueOnce(Error('not finalized'));
 await expect(completeActiveHashWalletOperation({directory,passphrase,network,transactionHash})).rejects.toThrow('not finalized');
 vi.mocked(verifyHashAccountVariantReceipt).mockImplementation(async operations=>({operation:operations[0],outcome:'target_failed'}));
 expect(await completeActiveHashWalletOperation({directory,passphrase,network,transactionHash})).toBe('target_failed');
 expect(await completeActiveHashWalletOperation({directory,passphrase,network,transactionHash})).toBe('target_failed');
 expect(fs.readdirSync(path.join(directory,'hash-wallet-history'))).toHaveLength(1);
 expect(await readActiveHashWalletDelivery({directory,passphrase})).toMatchObject({operation:retry,cancellation:null,completed:{transactionHash,outcome:'target_failed'}});
 vi.mocked(readHashAccountState).mockResolvedValue({root:operation.nextCommitment,nonce:'1',manifestHash:commitment,blockHash:commitment});
 const next=await prepareActiveHashWalletOperation(request);expect(next.signingRoot).toBe(operation.nextCommitment);expect(next.nonce).toBe('1');
 expect(await readActiveHashWalletDelivery({directory,passphrase,operationId:hashDeliveryId(retry)})).toMatchObject({operation:retry,completed:{transactionHash,outcome:'target_failed'}});
 expect(await readActiveHashWalletDelivery({directory,passphrase,operationId:hashDeliveryId(next)})).toMatchObject({operation:next,completed:null});
 vi.mocked(assertCurrentProtocolTransaction).mockRejectedValueOnce(Error('retired'));
 await expect(prepareActiveHashWalletOperation(request)).rejects.toThrow('retired');
 // A retirement cannot strand the reserved nonce. Both exact variants remain
 // discoverable, and cancellation uses the original durable successor key.
 const cancel=await cancelActiveHashWalletOperation({directory,passphrase,network});
 expect(cancel.nonce).toBe(next.nonce);expect(cancel.nextCommitment).toBe(next.nextCommitment);
 expect(cancel.target).toBe(destination);expect(cancel.value).toBe('0');expect(cancel.data).toBe('0x');
 await prepareActiveHashWalletOperation(request); // Original retry must retain published cancellation.
 const pending=await pendingActiveHashWalletOperations({directory,passphrase});
 expect(pending.operation).toEqual(next);expect(pending.cancellation).toEqual(cancel);
 vi.mocked(verifyHashAccountVariantReceipt).mockImplementation(async operations=>({operation:operations[1],outcome:'succeeded'}));
 expect(await completeActiveHashWalletOperation({directory,passphrase,network,transactionHash:`0x${'aa'.repeat(32)}`})).toBe('cancelled');
 expect(await pendingActiveHashWalletOperations({directory,passphrase})).toEqual({operation:null,cancellation:null});
 expect(await readActiveHashWalletDelivery({directory,passphrase})).toMatchObject({operation:next,cancellation:cancel,completed:{transactionHash:`0x${'aa'.repeat(32)}`,outcome:'cancelled'}});
 expect(await readActiveHashWalletDelivery({directory,passphrase,operationId:hashDeliveryId(retry)})).toMatchObject({operation:retry,completed:{transactionHash,outcome:'target_failed'}});
 const locator=path.join(directory,'hash-wallet-operations',`${hashDeliveryId(retry).slice(2)}.json`),savedLocator=fs.readFileSync(locator,'utf8');
 fs.writeFileSync(locator,JSON.stringify({transactionHash:`0x${'aa'.repeat(32)}`}));
 await expect(readActiveHashWalletDelivery({directory,passphrase,operationId:hashDeliveryId(retry)})).rejects.toThrow('history_invalid');fs.writeFileSync(locator,savedLocator);
 const archive=path.join(directory,'hash-wallet-history',`${id.slice(2)}-${'aa'.repeat(32)}.json`);fs.writeFileSync(archive,'corrupt');
 await expect(readActiveHashWalletDelivery({directory,passphrase})).rejects.toThrow();
}, 30000);
it('selected hash account signs exact membership bytes without curve fallback or key rotation', async () => {
 const rpc={request:async()=>{throw Error('unexpected RPC');}};
 const network:OwnerChainNetwork={rpcs:[rpc,rpc],deployment:async()=>{throw Error('unexpected deployment');}};
 const message=getBytes(`0x${'ab'.repeat(32)}`), args={directory,passphrase,account:destination,message,network};
 expect(await signActiveHashWalletMessage(args)).toBeNull();
 const root=await provisionBreakRecovery(input());
 saveKeystore(encryptKeystore({...generateAgentKeyPair(),walletId:'wallet_aw_break_test',passphrase,
  recoverySecret:'44'.repeat(32),recoverySigningSeed:'55'.repeat(32),kdfParams:{N:1024,r:8,p:1,dklen:32}}),path.join(directory,'agent-keystore.json'));
 vi.mocked(prepareBreakRecovery).mockImplementation(async args=>{
  await args.persistBeforePublishing({kernel:destination,identity:id,destination,operationHash:commitment,
   destinationSigningSeed:args.destinationSigningSeed,nextRecoverySecret:args.nextRecoverySecret,nextRecoverySigningSeed:args.nextRecoverySigningSeed});
  return {phase:'restore_balance',kernel:destination,executor:destination,authority:destination,manifestHash:commitment,identity:id,destination,amount:'50',data:'0x',ownerIntent:commitment};
 });
 await prepareAgentBreakRecovery({directory,passphrase,destination,network,entitlement:{identity:id,amount:'50',commitment,proof:[]}});
 vi.mocked(verifyBreakRecoveryReceipt).mockResolvedValue(undefined);
 await completeAgentBreakRecovery({...input(),transactionHash:`0x${'77'.repeat(32)}`,network});
 const state={root:root.signingRoot,nonce:'0',manifestHash:commitment,blockHash:commitment};
 vi.mocked(readHashAccountState).mockResolvedValue(state);
 const before=fs.readFileSync(file(),'utf8'), signature=getBytes((await signActiveHashWalletMessage(args))!);
 expect(signature).toHaveLength(7888);expect(fs.readFileSync(file(),'utf8')).toBe(before);
 const {slh_dsa_sha2_128s}=await import('@noble/post-quantum/slh-dsa.js');
 expect(slh_dsa_sha2_128s.verify(signature.slice(32),getBytes(hashAccountContractDigest(destination,root.signingRoot,hashMessage(message))),signature.slice(0,32))).toBe(true);
 await expect(signActiveHashWalletMessage({...args,account:`0x${'aa'.repeat(20)}`})).rejects.toThrow('account_changed');
 vi.mocked(readHashAccountState).mockResolvedValueOnce({...state,root:`0x${'bb'.repeat(32)}`});
 await expect(signActiveHashWalletMessage(args)).rejects.toThrow('reconcile_pending_receipt');
 vi.mocked(readHashAccountState).mockResolvedValueOnce(state).mockResolvedValueOnce({...state,nonce:'1'});
 await expect(signActiveHashWalletMessage(args)).rejects.toThrow('state_changed');
},30000);

it('signs a recovered auxiliary binding without selecting it and refuses wrong or changed owner state',async()=>{
 const seed=new Uint8Array(32).fill(0x27),root=await recoverySigningRoot(seed),message=getBytes(commitment);
 await withAgentHashRecoveryRecord({...input(),create:true},async(record,persist)=>{
  record.destination=destination;record.accountSigningSeed=hexlify(seed);persist();
 });
 const state={account:destination,root,nonce:'3',manifestHash:commitment,blockHash:commitment};
 const owner={destination,nonce:4,commitment,signingRoot:root,executor:context,deployment:{manifestHash:commitment} as ProtocolDeployment};
 vi.mocked(readHashAccountState).mockResolvedValue(state);
 vi.mocked(readOwnerChainState).mockResolvedValue(owner);
 const rpc={request:async()=>{throw Error('unexpected RPC');}},network:OwnerChainNetwork={rpcs:[rpc,rpc],deployment:async()=>{throw Error('unexpected deployment');}};
 const args={directory,passphrase,account:destination,binding:id,message,network};
 const before=fs.readFileSync(file(),'utf8'),signature=getBytes((await signBoundHashWalletMessage(args))!);
 expect(readActiveHashWallet(directory)).toBeNull();expect(fs.readFileSync(file(),'utf8')).toBe(before);
 const {slh_dsa_sha2_128s}=await import('@noble/post-quantum/slh-dsa.js');
 expect(slh_dsa_sha2_128s.verify(signature.slice(32),getBytes(hashAccountContractDigest(destination,root,hashMessage(message))),signature.slice(0,32))).toBe(true);
 expect(await signBoundHashWalletMessage({...args,binding:'0x'+'aa'.repeat(32)})).toBeNull();
 vi.mocked(readOwnerChainState).mockResolvedValueOnce({...owner,destination:'0x'+'aa'.repeat(20)});
 await expect(signBoundHashWalletMessage(args)).rejects.toThrow('account_changed');
 vi.mocked(readOwnerChainState).mockResolvedValueOnce(owner).mockResolvedValueOnce({...owner,nonce:5});
 await expect(signBoundHashWalletMessage(args)).rejects.toThrow('state_changed');
 await expect(signBoundHashWalletMessage({...args,passphrase:'wrong TEST ONLY'})).rejects.toThrow();
},30000);

it('durable departure uses the constructor seed after spending rotates and cannot become ordinary identity authority',async()=>{
 const initial=new Uint8Array(32).fill(0x28),later=new Uint8Array(32).fill(0x29),root=await recoverySigningRoot(initial),message=getBytes(commitment);
 await withAgentHashRecoveryRecord({...input(),create:true},async(record,persist)=>{
  record.destination=destination;record.destinationSigningSeed=hexlify(initial);record.accountSigningSeed=hexlify(later);persist();
 });
 const owner={destination,nonce:4,commitment,signingRoot:root,executor:context,deployment:{manifestHash:commitment} as ProtocolDeployment};
 vi.mocked(readHashAccountDepartureRoot).mockResolvedValue({root,manifestHash:commitment});
 vi.mocked(readHashAccountState).mockResolvedValue({root:await recoverySigningRoot(later),nonce:'9',manifestHash:commitment,blockHash:commitment});
 vi.mocked(readOwnerChainState).mockResolvedValue(owner);
 const rpc={request:async()=>{throw Error('unexpected RPC');}},network:OwnerChainNetwork={rpcs:[rpc,rpc],deployment:async()=>{throw Error('unexpected deployment');}};
 const args={directory,passphrase,account:destination,binding:id,message,network};
 const signature=getBytes((await signBoundHashWalletDeparture(args))!);
 const {slh_dsa_sha2_128s}=await import('@noble/post-quantum/slh-dsa.js');
 expect(slh_dsa_sha2_128s.verify(signature.slice(32),getBytes(hashAccountDepartureDigest(destination,root,hashMessage(message))),signature.slice(0,32))).toBe(true);
 expect(slh_dsa_sha2_128s.verify(signature.slice(32),getBytes(hashAccountContractDigest(destination,root,hashMessage(message))),signature.slice(0,32))).toBe(false);
 vi.mocked(readOwnerChainState).mockResolvedValueOnce(owner).mockResolvedValueOnce({...owner,nonce:5});
 await expect(signBoundHashWalletDeparture(args)).rejects.toThrow('state_changed');
 vi.mocked(readHashAccountDepartureRoot).mockResolvedValue({root:await recoverySigningRoot(later),manifestHash:commitment});
 await expect(signBoundHashWalletDeparture(args)).rejects.toThrow('reconcile_pending_receipt');
},30000);
