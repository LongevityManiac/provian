import { describe, it, expect } from 'vitest';
import { observeGemini } from '../geminiObserver';
import { loadFixture } from './testUtils';

describe('observeGemini', () => {
    it('reports two turns, one image, nonzero charCount on the synthetic fixture', () => {
        const { document } = loadFixture('gemini');
        const metrics = observeGemini(document as unknown as Document);
        expect(metrics.turnCount).toBe(2);
        expect(metrics.imageCount).toBe(1);
        expect(metrics.charCount).toBeGreaterThan(0);
        expect(metrics.videoSeconds).toBe(0);
    });

    it('charCount sums only user-query elements, not model-response output', () => {
        const { document } = loadFixture('gemini');
        const userEl = document.querySelector('user-query');
        const expectedUserLen = (userEl?.textContent ?? '').length;
        const metrics = observeGemini(document as unknown as Document);
        expect(metrics.charCount).toBe(expectedUserLen);
    });

    it('is idempotent', () => {
        const { document } = loadFixture('gemini');
        const a = observeGemini(document as unknown as Document);
        const b = observeGemini(document as unknown as Document);
        expect(a).toEqual(b);
    });

    it('returns zero metrics when no user-query or model-response elements are present', () => {
        const { Window } = require('happy-dom');
        const empty = new Window();
        empty.document.write('<!doctype html><html><body><main></main></body></html>');
        empty.document.close();
        const metrics = observeGemini(empty.document as unknown as Document);
        expect(metrics).toEqual({ turnCount: 0, charCount: 0, imageCount: 0, videoSeconds: 0 });
    });
});
