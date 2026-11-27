/**
 * ChatGPT observer. Pure function producing ObserverMetrics from the
 * current chatgpt.com / chat.openai.com chat DOM.
 *
 * Selectors in this module are written against synthetic fixtures. Live
 * DOM validation against the current production web app occurs at final
 * release-build smoke test. Selector drift from current provider DOM is
 * expected and will be reconciled in a follow-up patch when the smoke
 * test surfaces mismatches.
 *
 * Selector basis (checked against the live page): ChatGPT serves two shapes.
 *   - Signed-in page:     turns are [data-turn-key]; the user's turns carry
 *                         [data-conversation-role="user"].
 *   - Signed-out page:    turns are [data-testid^="conversation-turn-"]; the
 *                         user's carry [data-message-author-role="user"].
 *   - The signed-in page also has a "conversation-turn-location-footer" that
 *     is not a turn, so turn ids ending in "-footer" are excluded.
 *   - charCount sums textContent over user messages only.
 *   - imageCount counts every <img> inside any conversation turn.
 *   - videoSeconds sums finite, positive <video>.duration values over any
 *     native HTMLVideoElement rendered inside turns. DALL-E / Sora rich
 *     media typically render as <img>; native <video> in ChatGPT is rare.
 *
 * Pure, idempotent, side-effect-free.
 */

import {
    resolveScope,
    sumVideoSeconds,
    zeroMetrics,
    type DomRoot,
    type ObserverMetrics,
    type ProviderObserver,
} from './types';

const TURN_SELECTOR = '[data-turn-key], [data-testid^="conversation-turn-"]:not([data-testid$="-footer"])';
const USER_MESSAGE_SELECTOR = '[data-conversation-role="user"], [data-message-author-role="user"]';
const IMAGE_SELECTOR = '[data-turn-key] img, [data-testid^="conversation-turn-"]:not([data-testid$="-footer"]) img';

/** See `CLAUDE_OBSERVER_SELECTORS` for rationale. */
export const CHATGPT_OBSERVER_SELECTORS = {
    turn: TURN_SELECTOR,
    countTurns: true,
    userCharSource: USER_MESSAGE_SELECTOR,
    image: IMAGE_SELECTOR,
    countVideo: true,
} as const;

export const observeChatGPT: ProviderObserver = (root: DomRoot): ObserverMetrics => {
    const scope = resolveScope(root);
    if (!scope) return zeroMetrics();

    const turns = scope.querySelectorAll(TURN_SELECTOR);
    const userMessages = scope.querySelectorAll(USER_MESSAGE_SELECTOR);
    const images = scope.querySelectorAll(IMAGE_SELECTOR);
    const videos = scope.querySelectorAll<HTMLVideoElement>(IMAGE_SELECTOR.replace(/ img/g, ' video'));

    let charCount = 0;
    userMessages.forEach(el => {
        charCount += (el.textContent ?? '').length;
    });

    return {
        turnCount: turns.length,
        charCount,
        imageCount: images.length,
        videoSeconds: sumVideoSeconds(videos),
    };
};
