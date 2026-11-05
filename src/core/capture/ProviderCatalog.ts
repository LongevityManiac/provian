/**
 * Provider catalog v2: loader, validator, and matchers for the mobile Chat surface.
 *
 * Mirror of `provian-agent-sdk/src/observer/plugins/llm-session/catalog.ts`.
 * Catalog JSON at `src/core/capture/ai-providers.json` is byte-for-byte identical to
 * the desktop copy at `provian-agent-sdk/src/observer/config/ai-providers.json`.
 * A Vitest sync check at `__tests__/catalog-sync.test.ts` enforces identity.
 *
 * Spec of record: docs/PHASE_2B_DESIGN_NOTES.md §6 and docs/PHASE_2C_DESIGN_NOTES.md §4.Q1.
 *
 * Mobile only uses `browser_url_patterns` matching (WebView URL). The
 * `app_bundle_ids` and `process_names` fields are retained for schema parity
 * with desktop so the JSON stays identical across surfaces.
 */

export type SessionBoundaryMode = 'url_session_id' | 'timestamp_gap';

export interface BrowserUrlPattern {
    host: string;
    path_prefix: string;
}

export interface SurfaceMatch {
    app_bundle_ids: string[];
    process_names: string[];
    browser_url_patterns: BrowserUrlPattern[];
}

export interface UrlExtraction {
    regex: string;
    group: number;
}

export interface ProviderEntry {
    provider: string;
    surface_match: SurfaceMatch;
    session_boundary: SessionBoundaryMode;
    session_id_extraction: UrlExtraction | null;
    timestamp_gap_seconds: number | null;
    /**
     * Android package name for the provider's native app. Used by the
     * UsageStats scheduler (Phase 2c M7) to reverse-map a foreground-time
     * window to a provider. Optional: providers without a native Android
     * app omit this field. Verified against Play Store listings; see
     * CAPTURE_ARCHITECTURE.md §6 re-verification cadence.
     */
    android_package_name?: string;
}

export interface ProviderCatalog {
    version: '2';
    providers: ProviderEntry[];
}

export interface CatalogValidationError {
    path: string;
    message: string;
}

export type CatalogValidationResult =
    | { ok: true; catalog: ProviderCatalog }
    | { ok: false; errors: CatalogValidationError[] };

const MIN_TIMESTAMP_GAP_S = 30;
const MAX_TIMESTAMP_GAP_S = 3600;

export function validateCatalog(raw: unknown): CatalogValidationResult {
    const errors: CatalogValidationError[] = [];

    if (!isObject(raw)) {
        return { ok: false, errors: [{ path: '$', message: 'catalog must be an object' }] };
    }

    if (raw.version !== '2') {
        errors.push({ path: '$.version', message: `expected "2", got ${JSON.stringify(raw.version)}` });
    }

    if (!Array.isArray(raw.providers)) {
        errors.push({ path: '$.providers', message: 'must be an array' });
        return { ok: false, errors };
    }

    const providerNames = new Set<string>();

    for (let i = 0; i < raw.providers.length; i++) {
        const entry = raw.providers[i];
        const path = `$.providers[${i}]`;

        if (!isObject(entry)) {
            errors.push({ path, message: 'must be an object' });
            continue;
        }

        if (typeof entry.provider !== 'string' || entry.provider.length === 0) {
            errors.push({ path: `${path}.provider`, message: 'must be a non-empty string' });
        } else if (providerNames.has(entry.provider)) {
            errors.push({ path: `${path}.provider`, message: `duplicate provider name "${entry.provider}"` });
        } else {
            providerNames.add(entry.provider);
        }

        validateSurfaceMatch(entry.surface_match, `${path}.surface_match`, errors);
        validateBoundaryAndExtraction(entry, path, errors);
        if (entry.android_package_name !== undefined) {
            if (typeof entry.android_package_name !== 'string' || entry.android_package_name.length === 0) {
                errors.push({
                    path: `${path}.android_package_name`,
                    message: 'must be a non-empty string when present',
                });
            }
        }
    }

    detectHostPrefixConflicts(raw.providers, errors);

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, catalog: raw as unknown as ProviderCatalog };
}

function validateSurfaceMatch(
    raw: unknown,
    path: string,
    errors: CatalogValidationError[],
): void {
    if (!isObject(raw)) {
        errors.push({ path, message: 'must be an object' });
        return;
    }

    if (!isStringArray(raw.app_bundle_ids)) {
        errors.push({ path: `${path}.app_bundle_ids`, message: 'must be an array of strings' });
    }
    if (!isStringArray(raw.process_names)) {
        errors.push({ path: `${path}.process_names`, message: 'must be an array of strings' });
    }
    if (!Array.isArray(raw.browser_url_patterns)) {
        errors.push({ path: `${path}.browser_url_patterns`, message: 'must be an array' });
        return;
    }
    for (let j = 0; j < raw.browser_url_patterns.length; j++) {
        const p = raw.browser_url_patterns[j];
        const pPath = `${path}.browser_url_patterns[${j}]`;
        if (!isObject(p)) {
            errors.push({ path: pPath, message: 'must be an object' });
            continue;
        }
        if (typeof p.host !== 'string' || p.host.length === 0) {
            errors.push({ path: `${pPath}.host`, message: 'must be a non-empty string' });
        }
        if (typeof p.path_prefix !== 'string') {
            errors.push({ path: `${pPath}.path_prefix`, message: 'must be a string' });
        } else if (p.path_prefix !== '' && !p.path_prefix.startsWith('/')) {
            errors.push({
                path: `${pPath}.path_prefix`,
                message: 'must start with "/" or be empty',
            });
        }
    }
}

function validateBoundaryAndExtraction(
    entry: Record<string, unknown>,
    path: string,
    errors: CatalogValidationError[],
): void {
    const mode = entry.session_boundary;
    if (mode !== 'url_session_id' && mode !== 'timestamp_gap') {
        errors.push({
            path: `${path}.session_boundary`,
            message: 'must be "url_session_id" or "timestamp_gap"',
        });
        return;
    }

    const extraction = entry.session_id_extraction;
    const gap = entry.timestamp_gap_seconds;

    if (mode === 'url_session_id') {
        if (extraction === null || extraction === undefined) {
            errors.push({
                path: `${path}.session_id_extraction`,
                message: 'required when session_boundary is "url_session_id"',
            });
        } else if (!isObject(extraction)) {
            errors.push({ path: `${path}.session_id_extraction`, message: 'must be an object' });
        } else {
            if (typeof extraction.regex !== 'string' || extraction.regex.length === 0) {
                errors.push({
                    path: `${path}.session_id_extraction.regex`,
                    message: 'must be a non-empty string',
                });
            } else {
                try {
                    new RegExp(extraction.regex);
                } catch (e) {
                    errors.push({
                        path: `${path}.session_id_extraction.regex`,
                        message: `invalid regex: ${(e as Error).message}`,
                    });
                }
            }
            if (
                typeof extraction.group !== 'number' ||
                !Number.isInteger(extraction.group) ||
                extraction.group < 1
            ) {
                errors.push({
                    path: `${path}.session_id_extraction.group`,
                    message: 'must be an integer >= 1',
                });
            }
        }
        if (gap !== null && gap !== undefined) {
            errors.push({
                path: `${path}.timestamp_gap_seconds`,
                message: 'must be null when session_boundary is "url_session_id"',
            });
        }
    } else {
        if (extraction !== null && extraction !== undefined) {
            errors.push({
                path: `${path}.session_id_extraction`,
                message: 'must be null when session_boundary is "timestamp_gap"',
            });
        }
        if (typeof gap !== 'number' || !Number.isFinite(gap)) {
            errors.push({
                path: `${path}.timestamp_gap_seconds`,
                message: 'must be a number when session_boundary is "timestamp_gap"',
            });
        } else if (gap < MIN_TIMESTAMP_GAP_S || gap > MAX_TIMESTAMP_GAP_S) {
            errors.push({
                path: `${path}.timestamp_gap_seconds`,
                message: `must be in [${MIN_TIMESTAMP_GAP_S}, ${MAX_TIMESTAMP_GAP_S}]`,
            });
        }
    }
}

function detectHostPrefixConflicts(
    providers: unknown[],
    errors: CatalogValidationError[],
): void {
    interface HostEntry {
        providerIndex: number;
        patternIndex: number;
        host: string;
        pathPrefix: string;
    }
    const entries: HostEntry[] = [];

    for (let i = 0; i < providers.length; i++) {
        const entry = providers[i];
        if (!isObject(entry)) continue;
        const surfaceMatch = entry.surface_match;
        if (!isObject(surfaceMatch)) continue;
        const patterns = surfaceMatch.browser_url_patterns;
        if (!Array.isArray(patterns)) continue;
        for (let j = 0; j < patterns.length; j++) {
            const p = patterns[j];
            if (!isObject(p)) continue;
            if (typeof p.host !== 'string' || typeof p.path_prefix !== 'string') continue;
            entries.push({
                providerIndex: i,
                patternIndex: j,
                host: normalizeHost(p.host),
                pathPrefix: p.path_prefix,
            });
        }
    }

    for (let a = 0; a < entries.length; a++) {
        for (let b = a + 1; b < entries.length; b++) {
            const x = entries[a];
            const y = entries[b];
            if (x.host !== y.host) continue;
            if (x.providerIndex === y.providerIndex) continue;
            if (prefixesConflict(x.pathPrefix, y.pathPrefix)) {
                errors.push({
                    path: `$.providers[${x.providerIndex}].surface_match.browser_url_patterns[${x.patternIndex}]`,
                    message: `conflicts with $.providers[${y.providerIndex}].surface_match.browser_url_patterns[${y.patternIndex}] on host "${x.host}"`,
                });
            }
        }
    }
}

function prefixesConflict(a: string, b: string): boolean {
    const normA = a === '' ? '' : a.replace(/\/$/, '');
    const normB = b === '' ? '' : b.replace(/\/$/, '');
    if (normA === normB) return true;
    if (normA === '' || normB === '') return true;
    if (normA.startsWith(normB + '/') || normB.startsWith(normA + '/')) return true;
    return false;
}

function normalizeHost(host: string): string {
    return host.toLowerCase().replace(/^www\./, '');
}

// --- matchers ---------------------------------------------------------

export function matchUrlToProvider(url: string, catalog: ProviderCatalog): ProviderEntry | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    const host = normalizeHost(parsed.hostname);
    const path = parsed.pathname;

    for (const entry of catalog.providers) {
        for (const pattern of entry.surface_match.browser_url_patterns) {
            if (normalizeHost(pattern.host) !== host) continue;
            if (pattern.path_prefix === '' || pathMatches(path, pattern.path_prefix)) {
                return entry;
            }
        }
    }
    return null;
}

function pathMatches(path: string, prefix: string): boolean {
    if (prefix === '') return true;
    if (path === prefix) return true;
    if (path.startsWith(prefix + '/')) return true;
    return false;
}

export function extractSessionId(url: string, entry: ProviderEntry): string | null {
    if (entry.session_id_extraction === null) return null;
    let re: RegExp;
    try {
        re = new RegExp(entry.session_id_extraction.regex);
    } catch {
        return null;
    }
    const m = re.exec(url);
    if (!m) return null;
    const captured = m[entry.session_id_extraction.group];
    return captured ?? null;
}

export function getProvider(providerId: string, catalog: ProviderCatalog): ProviderEntry | null {
    for (const entry of catalog.providers) {
        if (entry.provider === providerId) return entry;
    }
    return null;
}

/**
 * Initial URL for a provider's WebView. Uses the first browser URL pattern
 * (host plus path prefix) as the landing page. For URL-boundary providers
 * this lands on the provider's chat root; for Grok it lands on `x.com/i/grok`
 * or `grok.com`, whichever is listed first in the catalog.
 */
export function initialUrlFor(entry: ProviderEntry): string {
    const patterns = entry.surface_match.browser_url_patterns;
    if (patterns.length === 0) {
        throw new Error(`provider "${entry.provider}" has no browser_url_patterns`);
    }
    const first = patterns[0];
    const path = first.path_prefix === '' ? '/' : first.path_prefix;
    return `https://${first.host}${path}`;
}

// --- loading ----------------------------------------------------------

/**
 * Load and validate a catalog from a JSON string. Mirrors the desktop
 * loader for symmetry.
 */
export function parseCatalog(json: string): CatalogValidationResult {
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch (e) {
        return {
            ok: false,
            errors: [{ path: '$', message: `invalid JSON: ${(e as Error).message}` }],
        };
    }
    return validateCatalog(raw);
}

// --- utilities --------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
    return Array.isArray(v) && v.every(x => typeof x === 'string');
}
