import { createHash, randomBytes } from 'crypto';

/** Wallet authorization for an operator-controlled GitHub App to create one PR. */
export interface GitHubPrRequest {
  repository: 'provian' | 'provian-reference-gate';
  wallet_id: string;
  head: string;
  head_sha: string;
  base: string;
  title: string;
  body: string;
  nonce: string;
  issued_at: number;
}
export interface SignedGitHubPrRequest extends GitHubPrRequest { signature: string }

export function prepareGitHubPrRequest(input: unknown, walletId: string, nowMs = Date.now()): GitHubPrRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_pr_request');
  const v = input as Record<string, unknown>;
  if (v.wallet_id !== undefined && v.wallet_id !== walletId) throw new Error('pr_request_wallet_mismatch');
  const request = { repository: v.repository, wallet_id: walletId, head: v.head, head_sha: v.head_sha, base: v.base,
    title: v.title, body: v.body ?? '', nonce: v.nonce ?? randomBytes(32).toString('hex'), issued_at: v.issued_at ?? Math.floor(nowMs / 1000) };
  githubPrRequestMessage(request as GitHubPrRequest);
  return request as GitHubPrRequest;
}
export function githubPrRequestMessage(r: GitHubPrRequest): string {
  const branches = r.repository === 'provian' ? ['master', 'prod'] : r.repository === 'provian-reference-gate' ? ['main'] : [];
  if (!branches.includes(r.base) || typeof r.wallet_id !== 'string' || !/^wallet_aw_[A-Za-z0-9_-]{1,128}$/.test(r.wallet_id) ||
      typeof r.head !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9._/-]{0,179}$/.test(r.head) || /\.\.|\/\/|\/$|\.lock$/.test(r.head) ||
      typeof r.head_sha !== 'string' || !/^[a-f0-9]{40}$/.test(r.head_sha) || typeof r.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(r.nonce) ||
      !Number.isSafeInteger(r.issued_at) || r.issued_at <= 0 || typeof r.title !== 'string' || !r.title.trim() || r.title.length > 200 ||
      /[\r\n]/.test(r.title) || typeof r.body !== 'string' || Buffer.byteLength(r.body) > 60000) throw new Error('invalid_pr_request');
  const hash = (v: string): string => createHash('sha256').update(v).digest('hex');
  const fields: Record<string, string> = { repository: r.repository, wallet_id: r.wallet_id, head: r.head, head_sha: r.head_sha,
    base: r.base, title_sha256: hash(r.title), body_sha256: hash(r.body), nonce: r.nonce, issued_at: String(r.issued_at) };
  return 'provian-github-pr-creation-v1\n' + Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join('\n');
}
