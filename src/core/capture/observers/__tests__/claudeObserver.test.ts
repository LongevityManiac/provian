import { describe, it, expect } from 'vitest';
import { observeClaude } from '../claudeObserver';
import { loadFixture } from './testUtils';

describe('observeClaude', () => {
    it('reports two turns, one image, nonzero charCount on the synthetic fixture', () => {
        const { document } = loadFixture('claude');
        const metrics = observeClaude(document as unknown as Document);
        expect(metrics.turnCount).toBe(2);
        expect(metrics.imageCount).toBe(1);
        expect(metrics.charCount).toBeGreaterThan(0);
        expect(metrics.videoSeconds).toBe(0);
    });

    it('charCount sums only user-authored text, not assistant output', () => {
        const { document } = loadFixture('claude');
        const userEl = document.querySelector('[data-testid="user-message"]');
        const expectedUserLen = (userEl?.textContent ?? '').length;
        const metrics = observeClaude(document as unknown as Document);
        expect(metrics.charCount).toBe(expectedUserLen);
    });

    it('is idempotent', () => {
        const { document } = loadFixture('claude');
        const a = observeClaude(document as unknown as Document);
        const b = observeClaude(document as unknown as Document);
        expect(a).toEqual(b);
    });

    it('returns zero metrics on an empty document', () => {
        const { Window } = require('happy-dom');
        const empty = new Window();
        empty.document.write('<!doctype html><html><body></body></html>');
        empty.document.close();
        const metrics = observeClaude(empty.document as unknown as Document);
        expect(metrics).toEqual({ turnCount: 0, charCount: 0, imageCount: 0, videoSeconds: 0 });
    });

    it('accepts an Element scope directly', () => {
        const { document } = loadFixture('claude');
        const scope = document.querySelector('[data-testid="conversation"]');
        expect(scope).not.toBeNull();
        const metrics = observeClaude(scope as unknown as Element);
        expect(metrics.turnCount).toBe(2);
        expect(metrics.imageCount).toBe(1);
    });
});
