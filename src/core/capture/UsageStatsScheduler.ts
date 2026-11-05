/**
 * UsageStatsScheduler (Phase 2c M7, Android-only).
 *
 * Runs while the wallet is foregrounded and consent is true. Every hour
 * it queries `UsageStatsBridge.queryAiAppUsage` for the preceding hour,
 * filtered to the Android package names declared in the provider
 * catalog. For each non-empty window it emits an `ai_conversation` PE
 * with `surface: 'mobile_usage_stats'`, `input_fidelity: 'presence_only'`,
 * and `pluginName: 'mobile_usage_stats'` in the session fingerprint.
 * That plugin name is distinct from `'mobile_webview'` so wrapper and
 * UsageStats PEs for the same time window do not alias in the
 * FingerprintCache.
 *
 * Guards:
 *   - iOS: scheduler is a no-op. `start()` returns without arming.
 *   - Consent: scheduler checks `shouldRunUsageStatsPipeline(consent)`
 *     before every query tick. Flipping the Settings toggle off mid-
 *     session stops emission on the next tick.
 *   - Permission: on every tick, checks `hasUsageStatsPermission()`
 *     first. If the permission was revoked, the scheduler skips the
 *     query entirely.
 *
 * Dedup: the existing 24h `FingerprintCache` (M3). On successful PE
 * emission the fingerprint is cached; a subsequent run with identical
 * inputs finds the cache hit and skips.
 */

import { Platform } from 'react-native';
import type { FingerprintCache } from './FingerprintCache';
import type {
    AIConversationMetadata,
    AIConversationProvider,
} from '../provenance/types';
import type { EnvelopeContext } from '../provenance/ProvenanceEnvelopeManager';
import type { ProvenanceEnvelope } from '../provenance/types';
import { resolvableOrigin } from '../provenance/originCapture';
import {
    hasUsageStatsPermission,
    queryAiAppUsage,
    type UsageWindow,
} from './UsageStatsBridge';
import {
    computeSessionFingerprint,
} from './sessionFingerprint';
import { shouldRunUsageStatsPipeline, getUsageStatsConsent } from './mobileChatConsent';

export const USAGE_STATS_PLUGIN_NAME = 'mobile_usage_stats';

/**
 * Scheduler tick interval: one query every hour while foregrounded.
 * The query window is the last hour, matched to the cadence so we
 * never double-count.
 */
export const USAGE_STATS_TICK_MS = 60 * 60 * 1000;

export interface UsageStatsProviderEntry {
    provider: AIConversationProvider;
    android_package_name: string;
}

export interface EnvelopeCreator {
    createEnvelope(params: EnvelopeContext): Promise<ProvenanceEnvelope>;
}

export interface UsageStatsSchedulerOptions {
    providers: UsageStatsProviderEntry[];
    fingerprintCache: FingerprintCache;
    envelopeManager?: EnvelopeCreator;
    now?: () => number;
    log?: (message: string) => void;
    /**
     * Optional override of the consent reader, only used by tests. In
     * production the scheduler reads the persisted value directly.
     */
    readConsent?: () => Promise<boolean | null | 'loading'>;
    /** Optional override of the permission check, only used by tests. */
    readPermission?: () => Promise<boolean>;
}

export interface TickResult {
    status: 'ok' | 'skipped_platform' | 'skipped_consent' | 'skipped_permission';
    emitted: number;
    skippedDuplicate: number;
    skippedUnknown: number;
    /** foreground windows below the effort floor (never emitted). */
    skippedBelowFloor: number;
}

export class UsageStatsScheduler {
    private readonly providers: UsageStatsProviderEntry[];
    private readonly cache: FingerprintCache;
    private readonly envelopeManagerOverride: EnvelopeCreator | null;
    private envelopeManagerCached: EnvelopeCreator | null = null;
    private readonly now: () => number;
    private readonly log: (message: string) => void;
    private readonly readConsentFn: () => Promise<boolean | null | 'loading'>;
    private readonly readPermissionFn: () => Promise<boolean>;
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(opts: UsageStatsSchedulerOptions) {
        this.providers = opts.providers;
        this.cache = opts.fingerprintCache;
        this.envelopeManagerOverride = opts.envelopeManager ?? null;
        this.now = opts.now ?? (() => Date.now());
        this.log = opts.log ?? ((m: string) => console.log(m));
        this.readConsentFn = opts.readConsent ?? (async () => await getUsageStatsConsent());
        this.readPermissionFn = opts.readPermission ?? hasUsageStatsPermission;
    }

    /**
     * Arm the scheduler. Returns immediately on iOS without scheduling
     * any timer. The caller owns the scheduler's lifecycle and calls
     * `stop()` on app background or shutdown.
     */
    start(): void {
        if (Platform.OS !== 'android') return;
        if (this.timer !== null) return;
        this.timer = setInterval(() => {
            void this.tick();
        }, USAGE_STATS_TICK_MS);
        // Run one tick shortly after arming so the first PE does not wait
        // a full hour. Micro-delay, not zero, to let the caller finish
        // React-side mount work.
        setTimeout(() => {
            void this.tick();
        }, 0);
    }

    stop(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /**
     * One pass: check guards, query the bridge, fold each non-empty
     * window into a PE. Exported for direct test.
     */
    async tick(): Promise<TickResult> {
        if (Platform.OS !== 'android') {
            return { status: 'skipped_platform', emitted: 0, skippedDuplicate: 0, skippedUnknown: 0, skippedBelowFloor: 0 };
        }
        const consent = await this.readConsentFn();
        if (!shouldRunUsageStatsPipeline(consent)) {
            return { status: 'skipped_consent', emitted: 0, skippedDuplicate: 0, skippedUnknown: 0, skippedBelowFloor: 0 };
        }
        const granted = await this.readPermissionFn();
        if (!granted) {
            return { status: 'skipped_permission', emitted: 0, skippedDuplicate: 0, skippedUnknown: 0, skippedBelowFloor: 0 };
        }

        const nowMs = this.now();
        const rangeStart = nowMs - USAGE_STATS_TICK_MS;
        const packageToProvider = new Map<string, AIConversationProvider>();
        const packageNames: string[] = [];
        for (const p of this.providers) {
            packageToProvider.set(p.android_package_name, p.provider);
            packageNames.push(p.android_package_name);
        }

        const windows = await queryAiAppUsage(rangeStart, nowMs, packageNames);

        let emitted = 0;
        let skippedDuplicate = 0;
        let skippedUnknown = 0;
        let skippedBelowFloor = 0;

        for (const window of windows) {
            // No duration floor (2026-): a foreground window under 2 s
            // mints like any other. Only a zero-length (or non-positive) window is
            // skipped — that is not a real session. This is the restored pre-
            // `<= 0` guard, not a new threshold.
            if (!(window.totalTimeInForegroundMs > 0)) {
                skippedBelowFloor += 1;
                continue;
            }
            const provider = packageToProvider.get(window.packageName);
            if (!provider) {
                skippedUnknown += 1;
                continue;
            }
            const result = await this.emitOne(window, provider, nowMs);
            if (result === 'emitted') emitted += 1;
            else if (result === 'duplicate') skippedDuplicate += 1;
        }

        return { status: 'ok', emitted, skippedDuplicate, skippedUnknown, skippedBelowFloor };
    }

    private async emitOne(
        window: UsageWindow,
        provider: AIConversationProvider,
        nowMs: number,
    ): Promise<'emitted' | 'duplicate' | 'failed'> {
        const metadata = buildUsageStatsMetadata(window, provider);
        const fingerprint = computeSessionFingerprint({
            provider: metadata.provider,
            sessionStartMs: window.firstTimeStampMs,
            durationMs: metadata.duration_ms,
            turnCount: metadata.turn_count,
            pluginName: USAGE_STATS_PLUGIN_NAME,
        });
        metadata.session_fingerprint_hash = fingerprint;

        if (await this.cache.has(fingerprint, nowMs)) {
            this.log(
                `[UsageStatsScheduler] Skipping ${provider} window @${window.firstTimeStampMs}: ` +
                `fingerprint already cached within 24h TTL`,
            );
            return 'duplicate';
        }

        try {
            const pem = await this.resolvePem();
            await pem.createEnvelope({
                actionType: 'ai_conversation',
                intentText: `ai_conversation:${provider}:${window.firstTimeStampMs}`,
                assetSymbol: '',
                amount: '0',
                chainId: 'mobile_usage_stats',
                riskScore: 0,
                riskCategory: 'low',
                policyDecision: 'allow',
                aiConversationMetadata: metadata,
                // Token counts are telemetry only. This
                // presence-only surface has no URL, so only the provider is
                // recorded. Top-level input_origins (never inside the frozen
                // metadata); witnessed:false (app's own observation, no non-actor
                // witness ref here). PURE PROVENANCE, ZERO mint effect.
                inputOrigins: [],
            });
            await this.cache.add(fingerprint, nowMs);
            return 'emitted';
        } catch (err) {
            this.log(`[UsageStatsScheduler] createEnvelope failed: ${err instanceof Error ? err.message : String(err)}`);
            return 'failed';
        }
    }

    private async resolvePem(): Promise<EnvelopeCreator> {
        if (this.envelopeManagerOverride) return this.envelopeManagerOverride;
        if (this.envelopeManagerCached) return this.envelopeManagerCached;
        const mod = await import('../provenance/ProvenanceEnvelopeManager');
        this.envelopeManagerCached = mod.default as EnvelopeCreator;
        return this.envelopeManagerCached;
    }
}

/**
 * Build an AIConversationMetadata from a UsageStats window. Pure,
 * exported for direct test. The session_fingerprint_hash is filled by
 * the caller after computeSessionFingerprint runs over the populated
 * metadata.
 *
 * UsageStats has no idle-vs-active distinction, so active_duration_ms
 * is equal to duration_ms (presence_only semantics per
 * PHASE_2B_DESIGN_NOTES.md §5). turn_count, char_count, image_count,
 * and video_seconds are all zero because UsageStats exposes no such
 * signals.
 */
export function buildUsageStatsMetadata(
    window: UsageWindow,
    provider: AIConversationProvider,
): AIConversationMetadata {
    const duration = nonNegInt(window.totalTimeInForegroundMs);
    return {
        provider,
        surface: 'mobile_usage_stats',
        duration_ms: duration,
        active_duration_ms: duration,
        turn_count: 0,
        char_count: 0,
        image_count: 0,
        video_seconds: 0,
        session_fingerprint_hash: '',
        input_fidelity: 'presence_only',
    };
}

function nonNegInt(n: number): number {
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.trunc(n);
}
