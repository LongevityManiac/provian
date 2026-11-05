/**
 * Minimal authenticated GCP REST client for the slice-6 collectors (infra + security).
 *
 * On Cloud Run, `GoogleAuth` picks up the runtime service account from the metadata server
 * with no key material. The runtime SA holds NO Editor : the custom role
 * `projects/provian-ai/roles/provianRelayRuntime` names exactly the calls made here (Cloud
 * Monitoring timeSeries + alert policies, Cloud Run v2 service get, Cloud Scheduler job list,
 * Secret Manager metadata list, Firestore database metadata + backup schedules + export, BigQuery
 * job create), plus bucket/dataset-level reads. A new GCP call here needs its permission added to
 * that role (`scripts/relay-iam-least-privilege.sh`), or its leg reads UNAVAILABLE.
 *
 * Fail-closed by construction: with no credentials (a local shell) `getGcpAccessToken` returns
 * null and every call returns `{status: 0, data: null}` the collector renders the leg as
 * UNAVAILABLE/unknown, never a fabricated green. Everything is injectable for unit tests.
 */

import { GoogleAuth } from 'google-auth-library';

export const CLOUD_PLATFORM_RO = 'https://www.googleapis.com/auth/cloud-platform.read-only';

let cachedAuth: GoogleAuth | null = null;
let cachedToken: { value: string; expiresAtMs: number } | null = null;
let loggedTokenFailure = false;

/** A metadata-server access token, cached until ~5 min before expiry. Null when no credentials
 * are available (never throws — the caller treats null as "unavailable").
 *
 * IMPORTANT — do NOT default to a restricted scope on Cloud Run. The Compute credential forwards
 * requested scopes to the metadata token endpoint as `?scopes=…` (see google-auth-library
 * computeclient.js), and the metadata server only mints a token for scopes the instance is
 * authorized for. A Cloud Run instance is authorized for full `cloud-platform`, NOT the
 * `cloud-platform.read-only` variant, so requesting read-only made the metadata call fail
 * ("instance does not have the correct permission scopes") → the swallowed throw returned a null
 * token and every GCP collector leg read as UNAVAILABLE in prod (caught live, slice 6).
 * With no explicit scope the Compute path returns the instance's default `cloud-platform` token;
 * the runtime SA's IAM roles — not the token scope — are what authorize these reads. */
export async function getGcpAccessToken(
  scopes: string | string[] | undefined = undefined,
  now: number = Date.now(),
): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAtMs - 60_000 > now) return cachedToken.value;
  try {
    if (!cachedAuth) cachedAuth = new GoogleAuth(scopes ? { scopes } : {});
    const client = await cachedAuth.getClient();
    const res = await client.getAccessToken();
    const token = typeof res === 'string' ? res : (res?.token ?? null);
    if (!token) return null;
    // getAccessToken() doesn't surface the exact expiry; tokens live ~1h, so cache 55 min.
    cachedToken = { value: token, expiresAtMs: now + 55 * 60_000 };
    return token;
  } catch (err) {
    // A null token blinds every GCP leg; log the reason ONCE so it is diagnosable without
    // re-blinding the operator surface (a silent catch is exactly what masked the scope bug).
    if (!loggedTokenFailure) {
      loggedTokenFailure = true;
      // eslint-disable-next-line no-console
      console.warn('[gcp-rest] metadata access-token unavailable:', (err as Error)?.message ?? err);
    }
    return null;
  }
}

/** Reset the token/auth cache (tests). */
export function __resetGcpRestForTest(): void {
  cachedAuth = null;
  cachedToken = null;
  loggedTokenFailure = false;
}

export interface GcpResult {
  /** HTTP status, or 0 when no credentials were available (request never sent). */
  readonly status: number;
  readonly data: unknown;
}

export interface GcpRestClient {
  getJson(url: string): Promise<GcpResult>;
  postJson(url: string, body: unknown): Promise<GcpResult>;
}

export interface GcpRestDeps {
  /** Injectable token source (tests). Defaults to the metadata-server token. */
  getAccessToken?: (now: number) => Promise<string | null>;
  /** Injectable fetch (tests). Defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  scopes?: string | string[];
}

export function createGcpRest(deps: GcpRestDeps = {}): GcpRestClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const getToken = deps.getAccessToken ?? ((n: number) => getGcpAccessToken(deps.scopes, n));

  async function call(method: 'GET' | 'POST', url: string, body?: unknown): Promise<GcpResult> {
    const token = await getToken(now());
    if (!token) return { status: 0, data: null };
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Awaited<ReturnType<typeof fetchImpl>>;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      return { status: 0, data: null }; // network error → unavailable, never a false green
    }
    let data: unknown = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  }

  return {
    getJson: (url) => call('GET', url),
    postJson: (url, body) => call('POST', url, body),
  };
}

/** The GCP project id the collectors query. Defaults to the production project. */
export function resolveGcpProjectId(env: Record<string, string | undefined> = process.env): string {
  return env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || env.GCP_PROJECT || 'provian-ai';
}
