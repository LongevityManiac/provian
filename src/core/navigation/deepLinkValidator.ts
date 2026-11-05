/**
 * Deep Link Validator
 *
 * [H-6] Validates deep links using proper URL parsing instead of string .includes().
 * All deep link handling in the codebase must go through this function.
 *
 * Prevents spoofing attacks where a malicious URL contains the expected path
 * as a substring.
 *
 * Parsing is hand-rolled (parseDeepLinkParts), NOT `new URL()`: React Native's
 * bundled URL polyfill (Hermes ships no native URL; RN force-installs
 * Blob/URL.js via polyfillGlobal) is anchored to `^https?://` and returns an
 * EMPTY host for custom-scheme URLs (`provian://…`) and even GLUES a stray '/'
 * onto the query of a custom-scheme link that has a fragment. Relying on it
 * silently broke every `provian://` deep link on device (host '' → no match) and
 * corrupted the promise-import ciphertext. The manual parser below behaves
 * identically on device and under the Node test runner, so the tests are
 * faithful to runtime.
 */

export interface ParsedDeepLink {
    scheme: string;
    host: string;
    pathname: string;
    params: Record<string, string>;
    /**
     * Sanitized URL fragment (without the leading '#'). Carries the E2E promise
     * share key (`k=...`) for the promise-import link. The fragment is NEVER
     * sent to a server — callers MUST NOT log it.
     */
    fragment: string;
    /**
     * scheme://host/path ONLY — query AND fragment stripped, so logging rawUrl
     * can never leak the promise key (`k`, fragment) or ciphertext (`d`, query).
     */
    rawUrl: string;
}

// Accepted schemes (without the trailing ':').
const PROVIAN_SCHEME = 'provian';
const HTTPS_SCHEME = 'https';

const VALID_HOSTS = ['app', 'wallet', 'agent', 'link', 'promise', ''];

const PROMISE_IMPORT_HTTPS_HOST = 'provian.ai';
const PROMISE_IMPORT_PATH = '/p';
const PROMISE_IMPORT_HOST = 'promise'; // provian://promise

/** Exact path match, tolerating one trailing slash (the site exports trailingSlash: true). */
function isExactPath(pathname: string, path: string): boolean {
    return pathname === path || pathname === `${path}/`;
}

// The encrypted promise blob can legitimately exceed the default 2KB param cap
// (terms up to 500 chars each → multi-KB ciphertext), so the promise-import link
// gets a larger ceiling. Everything else keeps the tight default.
const DEFAULT_PARAM_MAX = 2048;
const PROMISE_IMPORT_PARAM_MAX = 8192;

// Paths that affect balance and require strict origin validation. Add new
// paths here when introducing balance-affecting deep links.
const BALANCE_AFFECTING_PATHS: string[] = [];

interface DeepLinkParts {
    scheme: string; // lowercased, without ':'
    host: string; // lowercased; userinfo + :port stripped; '' if no authority
    pathname: string; // includes leading '/', or '' when no path
    query: string; // raw, without leading '?'
    fragment: string; // raw, without leading '#'
}

/**
 * Hand-parse a deep link into its components WITHOUT the runtime `URL` (see the
 * module header: RN's URL polyfill mangles non-http(s) schemes). Splits in the
 * canonical order scheme: → fragment(#) → query(?) → //authority/path, and
 * extracts the host by stripping userinfo (everything up to the LAST '@') and a
 * trailing :port — so `https://provian.ai@evil.com/p` resolves to host
 * `evil.com` (rejected), never the trusted host. Returns null when there is no
 * scheme.
 */
function parseDeepLinkParts(url: string): DeepLinkParts | null {
    const trimmed = url.trim();
    const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):/);
    if (!schemeMatch) {
        return null;
    }
    const scheme = schemeMatch[1].toLowerCase();
    let rest = trimmed.slice(schemeMatch[0].length);

    let fragment = '';
    const hashIdx = rest.indexOf('#');
    if (hashIdx !== -1) {
        fragment = rest.slice(hashIdx + 1);
        rest = rest.slice(0, hashIdx);
    }

    let query = '';
    const qIdx = rest.indexOf('?');
    if (qIdx !== -1) {
        query = rest.slice(qIdx + 1);
        rest = rest.slice(0, qIdx);
    }

    let host = '';
    let pathname = '';
    if (rest.startsWith('//')) {
        const authorityAndPath = rest.slice(2);
        const slashIdx = authorityAndPath.indexOf('/');
        const authority = slashIdx === -1 ? authorityAndPath : authorityAndPath.slice(0, slashIdx);
        pathname = slashIdx === -1 ? '' : authorityAndPath.slice(slashIdx);
        const atIdx = authority.lastIndexOf('@');
        const hostPort = atIdx === -1 ? authority : authority.slice(atIdx + 1);
        // Strip a trailing :port. A bracketed IPv6 literal keeps its ':' and so
        // simply won't match the host allowlist (fail closed — IPv6 hosts unused).
        const colonIdx = hostPort.indexOf(':');
        host = (colonIdx === -1 ? hostPort : hostPort.slice(0, colonIdx)).toLowerCase();
    } else {
        // No `//authority` component (e.g. `scheme:/path`); the remainder is path.
        pathname = rest;
    }

    return { scheme, host, pathname, query, fragment };
}

/** Decode one query component, matching URLSearchParams ( '+' → space ), but
 *  fail-soft on malformed percent-encoding (a lone '%') instead of throwing. */
function safeDecodeComponent(value: string): string {
    try {
        return decodeURIComponent(value.replace(/\+/g, ' '));
    } catch {
        return value;
    }
}

/** Parse a raw query string into [key, value] pairs (decoded). */
function parseQueryPairs(query: string): Array<[string, string]> {
    const pairs: Array<[string, string]> = [];
    if (!query) return pairs;
    for (const pair of query.split('&')) {
        if (!pair) continue;
        const eq = pair.indexOf('=');
        const rawKey = eq === -1 ? pair : pair.slice(0, eq);
        const rawVal = eq === -1 ? '' : pair.slice(eq + 1);
        const key = safeDecodeComponent(rawKey);
        if (!key) continue;
        pairs.push([key, safeDecodeComponent(rawVal)]);
    }
    return pairs;
}

/**
 * Validate and parse a deep link URL.
 *
 * Returns a ParsedDeepLink if the URL is valid, or null if it should be rejected.
 *
 * Validates:
 * 1. Scheme is exactly `provian:` (custom) or `https:` (promise import only)
 * 2. Host matches an expected host exactly
 * 3. Pathname is the exact expected path (not just a prefix/substring)
 */
export function deepLinkValidator(url: string): ParsedDeepLink | null {
    if (!url || typeof url !== 'string') {
        return null;
    }

    const parts = parseDeepLinkParts(url);
    if (!parts) {
        return null;
    }
    const { scheme, host, pathname, query, fragment: rawFragment } = parts;
    let isPromiseImport = false;

    if (scheme === PROVIAN_SCHEME) {
        if (!VALID_HOSTS.includes(host)) {
            console.warn(`[DeepLink] Rejected: unknown host "${host}"`);
            return null;
        }
        isPromiseImport = host === PROMISE_IMPORT_HOST;
    } else if (scheme === HTTPS_SCHEME) {
        const promisePath = isExactPath(pathname, PROMISE_IMPORT_PATH);

        if (host !== PROMISE_IMPORT_HTTPS_HOST || !promisePath) {
            console.warn(`[DeepLink] Rejected https link (only ${PROMISE_IMPORT_HTTPS_HOST}${PROMISE_IMPORT_PATH} allowed): host="${host}" path="${pathname}"`);
            return null;
        }
        isPromiseImport = promisePath;
    } else {
        console.warn(`[DeepLink] Rejected: unexpected scheme "${scheme}:"`);
        return null;
    }

    const maxLen = isPromiseImport ? PROMISE_IMPORT_PARAM_MAX : DEFAULT_PARAM_MAX;
    const sanitize = (value: string): string => value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, maxLen);

    // 2. Query params: hand-parsed + decoded (see parseDeepLinkParts on why we do
    //    NOT use the runtime URLSearchParams). [Audit M-8] strip control chars +
    //    length cap. Last value wins for a duplicate key (matches the prior
    //    URLSearchParams.forEach object-assignment behavior).
    const params: Record<string, string> = {};
    for (const [key, value] of parseQueryPairs(query)) {
        params[key] = sanitize(value);
    }

    // 3. Fragment carries the E2E promise key (`k=...`) for the import link; it
    //    never reaches a server and MUST NOT be logged. rawUrl below excludes the
    //    query AND fragment so logging it can leak neither the key nor ciphertext.
    const fragment = sanitize(rawFragment);

    return {
        scheme,
        host,
        pathname,
        params,
        fragment,
        rawUrl: `${scheme}://${host}${pathname}`,
    };
}

/**
 * True iff this parsed link is the E2E-encrypted promise-import link — either the
 * https universal link (provian.ai/p) or the provian://promise fallback. Used by
 * the deep-link handler to route the import without re-deriving the allowlist.
 */
export function isPromiseImportLink(deepLink: ParsedDeepLink): boolean {
    if (deepLink.scheme === 'https') {
        return (
            deepLink.host === PROMISE_IMPORT_HTTPS_HOST &&
            (deepLink.pathname === PROMISE_IMPORT_PATH || deepLink.pathname === `${PROMISE_IMPORT_PATH}/`)
        );
    }
    if (deepLink.scheme === 'provian') {
        return deepLink.host === PROMISE_IMPORT_HOST;
    }
    return false;
}

/**
 * Check if a deep link matches a specific path pattern.
 * Uses startsWith for path matching (not contains).
 */
export function matchesPath(deepLink: ParsedDeepLink, path: string): boolean {
    return deepLink.pathname === path || deepLink.pathname.startsWith(path + '/');
}

/**
 * Check if a deep link affects balance (requires stricter validation).
 */
export function isBalanceAffecting(deepLink: ParsedDeepLink): boolean {
    return BALANCE_AFFECTING_PATHS.some(p => matchesPath(deepLink, p));
}

export default deepLinkValidator;
