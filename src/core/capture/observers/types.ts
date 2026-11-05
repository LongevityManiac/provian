/**
 * Shared observer types for the mobile Chat capture surface.
 *
 * Each provider-specific observer exports a pure function conforming to
 * `ProviderObserver` that takes a DOM document or root node and returns the
 * four content-count metrics consumed by the injected MutationObserver
 * layer and eventually by `ai_conversation` PE emission in M5.
 *
 * Pure, idempotent, side-effect-free. Zero matches return zero, never throw,
 * never tear down the WebView.
 */

export interface ObserverMetrics {
    /** Number of distinct conversational turns observed in the root. */
    turnCount: number;
    /** Sum of text length over user-authored content in the root. */
    charCount: number;
    /** Number of image attachments / inline images in the root. */
    imageCount: number;
    /** Total video duration in seconds, summed over video elements. */
    videoSeconds: number;
}

export type DomRoot = Document | Element;

/** Pure function signature every provider observer must satisfy. */
export type ProviderObserver = (root: DomRoot) => ObserverMetrics;

export const ZERO_METRICS: ObserverMetrics = Object.freeze({
    turnCount: 0,
    charCount: 0,
    imageCount: 0,
    videoSeconds: 0,
});

/**
 * Safe wrapper used by injected scripts to guarantee graceful degradation:
 * if the observer throws for any reason we return zero metrics rather than
 * crashing the WebView.
 */
export function runObserverSafely(observer: ProviderObserver, root: DomRoot): ObserverMetrics {
    try {
        return observer(root);
    } catch {
        return { ...ZERO_METRICS };
    }
}

/**
 * Sum video durations in seconds, ignoring NaN / Infinity / negative.
 * Used by observers that support video (Claude: n/a, ChatGPT: rare,
 * Gemini: search results sometimes, Perplexity: sometimes, Grok: n/a).
 */
export function sumVideoSeconds(videos: NodeListOf<HTMLVideoElement> | HTMLVideoElement[]): number {
    let total = 0;
    for (const v of Array.from(videos)) {
        const d = v.duration;
        if (typeof d === 'number' && Number.isFinite(d) && d > 0) {
            total += d;
        }
    }
    return Math.round(total);
}

/**
 * Normalize a DomRoot to a scope. When given a Document, prefer a
 * provider-specific conversation selector, otherwise fall back to
 * document.body / documentElement / the document itself. When given an
 * Element, return it as-is.
 *
 * Returns null only when the root is unrecognizable, which the observers
 * treat as a zero-metrics signal.
 */
export function resolveScope(
    root: DomRoot,
    preferredSelector?: string,
): Document | Element | null {
    if ((root as Node).nodeType === 9) {
        const doc = root as Document;
        if (preferredSelector) {
            const scoped = doc.querySelector(preferredSelector);
            if (scoped) return scoped;
        }
        return doc.body ?? doc.documentElement ?? doc;
    }
    if ((root as Node).nodeType === 1) {
        return root as Element;
    }
    return null;
}

export function zeroMetrics(): ObserverMetrics {
    return { turnCount: 0, charCount: 0, imageCount: 0, videoSeconds: 0 };
}
