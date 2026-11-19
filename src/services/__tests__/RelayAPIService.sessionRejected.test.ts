vi.mock('../../core/protocol/runtime', async () => (await import('../../core/protocol/__test-helpers__/runtime')).protocolRuntimeFixture);
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../NotificationService', () => ({ default: {} }));

import relayService from '../RelayAPIService';

const service = relayService as any;
const answer = (status: number) => ({ ok: status >= 200 && status < 300, status, json: async () => ({}) }) as Response;

afterEach(() => vi.restoreAllMocks());

describe('relay session rejected', () => {
    it('a 401 that could not be renewed marks it; an accepted request and new credentials clear it', async () => {
        await relayService.setAuthSecret('secret-a', 'user-a');
        const once = vi.spyOn(service, 'makeAuthenticatedRequestOnce');
        expect(relayService.relaySessionRejected()).toBe(false);

        once.mockResolvedValueOnce(answer(401));
        await service.makeAuthenticatedRequest('/v1/pvt/accrual');
        expect(relayService.relaySessionRejected()).toBe(true);

        // A server error says nothing about the session: still rejected.
        once.mockResolvedValueOnce(answer(503));
        await service.makeAuthenticatedRequest('/v1/pvt/accrual');
        expect(relayService.relaySessionRejected()).toBe(true);

        once.mockResolvedValueOnce(answer(200));
        await service.makeAuthenticatedRequest('/v1/pvt/accrual');
        expect(relayService.relaySessionRejected()).toBe(false);

        once.mockResolvedValueOnce(answer(401));
        await service.makeAuthenticatedRequest('/v1/pvt/accrual');
        await relayService.setAuthSecret('secret-b', 'user-a');
        expect(relayService.relaySessionRejected()).toBe(false);
    });
});

describe('pre-signed session renewal', () => {
    const ACTION = Object.freeze({ nativeId: null });
    const ADDRESS = '0x00000000000000000000000000000000000000aa';

    async function primed() {
        await relayService.setAuthSecret('secret-a', 'user-a');
        relayService.discardSessionRenewal();
        service.lastRecoveryAt = 0;
        vi.spyOn(service, 'signRecoveryProof').mockResolvedValue('{"proof":1}');
        const submit = vi.spyOn(service, 'submitRecoveryProof').mockResolvedValue({ userId: 'user-a', authSecret: 's2', recovered: true });
        vi.spyOn(service, 'isRegistered').mockResolvedValue(true);
        const biometric = await import('../../core/security/biometricAction');
        const assertAction = vi.spyOn(biometric, 'assertBiometricAction').mockImplementation(() => undefined);
        await relayService.prepareSessionRenewal(ADDRESS, ACTION);
        // Signing is done: from here on there is no live approval, as after the unlock.
        assertAction.mockRestore();
        return { submit };
    }

    it('is held, used once for a 401 with no live approval, and never twice', async () => {
        const { submit } = await primed();
        expect(relayService.hasSessionRenewal()).toBe(true);
        await expect(relayService.renewWithPresignedProof(ADDRESS)).resolves.toBe(true);
        expect(submit).toHaveBeenCalledWith(ADDRESS, '{"proof":1}');
        expect(relayService.hasSessionRenewal()).toBe(false);
        service.lastRecoveryAt = 0;
        await expect(relayService.renewWithPresignedProof(ADDRESS)).resolves.toBe(false);
        expect(submit).toHaveBeenCalledTimes(1);
    });

    it('concurrent 401s share one renewal', async () => {
        const { submit } = await primed();
        const [a, b, c] = await Promise.all([
            relayService.renewWithPresignedProof(ADDRESS),
            relayService.renewWithPresignedProof(ADDRESS),
            relayService.renewWithPresignedProof(ADDRESS),
        ]);
        expect([a, b, c]).toEqual([true, true, true]);
        expect(submit).toHaveBeenCalledTimes(1);
    });

    it('respects the throttle after waiting on another wallet\'s recovery that just succeeded', async () => {
        const { submit } = await primed();
        let finish!: () => void;
        service.recoveryInFlight = {
            address: '0x00000000000000000000000000000000000000bb',
            promise: new Promise((r) => { finish = () => { service.lastRecoveryAt = Date.now(); r({ userId: 'b', authSecret: 'x', recovered: true }); }; }),
        };
        const renewal = relayService.renewWithPresignedProof(ADDRESS);
        finish();
        await expect(renewal).resolves.toBe(false);
        expect(submit).not.toHaveBeenCalled();
        service.recoveryInFlight = null;
    });

    it('never used for another wallet, after its lifetime, or once discarded', async () => {
        const { submit } = await primed();
        await expect(relayService.renewWithPresignedProof('0x00000000000000000000000000000000000000bb')).resolves.toBe(false);
        service.presignedRenewal.usableUntilMs = Date.now() - 1;
        await expect(relayService.renewWithPresignedProof(ADDRESS)).resolves.toBe(false);
        await primed();
        relayService.discardSessionRenewal();
        await expect(relayService.renewWithPresignedProof(ADDRESS)).resolves.toBe(false);
        expect(submit).not.toHaveBeenCalled();
    });

    it('a 401 on a request with no live approval renews with the proof and retries once', async () => {
        const { submit } = await primed();
        const walletStore = await import('../../store/walletStore');
        walletStore.useWalletStore.setState({ address: ADDRESS });
        vi.spyOn(service, 'getAuthSecret').mockResolvedValue('secret-a');
        vi.spyOn(service, 'generateSignedToken').mockResolvedValue('tok');
        vi.spyOn(service, 'getBackendUrl').mockResolvedValue('https://relay.example');
        const fetchMod = await import('../../core/network/apiFetch');
        const fetch = vi.spyOn(fetchMod, 'apiFetch')
            .mockResolvedValueOnce(answer(401))
            .mockResolvedValueOnce(answer(200));
        // The approval path (which would prompt) must not be taken.
        const prompted = vi.spyOn(service, 'recoverRelayCredentials');
        const response = await service.makeAuthenticatedRequest('/v1/pvt/accrual');
        expect(prompted).not.toHaveBeenCalled();
        expect(response.status).toBe(200);
        expect(submit).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(relayService.relaySessionRejected()).toBe(false);
    });
});
