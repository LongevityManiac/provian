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

describe('observeChatGPT on the page ChatGPT serves today', () => {
    // Shape checked on the live signed-in page: data-turn-key turns, data-conversation-role on the
    // user's turns, and a "conversation-turn-location-footer" that is not a turn.
    const signedIn = `<main>
      <div data-turn-key="t1"><div data-conversation-role="user">hello there</div></div>
      <div data-turn-key="t2"><div data-conversation-role="assistant">hi</div><img src="x.png"></div>
      <div data-testid="conversation-turn-location-footer"></div>
    </main>`;

    it('counts the signed-in turns and the user text, and never the footer', async () => {
        const { Window } = await import('happy-dom');
        const w = new Window();
        w.document.write(signedIn);
        const m = observeChatGPT(w.document as unknown as Document);
        expect(m.turnCount).toBe(2);
        expect(m.charCount).toBe('hello there'.length);
        expect(m.imageCount).toBe(1);
    });

    it('RED control: the previous selectors saw one "turn" (the footer) and no user text there', async () => {
        const { Window } = await import('happy-dom');
        const w = new Window();
        w.document.write(signedIn);
        expect(w.document.querySelectorAll('[data-testid^="conversation-turn-"]').length).toBe(1);
        expect(w.document.querySelectorAll('[data-message-author-role="user"]').length).toBe(0);
    });
});
