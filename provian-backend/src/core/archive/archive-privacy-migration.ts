/** Operator-only at-rest representation migration; no upload, reservation, purchase or accounting. */
import {archivePrivacyKeyHash} from './archive-objects';
export interface RewriteRequest {url:string;method:'POST';params:Record<string,string>;headers:Record<string,string>;data:Record<string,unknown>}
export interface RewriteResponse {done?:boolean;rewriteToken?:string;resource?:Record<string,any>}
export async function protectArchiveGeneration(args:{bucket:string;path:string;metadata:Record<string,any>;key:Buffer;request:(req:RewriteRequest)=>Promise<RewriteResponse>}):Promise<Record<string,any>>{
 const {bucket,path,metadata:source,key,request}=args;
 const hash=archivePrivacyKeyHash(key);
 if(source.customerEncryption){
  if(source.customerEncryption.keySha256!==hash)throw new Error('archive_source_key_version_unavailable');
  return source; // already protected: no physical generation change
 }
 if(!source.generation||!source.crc32c||!source.size)throw new Error('archive_source_integrity_metadata_missing');
 const base={sourceGeneration:String(source.generation),ifSourceGenerationMatch:String(source.generation),ifGenerationMatch:String(source.generation)};
 const headers={'x-goog-encryption-algorithm':'AES256','x-goog-encryption-key':key.toString('base64'),'x-goog-encryption-key-sha256':hash};
 const url='https://storage.googleapis.com/storage/v1/b/'+encodeURIComponent(bucket)+'/o/'+encodeURIComponent(path)+'/rewriteTo/b/'+encodeURIComponent(bucket)+'/o/'+encodeURIComponent(path);
 let token:string|undefined;
 const deadline=Date.now()+15*60*1000;
 const preserved=Object.fromEntries(['acl','temporaryHold','eventBasedHold','retention','customTime'].filter(field=>source[field]!==undefined).map(field=>[field,source[field]]));
 for(;;){
  // Each token request repeats exactly the original source and destination bindings. No SDK File.copy recursion.
  const response=await request({url,method:'POST',params:{...base,...(token?{rewriteToken:token}:{})},headers:{...headers},data:preserved});
  if(response.done){
   const result=response.resource;
   if(!result||result.name!==path||String(result.size)!==String(source.size)||result.crc32c!==source.crc32c||
    (source.md5Hash!==undefined&&result.md5Hash!==source.md5Hash)||result.storageClass!==source.storageClass||result.customerEncryption?.keySha256!==hash)
    throw new Error('archive_representation_integrity_mismatch');
   return result;
  }
  if(!response.rewriteToken||Date.now()>deadline)throw new Error('archive_rewrite_progress_invalid');
  token=response.rewriteToken;
 }
}
