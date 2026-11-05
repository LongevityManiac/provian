import {protectArchiveGeneration} from './archive-privacy-migration';
import {archivePrivacyKeyHash,createGcsArchiveObjectStore} from './archive-objects';
const key=Buffer.alloc(32,11),source={name:'v2/w/day/part.pea',generation:'100',size:'17',md5Hash:'original-md5',crc32c:'original-crc',storageClass:'ARCHIVE'};
const protectedMeta={...source,generation:'101',customerEncryption:{encryptionAlgorithm:'AES256',keySha256:archivePrivacyKeyHash(key)}};
describe(' immutable Archive bytes with existing-secret at-rest protection',()=>{
 it('RED unprotected header bytes remain readable; generation-pinned two-step migration preserves every proof/checksum and source key',async()=>{
  expect(source).not.toHaveProperty('customerEncryption');
  const requests:any[]=[];
  const result=await protectArchiveGeneration({bucket:'fixture-no-network',path:source.name,metadata:source,key,request:async req=>{requests.push(req);return requests.length===1?{done:false,rewriteToken:'next'}:{done:true,resource:protectedMeta};}});
  expect(result.md5Hash).toBe(source.md5Hash);expect(result.crc32c).toBe(source.crc32c);expect(result.size).toBe(source.size);expect(requests).toHaveLength(2);
  expect(requests.every(req=>req.params.sourceGeneration==='100'&&req.params.ifSourceGenerationMatch==='100'&&req.params.ifGenerationMatch==='100')).toBe(true);
  expect(requests[1].params.rewriteToken).toBe('next');expect(requests[1].headers).toEqual(requests[0].headers);
  expect(requests.every(req=>req.headers['x-goog-copy-source-encryption-key']===undefined)).toBe(true);
  expect(requests.every(req=>Object.keys(req.data).length===0)).toBe(true);
  let secondWrites=0;await protectArchiveGeneration({bucket:'fixture-no-network',path:source.name,metadata:protectedMeta,key,request:async()=>{secondWrites++;throw new Error('must not rewrite');}});expect(secondWrites).toBe(0);
 });
 it.each(['size','md5Hash','crc32c','storageClass'])('RED any altered %s refuses the result, without updating any Archive account',async field=>{
  await expect(protectArchiveGeneration({bucket:'fixture-no-network',path:source.name,metadata:source,key,request:async()=>({done:true,resource:{...protectedMeta,[field]:'corrupted'}})})).rejects.toThrow('integrity_mismatch');
 });
 it('RED metadata without the customer key hides MD5; key-aware stat requires exact protected checksum',async()=>{
  const existing=process.env.RELAY_SIGNING_KEY;process.env.RELAY_SIGNING_KEY='fixture-existing-relay-key';
  const {archivePrivacyKey}=await import('./archive-objects');const realKey=archivePrivacyKey();
  const meta={...source,customerEncryption:{keySha256:archivePrivacyKeyHash(realKey)}};
  let keySet=false;
  const file={setEncryptionKey(k:Buffer){expect(k.equals(realKey)).toBe(true);keySet=true;return this;},async getMetadata(){return [{...meta,md5Hash:keySet?source.md5Hash:undefined}];}};
  try{
   const store=createGcsArchiveObjectStore('fixture',{file:()=>file} as never);
   expect((await store.stat(source.name))?.md5).toBe(source.md5Hash);expect(keySet).toBe(true);
   const missing={...file,async getMetadata(){return [{...meta,md5Hash:undefined}];}};
   await expect(createGcsArchiveObjectStore('fixture',{file:()=>missing} as never).stat(source.name)).rejects.toThrow('protected_checksum_missing');
  }finally{process.env.RELAY_SIGNING_KEY=existing;}
 });
 it('RED a legitimate repeated continuation token must not drop holds, ACL or original generation bindings',async()=>{
  const held={...source,temporaryHold:true,eventBasedHold:true,acl:[{entity:'project-owners-1',role:'OWNER'}],customTime:'2026-10-07T00:00:00Z'};
  const requests:any[]=[];
  await protectArchiveGeneration({bucket:'fixture-no-network',path:source.name,metadata:held,key,request:async req=>{requests.push(req);return requests.length<3?{done:false,rewriteToken:'same-legitimate-token'}:{done:true,resource:{...protectedMeta,temporaryHold:true,eventBasedHold:true}};}});
  expect(requests).toHaveLength(3);
  for(const req of requests){expect(req.data).toEqual({temporaryHold:true,eventBasedHold:true,acl:held.acl,customTime:held.customTime});expect(req.params.sourceGeneration).toBe('100');expect(req.headers).toEqual(requests[0].headers);}
 });

});
