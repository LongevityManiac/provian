#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRpcPort } from './snapshot-cli.mjs';
import { preflightSuccessorPlan, readSuccessorArtifacts } from './successor-preflight.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
async function main() {
  const [planPath, pointerPath, rulePath, operatorsPath, output, ...extra] = process.argv.slice(2);
  if (planPath === '--help') {
    console.log('successor-preflight-cli.mjs PLAN POINTER_PLAN SIGNED_RULE OPERATOR_INPUTS OUTPUT\nRead-only: verifies the pinned approval signature, compiled source bindings, independent finalized snapshots and the complete executable plan against separately reviewed operator inputs. No signing key, Firestore write, broadcast or changeover. Build current contracts first.'); return;
  }
  if (!planPath || !pointerPath || !rulePath || !operatorsPath || !output || extra.length) throw Error('successor_preflight_usage');
  const read = file => JSON.parse(readFileSync(resolve(file), 'utf8'));
  const temporary = mkdtempSync(join(tmpdir(), 'provian-rule-verification-'));
  let verifiedRule;
  try {
    const verifiedPath = join(temporary, 'verified.json');
    execFileSync(resolve(root, 'provian-backend/node_modules/.bin/tsx'),
      [resolve(root, 'provian-backend/scripts/recourse-membership-rule.ts'), 'verify-signed', resolve(rulePath), verifiedPath],
      { cwd: root, stdio: 'pipe', timeout: 30000 });
    verifiedRule = read(verifiedPath);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  const port = snapshotRpcPort([process.env.BASE_RPC_URL ?? 'https://base-rpc.publicnode.com',
    process.env.BASE_RPC_URL_SECONDARY ?? 'https://base.drpc.org']);
  const result = await preflightSuccessorPlan({ plan: read(planPath), pointerPlan: read(pointerPath), verifiedRule, operators: read(operatorsPath),
    deployment: read(resolve(root, 'contracts/deployments/base-pvt9-institutions.json')),
    artifacts: readSuccessorArtifacts(root), port });
  writeFileSync(resolve(output), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ planDigest: result.plan.digest, ...result.facts, broadcast: false }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(/^successor_preflight_[a-z_]+$/.test(error.message)
    ? error.message : 'successor_preflight_refused'); process.exitCode = 1; });
}
