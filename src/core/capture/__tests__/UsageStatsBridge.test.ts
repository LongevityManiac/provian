/**
 * Tests for UsageStatsBridge. Mocks react-native (NativeModules +
 * Platform) so we can drive the Android and iOS paths plus every
 * error case without touching the real native module.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

type HasFn = () => Promise<boolean>;
type OpenFn = () => Promise<boolean>;
type QueryFn = (
    rangeStartMs: number,
    rangeEndMs: number,
    packageNames: string[],
) => Promise<Array<{
    package_name: string;
    total_time_in_foreground_ms: number;
    first_time_stamp_ms: number;
    last_time_stamp_ms: number;
}>>;

interface NativeMock {
    hasUsageStatsPermission: HasFn;
    openUsageStatsSettings: OpenFn;
    queryAiAppUsage: QueryFn;
}

let platformOS: 'android' | 'ios' = 'android';
let nativeModule: NativeMock | null = {
    async hasUsageStatsPermission() { return true; },
    async openUsageStatsSettings() { return true; },
    async queryAiAppUsage() { return []; },
};

vi.mock('react-native', () => ({
    get NativeModules() {
        return nativeModule ? { ProvianUsageStats: nativeModule } : {};
    },
    get Platform() {
        return { OS: platformOS };
    },
}));

import {
    hasUsageStatsPermission,
    openUsageStatsSettings,
    queryAiAppUsage,
} from '../UsageStatsBridge';

beforeEach(() => {
    platformOS = 'android';
    nativeModule = {
        async hasUsageStatsPermission() { return true; },
        async openUsageStatsSettings() { return true; },
        async queryAiAppUsage() { return []; },
    };
});

describe('UsageStatsBridge: Android happy path', () => {
    it('hasUsageStatsPermission forwards the native boolean', async () => {
        nativeModule!.hasUsageStatsPermission = async () => true;
        expect(await hasUsageStatsPermission()).toBe(true);
        nativeModule!.hasUsageStatsPermission = async () => false;
        expect(await hasUsageStatsPermission()).toBe(false);
    });

    it('openUsageStatsSettings invokes the native function', async () => {
        let called = false;
        nativeModule!.openUsageStatsSettings = async () => {
            called = true;
            return true;
        };
        await openUsageStatsSettings();
        expect(called).toBe(true);
    });

    it('queryAiAppUsage maps snake_case native entries to camelCase UsageWindow', async () => {
        nativeModule!.queryAiAppUsage = async () => ([
            {
                package_name: 'com.anthropic.claude',
                total_time_in_foreground_ms: 180_000,
                first_time_stamp_ms: 1_000_000,
                last_time_stamp_ms: 1_180_000,
            },
        ]);
        const windows = await queryAiAppUsage(0, 10_000_000, ['com.anthropic.claude']);
        expect(windows).toEqual([
            {
                packageName: 'com.anthropic.claude',
                totalTimeInForegroundMs: 180_000,
                firstTimeStampMs: 1_000_000,
                lastTimeStampMs: 1_180_000,
            },
        ]);
    });

    it('queryAiAppUsage forwards the arguments to the native module', async () => {
        let captured: { start?: number; end?: number; pkgs?: string[] } = {};
        nativeModule!.queryAiAppUsage = async (start, end, pkgs) => {
            captured = { start, end, pkgs };
            return [];
        };
        await queryAiAppUsage(100, 200, ['a', 'b']);
        expect(captured.start).toBe(100);
        expect(captured.end).toBe(200);
        expect(captured.pkgs).toEqual(['a', 'b']);
    });
});

describe('UsageStatsBridge: iOS short-circuit', () => {
    beforeEach(() => {
        platformOS = 'ios';
    });

    it('hasUsageStatsPermission returns false without calling native', async () => {
        nativeModule!.hasUsageStatsPermission = async () => {
            throw new Error('should not be called on iOS');
        };
        expect(await hasUsageStatsPermission()).toBe(false);
    });

    it('openUsageStatsSettings no-ops without calling native', async () => {
        nativeModule!.openUsageStatsSettings = async () => {
            throw new Error('should not be called on iOS');
        };
        await expect(openUsageStatsSettings()).resolves.toBeUndefined();
    });

    it('queryAiAppUsage returns [] without calling native', async () => {
        nativeModule!.queryAiAppUsage = async () => {
            throw new Error('should not be called on iOS');
        };
        expect(await queryAiAppUsage(0, 100, ['x'])).toEqual([]);
    });
});

describe('UsageStatsBridge: Android native failures', () => {
    it('hasUsageStatsPermission returns false when native throws', async () => {
        nativeModule!.hasUsageStatsPermission = async () => {
            throw new Error('boom');
        };
        expect(await hasUsageStatsPermission()).toBe(false);
    });

    it('openUsageStatsSettings swallows NO_ACTIVITY errors', async () => {
        nativeModule!.openUsageStatsSettings = async () => {
            throw new Error('NO_ACTIVITY: Usage access settings not available');
        };
        await expect(openUsageStatsSettings()).resolves.toBeUndefined();
    });

    it('queryAiAppUsage returns [] on PERMISSION_DENIED', async () => {
        nativeModule!.queryAiAppUsage = async () => {
            throw new Error('PERMISSION_DENIED');
        };
        expect(await queryAiAppUsage(0, 100, ['x'])).toEqual([]);
    });

    it('queryAiAppUsage returns [] on QUERY_FAILED', async () => {
        nativeModule!.queryAiAppUsage = async () => {
            throw new Error('QUERY_FAILED: some message');
        };
        expect(await queryAiAppUsage(0, 100, ['x'])).toEqual([]);
    });
});

describe('UsageStatsBridge: missing native module', () => {
    it('Android without the native module behaves like iOS', async () => {
        platformOS = 'android';
        nativeModule = null;
        expect(await hasUsageStatsPermission()).toBe(false);
        await expect(openUsageStatsSettings()).resolves.toBeUndefined();
        expect(await queryAiAppUsage(0, 100, ['x'])).toEqual([]);
    });
});
