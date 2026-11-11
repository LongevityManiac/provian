import { expect, test } from 'vitest';
import { AbiCoder, sha256 } from 'ethers';
import { deriveAddressRecoveryCredential } from './recourse-address-credential';
import { addressRecoveryBinding } from './recourse-address-binding';
import { recoveryCommitment, recoverySigningRoot } from './recourse-hash-authorization';
const domain={chainId:'8453',pointer:`0x${'11'.repeat(20)}`,origin:`0x${'22'.repeat(20)}`};
const root=new Uint8Array(32).fill(91);
test('public binding contains only pointer, chain and one original address',()=>{
 expect(addressRecoveryBinding(domain)).toBe(sha256(AbiCoder.defaultAbiCoder().encode(['string','uint256','address','address'],
  ['Provian address recovery binding',8453,domain.pointer,domain.origin])));
 expect(addressRecoveryBinding({...domain,origin:`0x${'33'.repeat(20)}`})).not.toBe(addressRecoveryBinding(domain));
});
test('same backup reconstructs credentials but every address, chain, pointer and generation separates them',async()=>{
 const first=deriveAddressRecoveryCredential(root,domain,'0');
 expect(deriveAddressRecoveryCredential(root,{...domain},'0')).toEqual(first);
 const credentials=[first,deriveAddressRecoveryCredential(root,domain,'1'),
  deriveAddressRecoveryCredential(root,{...domain,chainId:'31337'},'0'),
  deriveAddressRecoveryCredential(root,{...domain,origin:`0x${'33'.repeat(20)}`},'0'),
  deriveAddressRecoveryCredential(root,{...domain,pointer:`0x${'44'.repeat(20)}`},'0')];
 const outputs=credentials.flatMap(c=>[Buffer.from(c.recoverySecret).toString('hex'),Buffer.from(c.signingSeed).toString('hex')]);
 expect(new Set(outputs).size).toBe(10);
 const commitments=await Promise.all(credentials.map(async c=>recoveryCommitment(c.recoverySecret,await recoverySigningRoot(c.signingSeed))));
 expect(new Set(commitments).size).toBe(5);expect(root).toEqual(new Uint8Array(32).fill(91));
});
test('malformed domains and generations fail before credential derivation',()=>{
 for(const altered of [{chainId:'0'},{chainId:'08453'},{chainId:String(2n**256n)},{pointer:'0x'+'0'.repeat(40)},{origin:'bad'}]) {
  expect(()=>deriveAddressRecoveryCredential(root,{...domain,...altered},'0')).toThrow('domain_invalid');
 }
 for(const generation of ['-1','01',String(2n**256n)]) expect(()=>deriveAddressRecoveryCredential(root,domain,generation)).toThrow('credential_invalid');
 expect(()=>deriveAddressRecoveryCredential(new Uint8Array(16),domain,'0')).toThrow('credential_invalid');
});
