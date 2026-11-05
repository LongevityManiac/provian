/**
 * Tests for UsageStatsScheduler. UsageStatsBridge is mocked with vi.mock
 * so we can drive `queryAiAppUsage` return values and
 * `hasUsageStatsPermission` outcomes. PEM is stubbed via a minimal
 * `EnvelopeCreator`. FingerprintCache is backed by in-memory storage
 * (same helper M6 uses).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

type HasFn = () => Promise<boolean>;
type QueryFn = (
    rangeStartMs: number,
    rangeEndMs: number,
    packageNames: string[],
) => Promise<Array<{
    packageName: string;
    totalTimeInForegroundMs: number;
    firstTimeStampMs: number;
    lastTimeStampMs: number;
}>>;

let hasPermissionImpl: HasFn = async () => true;
let queryImpl: QueryFn = async () => [];

vi.mock('../UsageStatsBridge', () => ({
    hasUsageStatsPermission: () => hasPermissionImpl(),
    queryAiAppUsage: (start: number, end: number, pkgs: string[]) => queryImpl(start, end, pkgs),
    openUsageStatsSettings: async () => {},
}));

let platformOS: 'android' | 'ios' = 'android';
vi.mock('react-native', () => ({
    get Platform() {
        return { OS: platformOS };
    },
}));

import {
    UsageStatsScheduler,
    buildUsageStatsMetadata,
    USAGE_STATS_PLUGIN_NAME,
    USAGE_STATS_TICK_MS,
    type EnvelopeCreator,
    type UsageStatsProviderEntry,
} from '../UsageStatsScheduler';
import { FingerprintCache, createMemoryStorage } from '../FingerprintCache';
import { computeSessionFingerprint } from '../sessionFingerprint';
import type { EnvelopeContext } from '../../provenance/ProvenanceEnvelopeManager';
import type { ProvenanceEnvelope } from '../../provenance/types';

const PROVIDERS: UsageStatsProviderEntry[] = [
    { provider: 'claude', android_package_name: 'com.anthropic.claude' },
    { provider: 'chatgpt', android_package_name: 'com.openai.chatgpt' },
    { provider: 'gemini', android_package_name: 'com.google.android.apps.bard' },
    { provider: 'perplexity', android_package_name: 'ai.perplexity.app.android' },
    { provider: 'grok', android_package_name: 'xai.grok' },
];

function stubPem(): { pem: EnvelopeCreator; calls: EnvelopeContext[] } {
    const calls: EnvelopeContext[] = [];
    const pem: EnvelopeCreator = {
        async createEnvelope(params: EnvelopeContext): Promise<ProvenanceEnvelope> {
            calls.push(params);
            return {
                envelope_id: `env-${calls.length}`,
                prev_envelope_hash: 'genesis',
                timestamp: 0,
                actor_address: '0xdead',
                chain_id: params.chainId,
                action_type: params.actionType,
                intent_text: params.intentText,
                asset_symbol: params.assetSymbol,
                amount: params.amount,
                risk_score: params.riskScore,
                risk_category: params.riskCategory,
                policy_decision: params.policyDecision,
                device_attestation_id: 'device-1',
                subscription_state_snapshot: 'active',
                null_state_flags: [],
                ai_conversation_metadata: params.aiConversationMetadata,
            };
        },
    };
    return { pem, calls };
}

function freshCache(): FingerprintCache {
    return new FingerprintCache({ storage: createMemoryStorage() });
}

beforeEach(() => {
    platformOS = 'android';
    hasPermissionImpl = async () => true;
    queryImpl = async () => [];
});

describe('buildUsageStatsMetadata', () => {
    it('produces presence_only metadata with zero engagement signals', () => {
        const md = buildUsageStatsMetadata(
            {
                packageName: 'com.anthropic.claude',
                totalTimeInForegroundMs: 240_000,
                firstTimeStampMs: 1_000_000,
                lastTimeStampMs: 1_240_000,
            },
            'claude',
        );
        expect(md).toEqual({
            provider: 'claude',
            surface: 'mobile_usage_stats',
            duration_ms: 240_000,
            active_duration_ms: 240_000,
            turn_count: 0,
            char_count: 0,
            image_count: 0,
            video_seconds: 0,
            session_fingerprint_hash: '',
            input_fidelity: 'presence_only',
        });
    });

    it('clamps negative or non-integer durations', () => {
        const md = buildUsageStatsMetadata(
            {
                packageName: 'com.openai.chatgpt',
                totalTimeInForegroundMs: -5,
                firstTimeStampMs: 0,
                lastTimeStampMs: 0,
            },
            'chatgpt',
        );
        expect(md.duration_ms).toBe(0);
        expect(md.active_duration_ms).toBe(0);
    });
});

describe('UsageStatsScheduler.tick: emission path', () => {
    it('emits one PE per non-empty usage window', async () => {
        const { pem, calls } = stubPem();
        const cache = freshCache();
        queryImpl = async () => [
            { packageName: 'com.anthropic.claude', totalTimeInForegroundMs: 180_000, firstTimeStampMs: 1_000_000, lastTimeStampMs: 1_180_000 },
            { packageName: 'com.openai.chatgpt', totalTimeInForegroundMs: 120_000, firstTimeStampMs: 2_000_000, lastTimeStampMs: 2_120_000 },
        ];
        const sched = new UsageStatsScheduler({
            providers: PROVIDERS,
            fingerprintCache: cache,
            envelopeManager: pem,
            now: () => 10_000_000,
            readConsent: async () => true,
            readPermission: async () => true,
        });
        const result = await sched.tick();
        expect(result.status).toBe('ok');
        expect(result.emitted).toBe(2);
        expect(result.skippedDuplicate).toBe(0);
        expect(result.skippedUnknown).toBe(0);
        expect(calls).toHaveLength(2);
        expect(calls[0].actionType).toBe('ai_conversation');
        expect(calls[0].aiConversationMetadata!.surface).toBe('mobile_usage_stats');
        expect(calls[0].aiConversationMetadata!.provider).toBe('claude');
        expect(calls[1].aiConversationMetadata!.provider).toBe('chatgpt');
    });

    it('empty usage array produces zero PEs', async () => {
        const { pem, calls } = stubPem();
        queryImpl = async () => [];
        const sched = new UsageStatsScheduler({
            providers: PROVIDERS,
            fingerprintCache: freshCache(),
            envelopeManager: pem,
            readConsent: async () => true,
            readPermission: async () => true,
        });
        const result = await sched.tick();
        expect(result.status).toBe('ok');
        expect(result.emitted).toBe(0);
        expect(calls).toHaveLength(0);
    });

    it('dedups via fingerprint cache: a second identical tick emits zero', async () => {
        const { pem, calls } = stubPem();
        const cache = freshCache();
        queryImpl = async () => [
            { packageName: 'com.anthropic.claude', totalTimeInForegroundMs: 180_000, firstTimeStampMs: 1_000_000, lastTimeStampMs: 1_180_000 },
        ];
        const sched = new UsageStatsScheduler({
            providers: PROVIDERS,
            fingerprintCache: cache,
            envelopeManager: pem,
            now: () => 10_000_000,
            readConsent: async () => true,
            readPermission: async () => true,
        });
        const first = await sched.tick();
        expect(first.emitted).toBe(1);
        const second = await sched.tick();
        expect(second.emitted).toBe(0);
        expect(second.skippedDuplicate).toBe(1);
        expect(calls).toHaveLength(1);
    });

    it('zero-duration window is skipped (RED control — not a real session)', async () => {
        const { pem, calls } = stubPem();
        queryImpl = async () => [
            { packageName: 'com.anthropic.claude', totalTimeInForegroundMs: 0, firstTimeStampMs: 1_000_000, lastTimeStampMs: 1_000_000 },
        ];
        const sched = new UsageStatsScheduler({
            providers: PROVIDERS,
            fingerprintCache: freshCache(),
            envelopeManager: pem,
            readConsent: async () => true,
            readPermission: async () => true,
        });
        const result = await sched.tick();
        expect(result.emitted).toBe(0);
        expect(calls).toHaveLength(0);
    });

    it('no duration floor (2026-09-12): a short (sub-2 s) positive window IS emitted', async () => {
        // The 2 s floor is gone: a 500 ms foreground window that used to be
        // skipped now emits and mints. Paired with the zero-duration RED control above.
        const { pem, calls } = stubPem();
        queryImpl = async () => [
            { packageName: 'com.anthropic.claude', totalTimeInForegroundMs: 500, firstTimeStampMs: 1_000_000, lastTimeStampMs: 1_000_500 },
        ];
        const sched = new UsageStatsScheduler({
            providers: PROVIDERS,
            fingerprintCache: freshCache(),
            envelopeManager: pem,
            readConsent: async () => true,
            readPermission: async () => true,
        });
        const result = await sched.tick();
        expect(result.emitted).toBe(1);
        expect(calls).toHaveLength(1);
    });

    it('unknown package name (not in catalog) is skipped silently', async () => {
        const { pem, calls } = stubPem();
        queryImpl = async () => [
            { packageName: 'com.evilcorp.stealer', totalTimeInForegroundMs: 999_999, firstTimeStampMs: 1_000_000, lastTimeStampMs: 1_999_999 },
        ];
        const sched = new UsageStatsScheduler({
            providers: PROVIDERS,
            fingerprintCache: freshCache(),
            envelopeManager: pem,
            readConsent: async () => true,
            readPermission: async () => true,
        });
        const result = await sched.tick();
        expect(result.status).toBe('ok');
        expect(result.emitted).toBe(0);
        expect(result.skippedUnknown).toBe(1);
        expect(calls).toHaveLength(0);
    });

    it('metadata carries input_fidelity=presence_only, zero engagement signals, duration equals active_duration', async () => {
        const { pem, calls } = stubPem();
        queryImpl = async () => [
            { packageName: 'xai.grok', totalTimeInForegroundMs: 600_000, firstTimeStampMs: 5_000_000, lastTimeStampMs: 5_600_000 },
        ];
        const sched = new UsageStatsScheduler({
            providers: PROVIDERS,
            fingerprintCache: freshCache(),
            envelopeManager: pem,
            readConsent: async () => true,
            readPermission: async () => true,
        });
        await sched.tick();
        const md = calls[0].aiConversationMetadata!;
        expect(md.input_fidelity).toBe('presence_only');
        expect(md.turn_count).toBe(0);
        expect(md.char_count).toBe(0);
        expect(md.image_count).toBe(0);
        expect(md.video_seconds).toBe(0);
        expect(md.active_duration_ms).toBe(md.duration_ms);
        expect(md.duration_ms).toBe(600_000);
    });

    it('session_fingerprint_hash is computed with pluginName=mobile_usage_stats', async () => {
        const { pem, calls } = stubPem();
        const window = {
            packageName: 'com.anthropic.claude',
            totalTimeInForegroundMs: 180_000,
            firstTimeStampMs: 1_000_000,
            lastTimeStampMs: 1_180_000,
        };
        queryImpl = async () => [window];
        const sched = new UsageStatsScheduler({
            providers: PROVIDERS,
            fingerprintCache: freshCache(),
            envelopeManager: pem,
            now: () => 10_000_000,
            readConsent: async () => true,
            readPermission: async () => true,
        });
        await sched.tick();
        const expected = computeSessionFingerprint({
            provider: 'claude',
            sessionStartMs: 1_000_000,
            durationMs: 180_000,
            turnCount: 0,
            pluginName: USAGE_STATS_PLUGIN_NAME,
        });
        expect(calls[0].aiConversationMetadata!.session_fingerprint_hash).toBe(expected);
        expect(USAGE_STATS_PLUGIN_NAME).toBe('mobile_usage_stats');
    });
});

describe('UsageStatsScheduler.tick: guards', () => {
    it('skips entirely when consent is false', async () => {
        const { pem, calls } = stubPem();
        queryImpl = async () => [
            { packageName: 'com.anthropic.claude', totalTimeInForegroundMs: 180_000, firstTimeStampMs: 1, lastTimeStampMs: 2 },
        ];
        const sched = new UsageStatsScheduler({
            providers: PROVIDERS,
            fingerprintCache: freshCache(),
            envelopeManager: pem,
            readConsent: async () => false,
            readPermission: async () => true,
        });
        const result = await sched.tick();
        expect(result.status).toBe('skipped_consent');
        expect(calls).toHaveLength(0);
    });

    it('skips when consent is null (never decided)', async () => {
        const { pem, calls } = stubPem();
        const sched = new UsageStatsScheduler({
            providers: PROVIDERS,
            fingerprintCache: freshCache(),
            envelopeManager: pem,
            readConsent: async () => null,
            readPermission: async () => true,
        });
        const result = await sched.tick();
        expect(result.status).toBe('skipped_consent');
        expect(calls).toHaveLength(0);
    });

    it('skips when consent is loading', async () => {
        const { pem, calls } = stubPem();
        const sched = new UsageStatsScheduler({
            providers: PROVIDERS,
            fingerprintCache: freshCache(),
            envelopeManager: pem,
            readConsent: async () => 'loading',
            readPermission: async () => true,
        });
        const result = await sched.tick();
        expect(result.status).toBe('skipped_consent');
        expect(calls).toHaveLength(0);
    });

    it('skips when the permission has not been granted', async () => {
        const { pem, calls } = stubPem();
        let queryCalled = false;
        queryImpl = async () => {
            queryCalled = true;
            return [];
        };
        const sched = new UsageStatsScheduler({
            providers: PROVIDERS,
            fingerprintCache: freshCache(),
            envelopeManager: pem,
            readConsent: async () => true,
            readPermission: async () => false,
        });
        const result = await sched.tick();
        expect(result.status).toBe('skipped_permission');
        expect(queryCalled).toBe(false);
        expect(calls).toHaveLength(0);
    });

    it('iOS short-circuit: tick is a no-op', async () => {
        platformOS = 'ios';
        const { pem, calls } = stubPem();
        const sched = new UsageStatsScheduler({
            providers: PROVIDERS,
            fingerprintCache: freshCache(),
            envelopeManager: pem,
            readConsent: async () => true,
            readPermission: async () => true,
        });
        const result = await sched.tick();
        expect(result.status).toBe('skipped_platform');
        expect(calls).toHaveLength(0);
    });
});

describe('UsageStatsScheduler: tick cadence constant', () => {
    it('USAGE_STATS_TICK_MS is one hour', () => {
        expect(USAGE_STATS_TICK_MS).toBe(60 * 60 * 1000);
    });
});

describe('UsageStatsScheduler: start/stop lifecycle', () => {
    it('start() is idempotent: double-calling does not install a second timer', () => {
        vi.useFakeTimers();
        const { pem } = stubPem();
        const sched = new UsageStatsScheduler({
            providers: PROVIDERS,
            fingerprintCache: freshCache(),
            envelopeManager: pem,
            readConsent: async () => true,
            readPermission: async () => true,
        });
        sched.start();
        const timersAfterFirstStart = vi.getTimerCount();
        sched.start();
        const timersAfterSecondStart = vi.getTimerCount();
        expect(timersAfterSecondStart).toBe(timersAfterFirstStart);
        sched.stop();
        vi.useRealTimers();
    });

    it('stop() followed by start() re-arms cleanly', () => {
        vi.useFakeTimers();
        const { pem } = stubPem();
        const sched = new UsageStatsScheduler({
            providers: PROVIDERS,
            fingerprintCache: freshCache(),
            envelopeManager: pem,
            readConsent: async () => true,
            readPermission: async () => true,
        });
        sched.start();
        sched.stop();
        const timersAfterStop = vi.getTimerCount();
        sched.start();
        const timersAfterRestart = vi.getTimerCount();
        expect(timersAfterRestart).toBeGreaterThan(timersAfterStop);
        sched.stop();
        vi.useRealTimers();
    });
});
