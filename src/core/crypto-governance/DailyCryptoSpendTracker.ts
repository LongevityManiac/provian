/**
 * DailyCryptoSpendTracker (WS5).
 *
 * Persistent per-scope, per-UTC-day accumulator of governed on-chain stablecoin
 * spend (USD). Closes the audit gap where CryptoSpendingGovernance read
 * `metadata.dailyCryptoSpent` but NOTHING ever wrote it — so the daily cap only
 * ever blocked a single tx that alone exceeded the limit, never the cumulative
 * drain-via-many-sub-limit-transfers.
 *
 * Read by the governance engine before evaluating the daily cap; written by the
 * execution paths (WalletConnect send-success, agent transfer-success) AFTER a
 * spend is actually dispatched. Recording is deduped by requestHash so a
 * re-evaluation of the same request cannot double-count.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import securityLog from '../security/securityLogger';

const KEY_PREFIX = 'provian_daily_crypto_spend_';

interface DailyRecord {
    day: string;       // UTC YYYY-MM-DD
    totalUsd: number;
    recordedIds: string[]; // requestHashes already counted today (dedupe)
}

function utcDay(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
}

function scopeKey(scope: string): string {
    return `${KEY_PREFIX}${scope || 'wallet-owner'}`;
}

async function load(scope: string, now: number): Promise<DailyRecord> {
    const today = utcDay(now);
    try {
        const raw = await AsyncStorage.getItem(scopeKey(scope));
        if (raw) {
            const parsed = JSON.parse(raw) as DailyRecord;
            if (parsed.day === today) return parsed;
        }
    } catch {
        // Treat unreadable/corrupt state as a fresh day.
    }
    return { day: today, totalUsd: 0, recordedIds: [] };
}

/** USD already spent (governed) by `scope` today (UTC). */
export async function getDailyCryptoSpentUsd(scope: string, now: number = Date.now()): Promise<number> {
    const rec = await load(scope, now);
    return rec.totalUsd;
}

/**
 * Record `usd` spent by `scope`, deduped by `requestHash`. No-op for
 * non-positive amounts or a requestHash already counted today.
 */
export async function recordDailyCryptoSpendUsd(
    scope: string,
    requestHash: string,
    usd: number,
    now: number = Date.now(),
): Promise<void> {
    if (!(usd > 0)) return;
    const rec = await load(scope, now);
    if (requestHash && rec.recordedIds.includes(requestHash)) return;
    rec.totalUsd += usd;
    if (requestHash) rec.recordedIds.push(requestHash);
    try {
        await AsyncStorage.setItem(scopeKey(scope), JSON.stringify(rec));
    } catch (err) {
        // Best-effort; a failed write means the cap under-counts (fail toward
        // allowing), but the per-transaction cap and friction still apply.
        // Make the failure OBSERVABLE so a persistently-failing accumulator
        // (which silently weakens the daily on-chain cap) is not invisible.
        securityLog.warn(
            'DailyCryptoSpendTracker',
            `Failed to persist daily crypto-spend for scope "${scope}"; daily cap may under-count: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
    }
}

/** Test-only helper to clear an accumulator scope. */
export async function __clearDailyCryptoSpendForTest(scope: string): Promise<void> {
    try { await AsyncStorage.removeItem(scopeKey(scope)); } catch { /* ignore */ }
}
