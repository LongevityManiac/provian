import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { listMessages, markRead, type ThreadDocument } from './threads';
import { COMMONS_COLLECTIONS as C } from './types';
import type { AgentBankDeps } from '../agent-bank/types';

test('real message store: older pages are reachable and bounded read preserves an intervening arrival', async () => {
  const db = createFakeFirestore();
  const deps = { db } as unknown as AgentBankDeps;
  const thread = { thread_id: 'thr_history', party_a: 'human', party_b: 'agent', read_cursors: { human: 0 }, last_message_at: 1500, anchor_kind: 'profile', anchor_id: 'agent', parties: {}, opened_by: 'human', backing: { kind: 'relationship' }, created_at: 0, message_count: 150 } satisfies ThreadDocument;
  db.store.set(`${C.THREADS}/${thread.thread_id}`, thread);
  for (let i = 1; i <= 150; i++) db.store.set(`${C.THREAD_MESSAGES}/m${i}`, { thread_id: thread.thread_id, message_id: `m${i}`, author_id: 'agent', created_at: i * 10 });
  const page = await listMessages(deps, thread, { limit: 100 });
  expect(page).toHaveLength(100); expect(page[0].message_id).toBe('m51');
  const older = await listMessages(deps, thread, { limit: 100, before: page[0].created_at });
  expect(older).toHaveLength(50); expect(older[0].message_id).toBe('m1');
  await db.collection(C.THREADS).doc(thread.thread_id).update({ last_message_at: 1600 });
  await markRead(deps, thread, 'human', 1700, page.at(-1)!.created_at);
  expect((db.store.get(`${C.THREADS}/${thread.thread_id}`)?.read_cursors as Record<string, number>)?.human).toBe(1500);
  // Failing control: the old unbounded call clears the unseen message.
  await markRead(deps, thread, 'human', 1700);
  expect((db.store.get(`${C.THREADS}/${thread.thread_id}`)?.read_cursors as Record<string, number>)?.human).toBe(1700);
});

test('message-id cursor reaches every message sharing a page-boundary timestamp', async () => {
  const db = createFakeFirestore();
  const deps = { db } as unknown as AgentBankDeps;
  const thread = { thread_id: 'thr_ties' } as ThreadDocument;
  for (let i = 1; i <= 150; i++) {
    const id = `msg_${String(i).padStart(3, '0')}`;
    db.store.set(`${C.THREAD_MESSAGES}/${id}`, { thread_id: thread.thread_id, message_id: id, created_at: 500 });
  }
  const first = await listMessages(deps, thread, { limit: 100 });
  expect(first).toHaveLength(100);
  // Old cursor loses the remaining 50; the tie-safe cursor reaches them.
  expect(await listMessages(deps, thread, { before: 500, limit: 100 })).toHaveLength(0);
  const older = await listMessages(deps, thread, { before: 500, beforeId: first[0].message_id, limit: 100 });
  expect(older).toHaveLength(50);
  expect(new Set([...older, ...first].map(m => m.message_id)).size).toBe(150);
});
