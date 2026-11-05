import { describe, expect, it } from 'vitest';
import { LEADERBOARD_MIN_PARTICIPANTS, shouldShowLeaderboard } from './leaderboardVisibility';

describe('shouldShowLeaderboard', () => {
    it('hides the board below the participant floor (e.g. just a human and their agent)', () => {
        expect(shouldShowLeaderboard(2)).toBe(false);
        expect(shouldShowLeaderboard(LEADERBOARD_MIN_PARTICIPANTS - 1)).toBe(false);
    });
    it('shows it at and above the floor', () => {
        expect(shouldShowLeaderboard(LEADERBOARD_MIN_PARTICIPANTS)).toBe(true);
        expect(shouldShowLeaderboard(LEADERBOARD_MIN_PARTICIPANTS + 40)).toBe(true);
    });
    it('hides it when the count is unknown (never shows a board it cannot size)', () => {
        expect(shouldShowLeaderboard(undefined)).toBe(false);
        expect(shouldShowLeaderboard(null)).toBe(false);
    });
});
