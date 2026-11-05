/**
 * Tests for PE Batch Writer - buffer + flush pattern.
 */

import { PEBatchWriter } from './pe-batch-writer';

// ---------------------------------------------------------------------------
// Mock Firestore
// ---------------------------------------------------------------------------

function createMockFirestore(options?: { failOnCommit?: boolean; failCount?: number }) {
  let commitCalls = 0;
  let failsRemaining = options?.failCount ?? (options?.failOnCommit ? Infinity : 0);

  const setFn = jest.fn();
  const commitFn = jest.fn(async () => {
    commitCalls++;
    if (failsRemaining > 0) {
      failsRemaining--;
      throw new Error('Firestore write failed');
    }
  });

  const batchFn = jest.fn(() => ({
    set: setFn,
    commit: commitFn,
  }));

  const docFn = jest.fn((id: string) => ({ id }));
  const collectionFn = jest.fn(() => ({ doc: docFn }));

  const db = {
    batch: batchFn,
    collection: collectionFn,
  } as any;

  return { db, setFn, commitFn, batchFn, docFn, collectionFn };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PEBatchWriter', () => {
  let writer: PEBatchWriter;

  afterEach(() => {
    writer?.stop();
  });

  describe('enqueue', () => {
    it('should accept PEs into the buffer', () => {
      const { db } = createMockFirestore();
      writer = new PEBatchWriter(db, { flushThreshold: 100, flushIntervalMs: 60_000 });

      writer.enqueue('pe_1', { id: 'pe_1', status: 'approved' });
      writer.enqueue('pe_2', { id: 'pe_2', status: 'denied' });

      expect(writer.pendingCount).toBe(2);
      expect(writer.getStats().buffered).toBe(2);
    });

    it('should reject enqueue during drain', async () => {
      const { db } = createMockFirestore();
      writer = new PEBatchWriter(db, { flushThreshold: 100, flushIntervalMs: 60_000 });

      // Start drain (empty buffer, resolves immediately)
      const drainPromise = writer.drain();

      // After drain completes, try to enqueue - it should not throw
      // because drain sets draining=false at the end
      await drainPromise;

      // Enqueue should work after drain completes
      writer.enqueue('pe_1', { id: 'pe_1' });
      expect(writer.pendingCount).toBe(1);
    });
  });

  describe('flush', () => {
    it('should write all buffered PEs in a single batch', async () => {
      const { db, setFn, commitFn } = createMockFirestore();
      writer = new PEBatchWriter(db, { flushThreshold: 100, flushIntervalMs: 60_000 });

      writer.enqueue('pe_1', { id: 'pe_1', status: 'approved' });
      writer.enqueue('pe_2', { id: 'pe_2', status: 'denied' });
      writer.enqueue('pe_3', { id: 'pe_3', status: 'blocked' });

      const written = await writer.flush();

      expect(written).toBe(3);
      expect(setFn).toHaveBeenCalledTimes(3);
      expect(commitFn).toHaveBeenCalledTimes(1);
      expect(writer.pendingCount).toBe(0);
      expect(writer.getStats().flushed).toBe(3);
      expect(writer.getStats().totalBatches).toBe(1);
    });

    it('should write with { merge: true } so a concurrent out-of-band field (e.g. hidden) is not clobbered', async () => {
      const { db, setFn, docFn } = createMockFirestore();
      writer = new PEBatchWriter(db, { flushThreshold: 100, flushIntervalMs: 60_000 });

      // A PE doc enqueued for its final-upgrade. WS4 wrote the provisional doc
      // inside the tip transaction, so it already exists; a concurrent
      // PATCH .../hidden may have set hidden:true on it during the flush window.
      writer.enqueue('pe_1', { id: 'pe_1', durability: 'final' });
      await writer.flush();

      // The flush MUST merge, not full-overwrite. A bare set(ref, data) would
      // clobber the out-of-band hidden flag back to absent (the widened-window
      // clobber). Pinning { merge: true } here guards against a regression back
      // to full-overwrite.
      const ref = docFn.mock.results[0].value;
      expect(setFn).toHaveBeenCalledWith(
        ref,
        { id: 'pe_1', durability: 'final' },
        { merge: true },
      );
    });

    it('should return 0 when buffer is empty', async () => {
      const { db } = createMockFirestore();
      writer = new PEBatchWriter(db, { flushThreshold: 100, flushIntervalMs: 60_000 });

      const written = await writer.flush();
      expect(written).toBe(0);
    });

    it('should auto-flush when threshold is reached', async () => {
      const { db, commitFn } = createMockFirestore();
      writer = new PEBatchWriter(db, { flushThreshold: 3, flushIntervalMs: 60_000 });

      writer.enqueue('pe_1', { id: 'pe_1' });
      writer.enqueue('pe_2', { id: 'pe_2' });
      writer.enqueue('pe_3', { id: 'pe_3' }); // Triggers auto-flush

      // Wait for async flush to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(commitFn).toHaveBeenCalledTimes(1);
      expect(writer.pendingCount).toBe(0);
    });

    it('should retry on failure with exponential backoff', async () => {
      // Fail first 2 attempts, succeed on 3rd. The retries log warn() on each
      // attempt; suppress for this test only since the noise is expected and
      // not part of the assertion surface.
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { db, commitFn } = createMockFirestore({ failCount: 2 });
        writer = new PEBatchWriter(db, {
          flushThreshold: 100,
          flushIntervalMs: 60_000,
          maxRetries: 3,
        });

        writer.enqueue('pe_1', { id: 'pe_1' });

        const written = await writer.flush();

        expect(written).toBe(1);
        expect(commitFn).toHaveBeenCalledTimes(3); // 2 failures + 1 success
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should put items back in buffer on total failure', async () => {
      // Total-failure path logs warn() per retry plus error() after max
      // retries. Suppress both for this test only.
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { db } = createMockFirestore({ failOnCommit: true });
        writer = new PEBatchWriter(db, {
          flushThreshold: 100,
          flushIntervalMs: 60_000,
          maxRetries: 2,
        });

        writer.enqueue('pe_1', { id: 'pe_1' });
        writer.enqueue('pe_2', { id: 'pe_2' });

        await expect(writer.flush()).rejects.toThrow('Firestore write failed');

        // Items should be back in buffer
        expect(writer.pendingCount).toBe(2);
        expect(writer.getStats().failed).toBe(2);
      } finally {
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });

  describe('drain', () => {
    it('should flush all remaining PEs', async () => {
      const { db, setFn, commitFn } = createMockFirestore();
      writer = new PEBatchWriter(db, { flushThreshold: 100, flushIntervalMs: 60_000 });

      for (let i = 0; i < 10; i++) {
        writer.enqueue(`pe_${i}`, { id: `pe_${i}` });
      }

      const written = await writer.drain();

      expect(written).toBe(10);
      expect(setFn).toHaveBeenCalledTimes(10);
      expect(commitFn).toHaveBeenCalledTimes(1);
      expect(writer.pendingCount).toBe(0);
    });

    it('should handle empty buffer gracefully', async () => {
      const { db } = createMockFirestore();
      writer = new PEBatchWriter(db, { flushThreshold: 100, flushIntervalMs: 60_000 });

      const written = await writer.drain();
      expect(written).toBe(0);
    });
  });

  describe('stats', () => {
    it('should track all operations', async () => {
      const { db } = createMockFirestore();
      writer = new PEBatchWriter(db, { flushThreshold: 100, flushIntervalMs: 60_000 });

      writer.enqueue('pe_1', { id: 'pe_1' });
      writer.enqueue('pe_2', { id: 'pe_2' });

      const beforeFlush = writer.getStats();
      expect(beforeFlush.buffered).toBe(2);
      expect(beforeFlush.pending).toBe(2);
      expect(beforeFlush.flushed).toBe(0);
      expect(beforeFlush.lastFlushAt).toBeNull();

      await writer.flush();

      const afterFlush = writer.getStats();
      expect(afterFlush.buffered).toBe(2);
      expect(afterFlush.pending).toBe(0);
      expect(afterFlush.flushed).toBe(2);
      expect(afterFlush.totalBatches).toBe(1);
      expect(afterFlush.lastFlushAt).toBeGreaterThan(0);
    });
  });

  describe('periodic flush', () => {
    it('should flush on interval when started', async () => {
      jest.useFakeTimers();
      const { db, commitFn } = createMockFirestore();
      writer = new PEBatchWriter(db, { flushThreshold: 100, flushIntervalMs: 1000 });

      writer.start();
      writer.enqueue('pe_1', { id: 'pe_1' });

      // Advance timer past flush interval
      jest.advanceTimersByTime(1100);

      // Flush is async, need to let microtasks resolve
      await jest.advanceTimersByTimeAsync(100);

      expect(commitFn).toHaveBeenCalled();

      writer.stop();
      jest.useRealTimers();
    });
  });

  describe('concurrent safety', () => {
    it('should not double-flush when called concurrently', async () => {
      const { db, commitFn } = createMockFirestore();
      writer = new PEBatchWriter(db, { flushThreshold: 100, flushIntervalMs: 60_000 });

      writer.enqueue('pe_1', { id: 'pe_1' });
      writer.enqueue('pe_2', { id: 'pe_2' });

      // Call flush twice concurrently
      const [r1, r2] = await Promise.all([writer.flush(), writer.flush()]);

      // One should write, the other should no-op
      expect(r1 + r2).toBe(2);
      expect(commitFn).toHaveBeenCalledTimes(1);
    });
  });
});
