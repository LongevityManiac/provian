#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Wallet, getBytes } from 'ethers';
import { verifyExerciseMembershipChallenge, verifyExerciseMembershipSignature } from './exercise-membership.mjs';

/** Run on the agent's own machine. Only the public signature is exported;
 * the existing encrypted keystore remains there. Fixed exercise amounts and
 * chain 31337 are checked before any keystore material is accessed. */
export async function signExerciseMembership(challengePath, outputPath, sdkDirectory) {
  const challenge = verifyExerciseMembershipChallenge(JSON.parse(readFileSync(resolve(challengePath), 'utf8')));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const sdk = resolve(sdkDirectory ?? resolve(root, 'provian-agent-sdk/dist'));
  const { loadKeystore, decryptKeystore } = await import(pathToFileURL(resolve(sdk, 'keystore.js')).href);
  const { readLocalKeystoreSecret } = await import(pathToFileURL(resolve(sdk, 'local-keystore-secret.js')).href);
  const keystore = loadKeystore(), passphrase = process.env.PROVIAN_KEYSTORE_PASSPHRASE ?? readLocalKeystoreSecret();
  if (!keystore || !passphrase) throw Error('exercise_agent_keystore_unavailable');
  const material = decryptKeystore(keystore, passphrase);
  const wallet = new Wallet(material.privateKey.startsWith('0x') ? material.privateKey : '0x' + material.privateKey);
  if (wallet.address.toLowerCase() !== challenge.account) throw Error('exercise_membership_wrong_wallet');
  const signature = await wallet.signMessage(getBytes(challenge.messageHex));
  verifyExerciseMembershipSignature(challenge, signature);
  writeFileSync(resolve(outputPath), JSON.stringify({ challenge, ownerSignature: signature }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { address: challenge.account, chainId: 31337, method: challenge.method };
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  signExerciseMembership(process.argv[2], process.argv[3], process.argv[4]).then(value => console.log(JSON.stringify(value))).catch(error => {
    console.error(error.message?.startsWith('exercise_') ? error.message : 'exercise_membership_signing_failed'); process.exitCode = 1;
  });
}
