import type { Request } from 'express';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { authenticateGitHubWorker } from './github-worker-auth';
import { GITHUB_TASK_IDENTITY, GITHUB_TASK_AUDIENCE, GITHUB_TASK_PATH } from '../../core/witnesses/github-task-queue';
const req = (changes: Partial<Request> = {}): Request => ({ method: 'POST', originalUrl: GITHUB_TASK_PATH, headers: { authorization: 'Bearer signed-token' }, ...changes } as Request);
const payload: TokenPayload = { iss: 'https://accounts.google.com', sub: 'worker-id', aud: GITHUB_TASK_AUDIENCE, iat: 1, exp: 9999999999, email: GITHUB_TASK_IDENTITY, email_verified: true };
afterEach(() => jest.restoreAllMocks());
it('verifies the Google signature with the exact worker-route audience before accepting its dedicated identity', async () => {
  const verify = jest.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockResolvedValue({ getPayload: () => payload } as never);
  expect(await authenticateGitHubWorker(req())).toBe(true);
  expect(verify).toHaveBeenCalledWith({ idToken: 'signed-token', audience: GITHUB_TASK_AUDIENCE });
  expect(await authenticateGitHubWorker(req({ originalUrl: GITHUB_TASK_PATH.toUpperCase() + '/' }))).toBe(true);
});
it.each([
  { email: 'provian-scheduler@provian-ai.iam.gserviceaccount.com' },
  { email: '185909722463-compute@developer.gserviceaccount.com' },
  { email_verified: false }, { aud: 'https://provian-api-185909722463.us-central1.run.app' },
])('RED: refuses a different principal or audience %p', async change => {
  expect(await authenticateGitHubWorker(req(), async () => ({ ...payload, ...change }))).toBe(false);
});
it.each(['/v1/internal/scheduler/github-pr-gates', '/v1/internal/tasks/github/foreign', '/v1/internal/tasks/github-other'])('RED: the worker identity grants no access to %s', async originalUrl => {
  const verify = jest.fn(async () => payload);
  expect(await authenticateGitHubWorker(req({ originalUrl }), verify)).toBe(false);
  expect(verify).not.toHaveBeenCalled();
});
it('RED: missing JWT, forged queue headers, scheduler secret and failed signature never authorize the worker', async () => {
  expect(await authenticateGitHubWorker(req({ headers: { 'x-cloudtasks-queuename': 'provian-github-webhooks', 'x-scheduler-secret': 'present' } }), async () => payload)).toBe(false);
  expect(await authenticateGitHubWorker(req(), async () => { throw new Error('invalid_signature'); })).toBe(false);
  expect(await authenticateGitHubWorker(req({ method: 'GET' }), async () => payload)).toBe(false);
});
