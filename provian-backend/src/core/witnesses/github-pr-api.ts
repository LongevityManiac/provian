import crypto from 'crypto';
import dns from 'dns/promises';
import { Agent, request } from 'https';
import { isPrivateIp } from '../net/private-ip';
import { pinnedLookup } from '../net/pinned-lookup';
import { raceDeadline, startDeadline } from '../net/bounded-fetch';

/** Only these repositories operate this gate. Installation tokens are narrowed to one. */
export const PR_GATE_REPOSITORIES = {
  provian: { id: 1447355401, ownerId: '229043875', name: 'LongevityManiac/provian', branches: ['master', 'prod'] },
  'provian-reference-gate': { id: 1412438684, ownerId: '229043875', name: 'LongevityManiac/provian-reference-gate', branches: ['main'] },
} as const;
export type PrGateRepository = keyof typeof PR_GATE_REPOSITORIES;
export function isPrGateRepository(v: unknown): v is PrGateRepository {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PR_GATE_REPOSITORIES, v);
}
export function objectOf(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}
export class GitHubPrApiError extends Error {
  constructor(public readonly status: number) { super(`github_pr_api_${status}`); }
}

/** Fixed HTTPS origin, all-address DNS validation, pinned socket, no redirects, bounded body. */
export async function githubPrRequest(method: string, path: string, token: string, body?: unknown, hostname: 'api.github.com' | 'github.com' = 'api.github.com'): Promise<unknown> {
  if (!path.startsWith('/') || path.startsWith('//') || /[\r\n]/.test(path)) throw new Error('invalid_github_api_path');
  const deadline = startDeadline(15_000);
  let agent: Agent | undefined;
  try {
    const addresses = await raceDeadline(dns.lookup(hostname, { all: true }), deadline);
    if (!addresses.length || addresses.some((a) => isPrivateIp(a.address))) throw new Error('github_dns_refused');
    agent = new Agent({ lookup: pinnedLookup(addresses[0].address) });
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return await raceDeadline(new Promise<unknown>((resolve, reject) => {
      const req = request({ hostname, port: 443, path, method, agent,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), accept: hostname === 'github.com' ? 'application/json' : 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28', 'user-agent': 'provian-pr-gate',
          ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) },
        signal: deadline.signal,
      }, (res) => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) { req.destroy(); reject(new Error('github_response_too_large')); return; }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) { reject(new GitHubPrApiError(status)); return; }
          try { resolve(size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown : null); }
          catch { reject(new Error('github_response_invalid')); }
        });
      });
      req.on('error', () => reject(new Error('github_request_failed')));
      req.end(bytes);
    }), deadline);
  } finally { deadline.clear(); agent?.destroy(); }
}

export interface PrGateApi {
  call(repo: PrGateRepository, method: string, suffix: string, body?: unknown): Promise<unknown>;
}
export class GitHubPrApi implements PrGateApi {
  private readonly tokens = new Map<string, { value: string; until: number }>();
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  private jwt(): string {
    const pem = this.env.GITHUB_APP_PRIVATE_KEY;
    const appId = this.env.GITHUB_APP_ID ?? '4570525';
    if (!pem || !/^[0-9]+$/.test(appId)) throw new Error('github_app_signing_unconfigured');
    const now = Math.floor(Date.now() / 1000);
    const data = [Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })).toString('base64url')].join('.');
    return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), pem).toString('base64url')}`;
  }
  private async token(repo: PrGateRepository): Promise<string> {
    const cached = this.tokens.get(repo);
    if (cached && cached.until > Date.now() + 60_000) return cached.value;
    const target = PR_GATE_REPOSITORIES[repo];
    const installation = objectOf(await githubPrRequest('GET', `/repos/${target.name}/installation`, this.jwt()));
    if (!Number.isSafeInteger(installation.id) || objectOf(installation.account).id !== Number(target.ownerId)) {
      throw new Error('github_installation_mismatch');
    }
    const result = objectOf(await githubPrRequest('POST', `/app/installations/${installation.id}/access_tokens`, this.jwt(), {
      repository_ids: [target.id], permissions: { checks: 'write', pull_requests: 'write', contents: 'write', metadata: 'read' },
    }));
    if (typeof result.token !== 'string' || typeof result.expires_at !== 'string') throw new Error('github_token_unavailable');
    this.tokens.set(repo, { value: result.token, until: Date.parse(result.expires_at) });
    return result.token;
  }
  async call(repo: PrGateRepository, method: string, suffix: string, body?: unknown): Promise<unknown> {
    const allowed: Record<string, RegExp> = {
      GET: /^\/(?:pulls(?:\/[1-9][0-9]*(?:\/reviews(?:\/[1-9][0-9]*)?)?)?|commits\/[a-f0-9]{40}\/check-runs|branches\/[A-Za-z0-9_%.-]+|issues\/(?:[1-9][0-9]*\/comments|comments\/[1-9][0-9]*)|collaborators\/[A-Za-z0-9-]+\/permission)(?:\?[A-Za-z0-9_=%&-]+)?$/,
      POST: /^\/(?:check-runs|issues\/[1-9][0-9]*\/(?:comments|labels))$/,
      PATCH: /^\/(?:check-runs\/[1-9][0-9]*|issues\/comments\/[1-9][0-9]*)$/,
      DELETE: /^\/issues\/[1-9][0-9]*\/labels\/presentation-required$/,
      PUT: /^\/pulls\/[1-9][0-9]*\/merge$/,
    };
    if (!isPrGateRepository(repo) || !allowed[method]?.test(suffix)) throw new Error('github_gate_path_refused');
    return githubPrRequest(method, `/repos/${PR_GATE_REPOSITORIES[repo].name}${suffix}`, await this.token(repo), body);
  }
}
