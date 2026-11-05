import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import { cleanRuntimePages, partitionRuntimeRows, publishRuntimePages, RUNTIME_READ_MODEL_PAGES_COLLECTION } from './runtime-read-model-pages';

it('retains every row beyond the former one-document limit, including UTF-8 bytes', async () => {
  const rows = Array.from({ length: 5_267 }, (_, index) => ({ index, text: '🧪'.repeat(90) }));
  expect(Buffer.byteLength(JSON.stringify(rows))).toBeGreaterThan(1_048_576);
  const pages = partitionRuntimeRows(rows);
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.every((page) => Buffer.byteLength(page) <= 500_000)).toBe(true);
  expect(pages.flatMap((page) => JSON.parse(page))).toEqual(rows);
});
it('RED: failed immutable page publication cannot return a publishable root pointer', async () => {
  const fake = createFakeFirestore();
  const db = fake as unknown as Firestore;
  await db.collection('pvt_runtime_read_model_v1').doc('current').set({ pages: { generation: 'old' } });
  const original = fake.collection;
  fake.collection = (name) => name === RUNTIME_READ_MODEL_PAGES_COLLECTION
    ? { ...original(name), doc: () => ({ create: async () => { throw new Error('write failed'); } }) } as any
    : original(name);
  await expect(publishRuntimePages(db, 123, { types: [{ id: 'new' }] })).rejects.toThrow('write failed');
  expect((await db.collection('pvt_runtime_read_model_v1').doc('current').get()).data()?.pages.generation).toBe('old');
});
it('RED: cleanup preserves the current generation even when publication stopped for days', async () => {
  const db = createFakeFirestore() as unknown as Firestore;
  const current = await publishRuntimePages(db, 1, { types: [1] });
  const old = await publishRuntimePages(db, 1, { types: [2] });
  await db.collection('pvt_runtime_read_model_v1').doc('current').set({ pages: current });
  await cleanRuntimePages(db, 172_800_000);
  expect((await db.collection(RUNTIME_READ_MODEL_PAGES_COLLECTION).doc(`${current.generation}:types:0`).get()).exists).toBe(true);
  expect((await db.collection(RUNTIME_READ_MODEL_PAGES_COLLECTION).doc(`${old.generation}:types:0`).get()).exists).toBe(false);
});
