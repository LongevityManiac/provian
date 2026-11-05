/**
 * Claude observer. Pure function producing ObserverMetrics from the
 * current claude.ai chat DOM.
 *
 * Selectors in this module are written against synthetic fixtures. Live
 * DOM validation against the current production web app occurs at final
 * release-build smoke test. Selector drift from current provider DOM is
 * expected and will be reconciled in a follow-up patch when the smoke
 * test surfaces mismatches.
 *
 * Selector basis (ai-footprint-lab patterns + public convention):
 *   - Conversation scope: [data-testid="conversation"]
 *   - Turn containers:    [data-testid="user-message"] and
 *                         [data-testid="assistant-message"]
 *   - charCount sums textContent over user turns only, per PE_PROTOCOL_SPEC
 *     guidance that char_count measures user input, not assistant output.
 *   - imageCount counts every <img> inside the conversation scope.
 *   - videoSeconds is zero by construction: Claude does not embed a native
 *     video player in chat today. Revisit if Claude ships video attachments.
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

const CONVERSATION_SELECTOR = '[data-testid="conversation"]';
const USER_TURN_SELECTOR = '[data-testid="user-message"]';
const ASSISTANT_TURN_SELECTOR = '[data-testid="assistant-message"]';
const TURN_SELECTOR = `${USER_TURN_SELECTOR}, ${ASSISTANT_TURN_SELECTOR}`;

/**
 * Observer-side selector set for the Claude surface. Exported so the
 * `observer-injection-parity.test.ts` harness can cross-check it against
 * `SELECTORS_BY_PROVIDER.claude` in `injectedScript.ts`.
 */
export const CLAUDE_OBSERVER_SELECTORS = {
    scope: CONVERSATION_SELECTOR,
    turn: TURN_SELECTOR,
    countTurns: true,
    userCharSource: USER_TURN_SELECTOR,
    image: 'img',
    countVideo: false,
} as const;

export const observeClaude: ProviderObserver = (root: DomRoot): ObserverMetrics => {
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
