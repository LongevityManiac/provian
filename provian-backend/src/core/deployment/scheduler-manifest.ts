/**
 * Scheduler manifest + reconcile.
 *
 * THE CLASS FIX for / / three times a deployed scheduler
 * endpoint shipped with no Cloud Scheduler job (or a job outlived its endpoint),
 * and nobody noticed until a cursor froze or webhooks silently stopped — because
 * the endpoint↔job mapping lived only in gcloud state, with nothing in the repo
 * to check it against.
 *
 * `scheduler-jobs.json` is now that source of truth. This module reconciles it
 * two ways:
 * - IN CI, against SOURCE (`scanSchedulerEndpointsFromSource`): an endpoint
 * added to code without a manifest entry, or a manifest entry for an endpoint
 * that no longer exists, fails `scheduler-manifest.test.ts`.
 * - AT DEPLOY, against LIVE gcloud state (`scripts/reconcile-scheduler.ts`, a
 * HARD gate in `deploy-env.sh`): a `required` endpoint with no ENABLED job, a
 * schedule that drifted, or an ENABLED job pointing at a retired/unclassified
 * endpoint fails the deploy.
 *
 * The reconcile itself is a PURE function so the RED controls can drive it with
 * mutated inputs and prove each guard fires.
 */
import fs from 'fs';
import path from 'path';

export interface ManifestEndpoint {
  /** The full request path, e.g. `/v1/internal/scheduler/inbound-usdc`. */
  readonly path: string;
  /** true = MUST have an ENABLED job; false = MUST NOT have an ENABLED job. */
  readonly required: boolean;
  /** Expected job name (the ENABLED job for required; the paused job, if any, for unscheduled). */
  readonly job?: string | null;
  /** Expected cron for a required endpoint. */
  readonly schedule?: string | null;
  /** Why an endpoint is unscheduled (retired | quarantined | operator_invoked | superseded). */
  readonly reason?: string;
  /** For unscheduled endpoints that keep a paused job, the state it must NOT exceed. */
  readonly jobStateExpected?: string;
  readonly note?: string;
}

export interface ManifestNonHttpJob {
  readonly job: string;
  readonly target: string;
  readonly enabledExpected: boolean;
  readonly reason?: string;
  readonly note?: string;
}

export interface SchedulerManifest {
  readonly location: string;
  readonly project: string;
  readonly serviceUrl: string;
  readonly serviceUrls?: readonly string[];
  readonly endpoints: readonly ManifestEndpoint[];
  readonly nonHttpJobs: readonly ManifestNonHttpJob[];
}

/** One Cloud Scheduler job, normalized. `endpoint` is the extracted request path (null for non-HTTP targets). */
export interface LiveJob {
  readonly uri?: string | null;
  readonly name: string;
  readonly state: string; // 'ENABLED' | 'PAUSED' | ...
  readonly schedule: string;
  readonly endpoint: string | null;
  readonly nonHttpTarget?: string | null;
  /** The job's httpTarget.headers, if any. Used to flag a baked-in x-scheduler-secret (F43). */
  readonly headers?: Record<string, string> | null;
}

/**
 * A job's HTTP target, classified the one way the deploy reconcile and the Command Center both use:
 * a relay scheduler path (`/v1/internal/...`) is an `endpoint`; any other target — a separate
 * service such as the x402 facilitator, or a non-HTTP target — is a `nonHttpTarget`, which must be
 * allowlisted in `nonHttpJobs`. Reading every URL's pathname as a relay endpoint made the
 * facilitator's `/internal/refill` look like a dead relay endpoint.
 */
export function jobTargetFromUri(uri: string | null | undefined): { endpoint: string | null; nonHttpTarget: string | null } {
  if (!uri) return { endpoint: null, nonHttpTarget: null };
  const m = uri.match(/\/v1\/internal\/[a-z0-9/-]+$/);
  if (m) return { endpoint: m[0], nonHttpTarget: null };
  return { endpoint: null, nonHttpTarget: uri };
}

/** Header keys a Cloud Scheduler job must NEVER carry: a plaintext shared secret readable with
 *  cloudscheduler.jobs.get. OIDC (audience-bound, SA-verified) is the sole scheduler auth (F43). */
const FORBIDDEN_JOB_HEADER_KEYS = ['x-scheduler-secret', 'x-admin-secret'] as const;

export interface ReconcileResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly checked: {
    readonly sourceEndpoints: number;
    readonly requiredEndpoints: number;
    readonly enabledHttpJobs: number;
  };
}

/** Matches every scheduler-driven request path in source: `/v1/internal/scheduler/<name>`
 * plus the two scheduled endpoints that live outside `/scheduler/` — the daily
 * spending digest and the PVT9 settlement runner (scheduled standard + daily Genesis, ; the settlement
 * route also accepts a manual admin+token call, but it is scheduler-driven now). */
const ENDPOINT_RE = /\/v1\/internal\/(?:scheduler\/[a-z0-9-]+|settlement\/pvt9(?:-genesis)?-run|daily-spending-digest)/g;

/**
 * Scan real source for every scheduler-driven endpoint path (excluding test
 * files, so the `/scheduler/test` fixture and any test-only literal are ignored).
 * This is what makes the manifest↔code check bind to reality, not to a copy.
 */
export function scanSchedulerEndpointsFromSource(srcDir: string): string[] {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      if (entry.name.includes('.test.') || entry.name.endsWith('.d.ts')) continue;
      const text = fs.readFileSync(full, 'utf8');
      const matches = text.match(ENDPOINT_RE);
      if (matches) for (const m of matches) found.add(m);
    }
  };
  walk(srcDir);
  return Array.from(found).sort();
}

export function loadSchedulerManifest(manifestPath: string): SchedulerManifest {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SchedulerManifest;
}

/**
 * The one reconcile. Pure: no IO, no gcloud, no source read — the caller supplies
 * the manifest, the endpoints found in source, and the live job inventory.
 * Returns every violation it finds (not just the first) so a deploy operator sees
 * the whole picture at once.
 */
export function reconcileScheduler(input: {
  manifest: SchedulerManifest;
  codeEndpoints: readonly string[];
  liveJobs: readonly LiveJob[];
}): ReconcileResult {
  const { manifest, codeEndpoints } = input;
  const origins = new Set([manifest.serviceUrl, ...(manifest.serviceUrls ?? [])].filter(Boolean).map((url) => new URL(url).origin));
  const expectedNames = new Set([...manifest.endpoints.map((e) => e.job), ...manifest.nonHttpJobs.map((e) => e.job)]);
  const liveJobs = input.liveJobs.flatMap((job) => {
    if (!job.uri || !job.endpoint || origins.size === 0) return [job];
    if (origins.has(new URL(job.uri).origin)) return [job];
    // Other services own their internal routes. A declared local job redirected
    // elsewhere still fails the required-job and external-target guards.
    return expectedNames.has(job.name) ? [{ ...job, endpoint: null, nonHttpTarget: job.uri }] : [];
  });
  const errors: string[] = [];

  // Vacuous-population guards : a reconcile over zero endpoints, or a
  // manifest with none, would pass every ∀-quantified rule below while proving
  // nothing. Treat either as a failure, never a silent green.
  if (manifest.endpoints.length === 0) {
    errors.push('VACUOUS: manifest has zero endpoints.');
  }
  if (codeEndpoints.length === 0) {
    errors.push('VACUOUS: zero scheduler endpoints scanned from source — the source scan is broken; refusing to pass.');
  }

  const byPath = new Map(manifest.endpoints.map((e) => [e.path, e]));
  const codeSet = new Set(codeEndpoints);

  // (1) Every endpoint in source must be classified in the manifest.
  // THE // GUARD: a new scheduler endpoint cannot ship without
  //     a deliberate required/unscheduled decision (and, if required, a job).
  for (const ep of codeEndpoints) {
    if (!byPath.has(ep)) {
      errors.push(
        `UNCLASSIFIED ENDPOINT: ${ep} exists in source but is absent from scheduler-jobs.json. `
        + `Add it — required:true with job+schedule, or required:false with a reason.`,
      );
    }
  }

  // (2) The manifest must not reference an endpoint that no longer exists in source.
  for (const e of manifest.endpoints) {
    if (!codeSet.has(e.path)) {
      errors.push(`DEAD MANIFEST ENTRY: ${e.path} is in scheduler-jobs.json but no such endpoint exists in source.`);
    }
  }

  const jobsByEndpoint = new Map<string, LiveJob[]>();
  for (const j of liveJobs) {
    if (j.endpoint) {
      const list = jobsByEndpoint.get(j.endpoint) ?? [];
      list.push(j);
      jobsByEndpoint.set(j.endpoint, list);
    }
  }

  // (3) Every REQUIRED endpoint must have an ENABLED job at the declared schedule.
  // THE GUARD: a required endpoint with no live enabled cron fails.
  for (const e of manifest.endpoints) {
    if (!e.required) continue;
    const jobs = jobsByEndpoint.get(e.path) ?? [];
    const enabled = jobs.filter((j) => j.state === 'ENABLED');
    if (enabled.length === 0) {
      const hasPaused = jobs.length > 0;
      errors.push(
        `MISSING CRON: required endpoint ${e.path} has no ENABLED Cloud Scheduler job`
        + `${hasPaused ? ' (a job exists but is not ENABLED)' : ' (no job at all)'}. `
        + `Expected "${e.job ?? '?'}" @ "${e.schedule ?? '?'}".`,
      );
      continue;
    }
    if (e.schedule && !enabled.some((j) => j.schedule === e.schedule)) {
      errors.push(
        `SCHEDULE DRIFT: ${e.path} enabled job schedule `
        + `${enabled.map((j) => `"${j.schedule}"`).join(', ')} != manifest "${e.schedule}".`,
      );
    }
    if (e.job && !enabled.some((j) => j.name === e.job)) {
      errors.push(
        `JOB NAME DRIFT: ${e.path} is enabled by ${enabled.map((j) => j.name).join(', ')}, `
        + `manifest expects "${e.job}".`,
      );
    }
  }

  // (4) Every ENABLED HTTP job must target an endpoint classified REQUIRED.
  //     THE "job points at a dead/retired endpoint" GUARD.
  for (const j of liveJobs) {
    if (j.state !== 'ENABLED' || !j.endpoint) continue;
    const e = byPath.get(j.endpoint);
    if (!e) {
      errors.push(
        `ORPHAN JOB: enabled job "${j.name}" targets ${j.endpoint}, which is not in the manifest`
        + `${codeSet.has(j.endpoint) ? '' : ' and does not exist in source (DEAD ENDPOINT)'}.`,
      );
    } else if (!e.required) {
      errors.push(
        `JOB ON UNSCHEDULED ENDPOINT: enabled job "${j.name}" targets ${j.endpoint}, `
        + `classified unscheduled (${e.reason ?? 'no reason'}). Pause/delete it, or reclassify the endpoint.`,
      );
    }
  }

  // (6) No job (enabled OR paused) may carry a plaintext shared secret in its headers.
  //     F43 GUARD: a scheduler-secret baked into httpTarget.headers is readable with
  //     cloudscheduler.jobs.get and alone fires REAL PVT9 settlement — OIDC is the sole auth.
  for (const j of liveJobs) {
    const headers = j.headers ?? {};
    for (const key of Object.keys(headers)) {
      if ((FORBIDDEN_JOB_HEADER_KEYS as readonly string[]).includes(key.toLowerCase())) {
        errors.push(
          `SECRET IN JOB HEADER: job "${j.name}" carries a "${key}" header — a plaintext shared `
          + `secret readable with cloudscheduler.jobs.get. Remove it (OIDC is the sole scheduler `
          + `auth, F43) and rotate scheduler-secret.`,
        );
      }
    }
  }

  // (5) Every ENABLED non-HTTP job must be allowlisted in nonHttpJobs.
  const allowedNonHttp = new Set(
    manifest.nonHttpJobs.filter((n) => n.enabledExpected).map((n) => n.job),
  );
  for (const j of liveJobs) {
    if (j.state !== 'ENABLED' || j.endpoint) continue;
    if (!allowedNonHttp.has(j.name)) {
      errors.push(
        `UNRECOGNIZED NON-HTTP JOB (enabled): "${j.name}" -> ${j.nonHttpTarget ?? '?'}. `
        + `Add it to manifest.nonHttpJobs (enabledExpected:true), or pause it.`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    checked: {
      sourceEndpoints: codeEndpoints.length,
      requiredEndpoints: manifest.endpoints.filter((e) => e.required).length,
      enabledHttpJobs: liveJobs.filter((j) => j.state === 'ENABLED' && j.endpoint).length,
    },
  };
}
