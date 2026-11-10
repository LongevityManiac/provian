import { Wallet, TypedDataEncoder } from 'ethers';
import { recoverCurrentRecoverySigner } from './recovery-current-signer';
import { RECOVERY_DOMAIN, RECOVERY_TYPES, RECOVERY_PURPOSE } from './recovery-eip712';
const wallet = new Wallet(`0x${'11'.repeat(32)}`);
const message = {user:wallet.address,timestamp:123456,purpose:RECOVERY_PURPOSE};
test.each(['0x',`0xef0100${'22'.repeat(20)}`])('retains curve ownership for ordinary and delegated EOAs: %s',async runtime=>{
  const signature = await wallet.signTypedData(RECOVERY_DOMAIN,RECOVERY_TYPES,message), verifyHash=jest.fn();
  await expect(recoverCurrentRecoverySigner(message,signature,{code:async()=>runtime,verifyHash})).resolves.toBe(wallet.address.toLowerCase());
  expect(verifyHash).not.toHaveBeenCalled();
});
test('hash accounts verify the pinned typed digest and cannot use a valid curve signature at the same address',async()=>{
  const signature = `0x${'33'.repeat(7888)}`, verifyHash=jest.fn(async(_a:string,_d:string,s:string)=>{
    if(s!==signature)throw Error('invalid_hash_proof');
  });
  await expect(recoverCurrentRecoverySigner(message,signature,{code:async()=>'0x6000',verifyHash})).resolves.toBe(wallet.address.toLowerCase());
  expect(verifyHash).toHaveBeenCalledWith(wallet.address.toLowerCase(),TypedDataEncoder.hash(RECOVERY_DOMAIN,RECOVERY_TYPES,message),signature);
  const curve=await wallet.signTypedData(RECOVERY_DOMAIN,RECOVERY_TYPES,message);
  await expect(recoverCurrentRecoverySigner(message,curve,{code:async()=>'0x6000',verifyHash})).rejects.toThrow('invalid_hash_proof');
});
test('unknown code, unavailable chain evidence and malformed proofs never fall back to a curve key',async()=>{
  const curve=await wallet.signTypedData(RECOVERY_DOMAIN,RECOVERY_TYPES,message), denied=jest.fn(async()=>{throw Error('unverified');});
  await expect(recoverCurrentRecoverySigner(message,curve,{code:async()=>'0x6001',verifyHash:denied})).rejects.toThrow('unverified');
  await expect(recoverCurrentRecoverySigner(message,curve,{code:async()=>{throw Error('disagreement');},verifyHash:denied})).rejects.toThrow('disagreement');
  await expect(recoverCurrentRecoverySigner(message,'0x12',{code:async()=>'0x',verifyHash:denied})).rejects.toThrow('signature_invalid');
});
