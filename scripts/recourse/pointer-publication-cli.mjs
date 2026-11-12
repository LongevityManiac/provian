#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { snapshotRpcPort } from './snapshot-cli.mjs';
import { readSuccessorArtifacts } from './successor-preflight.mjs';
import { preparePointerPublication, verifyPointerPublication } from './pointer-publication.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = path => JSON.parse(readFileSync(resolve(path), 'utf8'));
const ensure = (value, reason) => { if (!value) throw Error('pointer_publication_cli_' + reason); };
const exec = promisify(execFile);
/** Public verification uses the configured approval public key, never the key
 * embedded in an untrusted signature as its own trust anchor. */
export async function verifiedRule(path) {
  const directory = mkdtempSync(join(tmpdir(), 'provian-publication-rule-'));
  try {
    const output = join(directory, 'verified.json');
    await exec(resolve(root, 'provian-backend/node_modules/.bin/tsx'),
      [resolve(root, 'provian-backend/scripts/recourse-membership-rule.ts'), 'verify-signed', resolve(path), output],
      { cwd: root, timeout: 30000, maxBuffer: 16384 });
    return read(output);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
export async function publicationInputs(input) {
  return {
    successor: read(input.successorPlanPath), institutions: read(input.institutionsPath),
    pointerPlan: read(input.pointerPlanPath), operators: read(input.operatorsPath),
    rule: await verifiedRule(input.signedRulePath),
    deployment: read(resolve(root, 'contracts/deployments/base-pvt9-institutions.json')),
    legacyTokens: read(resolve(root, 'config/pvt9-base.json')).validation.forbidden_pvt_addresses,
    pin: read(resolve(root, 'config/protocol-pointer.json')), artifacts: readSuccessorArtifacts(root),
    port: snapshotRpcPort([process.env.BASE_RPC_URL ?? 'https://base-rpc.publicnode.com', process.env.BASE_RPC_URL_SECONDARY ?? 'https://base.drpc.org']),
  };
}
async function main() {
  const [command, path, output, ...extra] = process.argv.slice(2);
  if (command === '--help') {
    console.log('pointer-publication-cli.mjs prepare INPUTS_JSON OUTPUT_JSON | inspect INPUTS_JSON\nRead-only unsigned preparation. Inputs name successorPlanPath, institutionsPath, pointerPlanPath, operatorsPath and signedRulePath. Prepare also requires stage (retire or publish) and positive decimal callGas. Inspect requires publicationPlanPath. Canonical deployment, legacy addresses and build pin come from this repository. Requires the pinned public policy verification key. Never reads a private key, signs, sends executable signatures, publishes a pointer or activates issuance.');
    return;
  }
  ensure(path && extra.length === 0 && (command === 'prepare' ? output && !output.startsWith('--') : command === 'inspect' && !output), 'usage');
  const input = read(path), inputs = await publicationInputs(input);
  if (command === 'inspect') {
    const verified = await verifyPointerPublication(read(input.publicationPlanPath), inputs);
    console.log(JSON.stringify({ status: 'verified', stage: verified.stage, checkpoint: verified.checkpoint, complete: verified.complete, broadcast: false }));
    return;
  }
  const plan = await preparePointerPublication({ ...inputs, stage: input.stage, callGas: input.callGas });
  writeFileSync(resolve(output), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: 'prepared', stage: plan.stage, planDigest: plan.digest, targets: plan.targets.length, complete: plan.complete, broadcast: false }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(/^pointer_publication_cli_[a-z_]+$/.test(error.message) ? error.message : 'pointer_publication_cli_refused'); process.exitCode = 1; });
}
