import { withBiometricAction } from '../../core/security/biometricAction';
/**
 * A restored wallet reads its OWN relay record (2026-10-02: "I just recovered my wallet. PVT/PE
 * isn't loading").
 *
 * The dashboard reads PEs and PVT by relay user_id. After a cloud restore on a fresh device, the
 * push registrar in App.tsx ran `ensureRegistered()` the moment onboarding completed; with no
 * secret yet it called `registerUser()` → `POST /v1/users`, which always mints a blank account.
 * The device then read a confident 0 PEs / 0 PVT, and the launch backstop skipped forever because
 * its marker was keyed by address only.
 *
 * Pinned here, each with a RED control:
 *  - ensureRegistered with a wallet on the device recovers by wallet signature, never registers;
 *  - a blank-account POST that resolves after a recovery landed never overwrites it;
 *  - concurrent recoveries share one call (each recovery rotates the secret);
 *  - the registration marker is keyed by address AND account;
 *  - a 409 `human_wallet_registration_index_invalid` (signed in as another wallet's account)
 *    recovers the address's own account once and retries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../NotificationService', () => ({
    default: { getBackendUrl: async () => 'https://relay.test', getPushToken: async () => null },
}));

const wallet = { address: null as string | null };
vi.mock('../../store/walletStore', () => ({
    useWalletStore: { getState: () => ({ address: wallet.address }) },
}));

const storage = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => storage.get(k) ?? null,
        setItem: async (k: string, v: string) => { storage.set(k, v); },
        removeItem: async (k: string) => { storage.delete(k); },
        multiSet: async () => undefined,
        multiRemove: async () => undefined,
    },
}));

const fetchMock = vi.fn();
vi.mock('../../core/network/apiFetch', () => ({
    apiFetch: (...args: unknown[]) => fetchMock(...args),
}));


import RelayAPIService, { humanWalletRegistrationMarker } from '../RelayAPIService';

type Recovered = { userId: string; authSecret: string; recovered: boolean };
const svc = RelayAPIService as unknown as {
    isRegistered: () => Promise<boolean>;
    registerUser: () => Promise<{ userId: string; authSecret: string }>;
    doRecoverRelayCredentials: (a: string) => Promise<Recovered>;
    getAuthSecret: () => Promise<string | null>;
    setAuthSecret: (s: string, u: string) => Promise<void>;
    getUserId: () => Promise<string | null>;
    getDeviceId: () => Promise<string>;
    makeAuthenticatedRequest: (e: string, o?: RequestInit, r?: boolean) => Promise<Response>;
    isAddressProofAuthorized: (a: string) => Promise<boolean>;
    recordAddressProofAuthorization: (a: unknown) => Promise<void>;
    registerHumanWallet: (a: string, o?: Record<string, unknown>) => Promise<boolean>;
    recoveryInFlight: unknown;
};

const RECOVERED: Recovered = { userId: 'user_owner', authSecret: 's', recovered: true };

function res(status: number, body: unknown): Response {
    const r = { ok: status >= 200 && status < 300, status, json: async () => body };
    return { ...r, clone: () => r } as unknown as Response;
}

beforeEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
    storage.clear();
    wallet.address = null;
    svc.recoveryInFlight = null;
});

describe('ensureRegistered', () => {
    it('recovers the wallet\'s own account when a wallet is on the device, never registers', async () => {
        wallet.address = '0xAbC';
        vi.spyOn(svc, 'isRegistered').mockResolvedValue(false);
        const register = vi.spyOn(svc, 'registerUser').mockResolvedValue({ userId: 'user_blank', authSecret: 'x' });
        const recover = vi.spyOn(svc, 'doRecoverRelayCredentials').mockResolvedValue(RECOVERED);
        await withBiometricAction('unlock', action => RelayAPIService.ensureRegistered(action));
        expect(recover).toHaveBeenCalledWith('0xAbC', expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value)));
        expect(register).not.toHaveBeenCalled();
    });

    it('RED: with no wallet on the device it registers fresh', async () => {
        vi.spyOn(svc, 'isRegistered').mockResolvedValue(false);
        const register = vi.spyOn(svc, 'registerUser').mockResolvedValue({ userId: 'user_new', authSecret: 'x' });
        const recover = vi.spyOn(svc, 'doRecoverRelayCredentials').mockResolvedValue(RECOVERED);
        await RelayAPIService.ensureRegistered();
        expect(register).toHaveBeenCalledTimes(1);
        expect(recover).not.toHaveBeenCalled();
    });

    it('does nothing when credentials already exist', async () => {
        wallet.address = '0xabc';
        vi.spyOn(svc, 'isRegistered').mockResolvedValue(true);
        const register = vi.spyOn(svc, 'registerUser');
        const recover = vi.spyOn(svc, 'doRecoverRelayCredentials');
        await RelayAPIService.ensureRegistered();
        expect(register).not.toHaveBeenCalled();
        expect(recover).not.toHaveBeenCalled();
    });
});

describe('registerUser', () => {
    beforeEach(() => {
        vi.spyOn(svc, 'getDeviceId').mockResolvedValue('device_1');
        fetchMock.mockResolvedValue(res(200, { user_id: 'user_blank', auth_secret: 'blank_secret' }));
    });

    it('keeps credentials a recovery stored while the POST was in flight', async () => {
        vi.spyOn(svc, 'getAuthSecret')
            .mockResolvedValueOnce(null) // before the POST
            .mockResolvedValueOnce('owner_secret'); // after it: a recovery landed
        const set = vi.spyOn(svc, 'setAuthSecret').mockResolvedValue(undefined);
        const out = await RelayAPIService.registerUser();
        expect(set).not.toHaveBeenCalled();
        expect(out.authSecret).toBe('owner_secret');
    });

    it('RED: with nothing landed it stores the new account', async () => {
        vi.spyOn(svc, 'getAuthSecret').mockResolvedValue(null);
        const set = vi.spyOn(svc, 'setAuthSecret').mockResolvedValue(undefined);
        await RelayAPIService.registerUser();
        expect(set).toHaveBeenCalledWith('blank_secret', 'user_blank');
    });
});

describe('recoverRelayCredentials', () => {
    it('concurrent calls for one address share a single recovery', async () => {
        let release: (v: Recovered) => void = () => undefined;
        const recover = vi.spyOn(svc, 'doRecoverRelayCredentials')
            .mockImplementation(() => new Promise<Recovered>((r) => { release = r; }));
        await withBiometricAction('reconnect', async action => {
            const a = RelayAPIService.recoverRelayCredentials('0xABC', action);
            const b = RelayAPIService.recoverRelayCredentials('0xabc', action);
            release(RECOVERED);
            expect(await a).toEqual(RECOVERED);
            expect(await b).toEqual(RECOVERED);
        });
        expect(recover).toHaveBeenCalledTimes(1);
        expect(svc.recoveryInFlight).toBeNull();
    });

    it('RED: a call for another address runs its own recovery after the first', async () => {
        const order: string[] = [];
        vi.spyOn(svc, 'doRecoverRelayCredentials').mockImplementation(async (addr: string) => {
            order.push(`start:${addr}`);
            await Promise.resolve();
            order.push(`end:${addr}`);
            return RECOVERED;
        });
        await Promise.all([
            RelayAPIService.recoverRelayCredentials('0xaaa'),
            RelayAPIService.recoverRelayCredentials('0xbbb'),
        ]);
        expect(order).toEqual(['start:0xaaa', 'end:0xaaa', 'start:0xbbb', 'end:0xbbb']);
    });

    it('a failed recovery clears the in-flight slot so the next call runs', async () => {
        const recover = vi.spyOn(svc, 'doRecoverRelayCredentials')
            .mockRejectedValueOnce(new Error('declined'))
            .mockResolvedValueOnce(RECOVERED);
        await expect(RelayAPIService.recoverRelayCredentials('0xabc')).rejects.toThrow('declined');
        expect(await RelayAPIService.recoverRelayCredentials('0xabc')).toEqual(RECOVERED);
        expect(recover).toHaveBeenCalledTimes(2);
    });
});

describe('ensureHumanWalletRegistered marker', () => {
    it.each(['refused', 'offline'] as const)('retries %s onboarding registration on launch and skips only after confirmation', async failure => {
        vi.spyOn(svc, 'getUserId').mockResolvedValue('user_owner');
        const reg = vi.spyOn(svc, 'registerHumanWallet');
        if (failure === 'offline') reg.mockRejectedValueOnce(new Error('offline'));
        else reg.mockResolvedValueOnce(false);
        reg.mockResolvedValue(true);
        const creationAction = { nativeId: 'creation' };
        expect(await RelayAPIService.ensureHumanWalletRegistered('0xabc', undefined, creationAction)).toBe(false);
        expect(storage.has(KEY)).toBe(false);
        expect(await RelayAPIService.ensureHumanWalletRegistered('0xabc')).toBe(true);
        expect(reg).toHaveBeenNthCalledWith(1, '0xabc', undefined, creationAction);
        expect(reg).toHaveBeenNthCalledWith(2, '0xabc', undefined, undefined);
        expect(storage.get(KEY)).toBe(humanWalletRegistrationMarker('0xabc', 'user_owner'));
        expect(await RelayAPIService.ensureHumanWalletRegistered('0xabc')).toBe(true);
        expect(reg).toHaveBeenCalledTimes(2);
    });

    it('passes the onboarding action through and reports a refused registration', async () => {
        const action = { nativeId: 'onboarding-action' };
        vi.spyOn(svc, 'getUserId').mockResolvedValue('user_owner');
        const reg = vi.spyOn(svc, 'registerHumanWallet').mockResolvedValue(false);
        expect(await RelayAPIService.ensureHumanWalletRegistered('0xabc', undefined, action)).toBe(false);
        expect(reg).toHaveBeenCalledWith('0xabc', undefined, action);
        expect(storage.has(KEY)).toBe(false);
        reg.mockResolvedValue(true);
        expect(await RelayAPIService.ensureHumanWalletRegistered('0xabc', undefined, action)).toBe(true);
        expect(storage.get(KEY)).toBe(humanWalletRegistrationMarker('0xabc', 'user_owner'));
    });

    const KEY = '@provian_human_wallet_registered';

    it('re-registers when the marker names another relay account (a blank one after restore)', async () => {
        storage.set(KEY, humanWalletRegistrationMarker('0xabc', 'user_blank'));
        vi.spyOn(svc, 'getUserId').mockResolvedValue('user_other');
        const reg = vi.spyOn(svc, 'registerHumanWallet').mockResolvedValue(true);
        await RelayAPIService.ensureHumanWalletRegistered('0xabc');
        expect(reg).toHaveBeenCalledTimes(1);
        expect(storage.get(KEY)).toBe(humanWalletRegistrationMarker('0xabc', 'user_other'));
    });

    it('re-registers once over a legacy address-only marker', async () => {
        storage.set(KEY, '0xabc');
        vi.spyOn(svc, 'getUserId').mockResolvedValue('user_owner');
        const reg = vi.spyOn(svc, 'registerHumanWallet').mockResolvedValue(true);
        await RelayAPIService.ensureHumanWalletRegistered('0xabc');
        expect(reg).toHaveBeenCalledTimes(1);
    });

    it('RED: skips when the marker matches this address on this account', async () => {
        storage.set(KEY, humanWalletRegistrationMarker('0xABC', 'user_owner'));
        vi.spyOn(svc, 'getUserId').mockResolvedValue('user_owner');
        const reg = vi.spyOn(svc, 'registerHumanWallet').mockResolvedValue(true);
        await RelayAPIService.ensureHumanWalletRegistered('0xabc');
        expect(reg).not.toHaveBeenCalled();
    });
});

describe('registerHumanWallet: signed in as another wallet\'s account', () => {
    beforeEach(() => {
        vi.spyOn(svc, 'getUserId').mockResolvedValue('user_owner');
        vi.spyOn(svc, 'recordAddressProofAuthorization').mockResolvedValue(undefined);
    });

    it('recovers this wallet\'s account on 409 index_invalid and retries once', async () => {
        vi.spyOn(svc, 'isAddressProofAuthorized').mockResolvedValue(false);
        const recover = vi.spyOn(svc, 'doRecoverRelayCredentials').mockResolvedValue(RECOVERED);
        const post = vi.spyOn(svc, 'makeAuthenticatedRequest')
            .mockResolvedValueOnce(res(409, { error: 'human_wallet_registration_index_invalid' }))
            .mockResolvedValueOnce(res(200, { walletId: 'wallet_1' }));
        expect(await RelayAPIService.registerHumanWallet('0xabc')).toBe(true);
        expect(recover).toHaveBeenCalledWith('0xabc', expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value)));
        expect(post).toHaveBeenCalledTimes(2);
    });

    it('RED: an account the relay already placed on this address is not recovered (no loop)', async () => {
        vi.spyOn(svc, 'isAddressProofAuthorized').mockResolvedValue(true);
        const recover = vi.spyOn(svc, 'doRecoverRelayCredentials').mockResolvedValue(RECOVERED);
        const post = vi.spyOn(svc, 'makeAuthenticatedRequest')
            .mockResolvedValue(res(409, { error: 'human_wallet_registration_index_invalid' }));
        expect(await RelayAPIService.registerHumanWallet('0xabc')).toBe(false);
        expect(recover).not.toHaveBeenCalled();
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('RED: a repeat 409 after the recovery does not loop', async () => {
        vi.spyOn(svc, 'isAddressProofAuthorized').mockResolvedValue(false);
        const recover = vi.spyOn(svc, 'doRecoverRelayCredentials').mockResolvedValue(RECOVERED);
        const post = vi.spyOn(svc, 'makeAuthenticatedRequest')
            .mockResolvedValue(res(409, { error: 'human_wallet_registration_index_invalid' }));
        expect(await RelayAPIService.registerHumanWallet('0xabc')).toBe(false);
        expect(recover).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenCalledTimes(2);
    });

    it('RED: a caller that just saw recovery fail does not recover again', async () => {
        vi.spyOn(svc, 'isAddressProofAuthorized').mockResolvedValue(false);
        const recover = vi.spyOn(svc, 'doRecoverRelayCredentials').mockResolvedValue(RECOVERED);
        vi.spyOn(svc, 'makeAuthenticatedRequest')
            .mockResolvedValue(res(409, { error: 'human_wallet_registration_index_invalid' }));
        expect(await RelayAPIService.registerHumanWallet('0xabc', { allowAddressProof: false })).toBe(false);
        expect(recover).not.toHaveBeenCalled();
    });

    it('RED: another 409 code does not recover', async () => {
        vi.spyOn(svc, 'isAddressProofAuthorized').mockResolvedValue(false);
        const recover = vi.spyOn(svc, 'doRecoverRelayCredentials').mockResolvedValue(RECOVERED);
        vi.spyOn(svc, 'makeAuthenticatedRequest')
            .mockResolvedValue(res(409, { error: 'human_wallet_uniqueness_conflict' }));
        expect(await RelayAPIService.registerHumanWallet('0xabc')).toBe(false);
        expect(recover).not.toHaveBeenCalled();
    });
});
