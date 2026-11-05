import { SPACING } from '../../constants/theme';

/**
 * Geometry of one recovery-word cell in ImportRecoveryPhraseScreen. The screen's
 * styles read these same numbers, so the column choice and the rendered cell agree.
 */
export const WORD_GRID = {
    screenPadding: SPACING.l,
    cellMargin: 3,
    cellPaddingLeft: SPACING.s,
    cellPaddingRight: SPACING.s,
    cellBorder: 1,
    numberWidth: 18,
    fontSize: 14,
    /** Monospace advance width as a fraction of the font size (Menlo / Android monospace). */
    monoAdvance: 0.6,
    /** The longest words in the BIP-39 English list have eight letters. */
    longestWord: 8,
} as const;

/** Width left for the typed word inside one cell when the grid runs `columns` across. */
export function wordRoomAt(windowWidth: number, columns: number): number {
    const g = WORD_GRID;
    const cell = (windowWidth - 2 * g.screenPadding) / columns - 2 * g.cellMargin;
    return cell - 2 * g.cellBorder - g.cellPaddingLeft - g.numberWidth - g.cellPaddingRight;
}

/** Three columns where the longest word fits, otherwise two. */
export function wordGridColumns(windowWidth: number): 2 | 3 {
    const need = WORD_GRID.longestWord * WORD_GRID.fontSize * WORD_GRID.monoAdvance;
    return wordRoomAt(windowWidth, 3) >= need ? 3 : 2;
}
