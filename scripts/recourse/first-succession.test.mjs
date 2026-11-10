import { test } from 'vitest';
import assert from 'node:assert/strict';
import {Interface,keccak256} from 'ethers';
import {firstSuccessionInventoryAllowed} from './snapshot-cli.mjs';
const pin={address:'0x'+'11'.repeat(20),runtimeHash:keccak256('0x6000')},hash='0x'+'22'.repeat(32);
const abi=new Interface(['function revision() view returns(uint256)']);
test('first-cutover snapshot requires explicit intent and refuses an already published or substituted pointer',async()=>{
 let code='0x',revision=0n,reads=0;
 const port={code:async(a,h)=>{reads++;assert.equal(a,pin.address);assert.equal(h,hash);return code;},
 call:async(a,d,h)=>{assert.equal(h,hash);return abi.encodeFunctionResult('revision',[revision]);}};
 assert.equal(await firstSuccessionInventoryAllowed({},pin,port,hash),false);assert.equal(reads,0);
 assert.equal(await firstSuccessionInventoryAllowed({firstSuccession:true},pin,port,hash),true);
 code='0x6000';assert.equal(await firstSuccessionInventoryAllowed({firstSuccession:true},pin,port,hash),true);
 revision=1n;await assert.rejects(firstSuccessionInventoryAllowed({firstSuccession:true},pin,port,hash),/already_published/);
 code='0x6001';await assert.rejects(firstSuccessionInventoryAllowed({firstSuccession:true},pin,port,hash),/runtime_mismatch/);
 await assert.rejects(firstSuccessionInventoryAllowed({firstSuccession:true,mode:'cryptographic-break'},pin,port,hash),/invalid/);
});
