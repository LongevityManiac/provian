import { describe, it, expect } from 'vitest';
import { observeChatGPT } from '../chatgptObserver';
import { loadFixture } from './testUtils';

describe('observeChatGPT', () => {
    it('reports two turns, one image, nonzero charCount on the synthetic fixture', () => {
        const { document } = loadFixture('chatgpt');
        const metrics = observeChatGPT(document as unknown as Document);
        expect(metrics.turnCount).toBe(2);
        expect(metrics.imageCount).toBe(1);
        expect(metrics.charCount).toBeGreaterThan(0);
        expect(metrics.videoSeconds).toBe(0);
    });

    it('charCount sums only user-authored messages, not assistant output', () => {
        const { document } = loadFixture('chatgpt');
        const userEl = document.querySelector('[data-message-author-role="user"]');
        const expectedUserLen = (userEl?.textContent ?? '').length;
        const metrics = observeChatGPT(document as unknown as Document);
        expect(metrics.charCount).toBe(expectedUserLen);
    });

    it('is idempotent', () => {
        const { document } = loadFixture('chatgpt');
        const a = observeChatGPT(document as unknown as Document);
        const b = observeChatGPT(document as unknown as Document);
        expect(a).toEqual(b);
    });

    it('returns zero metrics when the fixture has no conversation turns', () => {
        const { Window } = require('happy-dom');
        const empty = new Window();
        empty.document.write('<!doctype html><html><body><main></main></body></html>');
        empty.document.close();
        const metrics = observeChatGPT(empty.document as unknown as Document);
        expect(metrics).toEqual({ turnCount: 0, charCount: 0, imageCount: 0, videoSeconds: 0 });
    });
});
