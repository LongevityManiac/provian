vi.mock('../../core/protocol/runtime', async () => (await import('../../core/protocol/__test-helpers__/runtime')).protocolRuntimeFixture);
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../NotificationService', () => ({ default: {} }));

import relayService from '../RelayAPIService';

const service = relayService as any;
const response = (totalPEs: number) => ({
    ok: true,
    json: async () => ({ totalPEs, attestationDepth: 'software' }),
}) as Response;

afterEach(() => {
    vi.restoreAllMocks();
});

describe('personal accrual reads', () => {
    it('coalesces concurrent reads for one human, then permits a fresh read', async () => {
        await relayService.setAuthSecret('secret-a', 'user-a');
        let finish!: (result: Response) => void;
        const pending = new Promise<Response>((resolve) => { finish = resolve; });
        const request = vi.spyOn(service, 'makeAuthenticatedRequest')
            .mockImplementationOnce(() => pending)
            .mockResolvedValueOnce(response(8));

        const first = relayService.getPVTAccrual();
        const second = relayService.getPVTAccrual();
        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith(
            expect.stringMatching(/^\/v1\/pvt\/accrual\?_=/),
            expect.objectContaining({ cache: 'no-store' }), undefined, undefined,
        );
        finish(response(7));
        expect((await first)?.totalPEs).toBe(7);
        expect((await second)?.totalPEs).toBe(7);
        expect((await relayService.getPVTAccrual())?.totalPEs).toBe(8);
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('a read carrying a biometric action never joins one without it, and later plain reads join it', async () => {
        await relayService.setAuthSecret('secret-a', 'user-a');
        let finishPlain!: (result: Response) => void;
        let finishUnlock!: (result: Response) => void;
        const request = vi.spyOn(service, 'makeAuthenticatedRequest')
            .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishPlain = resolve; }))
            .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishUnlock = resolve; }));
        const action = Object.freeze({ nativeId: null });

        const plain = relayService.getPVTAccrual();
        const unlock = relayService.getPVTAccrual(action);
        // Its own request, carrying the action, so a 401 can renew the session.
        expect(request).toHaveBeenCalledTimes(2);
        expect(request.mock.calls[1][3]).toBe(action);
        const joiner = relayService.getPVTAccrual();
        expect(request).toHaveBeenCalledTimes(2);
        finishPlain(response(1));
        finishUnlock(response(2));
        expect((await plain)?.totalPEs).toBe(1);
        expect((await unlock)?.totalPEs).toBe(2);
        expect((await joiner)?.totalPEs).toBe(2);
    });

    it('does not return a previous human\'s response after an account switch', async () => {
        await relayService.setAuthSecret('secret-a', 'user-a');
        let finish!: (result: Response) => void;
        const pending = new Promise<Response>((resolve) => { finish = resolve; });
        vi.spyOn(service, 'makeAuthenticatedRequest').mockImplementation(() => pending);

        const oldRead = relayService.getPVTAccrual();
        await relayService.setAuthSecret('secret-b', 'user-b');
        finish(response(77));
        expect(await oldRead).toBeNull();
    });

    it('keeps history local and uses fresh URLs for network stats and on-chain balance', async () => {
        const request = vi.spyOn(service, 'makeAuthenticatedRequest').mockResolvedValue({
            ok: true,
            json: async () => ({ entries: [], total: 0, hasMore: false }),
        } as Response);
        await relayService.getPVTHistory(10, 0, false);
        await relayService.getPVTHistory(10, 0, false);
        await relayService.getPVTNetworkStats();
        await relayService.getPVTBalance('0x1111111111111111111111111111111111111111');

        const urls = request.mock.calls.map(([url]) => url as string);
        expect(urls).toHaveLength(2);
        expect(urls.some(url => url.startsWith('/v1/pvt/history'))).toBe(false);
        expect(urls[0]).toMatch(/^\/v1\/pvt\/network-stats\?window=all&_=/);
        const balanceUrl = new URL(urls[1], 'https://relay.example');
        expect(balanceUrl.pathname).toBe('/v1/pvt/balance/0x1111111111111111111111111111111111111111');
        expect(balanceUrl.searchParams.get('token')).toMatch(/^0x[0-9a-f]{40}$/);
        expect(balanceUrl.searchParams.has('_')).toBe(true);
        for (const [, options] of request.mock.calls) {
            expect(options).toEqual(expect.objectContaining({ cache: 'no-store' }));
        }
    });
});
