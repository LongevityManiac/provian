/**
 * Provider observer registry.
 *
 * Maps provider IDs (as used in ai-providers.json) to the corresponding
 * pure ProviderObserver function. Consumers in the WebView layer resolve
 * an observer by ID at injection time.
 */

export type { DomRoot, ObserverMetrics, ProviderObserver } from './types';
export { ZERO_METRICS, runObserverSafely, resolveScope, zeroMetrics, sumVideoSeconds } from './types';

import type { ProviderObserver } from './types';
import { observeClaude } from './claudeObserver';
import { observeChatGPT } from './chatgptObserver';
import { observeGemini } from './geminiObserver';
import { observePerplexity } from './perplexityObserver';
import { observeGrok } from './grokObserver';
import { observeVenice } from './veniceObserver';

export { observeClaude, observeChatGPT, observeGemini, observePerplexity, observeGrok, observeVenice };

export const OBSERVERS: Readonly<Record<string, ProviderObserver>> = Object.freeze({
    claude: observeClaude,
    chatgpt: observeChatGPT,
    gemini: observeGemini,
    perplexity: observePerplexity,
    grok: observeGrok,
    venice: observeVenice,
});

export function getObserver(providerId: string): ProviderObserver | null {
    return OBSERVERS[providerId] ?? null;
}
