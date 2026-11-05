/**
 * Typed wrapper around the ProvianUsageStats Android native module.
 *
 * Three functions matching the Kotlin surface:
 *   - hasUsageStatsPermission(): boolean
 *   - openUsageStatsSettings(): void
 *   - queryAiAppUsage(rangeStartMs, rangeEndMs, packageNames): UsageWindow[]
 *
 * All three are safe to call on iOS. On iOS the module does not exist;
 * calls short-circuit at the JS boundary and return:
 *   - hasUsageStatsPermission()     -> false
 *   - openUsageStatsSettings()      -> undefined (no-op)
 *   - queryAiAppUsage()             -> []
 *
 * Errors from the native module (permission denied, query failure)
 * are caught and translated to the same graceful defaults. The
 * scheduler is then free to treat every return as authoritative
 * without try/catch at every call site.
 */

import { NativeModules, Platform } from 'react-native';

export interface UsageWindow {
    packageName: string;
    totalTimeInForegroundMs: number;
    firstTimeStampMs: number;
    lastTimeStampMs: number;
}

interface NativeUsageEntry {
    package_name: string;
    total_time_in_foreground_ms: number;
    first_time_stamp_ms: number;
    last_time_stamp_ms: number;
}

interface NativeUsageStatsModule {
    hasUsageStatsPermission(): Promise<boolean>;
    openUsageStatsSettings(): Promise<boolean>;
    queryAiAppUsage(
        rangeStartMs: number,
        rangeEndMs: number,
        packageNames: string[],
    ): Promise<NativeUsageEntry[]>;
}

function getNativeModule(): NativeUsageStatsModule | null {
    if (Platform.OS !== 'android') return null;
    const mod = (NativeModules as Record<string, unknown>).ProvianUsageStats as
        | NativeUsageStatsModule
        | undefined;
    return mod ?? null;
}

export async function hasUsageStatsPermission(): Promise<boolean> {
    const mod = getNativeModule();
    if (!mod) return false;
    try {
        return await mod.hasUsageStatsPermission();
    } catch {
        return false;
    }
}

export async function openUsageStatsSettings(): Promise<void> {
    const mod = getNativeModule();
    if (!mod) return;
    try {
        await mod.openUsageStatsSettings();
    } catch {
        // No-op: no-activity or other startActivity failures surface in
        // user-visible logs but must not throw into the UI layer.
    }
}

export async function queryAiAppUsage(
    rangeStartMs: number,
    rangeEndMs: number,
    packageNames: string[],
): Promise<UsageWindow[]> {
    const mod = getNativeModule();
    if (!mod) return [];
    try {
        const entries = await mod.queryAiAppUsage(
            rangeStartMs,
            rangeEndMs,
            packageNames,
        );
        return entries.map(entry => ({
            packageName: entry.package_name,
            totalTimeInForegroundMs: entry.total_time_in_foreground_ms,
            firstTimeStampMs: entry.first_time_stamp_ms,
            lastTimeStampMs: entry.last_time_stamp_ms,
        }));
    } catch {
        return [];
    }
}
