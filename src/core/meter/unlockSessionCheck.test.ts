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
