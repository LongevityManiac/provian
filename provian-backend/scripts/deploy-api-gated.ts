/**
 * deploy `provian-api` without breaking the standard-lane settlement gate.
 *
 * The gate admits settlement only when the published reconciliation report's
 * `bound_tree.git_head` equals the deployed image's tree stamp. Those are two
 * artifacts from two commands, and until now nothing enforced their ordering —
 * so this wrapper runs the whole sequence, in order, refusing at each boundary:
 *
 * dry-run -> publish -> stamp -> deploy -> --reset
 *
 * PUBLISH-FIRST is the part people get wrong (this session included). Publishing
 * binds the report to whatever HEAD is NOW; doing it after the deploy binds it to
 * a commit the runtime is not running, which flips an ADMITTING gate to refusing.
 * "The report looks stale, let me refresh it" is the dangerous instinct.
 *
 * The ordering rules live in `src/core/pvt/wp4/deploy-gate-ordering.ts` and are
 * imported here, so the rules this script EXECUTES are the ones the jest suite
 * and the mutation battery ASSERT.
 *
 * SAFETY: plan-only unless `--execute` is passed. It cannot mint or settle —
 * it never calls the settlement route and holds no key. The stamp is restored
 * to null in a `finally`, so a failed deploy still leaves a clean tree.
 *
 * npx ts-node scripts/deploy-api-gated.ts # plan only
 * npx ts-node scripts/deploy-api-gated.ts --execute # really deploy
 * npx ts-node scripts/deploy-api-gated.ts --execute --cut-line <ms> --rpc <url>
 *
 * RELEASE FRESHNESS (ops follow-up 2, 2026-10-07): after the deploy the release endpoint must name
 * the bundle the relay serves. When it does not (a rebuilt `bootstrap-bundle/agent.js`), the next
 * release is signed over those exact bytes and the pair judged again; the deploy finishes only when
 * fresh, else `FINISHED STALE` with exit 1. `--no-release-sign` judges without signing;
 * `--release-check` runs only this guard (no deploy).
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import {
  DEPLOY_SEQUENCE,
  judgeDeployStep,
  judgeFinalState,
} from '../src/core/pvt/wp4/deploy-gate-ordering';
import type { DeployGateState, DeployStep } from '../src/core/pvt/wp4/deploy-gate-ordering';
import {
  RECONCILIATION_CURRENT_DOC,
  RECONCILIATION_REPORTS_COLLECTION,
} from '../src/core/pvt/wp4/standard-lane-recon-gate';
import { scriptDb } from './lib/script-db';
import crypto from 'crypto';
import { judgeReleaseFreshness, type ReleaseFreshnessFacts } from '../src/core/deployment/release-freshness';

const BACKEND_ROOT = path.join(__dirname, '..');
const STAMP_PATH = path.join(BACKEND_ROOT, 'src', 'core', 'pvt', 'tree-stamp.generated.ts');

/** The cut line every published report has been bound to since. */
const DEFAULT_CUT_LINE = '1784938132043';
const DEFAULT_RPC = 'https://mainnet.base.org';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
const EXECUTE = process.argv.includes('--execute');
const CUT_LINE = arg('--cut-line', DEFAULT_CUT_LINE);
const RPC = arg('--rpc', DEFAULT_RPC);
const API_BASE = arg('--api-base', 'https://api.provian.ai');
const SIGN_RELEASE = !process.argv.includes('--no-release-sign');
const RELEASE_CHECK_ONLY = process.argv.includes('--release-check');
const BUNDLE_PATH = path.join(BACKEND_ROOT, 'bootstrap-bundle', 'agent.js');

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: BACKEND_ROOT, encoding: 'utf8' }).trim();
}

/**
 * Dirt that would make the built tree differ from the commit being claimed.
 * The two exclusions mirror `stamp-tree-for-deploy.mjs` exactly: the stamp we
 * write ourselves, and the dry run's own untracked evidence artifacts, which
 * are OUTPUT and cannot change what Docker copies from `src/`.
 */
function computeTreeDirty(): boolean {
  return git(['status', '--porcelain'])
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .filter((l) => !l.endsWith('src/core/pvt/tree-stamp.generated.ts'))
    .filter((l) => !/^\?\? .*wp11-cutover-dry-run\.\d+\.[0-9a-f]{12}\.json$/.test(l.trim()))
    .length > 0;
}

function readStampValue(): string | null {
  const m = /export const DEPLOYED_TREE_GIT_HEAD: string \| null = (.*);/
    .exec(fs.readFileSync(STAMP_PATH, 'utf8'));
  if (m === null) return null;
  const raw = m[1].trim();
  if (raw === 'null') return null;
  return raw.replace(/^['"]|['"]$/g, '');
}

// every scripted database read goes through the private store, which derives its storage aliases
// from the relay secret. Fetch it from Secret Manager like the other scripts do, so the deploy
// procedure runs from a plain shell (the reference-gate run found it refusing at `plan` without it).
function ensureRelaySecret(): void {
  process.env.RELAY_SIGNING_KEY ??= execFileSync(
    "gcloud", ["secrets", "versions", "access", "latest", "--secret=relay-signing-key", "--project=provian-ai"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

async function readPublishedReportHead(): Promise<string | null> {
  ensureRelaySecret();
  if (getApps().length === 0) initializeApp({ credential: applicationDefault() });
  const snap = await scriptDb()
    .collection(RECONCILIATION_REPORTS_COLLECTION).doc(RECONCILIATION_CURRENT_DOC).get();
  if (!snap.exists) return null;
  const data = snap.data() ?? {};
  // The published doc carries `git_head` at the TOP LEVEL; `bound_tree` lives inside the
  // serialized `report_json`, not on the document. Reading `data.bound_tree.git_head`
  // therefore always yielded null, so this wrapper judged every publish as `publish_missing`
  // and refused at `stamp` — it could never complete a deploy, including immediately after
  // its own publish step reported success. Read the top-level field, and fall back to
  // parsing the report so the two readers in this file agree on one source.
  if (typeof data.git_head === 'string') return data.git_head;
  if (typeof data.report_json === 'string') {
    try {
      const report = JSON.parse(data.report_json) as { bound_tree?: { git_head?: unknown } };
      if (typeof report.bound_tree?.git_head === 'string') return report.bound_tree.git_head;
    } catch { /* fall through to null — an unparseable report is not a publish */ }
  }
  return null;
}

/** Newest dry-run artifact for this cut line, or null. */
function findArtifact(): string | null {
  const matches = fs.readdirSync(process.cwd())
    .filter((f) => new RegExp(`^wp11-cutover-dry-run\\.${CUT_LINE}\\.[0-9a-f]{12}\\.json$`).test(f))
    .map((f) => path.join(process.cwd(), f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return matches[0] ?? null;
}

function artifactBoundHead(): string | null {
  const p = findArtifact();
  if (p === null) return null;
  try {
    const report = JSON.parse(fs.readFileSync(p, 'utf8')) as
      { bound_tree?: { git_head?: unknown } };
    return typeof report.bound_tree?.git_head === 'string' ? report.bound_tree.git_head : null;
  } catch {
    return null;
  }
}

function shell(cmd: string, args: string[], opts: { tolerateExit?: boolean } = {}): void {
  console.log(`\n  $ ${cmd} ${args.join(' ')}`);
  if (!EXECUTE) { console.log('    (plan only — not executed)'); return; }
  try {
    execFileSync(cmd, args, { cwd: BACKEND_ROOT, stdio: 'inherit' });
  } catch (err) {
    if (opts.tolerateExit !== true) throw err;
    console.log('    (non-zero exit tolerated — judged on its artifact, see below)');
  }
}

/**
 * : the dry run and the publisher must read and write the SAME Firestore database the
 * relay runs on, but they run before deploy-env.sh loads .env.deploy. Take FIRESTORE_DATABASE_ID
 * from .env.deploy when the shell does not set it (child processes inherit it); refuse when the
 * two disagree, so a report is never published to a database the relay does not read.
 */
function pinDatabaseIdFromDeployEnv(): void {
  const envFile = path.join(BACKEND_ROOT, '.env.deploy');
  const fromFile = fs.existsSync(envFile)
    ? (fs.readFileSync(envFile, 'utf8').match(/^FIRESTORE_DATABASE_ID=(.*)$/m)?.[1] ?? '').trim().replace(/^["']|["']$/g, '')
    : '';
  const fromShell = (process.env.FIRESTORE_DATABASE_ID ?? '').trim();
  if (fromShell && fromFile && fromShell !== fromFile) {
    throw new Error(`FIRESTORE_DATABASE_ID is ${fromShell} in the shell but ${fromFile} in .env.deploy — refusing`);
  }
  if (!fromShell && fromFile) process.env.FIRESTORE_DATABASE_ID = fromFile;
  console.log(`  database  ${process.env.FIRESTORE_DATABASE_ID || '(default)'}`);
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function readReleaseFacts(): Promise<ReleaseFreshnessFacts> {
  const bust = `t=${Date.now()}`;
  let served: string | null = null;
  try {
    const r = await fetch(`${API_BASE}/v1/bootstrap/agent.js?${bust}`, { headers: { 'cache-control': 'no-cache' } });
    if (r.ok) served = sha256(Buffer.from(await r.arrayBuffer()));
  } catch { served = null; }
  let local: string | null = null;
  try { local = sha256(fs.readFileSync(BUNDLE_PATH)); } catch { local = null; }
  let releaseStatus: number | null = null;
  let releaseBundle: string | null = null;
  try {
    const r = await fetch(`${API_BASE}/v1/catalog/release/?${bust}`, { headers: { 'cache-control': 'no-cache' } });
    releaseStatus = r.status;
    if (r.status === 200) {
      const body = await r.json() as { manifest?: { bundle?: { sha256?: unknown } } };
      const sha = body.manifest?.bundle?.sha256;
      releaseBundle = typeof sha === 'string' ? sha : null;
    }
  } catch { releaseStatus = null; }
  let published: number | null = null;
  try {
    ensureRelaySecret();
    if (getApps().length === 0) scriptDb();
    const doc = await scriptDb().collection('release_manifest').doc('current').get();
    const v = (doc.data() as { manifest?: { version?: unknown } } | undefined)?.manifest?.version;
    published = typeof v === 'number' ? v : null;
  } catch { published = null; }
  return {
    servedBundleSha256: served, localBundleSha256: local, releaseStatus,
    releaseBundleSha256: releaseBundle, publishedVersion: published,
  };
}

/** Judge the live release pair; sign the next release when stale. True only when it ends fresh. */
async function ensureReleaseFresh(): Promise<boolean> {
  console.log('\n[release] judging the release endpoint against the served bundle');
  // A just-deployed revision can take a moment to answer with its own bundle.
  let facts = await readReleaseFacts();
  for (let i = 0; i < 6 && facts.servedBundleSha256 !== facts.localBundleSha256; i += 1) {
    await new Promise((r) => setTimeout(r, 10_000));
    facts = await readReleaseFacts();
  }
  let verdict = judgeReleaseFreshness(facts);
  console.log(`  served ${facts.servedBundleSha256?.slice(0, 12) ?? '?'}… release ${facts.releaseStatus ?? '?'} published v${facts.publishedVersion ?? '?'} -> ${verdict.state}`);
  if (verdict.state === 'fresh') return true;
  if (verdict.state === 'blocked') {
    console.error(`  BLOCKED: ${verdict.reason}`);
    return false;
  }
  console.log(`  STALE: ${verdict.reason}`);
  if (!SIGN_RELEASE || !EXECUTE) {
    console.error(`  not signing (${!EXECUTE ? 'plan only' : '--no-release-sign'}); sign with: npx ts-node scripts/sign-release-manifest.ts --version ${verdict.signVersion}`);
    return false;
  }
  console.log(`  signing release ${verdict.signVersion} over the served bundle`);
  shell('npx', ['ts-node', 'scripts/sign-release-manifest.ts', '--version', String(verdict.signVersion)], { tolerateExit: true });
  for (let i = 0; i < 6; i += 1) {
    facts = await readReleaseFacts();
    verdict = judgeReleaseFreshness(facts);
    if (verdict.state === 'fresh') {
      console.log(`  fresh: release v${verdict.version} names the served bundle`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  console.error(`  still ${verdict.state} after signing`);
  return false;
}

async function main(): Promise<void> {
  pinDatabaseIdFromDeployEnv();
  const completed: DeployStep[] = [];
  const observe = async (): Promise<DeployGateState> => ({
    headSha: git(['rev-parse', 'HEAD']),
    treeDirty: computeTreeDirty(),
    artifactBoundHead: artifactBoundHead(),
    publishedReportHead: await readPublishedReportHead(),
    stampValue: readStampValue(),
    completed: [...completed],
  });

  if (RELEASE_CHECK_ONLY) {
    const ok = await ensureReleaseFresh();
    console.log(ok ? '\n=== release fresh ===' : '\nRELEASE STALE');
    if (!ok) process.exitCode = 1;
    return;
  }

  const head = git(['rev-parse', 'HEAD']);
  console.log('=== provian-api gated deploy ===');
  console.log(`  HEAD      ${head}`);
  console.log(`  cut line  ${CUT_LINE}`);
  console.log(`  mode      ${EXECUTE ? 'EXECUTE' : 'PLAN ONLY (pass --execute to deploy)'}`);
  console.log(`  order     ${DEPLOY_SEQUENCE.join(' -> ')}`);

  let stamped = false;
  try {
    for (const step of DEPLOY_SEQUENCE) {
      if (step === 'reset') continue; // runs in the finally, always
      const verdict = judgeDeployStep(step, await observe());
      if (!verdict.ok) {
        console.error(`\nREFUSED at ${step} (${verdict.reason})\n  ${verdict.message}`);
        process.exitCode = 1;
        return;
      }
      console.log(`\n[${step}] admitted`);

      switch (step) {
        case 'dry_run':
          // Exit code encodes "everything reconciled", which is STRICTER than
          // what the gate requires (it judges C1/C3/C6 and allows a documented
          // C6 downgrade). C12 has also been permanently failing since.
          // So the artifact's validity is the test, not the exit status — the
          // publisher re-derives its digest and refuses a bad one anyway.
          shell('npx', ['ts-node', 'scripts/wp11-cutover-dry-run.ts',
            '--cut-line', CUT_LINE, '--rpc', RPC], { tolerateExit: true });
          if (EXECUTE && artifactBoundHead() === null) {
            console.error('\nREFUSED: the dry run produced no readable artifact.');
            process.exitCode = 1;
            return;
          }
          break;
        case 'publish': {
          const p = findArtifact();
          if (p === null && EXECUTE) {
            console.error('\nREFUSED: no artifact to publish.');
            process.exitCode = 1;
            return;
          }
          shell('npx', ['ts-node', 'scripts/wp11-publish-reconciliation-report.ts',
            p ?? '<artifact>']);
          break;
        }
        case 'stamp':
          shell('node', ['scripts/stamp-tree-for-deploy.mjs']);
          stamped = EXECUTE;
          break;
        case 'deploy':
          shell('bash', ['deploy-env.sh']);
          break;
        default:
          break;
      }
      completed.push(step);
    }
  } finally {
    // Unconditional: a thrown deploy must not strand a stamped working tree,
    // because that dirt is exactly what the next `stamp` refuses on.
    if (stamped) {
      console.log('\n[reset] restoring the null stamp');
      execFileSync('node', ['scripts/stamp-tree-for-deploy.mjs', '--reset'],
        { cwd: BACKEND_ROOT, stdio: 'inherit' });
      completed.push('reset');
    }
  }

  if (!EXECUTE) {
    await ensureReleaseFresh(); // reports the live pair; never signs in plan mode
    console.log('\nPLAN COMPLETE — nothing was executed. Re-run with --execute to deploy.');
    return;
  }

  const final = judgeFinalState(await observe());
  if (!final.ok) {
    console.error(`\nFINISHED DIRTY (${final.reason})\n  ${final.message}`);
    process.exitCode = 1;
    return;
  }
  if (!(await ensureReleaseFresh())) {
    console.error('\nFINISHED STALE (release) — the relay serves a bundle no signed release names, so every');
    console.error('  daemon update check answers "pending". Sign the version above, or re-run with --release-check.');
    process.exitCode = 1;
    return;
  }
  console.log('\n=== deploy complete, gate pair intact, release fresh ===');
  console.log(`  published report and deployed image both name ${head.slice(0, 12)}…`);
  console.log(' verify: npx ts-node scripts/wp4-standard-lane-gate-probe.ts');
  console.log('  NOTE: probe BEFORE the stamp is reset, or it reads the local null stamp');
  console.log('        and falsely refuses runtime_tree_unstamped.');
}

main().catch((err) => {
  console.error('[deploy-api-gated] failed:', err);
  process.exit(1);
});
