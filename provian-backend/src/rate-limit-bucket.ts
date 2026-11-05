/**
 * Pre-auth rate-limit bucket selection for the global `/v1` limiter.
 *
 * WHY THIS SHAPE (F38 / F51 / F63): the limiter runs BEFORE authentication, so
 * it must NEVER key a shared bucket on a CLAIMED, UNVERIFIED identity. The old
 * design keyed `rl:user:<sub>` off the base64 token payload (no HMAC check) and
 * `rl:agent:<x-agent-id>` off a request header — both attacker-choosable, so
 * anyone who knew a victim's user_id / agent_id could send 60–120 req/min under
 * the victim's key and 429-lock the victim out of every /v1 route (including the
 * kill switch). The fix: pre-auth traffic is bounded on the TRANSPORT IP, and
 * the only credential-scoped buckets are keyed on the CREDENTIAL itself (the
 * secret api-key prefix or a hash of the opaque session token) — never on a
 * claimed identity an attacker can spoof.
 *
 * the invariant: on limits: set them HIGH. A limit exists to bound abuse,
 * never to throttle real participants — so the per-IP ceiling sits well above
 * any single legitimate client's rate and only stops one IP from monopolising
 * the shared global bucket.
 *
 * Kept pure + dependency-light so the isolation is unit-testable without booting
 * the server (the middleware in server.ts is not exported).
 */

import { createHash } from 'crypto';

export interface RateBucket {
    /** Redis key for cache.checkRateLimit (paired with a 60s window at the call site). */
    key: string;
    /** Max requests allowed in the window. */
    limit: number;
}

/** Matches `POST /v1/users/:id/fcm-token` (and the canonical `push-token`). */
const PUSH_TOKEN_WRITE_RE = /^\/v1\/users\/[^/]+\/(?:fcm|push)-token$/;

/**
 * Per-IP ceiling for ordinary pre-auth traffic. HIGH by the invariant: * it sits above any single legitimate client's rate (a phone's interactive reads,
 * a heavy agent's polling) and above the per-api-key ceiling below, so it never
 * throttles a real participant — it only stops ONE transport IP from draining
 * the shared global bucket for everyone. Tunable.
 */
export const PRE_AUTH_IP_RATE_LIMIT_PER_MIN = 3000;

/**
 * Per-IP ceiling for push-token (re)registration writes. These get their OWN
 * per-IP bucket so the demonstrated feedback-loop hazard (2026-08-12: an iOS
 * token listener hit 2000+/min) self-throttles WITHOUT draining that IP's
 * interactive budget — the same isolation the old `rl:fcmtoken:<sub>` bucket
 * gave, re-keyed from the forgeable `sub` to the transport IP.
 */
export const PRE_AUTH_PUSH_TOKEN_IP_LIMIT_PER_MIN = 60;

/** Per-session ceiling for agent-session (opaque token) traffic. Unchanged from
 *  the old per-agent 120/min, re-keyed from the forgeable `x-agent-id` header to
 *  a hash of the SESSION TOKEN itself (a per-agent secret an attacker cannot
 *  guess to target a victim). */
export const AGENT_SESSION_RATE_LIMIT_PER_MIN = 120;

/** The stable, NON-secret api_key prefix length used as the per-key bucket
 * discriminator — the same discriminator the agent-key auth middleware keys on.
 * The secret half follows the `:` and never touches the bucket key. */
export const AGENT_API_KEY_BUCKET_PREFIX_LEN = 24;

/**
 * Per-key ceiling for agent API-key auth. HIGH by the invariant: this
 * exists to stop ONE runaway poll loop from starving the shared global bucket, not
 * to meter legitimate use — so it sits well above the 120/min agent-session cap.
 */
export const AGENT_API_KEY_RATE_LIMIT_PER_MIN = 1200;

/**
 * Per-subject bucket for agent API-key auth (`pvn_live_<hex>:pvns_<hex>`). Before
 * such a request carried no x-agent-id and no wallet `sub`, so it fell
 * through to the GLOBAL 500/2s bucket alone — one tight poll loop on a single key
 * could starve the whole network. This gives each key its own bucket, keyed on the
 * stable 24-char api_key prefix (never the secret).
 *
 * Returns `null` for anything that is NOT an agent API key, so the caller applies
 * this bucket ONLY to that path and leaves wallet/agent-session buckets alone. The
 * limiter runs BEFORE auth, so the validated wallet_id is not yet known — the
 * prefix is derivable here with no DB read. The api-key prefix is a SECRET
 * credential half (never published/enumerable), so it is not a victim-targeting
 * vector the way `sub`/`x-agent-id` were.
 */
export function selectAgentApiKeyRateBucket(token: string): RateBucket | null {
    if (!token.startsWith('pvn_live_')) return null;
    return {
        key: `rl:apikey:${token.slice(0, AGENT_API_KEY_BUCKET_PREFIX_LEN)}`,
        limit: AGENT_API_KEY_RATE_LIMIT_PER_MIN,
    };
}

/**
 * The full set of pre-auth buckets a request must clear, in charge order. NONE
 * is keyed on a claimed identity (F38/F51/F63): the transport IP bounds all
 * pre-auth traffic, and the only credential-scoped buckets are keyed on the
 * credential itself.
 *
 * - Every request charges ONE transport-IP bucket: the push-token-write IP
 *   bucket for a push-token registration, the general IP bucket otherwise
 *   (mutually exclusive, so a push-token storm never drains the interactive IP
 *   budget).
 * - A request bearing an agent API key ALSO charges its per-key bucket.
 * - A request bearing an opaque agent SESSION token (a Bearer with no '.') ALSO
 *   charges a bucket keyed on `sha256(token)` — stable per session, unforgeable
 *   as a targeting vector.
 * - A wallet HMAC token (a Bearer containing '.') is SINGLE-USE (fresh jti per
 *   request), so a per-token bucket would never accumulate; it is bounded by the
 *   per-IP bucket alone — and NEVER by the forgeable `sub` it once keyed.
 */
export function selectPreAuthRateBuckets(input: {
    method: string;
    originalUrl: string;
    authHeader: string | undefined;
    clientIp: string;
}): RateBucket[] {
    const ip = input.clientIp || 'unknown';
    const path = input.originalUrl.split('?')[0];
    const buckets: RateBucket[] = [];

    const isPushTokenWrite = input.method === 'POST' && PUSH_TOKEN_WRITE_RE.test(path);
    buckets.push(isPushTokenWrite
        ? { key: `rl:ip-fcmtoken:${ip}`, limit: PRE_AUTH_PUSH_TOKEN_IP_LIMIT_PER_MIN }
        : { key: `rl:ip:${ip}`, limit: PRE_AUTH_IP_RATE_LIMIT_PER_MIN });

    const authHeader = input.authHeader;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice('Bearer '.length);
        const apiKeyBucket = selectAgentApiKeyRateBucket(token);
        if (apiKeyBucket) {
            buckets.push(apiKeyBucket);
        } else if (token.length > 0 && !token.includes('.')) {
            // Opaque agent-session token. Key on its hash — the raw session id is
            // a bearer secret, so it never enters a Redis key directly.
            const tokenHash = createHash('sha256').update(token).digest('hex').slice(0, 32);
            buckets.push({ key: `rl:session:${tokenHash}`, limit: AGENT_SESSION_RATE_LIMIT_PER_MIN });
        }
    }

    return buckets;
}
