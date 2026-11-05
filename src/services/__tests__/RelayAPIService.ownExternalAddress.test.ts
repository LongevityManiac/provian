/**
 * A PERSON proves a wallet they already hold (Earn → "A wallet you already hold").
 *
 * The three wallet-auth calls hit the person routes, never the agent routes:
 *   POST /v1/wallet/external-address/challenge  {address}
 *   POST /v1/wallet/external-address/verify     {address, challenge_id, signature}
 *   GET  /v1/wallet/external-addresses
 * RED controls: a relay refusal surfaces its own error code; a malformed answer is never
 * treated as a challenge; a failed list read is null (unknown), never "none proven".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../NotificationService', () => ({
    default: {
        getBackendUrl: async () => 'https://relay.test',
        getPushToken: async () => null,
    },
}));

vi.mock('../../core/network/apiFetch', () => ({
    apiFetch: vi.fn(),
    default: vi.fn(),
}));

import RelayAPIService, { relayTimeMs } from '../RelayAPIService';

type AuthFetch = (endpoint: string, options?: RequestInit, retryOnAuth?: boolean) => Promise<Response>;
const svc = RelayAPIService as unknown as { makeAuthenticatedRequest: AuthFetch };

const ADDR = '0xabc0000000000000000000000000000000000001';

function fakeResponse(init: { ok: boolean; status: number; body: unknown }): Response {
    return { ok: init.ok, status: init.status, json: async () => init.body } as unknown as Response;
}

function spyAuth(init: { ok: boolean; status: number; body: unknown }) {
    return vi.spyOn(svc, 'makeAuthenticatedRequest').mockResolvedValue(fakeResponse(init));
}

describe('RelayAPIService.requestOwnExternalAddressChallenge', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('POSTs {address} to the PERSON challenge route and returns the exact message', async () => {
        const spy = spyAuth({
            ok: true, status: 200,
            body: {
                challenge_id: 'ch_1', message: 'Provian proof of control\nperson: u1', nonce: 'n',
                issued_at: '2026-10-01T00:00:00Z', expires_at: '2026-10-01T00:10:00Z',
                address: ADDR, chain: 'base', chain_id: 8453,
            },
        });
        const result = await RelayAPIService.requestOwnExternalAddressChallenge(ADDR);
        expect(result).toEqual({
            ok: true,
            challenge: {
                challengeId: 'ch_1',
                message: 'Provian proof of control\nperson: u1',
                address: ADDR,
                expiresAt: Date.parse('2026-10-01T00:10:00Z'),
            },
        });
        expect(spy).toHaveBeenCalledTimes(1);
        const [endpoint, init] = spy.mock.calls[0] as [string, RequestInit];
        expect(endpoint).toBe('/v1/wallet/external-address/challenge');
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ address: ADDR });
        // RED: never the agent route.
        expect(endpoint).not.toMatch(/\/v1\/agent\//);
    });

    it('accepts an epoch-ms expiry as well', async () => {
        spyAuth({ ok: true, status: 200, body: { challenge_id: 'c', message: 'm', expires_at: 1_790_000_000_000 } });
        const result = await RelayAPIService.requestOwnExternalAddressChallenge(ADDR);
        expect(result.ok && result.challenge.expiresAt).toBe(1_790_000_000_000);
    });

    it('RED: a relay refusal returns its code (address_is_provian_wallet)', async () => {
        spyAuth({ ok: false, status: 409, body: { error: 'address_is_provian_wallet' } });
        expect(await RelayAPIService.requestOwnExternalAddressChallenge(ADDR))
            .toEqual({ ok: false, error: 'address_is_provian_wallet' });
    });

    it('RED: a refusal with no code falls back to http_<status>', async () => {
        spyAuth({ ok: false, status: 429, body: {} });
        expect(await RelayAPIService.requestOwnExternalAddressChallenge(ADDR)).toEqual({ ok: false, error: 'http_429' });
    });

    it('RED: a 200 without a message or expiry is malformed, never a challenge', async () => {
        spyAuth({ ok: true, status: 200, body: { challenge_id: 'c', expires_at: 'not a date', message: 'm' } });
        expect(await RelayAPIService.requestOwnExternalAddressChallenge(ADDR)).toEqual({ ok: false, error: 'malformed_response' });
        vi.restoreAllMocks();
        spyAuth({ ok: true, status: 200, body: { challenge_id: 'c', expires_at: 1 } });
        expect(await RelayAPIService.requestOwnExternalAddressChallenge(ADDR)).toEqual({ ok: false, error: 'malformed_response' });
    });

    it('RED: a thrown auth/network error is returned, not thrown', async () => {
        vi.spyOn(svc, 'makeAuthenticatedRequest').mockRejectedValue(new Error('Not authenticated'));
        expect(await RelayAPIService.requestOwnExternalAddressChallenge(ADDR)).toEqual({ ok: false, error: 'Not authenticated' });
    });
});

describe('RelayAPIService.verifyOwnExternalAddress', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('POSTs {address, challenge_id, signature} to the PERSON verify route', async () => {
        const spy = spyAuth({
            ok: true, status: 200,
            body: { ok: true, proven_address: ADDR, proven_at: 1, proof_method: 'eip191', already_proven: false, pe_id: 'pe_1', owner: 'person' },
        });
        const sig = `0x${'ab'.repeat(65)}`;
        const result = await RelayAPIService.verifyOwnExternalAddress({ address: ADDR, challengeId: 'ch_1', signature: sig });
        expect(result).toEqual({ ok: true, provenAddress: ADDR });
        const [endpoint, init] = spy.mock.calls[0] as [string, RequestInit];
        expect(endpoint).toBe('/v1/wallet/external-address/verify');
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ address: ADDR, challenge_id: 'ch_1', signature: sig });
    });

    it('RED: a 200 without ok:true is not a proof', async () => {
        spyAuth({ ok: true, status: 200, body: { proven_address: ADDR } });
        expect(await RelayAPIService.verifyOwnExternalAddress({ address: ADDR, challengeId: 'c', signature: '0x' }))
            .toEqual({ ok: false, error: 'http_200' });
    });

    it('RED: address_bound_to_other_owner surfaces as its own code', async () => {
        spyAuth({ ok: false, status: 409, body: { error: 'address_bound_to_other_owner' } });
        expect(await RelayAPIService.verifyOwnExternalAddress({ address: ADDR, challengeId: 'c', signature: '0x' }))
            .toEqual({ ok: false, error: 'address_bound_to_other_owner' });
    });
});

describe('RelayAPIService.listOwnExternalAddresses', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('GETs the PERSON list route (no-cache) and maps rows; ISO or epoch-ms timestamps', async () => {
        const spy = spyAuth({
            ok: true, status: 200,
            body: {
                addresses: [
                    { address: ADDR, proven_at: '2026-10-01T00:00:00Z', proven_at_block: 1, proof_method: 'eip191', chain: 'base' },
                    { address: '0xdef0000000000000000000000000000000000002', proven_at: 1_790_000_000_000 },
                    { address: 42, proven_at: 1 },
                ],
            },
        });
        expect(await RelayAPIService.listOwnExternalAddresses()).toEqual([
            { address: ADDR, provenAt: Date.parse('2026-10-01T00:00:00Z') },
            { address: '0xdef0000000000000000000000000000000000002', provenAt: 1_790_000_000_000 },
        ]);
        const [endpoint, init] = spy.mock.calls[0] as [string, RequestInit];
        expect(endpoint).toMatch(/^\/v1\/wallet\/external-addresses\?_=/);
        expect(init.method).toBe('GET');
    });

    it('RED: a failed read is null (unknown), never an empty list', async () => {
        spyAuth({ ok: false, status: 503, body: {} });
        expect(await RelayAPIService.listOwnExternalAddresses()).toBeNull();
        vi.restoreAllMocks();
        spyAuth({ ok: true, status: 200, body: {} });
        expect(await RelayAPIService.listOwnExternalAddresses()).toBeNull();
        vi.restoreAllMocks();
        vi.spyOn(svc, 'makeAuthenticatedRequest').mockRejectedValue(new Error('offline'));
        expect(await RelayAPIService.listOwnExternalAddresses()).toBeNull();
    });
});

describe('relayTimeMs', () => {
    it('reads epoch ms and ISO strings; RED: anything else is null', () => {
        expect(relayTimeMs(5)).toBe(5);
        expect(relayTimeMs('2026-10-01T00:00:00Z')).toBe(Date.parse('2026-10-01T00:00:00Z'));
        expect(relayTimeMs('nope')).toBeNull();
        expect(relayTimeMs('')).toBeNull();
        expect(relayTimeMs(Number.NaN)).toBeNull();
        expect(relayTimeMs(null)).toBeNull();
    });
});
