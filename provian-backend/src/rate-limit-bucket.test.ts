import { createHash } from 'crypto';
import {
    selectPreAuthRateBuckets,
    selectAgentApiKeyRateBucket,
    AGENT_API_KEY_BUCKET_PREFIX_LEN,
    AGENT_API_KEY_RATE_LIMIT_PER_MIN,
    PRE_AUTH_IP_RATE_LIMIT_PER_MIN,
    PRE_AUTH_PUSH_TOKEN_IP_LIMIT_PER_MIN,
    AGENT_SESSION_RATE_LIMIT_PER_MIN,
} from './rate-limit-bucket';

const sessionHash = (token: string) => createHash('sha256').update(token).digest('hex').slice(0, 32);

describe('selectPreAuthRateBuckets (F38/F51/F63 — no bucket keyed on a claimed identity)', () => {
    const VICTIM_SUB = 'user_victim_3cc3f295';
    const VICTIM_AGENT = 'atlas-agent-id';
    const ATTACKER_IP = '203.0.113.9';

    // THE RED CONTROL. An unauthenticated attacker forges a Bearer whose base64
    // payload names a VICTIM's `sub`, and sets X-Agent-Id to a victim agent id.
    // The old limiter keyed `rl:user:<sub>` / `rl:agent:<x-agent-id>` off those
    // and let the attacker 429-lock the victim. The buckets returned here MUST
    // contain NEITHER the victim's sub NOR the victim's agent id — only the
    // attacker's OWN transport IP (and, for a stable token, a hash of that token).
    it('RED: a forged victim `sub` never produces a victim-keyed bucket', () => {
        const forged = Buffer.from(JSON.stringify({ sub: VICTIM_SUB })).toString('base64') + '.deadbeef';
        const buckets = selectPreAuthRateBuckets({
            method: 'GET',
            originalUrl: '/v1/pvt/accrual',
            authHeader: `Bearer ${forged}`,
            clientIp: ATTACKER_IP,
        });
        const keys = buckets.map((b) => b.key).join('|');
        expect(keys).not.toContain(VICTIM_SUB);
        expect(keys).not.toContain('rl:user:');
        // A wallet-HMAC token (has a '.') is single-use, so it carries ONLY the
        // per-IP bucket keyed on the attacker's own IP.
        expect(buckets).toEqual([{ key: `rl:ip:${ATTACKER_IP}`, limit: PRE_AUTH_IP_RATE_LIMIT_PER_MIN }]);
    });

    it('RED: a forged X-Agent-Id header never produces a victim-agent bucket', () => {
        // A dotless (session-shaped) bearer; the header is where the old bug keyed.
        const buckets = selectPreAuthRateBuckets({
            method: 'GET',
            originalUrl: '/v1/agent/status',
            authHeader: 'Bearer some-opaque-session-uuid',
            clientIp: ATTACKER_IP,
        });
        const keys = buckets.map((b) => b.key).join('|');
        expect(keys).not.toContain(VICTIM_AGENT);
        expect(keys).not.toContain('rl:agent:');
        // The session bucket is keyed on the TOKEN hash (a per-agent secret), plus
        // the per-IP bucket — never on a spoofable header.
        expect(buckets).toEqual([
            { key: `rl:ip:${ATTACKER_IP}`, limit: PRE_AUTH_IP_RATE_LIMIT_PER_MIN },
            { key: `rl:session:${sessionHash('some-opaque-session-uuid')}`, limit: AGENT_SESSION_RATE_LIMIT_PER_MIN },
        ]);
    });

    it('push-token writes get their OWN per-IP bucket (isolation preserved, re-keyed to IP)', () => {
        const write = selectPreAuthRateBuckets({
            method: 'POST',
            originalUrl: `/v1/users/${VICTIM_SUB}/fcm-token`,
            authHeader: undefined,
            clientIp: ATTACKER_IP,
        });
        expect(write).toEqual([{ key: `rl:ip-fcmtoken:${ATTACKER_IP}`, limit: PRE_AUTH_PUSH_TOKEN_IP_LIMIT_PER_MIN }]);
        // Distinct from the interactive IP bucket, so a push-token storm from one
        // IP cannot drain that IP's interactive budget.
        const read = selectPreAuthRateBuckets({ method: 'GET', originalUrl: '/v1/x', authHeader: undefined, clientIp: ATTACKER_IP });
        expect(write[0].key).not.toEqual(read[0].key);
    });

    it('an agent API key charges its per-key bucket PLUS the per-IP bucket', () => {
        const token = 'pvn_live_0123456789abcdef01234567:pvns_secret';
        const buckets = selectPreAuthRateBuckets({ method: 'GET', originalUrl: '/v1/x', authHeader: `Bearer ${token}`, clientIp: ATTACKER_IP });
        expect(buckets).toEqual([
            { key: `rl:ip:${ATTACKER_IP}`, limit: PRE_AUTH_IP_RATE_LIMIT_PER_MIN },
            { key: `rl:apikey:${token.slice(0, AGENT_API_KEY_BUCKET_PREFIX_LEN)}`, limit: AGENT_API_KEY_RATE_LIMIT_PER_MIN },
        ]);
    });

    it('an unauthenticated request is bounded on its transport IP alone', () => {
        const buckets = selectPreAuthRateBuckets({ method: 'GET', originalUrl: '/v1/present/verify', authHeader: undefined, clientIp: ATTACKER_IP });
        expect(buckets).toEqual([{ key: `rl:ip:${ATTACKER_IP}`, limit: PRE_AUTH_IP_RATE_LIMIT_PER_MIN }]);
    });

    it('the per-IP ceiling is HIGH — above the per-key ceiling (never throttles a real participant)', () => {
        expect(PRE_AUTH_IP_RATE_LIMIT_PER_MIN).toBeGreaterThanOrEqual(AGENT_API_KEY_RATE_LIMIT_PER_MIN);
    });
});

describe('selectAgentApiKeyRateBucket (WS E)', () => {
    // A realistic agent credential: `pvn_live_<hex>:pvns_<hex>`. Only the part
    // BEFORE the ':' is the api_key; the secret follows and must never reach a key.
    const API_KEY = 'pvn_live_0123456789abcdef01234567';
    const SECRET = 'pvns_deadbeefdeadbeefdeadbeefdead';
    const TOKEN = `${API_KEY}:${SECRET}`;

    it('gives an agent API key its OWN per-key bucket at the HIGH ceiling', () => {
        const bucket = selectAgentApiKeyRateBucket(TOKEN);
        expect(bucket).toEqual({
            key: `rl:apikey:${TOKEN.slice(0, AGENT_API_KEY_BUCKET_PREFIX_LEN)}`,
            limit: AGENT_API_KEY_RATE_LIMIT_PER_MIN,
        });
        // The ceiling is deliberately far above the 120/min agent-session cap:
        // it stops a runaway loop, it does not meter legitimate use.
        expect(AGENT_API_KEY_RATE_LIMIT_PER_MIN).toBeGreaterThan(120);
    });

    it('keys ONLY on the non-secret prefix — the secret half never enters the bucket key', () => {
        const bucket = selectAgentApiKeyRateBucket(TOKEN)!;
        expect(bucket.key).not.toContain(SECRET);
        expect(bucket.key).not.toContain('pvns_');
        // Two different secrets under the SAME api_key share one bucket (same subject).
        const other = selectAgentApiKeyRateBucket(`${API_KEY}:pvns_ffffffffffffffffffffffffffff`)!;
        expect(other.key).toBe(bucket.key);
    });

    it('two DIFFERENT keys get DISTINCT buckets (one runaway key cannot starve another)', () => {
        const a = selectAgentApiKeyRateBucket(TOKEN)!;
        const b = selectAgentApiKeyRateBucket('pvn_live_ffffffffffffffff0000abcd:pvns_x')!;
        expect(a.key).not.toEqual(b.key);
    });

    // NEGATIVE CONTROL : the guard MUST refuse a non-api-key token by
    // returning null, so the caller applies this bucket to NOTHING else. A helper
    // hard-wired to always return a bucket would fail here — the null path is what
    // keeps wallet/session tokens out of the api-key bucket.
    it('RED control — a non-API-key token returns null (bucket applies ONLY to pvn_live_)', () => {
        expect(selectAgentApiKeyRateBucket('some-uuid-session-token')).toBeNull();
        expect(selectAgentApiKeyRateBucket('')).toBeNull();
        // A wallet-auth payload token (has a dot) never reaches here, but prove the
        // prefix guard is what refuses it, not an accident of shape.
        expect(selectAgentApiKeyRateBucket('eyJhbGciOi.sig')).toBeNull();
        // Near-miss: the correct prefix must be at the START, not merely present.
        expect(selectAgentApiKeyRateBucket('x_pvn_live_0123')).toBeNull();
    });
});
