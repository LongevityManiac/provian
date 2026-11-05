/**
 * refuse to deploy an UNSTAMPED (or stale-stamped) provian-api image.
 *
 * `deploy-env.sh` builds and deploys from source but does NOT stamp the tree
 * (`stamp-tree-for-deploy.mjs` does, and only the gated wrapper calls it). A
 * direct `bash deploy-env.sh` therefore ships a null-stamped image, which the
 * standard-lane reconciliation gate refuses as `runtime_tree_unstamped` and
 * the lane then HOLDS its backlog silently until the next settlement run pages
 * it (the exact OP-1 incident of 2026-09-15). `deploy-env.sh` runs this guard
 * before it deploys, converting that silent hold into a fail-fast at deploy time.
 *
 * The decision lives in `deploy-gate-ordering.ts::judgeDeployStampReady` the
 * same module the gated wrapper and its jest suite import — so this script is a
 * thin reader of real state (the stamp file + `git rev-parse HEAD`), not a second
 * copy of the rule. Read-only: it deploys nothing, signs nothing, holds no key.
 *
 * npx tsx scripts/require-tree-stamp.ts # refuse unless stamp == HEAD
 * PROVIAN_ALLOW_UNSTAMPED_DEPLOY=1 npx tsx … # deliberate, audited override
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { judgeDeployStampReady } from '../src/core/pvt/wp4/deploy-gate-ordering';

const BACKEND_ROOT = path.join(__dirname, '..');
const STAMP_PATH = path.join(BACKEND_ROOT, 'src', 'core', 'pvt', 'tree-stamp.generated.ts');

/** The stamp file's current value — mirrors `deploy-api-gated.ts::readStampValue`. */
function readStampValue(): string | null {
  const m = /export const DEPLOYED_TREE_GIT_HEAD: string \| null = (.*);/
    .exec(fs.readFileSync(STAMP_PATH, 'utf8'));
  if (m === null) return null;
  const raw = m[1].trim();
  if (raw === 'null') return null;
  return raw.replace(/^['"]|['"]$/g, '');
}

function headSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: BACKEND_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const verdict = judgeDeployStampReady(
  readStampValue(),
  headSha(),
  process.env.PROVIAN_ALLOW_UNSTAMPED_DEPLOY === '1',
);

if (!verdict.ok) {
  console.error(`\nDEPLOY BLOCKED (require-tree-stamp,): ${verdict.message}\n`);
  process.exit(1);
}
console.log(
  `[require-tree-stamp] ok — ${verdict.message}`
  + (verdict.overridden ? ' (OVERRIDDEN)' : ''),
);
