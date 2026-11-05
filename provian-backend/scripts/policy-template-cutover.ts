import type {GenesisCampaignActivation} from '../src/core/pvt/policy/genesis-policy-engine';
/** Source-bound staging keeps both monetary lanes live across a rolling deployment. */
import {readFileSync} from 'fs';
import {decodeOpenSshEd25519PublicKey} from '../src/core/pvt/policy/approval-signature';
import {hashProposedMonetaryPolicyTemplate, isValidMonetaryPolicyActivation, monetaryActivationStageDocument, stageMonetaryActivation, monetaryActivationSourceHash, type MonetaryPolicyActivationDocument} from '../src/core/pvt/policy/runtime-monetary-policy';
import {APPROVED_MONETARY_ACTIVATION_SIGNATURE} from '../src/core/pvt/policy/approved-monetary-activation-approval';
import {APPROVED_GENESIS_ACTIVATION_SIGNATURE} from '../src/core/pvt/policy/approved-genesis-activation-approval';
import {stageGenesisActivation, genesisActivationStageDocument, genesisActivationSourceHash} from '../src/core/pvt/genesis-activation-store';
import {explainGenesisActivationRefusal} from '../src/core/pvt/genesis-activation-document';
import {shouldPersistGenesisQualification} from '../src/core/pvt/genesis-award-state-machine';
import {scriptDb} from './lib/script-db';

const BEFORE='sha256:cbe39337418064ba3c7a3ecd490d6e2fc3109570fe518ac41b0ff95a88083530';
const AFTER='sha256:8a6390074ac8d6d1530105f473fe0df142e7f1494cb7b23b67ad20720022ac39';
async function main():Promise<void>{
 const stage=process.argv.includes('--stage'), commit=process.argv.includes('--commit');
 if(stage&&commit)throw new Error('Choose stage or canonical cutover');
 if(hashProposedMonetaryPolicyTemplate()!==AFTER)throw new Error('Unexpected template');
 if(!process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY) process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY=readFileSync(process.env.HOME+'/.ssh/provian-pvt-policy.pub','utf8').trim();
 process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256=decodeOpenSshEd25519PublicKey(process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY!).sha256;
 const db=scriptDb(),collection=db.collection('pvt_policy_activations');
 const monetaryRef=collection.doc('monetary'), genesisRef=collection.doc('genesis');
 const [m,g]=await Promise.all([monetaryRef.get(),genesisRef.get()]);
 if(!m.exists||!g.exists)throw new Error('Canonical activation absent');
 const oldM=m.data()!,oldG=g.data()!;
 if(oldM.policy_template_sha256!==BEFORE||oldG.approved_monetary_policy_template_hash!==BEFORE)throw new Error('Unexpected source template');
 const newM={...oldM,policy_template_sha256:AFTER,approval_signature:APPROVED_MONETARY_ACTIVATION_SIGNATURE} as MonetaryPolicyActivationDocument;
 const newG={...oldG,approved_monetary_policy_template_hash:AFTER,approval_signature:APPROVED_GENESIS_ACTIVATION_SIGNATURE} as GenesisCampaignActivation;
 if(!isValidMonetaryPolicyActivation(newM)||explainGenesisActivationRefusal(newG).verdict!=='admits')throw new Error('New activation refused');
 if(isValidMonetaryPolicyActivation({...newM,approval_signature:{...APPROVED_MONETARY_ACTIVATION_SIGNATURE,armored_signature:'invalid'}}))throw new Error('Monetary negative control failed');
 for(const action of ['genesis_signup','genesis_human_signup','genesis_device_link'] as const){
  if(!shouldPersistGenesisQualification(action,newG.effective_at_ms!,newG)||shouldPersistGenesisQualification(action,newG.effective_at_ms!,{...newG,genesis_kill_switch_active:true}))throw new Error('Genesis positive or negative control failed');
 }
 const stagedM=stageMonetaryActivation(oldM as MonetaryPolicyActivationDocument,newM),stagedG=stageGenesisActivation(oldG,newG);
 const msRef=collection.doc(monetaryActivationStageDocument()),gsRef=collection.doc(genesisActivationStageDocument());
 console.log(JSON.stringify({before:BEFORE,after:AFTER,monetaryStage:msRef.path,genesisStage:gsRef.path,signaturesVerified:true,genesisGrantsAdmit:true,mode:stage?'stage':commit?'commit':'verify'}));
 if(!stage&&!commit)return;
 await db.runTransaction(async tx=>{
  const [liveM,liveG,ms,gs]=await Promise.all([tx.get(monetaryRef),tx.get(genesisRef),tx.get(msRef),tx.get(gsRef)]);
  if(monetaryActivationSourceHash(liveM.data())!==monetaryActivationSourceHash(oldM)||genesisActivationSourceHash(liveG.data())!==genesisActivationSourceHash(oldG))throw new Error('Canonical source changed');
  if(stage){tx.set(msRef,stagedM);tx.set(gsRef,stagedG);}
  else{
   if(monetaryActivationSourceHash(ms.data())!==monetaryActivationSourceHash(stagedM)||genesisActivationSourceHash(gs.data())!==genesisActivationSourceHash(stagedG))throw new Error('Exact signed stage missing');
   tx.set(monetaryRef,newM as unknown as FirebaseFirestore.DocumentData);tx.set(genesisRef,newG);
  }
 });
 console.log(stage?'Both signed activations staged; canonical documents unchanged.':'Both canonical activations cut over atomically.');
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
