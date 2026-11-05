import sourceJson from './fixtures/current-genesis-activation.json';
import {APPROVED_MONETARY_ACTIVATION_SIGNATURE} from './approved-monetary-activation-approval';
import {decodeOpenSshEd25519PublicKey} from './approval-signature';
import {hashProposedMonetaryPolicyTemplate} from './proposed-monetary-policy';
import {PROPOSED_GENESIS_CAMPAIGN_POLICY} from './proposed-genesis-policy';
import {hasGenesisMonetaryBinding} from './genesis-monetary-binding';
import {validateGenesisCampaignActivation,type GenesisCampaignActivation} from './genesis-policy-engine';
import {shouldPersistGenesisQualification} from '../genesis-award-state-machine';
import {explainGenesisActivationRefusal} from '../genesis-activation-document';
const source=sourceJson as GenesisCampaignActivation;
const wire=Buffer.from(APPROVED_MONETARY_ACTIVATION_SIGNATURE.armored_signature.replace(/-----[^\n]+-----/g,'').replace(/\s/g,''),'base64');
const publicKey='ssh-ed25519 '+wire.subarray(14,14+wire.readUInt32BE(10)).toString('base64');
const prior={...process.env};
beforeAll(()=>{process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY=publicKey;process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256=decodeOpenSshEd25519PublicKey(publicKey).sha256;});
afterAll(()=>{process.env=prior;});
describe(' unchanged signed Genesis grants through the exact template transition',()=>{
 test('existing real Genesis SSHSIG admits both template bindings with all fixed grants unchanged',()=>{
  const current={...source,approved_monetary_policy_template_hash:hashProposedMonetaryPolicyTemplate()};
  for(const activation of [current]){
   expect(hasGenesisMonetaryBinding(activation)).toBe(true);
   expect(validateGenesisCampaignActivation(PROPOSED_GENESIS_CAMPAIGN_POLICY,activation)).toBeNull();
   expect(explainGenesisActivationRefusal(activation).verdict).toBe('admits');
   for(const bounty of PROPOSED_GENESIS_CAMPAIGN_POLICY.bounties){
    expect(shouldPersistGenesisQualification(bounty.canonical_bounty_key as 'genesis_signup',source.effective_at_ms!,activation)).toBe(true);
    expect(bounty.fixed_grant_atomic).toBe(bounty.canonical_bounty_key==='genesis_device_link'?'25000000000000000000':'75000000000000000000');
   }
  }
 });
 test('RED unknown predecessor, changed Genesis manifest, signature, kill, cutoff and out-of-window refuse',()=>{
  for(const bad of [{...source,approved_monetary_policy_template_hash:'sha256:'+'f'.repeat(64)},{...source,approved_policy_manifest_hash:'sha256:'+'f'.repeat(64)},{...source,approval_signature:{...source.approval_signature!,armored_signature:'tampered'}},{...source,genesis_kill_switch_active:true}]){
   expect(shouldPersistGenesisQualification('genesis_signup',source.effective_at_ms!,bad)).toBe(false);
   expect(explainGenesisActivationRefusal(bad).verdict).not.toBe('admits');
  }
  expect(shouldPersistGenesisQualification('genesis_signup',PROPOSED_GENESIS_CAMPAIGN_POLICY.window.end_ms!+1,source)).toBe(false);
  const closed={...source,grants_enabled:false,admission_closed_at_ms:source.effective_at_ms!,admission_close_audit_id:'existing-operator-cutoff'};
  expect(shouldPersistGenesisQualification('genesis_signup',source.effective_at_ms!+1,closed)).toBe(false);
  expect(shouldPersistGenesisQualification('genesis_signup',source.effective_at_ms!-1,source)).toBe(false);
 });
});
