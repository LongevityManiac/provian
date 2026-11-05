/**
 * scheduler manifest reconcile, GREEN + RED controls.
 *
 * GREEN binds to REALITY: the real `scheduler-jobs.json` + the endpoints actually
 * scanned from `src/` + the live-job inventory seeded from gcloud on 2026-08-07
 * (anchor rows: daily-pe-anchor RESUMED 2026-08-11 for B10, //;
 * provian-anchor-recovery-schedule RETIRED + DELETED 2026-08-16 — the 08-11 B10
 * resume had re-enabled it by mistake, conflating the LEGACY execute-mode
 * PVTv4/legacy-PEAnchor job with the new anchoring pair. The seed follows live
 * state, so the deleted scheduler is absent below).
 * So if someone adds a scheduler endpoint to code without a manifest entry, or
 * deletes an endpoint the manifest still lists, THIS suite goes red in CI — the
 * class fix for //, enforced before deploy.
 *
 * Every guard ships with its RED negative control : the guard is fed a
 * deliberately violating inventory and asserted to report it. The GREEN case is
 * proven non-vacuous by asserting the evaluated counts.
 */
import path from 'path';
import {
  loadSchedulerManifest,
  scanSchedulerEndpointsFromSource,
  reconcileScheduler,
  type LiveJob,
} from './scheduler-manifest';

const MANIFEST_PATH = path.join(__dirname, '../../../scheduler-jobs.json');
const SRC_DIR = path.join(__dirname, '../..');

// Seeded from `gcloud scheduler jobs list` on 2026-08-07. This is the
// live inventory the current deploy passes against; the deploy-time CLI checks
// the ACTUAL live state, this fixture proves the logic accepts the known-good one.
const SEED_LIVE_JOBS: readonly LiveJob[] = Object.freeze([
  { name: 'provian-github-pr-gates', state: 'ENABLED', schedule: '18 4 * * *', endpoint: '/v1/internal/scheduler/github-pr-gates', nonHttpTarget: null },
  { name: 'provian-abandoned-bonds', state: 'ENABLED', schedule: '0 8 * * *', endpoint: '/v1/internal/scheduler/abandoned-bonds', nonHttpTarget: null },
  { name: 'provian-agent-bank-events', state: 'ENABLED', schedule: '*/5 * * * *', endpoint: '/v1/internal/scheduler/agent-bank-events', nonHttpTarget: null },
  { name: 'provian-auto-release', state: 'ENABLED', schedule: '0 * * * *', endpoint: '/v1/internal/scheduler/auto-release', nonHttpTarget: null },
  { name: 'provian-bond-renewals', state: 'ENABLED', schedule: '0 7 * * *', endpoint: '/v1/internal/scheduler/bond-renewals', nonHttpTarget: null },
  // Phase 2: action-type reconciler (building → live). CREATED at deploy.
  { name: 'provian-action-type-reconcile', state: 'ENABLED', schedule: '20 * * * *', endpoint: '/v1/internal/scheduler/action-type-reconcile', nonHttpTarget: null },
  // Phase 4: submitter activation-notice fan-out. CREATED at deploy.
  { name: 'provian-action-type-activation-notify', state: 'ENABLED', schedule: '35 * * * *', endpoint: '/v1/internal/scheduler/action-type-activation-notify', nonHttpTarget: null },
  { name: 'provian-court-deadlines', state: 'ENABLED', schedule: '*/15 * * * *', endpoint: '/v1/internal/scheduler/court-deadlines', nonHttpTarget: null },
  { name: 'provian-daily-pe-anchor', state: 'ENABLED', schedule: '*/5 * * * *', endpoint: '/v1/internal/scheduler/daily-pe-anchor', nonHttpTarget: null },
  { name: 'provian-daily-spending-digest', state: 'ENABLED', schedule: '0 2 * * *', endpoint: '/v1/internal/daily-spending-digest', nonHttpTarget: null },
  { name: 'provian-defaults', state: 'ENABLED', schedule: '30 * * * *', endpoint: '/v1/internal/scheduler/defaults', nonHttpTarget: null },
  { name: 'provian-deferred-release', state: 'ENABLED', schedule: '*/10 * * * *', endpoint: '/v1/internal/scheduler/deferred-release', nonHttpTarget: null },
  { name: 'provian-expired-claims', state: 'ENABLED', schedule: '0 9 * * *', endpoint: '/v1/internal/scheduler/expired-claims', nonHttpTarget: null },
  { name: 'provian-expired-pools', state: 'ENABLED', schedule: '45 * * * *', endpoint: '/v1/internal/scheduler/expired-pools', nonHttpTarget: null },
  { name: 'provian-general-dispute-deadlines', state: 'ENABLED', schedule: '50 * * * *', endpoint: '/v1/internal/scheduler/general-dispute-deadlines', nonHttpTarget: null },
  { name: 'provian-genesis-external-outbound', state: 'ENABLED', schedule: '*/30 * * * *', endpoint: '/v1/internal/scheduler/outbound-usdc', nonHttpTarget: null },
  { name: 'provian-genesis-inbound-usdc', state: 'ENABLED', schedule: '*/15 * * * *', endpoint: '/v1/internal/scheduler/inbound-usdc', nonHttpTarget: null },
  // F-A1-1 / F-A1-2 — the Genesis recovery drain + retention→outbox promotion.
  // Both jobs are CREATED at deploy (commands in deploy-env.sh / reconcile-scheduler.ts);
  // until they exist live, the deploy-time reconcile HARD gate refuses the deploy —
  // the mechanism doing exactly its job.
  { name: 'provian-genesis-drain', state: 'ENABLED', schedule: '*/30 * * * *', endpoint: '/v1/internal/scheduler/genesis-drain', nonHttpTarget: null },
  { name: 'provian-genesis-retention-backfill', state: 'ENABLED', schedule: '15 * * * *', endpoint: '/v1/internal/scheduler/genesis-retention-backfill', nonHttpTarget: null },
  { name: 'provian-institution-funding', state: 'ENABLED', schedule: '*/15 * * * *', endpoint: '/v1/internal/scheduler/institution-funding', nonHttpTarget: null },
  // (3b): institution COMPLETION watcher, created live alongside the 3b activation.
  { name: 'provian-institution-completion', state: 'ENABLED', schedule: '*/15 * * * *', endpoint: '/v1/internal/scheduler/institution-completion', nonHttpTarget: null },
  // (Trust Layer §2.12): institution STANDING watcher, created live before the deploy.
  { name: 'provian-institution-standing', state: 'ENABLED', schedule: '*/15 * * * *', endpoint: '/v1/internal/scheduler/institution-standing', nonHttpTarget: null },
  // Standing reconcile (a lost actor-stats bump cannot hide an adverse event), created live before the deploy.
  { name: 'provian-standing-reconcile', state: 'ENABLED', schedule: '25 * * * *', endpoint: '/v1/internal/scheduler/standing-reconcile', nonHttpTarget: null },
  { name: 'provian-ordinary-accrual-replay', state: 'ENABLED', schedule: '40 * * * *', endpoint: '/v1/internal/scheduler/ordinary-accrual-replay', nonHttpTarget: null },
  // the chain-record lane (transfer/swap records mint), created live before the deploy.
  { name: 'provian-chain-record-watcher', state: 'ENABLED', schedule: '*/5 * * * *', endpoint: '/v1/internal/scheduler/chain-record', nonHttpTarget: null },
  { name: 'provian-chain-record-auxiliary', state: 'ENABLED', schedule: '*/5 * * * *', endpoint: '/v1/internal/scheduler/chain-record-auxiliary', nonHttpTarget: null },
  { name: 'provian-chain-record-discovery', state: 'ENABLED', schedule: '*/5 * * * *', endpoint: '/v1/internal/scheduler/chain-record-discovery', nonHttpTarget: null },
  { name: 'provian-pending-cache-backfill', state: 'ENABLED', schedule: '0 * * * *', endpoint: '/v1/internal/scheduler/pending-cache-backfill', nonHttpTarget: null },
  // the five dead PAUSED jobs (advance-epoch, genesis-first-tx,
  // genesis-sustained, pe-aggregate-drift, pvt-mint) were DELETED; their endpoints stay
  // unscheduled (required:false, job:null) and no live job targets them.
  { name: 'provian-pending-evidence-resolve', state: 'ENABLED', schedule: '50 * * * *', endpoint: '/v1/internal/scheduler/pending-evidence-resolve', nonHttpTarget: null },
  // self-heal (created live 2026-09-14, MONEY_LAYER_RUN_LOG §self-heal).
  { name: 'provian-registry-hold-resolve', state: 'ENABLED', schedule: '40 * * * *', endpoint: '/v1/internal/scheduler/registry-hold-resolve', nonHttpTarget: null },
  { name: 'provian-purge-transients', state: 'ENABLED', schedule: '15 3 * * *', endpoint: '/v1/internal/scheduler/purge-transients', nonHttpTarget: null },
  { name: 'provian-pvt9-epoch-keeper', state: 'ENABLED', schedule: '*/20 * * * *', endpoint: '/v1/internal/scheduler/pvt9-epoch-keeper', nonHttpTarget: null },
  // PVT9 daily standard settlement runner with a 30-day payee interval (added live 2026-08-08).
  // (2026-10-04): the standard run moved to weekly, epoch-aligned (Saturdays 16:30 UTC).
  { name: 'provian-pvt9-settlement', state: 'ENABLED', schedule: '0 12 * * *', endpoint: '/v1/internal/settlement/pvt9-run', nonHttpTarget: null },
  // PVT9 DAILY Genesis-only settlement (Genesis daily, standard on a 30-day payee interval).
  { name: 'provian-pvt9-genesis-settlement', state: 'ENABLED', schedule: '0 0 * * *', endpoint: '/v1/internal/settlement/pvt9-genesis-run', nonHttpTarget: null },
  // : the on-demand payout sweep.
  { name: 'provian-payout-sweep', state: 'ENABLED', schedule: '*/10 * * * *', endpoint: '/v1/internal/scheduler/payout-sweep', nonHttpTarget: null },
  // : the paid PE Archive sweep.
  { name: 'provian-archive-sweep', state: 'ENABLED', schedule: '15 * * * *', endpoint: '/v1/internal/scheduler/archive-sweep', nonHttpTarget: null },
  // : the daily durable export.
  { name: 'provian-jurisdiction-sdn-refresh', state: 'ENABLED', schedule: '15 */6 * * *', endpoint: '/v1/internal/scheduler/jurisdiction-sdn-refresh', nonHttpTarget: null },
  { name: 'provian-firestore-export', state: 'ENABLED', schedule: '30 3 * * 0', endpoint: '/v1/internal/scheduler/firestore-export', nonHttpTarget: null },
]);

const manifest = loadSchedulerManifest(MANIFEST_PATH);
const codeEndpoints = scanSchedulerEndpointsFromSource(SRC_DIR);
const clone = (jobs: readonly LiveJob[]): LiveJob[] => jobs.map((j) => ({ ...j }));

describe(' scheduler manifest reconcile — GREEN (real manifest + real source + live seed)', () => {
  it('current state reconciles cleanly, and does so over a non-vacuous population', () => {
    const r = reconcileScheduler({ manifest, codeEndpoints, liveJobs: SEED_LIVE_JOBS });
    // Print the evaluated counts so a pass over zero can never masquerade as green.
    // eslint-disable-next-line no-console
    console.log('[ GREEN] checked =', JSON.stringify(r.checked), 'errors =', r.errors);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checked.sourceEndpoints).toBeGreaterThanOrEqual(20);
    expect(r.checked.requiredEndpoints).toBeGreaterThanOrEqual(20);
    expect(r.checked.enabledHttpJobs).toBeGreaterThanOrEqual(15);
  });

  it('the manifest classifies exactly the endpoints present in source (both directions)', () => {
    const manifestPaths = new Set(manifest.endpoints.map((e) => e.path));
    const codeSet = new Set(codeEndpoints);
    expect(codeEndpoints.length).toBeGreaterThan(0);
    // every source endpoint classified
    expect(codeEndpoints.filter((p) => !manifestPaths.has(p))).toEqual([]);
    // no manifest entry for a nonexistent endpoint
    expect(manifest.endpoints.filter((e) => !codeSet.has(e.path)).map((e) => e.path)).toEqual([]);
  });
});

describe(' scheduler manifest reconcile — RED controls (each guard fed a violation)', () => {
  it('RED (task-specified): a required job removed from the live set → MISSING CRON', () => {
    const jobs = clone(SEED_LIVE_JOBS).filter((j) => j.name !== 'provian-institution-funding');
    const r = reconcileScheduler({ manifest, codeEndpoints, liveJobs: jobs });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('MISSING CRON') && e.includes('/institution-funding'))).toBe(true);
  });

  it('RED: a required job flipped to PAUSED → MISSING CRON (not-enabled)', () => {
    const jobs = clone(SEED_LIVE_JOBS).map((j) =>
      j.name === 'provian-genesis-inbound-usdc' ? { ...j, state: 'PAUSED' } : j);
    const r = reconcileScheduler({ manifest, codeEndpoints, liveJobs: jobs });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('MISSING CRON') && e.includes('/inbound-usdc') && e.includes('not ENABLED'))).toBe(true);
  });

  it('RED: a required job schedule drifted → SCHEDULE DRIFT', () => {
    const jobs = clone(SEED_LIVE_JOBS).map((j) =>
      j.name === 'provian-court-deadlines' ? { ...j, schedule: '*/7 * * * *' } : j);
    const r = reconcileScheduler({ manifest, codeEndpoints, liveJobs: jobs });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('SCHEDULE DRIFT') && e.includes('/court-deadlines'))).toBe(true);
  });

  it('RED: an ENABLED job pointing at a RETIRED endpoint → JOB ON UNSCHEDULED ENDPOINT', () => {
    // The retired advance-epoch endpoint has no job; re-creating an ENABLED one must fail.
    const jobs: LiveJob[] = [
      ...clone(SEED_LIVE_JOBS),
      { name: 'provian-advance-epoch', state: 'ENABLED', schedule: '0 6 * * *', endpoint: '/v1/internal/scheduler/advance-epoch', nonHttpTarget: null },
    ];
    const r = reconcileScheduler({ manifest, codeEndpoints, liveJobs: jobs });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('JOB ON UNSCHEDULED ENDPOINT') && e.includes('/advance-epoch'))).toBe(true);
  });

  it('RED: an ENABLED job pointing at a nonexistent endpoint → ORPHAN JOB / DEAD ENDPOINT', () => {
    const jobs: LiveJob[] = [
      ...clone(SEED_LIVE_JOBS),
      { name: 'provian-ghost', state: 'ENABLED', schedule: '*/5 * * * *', endpoint: '/v1/internal/scheduler/does-not-exist', nonHttpTarget: null },
    ];
    const r = reconcileScheduler({ manifest, codeEndpoints, liveJobs: jobs });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('ORPHAN JOB') && e.includes('DEAD ENDPOINT'))).toBe(true);
  });

  it('RED: an endpoint in source but absent from the manifest → UNCLASSIFIED ENDPOINT', () => {
    const withNew = [...codeEndpoints, '/v1/internal/scheduler/brand-new-thing'];
    const r = reconcileScheduler({ manifest, codeEndpoints: withNew, liveJobs: SEED_LIVE_JOBS });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('UNCLASSIFIED ENDPOINT') && e.includes('brand-new-thing'))).toBe(true);
  });

  it('RED: an ENABLED non-HTTP job not allowlisted → UNRECOGNIZED NON-HTTP JOB', () => {
    const jobs: LiveJob[] = [
      ...clone(SEED_LIVE_JOBS),
      { name: 'provian-rogue-run', state: 'ENABLED', schedule: '0 * * * *', endpoint: null, nonHttpTarget: 'some/cloud-run/job:run' },
    ];
    const r = reconcileScheduler({ manifest, codeEndpoints, liveJobs: jobs });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('UNRECOGNIZED NON-HTTP JOB') && e.includes('provian-rogue-run'))).toBe(true);
  });

  it('RED (vacuous guard): an empty source scan does NOT pass green', () => {
    const r = reconcileScheduler({ manifest, codeEndpoints: [], liveJobs: SEED_LIVE_JOBS });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('VACUOUS'))).toBe(true);
  });

  // F43: a scheduler-secret baked into httpTarget.headers is readable with cloudscheduler.jobs.get
  // and alone fires REAL PVT9 settlement — reconcile-scheduler.ts must flag it. Any live job,
  // enabled OR paused. The SEED jobs carry no headers, so the GREEN reconcile above already
  // proves this guard does not false-fire on the clean population (non-vacuity).
  it('RED (F43): an ENABLED job carrying an x-scheduler-secret header → SECRET IN JOB HEADER', () => {
    const jobs = clone(SEED_LIVE_JOBS).map((j) =>
      j.name === 'provian-action-type-reconcile' ? { ...j, headers: { 'x-scheduler-secret': 'leaked-value' } } : j,
    );
    const r = reconcileScheduler({ manifest, codeEndpoints, liveJobs: jobs });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('SECRET IN JOB HEADER') && e.includes('provian-action-type-reconcile'))).toBe(true);
  });

  it('RED (F43): a PAUSED job carrying an x-scheduler-secret header is flagged too (case-insensitive key)', () => {
    const jobs: LiveJob[] = [
      ...clone(SEED_LIVE_JOBS),
      { name: 'provian-legacy-secret', state: 'PAUSED', schedule: '0 * * * *', endpoint: '/v1/internal/scheduler/action-type-reconcile', nonHttpTarget: null, headers: { 'X-Scheduler-Secret': 'leaked' } },
    ];
    const r = reconcileScheduler({ manifest, codeEndpoints, liveJobs: jobs });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('SECRET IN JOB HEADER') && e.includes('provian-legacy-secret'))).toBe(true);
  });
});
