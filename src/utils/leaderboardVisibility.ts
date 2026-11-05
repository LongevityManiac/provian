/**
 * A leaderboard needs a field to rank. Until the network has this many REAL
 * participants (network-stats `activeWallets` already excludes test wallets),
 * a "top contributors" board just lists everyone — so both boards (Abundance
 * and Commons → People) stay hidden. One constant for both screens.
 */
export const LEADERBOARD_MIN_PARTICIPANTS = 10;

export function shouldShowLeaderboard(activeWallets: number | undefined | null): boolean {
    return typeof activeWallets === 'number' && activeWallets >= LEADERBOARD_MIN_PARTICIPANTS;
}
