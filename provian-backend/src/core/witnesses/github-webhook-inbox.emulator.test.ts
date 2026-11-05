jest.mock('./github-task-queue', () => ({ enqueueGitHubTask: jest.fn(async () => {}) }));
import { Firestore } from 'firebase-admin/firestore';
import { createHmac, createHash, randomUUID, randomBytes } from 'crypto';
import { privateFirestore, privateStorageId } from '../provenance/private-store';
import { acceptGitHubWebhook, processGitHubReceipt, GITHUB_INBOX } from './github-webhook-inbox';
import { __resetOpsCountersForTest } from '../observability/ops-counters';
const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('durable encrypted GitHub inbox', () => {
  let raw: Firestore, db: Firestore;
  const prior = process.env.RELAY_SIGNING_KEY;
  beforeAll(async () => {
    process.env.RELAY_SIGNING_KEY = 'public-github-inbox-emulator-key';
    raw = new Firestore({ projectId: 'demo-github-inbox', databaseId: 'inbox-' + randomUUID().slice(0, 8) });
    await raw.collection('private_retention_state_v1').doc('d554').set({ opaque_ids_ready: true, opaque_records_complete: true, range_lookup_version: 1 });
    db = privateFirestore(raw);
  });
  afterAll(async () => { await raw.terminate(); __resetOpsCountersForTest(); if (prior === undefined) delete process.env.RELAY_SIGNING_KEY; else process.env.RELAY_SIGNING_KEY = prior; });
  it('stores a maximum-size receipt privately, deduplicates concurrent retries and survives secret rotation', async () => {
    const config = { enabled: true, webhookSecret: 'original-secret', appSlug: null };
    const rawBody = JSON.stringify({ zen: randomBytes(110_000).toString('hex') });
    const deliveryId = randomUUID();
    const input = { config, rawBody, eventType: 'ping', deliveryId,
      signatureHeader: `sha256=${createHmac('sha256', config.webhookSecret).update(rawBody).digest('hex')}` };
    const results = await Promise.all([acceptGitHubWebhook({ db }, input), acceptGitHubWebhook({ db }, input)]);
    // Contention can deliberately return a retryable 503 before the acknowledgement deadline.
    expect(results.every(r => [200, 503].includes(r.status))).toBe(true);
    const retry = await acceptGitHubWebhook({ db }, input);
    expect(retry.status).toBe(200); expect(retry.body.idempotent).toBe(true);
    const id = createHash('sha256').update(deliveryId).digest('hex');
    const physical = await raw.collection(GITHUB_INBOX).doc(privateStorageId(GITHUB_INBOX, id)).get();
    expect(physical.get('_provian_store')).toBe(1);
    expect(physical.get('raw_body')).toBeUndefined(); expect(physical.get('expire_at')).toBeUndefined();
    expect((await db.collection(GITHUB_INBOX).where('available_at', '<=', Date.now()).orderBy('available_at').limit(20).get()).docs).toHaveLength(1);
    expect(await processGitHubReceipt({ db } as any, id, { ...config, webhookSecret: 'rotated-secret' })).toBe(true);
    const completed = (await db.collection(GITHUB_INBOX).doc(id).get()).data();
    expect(completed?.status).toBe('done'); expect(completed?.raw_body).toBeUndefined();
    expect((await acceptGitHubWebhook({ db }, input)).body.idempotent).toBe(true);
    expect((await db.collection(GITHUB_INBOX).where('available_at', '<=', Date.now()).orderBy('available_at').limit(20).get()).empty).toBe(true);
    expect((await raw.collection('meter_act_keys_v1').get()).empty).toBe(true);
  }, 20_000);
});
