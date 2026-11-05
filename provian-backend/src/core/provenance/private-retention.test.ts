import { createHash, createHmac } from 'crypto';
import { PRIVATE_RETENTION_COLLECTIONS, protectRetainedFields, recoverRetainedFields } from './private-retention';
import { privateOrigin, PRIVATE_FILE } from './origin-capture';
import { verifyGitHubSignature, synthesizeFromGitHubPayload } from '../witnesses/github-webhook';
const guesses=['/Users/frank/secret-project/config.json','/Users/frank/public-project/config.json'];
describe(' private identifier protection with permanent RED controls',()=>{
 it('RED a guess recovers the retired path digest; the device/relay secret MAC does not match any guess',()=>{
  const old=createHash('sha256').update(guesses[0]).digest('hex');
  expect(guesses.find(p=>createHash('sha256').update(p).digest('hex')===old)).toBe(guesses[0]);
  const protectedDigest=privateOrigin(PRIVATE_FILE,guesses[0]).hash;
  expect(guesses.some(p=>'sha256:'+createHash('sha256').update(p).digest('hex')===protectedDigest)).toBe(false);
 });
 it('retained forge repo and branch are protected after original signature verification; RED a modified original fails',()=>{
  const payload={repository:{full_name:'private-owner/private-repo',private:true},after:'a'.repeat(40),before:'b'.repeat(40),ref:'refs/heads/private-branch',head_commit:{id:'a'.repeat(40),message:'private work',added:['secret/path'],modified:[],removed:[]},commits:[{id:'a'.repeat(40),message:'private work',added:['secret/path'],modified:[],removed:[]}]};
  const raw=JSON.stringify(payload),secret='existing-forge-test-secret';
  const signature='sha256='+createHmac('sha256',secret).update(raw).digest('hex');
  expect(verifyGitHubSignature(raw,signature,secret)).toBe(true);
  expect(verifyGitHubSignature(raw+' ',signature,secret)).toBe(false);
  const forge=synthesizeFromGitHubPayload('push',payload);expect(forge).not.toBeNull();
  const retained=protectRetainedFields('meter_relay_acts_v1',{act:{pricing:{metadata:forge!.metadata,input_origins:forge!.input_origins}},accrual:{inputOrigins:forge!.input_origins}});
  expect(JSON.stringify(forge)).toContain('private-owner/private-repo'); // RED old stored format discloses it.
  expect(JSON.stringify(retained)).not.toMatch(/private-owner|private-repo|private-branch|secret\/path/);
  expect(recoverRetainedFields('meter_relay_acts_v1',retained)).toEqual({act:{pricing:{metadata:forge!.metadata,input_origins:forge!.input_origins}},accrual:{inputOrigins:forge!.input_origins}});
  expect(verifyGitHubSignature(raw,signature,secret)).toBe(true);
 });
 it('every retained store protects old private hashes and exact economic seals; RED tampering fails closed',()=>{
  expect(PRIVATE_RETENTION_COLLECTIONS.size).toBe(11);
  const original={actor_id:'actor',timestamp:100, row:{mint_status:'eligible',economic_snapshot:{recordPointsAtomic:'1000000000000000000',recordTimeFactors:{canonicalEventId:'forge:private-owner/private-repo:private-branch'}},economic_snapshot_hash:'sha256:old-exact-snapshot-hash',input_origins:[{origin_identifier:'private_file',hash:'sha256:'+createHash('sha256').update(guesses[0]).digest('hex')}]},metadata:{resource:guesses[0]},origin_identifier:'repo:private-owner/private-repo',hash:'sha256:old-repo-digest'};
  for(const collection of PRIVATE_RETENTION_COLLECTIONS){
   const protectedDoc=protectRetainedFields(collection,original);
   expect(JSON.stringify(protectedDoc)).not.toMatch(/private-owner|private-repo|private-branch|\/Users\/frank/);
   expect(JSON.stringify(protectedDoc)).not.toContain(original.row.input_origins[0].hash);
   expect(protectedDoc.actor_id).toBe('actor');expect(protectedDoc.timestamp).toBe(100);
   expect(recoverRetainedFields(collection,protectedDoc)).toEqual(original);
   expect(protectRetainedFields(collection,protectedDoc)).toEqual(protectedDoc);
   const corrupt=JSON.parse(JSON.stringify(protectedDoc));corrupt.metadata.tag=Buffer.alloc(16).toString('base64');
   expect(()=>recoverRetainedFields(collection,corrupt)).toThrow();
  }
 });
 it('nested Firestore update paths recover under the same context as a full document',()=>{
  const patch=protectRetainedFields('meter_act_keys_v1',{'row.economic_snapshot':{exact:'private:branch'}});
  const full={row:{economic_snapshot:patch['row.economic_snapshot']}};
  expect(recoverRetainedFields('meter_act_keys_v1',full)).toEqual({row:{economic_snapshot:{exact:'private:branch'}}});
 });
});
