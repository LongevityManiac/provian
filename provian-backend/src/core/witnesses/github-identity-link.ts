import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import { githubPrRequest, objectOf } from './github-pr-api';

export const GITHUB_WALLET_LINKS = 'github_wallet_links_v1';
const SESSIONS = 'github_identity_sessions_v1';
export class GitHubIdentityError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export interface GitHubIdentityDeps {
  db: Firestore;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  request?: typeof githubPrRequest;
}
function secret(deps: GitHubIdentityDeps): Buffer {
  const value = (deps.env ?? process.env).TOKEN_SIGNING_SECRET;
  if (!value || value.length < 32) throw new GitHubIdentityError(503, 'identity_link_unavailable');
  return crypto.createHash('sha256').update('github-device-code-v1\0').update(value).digest();
}
function seal(deps: GitHubIdentityDeps, code: string): string {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', secret(deps), iv);
  return Buffer.concat([iv, cipher.update(code), cipher.final(), cipher.getAuthTag()]).toString('base64');
}
function open(deps: GitHubIdentityDeps, sealed: string): string {
  const bytes = Buffer.from(sealed, 'base64');
  const cipher = crypto.createDecipheriv('aes-256-gcm', secret(deps), bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8');
}
const clientId = (deps: GitHubIdentityDeps): string => (deps.env ?? process.env).GITHUB_APP_CLIENT_ID ?? 'Iv23liJKnWY7Mlexi5ff';
export async function startGitHubIdentity(deps: GitHubIdentityDeps, walletId: string): Promise<Record<string, unknown>> {
  secret(deps);
  const data = objectOf(await (deps.request ?? githubPrRequest)('POST', '/login/device/code', '', { client_id: clientId(deps) }, 'github.com'));
  if (typeof data.device_code !== 'string' || typeof data.user_code !== 'string' || data.verification_uri !== 'https://github.com/login/device' ||
      !Number.isSafeInteger(data.expires_in) || Number(data.expires_in) < 1 || Number(data.expires_in) > 900) {
    throw new GitHubIdentityError(503, 'github_device_flow_unavailable');
  }
  const state = crypto.randomBytes(32).toString('hex'); const now = deps.now?.() ?? Date.now();
  const interval = Math.max(5, Math.min(60, Number(data.interval) || 5));
  const expiresAt = now + Number(data.expires_in) * 1000;
  await deps.db.collection(SESSIONS).doc(state).create({ wallet_id: walletId, code: seal(deps, data.device_code),
    interval, next_poll: now + interval * 1000, expires_at: expiresAt, expire_at: Timestamp.fromMillis(expiresAt), status: 'pending' });
  return { state, user_code: data.user_code, verification_uri: data.verification_uri, expires_at: expiresAt, interval };
}
export async function pollGitHubIdentity(deps: GitHubIdentityDeps, walletId: string, state: string): Promise<Record<string, unknown>> {
  if (!/^[a-f0-9]{64}$/.test(state)) throw new GitHubIdentityError(400, 'invalid_identity_session');
  const ref = deps.db.collection(SESSIONS).doc(state); const now = deps.now?.() ?? Date.now();
  const session = await deps.db.runTransaction(async (tx) => {
    const data = (await tx.get(ref)).data();
    if (!data || data.wallet_id !== walletId) throw new GitHubIdentityError(404, 'identity_session_not_found');
    if (data.status === 'completed') return data;
    if (data.expires_at <= now) throw new GitHubIdentityError(410, 'identity_session_expired');
    if (data.next_poll > now) return null;
    tx.update(ref, { next_poll: now + Math.max(30, data.interval) * 1000 });
    return data;
  });
  if (!session) return { status: 'pending' };
  if (session.status === 'completed') return { status: 'completed', github_login: session.github_login, github_id: session.github_id };
  const result = objectOf(await (deps.request ?? githubPrRequest)('POST', '/login/oauth/access_token', '', {
    client_id: clientId(deps), device_code: open(deps, session.code), grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  }, 'github.com'));
  if (result.error === 'authorization_pending' || result.error === 'slow_down') {
    await ref.update({ next_poll: now + (session.interval + (result.error === 'slow_down' ? 5 : 0)) * 1000,
      interval: session.interval + (result.error === 'slow_down' ? 5 : 0) });
    return { status: 'pending' };
  }
  if (typeof result.access_token !== 'string') throw new GitHubIdentityError(403, 'github_authorization_refused_restart_link');
  // Tokens stay in this call only. Identity comes exclusively from GitHub GET /user.
  const user = objectOf(await (deps.request ?? githubPrRequest)('GET', '/user', result.access_token));
  if (!Number.isSafeInteger(user.id) || typeof user.login !== 'string') throw new GitHubIdentityError(403, 'github_identity_invalid');
  const githubId = String(user.id);
  await deps.db.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data();
    if (current?.wallet_id !== walletId || current.expires_at <= (deps.now?.() ?? Date.now())) throw new GitHubIdentityError(410, 'identity_session_expired');
    tx.set(deps.db.collection(GITHUB_WALLET_LINKS).doc(`${githubId}_${walletId}`), {
      github_id: githubId, github_login: user.login, wallet_id: walletId, verified_at: now, verified_by: 'github_user_oauth', revoked_at: null,
    });
    tx.set(ref, { wallet_id: walletId, status: 'completed', github_id: githubId, github_login: user.login,
      expires_at: session.expires_at, expire_at: Timestamp.fromMillis(session.expires_at) });
  });
  return { status: 'completed', github_id: githubId, github_login: user.login };
}
export async function revokeGitHubIdentity(deps: GitHubIdentityDeps, id: string): Promise<void> {
  if (!/^[0-9]+$/.test(id)) throw new GitHubIdentityError(400, 'invalid_github_identity');
  // A per-account revocation fence also covers any number of linked wallets.
  await deps.db.collection('github_identity_revocations_v1').doc(id).set({ revoked_at: deps.now?.() ?? Date.now() });
}
