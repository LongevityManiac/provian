import {describe,it,expect} from 'vitest';
import {sealRelayPrivateRequest} from './relay-private-request';
import {privacyTestFetch,openPrivacyTestRequest,PRIVACY_TEST_ENV} from './relay-private-request.test-support';
import {openRelayPrivateRequest} from '../../provian-backend/src/core/meter/relay-private-request';
import {sealPrivatePricing} from './meter/private-pricing';
import {openPrivateAuthenticatedRequest} from '../../provian-backend/src/core/meter/private-pricing';
const secret='existing-device-secret-fixture',path='/v1/pe/submit-sovereign';
describe(' private requests outside batch ingress',()=>{
 it('RED old signed hardware body exposes private identifiers; sealed body opens to exact original bindings',async()=>{
  const request={occurrence_id:'/workspace/private-project/main',input_origins:[{origin_identifier:'repo:private-company/repo@branch'}],hardware_witness:{scheme:'tpm2_quote',nonce:'original-binding'},signature:'original-EIP191-signature',nonce:'fresh-occurrence-nonce'};
  expect(JSON.stringify(request)).toContain('private-company');
  const fetchFn=privacyTestFetch((async()=>new Response('{}')) as typeof fetch);
  const wire=await sealRelayPrivateRequest('https://relay.test',path,request,secret,fetchFn);
  expect(JSON.stringify(wire)).not.toMatch(/private-company|private-project|original-binding|original-EIP191/);
  expect(openPrivacyTestRequest(wire)).toEqual(request);
  expect(()=>openRelayPrivateRequest(wire,path,{...PRIVACY_TEST_ENV,ATTESTATION_SIGNING_KEY:undefined})).toThrow();
  expect(()=>openRelayPrivateRequest(wire,'/another/path',PRIVACY_TEST_ENV)).toThrow();
  const changed=structuredClone(wire) as any;changed.private_relay_request.data=changed.private_relay_request.data.slice(0,-8)+'AAAAAAAA';
  expect(()=>openPrivacyTestRequest(changed)).toThrow();
  const wrongKid=structuredClone(wire) as any;wrongKid.private_relay_request.kid='another';expect(()=>openPrivacyTestRequest(wrongKid)).toThrow();
 });
 it.each(['/v1/meter/batch-proofs','/v1/meter/mailbox/ack','/v1/archive/device/parts','/v1/agent/wallet/w/present'])('protected %s retains original commitments and rejects wrong path/key/clear overrides',path=>{
  const original={batch_hashes:['dictionary-private-batch-hash'],ids:['dictionary-private-mailbox-id'],part:'owner-encrypted-part-with-original-header',pe_facts:[{private_commitment:'owner-secret',metadata:{repo:'private-repo'}}]};
  expect(JSON.stringify(original)).toContain('private-repo');
  const body={private_request:sealPrivatePricing({request:original},secret,'provian-private-request:v1:'+path)};
  expect(JSON.stringify(body)).not.toMatch(/private-repo|dictionary-private|owner-secret/);
  const req={body:structuredClone(body),originalUrl:path};openPrivateAuthenticatedRequest(req,secret);expect(req.body).toEqual(original);
  expect(()=>openPrivateAuthenticatedRequest({body,originalUrl:path},'wrong-secret')).toThrow();
  expect(()=>openPrivateAuthenticatedRequest({body,originalUrl:'/other'},secret)).toThrow();
  expect(()=>openPrivateAuthenticatedRequest({body:{...body,repo:'clear-override'},originalUrl:path},secret)).toThrow();
 });
 it('mailbox cursor encryption is bound to the original route and rejects additional clear query identifiers',()=>{
  const original={after:'dictionary-private-mailbox-id',limit:'100'},path='/v1/meter/mailbox';
  const query={private_query:JSON.stringify(sealPrivatePricing({request:original},secret,'provian-private-request:v1:'+path))};
  expect(JSON.stringify(query)).not.toContain(original.after);
  const req={query,originalUrl:path};openPrivateAuthenticatedRequest(req,secret);expect(req.query).toEqual(original);
  expect(()=>openPrivateAuthenticatedRequest({query:{...query,after:'clear'},originalUrl:path},secret)).toThrow();
 });
});
