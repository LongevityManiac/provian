/**
 * finding #3 — the human-promise live poll must not die on HTTP 304.
 *
 * getHumanPromise / listMyHumanPromises returned null on any non-2xx, including
 * the 304 Express returns once its ETag matches the client's If-None-Match. Once
 * ETags stabilized, PromiseRelayService.subscribeToPromise's poll went dark
 * (getHumanPromise → null → the callback never fires → reconcileWithRemote never
 * runs), so a relay state change only reached the app after a cold relaunch.
 *
 * The fix makes these reads NON-CACHEABLE: a per-request cache-busting query
 * param gives every poll a unique URL (no cached entry, no stored ETag → the
 * relay always answers 200 with the current body), plus no-store/no-cache. The
 * cache-buster is SAFE for wallet-auth token binding because the bound path
 * (`pth`) is canonicalized with the query stripped on both sides.
 *
 * Two proofs here: (A) the requests are issued non-cacheably and each poll's URL
 * is unique (driven through a faked makeAuthenticatedRequest); (B) the real
 * makeAuthenticatedRequest still signs each request and the cache-buster does not
 * break `pth` binding (driven through a faked apiFetch, decoding the token).
 *
 * RED control : revert getHumanPromise/listMyHumanPromises to the plain
 * endpoint (drop noCacheGet) and the "carries a cache-buster" + "unique per poll"
 * cases go red. Observed red on 2026-09-11, then restored.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as SecureStore from 'expo-secure-store';

vi.mock('../NotificationService', () => ({
    default: {
        getBackendUrl: async () => 'https://relay.test',
        getPushToken: async () => null,
    },
}));

// (B) fake the single outbound primitive so the REAL makeAuthenticatedRequest
// (signing + header assembly) runs and we can inspect the URL + Authorization.
vi.mock('../../core/network/apiFetch', () => ({
    apiFetch: vi.fn(),
    default: vi.fn(),
}));

import RelayAPIService from '../RelayAPIService';
import { apiFetch } from '../../core/network/apiFetch';

const AUTH_SECRET_KEY = 'provian_relay_auth_secret';
const USER_ID_KEY = 'provian_relay_user_id';

type AuthFetch = (endpoint: string, options?: RequestInit, retryOnAuth?: boolean) => Promise<Response>;
const svc = RelayAPIService as unknown as { makeAuthenticatedRequest: AuthFetch };

function fakeResponse(init: { status: number; body: unknown }): Response {
    return {
        ok: init.status >= 200 && init.status < 300,
        status: init.status,
        json: async () => init.body,
    } as unknown as Response;
}

function decodePth(token: string): string {
    const payloadB64 = token.slice(0, token.lastIndexOf('.'));
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
    return payload.pth;
}

beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
});

describe('(A) human-promise reads are non-cacheable', () => {
    let captured: { endpoint: string; options?: RequestInit }[] = [];
    function stub(resp: { status: number; body: unknown }): void {
        captured = [];
        vi.spyOn(svc, 'makeAuthenticatedRequest').mockImplementation(async (endpoint, options) => {
            captured.push({ endpoint, options });
            return fakeResponse(resp);
        });
    }

    it('getHumanPromise carries a cache-buster + no-store/no-cache and still parses the 200 body', async () => {
        stub({ status: 200, body: { promise: { promise_id: 'p-1', status: 'accepted' } } });
        const doc = await RelayAPIService.getHumanPromise('p-1');
        expect(doc).toEqual({ promise_id: 'p-1', status: 'accepted' });

        const { endpoint, options } = captured[0];
        expect(endpoint).toMatch(/^\/v1\/human-promises\/p-1\?_=/); // cache-buster on a query-less path
        expect(options?.cache).toBe('no-store');
        expect((options?.headers as Record<string, string>)['Cache-Control']).toBe('no-cache');
    });

    it('two successive getHumanPromise polls issue DISTINCT URLs (defeats the URLSession cache)', async () => {
        stub({ status: 200, body: { promise: { promise_id: 'p-1' } } });
        await RelayAPIService.getHumanPromise('p-1');
        await RelayAPIService.getHumanPromise('p-1');
        expect(captured).toHaveLength(2);
        expect(captured[0].endpoint).not.toBe(captured[1].endpoint);
    });

    it('listMyHumanPromises appends the cache-buster with & (path already has no query)', async () => {
        stub({ status: 200, body: { promises: [], my_address: '0xabc' } });
        await RelayAPIService.listMyHumanPromises();
        expect(captured[0].endpoint).toMatch(/^\/v1\/human-promises\/mine\?_=/);
        expect(captured[0].options?.cache).toBe('no-store');
    });
});

describe('(B) token binding survives the cache-buster', () => {
    beforeEach(async () => {
        await SecureStore.setItemAsync(AUTH_SECRET_KEY, 'test-secret');
        await SecureStore.setItemAsync(USER_ID_KEY, 'user_test');
    });

    it('signs each request and keeps pth query-stripped despite the cache-buster', async () => {
        vi.mocked(apiFetch).mockResolvedValue(
            fakeResponse({ status: 200, body: { promise: { promise_id: 'p-xyz' } } }),
        );

        const doc = await RelayAPIService.getHumanPromise('p-xyz');
        expect(doc).toEqual({ promise_id: 'p-xyz' });

        expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1);
        const [url, opts] = vi.mocked(apiFetch).mock.calls[0] as [string, RequestInit];

        // The fetched URL carries the cache-buster...
        expect(url).toMatch(/^https:\/\/relay\.test\/v1\/human-promises\/p-xyz\?_=/);

        // ...and the request is still signed, with pth canonicalized (query stripped)
        // so the wallet-auth token binding is intact.
        const auth = (opts.headers as Record<string, string>).Authorization;
        expect(auth).toMatch(/^Bearer /);
        expect(decodePth(auth.slice('Bearer '.length))).toBe('/v1/human-promises/p-xyz');
    });
});
