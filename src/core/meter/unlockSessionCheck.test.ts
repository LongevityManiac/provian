import { beforeEach, describe, expect, it, vi } from 'vitest';

const relay = {
    isRegistered: vi.fn(async () => true),
    getPVTAccrual: vi.fn(async (_action?: unknown): Promise<object | null> => null),
};
vi.mock('../../services/RelayAPIService', () => ({ default: relay }));
const saved: Array<[string, string | null, unknown]> = [];
vi.mock('../wallet/walletTopCache', () => ({
    saveWalletTop: vi.fn(async (key: string, address: string | null, value: unknown) => { saved.push([key, address, value]); }),
}));

import { checkRelaySessionAtUnlock } from './phoneMeterRuntime';
import type { BiometricAction } from '../security/biometricAction';

const ACTION = Object.freeze({ nativeId: 'unlock' }) as BiometricAction;
const accrual = { totalPEs: 5, weeklyPEs: 1, currentSettlementProjection: { available: false } };

describe('relay session check at unlock', () => {
    beforeEach(() => {
        saved.length = 0;
        relay.isRegistered.mockResolvedValue(true);
        relay.getPVTAccrual.mockReset();
    });

    it('reads with the unlock\'s own biometric action (so a 401 renews without a new prompt) and saves the answer', async () => {
        relay.getPVTAccrual.mockResolvedValue(accrual);
        await checkRelaySessionAtUnlock('0xabc', ACTION);
        expect(relay.getPVTAccrual).toHaveBeenCalledWith(ACTION);
        expect(saved).toEqual([['accrual', '0xabc', accrual]]);
    });

    it('saves nothing when the relay does not answer, and never throws', async () => {
        relay.getPVTAccrual.mockRejectedValue(new Error('offline'));
        await expect(checkRelaySessionAtUnlock('0xabc', ACTION)).resolves.toBeUndefined();
        relay.getPVTAccrual.mockResolvedValue(null);
        await checkRelaySessionAtUnlock('0xabc', ACTION);
        expect(saved).toEqual([]);
    });

    it('never holds the unlock past its bound', async () => {
        relay.getPVTAccrual.mockImplementation(() => new Promise(() => undefined));
        const started = Date.now();
        await checkRelaySessionAtUnlock('0xabc', ACTION, 20);
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(saved).toEqual([]);
    });

    it('does nothing for a wallet with no relay account yet or no address', async () => {
        relay.isRegistered.mockResolvedValue(false);
        await checkRelaySessionAtUnlock('0xabc', ACTION);
        await checkRelaySessionAtUnlock(null, ACTION);
        expect(relay.getPVTAccrual).not.toHaveBeenCalled();
    });
});

import { readFileSync } from 'node:fs';
import { prepareRenewalAtUnlock, renewRejectedSessionAfterUnlock, type UnlockRelay } from './phoneMeterRuntime';

function fakeRelay(state: { rejected?: boolean; acceptedSince?: boolean; sign?: () => Promise<boolean> } = {}) {
    const r = {
        isRegistered: vi.fn(async () => true),
        relaySessionRejected: vi.fn(() => state.rejected ?? false),
        sessionAcceptedSince: vi.fn((_since: number) => state.acceptedSince ?? false),
        prepareSessionRenewal: vi.fn((_a: string, _b: BiometricAction) => (state.sign ?? (async () => true))()),
        renewWithPresignedProof: vi.fn(async (_a: string) => true),
    } satisfies UnlockRelay;
    return r;
}

describe('the unlock: no relay wait, renewal pre-signed when the session is not confirmed', () => {
    it('a session the relay accepted since the lock screen appeared: nothing signed', async () => {
        const r = fakeRelay({ acceptedSince: true });
        await expect(prepareRenewalAtUnlock('0xabc', ACTION, r, 100)).resolves.toBe('healthy');
        expect(r.sessionAcceptedSince).toHaveBeenCalledWith(100);
        expect(r.prepareSessionRenewal).not.toHaveBeenCalled();
    });

    it('rejected or not answered yet: a proof is signed with the unlock\'s own action', async () => {
        for (const state of [{ rejected: true }, {}]) {
            const r = fakeRelay(state);
            await expect(prepareRenewalAtUnlock('0xabc', ACTION, r, 100)).resolves.toBe('signed');
            expect(r.prepareSessionRenewal).toHaveBeenCalledWith('0xabc', ACTION);
        }
    });

    it('signing is bounded: a slow signature never holds the unlock past its bound', async () => {
        const r = fakeRelay({ sign: () => new Promise<boolean>(() => undefined) });
        const started = Date.now();
        await expect(prepareRenewalAtUnlock('0xabc', ACTION, r, 100, 20)).resolves.toBe('skipped');
        expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('no address or no relay account: nothing to do', async () => {
        const r = fakeRelay();
        await expect(prepareRenewalAtUnlock(null, ACTION, r, 100)).resolves.toBe('skipped');
        r.isRegistered.mockResolvedValue(false);
        await expect(prepareRenewalAtUnlock('0xabc', ACTION, r, 100)).resolves.toBe('skipped');
        expect(r.prepareSessionRenewal).not.toHaveBeenCalled();
    });

    it('after landing, a session the relay rejected renews with the proof; a healthy one is left alone', async () => {
        const rejected = fakeRelay({ rejected: true });
        await expect(renewRejectedSessionAfterUnlock('0xabc', rejected)).resolves.toBe(true);
        expect(rejected.renewWithPresignedProof).toHaveBeenCalledWith('0xabc');
        const healthy = fakeRelay();
        await expect(renewRejectedSessionAfterUnlock('0xabc', healthy)).resolves.toBe(false);
        expect(healthy.renewWithPresignedProof).not.toHaveBeenCalled();
    });

    it('wiring: the lock screen checks first; the unlock signs, lands, and awaits nothing after landing', () => {
        const lock = readFileSync('src/screens/Security/WalletLockScreen.tsx', 'utf8');
        const runtime = readFileSync('src/core/meter/phoneMeterRuntime.ts', 'utf8');
        expect(lock).toMatch(/probeRelaySessionAtLock\(useWalletStore\.getState\(\)\.address\)/);
        const sign = lock.indexOf('await prepareRenewalAtUnlock(');
        const land = lock.indexOf('landAfterUnlock(navigation, seedUnreadable');
        expect(sign).toBeGreaterThan(0);
        expect(land).toBeGreaterThan(sign);
        const afterLand = lock.slice(land, lock.indexOf('}, undefined);', land));
        expect(afterLand).not.toMatch(/await /);
        expect(afterLand).toMatch(/void renewRejectedSessionAfterUnlock\(wallet\)/);
        const unlocked = runtime.slice(runtime.indexOf('export async function onWalletUnlocked'));
        expect(unlocked).not.toMatch(/checkRelaySessionAtUnlock/);
    });
});
