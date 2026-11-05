import { describe, it, expect } from 'vitest';
import { observePerplexity } from '../perplexityObserver';
import { loadFixture } from './testUtils';

describe('observePerplexity', () => {
    it('reports two turns, one image, nonzero charCount on the synthetic fixture', () => {
        const { document } = loadFixture('perplexity');
        const metrics = observePerplexity(document as unknown as Document);
        expect(metrics.turnCount).toBe(2);
        expect(metrics.imageCount).toBe(1);
        expect(metrics.charCount).toBeGreaterThan(0);
        expect(metrics.videoSeconds).toBe(0);
    });

    it('charCount sums only thread-question elements, not thread-answer output', () => {
        const { document } = loadFixture('perplexity');
        const userEl = document.querySelector('[data-testid="thread-question"]');
        const expectedUserLen = (userEl?.textContent ?? '').length;
        const metrics = observePerplexity(document as unknown as Document);
        expect(metrics.charCount).toBe(expectedUserLen);
    });

    it('is idempotent', () => {
        const { document } = loadFixture('perplexity');
        const a = observePerplexity(document as unknown as Document);
        const b = observePerplexity(document as unknown as Document);
        expect(a).toEqual(b);
    });

    it('returns zero metrics when no thread cards are present', () => {
        const { Window } = require('happy-dom');
        const empty = new Window();
        empty.document.write('<!doctype html><html><body><main></main></body></html>');
        empty.document.close();
        const metrics = observePerplexity(empty.document as unknown as Document);
        expect(metrics).toEqual({ turnCount: 0, charCount: 0, imageCount: 0, videoSeconds: 0 });
    });
});
