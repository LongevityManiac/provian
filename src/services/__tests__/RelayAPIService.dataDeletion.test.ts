/**
 * Delete All Data — the relay request (2026-10-23 close-out, ).
 *
 * `requestDataDeletion` sends `DELETE /v1/user/data` under wallet auth: a request-bound v2 token
 * signed with this device's relay secret, sent BEFORE the local wipe. This suite checks:
 *  - the token verifies the way the relay's verifier does (HMAC-SHA256 over the payload with the
 *    account's secret, then method, path and body-hash binding, subject, device and expiry). The app
 *    token shape itself is bound to the real relay verifier by the backend's
 *    `wallet-auth.client-conformance.test.ts`; importing the backend verifier here would pull
 *    backend-only modules into the app's type program;
 *  - each relay answer maps to its `DataDeletionOutcome`, and a timeout or network error is
 *    `unknown` (the relay may have finished), never "nothing deleted";
 *  - NO credential recovery ever runs on this path: a 401 is read, not retried. A recovery for a
 *    deleted account would find no owner and create a fresh one, orphaning the old data;
 *  - the "account gone" 401 text is the relay's own (`wallet-auth.ts`), read from its source.
 *
 * RED controls (in-suite): the same token fails under another secret and another path; a 401 with
 * any other error is `no_access`, not `account_gone`. Approval checks are mocked to pass, so only
 * the path's own `retryOnAuth = false` keeps recovery out. By hand (2026-10-23): with `retryOnAuth`
 * left at its default (`true`), the two 401 tests fail (the recovery spy is called).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../NotificationService', () => ({
    default: { getBackendUrl: async () => 'https://relay.test', getPushToken: async () => null },
}));
vi.mock('../../core/network/apiFetch', () => ({ apiFetch: vi.fn(), default: vi.fn() }));
vi.mock('../../store/walletStore', () => ({ useWalletStore: { getState: () => ({ address: '0x' + '11'.repeat(20) }) } }));
// Every approval check passes, so the ONLY thing that can keep a recovery from running on this path
// is the path itself (it sends with retryOnAuth = false), not a missing biometric approval.
vi.mock('../../core/security/biometricAction', () => ({
    assertBiometricAction: () => undefined,
    isBiometricActionValid: () => true,
    withBiometricAction: async (_reason: string, fn: (a: unknown) => Promise<unknown>) => fn({ nativeId: null }),
}));

import RelayAPIService, { RELAY_AUTH_RECORD_GONE_ERROR } from '../RelayAPIService';
import { apiFetch } from '../../core/network/apiFetch';

const SECRET = 'device-relay-secret';
const USER = 'user_deletion_fixture';
const DEVICE = 'device_0123456789abcdef0123456789abcdef';

const svc = RelayAPIService as unknown as {
    getAuthSecret(): Promise<string | null>; getUserId(): Promise<string | null>; getDeviceId(): Promise<string>;
    recoverRelayCredentials(...args: unknown[]): Promise<unknown>; registerUser(...args: unknown[]): Promise<unknown>;
};
const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;

type Verdict = { ok: true; userId: string; deviceId: string } | { ok: false; error: string };

/** The relay verifier's checks, in its order (wallet-auth.ts verifyWalletAuthTokenWithBinding). */
function verifyLikeRelay(token: string, binding: { method: string; path: string; bodyHash: string }, secret: string): Verdict {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return { ok: false, error: 'Invalid token format' };
    const payloadB64 = token.slice(0, dot), sig = token.slice(dot + 1);
    const p = JSON.parse(Buffer.from(payloadB64, 'base64').toString()) as Record<string, unknown>;
    if (!p.sub || !p.jti || !p.mth || !p.pth || !p.bh || !p.device_id) return { ok: false, error: 'Incomplete token payload' };
    if (typeof p.exp !== 'number' || Date.now() > p.exp || p.exp - Date.now() > 15 * 60 * 1000) return { ok: false, error: 'Token expiry' };
    const expected = createHmac('sha256', secret).update(payloadB64).digest('hex');
    if (!/^[0-9a-f]{64}$/.test(sig) || !timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return { ok: false, error: 'Invalid token signature' };
    if (p.mth !== binding.method) return { ok: false, error: 'Token method mismatch' };
    if (String(p.pth).replace(/\/+$/, '').toLowerCase() !== binding.path.replace(/\/+$/, '').toLowerCase()) return { ok: false, error: 'Token path mismatch' };
    if (p.bh !== binding.bodyHash) return { ok: false, error: 'Token body hash mismatch' };
    return { ok: true, userId: String(p.sub), deviceId: String(p.device_id) };
}

function answer(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const EMPTY_BODY_HASH = createHash('sha256').update('').digest('hex');

describe('RelayAPIService.requestDataDeletion', () => {
    let recover: ReturnType<typeof vi.fn>;
    let register: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        vi.restoreAllMocks();
        fetchMock.mockReset();
        vi.spyOn(svc, 'getAuthSecret').mockResolvedValue(SECRET);
        vi.spyOn(svc, 'getUserId').mockResolvedValue(USER);
        vi.spyOn(svc, 'getDeviceId').mockResolvedValue(DEVICE);
        recover = vi.spyOn(svc, 'recoverRelayCredentials').mockResolvedValue({}) as unknown as ReturnType<typeof vi.fn>;
        register = vi.spyOn(svc, 'registerUser').mockResolvedValue({}) as unknown as ReturnType<typeof vi.fn>;
    });

    it('sends DELETE /v1/user/data with a token that verifies for that exact request; 200 → deleted', async () => {
        fetchMock.mockResolvedValue(answer(200, { deleted: 7 }));
        expect(await RelayAPIService.requestDataDeletion()).toBe('deleted');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://relay.test/v1/user/data');
        expect(init.method).toBe('DELETE');
        const token = new Headers(init.headers).get('authorization')!.slice('Bearer '.length);
        expect(verifyLikeRelay(token, { method: 'DELETE', path: '/v1/user/data', bodyHash: EMPTY_BODY_HASH }, SECRET))
            .toEqual({ ok: true, userId: USER, deviceId: DEVICE });
        // RED: the same token fails under another secret or another path.
        expect(verifyLikeRelay(token, { method: 'DELETE', path: '/v1/user/data', bodyHash: EMPTY_BODY_HASH }, 'another-secret'))
            .toMatchObject({ ok: false, error: 'Invalid token signature' });
        expect(verifyLikeRelay(token, { method: 'DELETE', path: '/v1/user/devices', bodyHash: EMPTY_BODY_HASH }, SECRET))
            .toMatchObject({ ok: false, error: 'Token path mismatch' });
    });

    it('a 401 for a gone authentication record → account_gone, and NO recovery or registration runs', async () => {
        fetchMock.mockResolvedValue(answer(401, { error: RELAY_AUTH_RECORD_GONE_ERROR }));
        expect(await RelayAPIService.requestDataDeletion()).toBe('account_gone');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(recover).not.toHaveBeenCalled();
        expect(register).not.toHaveBeenCalled();
    });

    it('RED: a 401 for any other reason (e.g. a rotated secret) → no_access, and still never recovers', async () => {
        fetchMock.mockResolvedValue(answer(401, { error: 'Invalid token signature' }));
        expect(await RelayAPIService.requestDataDeletion()).toBe('no_access');
        expect(recover).not.toHaveBeenCalled();
        expect(register).not.toHaveBeenCalled();
    });

    it('the gone-account text is the relay verifier\'s own', () => {
        const relay = readFileSync(resolve(__dirname, '../../../provian-backend/src/routes/middleware/wallet-auth.ts'), 'utf8');
        expect(relay).toContain(`error: '${RELAY_AUTH_RECORD_GONE_ERROR}'`);
    });

    it('a 500 (possibly after part of the data was deleted) → not_finished', async () => {
        fetchMock.mockResolvedValue(answer(500, { error: 'Internal server error' }));
        expect(await RelayAPIService.requestDataDeletion()).toBe('not_finished');
    });

    it('a timeout or network error → unknown (the relay may have finished), never thrown into the screen', async () => {
        fetchMock.mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));
        await expect(RelayAPIService.requestDataDeletion()).resolves.toBe('unknown');
        fetchMock.mockReset();
        fetchMock.mockRejectedValue(new Error('offline'));
        await expect(RelayAPIService.requestDataDeletion()).resolves.toBe('unknown');
    });

    it('with no relay credentials on this phone, nothing is sent, nothing is recovered → no_access', async () => {
        vi.spyOn(svc, 'getAuthSecret').mockResolvedValue(null);
        expect(await RelayAPIService.requestDataDeletion()).toBe('no_access');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(recover).not.toHaveBeenCalled();
        expect(register).not.toHaveBeenCalled();
    });
});
