/**
 * Venice observer. Pure function producing ObserverMetrics from the
 * current venice.ai chat DOM.
 *
 * Venice (venice.ai) is a URL-boundary provider: chat sessions live at
 * `venice.ai/c/<id>`, so session accounting comes from the URL session id
 * (see ai-providers.json), not the DOM. This observer behaves like the
 * other four URL-boundary providers and reports turnCount, charCount, and
 * imageCount; videoSeconds is zero by construction because Venice does not
 * embed a native video player in chat today.
 *
 * Selectors in this module are written against synthetic fixtures. Live
 * DOM validation against the current production web app occurs at final
 * release-build smoke test. Selector drift from current provider DOM is
 * expected and will be reconciled in a follow-up patch when the smoke
 * test surfaces mismatches.
 *
 * Selector basis (public convention; Venice's DOM is not yet pinned to a
 * captured fixture):
 *   - Conversation scope: [data-testid="chat-messages"]
 *   - Turn containers:    [data-testid="message-user"] and
 *                         [data-testid="message-assistant"]
 *   - charCount sums textContent over user turns only, per PE_PROTOCOL_SPEC
 *     guidance that char_count measures user input, not assistant output.
 *   - imageCount counts every <img> inside the conversation scope.
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

const CONVERSATION_SELECTOR = '[data-testid="chat-messages"]';
const USER_TURN_SELECTOR = '[data-testid="message-user"]';
const ASSISTANT_TURN_SELECTOR = '[data-testid="message-assistant"]';
const TURN_SELECTOR = `${USER_TURN_SELECTOR}, ${ASSISTANT_TURN_SELECTOR}`;

/**
 * Observer-side selector set for the Venice surface. Exported so the
 * `observer-injection-parity.test.ts` harness can cross-check it against
 * `SELECTORS_BY_PROVIDER.venice` in `injectedScript.ts`.
 */
export const VENICE_OBSERVER_SELECTORS = {
    scope: CONVERSATION_SELECTOR,
    turn: TURN_SELECTOR,
    countTurns: true,
    userCharSource: USER_TURN_SELECTOR,
    image: 'img',
    countVideo: false,
} as const;

export const observeVenice: ProviderObserver = (root: DomRoot): ObserverMetrics => {
    const scope = resolveScope(root, CONVERSATION_SELECTOR);
    if (!scope) return zeroMetrics();

    const turns = scope.querySelectorAll(TURN_SELECTOR);
    const userTurns = scope.querySelectorAll(USER_TURN_SELECTOR);
    const images = scope.querySelectorAll('img');

    let charCount = 0;
    userTurns.forEach(el => {
        charCount += (el.textContent ?? '').length;
    });

    return {
        turnCount: turns.length,
        charCount,
        imageCount: images.length,
        videoSeconds: 0,
    };
};
