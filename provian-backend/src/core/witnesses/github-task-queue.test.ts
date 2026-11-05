import { EventEmitter } from 'events';
import dns from 'dns/promises';
import https from 'https';
import { getGcpAccessToken } from '../cloud/google-rest';
import { enqueueGitHubTask, githubTaskRequest, isGitHubTask, GITHUB_TASK_QUEUE, GITHUB_TASK_ORIGIN, GITHUB_TASK_PATH, GITHUB_TASK_IDENTITY, GITHUB_TASK_AUDIENCE } from './github-task-queue';
jest.mock('../cloud/google-rest', () => ({ getGcpAccessToken: jest.fn(async () => 'access-token') }));
const task = { kind: 'receipt' as const, id: 'a'.repeat(64) };
afterEach(() => { jest.restoreAllMocks(); });
it('binds opaque references to the fixed worker and existing OIDC identity with deterministic daily recovery', () => {
  const body = githubTaskRequest(task, 0) as { task: { name: string; httpRequest: { url: string; body: string; oidcToken: unknown } } };
  expect(body.task.name).toMatch(new RegExp(`^${GITHUB_TASK_QUEUE}/tasks/[a-f0-9]{64}$`));
  expect(body.task.httpRequest.url).toBe(GITHUB_TASK_ORIGIN + GITHUB_TASK_PATH);
  expect(body.task.httpRequest.oidcToken).toEqual({ serviceAccountEmail: GITHUB_TASK_IDENTITY, audience: GITHUB_TASK_AUDIENCE });
  expect(JSON.parse(Buffer.from(body.task.httpRequest.body, 'base64').toString())).toEqual(task);
  expect(githubTaskRequest(task, 1)).toEqual(body);
  expect(githubTaskRequest(task, 86_400_000)).not.toEqual(body);
  expect(isGitHubTask({ kind: 'pr_gate', repo: 'provian', number: 6, burnId: 'b'.repeat(64) })).toBe(true);
});
it.each([{ ...task, id: '../x' }, { kind: 'pr_gate', repo: 'foreign', number: 1, burnId: 'b'.repeat(64) },
  { kind: 'pr_gate', repo: 'provian', number: 0, burnId: 'b'.repeat(64) }, null])('RED: refuses malformed or foreign task %p', value => {
  expect(isGitHubTask(value)).toBe(false);
});
function transport(status: number) {
  const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error: Error) => void };
  req.destroy = error => { req.emit('error', error); };
  const res = new EventEmitter() as EventEmitter & { statusCode: number };
  res.statusCode = status;
  const call = jest.spyOn(https, 'request').mockImplementation((_options: unknown, cb: unknown) => {
    req.end = () => { (cb as (res: unknown) => void)(res); res.emit('data', Buffer.from('{}')); res.emit('end'); };
    return req as never;
  });
  jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '142.250.1.1', family: 4 }] as never);
  return call;
}
it.each([200, 409])('treats queue response %i as durable dispatch', async status => {
  const call = transport(status); await enqueueGitHubTask(task);
  expect(call).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'cloudtasks.googleapis.com', method: 'POST', path: `/v2/${GITHUB_TASK_QUEUE}/tasks` }), expect.any(Function));
});
it.each([302, 403, 500])('RED: queue response %i cannot acknowledge dispatch', async status => {
  transport(status); await expect(enqueueGitHubTask(task)).rejects.toThrow(`github_task_enqueue_${status}`);
});
it('RED: refuses private DNS and missing credentials before making a request', async () => {
  const call = transport(200);
  jest.mocked(dns.lookup).mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
  await expect(enqueueGitHubTask(task)).rejects.toThrow('dns_refused'); expect(call).not.toHaveBeenCalled();
  jest.mocked(getGcpAccessToken).mockResolvedValueOnce(null);
  await expect(enqueueGitHubTask(task)).rejects.toThrow('auth_unavailable'); expect(call).not.toHaveBeenCalled();
});
