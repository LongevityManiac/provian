import type {Firestore} from 'firebase-admin/firestore';
import {createFakeFirestore} from './__test-helpers__/fake-firestore';
import {hashProposedMonetaryPolicyTemplate} from './policy/proposed-monetary-policy';
import {BOUND_GENESIS_TEMPLATE_SHA256, genesisApprovalSigningBytes, APPROVED_GENESIS_ACTIVATION_SIGNATURE} from './policy/approved-genesis-activation-approval';
import {stageGenesisActivation, selectGenesisActivation, readGenesisActivation, genesisActivationStageDocument} from './genesis-activation-store';
import currentJson from './policy/fixtures/current-genesis-activation.json';
import {shouldPersistGenesisQualification} from './genesis-award-state-machine';
import {decodeOpenSshEd25519PublicKey} from './policy/approval-signature';
import {readFileSync} from 'fs';
import path from 'path';

const current = {...currentJson};
const source = {...current, approved_monetary_policy_template_hash: 'sha256:'+'1'.repeat(64)};
const prior = {...process.env};
beforeAll(()=>{
 const wire=Buffer.from(APPROVED_GENESIS_ACTIVATION_SIGNATURE.armored_signature.replace(/-----[^\n]+-----/g,'').replace(/\s/g,''),'base64');
 const key='ssh-ed25519 '+wire.subarray(14,14+wire.readUInt32BE(10)).toString('base64');
 process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY=key;
 process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256=decodeOpenSshEd25519PublicKey(key).sha256;
});
afterAll(()=>{process.env=prior;});
test('the shipped Genesis signature binds the exact current monetary template',()=>{
 expect(BOUND_GENESIS_TEMPLATE_SHA256).toBe(hashProposedMonetaryPolicyTemplate());
 expect(JSON.parse(genesisApprovalSigningBytes().toString()).monetary_policy_template_sha256).toBe(hashProposedMonetaryPolicyTemplate());
 expect(shouldPersistGenesisQualification('genesis_signup',current.effective_at_ms,current)).toBe(true);
 expect(shouldPersistGenesisQualification('genesis_signup',current.effective_at_ms,{...current,approval_signature:{...current.approval_signature,armored_signature:'invalid'}})).toBe(false);
});
test('staging preserves every operational field and refuses changes to controls, grants or campaign',()=>{
 const stage=stageGenesisActivation(source,current);
 expect(selectGenesisActivation(source,stage)).toEqual(current);
 for(const change of [{genesis_kill_switch_active:true},{grants_enabled:false},{effective_at_ms:1},{ledger_namespace:'other'},{approved_policy_manifest_hash:'different'}]){
  expect(()=>stageGenesisActivation(source,{...current,...change})).toThrow();
  expect(selectGenesisActivation({...source,...change},stage)).toEqual({...source,...change});
 }
 expect(selectGenesisActivation(source,{...stage,source_sha256:'mismatch'})).toEqual(source);
});
test('transactional readers select the stage while canonical retains the prior revision binding',async()=>{
 const fake=createFakeFirestore();const db=fake as unknown as Firestore;
 await db.collection('pvt_policy_activations').doc('genesis').set(source);
 await db.collection('pvt_policy_activations').doc(genesisActivationStageDocument()).set(stageGenesisActivation(source,current));
 expect((await readGenesisActivation(db)).data()).toEqual(current);
 await db.runTransaction(async tx=>{
  expect((await readGenesisActivation(db,tx)).data()).toEqual(current);
 });
 expect((await db.collection('pvt_policy_activations').doc('genesis').get()).data()).toEqual(source);
 await db.collection('pvt_policy_activations').doc('genesis').set({...source,grants_enabled:false});
 expect((await readGenesisActivation(db)).data()?.grants_enabled).toBe(false);
});
test('all grant-ingress and settlement reads use the transactional selector',()=>{
 const root=path.resolve(__dirname);
 const files=['genesis-award-state-machine.ts','genesis-ingress.ts','genesis-retention-backfill.ts','policy/record-path-estimate.ts','../../routes/agent-wallet.ts','../../routes/admin-genesis.ts'];
 for(const name of files){
  const source=readFileSync(path.join(root,name),'utf8');
  expect(source).toContain('readGenesisActivation(');
  expect(source).not.toMatch(/txn\.get\((?:genesisActivationRef|activationRef)\)|activationRef\.get\(\)|\.doc\(GENESIS_ACTIVATION_DOCUMENT\)\s*\.get\(\)/);
 }
});
