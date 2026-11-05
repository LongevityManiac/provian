/**
 * WebView onMessage handler for observer-posted metrics.
 *
 * The WebView's injected MutationObserver layer posts JSON like:
 *
 *   {
 *     "v": 1,
 *     "t": "capture_metrics",
 *     "provider": "claude",
 *     "turnCount": 2,
 *     "charCount": 300,
 *     "imageCount": 1,
 *     "videoSeconds": 0
 *   }
 *
 * via `window.ReactNativeWebView.postMessage(JSON.stringify(...))`.
 *
 * This handler parses, validates shape and types, stamps a receive-time
 * timestamp, and forwards to a `MetricsBuffer`. Invalid payloads are
 * silently dropped; no throws, no WebView teardown.
 *
 * M5 attaches this handler to the Chat WebView and adds a consumer that
 * drains the buffer into the session state machine.
 */

import { globalMetricsBuffer, type BufferedMetric, type MetricsBuffer } from './MetricsBuffer';
import { ENABLED_PROVIDERS } from './catalog';

/** Matches the shape produced by `buildInjectedScript` in `injectedScript.ts`. */
export interface InjectedMetricsPayload {
    v: number;
    t: 'capture_metrics';
    provider: string;
    turnCount: number;
    charCount: number;
    imageCount: number;
    videoSeconds: number;
}

export interface WebViewOnMessageEvent {
    nativeEvent: { data: string };
}

export type OnMessageFn = (event: WebViewOnMessageEvent) => void;

export interface OnMessageHandlerOptions {
    buffer?: MetricsBuffer;
    now?: () => number;
    onDrop?: (reason: string) => void;
}

/**
 * Build an `onMessage` handler bound to a MetricsBuffer (defaults to the
 * process-level singleton). Safe to attach directly to a react-native-webview
 * `onMessage` prop.
 */
export function createOnMessageHandler(opts: OnMessageHandlerOptions = {}): OnMessageFn {
    const buffer = opts.buffer ?? globalMetricsBuffer;
    const now = opts.now ?? (() => Date.now());
    const onDrop = opts.onDrop ?? (() => {});

    return function onMessage(event: WebViewOnMessageEvent): void {
        const raw = event?.nativeEvent?.data;
        if (typeof raw !== 'string' || raw.length === 0) {
            onDrop('empty-or-non-string-data');
            return;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            onDrop('invalid-json');
            return;
        }

        const payload = validatePayload(parsed);
        if (!payload) {
            onDrop('schema-mismatch');
            return;
        }

        // Catalog-membership check: reject payloads whose provider is not
        // in ENABLED_PROVIDERS. Defense in depth against a WebView that
        // somehow posts a payload for a provider outside the Chat tab
        // allowlist. Shipped as part of Phase 2c M5 follow-up #2.
        if (!ENABLED_PROVIDERS.includes(payload.provider)) {
            onDrop('provider-not-in-catalog');
            return;
        }

        const metric: BufferedMetric = {
            provider: payload.provider,
            surface: 'mobile_wrapper',
            receivedAtMs: now(),
            turnCount: payload.turnCount,
            charCount: payload.charCount,
            imageCount: payload.imageCount,
            videoSeconds: payload.videoSeconds,
        };
        buffer.push(metric);
    };
}

function validatePayload(v: unknown): InjectedMetricsPayload | null {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    if (o.v !== 1) return null;
    if (o.t !== 'capture_metrics') return null;
    if (typeof o.provider !== 'string' || o.provider.length === 0) return null;
    if (!isNonNegativeFiniteInt(o.turnCount)) return null;
    if (!isNonNegativeFiniteInt(o.charCount)) return null;
    if (!isNonNegativeFiniteInt(o.imageCount)) return null;
    if (!isNonNegativeFiniteInt(o.videoSeconds)) return null;
    return o as unknown as InjectedMetricsPayload;
}

function isNonNegativeFiniteInt(n: unknown): n is number {
    return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n >= 0;
}
