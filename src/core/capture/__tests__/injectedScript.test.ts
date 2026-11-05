/**
 * injectedScript tests. We verify two things:
 *
 *   1. The builder produces a string that contains the provider literal,
 *      the expected selector strings, and the ReactNativeWebView postMessage
 *      call. This catches accidental schema drift and guards against the
 *      injected script forgetting to post.
 *
 *   2. When the script is evaluated inside a happy-dom Window with a
 *      synthetic fixture loaded and a mocked `window.ReactNativeWebView`,
 *      it eventually posts a well-formed metrics payload. This exercises
 *      the full injected code path including the initial post timer.
 *
 * Full MutationObserver-driven re-posting is not exercised here (jsdom-
 * style environments simulate MutationObserver inconsistently across
 * happy-dom versions); M5 adds an end-to-end test when the state machine
 * consumer lands.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';
import {
    buildInjectedScript,
    DEBOUNCE_MS_DEFAULT,
    type SupportedProvider,
} from '../injectedScript';

function fixturePath(provider: string): string {
    return resolve(__dirname, '..', 'fixtures', `${provider}.synthetic.html`);
}

describe('buildInjectedScript: static shape', () => {
    const providers: SupportedProvider[] = ['claude', 'chatgpt', 'gemini', 'perplexity', 'grok', 'venice'];

    for (const provider of providers) {
        it(`emits a self-contained IIFE that posts via ReactNativeWebView for ${provider}`, () => {
            const js = buildInjectedScript(provider);
            expect(js).toContain(`"${provider}"`);
            expect(js).toContain('window.ReactNativeWebView');
            expect(js).toContain('postMessage');
            expect(js).toContain('capture_metrics');
            // The closing `true;` is the react-native-webview idiom to signal
            // the injection completed.
            expect(js.trimEnd().endsWith('true;')).toBe(true);
        });
    }

    it('accepts a custom debounce interval', () => {
        const js = buildInjectedScript('claude', { debounceMs: 500 });
        expect(js).toContain('var DEBOUNCE_MS = 500');
    });

    it('uses the default debounce when none is supplied', () => {
        const js = buildInjectedScript('claude');
        expect(js).toContain(`var DEBOUNCE_MS = ${DEBOUNCE_MS_DEFAULT}`);
    });

    it('throws for an unknown provider id', () => {
        expect(() => buildInjectedScript('copilot' as SupportedProvider)).toThrow(
            /unknown provider/,
        );
    });
});

describe('buildInjectedScript: end-to-end in happy-dom', () => {
    it('posts a rounded metrics payload for the Claude fixture', async () => {
        const html = readFileSync(fixturePath('claude'), 'utf8');
        const win = new Window();
        win.document.write(html);
        win.document.close();

        const received: string[] = [];
        // happy-dom's Window is loose enough to accept a custom global without
        // contorted typing.
        (win as unknown as { ReactNativeWebView: { postMessage: (s: string) => void } }).ReactNativeWebView = {
            postMessage: (s: string) => received.push(s),
        };

        const js = buildInjectedScript('claude', { debounceMs: 10 });
        // Evaluate the injected script inside the happy-dom Window's
        // global scope by assigning globals onto the Window and using Function.
        const runner = new win.Function('_', js) as (_: unknown) => unknown;
        runner.call(win, null);

        // Wait for the initial postMetrics timer (debounce + a small buffer).
        await new Promise(r => setTimeout(r, 60));

        expect(received.length).toBeGreaterThan(0);
        const payload = JSON.parse(received[0]);
        expect(payload).toMatchObject({
            v: 1,
            t: 'capture_metrics',
            provider: 'claude',
            turnCount: 2,
            imageCount: 1,
            videoSeconds: 0,
        });
        // charCount is rounded to nearest 100.
        expect(payload.charCount % 100).toBe(0);
        // And charCount should be positive given the fixture has user text.
        expect(payload.charCount).toBeGreaterThanOrEqual(100);

        vi.restoreAllMocks();
    });

    it('posts turnCount=0 for the Grok fixture (lighter observer)', async () => {
        const html = readFileSync(fixturePath('grok'), 'utf8');
        const win = new Window();
        win.document.write(html);
        win.document.close();

        const received: string[] = [];
        (win as unknown as { ReactNativeWebView: { postMessage: (s: string) => void } }).ReactNativeWebView = {
            postMessage: (s: string) => received.push(s),
        };

        const js = buildInjectedScript('grok', { debounceMs: 10 });
        const runner = new win.Function('_', js) as (_: unknown) => unknown;
        runner.call(win, null);

        await new Promise(r => setTimeout(r, 60));
        expect(received.length).toBeGreaterThan(0);
        const payload = JSON.parse(received[0]);
        expect(payload.provider).toBe('grok');
        expect(payload.turnCount).toBe(0);
        expect(payload.videoSeconds).toBe(0);
        expect(payload.imageCount).toBe(1);
        expect(payload.charCount).toBeGreaterThanOrEqual(100);
    });

    it('posts a rounded metrics payload for the Venice fixture', async () => {
        const html = readFileSync(fixturePath('venice'), 'utf8');
        const win = new Window();
        win.document.write(html);
        win.document.close();

        const received: string[] = [];
        (win as unknown as { ReactNativeWebView: { postMessage: (s: string) => void } }).ReactNativeWebView = {
            postMessage: (s: string) => received.push(s),
        };

        const js = buildInjectedScript('venice', { debounceMs: 10 });
        const runner = new win.Function('_', js) as (_: unknown) => unknown;
        runner.call(win, null);

        await new Promise(r => setTimeout(r, 60));
        expect(received.length).toBeGreaterThan(0);
        const payload = JSON.parse(received[0]);
        expect(payload).toMatchObject({
            v: 1,
            t: 'capture_metrics',
            provider: 'venice',
            turnCount: 2,
            imageCount: 1,
            videoSeconds: 0,
        });
        expect(payload.charCount % 100).toBe(0);
        expect(payload.charCount).toBeGreaterThanOrEqual(100);

        vi.restoreAllMocks();
    });
});
