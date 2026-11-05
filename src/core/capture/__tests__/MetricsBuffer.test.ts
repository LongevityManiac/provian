import { describe, it, expect } from 'vitest';
import { MetricsBuffer, type BufferedMetric } from '../MetricsBuffer';

function makeMetric(over: Partial<BufferedMetric> = {}): BufferedMetric {
    return {
        provider: 'claude',
        surface: 'mobile_wrapper',
        receivedAtMs: 1_000_000,
        turnCount: 0,
        charCount: 0,
        imageCount: 0,
        videoSeconds: 0,
        ...over,
    };
}

describe('MetricsBuffer', () => {
    it('push and drain return entries in FIFO order', () => {
        const buf = new MetricsBuffer();
        buf.push(makeMetric({ receivedAtMs: 1 }));
        buf.push(makeMetric({ receivedAtMs: 2 }));
        buf.push(makeMetric({ receivedAtMs: 3 }));
        expect(buf.size()).toBe(3);
        const drained = buf.drain();
        expect(drained.map(m => m.receivedAtMs)).toEqual([1, 2, 3]);
        expect(buf.size()).toBe(0);
    });

    it('drain empties the buffer; subsequent drain returns []', () => {
        const buf = new MetricsBuffer();
        buf.push(makeMetric());
        buf.drain();
        expect(buf.drain()).toEqual([]);
    });

    it('enforces maxEntries by dropping oldest', () => {
        const buf = new MetricsBuffer({ maxEntries: 3 });
        buf.push(makeMetric({ receivedAtMs: 1 }));
        buf.push(makeMetric({ receivedAtMs: 2 }));
        buf.push(makeMetric({ receivedAtMs: 3 }));
        buf.push(makeMetric({ receivedAtMs: 4 }));
        expect(buf.size()).toBe(3);
        expect(buf.droppedCount()).toBe(1);
        expect(buf.drain().map(m => m.receivedAtMs)).toEqual([2, 3, 4]);
    });

    it('peekLast returns the most recent metric without removing it', () => {
        const buf = new MetricsBuffer();
        expect(buf.peekLast()).toBeNull();
        buf.push(makeMetric({ receivedAtMs: 1 }));
        buf.push(makeMetric({ receivedAtMs: 2 }));
        expect(buf.peekLast()?.receivedAtMs).toBe(2);
        expect(buf.size()).toBe(2);
    });

    it('clear empties the buffer without returning anything', () => {
        const buf = new MetricsBuffer();
        buf.push(makeMetric());
        buf.push(makeMetric());
        buf.clear();
        expect(buf.size()).toBe(0);
    });
});
