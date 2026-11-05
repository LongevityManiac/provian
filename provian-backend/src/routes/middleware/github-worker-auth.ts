import type { Request } from 'express';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { GITHUB_TASK_AUDIENCE, GITHUB_TASK_IDENTITY, GITHUB_TASK_PATH } from '../../core/witnesses/github-task-queue';

const client = new OAuth2Client();
type VerifyWorkerToken = (token: string) => Promise<TokenPayload | undefined>;
const verify: VerifyWorkerToken = async token => (await client.verifyIdToken({ idToken: token, audience: GITHUB_TASK_AUDIENCE })).getPayload();

/** Dedicated principal, route-bound audience, no scheduler/shared-secret fallback. */
export async function authenticateGitHubWorker(req: Request, verifyToken: VerifyWorkerToken = verify): Promise<boolean> {
  const route = req.originalUrl.split('?')[0].replace(/\/$/, '').toLowerCase();
  if (req.method !== 'POST' || route !== GITHUB_TASK_PATH) return false;
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  try {
    const payload = await verifyToken(header.slice(7));
    return payload?.email === GITHUB_TASK_IDENTITY && payload.email_verified === true && payload.aud === GITHUB_TASK_AUDIENCE;
  } catch { return false; }
}
