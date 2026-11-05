import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import { runInstitutionWatcherScheduler, INSTITUTION_WATCHER_STATUS_COLLECTION } from './institution-watcher-status';

it.each(['funding', 'completion'] as const)('persists %s holds and returns non-success; a successful retry replaces the hold', async (kind) => {
  const db = createFakeFirestore() as unknown as Firestore;
  const ref = db.collection(INSTITUTION_WATCHER_STATUS_COLLECTION).doc(kind);
  const held = await runInstitutionWatcherScheduler(db, kind, async () => true,
    async () => ({ status: 'held' as const, hold_reason: 'provider_disagreement' as const }), () => 100);
  expect(held.httpStatus).toBe(503);
  expect((await ref.get()).data()).toMatchObject({ status: 'held', hold_reason: 'provider_disagreement', updated_at_ms: 100 });
  const completed = await runInstitutionWatcherScheduler(db, kind, async () => true,
    async () => ({ status: 'completed' as const, hold_reason: null, cursorFrom: 11, cursorTo: 20 }), () => 200);
  expect(completed.httpStatus).toBe(200);
  expect((await ref.get()).data()).toMatchObject({ status: 'completed', hold_reason: null, cursorFrom: 11 });
});
it('an operational pause never invokes a scan and never returns a completed scan', async () => {
  const db = createFakeFirestore() as unknown as Firestore;
  const run = jest.fn();
  const outcome = await runInstitutionWatcherScheduler(db, 'funding', async () => false, run);
  expect(outcome).toMatchObject({ httpStatus: 503, report: { status: 'held', hold_reason: 'activity_mapping_disabled' } });
  expect(run).not.toHaveBeenCalled();
});
it('persists unexpected scan failures before propagating them to the HTTP error handler', async () => {
  const db = createFakeFirestore() as unknown as Firestore;
  await expect(runInstitutionWatcherScheduler(db, 'completion', async () => true, async () => { throw new Error('rpc down'); }, () => 300)).rejects.toThrow('rpc down');
  expect((await db.collection(INSTITUTION_WATCHER_STATUS_COLLECTION).doc('completion').get()).data())
    .toMatchObject({ status: 'held', hold_reason: 'cycle_failed', updated_at_ms: 300 });
});
