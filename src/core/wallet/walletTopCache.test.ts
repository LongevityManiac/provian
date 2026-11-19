import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => storage.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { storage.set(k, v); }),
    },
}));

import {
    isSavedAccrual, isSavedAgentList, isSavedCount, readWalletTop, saveWalletTop, walletTopStorageKey,
} from './walletTopCache';

const ALICE = '0xAbC0000000000000000000000000000000000001';
const BOB = '0xabc0000000000000000000000000000000000002';
const accrual = { totalPEs: 10811, weeklyPEs: 40, currentSettlementProjection: { available: true, totalPVT: '512.3' } };

describe('wallet-top saved answers', () => {
    beforeEach(() => storage.clear());

    it('reads back what it saved, for the same wallet in any letter case', async () => {
        await saveWalletTop('accrual', ALICE, accrual, 1_000);
        await expect(readWalletTop('accrual', ALICE.toLowerCase(), isSavedAccrual))
            .resolves.toEqual({ value: accrual, savedAtMs: 1_000 });
    });

    it('never shows one wallet\'s answer on another', async () => {
        await saveWalletTop('accrual', ALICE, accrual, 1_000);
        await expect(readWalletTop('accrual', BOB, isSavedAccrual)).resolves.toBeNull();
        await expect(readWalletTop('accrual', null, isSavedAccrual)).resolves.toBeNull();
        expect(walletTopStorageKey('accrual', ALICE)).not.toBe(walletTopStorageKey('accrual', BOB));
    });

    it('refuses a stored value of the wrong shape, corrupt JSON, or a missing time', async () => {
        storage.set(walletTopStorageKey('accrual', ALICE), JSON.stringify({ value: { totalPEs: 'many' }, savedAtMs: 1 }));
        await expect(readWalletTop('accrual', ALICE, isSavedAccrual)).resolves.toBeNull();
        storage.set(walletTopStorageKey('accrual', ALICE), '{not json');
        await expect(readWalletTop('accrual', ALICE, isSavedAccrual)).resolves.toBeNull();
        storage.set(walletTopStorageKey('accrual', ALICE), JSON.stringify({ value: accrual }));
        await expect(readWalletTop('accrual', ALICE, isSavedAccrual)).resolves.toBeNull();
    });

    it('shape guards accept real answers and reject violating ones (RED controls)', () => {
        expect(isSavedAccrual(accrual)).toBe(true);
        expect(isSavedAccrual({ ...accrual, currentSettlementProjection: { available: true } })).toBe(false);
        expect(isSavedAccrual({ ...accrual, weeklyPEs: undefined })).toBe(false);
        expect(isSavedAccrual(null)).toBe(false);
        expect(isSavedAgentList([{ agent_id: 'atlas' }])).toBe(true);
        expect(isSavedAgentList([])).toBe(true);
        expect(isSavedAgentList([{ display_name: 'no id' }])).toBe(false);
        expect(isSavedAgentList({ agent_id: 'x' })).toBe(false);
        expect(isSavedCount(3)).toBe(true);
        expect(isSavedCount(-1)).toBe(false);
        expect(isSavedCount(1.5)).toBe(false);
    });
});
