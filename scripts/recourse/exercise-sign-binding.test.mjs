import { test, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HDNodeWallet, hexlify, sha256, toUtf8Bytes, verifyMessage } from 'ethers';
import { signExerciseBinding } from './exercise-sign-binding.mjs';

test('agent signs only the fixed isolated binding and never overwrites signed output', async () => {
  const directory=mkdtempSync(join(tmpdir(),'recourse-binding-test-'));
  const key=HDNodeWallet.fromPhrase('test test test test test test test test test test test junk');
  const address=key.address.toLowerCase();
  const challengeFile=join(directory,'challenge.json'), output=join(directory,'signature.json');
  writeFileSync(join(directory,'package.json'),JSON.stringify({type:'module'}));
  writeFileSync(join(directory,'keystore.js'),`export function loadKeystore(){return {}};export function decryptKeystore(){return {privateKey:${JSON.stringify(key.privateKey)}}}`);
  writeFileSync(join(directory,'local-keystore-secret.js'),'export function readLocalKeystoreSecret(){return "TEST ONLY"}');
  const hash=sha256(toUtf8Bytes('TEST ONLY'));
  const binding={account:address,kernel:'0x0000000000000000000000000000000000000001',
    identity:sha256(toUtf8Bytes('EXERCISE ONLY: wallet identity '+address)),recoveryCommitment:hash,signingRoot:hash,nonce:hash,expiresAtMs:'1900000000000'};
  const message=['Provian ownership binding','chain:31337','kernel:'+binding.kernel,'identity:'+binding.identity,'address:'+address,
    'recovery:'+hash,'hash-authority:'+hash,'nonce:'+hash,'expires:'+binding.expiresAtMs].join('\n');
  const challenge={binding,revision:'1',messageHex:hexlify(toUtf8Bytes(message))};
  try {
    writeFileSync(challengeFile,JSON.stringify({...challenge,messageHex:hexlify(toUtf8Bytes(message.replace('chain:31337','chain:8453')))}));
    await expect(signExerciseBinding(challengeFile,output,directory)).rejects.toThrow('exercise_binding_message_changed');
    writeFileSync(challengeFile,JSON.stringify({...challenge,binding:{...binding,identity:hash}}));
    await expect(signExerciseBinding(challengeFile,output,directory)).rejects.toThrow('exercise_identity_invalid');
    writeFileSync(challengeFile,JSON.stringify(challenge));
    expect(await signExerciseBinding(challengeFile,output,directory)).toEqual({address,chainId:31337});
    const signed=JSON.parse(readFileSync(output,'utf8'));
    expect(verifyMessage(message,signed.ownerSignature).toLowerCase()).toBe(address);
    expect(readFileSync(output,'utf8')).not.toContain(key.privateKey);
    await expect(signExerciseBinding(challengeFile,output,directory)).rejects.toThrow('EEXIST');
  } finally {rmSync(directory,{recursive:true,force:true});}
});
