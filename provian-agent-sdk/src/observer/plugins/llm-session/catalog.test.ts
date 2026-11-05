import { describe, it, expect } from 'vitest';
import {
  validateCatalog,
  parseCatalog,
  matchUrlToProvider,
  matchBundleIdToProvider,
  matchProcessNameToProvider,
  extractSessionId,
  type ProviderCatalog,
  type ProviderEntry,
} from './catalog';
// Importing the JSON directly validates it loads under resolveJsonModule.
import goldenRaw from '../../config/ai-providers.json';

function urlEntry(overrides: Partial<ProviderEntry> = {}): ProviderEntry {
  return {
    provider: 'test',
    surface_match: {
      app_bundle_ids: [],
      process_names: [],
      browser_url_patterns: [{ host: 'example.com', path_prefix: '' }],
    },
    session_boundary: 'url_session_id',
    session_id_extraction: { regex: '^https://example\\.com/c/([a-z0-9]+)', group: 1 },
    timestamp_gap_seconds: null,
    ...overrides,
  };
}

function gapEntry(overrides: Partial<ProviderEntry> = {}): ProviderEntry {
  return {
    provider: 'test_gap',
    surface_match: {
      app_bundle_ids: [],
      process_names: [],
      browser_url_patterns: [{ host: 'other.com', path_prefix: '' }],
    },
    session_boundary: 'timestamp_gap',
    session_id_extraction: null,
    timestamp_gap_seconds: 300,
    ...overrides,
  };
}

describe('validateCatalog: golden catalog', () => {
  it('loads and validates the shipped ai-providers.json', () => {
    const result = validateCatalog(goldenRaw);
    if (!result.ok) {
      throw new Error(`golden catalog invalid:\n${JSON.stringify(result.errors, null, 2)}`);
    }
    expect(result.ok).toBe(true);
    expect(result.catalog.version).toBe('2');
    expect(result.catalog.providers.map(p => p.provider)).toEqual([
      'claude', 'chatgpt', 'gemini', 'perplexity', 'grok', 'venice',
    ]);
  });

  it('has grok configured as timestamp_gap with 300s', () => {
    const result = validateCatalog(goldenRaw);
    if (!result.ok) throw new Error('golden invalid');
    const grok = result.catalog.providers.find(p => p.provider === 'grok');
    expect(grok).toBeDefined();
    expect(grok!.session_boundary).toBe('timestamp_gap');
    expect(grok!.timestamp_gap_seconds).toBe(300);
    expect(grok!.session_id_extraction).toBeNull();
  });

  it('has the four url-session providers with session_id_extraction populated', () => {
    const result = validateCatalog(goldenRaw);
    if (!result.ok) throw new Error('golden invalid');
    for (const name of ['claude', 'chatgpt', 'gemini', 'perplexity']) {
      const p = result.catalog.providers.find(x => x.provider === name);
      expect(p?.session_boundary).toBe('url_session_id');
      expect(p?.session_id_extraction).not.toBeNull();
      expect(p?.timestamp_gap_seconds).toBeNull();
    }
  });
});

describe('validateCatalog: structural errors', () => {
  it('rejects non-object input', () => {
    const r = validateCatalog([]);
    expect(r.ok).toBe(false);
  });

  it('rejects wrong version', () => {
    const r = validateCatalog({ version: '1', providers: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.path === '$.version')).toBe(true);
  });

  it('rejects missing providers array', () => {
    const r = validateCatalog({ version: '2' });
    expect(r.ok).toBe(false);
  });

  it('rejects duplicate provider names', () => {
    const r = validateCatalog({
      version: '2',
      providers: [urlEntry({ provider: 'dup' }), urlEntry({
        provider: 'dup',
        surface_match: { app_bundle_ids: [], process_names: [], browser_url_patterns: [{ host: 'other.com', path_prefix: '' }] },
      })],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.message.includes('duplicate'))).toBe(true);
  });

  it('rejects path_prefix that does not start with /', () => {
    const r = validateCatalog({
      version: '2',
      providers: [urlEntry({
        surface_match: {
          app_bundle_ids: [], process_names: [],
          browser_url_patterns: [{ host: 'example.com', path_prefix: 'foo' }],
        },
      })],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.message.includes('start with "/"'))).toBe(true);
  });

  it('accepts empty path_prefix', () => {
    const r = validateCatalog({
      version: '2',
      providers: [urlEntry({
        surface_match: {
          app_bundle_ids: [], process_names: [],
          browser_url_patterns: [{ host: 'example.com', path_prefix: '' }],
        },
      })],
    });
    expect(r.ok).toBe(true);
  });
});

describe('validateCatalog: session_boundary invariants', () => {
  it('rejects url_session_id without session_id_extraction', () => {
    const r = validateCatalog({
      version: '2',
      providers: [urlEntry({ session_id_extraction: null })],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects url_session_id with timestamp_gap_seconds set', () => {
    const r = validateCatalog({
      version: '2',
      providers: [urlEntry({ timestamp_gap_seconds: 300 })],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects timestamp_gap with session_id_extraction set', () => {
    const r = validateCatalog({
      version: '2',
      providers: [gapEntry({ session_id_extraction: { regex: '.*', group: 1 } })],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects timestamp_gap without timestamp_gap_seconds', () => {
    const r = validateCatalog({
      version: '2',
      providers: [gapEntry({ timestamp_gap_seconds: null })],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects timestamp_gap below range', () => {
    const r = validateCatalog({
      version: '2',
      providers: [gapEntry({ timestamp_gap_seconds: 29 })],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects timestamp_gap above range', () => {
    const r = validateCatalog({
      version: '2',
      providers: [gapEntry({ timestamp_gap_seconds: 3601 })],
    });
    expect(r.ok).toBe(false);
  });

  it('accepts timestamp_gap at range boundaries', () => {
    expect(validateCatalog({
      version: '2',
      providers: [gapEntry({ timestamp_gap_seconds: 30 })],
    }).ok).toBe(true);
    expect(validateCatalog({
      version: '2',
      providers: [gapEntry({ timestamp_gap_seconds: 3600, provider: 'gap2', surface_match: { app_bundle_ids: [], process_names: [], browser_url_patterns: [{ host: 'other2.com', path_prefix: '' }] } })],
    }).ok).toBe(true);
  });

  it('rejects invalid regex in session_id_extraction', () => {
    const r = validateCatalog({
      version: '2',
      providers: [urlEntry({ session_id_extraction: { regex: '[unclosed', group: 1 } })],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects group < 1', () => {
    const r = validateCatalog({
      version: '2',
      providers: [urlEntry({ session_id_extraction: { regex: '.*', group: 0 } })],
    });
    expect(r.ok).toBe(false);
  });
});

describe('validateCatalog: host/path conflict detection', () => {
  it('rejects two providers with same host and overlapping empty prefix', () => {
    const r = validateCatalog({
      version: '2',
      providers: [
        urlEntry({
          provider: 'a',
          surface_match: { app_bundle_ids: [], process_names: [], browser_url_patterns: [{ host: 'shared.com', path_prefix: '' }] },
        }),
        urlEntry({
          provider: 'b',
          surface_match: { app_bundle_ids: [], process_names: [], browser_url_patterns: [{ host: 'shared.com', path_prefix: '/foo' }] },
        }),
      ],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects two providers with one prefix contained in the other', () => {
    const r = validateCatalog({
      version: '2',
      providers: [
        urlEntry({
          provider: 'a',
          surface_match: { app_bundle_ids: [], process_names: [], browser_url_patterns: [{ host: 'shared.com', path_prefix: '/foo' }] },
        }),
        urlEntry({
          provider: 'b',
          surface_match: { app_bundle_ids: [], process_names: [], browser_url_patterns: [{ host: 'shared.com', path_prefix: '/foo/bar' }] },
        }),
      ],
    });
    expect(r.ok).toBe(false);
  });

  it('accepts two providers with same host but sibling prefixes', () => {
    const r = validateCatalog({
      version: '2',
      providers: [
        urlEntry({
          provider: 'a',
          surface_match: { app_bundle_ids: [], process_names: [], browser_url_patterns: [{ host: 'shared.com', path_prefix: '/foo' }] },
        }),
        urlEntry({
          provider: 'b',
          surface_match: { app_bundle_ids: [], process_names: [], browser_url_patterns: [{ host: 'shared.com', path_prefix: '/bar' }] },
        }),
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('allows a single provider to list multiple patterns for the same host', () => {
    const r = validateCatalog({
      version: '2',
      providers: [
        urlEntry({
          provider: 'a',
          surface_match: {
            app_bundle_ids: [], process_names: [],
            browser_url_patterns: [
              { host: 'dup.com', path_prefix: '' },
              { host: 'dup.com', path_prefix: '/x' },
            ],
          },
        }),
      ],
    });
    expect(r.ok).toBe(true);
  });
});

describe('parseCatalog', () => {
  it('returns error on invalid JSON', () => {
    const r = parseCatalog('{not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].message).toContain('invalid JSON');
  });

  it('round-trips the golden catalog', () => {
    const r = parseCatalog(JSON.stringify(goldenRaw));
    expect(r.ok).toBe(true);
  });
});

describe('matchUrlToProvider', () => {
  const catalog = validateCatalog(goldenRaw);
  if (!catalog.ok) throw new Error('golden invalid');
  const c = catalog.catalog;

  it('matches claude.ai', () => {
    expect(matchUrlToProvider('https://claude.ai/chat/abc-123', c)?.provider).toBe('claude');
  });

  it('matches chat.openai.com and chatgpt.com', () => {
    expect(matchUrlToProvider('https://chat.openai.com/c/abc-123', c)?.provider).toBe('chatgpt');
    expect(matchUrlToProvider('https://chatgpt.com/c/abc-123', c)?.provider).toBe('chatgpt');
  });

  it('matches gemini.google.com', () => {
    expect(matchUrlToProvider('https://gemini.google.com/app/abc-123', c)?.provider).toBe('gemini');
  });

  it('matches perplexity.ai with and without www', () => {
    expect(matchUrlToProvider('https://perplexity.ai/search/abc-123', c)?.provider).toBe('perplexity');
    expect(matchUrlToProvider('https://www.perplexity.ai/search/abc-123', c)?.provider).toBe('perplexity');
  });

  it('matches grok.com', () => {
    expect(matchUrlToProvider('https://grok.com/chat/new', c)?.provider).toBe('grok');
  });

  it('matches venice.ai', () => {
    expect(matchUrlToProvider('https://venice.ai/c/web-ui-gen', c)?.provider).toBe('venice');
  });

  it('matches x.com/i/grok for Grok', () => {
    expect(matchUrlToProvider('https://x.com/i/grok', c)?.provider).toBe('grok');
    expect(matchUrlToProvider('https://x.com/i/grok/some-session', c)?.provider).toBe('grok');
  });

  it('does NOT match x.com/home as Grok (path-scope false-positive guard)', () => {
    expect(matchUrlToProvider('https://x.com/home', c)).toBeNull();
    expect(matchUrlToProvider('https://x.com/user/status/123', c)).toBeNull();
  });

  it('returns null for URLs not in the catalog', () => {
    expect(matchUrlToProvider('https://example.com/', c)).toBeNull();
  });

  it('returns null for malformed URLs', () => {
    expect(matchUrlToProvider('not a url', c)).toBeNull();
  });
});

describe('matchBundleIdToProvider and matchProcessNameToProvider', () => {
  const catalog = validateCatalog(goldenRaw);
  if (!catalog.ok) throw new Error('golden invalid');
  const c = catalog.catalog;

  it('matches Claude bundle ID', () => {
    expect(matchBundleIdToProvider('ai.anthropic.claude', c)?.provider).toBe('claude');
  });

  it('matches ChatGPT bundle ID', () => {
    expect(matchBundleIdToProvider('com.openai.chat', c)?.provider).toBe('chatgpt');
  });

  it('matches Perplexity bundle ID', () => {
    expect(matchBundleIdToProvider('ai.perplexity.mac', c)?.provider).toBe('perplexity');
  });

  it('returns null for unknown bundle ID', () => {
    expect(matchBundleIdToProvider('com.example.other', c)).toBeNull();
  });

  it('matches process names for native apps', () => {
    expect(matchProcessNameToProvider('Claude', c)?.provider).toBe('claude');
    expect(matchProcessNameToProvider('ChatGPT', c)?.provider).toBe('chatgpt');
    expect(matchProcessNameToProvider('Perplexity', c)?.provider).toBe('perplexity');
  });

  it('does not match Gemini or Grok by process name (web-only per catalog)', () => {
    expect(matchProcessNameToProvider('Gemini', c)).toBeNull();
    expect(matchProcessNameToProvider('Grok', c)).toBeNull();
  });
});

describe('extractSessionId', () => {
  const catalog = validateCatalog(goldenRaw);
  if (!catalog.ok) throw new Error('golden invalid');
  const c = catalog.catalog;
  const claude = c.providers.find(p => p.provider === 'claude')!;
  const chatgpt = c.providers.find(p => p.provider === 'chatgpt')!;
  const gemini = c.providers.find(p => p.provider === 'gemini')!;
  const perplexity = c.providers.find(p => p.provider === 'perplexity')!;
  const grok = c.providers.find(p => p.provider === 'grok')!;
  const venice = c.providers.find(p => p.provider === 'venice')!;

  it('extracts Claude UUIDs', () => {
    expect(extractSessionId('https://claude.ai/chat/abc123-def4-5678-90ab-cdef01234567', claude))
      .toBe('abc123-def4-5678-90ab-cdef01234567');
  });

  it('extracts ChatGPT session IDs', () => {
    expect(extractSessionId('https://chatgpt.com/c/aaaa-bbbb-cccc', chatgpt)).toBe('aaaa-bbbb-cccc');
    expect(extractSessionId('https://chat.openai.com/c/abcd', chatgpt)).toBe('abcd');
  });

  it('extracts Gemini session IDs with hyphens', () => {
    expect(extractSessionId('https://gemini.google.com/app/abc-def-123', gemini)).toBe('abc-def-123');
  });

  it('extracts Perplexity search slugs', () => {
    expect(extractSessionId('https://www.perplexity.ai/search/my-query-slug', perplexity)).toBe('my-query-slug');
    expect(extractSessionId('https://perplexity.ai/search/other-slug', perplexity)).toBe('other-slug');
  });

  it('returns null for Grok (no extraction configured)', () => {
    expect(extractSessionId('https://grok.com/chat/anything', grok)).toBeNull();
  });

  it('extracts Venice session slugs', () => {
    expect(extractSessionId('https://venice.ai/c/web-ui-gen', venice)).toBe('web-ui-gen');
  });

  it('returns null when URL does not match the provider regex', () => {
    expect(extractSessionId('https://claude.ai/settings', claude)).toBeNull();
  });

  it('returns null when URL does not include a session ID', () => {
    expect(extractSessionId('https://claude.ai/chat/', claude)).toBeNull();
  });
});

describe('catalog: structural type exports', () => {
  it('ProviderCatalog type accepts valid entries', () => {
    const c: ProviderCatalog = {
      version: '2',
      providers: [
        {
          provider: 'foo',
          surface_match: { app_bundle_ids: [], process_names: [], browser_url_patterns: [] },
          session_boundary: 'timestamp_gap',
          session_id_extraction: null,
          timestamp_gap_seconds: 300,
        },
      ],
    };
    expect(c.providers).toHaveLength(1);
  });
});
