import { describe, it, expect, vi, beforeEach } from 'vitest';

const mem = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => mem.get(k) ?? null,
        setItem: async (k: string, v: string) => { mem.set(k, v); },
        removeItem: async (k: string) => { mem.delete(k); },
    },
}));

import { BACKUP_SKIPPED_KEY, checkWords, hasPhraseBackup, markPhraseBackupConfirmed, pickCheckPositions } from './phraseBackup';
import { markBackupRequired, resolveBackupGate } from './cloud/backupRequirement';

const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const ADDRESS = '0x' + 'ab'.repeat(20);

describe('the recovery-phrase fallback', () => {
    beforeEach(() => mem.clear());

    it('asks for three distinct positions, in order', () => {
        const seq = [0.95, 0.95, 0.1, 0.5];
        let i = 0;
        expect(pickCheckPositions(12, () => seq[i++ % seq.length])).toEqual([1, 6, 11]);
        for (let n = 0; n < 50; n += 1) expect(new Set(pickCheckPositions(12)).size).toBe(3);
    });

    it('the right words pass (any case, stray spaces); RED: one wrong, missing or swapped word fails', () => {
        expect(checkWords(WORDS, [0, 5, 11], ['Abandon', ' absent ', 'ACCIDENT'])).toBe(true);
        expect(checkWords(WORDS, [0, 5, 11], ['abandon', 'absent', 'access'])).toBe(false);
        expect(checkWords(WORDS, [0, 5, 11], ['abandon', 'absent'])).toBe(false);
        expect(checkWords(WORDS, [0, 5, 11], ['absent', 'abandon', 'accident'])).toBe(false);
        expect(checkWords(WORDS, [], [])).toBe(false);
    });

    it('a confirmed phrase backup clears the backup gate exactly like a cloud backup', async () => {
        await markBackupRequired(ADDRESS);
        const noCloud = async () => false;
        // RED: owed, no cloud backup, no phrase confirmed → the backup screen.
        expect(await resolveBackupGate(ADDRESS, noCloud)).toBe('backup');
        await markPhraseBackupConfirmed(ADDRESS);
        expect(await hasPhraseBackup(ADDRESS)).toBe(true);
        expect(await resolveBackupGate(ADDRESS, noCloud)).toBe('app');
    });

    it('a confirmed phrase backup clears the "no backup" banner a cloud-less restore set (RED: the flag stays true)', async () => {
        mem.set(BACKUP_SKIPPED_KEY, 'true');
        await markPhraseBackupConfirmed(ADDRESS);
        expect(mem.get(BACKUP_SKIPPED_KEY)).toBe('false');
    });

    it("another wallet's phrase confirmation does not clear this wallet's gate", async () => {
        await markPhraseBackupConfirmed('0x' + 'cd'.repeat(20));
        await markBackupRequired(ADDRESS);
        expect(await resolveBackupGate(ADDRESS, async () => false)).toBe('backup');
    });
});
