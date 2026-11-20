import { afterEach, describe, expect, it, vi } from 'vitest';
import relayService from '../RelayAPIService';

vi.mock('../NotificationService', () => ({ default: {} }));

const client = relayService as unknown as {
    sendLatestActs(): Promise<void>;
    makeAuthenticatedRequest(path: string, input: RequestInit): Promise<Response>;
};

afterEach(() => vi.restoreAllMocks());

describe('Earn payout availability', () => {
    it.each([
        [402, { ready: { claims: 2 } }, true],
        [402, { ready: { claims: 0 } }, false],
        [409, { error: 'nothing_to_pay' }, false],
        [503, { error: 'waits_for_gas' }, true],
        [503, { error: 'payout_not_configured' }, false],
    ] as const)('reads the quote without uploading acts or sending payment (%s, %j)', async (status, body, expected) => {
        const upload = vi.spyOn(client, 'sendLatestActs').mockResolvedValue();
        const request = vi.spyOn(client, 'makeAuthenticatedRequest')
            .mockResolvedValue(new Response(JSON.stringify(body), { status }));
        await expect(relayService.hasReadyPayoutWork()).resolves.toBe(expected);
        expect(upload).not.toHaveBeenCalled();
        expect(request).toHaveBeenCalledWith('/v1/payout/mobile', { method: 'POST', body: '{}' }, undefined, undefined);
    });

    it('still uploads the latest acts when the user starts a quote', async () => {
        const upload = vi.spyOn(client, 'sendLatestActs').mockResolvedValue();
        const request = vi.spyOn(client, 'makeAuthenticatedRequest')
            .mockResolvedValue(new Response(JSON.stringify({ ready: { claims: 2 } }), { status: 402 }));
        await expect(relayService.payoutQuote()).resolves.toMatchObject({ available: true, readyClaims: 2 });
        expect(upload.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[0]);
    });
});
