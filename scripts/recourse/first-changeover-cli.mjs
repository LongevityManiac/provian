#!/usr/bin/env -S tsx
import { assertBaseTransactionGasLimit } from './transaction-gas-limit.mjs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Wallet } from 'ethers';
import { scriptDb } from '../../provian-backend/scripts/lib/script-db.ts';
import { openHashAuthorityOperationStore } from '../../provian-backend/src/core/recourse/hash-authority-operation-store.ts';
import { snapshotRpcPort } from './snapshot-cli.mjs';
import { readSuccessorArtifacts } from './successor-preflight.mjs';
import { verifiedRule } from './pointer-publication-cli.mjs';
import { onePasswordAuthorityVault } from './hash-authority-vault.mjs';
import { runChangeoverStage } from './changeover-runtime.mjs';
import { runPublicationDelivery } from './publication-runtime.mjs';
import { openChangeoverArtifacts } from './changeover-artifacts.mjs';
import { advanceFirstChangeover } from './first-changeover.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = path => JSON.parse(readFileSync(resolve(path), 'utf8'));
const exec = promisify(execFile);
const ensure = (value, reason) => { if (!value) throw Error('first_changeover_cli_' + reason); };
const phases = ['retirement', 'pointer', 'successor', 'publication', 'activation'];

/** All spending limits are mandatory, even during preparation. They become
 * immutable configuration, so a restart cannot silently increase its budget. */
export function deliveryLimits(input) {
  const positive = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
  ensure(phases.every(phase => positive(input.approvedBudgetsWei?.[phase]))
    && Object.keys(input.approvedBudgetsWei).sort().join(',') === [...phases].sort().join(','), 'budgets');
  ensure(['maxFeePerGasWei', 'maxPriorityFeePerGasWei', 'maxGas'].every(key => positive(input[key]))
    && BigInt(input.maxFeePerGasWei) >= BigInt(input.maxPriorityFeePerGasWei), 'fees');
  assertBaseTransactionGasLimit(BigInt(input.maxGas));
  ensure(/^0x[0-9a-f]{40}$/.test(input.gasSigner), 'gas_signer');
  return structuredClone({ approvedBudgetsWei: input.approvedBudgetsWei, gasSigner: input.gasSigner,
    maxFeePerGasWei: input.maxFeePerGasWei, maxPriorityFeePerGasWei: input.maxPriorityFeePerGasWei, maxGas: input.maxGas });
}
export async function runFirstChangeoverCli(path, flags = []) {
  ensure(flags.every(flag => ['--execute', '--watch'].includes(flag)) && new Set(flags).size === flags.length
    && (!flags.includes('--watch') || flags.includes('--execute')), 'usage');
  const execute = flags.includes('--execute'), input = read(path), limits = deliveryLimits(input);
  const deployment = read(resolve(root, 'contracts/deployments/base-pvt9-institutions.json'));
  ensure(typeof input.stateDirectory === 'string' && input.stateDirectory.length > 0, 'state_directory');
  for (const address of new Set([deployment.wiring.admin.toLowerCase(), input.deployer, input.gasSigner])) {
    ensure(/^0x[0-9a-f]{40}$/.test(address) && typeof input.signerReferences?.[address] === 'string'
      && input.signerReferences[address].startsWith('op://'), 'signer_reference');
  }
  const inputs = { deployment, artifacts: readSuccessorArtifacts(root), pointerPlan: read(input.pointerPlanPath),
    pin: read(resolve(root, 'config/protocol-pointer.json')), rule: await verifiedRule(input.signedRulePath),
    legacyTokens: read(resolve(root, 'config/pvt9-base.json')).validation.forbidden_pvt_addresses,
    deployer: input.deployer, identityAttestor: input.identityAttestor, batchApprover: input.batchApprover, submitter: input.submitter,
    importBatchSize: input.importBatchSize, callGas: input.callGas, executionLimits: limits,
    port: snapshotRpcPort([process.env.BASE_RPC_URL ?? 'https://base-rpc.publicnode.com', process.env.BASE_RPC_URL_SECONDARY ?? 'https://base.drpc.org']) };
  const state = openChangeoverArtifacts(input.stateDirectory);
  let database, operationStore;
  const db = () => {
    ensure(process.env.GOOGLE_CLOUD_PROJECT === 'provian-ai' && process.env.FIRESTORE_DATABASE_ID === 'relay', 'database_selection');
    return database ??= scriptDb();
  };
  const store = () => operationStore ??= openHashAuthorityOperationStore(db());
  const authorityStore = { read: slot => store().read(slot), create: (slot, record) => {
    ensure(execute, 'execution_required'); return store().create(slot, record);
  } };
  const loadSigner = async address => {
    ensure(execute, 'execution_required');
    const reference = input.signerReferences[address];
    ensure(typeof reference === 'string' && reference.startsWith('op://'), 'signer_reference');
    let result;
    try { result = await exec('op', ['read', reference], { encoding: 'utf8', timeout: 30000, maxBuffer: 16384 }); }
    catch { throw Error('first_changeover_cli_key_unavailable'); }
    const key = result.stdout.trim(); ensure(/^(?:0x)?[0-9a-fA-F]{64}$/.test(key), 'key_invalid');
    const signer = new Wallet(key.startsWith('0x') ? key : '0x' + key);
    ensure(signer.address.toLowerCase() === address, 'key_address_changed'); return signer;
  };
  const fees = { maxFeePerGas: BigInt(limits.maxFeePerGasWei), maxPriorityFeePerGas: BigInt(limits.maxPriorityFeePerGasWei), maxGas: BigInt(limits.maxGas) };
  const runtime = (stage, options) => {
    ensure(execute || options.requireCompleted, 'execution_required');
    return runChangeoverStage({ ...stage, db: db(), readers: inputs.port.rpcs, loadSigner, ...fees,
      requireCompleted: options.requireCompleted, approvedStageBudgetWei: limits.approvedBudgetsWei[options.phase] });
  };
  const publish = (publication, options) => {
    ensure(execute || options.requireCompleted, 'execution_required');
    return runPublicationDelivery({ inputs: publication, db: db(), from: limits.gasSigner, store: authorityStore,
      vault: onePasswordAuthorityVault(input.authorityVault), loadSigner, ...fees,
      requireCompleted: options.requireCompleted, approvedBudgetWei: limits.approvedBudgetsWei.publication });
  };
  do {
    const result = await advanceFirstChangeover({ inputs, state, execute, runtime, publish, authorityStore });
    console.log(JSON.stringify(result));
    if (!flags.includes('--watch') || result.status === 'confirmed') return result;
    if (result.status !== 'advance') await new Promise(resolve => setTimeout(resolve, 5000));
  } while (true);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [path, ...flags] = process.argv.slice(2);
  if (path === '--help') console.log('first-changeover-cli.mjs INPUTS_JSON [--execute] [--watch]\nDefault prepares and verifies immutable phase artifacts without signing. Explicit --execute requires separate public-switch authorization. Orders predecessor retirement, permanent pointer deployment, balance/history/institution reconstruction, successor deployment, hash-authorized pointer publication, then successor activation. Completed phases reconcile read-only at canonical saved checkpoints. Inputs: stateDirectory, pointerPlanPath, signedRulePath, deployer, identityAttestor, batchApprover, submitter, importBatchSize, callGas, gasSigner, signerReferences (address -> op://), authorityVault, approvedBudgetsWei (retirement/pointer/successor/publication/activation), maxFeePerGasWei, maxPriorityFeePerGasWei, maxGas. Budgets bind before the first action. Never releases relay, website, SDKs or stores.');
  else Promise.resolve().then(() => { ensure(path && !path.startsWith('--'), 'usage'); return runFirstChangeoverCli(path, flags); })
    .catch(error => { console.error(/^first_changeover_cli_[a-z_]+$/.test(error.message) ? error.message : 'first_changeover_cli_refused'); process.exitCode = 1; });
}
