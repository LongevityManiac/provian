/**
 * ProxyConfig - API Proxy Configuration Service
 * ============================================
 *
 * SECURITY FIX: G-1 - Remove API keys from client binary
 *
 * This service defines the mapping of external API services to proxy endpoints
 * on the Provian relay backend. The relay backend holds the actual API keys
 * and forwards requests after authenticating the client.
 *
 * Flow:
 * 1. Client sends request to {RELAY_BASE_URL}/api/proxy/{service}/{path}
 * 2. Client includes its auth token (Bearer token from RelayAPIService)
 * 3. Relay authenticates the client
 * 4. Relay adds the appropriate API key for the external service
 * 5. Relay forwards the request and returns the response
 *
 * Benefits:
 * - API keys never leave the server
 * - Keys can be rotated without app updates
 * - Usage can be monitored and rate-limited per user
 * - Abuse can be tracked back to specific users
 */

import NotificationService from './NotificationService';
import RelayAPIService from './RelayAPIService';
import { apiFetch } from '../core/network/apiFetch';

/**
 * Supported external services that route through the proxy.
 */
export type ProxyService =
    | 'alchemy'       // EVM RPC
    | 'zerox'         // 0x swap aggregator (same-chain EVM; relay sets the 0.25% fee)
    | 'lifi'          // LI.FI (cross-chain; relay sets the 0.25% fee)
    | 'jupiter'       // Jupiter (same-chain Solana; relay sets the 0.25% fee)
    | 'explorer'      // Etherscan-family block explorers
    | 'prices';       // USD price feed (the relay fetches + keeps last-known prices)
// P4-14: 'onramper' removed — Onramper retired as a fiat on-ramp post-Coinbase cutover.

/**
 * Service-specific configuration for proxy routing.
 */
interface ProxyServiceConfig {
    /** Human-readable name for logging */
    name: string;
    /** Base path on the relay proxy (e.g., 'alchemy' -> /api/proxy/alchemy) */
    proxyPath: string;
    /** Whether this service is currently enabled */
    enabled: boolean;
    /** Optional: specific subservices (e.g., 'rpc') */
    subservices?: string[];
}

/**
 * Configuration for all proxied services.
 */
const PROXY_SERVICES: Record<ProxyService, ProxyServiceConfig> = {
    alchemy: {
        name: 'Alchemy',
        proxyPath: 'alchemy',
        enabled: true,
        subservices: ['rpc'],
    },
    zerox: {
        name: '0x Swap',
        proxyPath: 'zerox',
        enabled: true,
    },
    lifi: {
        name: 'LI.FI',
        proxyPath: 'lifi',
        enabled: true,
    },
    jupiter: {
        name: 'Jupiter',
        proxyPath: 'jupiter',
        enabled: true,
    },
    explorer: {
        name: 'Block Explorer',
        proxyPath: 'explorer',
        enabled: true,
    },
    prices: {
        name: 'Price feed',
        proxyPath: 'prices',
        enabled: true,
    },
};

/**
 * Network identifiers for multi-chain services.
 */
export type EVMNetwork = 'eth-mainnet' | 'base-mainnet' | 'arb-mainnet' | 'opt-mainnet'
    | 'eth-sepolia' | 'base-sepolia' | 'arb-sepolia' | 'opt-sepolia';

/**
 * [M-34] Allowlist of proxy services that do not require wallet auth.
 *
 * Empty by default. All current proxied services route through the relay
 * backend which authenticates the client and attaches the upstream API key.
 * Add a service identifier here only if a specific upstream is intentionally
 * anonymous (and the relay endpoint accepts unauthenticated requests).
 */
const NO_AUTH_REQUIRED_SERVICES: ReadonlySet<ProxyService> = new Set();

/**
 * [M-33] Path traversal sentinel patterns. We block both raw `..` and the
 * common URL-encoded forms of `.` and `/`. This is checked before any
 * decoding/normalization on the client side; the relay also re-validates.
 */
const PATH_TRAVERSAL_PATTERNS = [
    '..',
    '%2e',
    '%2E',
    '%2f',
    '%2F',
];

export class ProxyPathTraversalError extends Error {
    readonly code = 'PROXY_PATH_TRAVERSAL';
    readonly offendingPath: string;

    constructor(offendingPath: string) {
        super(`Proxy path rejected: contains path traversal sequence (${offendingPath})`);
        this.name = 'ProxyPathTraversalError';
        this.offendingPath = offendingPath;
    }
}

export class ProxyAuthRequiredError extends Error {
    readonly code = 'PROXY_AUTH_REQUIRED';
    readonly service: ProxyService;

    constructor(service: ProxyService) {
        super(`Proxy request to '${service}' requires wallet auth but no auth token is available`);
        this.name = 'ProxyAuthRequiredError';
        this.service = service;
    }
}

class ProxyConfig {
    private static instance: ProxyConfig;
    private cachedBackendUrl: string | null = null;
    private authSubscriptionInitialized = false;

    private constructor() {}

    static getInstance(): ProxyConfig {
        if (!ProxyConfig.instance) {
            ProxyConfig.instance = new ProxyConfig();
            ProxyConfig.instance.initAuthSubscription();
        }
        return ProxyConfig.instance;
    }

    /**
     * [M-35] Subscribe to wallet auth state changes and clear the cached
     * backend URL on transition. The backend URL is set per-environment
     * (prod/staging/dev) and is normally stable, but a logout/relogin or
     * environment switch should not retain a stale value across users.
     *
     * Lazy import to avoid a static-import cycle (walletStore -> services
     * -> ProxyConfig). The subscription is installed on first getInstance()
     * call, which always happens before any proxy request.
     */
    private initAuthSubscription(): void {
        if (this.authSubscriptionInitialized) return;
        this.authSubscriptionInitialized = true;

        // Fire-and-forget: dynamic import + subscribe. Failures are
        // non-fatal: clearCache() can still be invoked manually.
        void import('../store/walletStore')
            .then(({ useWalletStore }) => {
                let lastIsAuthenticated = useWalletStore.getState().isAuthenticated;
                useWalletStore.subscribe((state) => {
                    if (state.isAuthenticated !== lastIsAuthenticated) {
                        lastIsAuthenticated = state.isAuthenticated;
                        this.clearCache();
                    }
                });
            })
            .catch((err) => {
                console.warn('[ProxyConfig] Failed to subscribe to auth state changes:', err);
            });
    }

    /**
     * Get the relay backend base URL.
     */
    private async getBackendUrl(): Promise<string> {
        if (this.cachedBackendUrl) {
            return this.cachedBackendUrl;
        }
        this.cachedBackendUrl = await NotificationService.getBackendUrl();
        return this.cachedBackendUrl;
    }

    /**
     * Get a freshly-signed wallet auth token for authenticated proxy requests.
     *
     * [BUG FIX] Previously this read from `provian_relay_auth_token` in
     * SecureStore, a key that NOTHING in the codebase ever wrote to. Result:
     * every proxy request went out without an Authorization header, the backend
     * returned 401, and any caller (SwapEngine, etc.) silently fell
     * back to its mock/error path. The wallet auth token actually lives in
     * RelayAPIService and must be re-signed per request because the payload
     * embeds a fresh timestamp.
     */
    private async getAuthToken(
        method: string = 'GET',
        path: string = '/',
        body?: string,
    ): Promise<string | null> {
        return RelayAPIService.getSignedAuthToken(method, path, body);
    }

    /**
     * [M-33] Reject paths that contain path traversal sequences in any form
     * we recognize. The relay validates server-side as the source of truth;
     * this check is defense-in-depth against accidental traversal in caller
     * code and a fast-fail before issuing the request.
     */
    private assertNoPathTraversal(path: string): void {
        for (const pattern of PATH_TRAVERSAL_PATTERNS) {
            if (path.includes(pattern)) {
                throw new ProxyPathTraversalError(path);
            }
        }
    }

    /**
     * Build proxy URL for a service.
     *
     * @param service - The external service to proxy to
     * @param path - The path on the external service (without leading /)
     * @returns The full proxy URL
     */
    async getProxyUrl(service: ProxyService, path: string = ''): Promise<string> {
        const config = PROXY_SERVICES[service];
        if (!config || !config.enabled) {
            throw new Error(`Proxy service '${service}' is not enabled`);
        }

        // [M-33] Validate path before any further processing.
        this.assertNoPathTraversal(path);

        const backendUrl = await this.getBackendUrl();
        const cleanPath = path.startsWith('/') ? path.slice(1) : path;

        return `${backendUrl}/api/proxy/${config.proxyPath}${cleanPath ? `/${cleanPath}` : ''}`;
    }

    /**
     * Get headers for authenticated proxy requests.
     * Pass request details so the auth token is bound to this specific request.
     *
     * [M-34] Fails closed: throws ProxyAuthRequiredError when no auth token
     * is available and the service is not in NO_AUTH_REQUIRED_SERVICES.
     * Previously this silently returned a header set with no Authorization,
     * which caused requests to flow out unauthenticated and hit 401 paths
     * downstream.
     */
    async getProxyHeaders(
        method: string = 'GET',
        proxyPath: string = '/',
        body?: string,
        service?: ProxyService,
    ): Promise<Record<string, string>> {
        const authToken = await this.getAuthToken(method, proxyPath, body);

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        if (authToken) {
            headers['Authorization'] = `Bearer ${authToken}`;
            return headers;
        }

        // No auth token. Allowlist check: if a known service is provided
        // and it's tagged as not requiring auth, proceed without it. Otherwise
        // fail closed.
        if (service && NO_AUTH_REQUIRED_SERVICES.has(service)) {
            return headers;
        }

        throw new ProxyAuthRequiredError(service ?? ('unknown' as ProxyService));
    }

    /**
     * Make an authenticated request through the proxy.
     *
     * @param service - The external service to proxy to
     * @param path - The path on the external service
     * @param options - Fetch options (method, body, etc.)
     * @returns The fetch Response
     */
    async proxyFetch(
        service: ProxyService,
        path: string,
        options: RequestInit = {}
    ): Promise<Response> {
        const url = await this.getProxyUrl(service, path);
        const method = (options.method || 'GET').toUpperCase();
        const bodyStr = typeof options.body === 'string' ? options.body : undefined;
        // Extract the URL path portion for token binding
        const urlPath = new URL(url).pathname;
        const headers = await this.getProxyHeaders(method, urlPath, bodyStr, service);

        // [M-32] Route through apiFetch so all outbound traffic from
        // ProxyConfig flows through the same wrapper as the rest of the
        // wallet-to-relay traffic.
        return apiFetch(url, {
            ...options,
            headers: {
                ...headers,
                ...options.headers,
            },
        });
    }

    // =========================================================================
    // Service-Specific URL Builders
    // =========================================================================

    /**
     * Get proxy URL for Alchemy RPC.
     * Original: https://{network}.g.alchemy.com/v2/{API_KEY}
     * Proxy: {BACKEND}/api/proxy/alchemy/rpc/{network}
     */
    async getAlchemyRpcUrl(network: EVMNetwork): Promise<string> {
        return this.getProxyUrl('alchemy', `rpc/${network}`);
    }

    /**
     * Get proxy URL for Solana JSON-RPC (Alchemy Solana endpoint).
     * Original: https://{solana-mainnet|solana-devnet}.g.alchemy.com/v2/{API_KEY}
     * Proxy: {BACKEND}/api/proxy/alchemy/rpc/{network}
     *
     * Reuses the alchemy proxy service (method-agnostic body forwarding), so
     * Solana rides the same authenticated, keyed, rate-limited relay path as
     * EVM RPC. `network` is a Solana cluster slug, not an EVMNetwork.
     */
    async getSolanaRpcUrl(network: 'solana-mainnet' | 'solana-devnet'): Promise<string> {
        return this.getProxyUrl('alchemy', `rpc/${network}`);
    }

    // P4-14: getOnramperUrl removed — Onramper retired as a fiat on-ramp
    // post-Coinbase cutover (it had zero callers and the backend proxy was
    // removed). Coinbase Onramp opens via the system browser, not this proxy.

    /**
     * Get proxy URL for 0x Swap API (v2 allowance-holder flow).
     * Original: https://api.0x.org/swap/{endpoint} with 0x-api-key + 0x-version:v2 headers
     * Proxy: {BACKEND}/api/proxy/zerox/{endpoint}
     */
    async getZeroXUrl(endpoint: string): Promise<string> {
        return this.getProxyUrl('zerox', endpoint);
    }

    /**
     * Get proxy URL for Etherscan-family block explorers.
     * Original: https://api.etherscan.io/api?apikey={KEY}&... (per-chain)
     * Proxy: {BACKEND}/api/proxy/explorer/{network}?...
     */
    async getExplorerUrl(network: string): Promise<string> {
        return this.getProxyUrl('explorer', network);
    }

    // =========================================================================
    // Utility Methods
    // =========================================================================

    /**
     * Check if a service is enabled.
     */
    isServiceEnabled(service: ProxyService): boolean {
        return PROXY_SERVICES[service]?.enabled ?? false;
    }

    /**
     * Get all enabled services.
     */
    getEnabledServices(): ProxyService[] {
        return (Object.keys(PROXY_SERVICES) as ProxyService[])
            .filter(s => PROXY_SERVICES[s].enabled);
    }

    /**
     * Clear cached backend URL (call on logout or URL change).
     */
    clearCache(): void {
        this.cachedBackendUrl = null;
    }
}

export default ProxyConfig.getInstance();
