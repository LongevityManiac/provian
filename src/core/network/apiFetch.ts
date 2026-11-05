/**
 * API-level fetch wrapper, no certificate pinning.
 *
 * Certificate pinning is enforced at the network layer (iOS App Transport
 * Security plus Android Network Security Config), not in JavaScript. This
 * wrapper exists only to provide a single chokepoint for app-level concerns
 * (logging, retries, future instrumentation) without falsely advertising
 * pinning behavior at the call site.
 *
 * If pinning is reintroduced in the future, it should use either:
 * - A custom domain with manually managed certs (controls rotation timing)
 * - Dynamic pinning with OTA update mechanism (expo-updates)
 * - Intermediate CA pinning (longer rotation cycle, wider trust surface)
 */

/**
 * Fetch wrapper for API calls.
 * Drop-in replacement for fetch(), same signature.
 */
export async function apiFetch(
    url: string,
    options: RequestInit = {},
): Promise<Response> {
    return fetch(url, options);
}

export default apiFetch;
