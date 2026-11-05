/** Push only opaque work references; payloads and replay authority stay in the durable inbox. */
import crypto from 'crypto';
import dns from 'dns/promises';
import { Agent, request } from 'https';
import { getGcpAccessToken } from '../cloud/google-rest';
import { isPrivateIp } from '../net/private-ip';
import { pinnedLookup } from '../net/pinned-lookup';
import { raceDeadline, startDeadline } from '../net/bounded-fetch';
import { isPrGateRepository, type PrGateRepository } from './github-pr-api';

export const GITHUB_TASK_QUEUE = 'projects/provian-ai/locations/us-central1/queues/provian-github-webhooks';
export const GITHUB_TASK_ORIGIN = 'https://provian-api-185909722463.us-central1.run.app';
export const GITHUB_TASK_PATH = '/v1/internal/tasks/github';
export const GITHUB_TASK_IDENTITY = 'provian-github-worker@provian-ai.iam.gserviceaccount.com';
export const GITHUB_TASK_AUDIENCE = GITHUB_TASK_ORIGIN + GITHUB_TASK_PATH;
export type GitHubTask = { kind: 'receipt'; id: string } |
  { kind: 'pr_gate'; repo: PrGateRepository; number: number; burnId: string };

export function isGitHubTask(value: unknown): value is GitHubTask {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.kind === 'receipt' ? typeof v.id === 'string' && /^[a-f0-9]{64}$/.test(v.id) :
    v.kind === 'pr_gate' && isPrGateRepository(v.repo) && Number.isSafeInteger(v.number) &&
    Number(v.number) > 0 && typeof v.burnId === 'string' && /^[a-f0-9]{64}$/.test(v.burnId);
}

export function githubTaskRequest(task: GitHubTask, now = Date.now()): object {
  if (!isGitHubTask(task)) throw new Error('invalid_github_task');
  // Daily generations let the recovery net redispatch after transport retention/tombstone expiry.
  const id = crypto.createHash('sha256').update(`${JSON.stringify(task)}:${Math.floor(now / 86_400_000)}`).digest('hex');
  return { task: { name: `${GITHUB_TASK_QUEUE}/tasks/${id}`, dispatchDeadline: '1800s', httpRequest: {
    httpMethod: 'POST', url: `${GITHUB_TASK_ORIGIN}${GITHUB_TASK_PATH}`,
    headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify(task)).toString('base64'),
    oidcToken: { serviceAccountEmail: GITHUB_TASK_IDENTITY, audience: GITHUB_TASK_AUDIENCE },
  } } };
}

/** Fixed Google API origin, private-address refusal, pinned DNS, no redirects, bounded exchange. */
export async function enqueueGitHubTask(task: GitHubTask): Promise<void> {
  const body = Buffer.from(JSON.stringify(githubTaskRequest(task)));
  const deadline = startDeadline(4000);
  let agent: Agent | undefined;
  try {
    const token = await raceDeadline(getGcpAccessToken(), deadline);
    if (!token) throw new Error('github_task_auth_unavailable');
    const hostname = 'cloudtasks.googleapis.com';
    const addresses = await raceDeadline(dns.lookup(hostname, { all: true }), deadline);
    if (!addresses.length || addresses.some(a => isPrivateIp(a.address))) throw new Error('github_task_dns_refused');
    agent = new Agent({ lookup: pinnedLookup(addresses[0].address) });
    const status = await raceDeadline(new Promise<number>((resolve, reject) => {
      const req = request({ hostname, port: 443, path: `/v2/${GITHUB_TASK_QUEUE}/tasks`, method: 'POST', agent,
        signal: deadline.signal, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': body.length },
      }, res => {
        let size = 0;
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 64 * 1024) req.destroy(new Error('github_task_response_too_large')); });
        res.on('error', reject);
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', () => reject(new Error('github_task_request_failed')));
      req.end(body);
    }), deadline);
    if ((status < 200 || status >= 300) && status !== 409) throw new Error(`github_task_enqueue_${status}`);
  } finally { deadline.clear(); agent?.destroy(); }
}
