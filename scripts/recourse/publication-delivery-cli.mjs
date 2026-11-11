#!/usr/bin/env -S tsx
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Wallet } from 'ethers';
import { scriptDb } from '../../provian-backend/scripts/lib/script-db.ts';
import { openHashAuthorityOperationStore } from '../../provian-backend/src/core/recourse/hash-authority-operation-store.ts';
import { publicationInputs } from './pointer-publication-cli.mjs';
import { onePasswordAuthorityVault } from './hash-authority-vault.mjs';
import { readPublicationProgress } from './publication-recovery.mjs';
import { runPublicationDelivery } from './publication-runtime.mjs';
const exec = promisify(execFile);
const ensure = (value, reason) => { if (!value) throw Error('publication_delivery_cli_' + reason); };

async function main() {
  const [path, ...flags] = process.argv.slice(2);
  if (path === '--help') {
    console.log('publication-delivery-cli.mjs INPUTS_JSON [--execute] [--watch] [--cancel-gas]\nRequires repository Node20 and provian-backend/node_modules/.bin/tsx. Default is read-only recovery/inspection. Inputs include the pointer-publication input paths plus callGas, gasSigner, signerReference (op://), authorityVault, approvedBudgetWei, maxFeePerGasWei, maxPriorityFeePerGasWei and maxGas. --execute advances durable retirement/publication delivery only after separate public-switch authorization. --watch repeats through finalized completion. --cancel-gas cancels one retained sponsor nonce with a budgeted fee bump, preserving all original bytes; it does not cancel an authority proof. No relay/site/store release or kernel activation.');
    return;
  }
  ensure(path && !path.startsWith('--') && flags.every(flag => ['--execute', '--watch', '--cancel-gas'].includes(flag))
    && new Set(flags).size === flags.length, 'usage');
  const execute = flags.includes('--execute'), watch = flags.includes('--watch'), cancelGas = flags.includes('--cancel-gas');
  ensure(execute || !watch && !cancelGas, 'execution_required');
  const input = JSON.parse(readFileSync(resolve(path), 'utf8'));
  ensure(typeof input.callGas === 'string' && /^[1-9][0-9]*$/.test(input.callGas), 'call_gas');
  ensure(process.env.GOOGLE_CLOUD_PROJECT === 'provian-ai' && process.env.FIRESTORE_DATABASE_ID === 'relay', 'database_selection');
  const inputs = { ...await publicationInputs(input), callGas: input.callGas };
  const db = scriptDb(), store = openHashAuthorityOperationStore(db);
  if (!execute) {
    const progress = await readPublicationProgress(inputs, store);
    console.log(JSON.stringify({ status: progress.outcome.status, revision: progress.outcome.revision,
      publication: progress.outcome.publication, authorityNonce: progress.nonce, retainedOperations: progress.records.length,
      checkpoint: progress.outcome.checkpoint, broadcast: false }));
    return;
  }
  ensure(/^0x[0-9a-f]{40}$/.test(input.gasSigner) && typeof input.signerReference === 'string'
    && input.signerReference.startsWith('op://'), 'signer_configuration');
  const positive = key => { ensure(typeof input[key] === 'string' && /^[1-9][0-9]*$/.test(input[key]), 'fee_configuration'); return BigInt(input[key]); };
  const maxFeePerGas = positive('maxFeePerGasWei'), maxPriorityFeePerGas = positive('maxPriorityFeePerGasWei'), maxGas = positive('maxGas');
  positive('approvedBudgetWei');
  const vault = onePasswordAuthorityVault(input.authorityVault);
  const loadSigner = async address => {
    let result;
    try { result = await exec('op', ['read', input.signerReference], { encoding: 'utf8', timeout: 30000, maxBuffer: 16384 }); }
    catch { throw Error('publication_delivery_cli_key_unavailable'); }
    const key = result.stdout.trim(); ensure(/^(?:0x)?[0-9a-fA-F]{64}$/.test(key), 'key_invalid');
    const signer = new Wallet(key.startsWith('0x') ? key : '0x' + key);
    ensure(signer.address.toLowerCase() === address, 'key_address_changed'); return signer;
  };
  do {
    const result = await runPublicationDelivery({ inputs, db, from: input.gasSigner, store, vault, loadSigner,
      approvedBudgetWei: input.approvedBudgetWei, maxFeePerGas, maxPriorityFeePerGas, maxGas, cancelGas });
    console.log(JSON.stringify(result));
    if (!watch || result.status === 'confirmed' || cancelGas && result.status === 'advance') return;
    if (result.status !== 'advance') await new Promise(resolve => setTimeout(resolve, 5000));
  } while (true);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(/^publication_delivery_cli_[a-z_]+$/.test(error.message)
    ? error.message : 'publication_delivery_cli_refused'); process.exitCode = 1; });
}
