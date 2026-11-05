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
 * Selector basis (ai-footprint-lab patterns + public convention):
 *   - Turn containers:    [data-testid^="conversation-turn-"]
 *   - User-role marker:   [data-message-author-role="user"]
 *   - Assistant marker:   [data-message-author-role="assistant"]
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

const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
const USER_MESSAGE_SELECTOR = '[data-message-author-role="user"]';

/** See `CLAUDE_OBSERVER_SELECTORS` for rationale. */
export const CHATGPT_OBSERVER_SELECTORS = {
    turn: TURN_SELECTOR,
    countTurns: true,
    userCharSource: USER_MESSAGE_SELECTOR,
    image: `${TURN_SELECTOR} img`,
    countVideo: true,
} as const;

export const observeChatGPT: ProviderObserver = (root: DomRoot): ObserverMetrics => {
    const scope = resolveScope(root);
    if (!scope) return zeroMetrics();

    const turns = scope.querySelectorAll(TURN_SELECTOR);
    const userMessages = scope.querySelectorAll(USER_MESSAGE_SELECTOR);
    const images = scope.querySelectorAll(`${TURN_SELECTOR} img`);
    const videos = scope.querySelectorAll<HTMLVideoElement>(`${TURN_SELECTOR} video`);

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
