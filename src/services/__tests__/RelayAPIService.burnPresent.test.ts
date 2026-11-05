/**
 * F-A5-1 — the human burn-to-present RelayAPIService methods
 * (recordFirstPartyBurn / produceHumanPresentation): request shape + response
 * parsing + fail-loud behaviour. Each case drives the REAL method through a faked
 * makeAuthenticatedRequest; no copy of the production request table lives here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../NotificationService', () => ({ default: {} }));

import RelayAPIService from '../RelayAPIService';

type AuthFetch = (endpoint: string, options?: RequestInit, retryOnAuth?: boolean) => Promise<Response>;
const svc = RelayAPIService as unknown as { makeAuthenticatedRequest: AuthFetch };

function fakeResponse(init: { status: number; body: unknown }): Response {
    return {
        ok: init.status >= 200 && init.status < 300,
        status: init.status,
        json: async () => init.body,
    } as unknown as Response;
}

let captured: { endpoint: string; body: Record<string, unknown> } | null = null;
beforeEach(() => { captured = null; });

function stub(resp: { status: number; body: unknown }): void {
    vi.spyOn(svc, 'makeAuthenticatedRequest').mockImplementation(async (endpoint, options) => {
        captured = { endpoint, body: JSON.parse(String(options?.body ?? '{}')) };
        return fakeResponse(resp);
    });
}

describe('recordFirstPartyBurn', () => {
    it('posts {tx_hash, chain, amount_atomic} to /v1/wallet/burn/record and returns the burn id', async () => {
        stub({ status: 200, body: { burn_id: 'burn_abc', verified: true } });
        const r = await RelayAPIService.recordFirstPartyBurn({
            txHash: `0x${'a'.repeat(64)}`, chain: 'base', amountAtomic: '1000000000000000000',
        });
        expect(captured?.endpoint).toBe('/v1/wallet/burn/record');
        expect(captured?.body).toEqual({
            tx_hash: `0x${'a'.repeat(64)}`, chain: 'base', amount_atomic: '1000000000000000000',
        });
        expect(r).toEqual({ burnId: 'burn_abc', verified: true, idempotent: false });
    });

    it('surfaces the backend reason on a non-2xx (fails loud, never a silent success)', async () => {
        stub({ status: 400, body: { error: 'burn_not_verified', reason: 'no Transfer to 0x0 found' } });
        await expect(RelayAPIService.recordFirstPartyBurn({
            txHash: `0x${'b'.repeat(64)}`, chain: 'base', amountAtomic: '1',
        })).rejects.toThrow(/no Transfer to 0x0 found/);
    });

    // a 200 with no burn_id must NOT be read as a successful burn.
    it('RED — a 200 missing burn_id throws rather than returning a phantom burn', async () => {
        stub({ status: 200, body: { verified: true } });
        await expect(RelayAPIService.recordFirstPartyBurn({
            txHash: `0x${'c'.repeat(64)}`, chain: 'base', amountAtomic: '1',
        })).rejects.toThrow(/missing burn_id/);
    });
});

describe('produceHumanPresentation', () => {
    it('posts the request to /v1/wallet/present and returns the token', async () => {
        stub({ status: 200, body: { tier: 'pe_fact', presentation: { tier: 'pe_fact' }, token: 'tok_x' } });
        const r = await RelayAPIService.produceHumanPresentation({
            tier: 'pe_fact', burn_id: 'burn_abc', audience: 'requester_1', challenge: 'nonce_deadbeef_1234',
        });
        expect(captured?.endpoint).toBe('/v1/wallet/present');
        expect(captured?.body.burn_id).toBe('burn_abc');
        expect(r.token).toBe('tok_x');
    });
});
