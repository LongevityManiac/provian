/**
 * advanceEmptyWatcherCheckpoint — the empty-watched-set cursor advance.
 *
 * This is the fix for the / silent-freeze class as it surfaced on the
 * outbound-USDC watcher's money path (Task 1): when the watched set is empty
 * (the normal pre-launch state — every agent is platform:'test' and excluded)
 * the scan used to return before committing, so the durable cursor froze at
 * 49,679,822 from 2026-08-08 while every 30-minute tick still reported healthy.
 *
 * The negative controls are inline and MANDATORY: each one is the exact
 * scenario that must FAIL if the guard is wrong.
 */
import { describe, it, expect } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import {
  advanceEmptyWatcherCheckpoint,
  readWatcherCheckpointSnapshot,
} from './watcher-address-admission';

const COLL = 'activity_outbound_checkpoints';
const CHAIN = 8453;

function seedCheckpoint(
  db: ReturnType<typeof createFakeFirestore>,
  lastProcessedBlock: number | null,
  generation: number,
  updatedAt: number,
): void {
  db.store.set(`${COLL}/${CHAIN}`, {
    chain_id: CHAIN,
    last_processed_block: lastProcessedBlock,
    membership_generation: generation,
    updated_at: updatedAt,
  });
}

describe('advanceEmptyWatcherCheckpoint', () => {
  it('GREEN: advances a frozen cursor to head, preserving membership generation', async () => {
    const db = createFakeFirestore();
    seedCheckpoint(db, 100, 7, 1_000);
    const before = await readWatcherCheckpointSnapshot(db as unknown as Firestore, COLL, CHAIN);
    expect(before.lastProcessedBlock).toBe(100); // the frozen value

    const advanced = await advanceEmptyWatcherCheckpoint(
      db as unknown as Firestore,
      COLL,
      CHAIN,
      before,
      989,
      2_000,
    );

    expect(advanced).toBe(989);
    const after = db.store.get(`${COLL}/${CHAIN}`)!;
    // The exact freeze this fixes: the cursor MUST have moved off 100. If the
    // fix regressed to an early-return, `advanced` would be null and this stays
    // 100 — the negative control for the silent freeze.
    expect(after.last_processed_block).toBe(989);
    // Generation is preserved: an impl that bumped it would break every
    // in-flight per-address admission's membership CAS.
    expect(after.membership_generation).toBe(7);
  });

  it('GREEN: creates the cursor at head when no checkpoint exists yet', async () => {
    const db = createFakeFirestore();
    const before = await readWatcherCheckpointSnapshot(db as unknown as Firestore, COLL, CHAIN);
    expect(before.lastProcessedBlock).toBeNull();

    const advanced = await advanceEmptyWatcherCheckpoint(
      db as unknown as Firestore,
      COLL,
      CHAIN,
      before,
      500,
      2_000,
    );

    expect(advanced).toBe(500);
    expect(db.store.get(`${COLL}/${CHAIN}`)).toMatchObject({ last_processed_block: 500 });
  });

  it('RED: never rewinds — a head at or below the current cursor is a no-op, not a regression', async () => {
    const db = createFakeFirestore();
    seedCheckpoint(db, 989, 7, 5_000);
    const snapshot = await readWatcherCheckpointSnapshot(db as unknown as Firestore, COLL, CHAIN);

    // head == cursor → nothing ahead → no write.
    expect(await advanceEmptyWatcherCheckpoint(
      db as unknown as Firestore, COLL, CHAIN, snapshot, 989, 6_000,
    )).toBeNull();
    // head < cursor (e.g. a transiently lagging RPC head) → MUST NOT rewind.
    expect(await advanceEmptyWatcherCheckpoint(
      db as unknown as Firestore, COLL, CHAIN, snapshot, 950, 6_000,
    )).toBeNull();

    // The stored cursor is untouched at 989 — the "cannot regress silently"
    // guarantee. A broken impl that wrote the lower value would fail here.
    expect(db.store.get(`${COLL}/${CHAIN}`)!.last_processed_block).toBe(989);
    expect(db.store.get(`${COLL}/${CHAIN}`)!.membership_generation).toBe(7);
  });

  it('RED: a stale membership generation is refused (cannot overtake a rotated set)', async () => {
    const db = createFakeFirestore();
    // The stored doc is generation 8; our snapshot claims 7 (stale).
    seedCheckpoint(db, 100, 8, 1_000);
    await expect(advanceEmptyWatcherCheckpoint(
      db as unknown as Firestore,
      COLL,
      CHAIN,
      { lastProcessedBlock: 100, membershipGeneration: 7 },
      989,
      2_000,
    )).rejects.toThrow('watcher_membership_generation_changed');
    // Cursor untouched by the refused write.
    expect(db.store.get(`${COLL}/${CHAIN}`)!.last_processed_block).toBe(100);
  });
});
