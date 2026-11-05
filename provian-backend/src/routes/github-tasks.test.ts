import express from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { createFakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import * as inbox from '../core/witnesses/github-webhook-inbox';
import { PR_GATES_COLLECTION, prGateId, PR_GATE_SEEN_COLLECTION, type PrGateDeps } from '../core/witnesses/github-pr-gate';
import { PR_GATE_REPOSITORIES } from '../core/witnesses/github-pr-api';
import { createGitHubTaskRouter } from './github-tasks';
const ID = 'a'.repeat(64), BURN = 'b'.repeat(64);
afterEach(() => jest.restoreAllMocks());
function setup(authorized = true) {
  const fake = createFakeFirestore(); const db = fake as unknown as Firestore;
  const deps = { db } as AgentBankDeps;
  const authenticate = jest.fn(async () => authorized);
  const comments: string[] = [];
  const receipt = { burn_id: BURN, presenter_id: 'author-wallet', amount_atomic: '50000000000000000000', at: Date.now(), token_sha256: 'c'.repeat(64) };
  const key = `${PR_GATES_COLLECTION}/${prGateId('provian', 6)}`;
  fake.store.set(key, { repository: 'provian', number: 6, author_id: '77', author_login: 'contributor', head_sha: ID.slice(0, 40).slice(0, 40), state: 'open', pending: receipt });
  fake.store.set(`pvt_burn_records/${BURN}`, { status: 'recorded', verified: true, wallet_id: 'author-wallet', amount_atomic: receipt.amount_atomic, finality: 'provisional' });
  fake.store.set(`${PR_GATE_SEEN_COLLECTION}/${BURN}`, { pr: prGateId('provian', 6), token_sha256: receipt.token_sha256 });
  fake.store.set('github_wallet_links_v1/77_author-wallet', { github_id: '77', wallet_id: 'author-wallet', verified_by: 'github_user_oauth', verified_at: Date.now(), revoked_at: null });
  fake.store.set('agent_wallets/author-wallet', { address: '0x' + '1'.repeat(40), status: 'active' });
  const gate: PrGateDeps = { db, api: { call: jest.fn(async (_repo, method, path, body) => {
    if (path === '/pulls/6') return { number: 6, user: { id: 77, login: 'contributor' }, head: { sha: ID.slice(0, 40) }, base: { ref: 'master', sha: ID.slice(0, 40), repo: { id: PR_GATE_REPOSITORIES.provian.id } }, state: 'open' };
    if (path.includes('/check-runs?')) return { check_runs: [] };
    if (path.includes('/comments?')) return [];
    if (method === 'POST' && path.endsWith('/comments')) comments.push((body as { body: string }).body);
    return { id: 1 };
  }) } };
  const app = (finalize = jest.fn(async () => {})) => {
    const a = express(); a.use(express.json()); a.use('/task', createGitHubTaskRouter(deps, authenticate, { gate, finalize })); return a;
  };
  return { fake, deps, authenticate, app, key, comments, gate };
}
it('RED: task headers alone never authorize a worker or touch receipt state', async () => {
  const s = setup(false); const process = jest.spyOn(inbox, 'processGitHubReceipt');
  const response = await request(s.app()).post('/task').set('X-CloudTasks-QueueName', 'provian-github-webhooks').send({ kind: 'receipt', id: ID });
  expect(response.status).toBe(403); expect(process).not.toHaveBeenCalled(); expect(s.gate.api.call).not.toHaveBeenCalled();
});
it('RED: unfinished and leased receipts keep transport retries; only done is acknowledged', async () => {
  const s = setup(); s.fake.store.set(`${inbox.GITHUB_INBOX}/${ID}`, { status: 'processing' });
  const process = jest.spyOn(inbox, 'processGitHubReceipt').mockResolvedValue(false);
  expect((await request(s.app()).post('/task').send({ kind: 'receipt', id: ID })).status).toBe(503);
  s.fake.store.set(`${inbox.GITHUB_INBOX}/${ID}`, { status: 'done' });
  expect((await request(s.app()).post('/task').send({ kind: 'receipt', id: ID })).status).toBe(200);
  expect(process).toHaveBeenCalledTimes(2);
});
it('clears and comments immediately after finality inside the active push request, without merging', async () => {
  const s = setup(); const finalize = jest.fn(async () => { s.fake.store.get(`pvt_burn_records/${BURN}`)!.finality = 'final'; });
  expect((await request(s.app(finalize)).post('/task').send({ kind: 'pr_gate', repo: 'provian', number: 6, burnId: BURN })).status).toBe(200);
  expect(finalize).toHaveBeenCalledTimes(1);
  expect(s.fake.store.get(s.key)?.cleared).toMatchObject({ burn_id: BURN });
  expect(s.comments).toHaveLength(1); expect(s.comments[0]).toContain('Presentation accepted');
  expect(jest.mocked(s.gate.api.call).mock.calls.some(c => c[1] === 'PUT')).toBe(false);
});
it('RED: provisional finality is never acknowledged as cleared; worker retries and preserves payment', async () => {
  const s = setup();
  expect((await request(s.app()).post('/task').send({ kind: 'pr_gate', repo: 'provian', number: 6, burnId: BURN })).status).toBe(503);
  expect(s.fake.store.get(s.key)?.cleared).toBeUndefined(); expect(s.fake.store.get(s.key)?.pending).toBeDefined();
});
it('RED: a different burn reference cannot finalize or synchronize the PR', async () => {
  const s = setup(); const finalize = jest.fn(async () => {});
  expect((await request(s.app(finalize)).post('/task').send({ kind: 'pr_gate', repo: 'provian', number: 6, burnId: 'd'.repeat(64) })).status).toBe(200);
  expect(finalize).not.toHaveBeenCalled(); expect(s.comments).toHaveLength(0);
});
