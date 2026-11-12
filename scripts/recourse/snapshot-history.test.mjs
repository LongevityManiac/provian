import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, AbiCoder, ZeroHash, sha256 } from 'ethers';
import { inheritedMonetaryHistory } from './snapshot-history.mjs';
import { merkle, historyLeaf, batchLeaf, verifyProof } from './snapshot.mjs';
const coder=AbiCoder.defaultAbiCoder(),h=x=>sha256(Buffer.from(x)),a=n=>`0x${n.toString(16).padStart(40,'0')}`;
const iface=new Interface(JSON.parse(readFileSync(new URL('../../contracts/out/ProvianRecourseKernel.sol/ProvianRecourseKernel.json',import.meta.url))).abi);
const historyAbi=new Interface(JSON.parse(readFileSync(new URL('../../contracts/out/ProvianRecoveryHistory.sol/ProvianRecoveryHistory.json',import.meta.url))).abi);
function fixture(){
 const record={settled:true,lane:1,epoch:0,finalizedCursorStart:0,finalizedCursorEnd:1,policyHash:h('policy'),claimsHash:h('claims'),
 settlementDigest:h('digest'),grossInput:75,totalMinted:75,contributorTotal:73,provianTotal:1,foundationTotal:1,recipientCount:1,claimCount:1};
 const prior={format:'provian-succession-snapshot',predecessor:a(1),block:10,history:[],historyCount:4};
 prior.history=[{type:'batch',key:h('batch'),record,leaf:batchLeaf(a(1),10,h('batch'),coder.encode([iface.getFunction('getBatchRecord').outputs[0]],[record]))},
 ...[0,1,2].map(kind=>({type:'entry',kind,key:h('entry'+kind),value:kind===2?'75':'1',leaf:historyLeaf(a(1),10,kind,h('entry'+kind),kind===2?75:1)}))];
 const verifier={verifier:a(8),configurationId:h('verifier'),version:1};
 prior.state={epochZeroStartsAt:1,genesisStartsAt:1,genesisEndsAt:100,genesisClosed:false,genesisCutoff:0,lastOpenedEpoch:0,nextCursor:1,
 administrativeHold:true,mintRate:1,agentFoundationBps:50,genesisCap:100,combinedCap:100,epochGenesisIssued:75,epochTotalIssued:75,
 schedules:[],epochs:[],provianTreasury:a(9),foundationTreasury:a(10),beneficiaryVerifier:verifier,eligibilityVerifier:verifier,economicRoot:ZeroHash,economicCount:0};
 const tree=merkle(prior.history.map(e=>e.leaf));prior.historyRoot=tree.root;prior.history=prior.history.map((e,i)=>({...e,proof:tree.proofs[i]}));
 const chain={root:tree.root,entryCount:4n,predecessor:a(1),lastGoodBlock:10n,complete:true,baseState:structuredClone(prior.state)};
 const facts={getBatchRecord:iface.decodeFunctionResult('getBatchRecord',iface.encodeFunctionResult('getBatchRecord',[record]))[0],
 claimSettled:true,genesisAnchorUsed:true,genesisWalletGrossIssued:100n};
 const input={prior,historyAddress:a(2),blockHash:h('block'),iface,predecessor:a(3),block:20,
 port:{async call(target,data){assert.equal(target,a(2));const f=historyAbi.parseTransaction({data});return historyAbi.encodeFunctionResult(f.name,[chain[f.name]]);}},
 async read(name){return facts[name];}};
 return{input,chain,facts};
}
test('inherited monetary history is enumerated only from complete root-bound artifacts and cumulative wallets stay current',async()=>{
 const f=fixture(),out=await inheritedMonetaryHistory(f.input);
 assert.equal(out.minted,75n);assert.equal(out.entries.length,3);assert.equal(out.claims.size,1);assert.equal(out.anchors.size,1);assert.equal(out.wallets.size,1);assert.equal(out.batches.size,1);
 assert.equal(out.entries[0].record.settlementDigest,h('digest'));
 assert.equal(out.entries[1].leaf,historyLeaf(a(3),20,0,h('entry0'),1));
 const tree=merkle(out.entries.map(e=>e.leaf));out.entries.forEach((e,i)=>assert.ok(verifyProof(e.leaf,tree.proofs[i],tree.root)));
});
test('missing artifact, truncated history, wrong predecessor, proof, consumed state or cumulative issuance are refused',async()=>{
 for(const mutate of [f=>f.input.prior=undefined,f=>f.input.prior.history.pop(),f=>f.chain.root=ZeroHash,
 f=>f.chain.predecessor=a(9),f=>f.chain.complete=false,f=>f.facts.claimSettled=false,f=>f.facts.genesisAnchorUsed=false,
 f=>f.facts.genesisWalletGrossIssued=1n,f=>f.input.prior.history[0].record.totalMinted=76,
 f=>f.input.prior.history[1].proof=[ZeroHash],f=>f.input.prior.state.mintRate=2]){
 const f=fixture();mutate(f);await assert.rejects(inheritedMonetaryHistory(f.input),/snapshot_/);
 }
});
