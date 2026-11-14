import { reconcileScheduler, type SchedulerManifest, type LiveJob, type ReconcileResult } from './scheduler-manifest';

export const RECOURSE_HELD_JOBS = Object.freeze([
  'provian-pvt9-settlement', 'provian-pvt9-genesis-settlement', 'provian-payout-sweep',
  'provian-daily-pe-anchor', 'provian-pvt9-epoch-keeper',
]);
export function assertRecourseWriterFence(value: unknown, nowMs = Date.now()): void {
  const row = value as { protocol?: unknown; active?: unknown; recourse_changeover?: {
    run?: unknown; source?: unknown; held_at_ms?: unknown; completion?: unknown;
  } } | null;
  const hold = row?.recourse_changeover;
  if (row?.protocol !== 'canonical-nonce-v1' || row.active !== false || !hold
    || typeof hold.run !== 'string' || hold.run.length === 0
    || typeof hold.source !== 'string' || !/^[0-9a-f]{40}$/.test(hold.source)
    || !Number.isSafeInteger(hold.held_at_ms) || Number(hold.held_at_ms) <= 0
    || Number(hold.held_at_ms) > nowMs || hold.completion !== undefined) throw Error('recourse_scheduler_writer_fence_required');
}

/** Deployment-only maintenance admission. The CLI must read the actual writer
 * fence before and after reading live jobs. This grants no permission to run a
 * job or reopen writers. Only the five named, exactly matching PAUSED jobs can
 * substitute for their normally required ENABLED state. All ordinary source,
 * target, schedule, name, secret-header and orphan checks still run. */
export function reconcileRecourseSchedulerHold(input: {
  manifest: SchedulerManifest; codeEndpoints: readonly string[]; liveJobs: readonly LiveJob[];
  fence: unknown; nowMs?: number;
}): ReconcileResult {
  assertRecourseWriterFence(input.fence, input.nowMs);
  const ordinary = reconcileScheduler(input);
  const errors: string[] = [];
  for (const name of RECOURSE_HELD_JOBS) {
    const entries = input.manifest.endpoints.filter(row => row.job === name && row.required);
    const jobs = input.liveJobs.filter(row => row.name === name);
    if (entries.length !== 1 || jobs.length !== 1 || jobs[0].state !== 'PAUSED'
      || !entries[0].schedule || jobs[0].schedule !== entries[0].schedule || jobs[0].endpoint !== entries[0].path
      || input.liveJobs.filter(row => row.endpoint === entries[0].path).length !== 1) {
      errors.push(`INVALID CHANGEOVER HOLD: ${name} must be the sole declared job at its original target/schedule and PAUSED.`);
    }
  }
  if (errors.length) {
    return { ...ordinary, ok: false, errors: [...errors, ...ordinary.errors] };
  }
  const held = new Set(RECOURSE_HELD_JOBS);
  const checked = reconcileScheduler({ ...input, liveJobs: input.liveJobs.map(job => held.has(job.name) ? { ...job, state: 'ENABLED' } : job) });
  return { ...checked, checked: { ...checked.checked, enabledHttpJobs: ordinary.checked.enabledHttpJobs } };
}
