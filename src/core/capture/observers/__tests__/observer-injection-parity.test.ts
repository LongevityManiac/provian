/**
 * Observer / injected-script selector parity.
 *
 * The mobile Chat surface has two independent DOM-reading code paths:
 *   1. Injected JS inside the WebView, defined by `buildInjectedScript` in
 *      `src/core/capture/injectedScript.ts` using `SELECTORS_BY_PROVIDER`.
 *   2. TypeScript observer modules in `src/core/capture/observers/*` used
 *      for synthetic-fixture unit tests and any future happy-dom work.
 *
 * The two paths share a source-of-truth: the selector strings per provider.
 * If either path drifts silently, the WebView and the TS observer disagree
 * about what is a user message / turn / image, and the unit tests vouch for
 * the wrong thing. This test fails noisily when the sets diverge.
 *
 * One `it` per provider. The comparison normalizes the two shapes (the
 * injected script carries boolean flags, the observer does not) and asserts
 * the selector strings match.
 */

import { describe, it, expect } from 'vitest';
import { SELECTORS_BY_PROVIDER } from '../../injectedScript';
import { CLAUDE_OBSERVER_SELECTORS } from '../claudeObserver';
import { CHATGPT_OBSERVER_SELECTORS } from '../chatgptObserver';
import { GEMINI_OBSERVER_SELECTORS } from '../geminiObserver';
import { PERPLEXITY_OBSERVER_SELECTORS } from '../perplexityObserver';
import { GROK_OBSERVER_SELECTORS } from '../grokObserver';
import { VENICE_OBSERVER_SELECTORS } from '../veniceObserver';

interface NormalizedSelectors {
    scope?: string;
    turn?: string;
    countTurns: boolean;
    userCharSource?: string;
    image?: string;
    countVideo: boolean;
}

function normalize(sel: {
    scope?: string;
    turn?: string;
    countTurns: boolean;
    userCharSource?: string;
    image?: string;
    countVideo: boolean;
}): NormalizedSelectors {
    return {
        scope: sel.scope,
        turn: sel.turn,
        countTurns: sel.countTurns,
        userCharSource: sel.userCharSource,
        image: sel.image,
        countVideo: sel.countVideo,
    };
}

function diffMessage(
    provider: string,
    injected: NormalizedSelectors,
    observer: NormalizedSelectors,
): string {
    return [
        `Selector parity drift detected for provider "${provider}".`,
        `Injected script (SELECTORS_BY_PROVIDER.${provider}):`,
        JSON.stringify(injected, null, 2),
        `Observer module (${provider.toUpperCase()}_OBSERVER_SELECTORS):`,
        JSON.stringify(observer, null, 2),
    ].join('\n');
}

describe('observer / injected-script selector parity', () => {
    it('claude: observer selectors match SELECTORS_BY_PROVIDER.claude', () => {
        const injected = normalize(SELECTORS_BY_PROVIDER.claude);
        const observer = normalize(CLAUDE_OBSERVER_SELECTORS);
        expect(observer, diffMessage('claude', injected, observer)).toEqual(injected);
    });

    it('chatgpt: observer selectors match SELECTORS_BY_PROVIDER.chatgpt', () => {
        const injected = normalize(SELECTORS_BY_PROVIDER.chatgpt);
        const observer = normalize(CHATGPT_OBSERVER_SELECTORS);
        expect(observer, diffMessage('chatgpt', injected, observer)).toEqual(injected);
    });

    it('gemini: observer selectors match SELECTORS_BY_PROVIDER.gemini', () => {
        const injected = normalize(SELECTORS_BY_PROVIDER.gemini);
        const observer = normalize(GEMINI_OBSERVER_SELECTORS);
        expect(observer, diffMessage('gemini', injected, observer)).toEqual(injected);
    });

    it('perplexity: observer selectors match SELECTORS_BY_PROVIDER.perplexity', () => {
        const injected = normalize(SELECTORS_BY_PROVIDER.perplexity);
        const observer = normalize(PERPLEXITY_OBSERVER_SELECTORS);
        expect(observer, diffMessage('perplexity', injected, observer)).toEqual(injected);
    });

    it('grok: observer selectors match SELECTORS_BY_PROVIDER.grok', () => {
        const injected = normalize(SELECTORS_BY_PROVIDER.grok);
        const observer = normalize(GROK_OBSERVER_SELECTORS);
        expect(observer, diffMessage('grok', injected, observer)).toEqual(injected);
    });

    it('venice: observer selectors match SELECTORS_BY_PROVIDER.venice', () => {
        const injected = normalize(SELECTORS_BY_PROVIDER.venice);
        const observer = normalize(VENICE_OBSERVER_SELECTORS);
        expect(observer, diffMessage('venice', injected, observer)).toEqual(injected);
    });
});
