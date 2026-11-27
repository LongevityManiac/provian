// @vitest-environment node
/**
 * The turn watcher, run in a simulated page with a controlled clock. Each guard ships with its
 * RED control: the same scenario with the guard's condition violated produces the opposite.
 */
import { describe, it, expect } from 'vitest';
import { Window } from 'happy-dom';
import {
    TURN_MARKERS,
    buildTurnWatcherScript,
    parseTurnWatcherMessage,
    MARKER_HEALTH_FINAL_CHECK_MS,
    THREAD_ARRIVAL_ABSORB_MS,
    threadKeyFromUrl,
} from '../turnMarkers';
import type { SupportedProvider } from '../injectedScript';

interface Page {
    posts: Array<Record<string, unknown>>;
    doc: Document;
    main: HTMLElement;
    nav(path: string): void;
    /** The page renames its own history entry (what a fresh chat does when it gets its thread). */
    rename(path: string): void;
    advance(ms: number): Promise<void>;
    addTurn(attrs: Record<string, string>, opts?: { top?: boolean; tag?: string }): HTMLElement;
}

async function openPage(provider: SupportedProvider, path: string): Promise<Page> {
    const win = new Window({ url: 'https://example.test' + path });
    const doc = win.document as unknown as Document;
    doc.body.innerHTML = '<main id="m"></main>';
    // happy-dom does no layout: give every element without `hidden` a size.
    (win as unknown as { Element: { prototype: Element } }).Element.prototype.getBoundingClientRect = function (this: Element) {
        const hidden = this.hasAttribute('hidden');
        return { width: hidden ? 0 : 10, height: hidden ? 0 : 10, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
    };
    const posts: Array<Record<string, unknown>> = [];
    let now = 1_000_000;
    const timers: Array<{ at: number; fn: () => void; every?: number }> = [];
    const loc = { pathname: path };
    const fakeWindow = { ReactNativeWebView: { postMessage: (s: string) => posts.push(JSON.parse(s)) } };
    const fakeHistory = {
        replaceState(_s: unknown, _t: string, url: string) { loc.pathname = url; },
        pushState(_s: unknown, _t: string, url: string) { loc.pathname = url; },
    };
    const run = new Function('window', 'document', 'location', 'history', 'MutationObserver', 'setTimeout', 'setInterval', 'Date', buildTurnWatcherScript(provider));
    run(
        fakeWindow, doc, loc, fakeHistory, win.MutationObserver,
        (fn: () => void, ms: number) => timers.push({ at: now + ms, fn }),
        (fn: () => void, ms: number) => timers.push({ at: now + ms, fn, every: ms }),
        { now: () => now },
    );
    const flush = () => new Promise<void>(r => setImmediate(r));
    const page: Page = {
        posts,
        doc,
        main: doc.getElementById('m') as HTMLElement,
        nav(p: string) { fakeHistory.pushState(null, '', p); },
        rename(p: string) { fakeHistory.replaceState(null, '', p); },
        async advance(ms: number) {
            const end = now + ms;
            for (;;) {
                await flush();
                timers.sort((a, b) => a.at - b.at);
                const next = timers[0];
                if (!next || next.at > end) break;
                timers.shift();
                now = next.at;
                if (next.every) timers.push({ at: now + next.every, fn: next.fn, every: next.every });
                next.fn();
            }
            now = end;
            await flush();
        },
        addTurn(attrs, opts = {}) {
            const el = doc.createElement(opts.tag ?? 'div');
            for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
            if (opts.top) page.main.prepend(el); else page.main.append(el);
            return el;
        },
    };
    await page.advance(500);
    return page;
}

const turnsAdded = (p: Page) => p.posts.filter(m => m.t === 'turns_added').length;
const health = (p: Page) => p.posts.filter(m => m.t === 'marker_health');

describe('turn watcher: new turns count, old ones do not', () => {
    it('a fresh ChatGPT chat whose URL gains its id counts every new turn (4 spoken turns)', async () => {
        const p = await openPage('chatgpt', '/');
        p.addTurn({ 'data-turn-key': 'u1' });
        p.rename('/c/0123456789abcdef');
        await p.advance(500);
        for (const k of ['a1', 'u2', 'a2']) { p.addTurn({ 'data-turn-key': k }); await p.advance(500); }
        expect(turnsAdded(p)).toBe(4);
    });

    it('opening an old thread that renders late counts nothing', async () => {
        const p = await openPage('chatgpt', '/c/0123456789abcdef');
        await p.advance(2_000);
        for (const k of ['o1', 'o2', 'o3']) p.addTurn({ 'data-turn-key': k });
        await p.advance(1_000);
        expect(turnsAdded(p)).toBe(0);
    });

    it('older turns rendering above on scroll count nothing; a new last turn counts once', async () => {
        const p = await openPage('claude', '/chat/0123456789abcdef');
        p.addTurn({ 'data-turn-key': 'o3' }); p.addTurn({ 'data-turn-key': 'o4' });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 500);
        p.addTurn({ 'data-turn-key': 'o2' }, { top: true }); p.addTurn({ 'data-turn-key': 'o1' }, { top: true });
        await p.advance(500);
        expect(turnsAdded(p)).toBe(0);
        p.addTurn({ 'data-turn-key': 'new' });
        await p.advance(500);
        expect(turnsAdded(p)).toBe(1);
    });

    it('switching to another old thread re-baselines', async () => {
        const p = await openPage('claude', '/chat/aaaaaaaaaaaaaaaa');
        p.addTurn({ 'data-turn-key': 'one' });
        await p.advance(500);
        p.main.innerHTML = '';
        p.nav('/chat/bbbbbbbbbbbbbbbb');
        await p.advance(500);
        p.addTurn({ 'data-turn-key': 't1' }); p.addTurn({ 'data-turn-key': 't2' });
        await p.advance(500);
        expect(turnsAdded(p)).toBe(0);
    });

    it('RED control: the same thread switch WITHOUT the path change counts the new turns', async () => {
        const p = await openPage('claude', '/chat/aaaaaaaaaaaaaaaa');
        p.addTurn({ 'data-turn-key': 'one' });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 500);
        p.main.innerHTML = '';
        await p.advance(500);
        p.addTurn({ 'data-turn-key': 't1' }); p.addTurn({ 'data-turn-key': 't2' });
        await p.advance(500);
        expect(turnsAdded(p)).toBe(1);
    });

    it('ChatGPT signed-out shape counts; its footer is never a turn', async () => {
        const p = await openPage('chatgpt', '/');
        p.addTurn({ 'data-testid': 'conversation-turn-location-footer' });
        await p.advance(500);
        expect(turnsAdded(p)).toBe(0);
        p.addTurn({ 'data-testid': 'conversation-turn-1' }, { top: true });
        p.main.append(p.doc.querySelector('[data-testid="conversation-turn-location-footer"]') as Element);
        await p.advance(500);
        expect(turnsAdded(p)).toBe(1);
    });
});

describe('turn watcher: a fresh page is where old threads are opened from', () => {
    it('opening an old thread from the fresh page counts nothing', async () => {
        const p = await openPage('chatgpt', '/');
        p.nav('/c/0123456789abcdef');
        await p.advance(500);
        for (const k of ['o1', 'o2', 'o3']) p.addTurn({ 'data-turn-key': k });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 2_000);
        expect(turnsAdded(p)).toBe(0);
        p.addTurn({ 'data-turn-key': 'new' });
        await p.advance(500);
        expect(turnsAdded(p)).toBe(1);
    });

    it('a fresh chat the page renames to its thread counts its first turns', async () => {
        const p = await openPage('claude', '/new');
        p.rename('/chat/0123456789abcdef');
        p.addTurn({ 'data-turn-key': 'u1' });
        p.addTurn({ 'data-turn-key': 'a1' });
        await p.advance(500);
        expect(turnsAdded(p)).toBe(1);
    });

    it('RED control: the same arrival without the rename is read as an opened thread', async () => {
        const p = await openPage('claude', '/new');
        p.nav('/chat/0123456789abcdef');
        p.addTurn({ 'data-turn-key': 'u1' });
        p.addTurn({ 'data-turn-key': 'a1' });
        await p.advance(500);
        expect(turnsAdded(p)).toBe(0);
    });

    it('a rename long before the move does not count as creation', async () => {
        const p = await openPage('chatgpt', '/');
        p.rename('/');
        await p.advance(5_000);
        p.nav('/c/0123456789abcdef');
        for (const k of ['o1', 'o2']) p.addTurn({ 'data-turn-key': k });
        await p.advance(1_000);
        expect(turnsAdded(p)).toBe(0);
    });

    it('turns still swapping in on arrival at another thread are absorbed', async () => {
        const p = await openPage('claude', '/chat/aaaaaaaaaaaaaaaa');
        p.addTurn({ 'data-turn-key': 'a1' });
        await p.advance(500);
        p.nav('/chat/bbbbbbbbbbbbbbbb');
        await p.advance(500);
        // The old thread's turn is still up when the first run after the move fires.
        p.main.innerHTML = '';
        p.addTurn({ 'data-turn-key': 'b1' }); p.addTurn({ 'data-turn-key': 'b2' });
        await p.advance(1_000);
        expect(turnsAdded(p)).toBe(0);
    });
});

describe('threadKeyFromUrl: every conversation URL has a key', () => {
    it.each([
        ['venice', 'https://venice.ai/chat/agent/Lr4lQG6', '/chat/agent/Lr4lQG6'],
        ['perplexity', 'https://www.perplexity.ai/session/ca3aacf9-91f3-4a49-a0c9-49a2bb36f6f8', '/session/ca3aacf9-91f3-4a49-a0c9-49a2bb36f6f8'],
        ['chatgpt', 'https://chatgpt.com/g/g-abc/c/6b0850e7-8ffc-83e9-aad5-2fe47b368e08?x=1', '/g/g-abc/c/6b0850e7-8ffc-83e9-aad5-2fe47b368e08'],
    ])('%s %s', (provider, url, key) => expect(threadKeyFromUrl(provider, url)).toBe(key));
    it.each([
        ['venice', 'https://venice.ai/chat/agent'],
        ['chatgpt', 'https://chatgpt.com/?temporary-chat=true'],
        ['claude', 'https://claude.ai/new'],
        ['nobody', 'https://example.com/c/abc'],
    ])('fresh or unknown: %s %s', (provider, url) => expect(threadKeyFromUrl(provider, url)).toBeNull());
});

describe('turn watcher: sign-in forms', () => {
    it('reports a visible sign-in field, then its removal', async () => {
        const p = await openPage('claude', '/login');
        const input = p.addTurn({ type: 'email' }, { tag: 'input' });
        await p.advance(500);
        input.remove();
        await p.advance(500);
        expect(p.posts.filter(m => m.t === 'auth_page').map(m => m.visible)).toEqual([false, true, false]);
    });

    it('RED control: a hidden sign-in field is not a sign-in form', async () => {
        const p = await openPage('claude', '/new');
        p.addTurn({ type: 'password', hidden: '' }, { tag: 'input' });
        await p.advance(500);
        expect(p.posts.filter(m => m.t === 'auth_page').map(m => m.visible)).toEqual([false]);
    });
});

describe('turn watcher: marker health', () => {
    it('a conversation page whose markers match reports matched', async () => {
        const p = await openPage('chatgpt', '/c/0123456789abcdef');
        p.addTurn({ 'data-turn-key': 'x' });
        await p.advance(MARKER_HEALTH_FINAL_CHECK_MS + 5_000);
        expect(health(p)).toEqual([expect.objectContaining({ matched: true, candidate: 0, account: 'signed_in' })]);
    });

    it('a conversation page where nothing matches reports unmatched once', async () => {
        const p = await openPage('chatgpt', '/c/0123456789abcdef');
        p.addTurn({ 'data-some-new-marker': 'x' });
        await p.advance(MARKER_HEALTH_FINAL_CHECK_MS * 3);
        const h = health(p);
        expect(h).toHaveLength(1);
        expect(h[0]).toMatchObject({ matched: false, candidate: -1 });
    });

    it('the old ChatGPT marker alone would have reported the signed-in page unmatched', async () => {
        // The live signed-in page: data-turn-key turns plus a "-footer" test id. Our previous
        // marker, [data-testid^="conversation-turn-"], matched only the footer.
        const p = await openPage('chatgpt', '/c/0123456789abcdef');
        for (const k of ['a', 'b', 'c']) p.addTurn({ 'data-turn-key': k });
        p.addTurn({ 'data-testid': 'conversation-turn-location-footer' });
        await p.advance(MARKER_HEALTH_FINAL_CHECK_MS + 5_000);
        // RED control for the old marker: on this page it finds one element, the footer, and no turn.
        const old = p.doc.querySelectorAll('[data-testid^="conversation-turn-"]');
        expect(old.length).toBe(1);
        expect(old[0].getAttribute('data-testid')).toBe('conversation-turn-location-footer');
        expect(health(p)[0]).toMatchObject({ matched: true, candidate: 0, counts: [3, 0, 0] });
    });

    it('a fresh chat page is never judged', async () => {
        const p = await openPage('chatgpt', '/');
        await p.advance(MARKER_HEALTH_FINAL_CHECK_MS * 3);
        expect(health(p)).toHaveLength(0);
    });

    it('marks a page with a sign-in link as signed out', async () => {
        const p = await openPage('chatgpt', '/c/0123456789abcdef');
        p.addTurn({ 'data-testid': 'login-button' }, { tag: 'button' });
        p.addTurn({ 'data-testid': 'conversation-turn-1' });
        await p.advance(MARKER_HEALTH_FINAL_CHECK_MS + 5_000);
        expect(health(p)[0]).toMatchObject({ matched: true, candidate: 1, account: 'signed_out' });
    });
});

describe('turn markers: every chat-screen provider has live markers and paths', () => {
    it.each(Object.entries(TURN_MARKERS))('%s', (_provider, spec) => {
        expect(spec.candidates.length).toBeGreaterThan(0);
        expect(() => new RegExp(spec.freshPath)).not.toThrow();
        expect(() => new RegExp(spec.threadPath)).not.toThrow();
    });

    it('thread paths match today\'s conversation URLs and not fresh pages', () => {
        const cases: Array<[SupportedProvider, string, boolean]> = [
            ['chatgpt', '/c/6b0850e7-8ffc-83e9-aad5-2fe47b368e08', true],
            ['chatgpt', '/', false],
            ['claude', '/chat/489bc9d4-4d93-4919-ac71-9571ace13324', true],
            ['claude', '/new', false],
            ['gemini', '/app/5becdb079ec37ffb', true],
            ['perplexity', '/session/ca3aacf9-91f3-4a49-a0c9-49a2bb36f6f8', true],
            ['perplexity', '/search/what-is-2-2-abcDEF123', true],
            ['venice', '/chat/agent/Lr4lQG6', true],
            ['venice', '/chat/agent', false],
            ['grok', '/c/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0', true],
            ['grok', '/', false],
        ];
        for (const [provider, path, expected] of cases) {
            expect(new RegExp(TURN_MARKERS[provider].threadPath).test(path), `${provider} ${path}`).toBe(expected);
        }
    });
});

describe('parseTurnWatcherMessage', () => {
    it('accepts the three shapes for the screen\'s own provider', () => {
        expect(parseTurnWatcherMessage('{"v":1,"t":"turns_added","provider":"grok","n":2}', 'grok')).toEqual({ t: 'turns_added', provider: 'grok', n: 2 });
        expect(parseTurnWatcherMessage('{"v":1,"t":"auth_page","provider":"grok","visible":true}', 'grok')).toMatchObject({ visible: true });
        expect(parseTurnWatcherMessage('{"v":1,"t":"marker_health","provider":"grok","matched":false,"candidate":-1,"counts":[0,0],"account":"signed_in"}', 'grok')).toMatchObject({ matched: false });
    });

    it('refuses another provider, malformed values, extra-large input, and capture metrics', () => {
        expect(parseTurnWatcherMessage('{"v":1,"t":"turns_added","provider":"claude","n":2}', 'grok')).toBeNull();
        expect(parseTurnWatcherMessage('{"v":1,"t":"turns_added","provider":"grok","n":0}', 'grok')).toBeNull();
        expect(parseTurnWatcherMessage('{"v":1,"t":"turns_added","provider":"grok","n":"2"}', 'grok')).toBeNull();
        expect(parseTurnWatcherMessage('{"v":1,"t":"marker_health","provider":"grok","matched":false,"candidate":-1,"counts":[0],"account":"admin"}', 'grok')).toBeNull();
        expect(parseTurnWatcherMessage('{"v":1,"t":"capture_metrics","provider":"grok","turnCount":1}', 'grok')).toBeNull();
        expect(parseTurnWatcherMessage('x'.repeat(3_000), 'grok')).toBeNull();
        expect(parseTurnWatcherMessage('not json', 'grok')).toBeNull();
    });
});
