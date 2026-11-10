#!/usr/bin/env node
import { homedir } from 'os';
import * as path from 'path';
import { recoverRecourseAgent } from '../recourse-recovery';
import { readLocalKeystoreSecret } from '../local-keystore-secret';

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log('recover-recourse [--new-recovery]\nRecover the registered agent identity using its encrypted independent recovery secret. Rerun to resume an interrupted recovery. Retired keys remain encrypted for other assets.');
    return;
  }
  const directory = path.join(homedir(), '.provian');
  const passphrase = readLocalKeystoreSecret(path.join(directory, 'agent-keystore.secret'));
  if (!passphrase) throw new Error('Recovery backup unavailable');
  const result = await recoverRecourseAgent({ directory, passphrase,
    relayUrl: process.env.PROVIAN_RELAY_URL ?? 'https://api.provian.ai',
    newRecovery: process.argv.includes('--new-recovery') });
  console.log(`Agent identity recovered to ${result.destination}. Retired keys remain encrypted. This operation does not transfer assets or request a pool determination.`);
}
void main().catch(() => {
  console.error('Recovery could not finish. The encrypted recovery record is retained; rerun to resume.');
  process.exitCode = 1;
});
