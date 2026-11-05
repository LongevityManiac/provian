jest.mock('./github-task-queue', () => ({ enqueueGitHubTask: jest.fn(async () => {}) }));
import crypto from 'crypto';
import { acceptGitHubWebhook, processGitHubReceipt, drainGitHubWebhookInbox, redispatchGitHubWebhookInbox, GITHUB_INBOX } from './github-webhook-inbox';
import * as handler from './github-webhook';
import { makeWitnessFakeDeps } from './__test-helpers__/witness-fake-deps';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { createServiceInstall } from './service-installs';
import { __resetOpsCountersForTest } from '../observability/ops-counters';
import { enqueueGitHubTask } from './github-task-queue';

const config = { enabled: true, webhookSecret: 's'.repeat(64), appSlug: null };
function input(payload: unknown, eventType = 'push', deliveryId = 'receipt-1') {
  const rawBody = JSON.stringify(payload);
  return { rawBody, signatureHeader: `sha256=${crypto.createHmac('sha256', config.webhookSecret).update(rawBody).digest('hex')}`, eventType, deliveryId, config };
}
const id = (delivery = 'receipt-1') => crypto.createHash('sha256').update(delivery).digest('hex');
const payload = {
  ref: 'refs/heads/main', before: 'b'.repeat(40), after: 'a'.repeat(40), installation: { id: 42 },
  repository: { full_name: 'octocat/repo', owner: { login: 'octocat', id: 21031067, type: 'User' } },
  head_commit: { id: 'a'.repeat(40), message: 'fix', author: { username: 'octocat', email: 'octocat@users.noreply.github.com' } },
  commits: [{ id: 'a'.repeat(40), added: ['x.ts'], removed: [], modified: [], author: { username: 'octocat' } }],
};
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); __resetOpsCountersForTest(); });

it('RED: dispatch failure cannot acknowledge success; retry reuses the persisted receipt', async () => {
  const fake = createFakeFirestore(); const deps = { db: fake } as any;
  const enqueue = jest.fn(async () => { throw new Error('queue offline'); });
  expect((await acceptGitHubWebhook(deps, input(payload), enqueue)).status).toBe(503);
  expect((await fake.collection(GITHUB_INBOX).doc(id()).get()).data()?.status).toBe('pending');
  const retry = jest.fn(async () => {
    expect((await fake.collection(GITHUB_INBOX).doc(id()).get()).exists).toBe(true);
  });
  expect((await acceptGitHubWebhook(deps, input(payload), retry)).body.idempotent).toBe(true);
  expect(retry).toHaveBeenCalledWith({ kind: 'receipt', id: id() });
  await fake.collection(GITHUB_INBOX).doc(id()).update({ status: 'done' });
  retry.mockClear();
  expect((await acceptGitHubWebhook(deps, input(payload), retry)).status).toBe(200);
  expect(retry).not.toHaveBeenCalled();
});

it('acknowledges only authenticated durable storage, without running earning work', async () => {
  const fake = createFakeFirestore(); const deps = { db: fake } as any;
  const process = jest.spyOn(handler, 'handleGitHubWebhook');
  expect((await acceptGitHubWebhook(deps, { ...input(payload), signatureHeader: 'bad' })).status).toBe(401);
  expect((await fake.collection(GITHUB_INBOX).get()).docs).toHaveLength(0);
  expect(enqueueGitHubTask).not.toHaveBeenCalled();
  expect((await acceptGitHubWebhook(deps, input(payload))).body.durable).toBe(true);
  expect(enqueueGitHubTask).toHaveBeenCalledWith({ kind: 'receipt', id: id() });
  expect(process).not.toHaveBeenCalled();
  expect((await fake.collection(GITHUB_INBOX).doc(id()).get()).data()?.status).toBe('pending');
  expect((await acceptGitHubWebhook(deps, input(payload))).body.idempotent).toBe(true);
  expect((await acceptGitHubWebhook(deps, input({ ...payload, after: 'c'.repeat(40) }))).status).toBe(400);
  const broken = { db: { runTransaction: jest.fn().mockRejectedValue(new Error('offline')), collection: fake.collection.bind(fake) } } as any;
  expect((await acceptGitHubWebhook(broken, input(payload))).status).toBe(503);
});

it('returns a retryable failure before the vendor deadline when storage stalls', async () => {
  jest.useFakeTimers();
  try {
    const fake = createFakeFirestore();
    const deps = { db: { collection: fake.collection.bind(fake), runTransaction: () => new Promise(() => {}) } } as any;
    const pending = acceptGitHubWebhook(deps, input(payload));
    await jest.advanceTimersByTimeAsync(5001);
    expect((await pending).status).toBe(503);
  } finally { jest.useRealTimers(); }
});

it('RED: a stalled queue cannot acknowledge a stored receipt before the vendor deadline', async () => {
  jest.useFakeTimers();
  try {
    const fake = createFakeFirestore();
    const pending = acceptGitHubWebhook({ db: fake } as any, input(payload), () => new Promise(() => {}));
    await jest.advanceTimersByTimeAsync(5001);
    expect((await pending).status).toBe(503);
    expect((await fake.collection(GITHUB_INBOX).doc(id()).get()).data()?.status).toBe('pending');
  } finally { jest.useRealTimers(); }
});

it('daily recovery pages due receipts only and leaves an empty inbox without dispatch', async () => {
  const fake = createFakeFirestore(); const deps = { db: fake } as any;
  const enqueue = jest.fn(async () => {});
  expect(await redispatchGitHubWebhookInbox(deps, enqueue)).toBe(0);
  expect(enqueue).not.toHaveBeenCalled();
  for (let n = 0; n < 101; n++) await fake.collection(GITHUB_INBOX).doc(id(String(n))).set({ status: 'pending', available_at: 1, received_at: Date.now() });
  await fake.collection(GITHUB_INBOX).doc(id('future')).set({ status: 'processing', available_at: Date.now() + 60_000, received_at: Date.now() });
  await fake.collection(GITHUB_INBOX).doc(id('done')).set({ status: 'done', available_at: Number.MAX_SAFE_INTEGER, received_at: Date.now() });
  expect(await redispatchGitHubWebhookInbox(deps, enqueue)).toBe(101);
  expect(enqueue).toHaveBeenCalledTimes(101);
  expect(enqueue).not.toHaveBeenCalledWith({ kind: 'receipt', id: id('future') });
  expect(enqueue).not.toHaveBeenCalledWith({ kind: 'receipt', id: id('done') });
});

it('retains failed work and recovers an expired lease under the scheduled worker', async () => {
  const fake = createFakeFirestore(); const deps = { db: fake } as any;
  await acceptGitHubWebhook(deps, input({ zen: 'ok' }, 'ping'));
  const process = jest.spyOn(handler, 'handleGitHubWebhook').mockRejectedValueOnce(new Error('temporary'))
    .mockResolvedValue({ status: 200, body: { ping: true } });
  expect(await processGitHubReceipt(deps, id(), config)).toBe(false);
  let row = (await fake.collection(GITHUB_INBOX).doc(id()).get()).data()!;
  expect(row.status).toBe('pending'); expect(row.expire_at).toBeUndefined();
  await fake.collection(GITHUB_INBOX).doc(id()).update({ status: 'processing', available_at: Date.now() - 1 });
  process.mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 5)); return { status: 200, body: {} }; });
  const attempts = await Promise.all([processGitHubReceipt(deps, id(), config), processGitHubReceipt(deps, id(), config)]);
  expect(attempts.filter(Boolean)).toHaveLength(1);
  row = (await fake.collection(GITHUB_INBOX).doc(id()).get()).data()!;
  expect(row.status).toBe('done'); expect((row.expire_at as { toMillis(): number }).toMillis()).toBeGreaterThan(Date.now());
});

it('preserves the one eligible earning act and chain tip after a seal-before-completion crash', async () => {
  const { deps, store, enqueued } = makeWitnessFakeDeps();
  const d = deps as any;
  await createServiceInstall(d.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });
  await d.db.collection('wallets').doc('user_1').set({ user_id: 'user_1', wallet_address: '0x' + '1'.repeat(40) });
  await acceptGitHubWebhook(d, input(payload));
  const mark = jest.spyOn(handler, 'checkAndMarkDelivery').mockRejectedValueOnce(new Error('crash after seal'));
  expect(await processGitHubReceipt(d, id(), config)).toBe(false);
  expect(enqueued).toHaveLength(1);
  const before = JSON.stringify([...store.get('meter_act_keys_v1')!.entries()]);
  const tip = JSON.stringify([...store.get('pe_chain_tips')!.entries()]);
  const receipt = store.get(GITHUB_INBOX)!.get(id())!;
  receipt.available_at = 0;
  mark.mockRestore();
  expect(await processGitHubReceipt(d, id(), config)).toBe(true);
  expect(enqueued).toHaveLength(1);
  expect(JSON.stringify([...store.get('meter_act_keys_v1')!.entries()])).toBe(before);
  expect(JSON.stringify([...store.get('pe_chain_tips')!.entries()])).toBe(tip);
  expect(enqueued[0].pe.metadata).toMatchObject({ verified: true, delivery_id: 'receipt-1' });
  expect((receipt.prepared_pe as { witnessClass: string }).witnessClass).toBe('forge_witnessed');
  expect(store.get('meter_act_keys_v1')?.size).toBe(1);
});

it('classifies lifecycle no-ops without hiding malformed earning evidence', () => {
  expect(handler.isExpectedNonEarningGitHubEvent('pull_request', { action: 'opened' })).toBe(true);
  expect(handler.isExpectedNonEarningGitHubEvent('push', { created: true, commits: [] })).toBe(true);
  expect(handler.isExpectedNonEarningGitHubEvent('push', { commits: [] })).toBe(false);
  expect(handler.isExpectedNonEarningGitHubEvent('pull_request', { action: 'closed', pull_request: { merged: true } })).toBe(false);
});

it('drains due work and publishes durable backlog health', async () => {
  const fake = createFakeFirestore(); const deps = { db: fake } as any;
  await acceptGitHubWebhook(deps, input({ zen: 'ok' }, 'ping'));
  jest.spyOn(handler, 'handleGitHubWebhook').mockResolvedValue({ status: 200, body: {} });
  // A real configured worker is required; this test keeps a disabled receipt pending and observable.
  const result = await drainGitHubWebhookInbox(deps);
  expect(result.pending_sample).toBe(1);
  expect((await fake.collection('system_status').doc('github_webhook_inbox').get()).exists).toBe(true);
});
