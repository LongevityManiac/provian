#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256 } from 'ethers';
import { snapshotRpcPort } from './snapshot-cli.mjs';
import { createHashAuthority, onePasswordAuthorityVault } from './hash-authority-vault.mjs';
import { prepareCheckedHashAuthority } from './hash-authority-plan.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
async function main() {
  const [command, vaultName, input, output, ...extra] = process.argv.slice(2);
  if (command === '--help') {
    console.log('hash-authority-cli.mjs provision VAULT PUBLIC_OUTPUT | prepare VAULT REVIEWED_PLAN PUBLIC_OUTPUT\nSeeds stay in 1Password. Prepared calls are public, gas-sponsorable transactions. Prepare sends the executable signature to both RPC operators for eth_call simulation; either operator could sponsor it. The successor signing seed is durably saved before that exposure. This command does not itself submit eth_sendRawTransaction.');
    return;
  }
  if (extra.length || !vaultName || !input || !['provision', 'prepare'].includes(command)
    || (command === 'provision' ? output !== undefined : output === undefined)) throw Error('hash_authority_usage');
  const vault = onePasswordAuthorityVault(vaultName);
  let result;
  if (command === 'provision') result = { schema: 'provian.hash-authority-root.v1', ...await createHashAuthority(vault) };
  else {
    const artifact = JSON.parse(readFileSync(resolve(root, 'contracts/out/ProvianHashAccount.sol/ProvianHashAccount.json'), 'utf8'));
    const port = snapshotRpcPort([process.env.BASE_RPC_URL ?? 'https://mainnet.base.org', process.env.BASE_RPC_URL_SECONDARY ?? process.env.BASE_RPC_SECONDARY_URL ?? 'https://base.drpc.org']);
    const plan = JSON.parse(readFileSync(resolve(input), 'utf8'));
    result = await prepareCheckedHashAuthority(plan, port, keccak256(artifact.deployedBytecode.object), vault);
  }
  writeFileSync(resolve(output ?? input), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ result: command === 'provision' ? 'root_saved' : 'operation_prepared', broadcast: false }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(/^hash_authority_[a-z_]+$/.test(error.message) ? error.message : 'hash_authority_refused'); process.exitCode = 1; });
}
