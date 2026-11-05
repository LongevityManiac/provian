/**
 * Runtime catalog loader for the mobile Chat surface.
 *
 * Metro bundles JSON imports by default. The catalog is parsed and validated
 * at module load time so malformed catalogs fail fast during app boot rather
 * than at first Chat tab use.
 */

import rawCatalog from './ai-providers.json';
import { parseCatalog } from './ProviderCatalog';
import type { ProviderCatalog } from './ProviderCatalog';

function loadCatalogOrThrow(): ProviderCatalog {
    const result = parseCatalog(JSON.stringify(rawCatalog));
    if (!result.ok) {
        const summary = result.errors
            .slice(0, 5)
            .map(e => `${e.path}: ${e.message}`)
            .join('; ');
        throw new Error(
            `[ProviderCatalog] ai-providers.json failed validation: ${summary}`,
        );
    }
    return result.catalog;
}

export const PROVIDER_CATALOG: ProviderCatalog = loadCatalogOrThrow();

/**
 * Provider IDs enabled for the Chat tab.
 *
 * M1 shipped the four URL-boundary providers. M2 adds Grok alongside them;
 * Grok's timestamp-gap session boundary detector lives in
 * `GrokSessionBoundary.ts` and is wired into the full session state machine
 * in M3. Venice (venice.ai) joins as a URL-boundary provider; its chat
 * sessions live at `venice.ai/c/<id>`.
 */
export const ENABLED_PROVIDERS: readonly string[] = [
    'claude',
    'chatgpt',
    'gemini',
    'perplexity',
    'grok',
    'venice',
] as const;
