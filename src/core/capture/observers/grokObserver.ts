/**
 * Grok observer. Pure function producing ObserverMetrics from the
 * current grok.com and x.com/i/grok chat DOM.
 *
 * Grok ships a lighter observer than the four URL-boundary providers.
 * Session boundaries for Grok come from `detectGrokBoundary` via
 * timestamps (see CAPTURE_ARCHITECTURE.md §6 and M2), not from DOM
 * events, so turnCount is not a load-bearing signal for session
 * accounting. This observer intentionally reports turnCount = 0 and
 * videoSeconds = 0 and emits only charCount and imageCount.
 *
 * Selectors in this module are written against synthetic fixtures. Live
 * DOM validation against the current production web app occurs at final
 * release-build smoke test. Selector drift from current provider DOM is
 * expected and will be reconciled in a follow-up patch when the smoke
 * test surfaces mismatches.
 *
 * Selector basis (public convention, Grok's DOM is more fluid than the
 * other four):
 *   - User-message marker: [data-testid="message"][data-role="user"]
 *   - charCount sums textContent over user messages only.
 *   - imageCount counts any <img> inside a user message.
 *   - turnCount: zero by construction (per scope).
 *   - videoSeconds: zero by construction (per scope).
 *
 * Pure, idempotent, side-effect-free.
 */

import {
    resolveScope,
    zeroMetrics,
    type DomRoot,
    type ObserverMetrics,
    type ProviderObserver,
} from './types';

const USER_MESSAGE_SELECTOR = '[data-testid="message"][data-role="user"]';

/** See `CLAUDE_OBSERVER_SELECTORS` for rationale. */
export const GROK_OBSERVER_SELECTORS = {
    countTurns: false,
    userCharSource: USER_MESSAGE_SELECTOR,
    image: `${USER_MESSAGE_SELECTOR} img`,
    countVideo: false,
} as const;

export const observeGrok: ProviderObserver = (root: DomRoot): ObserverMetrics => {
    const scope = resolveScope(root);
    if (!scope) return zeroMetrics();

    const userMessages = scope.querySelectorAll(USER_MESSAGE_SELECTOR);
    const images = scope.querySelectorAll(`${USER_MESSAGE_SELECTOR} img`);

    let charCount = 0;
    userMessages.forEach(el => {
        charCount += (el.textContent ?? '').length;
    });

    return {
        turnCount: 0,
        charCount,
        imageCount: images.length,
        videoSeconds: 0,
    };
};
