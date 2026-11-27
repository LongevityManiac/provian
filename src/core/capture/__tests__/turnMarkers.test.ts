// @vitest-environment node
/**
 * The turn watcher, run in a simulated page with a controlled clock. Each guard ships with its
 * RED control: the same scenario with the guard's condition violated produces the opposite.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Window } from 'happy-dom';
import {
    TURN_MARKERS,
    buildTurnWatcherScript,
    parseTurnWatcherMessage,
    MARKER_HEALTH_FINAL_CHECK_MS,
    THREAD_ARRIVAL_ABSORB_MS,
    LINK_TAP_WINDOW_MS,
    ROW_TAP_WINDOW_MS,
    ARRIVAL_MAX_NEW_TURNS,
    threadKeyFromUrl,
} from '../turnMarkers';
import type { SupportedProvider } from '../injectedScript';

interface Page {
    posts: Array<Record<string, unknown>>;
    doc: Document;
    main: HTMLElement;
    /** The page moves its own history entry (pushState), as a router does. */
    nav(path: string): void;
    /** The person taps a history-list link to `path`; the page's router moves there. */
    openLink(path: string): void;
    /** The person goes back to `path` (popstate: no history call). */
    back(path: string): void;
    /** Add an element (by HTML) to the page and return it, for taps. */
    put(html: string, parent?: Element): HTMLElement;
    /** A finger press and release on `el`: pointerdown, then click. */
    tap(el: Element): void;
    /** Dispatch one bubbling page event of `type` at `target`. */
    fire(target: EventTarget, type: string): void;
    /** The page renames its own history entry (what a fresh chat does when it gets its thread). */
    rename(path: string): void;
    advance(ms: number): Promise<void>;
    addTurn(attrs: Record<string, string>, opts?: { top?: boolean; tag?: string }): HTMLElement;
}

// happy-dom holds each MutationObserver's callback only through a WeakRef, so garbage collection
// can silently disconnect the watcher mid-test (seen as random failures in a full run). A browser
// keeps a registered observer alive while its target lives; hold references strongly here too.
const RealWeakRef = globalThis.WeakRef;
class StrongRef<T extends object> {
    constructor(private readonly value: T) {}
    deref(): T { return this.value; }
}
beforeAll(() => { (globalThis as { WeakRef: unknown }).WeakRef = StrongRef; });
afterAll(() => { (globalThis as { WeakRef: unknown }).WeakRef = RealWeakRef; });

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
    const loc = { pathname: path.split('?')[0], search: path.includes('?') ? '?' + path.split('?')[1] : '', href: 'https://example.test' + path };
    const setUrl = (url: string) => {
        const u = new URL(url, loc.href);
        loc.pathname = u.pathname; loc.search = u.search; loc.href = u.href;
    };
    const fakeWindow = { ReactNativeWebView: { postMessage: (s: string) => posts.push(JSON.parse(s)) } };
    const fakeHistory = {
        replaceState(_s: unknown, _t: string, url: string) { setUrl(url); },
        pushState(_s: unknown, _t: string, url: string) { setUrl(url); },
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
        openLink(p: string) {
            const a = doc.createElement('a');
            a.setAttribute('href', p);
            const label = doc.createElement('span');
            a.append(label);
            a.addEventListener('click', ev => { ev.preventDefault(); fakeHistory.pushState(null, '', p); });
            doc.body.append(a);
            label.click();
        },
        back(p: string) { setUrl(p); },
        put(html: string, parent?: Element) {
            const box = doc.createElement('div');
            box.innerHTML = html;
            const el = box.firstElementChild as HTMLElement;
            (parent ?? doc.body).append(el);
            return el;
        },
        tap(el: Element) {
            page.fire(el, 'pointerdown');
            (el as HTMLElement).click();
        },
        fire(target: EventTarget, type: string) {
            target.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event(type, { bubbles: true }));
        },
        rename(p: string) { (fakeHistory.replaceState as (s: unknown, t: string, u: string) => void)(null, '', p); },
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
        await p.advance(500);
        p.rename('/c/0123456789abcdef');
        // A created thread's arrival is held, then its new turns count from there on.
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 500);
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
    const pathChanges = (p: Page) => p.posts.filter(m => m.t === 'path_change');

    it('opening an old thread from its history link counts nothing', async () => {
        const p = await openPage('chatgpt', '/');
        p.openLink('/c/0123456789abcdef');
        await p.advance(500);
        for (const k of ['o1', 'o2', 'o3']) p.addTurn({ 'data-turn-key': k });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 2_000);
        expect(turnsAdded(p)).toBe(0);
        expect(pathChanges(p)).toEqual([expect.objectContaining({ created: false })]);
        p.addTurn({ 'data-turn-key': 'new' });
        await p.advance(500);
        expect(turnsAdded(p)).toBe(1);
    });

    it('a fresh Claude voice chat: the page moves to its thread, then question and answer render together; it counts', async () => {
        const p = await openPage('claude', '/new');
        p.nav('/chat/0123456789abcdef');
        await p.advance(300);
        p.addTurn({ 'data-turn-key': 'u1' });
        p.addTurn({ 'data-turn-key': 'a1' });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(turnsAdded(p)).toBe(1);
        expect(pathChanges(p)).toEqual([expect.objectContaining({ path: '/chat/0123456789abcdef', created: true })]);
    });

    it('RED control: the same arrival reached by tapping its history link counts nothing', async () => {
        const p = await openPage('claude', '/new');
        p.openLink('/chat/0123456789abcdef');
        await p.advance(300);
        p.addTurn({ 'data-turn-key': 'u1' });
        p.addTurn({ 'data-turn-key': 'a1' });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(turnsAdded(p)).toBe(0);
        expect(pathChanges(p)).toEqual([expect.objectContaining({ created: false })]);
    });

    it.each(['chatgpt', 'claude', 'gemini', 'perplexity', 'grok', 'venice'] as SupportedProvider[])(
        '%s: a fresh chat moved to its thread before its first exchange renders counts it; the same thread opened from its link does not',
        async provider => {
            const fresh = { chatgpt: '/', claude: '/new', gemini: '/app', perplexity: '/', grok: '/', venice: '/chat/agent' }[provider];
            const thread = {
                chatgpt: '/c/6b0850e7-8ffc-83e9-aad5-2fe47b368e08',
                claude: '/chat/489bc9d4-4d93-4919-ac71-9571ace13324',
                gemini: '/app/5becdb079ec37ffb',
                perplexity: '/search/what-is-2-2-abcDEF123',
                grok: '/c/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0',
                venice: '/chat/agent/Lr4lQG6',
            }[provider];
            const sel = TURN_MARKERS[provider].candidates[0].sel.split(',')[0].trim();
            const turn = (page: Page) => {
                const el = page.doc.createElement('div');
                page.main.append(el);
                // Give the element what the first candidate selects on.
                const m = /^\[([a-z-]+)(?:([\^$]?=)"([^"]*)")?\]$/.exec(sel);
                if (m) el.setAttribute(m[1], (m[3] ?? 'x') + (m[2] === '^=' ? String(page.main.children.length) : ''));
                else {
                    const cls = /^\.([a-z-]+)\[id\]$/.exec(sel);
                    if (!cls) throw new Error('unhandled selector ' + sel);
                    el.className = cls[1];
                    el.id = 'c' + page.main.children.length;
                }
            };
            const created = await openPage(provider, fresh);
            created.nav(thread);
            await created.advance(300);
            turn(created); turn(created);
            await created.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
            expect(turnsAdded(created), 'created').toBe(1);

            const opened = await openPage(provider, fresh);
            opened.openLink(thread);
            await opened.advance(300);
            turn(opened); turn(opened);
            await opened.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
            expect(turnsAdded(opened), 'opened').toBe(0);
        },
    );

    it('going back to an old thread (no history call by the page) counts nothing', async () => {
        const p = await openPage('claude', '/new');
        p.back('/chat/0123456789abcdef');
        await p.advance(300);
        for (const k of ['o1', 'o2']) p.addTurn({ 'data-turn-key': k });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(turnsAdded(p)).toBe(0);
        expect(pathChanges(p)).toEqual([expect.objectContaining({ created: false })]);
    });

    it('a history link tapped long before the move does not stop a later chat from counting', async () => {
        const p = await openPage('claude', '/new');
        const a = p.doc.createElement('a');
        a.setAttribute('href', '/chat/aaaaaaaaaaaaaaaa');
        a.addEventListener('click', ev => ev.preventDefault());
        p.doc.body.append(a);
        a.click();
        await p.advance(LINK_TAP_WINDOW_MS + 1_000);
        p.nav('/chat/0123456789abcdef');
        await p.advance(300);
        p.addTurn({ 'data-turn-key': 'u1' });
        p.addTurn({ 'data-turn-key': 'a1' });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(turnsAdded(p)).toBe(1);
    });

    it('a tap on a link that is not a thread (the "new chat" link) does not mark an open', async () => {
        const p = await openPage('claude', '/new');
        const a = p.doc.createElement('a');
        a.setAttribute('href', '/new');
        a.addEventListener('click', ev => ev.preventDefault());
        p.doc.body.append(a);
        a.click();
        await p.advance(500);
        p.nav('/chat/0123456789abcdef');
        p.addTurn({ 'data-turn-key': 'u1' });
        p.addTurn({ 'data-turn-key': 'a1' });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(turnsAdded(p)).toBe(1);
    });

    it('an old thread opened some other way, rendering more turns than a new chat can have, counts nothing', async () => {
        const p = await openPage('claude', '/new');
        p.nav('/chat/0123456789abcdef');
        await p.advance(300);
        for (let i = 0; i <= ARRIVAL_MAX_NEW_TURNS; i++) p.addTurn({ 'data-turn-key': 'o' + i });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(turnsAdded(p)).toBe(0);
        p.addTurn({ 'data-turn-key': 'new' });
        await p.advance(500);
        expect(turnsAdded(p)).toBe(1);
    });

    it('RED control: one turn fewer on that first render is read as a new chat and counts', async () => {
        const p = await openPage('claude', '/new');
        p.nav('/chat/0123456789abcdef');
        await p.advance(300);
        for (let i = 0; i < ARRIVAL_MAX_NEW_TURNS; i++) p.addTurn({ 'data-turn-key': 'o' + i });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(turnsAdded(p)).toBe(1);
    });

    it('review round 1: a slow page that moves 15 s after the history-link tap still opens (no record)', async () => {
        const p = await openPage('claude', '/new');
        const a = p.put('<a href="/chat/0123456789abcdef/"><span>old</span></a>');
        a.addEventListener('click', ev => ev.preventDefault());
        p.tap(a.firstElementChild as Element);
        await p.advance(15_000);
        p.nav('/chat/0123456789abcdef');
        await p.advance(300);
        for (const k of ['o1', 'o2']) p.addTurn({ 'data-turn-key': k });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(turnsAdded(p)).toBe(0);
        expect(pathChanges(p)).toEqual([expect.objectContaining({ created: false })]);
    });

    it('RED control: a link tap to a DIFFERENT thread, then the mic, does not stop a new chat from counting', async () => {
        const p = await openPage('claude', '/new');
        const a = p.put('<a href="/chat/aaaaaaaaaaaaaaaa"><span>old</span></a>');
        a.addEventListener('click', ev => ev.preventDefault());
        p.tap(a.firstElementChild as Element);
        await p.advance(1_000);
        p.tap(p.put('<main><button aria-label="voice"></button></main>').querySelector('button') as Element);
        await p.advance(3_000);
        p.nav('/chat/0123456789abcdef');
        await p.advance(300);
        for (const k of ['u1', 'a1']) p.addTurn({ 'data-turn-key': k });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(turnsAdded(p)).toBe(1);
    });

    it(`RED control: a link tap to this thread older than ${LINK_TAP_WINDOW_MS / 1000} s no longer marks an open`, async () => {
        const p = await openPage('claude', '/new');
        const a = p.put('<a href="/chat/0123456789abcdef"><span>x</span></a>');
        a.addEventListener('click', ev => ev.preventDefault());
        p.tap(a.firstElementChild as Element);
        await p.advance(LINK_TAP_WINDOW_MS + 1_000);
        p.nav('/chat/0123456789abcdef');
        await p.advance(300);
        for (const k of ['u1', 'a1']) p.addTurn({ 'data-turn-key': k });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(turnsAdded(p)).toBe(1);
    });

    it('review round 1: a router that moves on press, before the click arrives, still opens', async () => {
        const p = await openPage('claude', '/new');
        const a = p.put('<a href="/chat/0123456789abcdef"><span>old</span></a>');
        a.addEventListener('pointerdown', () => p.nav('/chat/0123456789abcdef'));
        a.addEventListener('click', ev => ev.preventDefault());
        // A long press: the page has moved and been looked at before the click arrives.
        p.fire(a.firstElementChild as Element, 'pointerdown');
        await p.advance(700);
        (a.firstElementChild as HTMLElement).click();
        await p.advance(300);
        for (const k of ['o1', 'o2']) p.addTurn({ 'data-turn-key': k });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(turnsAdded(p)).toBe(0);
    });

    it('a tap whose target is the link\'s text node still reads the link', async () => {
        const p = await openPage('claude', '/new');
        const a = p.put('<a href="/chat/0123456789abcdef">old chat</a>');
        a.addEventListener('click', ev => ev.preventDefault());
        p.fire(a.firstChild as Node, 'click');
        p.nav('/chat/0123456789abcdef');
        await p.advance(300);
        for (const k of ['o1', 'o2']) p.addTurn({ 'data-turn-key': k });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(turnsAdded(p)).toBe(0);
    });

    it('review round 1: a bare move with no other page change, turns 1.8 s later, still counts', async () => {
        const p = await openPage('claude', '/new');
        // Interval runs fall at +4 s and +8 s from the script's start (the page opened at +0.5 s).
        // Move just after the +4 s run, so without a run on the move the next is far away.
        await p.advance(3_600);
        p.nav('/chat/0123456789abcdef');
        await p.advance(1_800);
        for (const k of ['u1', 'a1']) p.addTurn({ 'data-turn-key': k });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(pathChanges(p)).toEqual([expect.objectContaining({ created: true })]);
        expect(turnsAdded(p)).toBe(1);
    });

    it.each([
        ['a sidebar button', '<nav><ul><li><button><span>old chat</span></button></li></ul></nav>'],
        ['a search-dialog option', '<div role="dialog"><div role="option"><span>old chat</span></div></div>'],
        ['a cmdk row in a search dialog', '<div role="dialog"><div cmdk-item=""><span>old chat</span></div></div>'],
        ['an aside list row', '<aside><li><span>old chat</span></li></aside>'],
    ])('review round 1: an old chat opened from %s (not a link) counts nothing', async (_name, html) => {
        const p = await openPage('grok', '/');
        const row = p.put(html);
        const target = row.querySelector('span') as Element;
        target.addEventListener('click', () => p.nav('/c/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0'));
        p.tap(target);
        await p.advance(300);
        for (const k of ['response-o1', 'response-o2']) p.addTurn({ id: k });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(turnsAdded(p)).toBe(0);
        expect(pathChanges(p)).toEqual([expect.objectContaining({ created: false })]);
    });

    it('RED control: a sidebar tap followed by a tap on the voice button (last tap) leaves a new chat counting', async () => {
        const p = await openPage('grok', '/');
        const row = p.put('<nav><button><span>new chat</span></button></nav>');
        p.tap(row.querySelector('span') as Element);
        await p.advance(1_000);
        const mic = p.put('<main><form><button aria-label="voice"><svg></svg></button></form></main>');
        p.tap(mic.querySelector('button') as Element);
        await p.advance(4_000);
        p.nav('/c/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0');
        await p.advance(300);
        for (const k of ['response-u1', 'response-a1']) p.addTurn({ id: k });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(turnsAdded(p)).toBe(1);
    });

    it(`RED control: a sidebar tap more than ${ROW_TAP_WINDOW_MS / 1000} s before the move does not mark an open`, async () => {
        const p = await openPage('grok', '/');
        const row = p.put('<nav><button><span>x</span></button></nav>');
        p.tap(row.querySelector('span') as Element);
        await p.advance(ROW_TAP_WINDOW_MS + 1_000);
        p.nav('/c/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0');
        await p.advance(300);
        for (const k of ['response-u1', 'response-a1']) p.addTurn({ id: k });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(turnsAdded(p)).toBe(1);
    });

    it('review round 2: two thread links touched, the page then moves to the first one: still opened', async () => {
        const p = await openPage('claude', '/new');
        const a = p.put('<a href="/chat/aaaaaaaaaaaaaaaa"><span>a</span></a>');
        const b = p.put('<a href="/chat/bbbbbbbbbbbbbbbb"><span>b</span></a>');
        for (const el of [a, b]) el.addEventListener('click', ev => ev.preventDefault());
        p.tap(a.firstElementChild as Element);
        await p.advance(1_500);
        p.fire(b.firstElementChild as Element, 'touchstart');
        await p.advance(12_000);
        p.nav('/chat/aaaaaaaaaaaaaaaa');
        await p.advance(300);
        for (const k of ['o1', 'o2']) p.addTurn({ 'data-turn-key': k });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(turnsAdded(p)).toBe(0);
    });

    it('a touch on another thread\'s link while a voice chat is being created does not stop it counting', async () => {
        const p = await openPage('claude', '/new');
        const a = p.put('<a href="/chat/aaaaaaaaaaaaaaaa"><span>a</span></a>');
        p.fire(a.firstElementChild as Element, 'touchstart'); // scrolling the history list
        await p.advance(1_000);
        p.nav('/chat/0123456789abcdef');
        await p.advance(300);
        for (const k of ['u1', 'a1']) p.addTurn({ 'data-turn-key': k });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(turnsAdded(p)).toBe(1);
    });

    it('review round 2: a created voice chat posts its turn at once, before the arrival window ends', async () => {
        const p = await openPage('claude', '/new');
        p.nav('/chat/0123456789abcdef');
        await p.advance(600);
        for (const k of ['u1', 'a1']) p.addTurn({ 'data-turn-key': k });
        await p.advance(500);
        expect(turnsAdded(p)).toBe(1);
    });

    it('review round 2: the row window is measured to the move, not to when the page is looked at', async () => {
        const p = await openPage('grok', '/');
        const row = p.put('<nav><li><span>old chat</span></li></nav>');
        p.tap(row.querySelector('span') as Element);
        await p.advance(ROW_TAP_WINDOW_MS - 200);
        p.nav('/c/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0');
        await p.advance(600);
        for (const k of ['response-o1', 'response-o2']) p.addTurn({ id: k });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(pathChanges(p)).toEqual([expect.objectContaining({ created: false })]);
        expect(turnsAdded(p)).toBe(0);
    });

    it('review round 2: a suggestion option under the composer (not a sidebar or dialog) is not a history row', async () => {
        const p = await openPage('perplexity', '/');
        const opt = p.put('<main><div role="listbox"><div role="option"><span>suggestion</span></div></div></main>');
        p.tap(opt.querySelector('span') as Element);
        p.nav('/search/what-is-2-2-abcDEF123');
        await p.advance(300);
        p.addTurn({ 'data-message-bubble': 'right' }); p.addTurn({ 'data-workflow-final-text': '' });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(pathChanges(p)).toEqual([expect.objectContaining({ created: true })]);
        expect(turnsAdded(p)).toBe(1);
    });

    it('review round 2: a voice dialog\'s own button is not a history row', async () => {
        const p = await openPage('claude', '/new');
        const dlg = p.put('<div role="dialog"><button aria-label="end voice"><span>x</span></button></div>');
        p.tap(dlg.querySelector('span') as Element);
        p.nav('/chat/0123456789abcdef');
        await p.advance(300);
        for (const k of ['u1', 'a1']) p.addTurn({ 'data-turn-key': k });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(turnsAdded(p)).toBe(1);
    });

    it('review round 2: typing in the composer after a sidebar tap makes the typed chat a creation', async () => {
        const p = await openPage('grok', '/');
        p.tap(p.put('<nav><button><span>model</span></button></nav>').querySelector('span') as Element);
        await p.advance(1_000);
        const box = p.put('<main><textarea></textarea></main>').querySelector('textarea') as Element;
        p.fire(box, 'keydown');
        await p.advance(1_000);
        p.nav('/c/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0');
        await p.advance(300);
        for (const k of ['response-u1', 'response-a1']) p.addTurn({ id: k });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(pathChanges(p)).toEqual([expect.objectContaining({ created: true })]);
    });

    it('review round 3: typing in a search dialog, then Enter to open a result, is still an open', async () => {
        const p = await openPage('claude', '/new');
        p.tap(p.put('<nav><button><span>search</span></button></nav>').querySelector('span') as Element);
        const input = p.put('<div role="dialog"><input type="search"></div>').querySelector('input') as Element;
        p.fire(input, 'keydown');
        p.fire(input, 'keydown');
        p.nav('/chat/0123456789abcdef');
        await p.advance(300);
        for (const k of ['o1', 'o2']) p.addTurn({ 'data-turn-key': k });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(pathChanges(p)).toEqual([expect.objectContaining({ created: false })]);
        expect(turnsAdded(p)).toBe(0);
    });

    it('review round 3: after the arrival window, a remount of many turns is ordinary engagement again', async () => {
        const p = await openPage('perplexity', '/');
        p.nav('/search/what-is-2-2-abcDEF123');
        await p.advance(300);
        p.addTurn({ 'data-message-bubble': 'right' }); p.addTurn({ 'data-workflow-final-text': '' });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(turnsAdded(p)).toBe(1);
        // The provider remounts its turns (new elements) and a new exchange lands.
        p.main.innerHTML = '';
        for (let i = 0; i < 3; i++) { p.addTurn({ 'data-message-bubble': 'right' }); p.addTurn({ 'data-workflow-final-text': '' }); }
        await p.advance(500);
        expect(turnsAdded(p)).toBe(2);
    });

    it('review round 1: an empty render between the move and the turns does not use up the check', async () => {
        const p = await openPage('claude', '/new');
        p.nav('/chat/0123456789abcdef');
        p.put('<div class="spinner"></div>', p.main);
        await p.advance(500);
        for (let i = 0; i <= ARRIVAL_MAX_NEW_TURNS; i++) p.addTurn({ 'data-turn-key': 'o' + i });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(turnsAdded(p)).toBe(0);
    });

    it('a fresh chat the page renames to its thread counts its first turns', async () => {
        const p = await openPage('claude', '/new');
        p.rename('/chat/0123456789abcdef');
        p.addTurn({ 'data-turn-key': 'u1' });
        p.addTurn({ 'data-turn-key': 'a1' });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 500);
        expect(turnsAdded(p)).toBe(1);
    });

    it('a move the page made long before the path is seen is not creation', async () => {
        const p = await openPage('chatgpt', '/');
        p.rename('/');
        await p.advance(5_000);
        p.back('/c/0123456789abcdef');
        for (const k of ['o1', 'o2']) p.addTurn({ 'data-turn-key': k });
        await p.advance(1_000);
        expect(turnsAdded(p)).toBe(0);
    });

    it('RED control (review round 2): link to an old thread, then a same-URL replaceState, is not creation', async () => {
        const p = await openPage('claude', '/new');
        p.openLink('/chat/0123456789abcdef');
        p.rename('/chat/0123456789abcdef');
        for (const k of ['o1', 'o2']) p.addTurn({ 'data-turn-key': k });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(turnsAdded(p)).toBe(0);
        expect(pathChanges(p)).toEqual([expect.objectContaining({ path: '/chat/0123456789abcdef', created: false })]);
    });

    it('a turn on the fresh page just before the move marks creation', async () => {
        const p = await openPage('chatgpt', '/');
        p.addTurn({ 'data-turn-key': 'u1' });
        await p.advance(500);
        p.back('/c/0123456789abcdef');
        p.addTurn({ 'data-turn-key': 'a1' });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 500);
        expect(turnsAdded(p)).toBe(2);
        expect(pathChanges(p)).toEqual([expect.objectContaining({ created: true })]);
    });

    it('a chat on the fresh page, then a tapped history link, opens that thread (not a continuation)', async () => {
        const p = await openPage('chatgpt', '/');
        p.addTurn({ 'data-turn-key': 'u1' });
        await p.advance(500);
        p.openLink('/c/0123456789abcdef');
        p.main.innerHTML = '';
        for (const k of ['o1', 'o2']) p.addTurn({ 'data-turn-key': k });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(turnsAdded(p)).toBe(1);
        expect(pathChanges(p)).toEqual([expect.objectContaining({ created: false })]);
    });

    it('RED control (review round 2): a temporary chat that moves to a thread is not creation', async () => {
        const p = await openPage('chatgpt', '/?temporary-chat=true');
        p.addTurn({ 'data-turn-key': 't1' });
        await p.advance(500);
        p.nav('/c/0123456789abcdef');
        p.main.innerHTML = '';
        for (const k of ['o1', 'o2']) p.addTurn({ 'data-turn-key': k });
        await p.advance(THREAD_ARRIVAL_ABSORB_MS + 1_000);
        expect(turnsAdded(p)).toBe(1);
        expect(pathChanges(p)).toEqual([expect.objectContaining({ created: false })]);
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
