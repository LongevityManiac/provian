import { describe, expect, it } from 'vitest';
import { WORD_GRID, wordGridColumns, wordRoomAt } from './wordGridColumns';

const need = WORD_GRID.longestWord * WORD_GRID.fontSize * WORD_GRID.monoAdvance;

describe('recovery-phrase grid fits the longest BIP-39 word at every phone width', () => {
    const widths = [320, 340, 360, 375, 390, 393, 414, 430];
    it.each(widths)('%ipt: the chosen column count leaves room for an eight-letter word', (w) => {
        expect(wordRoomAt(w, wordGridColumns(w))).toBeGreaterThanOrEqual(need);
    });

    it('RED control: the old fixed three columns cut the word off at 320pt', () => {
        // The pre-fix grid always ran three columns; at the smallest supported
        // width that leaves less room than an eight-letter word needs.
        expect(wordRoomAt(320, 3)).toBeLessThan(need);
        expect(wordGridColumns(320)).toBe(2);
    });

    it('wide phones keep three columns', () => {
        expect(wordGridColumns(393)).toBe(3);
    });
});
