#!/usr/bin/env node
/**
 * stamp the deploying tree's git HEAD into
 * `src/core/pvt/tree-stamp.generated.ts` so the built image can prove which
 * tree it runs. The standard-lane settlement gate compares this stamp to the
 * published reconciliation report's `bound_tree.git_head`; a mismatch (or a
 * null stamp) refuses settlement.
 *
 * Usage, wrapped around the existing deploy:
 * node scripts/stamp-tree-for-deploy.mjs # verify clean, write HEAD
 * gcloud run deploy provian-api --source. … # (or the REST tar flow)
 * node scripts/stamp-tree-for-deploy.mjs --reset # restore the null stamp
 *
 * The stamp is the ONLY diff from the recorded commit at build time, and it
 * names that commit — so the image's provenance stays exact. `--reset` after
 * the build keeps the working tree clean; forgetting it is caught by git
 * status, not hidden.
 */
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const BACKEND_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAMP_PATH = path.join(BACKEND_ROOT, 'src', 'core', 'pvt', 'tree-stamp.generated.ts');
const NULL_LINE = 'export const DEPLOYED_TREE_GIT_HEAD: string | null = null;';

function git(args) {
  return execFileSync('git', args, { cwd: BACKEND_ROOT, encoding: 'utf8' }).trim();
}

const reset = process.argv.includes('--reset');
const source = readFileSync(STAMP_PATH, 'utf8');

if (reset) {
  const restored = source.replace(
    /export const DEPLOYED_TREE_GIT_HEAD: string \| null = .*;/,
    NULL_LINE,
  );
  writeFileSync(STAMP_PATH, restored, 'utf8');
  console.log('tree stamp RESET to null');
  process.exit(0);
}

const head = git(['rev-parse', 'HEAD']);
if (!/^[0-9a-f]{40}$/.test(head)) {
  console.error(`refusing: git HEAD did not resolve to a 40-hex sha (${head})`);
  process.exit(1);
}
// The ONLY tolerated dirt: a previously-written stamp itself, and the
// dry-run's own untracked evidence artifacts (run OUTPUT — the operator flow
// is dry-run → publish → stamp, so the artifact is legitimately present and
// cannot change what the image builds; Docker copies only src/). Anything
// else means the tree being built is not the commit being claimed.
const dirt = git(['status', '--porcelain'])
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .filter((line) => !line.endsWith('src/core/pvt/tree-stamp.generated.ts'))
  .filter((line) => !/^\?\? .*wp11-cutover-dry-run\.\d+\.[0-9a-f]{12}\.json$/.test(line.trim()));
if (dirt.length > 0) {
  console.error('refusing to stamp a dirty tree:');
  for (const line of dirt) console.error(`  ${line}`);
  process.exit(1);
}

if (!source.includes(NULL_LINE) && !/= '[0-9a-f]{40}';/.test(source)) {
  console.error('refusing: tree-stamp.generated.ts does not have the expected shape');
  process.exit(1);
}
const stamped = source.replace(
  /export const DEPLOYED_TREE_GIT_HEAD: string \| null = .*;/,
  `export const DEPLOYED_TREE_GIT_HEAD: string | null = '${head}';`,
);
writeFileSync(STAMP_PATH, stamped, 'utf8');
console.log(`tree stamp WRITTEN: ${head}`);
console.log('build/deploy now, then run with --reset to restore the null stamp');
