/**
 * Unit tests for the mobile provider catalog parser and matchers.
 *
 * Mirrors desktop coverage (provian-agent-sdk/src/observer/plugins/llm-session/catalog.test.ts)
 * on the mobile-relevant subset: validation, URL matching, session ID extraction,
 * host-prefix conflict detection, the initial-URL helper, and the enabled
 * provider list.
 */

import { describe, it, expect } from 'vitest';
import {
    parseCatalog,
    validateCatalog,
    matchUrlToProvider,
    extractSessionId,
    getProvider,
    initialUrlFor,
} from '../ProviderCatalog';
import { PROVIDER_CATALOG, ENABLED_PROVIDERS } from '../catalog';

describe('ProviderCatalog', () => {
    describe('validateCatalog', () => {
        it('accepts the shipped catalog', () => {
            const result = validateCatalog(PROVIDER_CATALOG);
            expect(result.ok).toBe(true);
        });

        it('rejects wrong version', () => {
            const result = validateCatalog({ version: '1', providers: [] });
            expect(result.ok).toBe(false);
        });

        it('rejects missing providers array', () => {
            const result = validateCatalog({ version: '2' });
            expect(result.ok).toBe(false);
        });

        it('rejects url_session_id without session_id_extraction', () => {
            const result = validateCatalog({
                version: '2',
                providers: [
                    {
                        provider: 'x',
                        surface_match: {
                            app_bundle_ids: [],
                            process_names: [],
                            browser_url_patterns: [{ host: 'x.test', path_prefix: '' }],
                        },
                        session_boundary: 'url_session_id',
                        session_id_extraction: null,
                        timestamp_gap_seconds: null,
                    },
                ],
            });
            expect(result.ok).toBe(false);
        });

        it('rejects timestamp_gap outside [30, 3600]', () => {
            const result = validateCatalog({
                version: '2',
                providers: [
                    {
                        provider: 'x',
                        surface_match: {
                            app_bundle_ids: [],
                            process_names: [],
                            browser_url_patterns: [{ host: 'x.test', path_prefix: '' }],
                        },
                        session_boundary: 'timestamp_gap',
                        session_id_extraction: null,
                        timestamp_gap_seconds: 1,
                    },
                ],
            });
            expect(result.ok).toBe(false);
        });

        it('rejects host-prefix conflicts across providers', () => {
            const result = validateCatalog({
                version: '2',
                providers: [
                    {
                        provider: 'a',
                        surface_match: {
                            app_bundle_ids: [],
                            process_names: [],
                            browser_url_patterns: [{ host: 'shared.test', path_prefix: '' }],
                        },
                        session_boundary: 'timestamp_gap',
                        session_id_extraction: null,
                        timestamp_gap_seconds: 300,
                    },
                    {
                        provider: 'b',
                        surface_match: {
                            app_bundle_ids: [],
                            process_names: [],
                            browser_url_patterns: [{ host: 'shared.test', path_prefix: '/sub' }],
                        },
                        session_boundary: 'timestamp_gap',
                        session_id_extraction: null,
                        timestamp_gap_seconds: 300,
                    },
                ],
            });
            expect(result.ok).toBe(false);
        });
    });

    describe('parseCatalog', () => {
        it('parses the shipped JSON', () => {
            const result = parseCatalog(JSON.stringify(PROVIDER_CATALOG));
            expect(result.ok).toBe(true);
        });

        it('returns an error on invalid JSON', () => {
            const result = parseCatalog('{ not json');
            expect(result.ok).toBe(false);
        });
    });

    describe('matchUrlToProvider', () => {
        it('matches claude.ai to claude', () => {
            const entry = matchUrlToProvider('https://claude.ai/chat/abc', PROVIDER_CATALOG);
            expect(entry?.provider).toBe('claude');
        });

        it('matches chatgpt.com and chat.openai.com to chatgpt', () => {
            expect(matchUrlToProvider('https://chatgpt.com/c/abc', PROVIDER_CATALOG)?.provider).toBe('chatgpt');
            expect(matchUrlToProvider('https://chat.openai.com/c/abc', PROVIDER_CATALOG)?.provider).toBe('chatgpt');
        });

        it('matches gemini.google.com to gemini', () => {
            const entry = matchUrlToProvider('https://gemini.google.com/app/abc', PROVIDER_CATALOG);
            expect(entry?.provider).toBe('gemini');
        });

        it('matches perplexity.ai and www.perplexity.ai to perplexity', () => {
            expect(matchUrlToProvider('https://perplexity.ai/search/abc', PROVIDER_CATALOG)?.provider).toBe('perplexity');
            expect(matchUrlToProvider('https://www.perplexity.ai/search/abc', PROVIDER_CATALOG)?.provider).toBe('perplexity');
        });

        it('matches grok.com to grok', () => {
            expect(matchUrlToProvider('https://grok.com/', PROVIDER_CATALOG)?.provider).toBe('grok');
        });

        it('matches x.com/i/grok to grok but NOT x.com/home', () => {
            expect(matchUrlToProvider('https://x.com/i/grok', PROVIDER_CATALOG)?.provider).toBe('grok');
            expect(matchUrlToProvider('https://x.com/i/grok/chat/abc', PROVIDER_CATALOG)?.provider).toBe('grok');
            expect(matchUrlToProvider('https://x.com/home', PROVIDER_CATALOG)).toBeNull();
        });

        it('matches venice.ai to venice', () => {
            expect(matchUrlToProvider('https://venice.ai/c/web-ui-gen', PROVIDER_CATALOG)?.provider).toBe('venice');
        });

        it('returns null for unknown URLs', () => {
            expect(matchUrlToProvider('https://example.com/', PROVIDER_CATALOG)).toBeNull();
        });

        it('returns null for malformed URLs', () => {
            expect(matchUrlToProvider('not-a-url', PROVIDER_CATALOG)).toBeNull();
        });
    });

    describe('extractSessionId', () => {
        it('extracts Claude session IDs', () => {
            const claude = getProvider('claude', PROVIDER_CATALOG)!;
            expect(extractSessionId('https://claude.ai/chat/550e8400-e29b-41d4-a716-446655440000', claude))
                .toBe('550e8400-e29b-41d4-a716-446655440000');
        });

        it('returns null for Grok (no extraction pattern)', () => {
            const grok = getProvider('grok', PROVIDER_CATALOG)!;
            expect(extractSessionId('https://grok.com/chat/whatever', grok)).toBeNull();
        });

        it('returns null when URL does not match the regex', () => {
            const claude = getProvider('claude', PROVIDER_CATALOG)!;
            expect(extractSessionId('https://claude.ai/settings', claude)).toBeNull();
        });

        it('extracts Venice session IDs from venice.ai/c/<id>', () => {
            const venice = getProvider('venice', PROVIDER_CATALOG)!;
            expect(extractSessionId('https://venice.ai/c/web-ui-gen', venice)).toBe('web-ui-gen');
        });
    });

    describe('initialUrlFor', () => {
        it('returns a well-formed starting URL for each enabled provider', () => {
            for (const providerId of ENABLED_PROVIDERS) {
                const entry = getProvider(providerId, PROVIDER_CATALOG)!;
                const url = initialUrlFor(entry);
                expect(() => new URL(url)).not.toThrow();
                expect(url.startsWith('https://')).toBe(true);
            }
        });
    });

    describe('catalog module side effects', () => {
        it('PROVIDER_CATALOG loads the launch providers', () => {
            const providers = PROVIDER_CATALOG.providers.map(p => p.provider).sort();
            expect(providers).toEqual(['chatgpt', 'claude', 'gemini', 'grok', 'perplexity', 'venice']);
        });

        it('ENABLED_PROVIDERS includes all launch providers (M2 adds grok, venice joins)', () => {
            expect([...ENABLED_PROVIDERS].sort()).toEqual([
                'chatgpt',
                'claude',
                'gemini',
                'grok',
                'perplexity',
                'venice',
            ]);
        });
    });
});
