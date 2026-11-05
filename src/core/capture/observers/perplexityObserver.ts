/**
 * Perplexity observer. Pure function producing ObserverMetrics from the
 * current perplexity.ai search/thread DOM.
 *
 * Selectors in this module are written against synthetic fixtures. Live
 * DOM validation against the current production web app occurs at final
 * release-build smoke test. Selector drift from current provider DOM is
 * expected and will be reconciled in a follow-up patch when the smoke
 * test surfaces mismatches.
 *
 * Selector basis (ai-footprint-lab patterns + public convention):
 *   - Question container:  [data-testid="thread-question"]
 *   - Answer container:    [data-testid="thread-answer"]
 *   - turnCount counts questions plus answers inside the thread scope.
 *   - charCount sums textContent over questions only (user-authored).
 *   - imageCount counts any <img> inside a question or answer.
 *   - videoSeconds: Perplexity's native video surface is inconsistent.
 *     YouTube embeds render as <iframe>, not <video>, so .duration is
 *     unreachable. Native <video> tags, when present, are summed.
 *     Otherwise videoSeconds is zero by construction. This is documented
 *     here rather than in the observer body to keep the pure function lean.
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

const QUESTION_SELECTOR = '[data-testid="thread-question"]';
const ANSWER_SELECTOR = '[data-testid="thread-answer"]';
const TURN_SELECTOR = `${QUESTION_SELECTOR}, ${ANSWER_SELECTOR}`;

/** See `CLAUDE_OBSERVER_SELECTORS` for rationale. */
export const PERPLEXITY_OBSERVER_SELECTORS = {
    turn: TURN_SELECTOR,
    countTurns: true,
    userCharSource: QUESTION_SELECTOR,
    image: `${QUESTION_SELECTOR} img, ${ANSWER_SELECTOR} img`,
    countVideo: true,
} as const;

export const observePerplexity: ProviderObserver = (root: DomRoot): ObserverMetrics => {
    const scope = resolveScope(root);
    if (!scope) return zeroMetrics();

    const turns = scope.querySelectorAll(TURN_SELECTOR);
    const questions = scope.querySelectorAll(QUESTION_SELECTOR);
    const images = scope.querySelectorAll(`${TURN_SELECTOR} img`);
    const videos = scope.querySelectorAll<HTMLVideoElement>(`${TURN_SELECTOR} video`);

    let charCount = 0;
    questions.forEach(el => {
        charCount += (el.textContent ?? '').length;
    });

    return {
        turnCount: turns.length,
        charCount,
        imageCount: images.length,
        videoSeconds: sumVideoSeconds(videos),
    };
};
