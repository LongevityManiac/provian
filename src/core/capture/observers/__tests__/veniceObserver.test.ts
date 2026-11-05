import { describe, it, expect } from 'vitest';
import { observeVenice } from '../veniceObserver';
import { loadFixture } from './testUtils';

describe('observeVenice', () => {
    it('reports two turns, one image, nonzero charCount on the synthetic fixture', () => {
        const { document } = loadFixture('venice');
        const metrics = observeVenice(document as unknown as Document);
        expect(metrics.turnCount).toBe(2);
        expect(metrics.imageCount).toBe(1);
        expect(metrics.charCount).toBeGreaterThan(0);
        expect(metrics.videoSeconds).toBe(0);
    });

    it('charCount sums only user-authored text, not assistant output', () => {
        const { document } = loadFixture('venice');
        const userEl = document.querySelector('[data-testid="message-user"]');
        const expectedUserLen = (userEl?.textContent ?? '').length;
        const metrics = observeVenice(document as unknown as Document);
        expect(metrics.charCount).toBe(expectedUserLen);
    });

    it('is idempotent', () => {
        const { document } = loadFixture('venice');
        const a = observeVenice(document as unknown as Document);
        const b = observeVenice(document as unknown as Document);
        expect(a).toEqual(b);
    });

    it('returns zero metrics on an empty document', () => {
        const { Window } = require('happy-dom');
        const empty = new Window();
        empty.document.write('<!doctype html><html><body></body></html>');
        empty.document.close();
        const metrics = observeVenice(empty.document as unknown as Document);
        expect(metrics).toEqual({ turnCount: 0, charCount: 0, imageCount: 0, videoSeconds: 0 });
    });

    it('accepts an Element scope directly', () => {
        const { document } = loadFixture('venice');
        const scope = document.querySelector('[data-testid="chat-messages"]');
        expect(scope).not.toBeNull();
        const metrics = observeVenice(scope as unknown as Element);
        expect(metrics.turnCount).toBe(2);
        expect(metrics.imageCount).toBe(1);
    });
});
