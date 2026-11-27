import { describe, it, expect } from 'vitest';
import { isAuthUrl, keyboardCounts, navigationMayRevive } from '../chatScreenSignals';

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
