/**
 * deploy-time scheduler reconcile gate.
 *
 * HARD gate wired into `deploy-env.sh` before `gcloud run deploy`. Reconciles
 * `scheduler-jobs.json` against (a) the endpoints actually present in `src/` and
 * (b) the LIVE Cloud Scheduler inventory. Exits non-zero — failing the deploy —
 * if a `required` endpoint has no ENABLED job, a schedule drifted, or an ENABLED
 * job points at a retired/unclassified endpoint. This is the fix for the class
 * // fell into.
 *
 * Live mode (default): reads jobs via `gcloud scheduler jobs list`.
 * Offline mode: `--jobs-file <path.json>` reads a captured inventory instead
 * (used to reproduce the check without gcloud auth).
 *
 * Run: npx tsx scripts/reconcile-scheduler.ts
 */
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import {
  loadSchedulerManifest,
  scanSchedulerEndpointsFromSource,
  reconcileScheduler,
  type LiveJob,
  jobTargetFromUri,
} from '../src/core/deployment/scheduler-manifest';

const MANIFEST_PATH = path.join(__dirname, '../scheduler-jobs.json');
const SRC_DIR = path.join(__dirname, '../src');

interface RawJob {
  name?: string;
  state?: string;
  schedule?: string;
  httpTarget?: { uri?: string; headers?: Record<string, string> };
}

function normalize(raw: RawJob[]): LiveJob[] {
  return raw.map((j) => {
    const { endpoint, nonHttpTarget } = jobTargetFromUri(j.httpTarget?.uri);
    return {
      name: (j.name ?? '').split('/').pop() ?? '',
      state: j.state ?? 'UNKNOWN',
      schedule: j.schedule ?? '',
      endpoint,
      nonHttpTarget,
      headers: j.httpTarget?.headers ?? null,
      uri: j.httpTarget?.uri ?? null,
    };
  });
}

function fetchLiveJobs(manifestLocation: string, project: string): LiveJob[] {
  const out = execFileSync(
    'gcloud',
    ['scheduler', 'jobs', 'list', `--location=${manifestLocation}`, `--project=${project}`, '--format=json'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  return normalize(JSON.parse(out) as RawJob[]);
}

function main(): void {
  const manifest = loadSchedulerManifest(MANIFEST_PATH);
  const codeEndpoints = scanSchedulerEndpointsFromSource(SRC_DIR);

  const fileArgIdx = process.argv.indexOf('--jobs-file');
  let liveJobs: LiveJob[];
  if (fileArgIdx !== -1) {
    const file = process.argv[fileArgIdx + 1];
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as RawJob[];
    liveJobs = normalize(raw);
    console.log(`[reconcile-scheduler] offline mode: ${liveJobs.length} jobs from ${file}`);
  } else {
    liveJobs = fetchLiveJobs(manifest.location, manifest.project);
    console.log(`[reconcile-scheduler] live mode: ${liveJobs.length} jobs from gcloud (${manifest.project}/${manifest.location})`);
  }

  const result = reconcileScheduler({ manifest, codeEndpoints, liveJobs });
  console.log(`[reconcile-scheduler] checked: ${JSON.stringify(result.checked)}`);

  if (result.ok) {
    console.log('[reconcile-scheduler] OK — every required scheduler endpoint has an enabled job; no job points at a retired/unknown endpoint.');
    process.exit(0);
  }

  console.error('\n[reconcile-scheduler] RECONCILE FAILED — the deploy is blocked. Fix these before deploying:\n');
  for (const e of result.errors) console.error('  ✗ ' + e);
  console.error('\nEither create/enable the missing Cloud Scheduler job (mirror the USDC/institution siblings),');
  console.error('pause a job that points at a retired endpoint, or update scheduler-jobs.json if the change is intended.\n');
  process.exit(1);
}

main();
