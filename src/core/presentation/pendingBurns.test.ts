import { describe, it, expect, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(), setItem: vi.fn() } }));

import { obtainRecordedBurn, obtainBroadcastBurn, rememberRecordedBurn, markBurnConsumed, findPendingBurn, BurnStillFinalizingError, isBurnConsumedError, isRevertedBurnError,
    isRevokedBurnError, isTransientRecordError, listPendingBurns, PHANTOM_BURN_AFTER_MS } from './pendingBurns';

const ADDR = '0xAbC0000000000000000000000000000000000001';
const AMT = '15000000000000000000';

function memStorage() {
    const m = new Map<string, string>();
    return { getItem: async (k: string) => m.get(k) ?? null, setItem: async (k: string, v: string) => { m.set(k, v); } };
}
const refused = () => new Error('insufficient_confirmations: 0/12');

describe('pendingBurns — a broadcast burn is never lost or re-burned', () => {
    it('records through the relay hold (until mined) and returns the burnId', async () => {
        const storage = memStorage();
        const burn = vi.fn(async () => ({ txHash: '0xtx1', amountAtomic: AMT }));
        const record = vi.fn().mockRejectedValueOnce(refused()).mockRejectedValueOnce(refused()).mockResolvedValue({ burnId: 'b1' });
        const out = await obtainRecordedBurn({ address: ADDR, amountPvt: '15', amountAtomic: AMT, intervalMs: 0 }, { burn, record, storage, sleep: async () => {} });
        expect(out).toEqual({ burnId: 'b1', txHash: '0xtx1', resumed: false });
        expect(burn).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledTimes(3);
    });

    it('RED (the 2026-09-22 double burn): a record that never finalizes throws, and the NEXT attempt resumes the saved burn — burn() is called exactly once', async () => {
        const storage = memStorage();
        let t = 0;
        const burn = vi.fn(async () => ({ txHash: '0xtx1', amountAtomic: AMT }));
        const record = vi.fn(async (_p: { txHash: string }): Promise<{ burnId: string }> => { throw refused(); });
        const deps = { burn, record, storage, sleep: async () => { t += 10_000; }, now: () => t };
        await expect(obtainRecordedBurn({ address: ADDR, amountPvt: '15', amountAtomic: AMT, deadlineMs: 30_000 }, deps)).rejects.toBeInstanceOf(BurnStillFinalizingError);
        expect(await findPendingBurn(ADDR, AMT, storage)).toMatchObject({ txHash: '0xtx1' });
        record.mockResolvedValueOnce({ burnId: 'b1' });
        const out = await obtainRecordedBurn({ address: ADDR, amountPvt: '15', amountAtomic: AMT }, deps);
        expect(out).toMatchObject({ burnId: 'b1', txHash: '0xtx1', resumed: true });
        expect(burn).toHaveBeenCalledTimes(1);
    });

    it('RED: a non-transient refusal is thrown at once, and the burn stays saved (never dropped)', async () => {
        const storage = memStorage();
        const burn = vi.fn(async () => ({ txHash: '0xtx1', amountAtomic: AMT }));
        const record = vi.fn(async () => { throw new Error('This burn tx was already recorded by a different wallet'); });
        await expect(obtainRecordedBurn({ address: ADDR, amountPvt: '15', amountAtomic: AMT }, { burn, record, storage, sleep: async () => {} })).rejects.toThrow(/different wallet/);
        expect(record).toHaveBeenCalledTimes(1);
        expect(await findPendingBurn(ADDR, AMT, storage)).not.toBeNull();
    });

    it('a recorded-but-unconsumed burn is reused without another record call; consumption forgets it', async () => {
        const storage = memStorage();
        const burn = vi.fn(async () => ({ txHash: '0xtx1', amountAtomic: AMT }));
        const record = vi.fn(async () => ({ burnId: 'b1' }));
        await obtainRecordedBurn({ address: ADDR, amountPvt: '15', amountAtomic: AMT }, { burn, record, storage });
        const again = await obtainRecordedBurn({ address: ADDR, amountPvt: '15', amountAtomic: AMT }, { burn, record, storage });
        expect(again).toMatchObject({ burnId: 'b1', resumed: true });
        expect(record).toHaveBeenCalledTimes(1);
        await markBurnConsumed(ADDR, { burnId: 'b1' }, storage);
        expect(await findPendingBurn(ADDR, AMT, storage)).toBeNull();
        await obtainRecordedBurn({ address: ADDR, amountPvt: '15', amountAtomic: AMT }, { burn, record, storage });
        expect(burn).toHaveBeenCalledTimes(2);
    });

    it('a burn of a different amount is never reused for this one', async () => {
        const storage = memStorage();
        const burn = vi.fn(async (pvt: string) => ({ txHash: `0x${pvt}`, amountAtomic: `${pvt}000000000000000000` }));
        const record = vi.fn(async (p: { txHash: string }) => ({ burnId: p.txHash }));
        await obtainRecordedBurn({ address: ADDR, amountPvt: '5', amountAtomic: '5000000000000000000' }, { burn, record, storage });
        const out = await obtainRecordedBurn({ address: ADDR, amountPvt: '15', amountAtomic: AMT }, { burn, record, storage });
        expect(out).toMatchObject({ txHash: '0x15', resumed: false });
    });

    it('recognizes the relay consumed-burn refusal', () => {
        expect(isBurnConsumedError(new Error('this burn has already been consumed'))).toBe(true);
        expect(isBurnConsumedError(new Error('insufficient_confirmations: 0/12'))).toBe(false);
    });
});

describe('broadcast without waiting; the relay holds the record until the burn is mined ', () => {
    it('obtainRecordedBurn asks the relay to hold the record (await_finality)', async () => {
        const storage = memStorage();
        const burn = vi.fn(async () => ({ txHash: '0xtx1', amountAtomic: AMT }));
        const record = vi.fn(async () => ({ burnId: 'b1' }));
        await obtainRecordedBurn({ address: ADDR, amountPvt: '15', amountAtomic: AMT }, { burn, record, storage });
        expect(record).toHaveBeenCalledWith({ txHash: '0xtx1', chain: 'base', amountAtomic: AMT, awaitFinality: true });
    });

    it('obtainBroadcastBurn saves the burn BEFORE returning and makes no relay call', async () => {
        const storage = memStorage();
        const burn = vi.fn(async () => ({ txHash: '0xtx1', amountAtomic: AMT }));
        const out = await obtainBroadcastBurn({ address: ADDR, amountPvt: '15', amountAtomic: AMT }, { burn, storage });
        expect(out).toEqual({ txHash: '0xtx1', amountAtomic: AMT, resumed: false });
        expect(await findPendingBurn(ADDR, AMT, storage)).toMatchObject({ txHash: '0xtx1' });
    });

    it('RED: a second tap resumes the saved burn (burn() once), and carries its burnId once the relay recorded it', async () => {
        const storage = memStorage();
        const burn = vi.fn(async () => ({ txHash: '0xtx1', amountAtomic: AMT }));
        await obtainBroadcastBurn({ address: ADDR, amountPvt: '15', amountAtomic: AMT }, { burn, storage });
        const again = await obtainBroadcastBurn({ address: ADDR, amountPvt: '15', amountAtomic: AMT }, { burn, storage });
        expect(again).toEqual({ txHash: '0xtx1', amountAtomic: AMT, resumed: true });
        await rememberRecordedBurn(ADDR, '0xtx1', 'b1', storage);
        const third = await obtainBroadcastBurn({ address: ADDR, amountPvt: '15', amountAtomic: AMT }, { burn, storage });
        expect(third).toEqual({ txHash: '0xtx1', amountAtomic: AMT, burnId: 'b1', resumed: true });
        expect(burn).toHaveBeenCalledTimes(1);
    });

    it('RED: a burn the relay reports REVERTED (tx_failed) is forgotten — never resumed — and not retried', async () => {
        const storage = memStorage();
        const burn = vi.fn(async () => ({ txHash: '0xtx1', amountAtomic: AMT }));
        const record = vi.fn(async () => { throw new Error('tx_failed'); });
        await expect(obtainRecordedBurn({ address: ADDR, amountPvt: '15', amountAtomic: AMT }, { burn, record, storage, sleep: async () => {} })).rejects.toThrow(/reverted/);
        expect(record).toHaveBeenCalledTimes(1);
        expect(await findPendingBurn(ADDR, AMT, storage)).toBeNull();
        expect(isRevertedBurnError(new Error('tx_failed'))).toBe(true);
        expect(isRevertedBurnError(new Error('insufficient_confirmations: 3/12'))).toBe(false);
    });

    it('RED : a burn the relay REVOKED (never reached finality) is forgotten — never resumed — and not retried', async () => {
        const storage = memStorage();
        const burn = vi.fn(async () => ({ txHash: '0xtx1', amountAtomic: AMT }));
        const record = vi.fn(async () => { throw new Error('burn_revoked'); });
        await expect(obtainRecordedBurn({ address: ADDR, amountPvt: '15', amountAtomic: AMT }, { burn, record, storage, sleep: async () => {} })).rejects.toThrow(/did not confirm on Base/);
        expect(record).toHaveBeenCalledTimes(1);
        expect(await findPendingBurn(ADDR, AMT, storage)).toBeNull();
        expect(isRevokedBurnError(new Error('This burn did not reach Base finality and was revoked'))).toBe(true);
        expect(isRevokedBurnError(new Error('tx_not_found'))).toBe(false);
        // The consume-path refusal a SAVED, recorded burn meets after revocation.
        expect(isRevokedBurnError(new Error('this burn did not reach Base finality and was revoked (burn_revoked)'))).toBe(true);
        expect(isTransientRecordError(new Error('burn_revoked'))).toBe(false);
    });

    it('a client timeout during the relay hold (an aborted fetch) is transient', () => {
        expect(isTransientRecordError(new Error('Aborted'))).toBe(true);
        expect(isTransientRecordError(new Error('This burn tx was already recorded by a different wallet'))).toBe(false);
    });
});

// a burn saved at broadcast that never mines must not be resumed forever.
describe('uncertain saved burns are recovered without another payment', () => {
    it('unknown after three minutes resumes the original operation and refuses a changed hash', async () => {
        const storage = memStorage();
        let t = 1_000_000;
        const burn = vi.fn().mockResolvedValueOnce({ txHash: '0xold', amountAtomic: AMT }).mockResolvedValueOnce({ txHash: '0xnew', amountAtomic: AMT });
        await obtainBroadcastBurn({ address: ADDR, amountPvt: '15', amountAtomic: AMT }, { burn, storage, now: () => t });
        t += PHANTOM_BURN_AFTER_MS + 1;
        const txStatus = vi.fn(async () => 'unknown' as const);
        await expect(obtainBroadcastBurn({ address: ADDR, amountPvt: '15', amountAtomic: AMT }, { burn, storage, now: () => t, txStatus })).rejects.toThrow('burn_recovery_hash_changed');
        expect(burn.mock.calls[1][1]).toBe(burn.mock.calls[0][1]);
        expect(await listPendingBurns(ADDR, storage)).toEqual([expect.objectContaining({ txHash: '0xold' })]);
    });

    it('a pending or mined burn is resumed, and so is one too young to judge or whose status read fails', async () => {
        for (const [status, age] of [['pending', PHANTOM_BURN_AFTER_MS + 1], ['mined', PHANTOM_BURN_AFTER_MS + 1], ['unknown', 1_000], ['throws', PHANTOM_BURN_AFTER_MS + 1]] as const) {
            const storage = memStorage();
            let t = 1_000_000;
            const burn = vi.fn().mockResolvedValueOnce({ txHash: '0xold', amountAtomic: AMT }).mockResolvedValueOnce({ txHash: '0xold', amountAtomic: AMT });
            await obtainBroadcastBurn({ address: ADDR, amountPvt: '15', amountAtomic: AMT }, { burn, storage, now: () => t });
            t += age;
            const txStatus = vi.fn(async () => { if (status === 'throws') throw new Error('rpc'); return status; });
            const out = await obtainBroadcastBurn({ address: ADDR, amountPvt: '15', amountAtomic: AMT }, { burn, storage, now: () => t, txStatus });
            expect(out).toMatchObject({ txHash: '0xold', resumed: true });
            expect(burn).toHaveBeenCalledTimes(status === 'pending' || status === 'unknown' ? 2 : 1);
            if (burn.mock.calls.length === 2) expect(burn.mock.calls[1][1]).toBe(burn.mock.calls[0][1]);
        }
    });

    it('a RECORDED saved burn is never judged phantom (the relay already verified it)', async () => {
        const storage = memStorage();
        let t = 1_000_000;
        const burn = vi.fn(async () => ({ txHash: '0xold', amountAtomic: AMT }));
        await obtainBroadcastBurn({ address: ADDR, amountPvt: '15', amountAtomic: AMT }, { burn, storage, now: () => t });
        await rememberRecordedBurn(ADDR, '0xold', 'b1', storage);
        t += PHANTOM_BURN_AFTER_MS + 1;
        const txStatus = vi.fn(async () => 'unknown' as const);
        const out = await obtainBroadcastBurn({ address: ADDR, amountPvt: '15', amountAtomic: AMT }, { burn, storage, now: () => t, txStatus });
        expect(out).toMatchObject({ txHash: '0xold', burnId: 'b1' });
        expect(txStatus).not.toHaveBeenCalled();
    });
});
