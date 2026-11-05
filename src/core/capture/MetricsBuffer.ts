/**
 * In-memory metrics buffer for WebView-posted ObserverMetrics payloads.
 *
 * The WebView's injected MutationObserver layer computes metrics on
 * every relevant DOM mutation, applies conservative rounding, and posts
 * the result via `window.ReactNativeWebView.postMessage`. The mobile
 * side's `onMessage` handler parses each payload and pushes it into this
 * buffer.
 *
 * M4 does not wire a consumer. M5's session state machine / PE emission
 * layer will drain this buffer to produce `ai_conversation` PEs.
 *
 * The buffer is a bounded FIFO. A hard cap prevents unbounded growth if
 * the consumer is slow or absent; when the cap is reached the oldest
 * entries are dropped so the newest metric is always available. The cap
 * is intentionally large enough to absorb several minutes of high-rate
 * mutations in testing.
 */

export interface BufferedMetric {
    provider: string;
    surface: 'mobile_wrapper';
    receivedAtMs: number;
    turnCount: number;
    charCount: number;
    imageCount: number;
    videoSeconds: number;
}

export interface MetricsBufferOptions {
    maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 2_000;

export class MetricsBuffer {
    private readonly max: number;
    private buf: BufferedMetric[] = [];
    private drops = 0;

    constructor(opts: MetricsBufferOptions = {}) {
        this.max = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    }

    /**
     * Push a metric. If the buffer is at capacity the oldest entry is
     * dropped and a drop counter is incremented. Never throws.
     */
    push(metric: BufferedMetric): void {
        if (this.buf.length >= this.max) {
            this.buf.shift();
            this.drops += 1;
        }
        this.buf.push(metric);
    }

    /** Current number of buffered metrics. */
    size(): number {
        return this.buf.length;
    }

    /** Total drops across the buffer's lifetime. */
    droppedCount(): number {
        return this.drops;
    }

    /**
     * Peek at the most recent metric without removing it.
     * Returns null when the buffer is empty.
     */
    peekLast(): BufferedMetric | null {
        return this.buf.length === 0 ? null : { ...this.buf[this.buf.length - 1] };
    }

    /**
     * Remove and return all buffered metrics in FIFO order. Resets the
     * buffer to empty. Does not reset the drop counter.
     */
    drain(): BufferedMetric[] {
        const out = this.buf;
        this.buf = [];
        return out;
    }

    /** Empty the buffer without returning anything. */
    clear(): void {
        this.buf = [];
    }
}

/**
 * Process-level singleton that the WebView onMessage handler writes into
 * and (eventually, in M5) that the session state machine reads from.
 * Exposed as a module-scoped instance so the handler does not need to
 * plumb a reference through the navigation tree.
 */
export const globalMetricsBuffer = new MetricsBuffer();
