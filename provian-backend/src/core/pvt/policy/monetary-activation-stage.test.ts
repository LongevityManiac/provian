import crypto from 'crypto';
import type {Firestore} from 'firebase-admin/firestore';
import previousSignature from './fixtures/d554-predecessor-monetary-signature.json';
import {APPROVED_MONETARY_ACTIVATION,monetaryApprovalSigningBytes,APPROVED_MONETARY_ACTIVATION_SIGNATURE} from './approved-monetary-activation-approval';
import {PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256} from './pvt9-approval-manifest.generated';
import {PROPOSED_MONETARY_POLICY_TEMPLATE} from './proposed-monetary-policy';
import {decodeOpenSshEd25519PublicKey,verifySshApprovalSignature,type SshApprovalSignature,type SshApprovalVerifierConfig} from './approval-signature';
import {hashProposedMonetaryPolicyTemplate,memoizeMonetaryActivationForBatch,loadActivatedRuntimeMonetaryPolicy,isValidMonetaryPolicyActivation,stageMonetaryActivation,selectMonetaryActivation,readSelectedMonetaryActivation,loadRuntimeMonetaryPolicy,monetaryActivationStageDocument,type MonetaryPolicyActivationDocument} from './runtime-monetary-policy';
import {readMonetaryActivationDocument} from './monetary-activation-status';
// The existing approval public key is embedded in the shipped SSHSIG. No private
// key or generated fixture approval is involved in these production-path controls.
const bytes=Buffer.from(APPROVED_MONETARY_ACTIVATION_SIGNATURE.armored_signature.replace(/-----[^\n]+-----/g,'').replace(/\s/g,''),'base64');
const publicKey='ssh-ed25519 '+bytes.subarray(14,14+bytes.readUInt32BE(10)).toString('base64');
const config:SshApprovalVerifierConfig={openSshPublicKey:publicKey,publicKeySha256:decodeOpenSshEd25519PublicKey(publicKey).sha256,signerIdentity:APPROVED_MONETARY_ACTIVATION_SIGNATURE.signer_identity,namespace:APPROVED_MONETARY_ACTIVATION_SIGNATURE.namespace};
const current:MonetaryPolicyActivationDocument={schema_version:'pvt-monetary-policy-activation/v1',approval_status:'approved_by_frank',approval_manifest_sha256:PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,approval_signature:APPROVED_MONETARY_ACTIVATION_SIGNATURE,policy_version:PROPOSED_MONETARY_POLICY_TEMPLATE.proposedPolicyVersion,policy_template_sha256:hashProposedMonetaryPolicyTemplate(),effective_at_ms:1785715200000,effective_until_ms:null,activation_scope:'record_and_settlement',automation_generated:false,activated_at_ms:1785715200000,activated_by:'existing-operator'};
const source={...current,policy_template_sha256:'sha256:610a1f08ff18da7e11a3f0adee93c142c8e86d421ceb34e6f10d310129fd8897',approval_signature:previousSignature as SshApprovalSignature};
function database(canonical:unknown,stage:unknown,mutate?:()=>unknown){
 let state=canonical;const snapshot=(id:string)=>({exists:state!==undefined,data:()=>id==='monetary'?state:stage});
 const db={collection:()=>({doc:(id:string)=>({id,get:async()=>snapshot(id)})}),runTransaction:async(fn:(tx:unknown)=>unknown)=>{if(mutate)state=mutate();return fn({get:async(ref:{id:string})=>snapshot(ref.id)});}} as unknown as Firestore;
 return db;
}
describe(' overlapping monetary approval deployment',()=>{
 test('same captured SSHSIG admits new staged policy; RED canonical-only swap invalidates the other revision',()=>{
  expect(isValidMonetaryPolicyActivation(current,config)).toBe(true);
  expect(isValidMonetaryPolicyActivation(source,config)).toBe(false);
  const stage=stageMonetaryActivation(source,current);
  expect(selectMonetaryActivation(source,stage,config)).toBe(current);
  expect(source.policy_template_sha256).toBe('sha256:610a1f08ff18da7e11a3f0adee93c142c8e86d421ceb34e6f10d310129fd8897');
  const oldScope={...APPROVED_MONETARY_ACTIVATION.approved,policy_template_sha256:source.policy_template_sha256};
  const oldRevision=(doc:typeof source)=>doc.policy_template_sha256===oldScope.policy_template_sha256&&verifySshApprovalSignature(monetaryApprovalSigningBytes(oldScope),doc.approval_signature,config);
  expect(verifySshApprovalSignature(monetaryApprovalSigningBytes(oldScope),source.approval_signature,config)).toBe(true);
  expect(oldRevision(source)).toBe(true);expect(oldRevision(current)).toBe(false);
  expect(selectMonetaryActivation(source,undefined,config)).toBe(source);
  expect(selectMonetaryActivation(current,stage,config)).toBe(current);
 });
 test('RED tampered signature, digest, stage source and changed operator bounds cannot admit',()=>{
  const stage=stageMonetaryActivation(source,current);
  for(const corrupt of [{...stage,source_sha256:'changed'},{...stage,activation:{...current,policy_template_sha256:source.policy_template_sha256}},{...stage,activation:{...current,approval_signature:{...current.approval_signature,armored_signature:'tampered'}}},{...stage,activation:{...current,effective_until_ms:current.effective_at_ms+1}}])expect(selectMonetaryActivation(source,corrupt,config)).toBe(source);
  for(const changed of [{...source,approval_status:'disabled'},{...source,effective_until_ms:source.effective_at_ms+1},{...source,activated_by:'changed-operator'}])expect(selectMonetaryActivation(changed,stage,config)).toBe(changed);
  expect(()=>stageMonetaryActivation(source,{...current,effective_until_ms:current.effective_at_ms+1})).toThrow('operational fields');
 });
 test('runtime, startup and classification readers select identical stage; transaction sees a concurrent disable',async()=>{
  const prior={...process.env};try{
   process.env.NODE_ENV='production';process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY=publicKey;process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256=config.publicKeySha256;
   const stage=stageMonetaryActivation(source,current),db=database(source,stage);
   expect(await readSelectedMonetaryActivation(db)).toEqual(current);expect(await readMonetaryActivationDocument(db)).toEqual(current);
   const resolution={status:'known_launch_identifier'} as Parameters<typeof loadRuntimeMonetaryPolicy>[2];
   expect((await loadRuntimeMonetaryPolicy(db,current.effective_at_ms,resolution)).actions.coding_session).toBeDefined();
   expect((await loadRuntimeMonetaryPolicy(database(source,undefined),current.effective_at_ms,resolution)).actions).toEqual({});
   const disabled={...source,approval_status:'disabled'};
   expect(await readSelectedMonetaryActivation(database(source,stage,()=>disabled))).toEqual(disabled);
   expect((await loadRuntimeMonetaryPolicy(database(source,stage,()=>disabled),current.effective_at_ms,resolution)).actions).toEqual({});
   const bounded={...source,effective_until_ms:current.effective_at_ms+1000},activated={...current,effective_until_ms:bounded.effective_until_ms};
   const boundedDb=database(bounded,stageMonetaryActivation(bounded,activated));
   expect((await loadRuntimeMonetaryPolicy(boundedDb,current.effective_at_ms+999,resolution)).actions.coding_session).toBeDefined();
   expect((await loadRuntimeMonetaryPolicy(boundedDb,current.effective_at_ms+1000,resolution)).actions).toEqual({});
   expect(monetaryActivationStageDocument()).toContain(hashProposedMonetaryPolicyTemplate().slice(7));
  }finally{process.env=prior;}
 });
});


describe('batch activation selection', () => {
 const resolution = { status: 'known_launch_identifier' } as Parameters<typeof loadRuntimeMonetaryPolicy>[2];
 const configure = (): void => {
  process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY = publicKey;
  process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256 = config.publicKeySha256;
 };
 const prior = { ...process.env };
 afterEach(() => { process.env = { ...prior }; jest.restoreAllMocks(); });
 function counting(canonical: unknown, stage?: unknown) {
  let value = canonical, reads = 0, fails = false;
  const get = async (id: string) => {
   reads++;
   if (fails) throw Error('unavailable');
   const body = id === 'monetary' ? value : stage;
   return { exists: body !== undefined, data: () => body };
  };
  const db = { collection: () => ({ doc: (id: string) => ({ id, get: () => get(id) }) }),
   runTransaction: async <T>(fn: (tx: { get: (ref: {id: string}) => ReturnType<typeof get> }) => Promise<T>) => fn({ get: ref => get(ref.id) }) } as unknown as Firestore;
  return {db, reads: () => reads, set: (body: unknown) => { value = body; }, fail: (flag: boolean) => { fails = flag; }};
 }
 test('one selected snapshot serves all act times; a new batch observes a disabled policy', async () => {
  configure(); const verify = jest.spyOn(crypto, 'verify'); const h = counting(current); memoizeMonetaryActivationForBatch(h.db);
  expect((await loadActivatedRuntimeMonetaryPolicy(h.db, current.effective_at_ms - 1, resolution)).actions).toEqual({});
  const firstVerificationCount = verify.mock.calls.length; expect(firstVerificationCount).toBeGreaterThan(0);
  for (let i = 0; i < 32; i++) expect((await loadActivatedRuntimeMonetaryPolicy(h.db, current.effective_at_ms, resolution)).actions.coding_session).toBeDefined();
  expect(h.reads()).toBe(1); expect(verify.mock.calls.length).toBe(firstVerificationCount);
  h.set({...current, approval_status: 'disabled'});
  expect((await loadActivatedRuntimeMonetaryPolicy(h.db, current.effective_at_ms, resolution)).actions.coding_session).toBeDefined();
  memoizeMonetaryActivationForBatch(h.db);
  expect((await loadActivatedRuntimeMonetaryPolicy(h.db, current.effective_at_ms, resolution)).actions).toEqual({});
  expect(h.reads()).toBe(2);
 });
 test('RED a mutable source object cannot change the already verified batch snapshot', async () => {
  configure(); const mutable: Record<string, unknown> = {...current}; const h = counting(mutable);
  memoizeMonetaryActivationForBatch(h.db);
  expect((await loadActivatedRuntimeMonetaryPolicy(h.db, current.effective_at_ms, resolution)).actions.coding_session).toBeDefined();
  mutable.approval_status = 'disabled'; mutable.effective_at_ms = current.effective_at_ms + 1000;
  expect((await loadActivatedRuntimeMonetaryPolicy(h.db, current.effective_at_ms, resolution)).actions.coding_session).toBeDefined();
  memoizeMonetaryActivationForBatch(h.db);
  expect((await loadActivatedRuntimeMonetaryPolicy(h.db, current.effective_at_ms, resolution)).actions).toEqual({});
 });
 test('staged selection retains its atomic two-record read and checks every effective-until boundary', async () => {
  configure(); const until = current.effective_at_ms + 1000;
  const canonical = {...source, effective_until_ms: until}, activated = {...current, effective_until_ms: until};
  const h = counting(canonical, stageMonetaryActivation(canonical, activated)); memoizeMonetaryActivationForBatch(h.db);
  expect((await loadActivatedRuntimeMonetaryPolicy(h.db, until - 1, resolution)).actions.coding_session).toBeDefined();
  expect((await loadActivatedRuntimeMonetaryPolicy(h.db, until, resolution)).actions).toEqual({});
  expect(h.reads()).toBe(4);
 });
 test('RED non-batch readers remain live; failed selections cannot become an earning policy', async () => {
  configure(); const live = counting(current);
  await readSelectedMonetaryActivation(live.db); live.set({...current, approval_status: 'disabled'});
  expect((await loadActivatedRuntimeMonetaryPolicy(live.db, current.effective_at_ms, resolution)).actions).toEqual({});
  expect(live.reads()).toBe(2);
  const unavailable = counting(current); unavailable.fail(true); memoizeMonetaryActivationForBatch(unavailable.db);
  expect((await loadActivatedRuntimeMonetaryPolicy(unavailable.db, current.effective_at_ms, resolution)).actions).toEqual({});
  unavailable.fail(false);
  expect((await loadActivatedRuntimeMonetaryPolicy(unavailable.db, current.effective_at_ms, resolution)).actions).toEqual({});
  expect(unavailable.reads()).toBe(1);
  memoizeMonetaryActivationForBatch(unavailable.db);
  expect((await loadActivatedRuntimeMonetaryPolicy(unavailable.db, current.effective_at_ms, resolution)).actions.coding_session).toBeDefined();
  expect(unavailable.reads()).toBe(2);
 });
});
