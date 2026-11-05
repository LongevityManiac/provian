import crypto from 'crypto';
import type { AgentBankDeps } from '../agent-bank/types';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { handleGitHubWebhook } from './github-webhook';
import { approvePrMerge, mergeApprovedPr, syncPrGate } from './github-pr-gate';
import { PR_GATE_REPOSITORIES } from './github-pr-api';

jest.mock('./github-pr-gate', () => ({ syncPrGate: jest.fn(async () => undefined), approvePrMerge: jest.fn(async () => true), mergeApprovedPr: jest.fn(async () => true) }));
const secret = 'a'.repeat(64);
const payload = () => ({ action: 'opened', repository: { name: 'provian', id: Number(PR_GATE_REPOSITORIES.provian.id),
  full_name: PR_GATE_REPOSITORIES.provian.name }, pull_request: { number: 1, head: { sha: 'a'.repeat(40) }, base: { ref: 'master', sha: 'f'.repeat(40) } }, installation: { id: 123 } });
const config = { enabled: true, webhookSecret: secret, appSlug: 'provian-git-witness' };
function input(value: unknown, signature?: string) {
  const rawBody = JSON.stringify(value);
  return { rawBody, signatureHeader: signature ?? `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`,
    eventType: 'pull_request', deliveryId: 'test-delivery', config };
}
describe('PR gate webhook isolation', () => {
  const prior = process.env.GITHUB_PR_GATE_ENABLED;
  beforeEach(() => { process.env.GITHUB_PR_GATE_ENABLED = 'true'; jest.clearAllMocks(); });
  afterAll(() => { if (prior === undefined) delete process.env.GITHUB_PR_GATE_ENABLED; else process.env.GITHUB_PR_GATE_ENABLED = prior; });
  const deps = () => ({ db: createFakeFirestore() }) as unknown as AgentBankDeps;
  it.each(['opened', 'reopened', 'synchronize'])('handles a signed %s event for the exact repository', async (action) => {
    await handleGitHubWebhook(deps(), input({ ...payload(), action }));
    expect(syncPrGate).toHaveBeenCalledWith(expect.anything(), 'provian', 1);
  });
  it('RED: invalid HMAC never reaches the PR gate', async () => {
    expect((await handleGitHubWebhook(deps(), input(payload(), 'sha256=' + '0'.repeat(64)))).status).toBe(401);
    expect(syncPrGate).not.toHaveBeenCalled();
  });
  it('RED: matching name with a foreign repository id never reaches the gate', async () => {
    const p = payload(); p.repository.id = 42;
    await handleGitHubWebhook(deps(), input(p)); expect(syncPrGate).not.toHaveBeenCalled();
  });
  it('only the owner’s signed submitted review can request a merge', async () => {
    const p = { ...payload(), action: 'submitted', sender: { id: 229043875 }, review: { id: 77, state: 'approved' } };
    const result = await handleGitHubWebhook(deps(), { ...input(p), eventType: 'pull_request_review' });
    expect(result.body.merged).toBe(true);
    expect(approvePrMerge).toHaveBeenCalledWith(expect.anything(), 'provian', 1, 77, { head_sha: 'a'.repeat(40), base_ref: 'master', base_sha: 'f'.repeat(40) });
    expect(mergeApprovedPr).toHaveBeenCalledTimes(1);
  });
  it('RED: an approved merge refused transiently retains its receipt for push retry', async () => {
    jest.mocked(mergeApprovedPr).mockResolvedValueOnce(false);
    const p = { ...payload(), action: 'submitted', sender: { id: 229043875 }, review: { id: 77, state: 'approved' } };
    const result = await handleGitHubWebhook(deps(), { ...input(p), eventType: 'pull_request_review' });
    expect(result.status).toBe(503);
    expect(result.body.error).toBe('pr_gate_merge_pending');
    expect((await handleGitHubWebhook(deps(), { ...input(p), eventType: 'pull_request_review' })).body.merged).toBe(true);
  });
  it('RED: another reviewer or a merge comment never authorizes merge', async () => {
    await handleGitHubWebhook(deps(), { ...input({ ...payload(), action: 'submitted', sender: { id: 10 }, review: { id: 77 } }), eventType: 'pull_request_review' });
    await handleGitHubWebhook(deps(), { ...input({ ...payload(), action: 'created', sender: { id: 229043875 }, comment: { body: '/provian merge ' + 'a'.repeat(40) } }), eventType: 'issue_comment' });
    expect(approvePrMerge).not.toHaveBeenCalled(); expect(mergeApprovedPr).not.toHaveBeenCalled();
  });
  it('RED: clearing or synchronizing a PR never calls the merger', async () => {
    await handleGitHubWebhook(deps(), input(payload()));
    expect(mergeApprovedPr).not.toHaveBeenCalled();
  });
  it('merged-commit earning remains on the existing closed-event path', async () => {
    await handleGitHubWebhook(deps(), input({ ...payload(), action: 'closed' }));
    expect(syncPrGate).not.toHaveBeenCalled();
  });
});
