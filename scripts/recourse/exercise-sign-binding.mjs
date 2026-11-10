#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Wallet, getAddress, hexlify, sha256, toUtf8Bytes } from 'ethers';

/** Sign only the fixed, chain-31337 exercise binding on the agent's own
 * machine. The existing keystore never leaves that machine. The output is a
 * public, short-lived signature, not a key or reusable relay credential. */
export async function signExerciseBinding(challengePath, outputPath, sdkDirectory) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const sdk = resolve(sdkDirectory ?? resolve(root, 'provian-agent-sdk/dist'));
  const { loadKeystore, decryptKeystore } = await import(pathToFileURL(resolve(sdk, 'keystore.js')).href);
  const { readLocalKeystoreSecret } = await import(pathToFileURL(resolve(sdk, 'local-keystore-secret.js')).href);
  const challenge = JSON.parse(readFileSync(resolve(challengePath), 'utf8'));
  const b = challenge.binding;
  if (!b || typeof b !== 'object' || challenge.revision !== '1'
    || !['identity','recoveryCommitment','signingRoot','nonce'].every(key => /^0x[0-9a-f]{64}$/.test(b[key]))
    || !/^[1-9][0-9]*$/.test(b.expiresAtMs)) throw Error('exercise_binding_invalid');
  const account = getAddress(b.account).toLowerCase(), kernel = getAddress(b.kernel).toLowerCase();
  if (b.identity !== sha256(toUtf8Bytes('EXERCISE ONLY: wallet identity '+account))) throw Error('exercise_identity_invalid');
  const message = ['Provian ownership binding','chain:31337','kernel:'+kernel,'identity:'+b.identity,'address:'+account,
    'recovery:'+b.recoveryCommitment,'hash-authority:'+b.signingRoot,'nonce:'+b.nonce,'expires:'+b.expiresAtMs].join('\n');
  if (challenge.messageHex !== hexlify(toUtf8Bytes(message))) throw Error('exercise_binding_message_changed');
  const keystore = loadKeystore(), passphrase = process.env.PROVIAN_KEYSTORE_PASSPHRASE ?? readLocalKeystoreSecret();
  if (!keystore || !passphrase) throw Error('exercise_agent_keystore_unavailable');
  const material = decryptKeystore(keystore, passphrase);
  const wallet = new Wallet(material.privateKey.startsWith('0x') ? material.privateKey : '0x'+material.privateKey);
  if (wallet.address.toLowerCase() !== account) throw Error('exercise_binding_wrong_wallet');
  const signature = await wallet.signMessage(message);
  writeFileSync(resolve(outputPath), JSON.stringify({ ...challenge, ownerSignature: signature }, null, 2)+'\n',
    { flag: 'wx', mode: 0o600 });
  return { address: account, chainId: 31337 };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  signExerciseBinding(process.argv[2],process.argv[3],process.argv[4]).then(result=>console.log(JSON.stringify(result))).catch(error=>{
    console.error(error.message?.startsWith('exercise_')?error.message:'exercise_binding_signing_failed');process.exitCode=1;
  });
}
