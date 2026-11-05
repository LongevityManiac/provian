/**
 * Gemini observer. Pure function producing ObserverMetrics from the
 * current gemini.google.com chat DOM.
 *
 * Selectors in this module are written against synthetic fixtures. Live
 * DOM validation against the current production web app occurs at final
 * release-build smoke test. Selector drift from current provider DOM is
 * expected and will be reconciled in a follow-up patch when the smoke
 * test surfaces mismatches.
 *
 * Selector basis (Polymer custom-element convention observed in Gemini):
 *   - user-query       custom element wrapping a user turn
 *   - model-response   custom element wrapping an assistant turn
 *   - turnCount counts the union of the two element types.
 *   - charCount sums textContent over user-query elements only.
 *   - imageCount counts <img> inside user-query or model-response.
 *   - videoSeconds sums <video>.duration from Gemini-rendered video
 *     results (search results occasionally embed video).
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

const USER_TURN_SELECTOR = 'user-query';
const ASSISTANT_TURN_SELECTOR = 'model-response';
const TURN_SELECTOR = `${USER_TURN_SELECTOR}, ${ASSISTANT_TURN_SELECTOR}`;

/** See `CLAUDE_OBSERVER_SELECTORS` for rationale. */
export const GEMINI_OBSERVER_SELECTORS = {
    turn: TURN_SELECTOR,
    countTurns: true,
    userCharSource: USER_TURN_SELECTOR,
    image: `${USER_TURN_SELECTOR} img, ${ASSISTANT_TURN_SELECTOR} img`,
    countVideo: true,
} as const;

export const observeGemini: ProviderObserver = (root: DomRoot): ObserverMetrics => {
    const scope = resolveScope(root);
    if (!scope) return zeroMetrics();

    const turns = scope.querySelectorAll(TURN_SELECTOR);
    const userTurns = scope.querySelectorAll(USER_TURN_SELECTOR);
    const images = scope.querySelectorAll(`${TURN_SELECTOR} img`);
    const videos = scope.querySelectorAll<HTMLVideoElement>(`${TURN_SELECTOR} video`);

    let charCount = 0;
    userTurns.forEach(el => {
        charCount += (el.textContent ?? '').length;
    });

    return {
        turnCount: turns.length,
        charCount,
        imageCount: images.length,
        videoSeconds: sumVideoSeconds(videos),
    };
};
