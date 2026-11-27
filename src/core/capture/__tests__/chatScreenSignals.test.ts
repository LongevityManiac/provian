import { describe, it, expect } from 'vitest';
import { effectOfWatcherMessage, isAuthUrl, keyboardCounts, navigationMayRevive, stepForKeyboard, stepForNavigation } from '../chatScreenSignals';

describe('isAuthUrl: a provider sign-in page is not its chat surface', () => {
    it.each([
        'https://auth.openai.com/log-in',
        'https://chatgpt.com/auth/login',
        'https://claude.ai/login',
        'https://claude.ai/magic-link#abc',
        'https://grok.com/sign-in',
        'https://accounts.x.ai/sign-in',
        'https://x.com/i/oauth2/authorize?client_id=x',
        'https://x.com/i/flow/login',
        'https://accounts.google.com/v3/signin/identifier',
        'https://appleid.apple.com/auth/authorize',
        'https://www.perplexity.ai/auth/signin',
    ])('sign-in: %s', url => expect(isAuthUrl(url)).toBe(true));

    it.each([
        'https://chatgpt.com/',
        'https://chatgpt.com/c/6b0850e7-8ffc-83e9-aad5-2fe47b368e08',
        'https://claude.ai/new',
        'https://claude.ai/chat/489bc9d4-4d93-4919-ac71-9571ace13324',
        'https://grok.com/c/0b1c2d3e',
        'https://x.com/i/grok',
        'https://gemini.google.com/app/5becdb079ec37ffb',
        'https://www.perplexity.ai/session/abc',
        'https://venice.ai/chat/agent/Lr4lQG6',
        'https://chatgpt.com/c/authority-of-the-author',
    ])('chat surface: %s', url => expect(isAuthUrl(url)).toBe(false));
});

describe('keyboardCounts', () => {
    it('counts on a chat page with no sign-in form', () => {
        expect(keyboardCounts({ url: 'https://claude.ai/new', authFormVisible: false })).toBe(true);
    });
    it('does not count over a visible sign-in form, even on the chat host', () => {
        expect(keyboardCounts({ url: 'https://chatgpt.com/', authFormVisible: true })).toBe(false);
    });
    it('does not count on a sign-in page', () => {
        expect(keyboardCounts({ url: 'https://claude.ai/login', authFormVisible: false })).toBe(false);
    });
});

describe('navigationMayRevive: only the app in the foreground', () => {
    it.each([['active', true], ['background', false], ['inactive', false], [null, false], [undefined, false]] as const)('%s', (state, expected) => {
        expect(navigationMayRevive(state)).toBe(expected);
    });
});

describe('screen gates: what each event does to the session', () => {
    const ctx = { provider: 'claude', sessionId: 'x', boundaryMode: 'url_session_id' as const, timestampGapMs: null };

    it('a new turn on screen is an input event and hides the restore offer', () => {
        expect(effectOfWatcherMessage({ t: 'turns_added', provider: 'claude', n: 1 }, 'active', 5)).toEqual({ step: { t: 'input_event', ts: 5 }, hideRestoreVoice: true });
    });
    it('RED control: a new turn while the app is in the background is not engagement', () => {
        expect(effectOfWatcherMessage({ t: 'turns_added', provider: 'claude', n: 1 }, 'background', 5).step).toBeNull();
        expect(effectOfWatcherMessage({ t: 'turns_added', provider: 'claude', n: 1 }, 'inactive', 5).step).toBeNull();
    });
    it('a sign-in form message only sets the flag; a verdict is forwarded', () => {
        expect(effectOfWatcherMessage({ t: 'auth_page', provider: 'claude', visible: true }, 'active', 5)).toEqual({ step: null, authFormVisible: true, hideRestoreVoice: false });
        const v = { t: 'marker_health' as const, provider: 'claude', matched: false, candidate: -1, counts: [0], account: 'signed_in' as const };
        expect(effectOfWatcherMessage(v, 'active', 5)).toEqual({ step: null, markerVerdict: v, hideRestoreVoice: false });
    });

    it('keyboard: counts on a chat page in the foreground', () => {
        expect(stepForKeyboard({ url: 'https://claude.ai/new', authFormVisible: false, appState: 'active' }, 7)).toEqual({ t: 'input_event', ts: 7 });
    });
    it('RED control: keyboard over a sign-in form, on a sign-in page, or in the background is not a chat', () => {
        expect(stepForKeyboard({ url: 'https://claude.ai/new', authFormVisible: true, appState: 'active' }, 7)).toBeNull();
        expect(stepForKeyboard({ url: 'https://claude.ai/login', authFormVisible: false, appState: 'active' }, 7)).toBeNull();
        expect(stepForKeyboard({ url: 'https://claude.ai/new', authFormVisible: false, appState: 'background' }, 7)).toBeNull();
    });

    it('navigation in the foreground reports what is on screen', () => {
        expect(stepForNavigation(ctx, 'active', 9)).toEqual({ t: 'foreground_changed', ts: 9, providerContext: ctx });
    });
    it('RED control: navigation while backgrounded never revives a session', () => {
        expect(stepForNavigation(ctx, 'background', 9)).toBeNull();
        expect(stepForNavigation(ctx, 'inactive', 9)).toBeNull();
    });
});
