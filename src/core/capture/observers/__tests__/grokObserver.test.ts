import { describe, it, expect } from 'vitest';
import { observeGrok } from '../grokObserver';
import { loadFixture } from './testUtils';

describe('observeGrok', () => {
    it('reports one image and nonzero charCount on the synthetic fixture; turnCount and videoSeconds are zero by construction', () => {
        const { document } = loadFixture('grok');
        const metrics = observeGrok(document as unknown as Document);
        expect(metrics.imageCount).toBe(1);
        expect(metrics.charCount).toBeGreaterThan(0);
        // Grok ships a lighter observer; turns come from timestamps not DOM.
        expect(metrics.turnCount).toBe(0);
        expect(metrics.videoSeconds).toBe(0);
    });

    it('charCount sums only user-role messages, not assistant replies', () => {
        const { document } = loadFixture('grok');
        const userEl = document.querySelector('[data-testid="message"][data-role="user"]');
        const expectedUserLen = (userEl?.textContent ?? '').length;
        const metrics = observeGrok(document as unknown as Document);
        expect(metrics.charCount).toBe(expectedUserLen);
    });

    it('is idempotent', () => {
        const { document } = loadFixture('grok');
        const a = observeGrok(document as unknown as Document);
        const b = observeGrok(document as unknown as Document);
        expect(a).toEqual(b);
    });

    it('returns zero metrics when no user messages are present', () => {
        const { Window } = require('happy-dom');
        const empty = new Window();
        empty.document.write('<!doctype html><html><body><div class="conversation"></div></body></html>');
        empty.document.close();
        const metrics = observeGrok(empty.document as unknown as Document);
        expect(metrics).toEqual({ turnCount: 0, charCount: 0, imageCount: 0, videoSeconds: 0 });
    });
});
