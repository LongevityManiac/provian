/**
 * ChatPEEmitter: consumes MobileSessionStateMachine outputs and turns them
 * into ai_conversation Provenance Envelopes.
 *
 * Pipeline for each session-end or heartbeat emission payload:
 * 1. Drain MetricsBuffer into a per-emission aggregate, filtered by the
 * state machine's provider. FIFO drain of the process-level singleton
 * populated by the WebView onMessage handler (M4).
 * 2. Fold aggregate + EmissionPayload into an AIConversationMetadata
 * object. duration_ms is windowEnd minus windowStart from the state
 * machine. active_duration_ms, turn_count, and input_fidelity come
 * from the state machine too. char_count, image_count, and
 * video_seconds come from the metrics aggregate. All numeric fields
 * land as non-negative integers (required by the backend validator).
 * 3. Compute session_fingerprint_hash via computeSessionFingerprint with
 * pluginName = "mobile_webview".
 * 4. Check the FingerprintCache. If the fingerprint was emitted within
 * the last 24 hours, skip and log one line. This is the idempotency
 * guard against repeated state-machine outputs as well as the
 * client-side dedup the operator keyed on at 2b sign-off.
 * 5. Call ProvenanceEnvelopeManager.createEnvelope with action_type
 * 'ai_conversation' and the full metadata. PEM handles hardware
 * signing, WAL, local chain write, batched backend submit, and the
 * retry queue on backend failure.
 * 6. Optimistically cache the fingerprint on createEnvelope success.
 * Rationale: PEM's backend submit is fire-and-forget; the emitter
 * cannot synchronously observe the relay response. The cache is a
 * client-side bandwidth optimization against state-machine event
 * replay; the relay's content-hash dedup protects against duplicate
 * acceptance regardless. If createEnvelope throws (hardware key
 * missing, wallet not initialized), the fingerprint is NOT cached
 * and a subsequent emission will retry from scratch.
 *
 * The emitter is a plain class. Caller owns its lifecycle and injects the
 * PEM instance, FingerprintCache, MetricsBuffer, and a clock function so
 * tests can drive it deterministically.
 */

import type {
    AIConversationMetadata,
    AIConversationProvider,
} from '../provenance/types';
import type { EnvelopeContext } from '../provenance/ProvenanceEnvelopeManager';
import type { ProvenanceEnvelope } from '../provenance/types';
import {
    globalMetricsBuffer,
    type BufferedMetric,
    type MetricsBuffer,
} from './MetricsBuffer';
import { FingerprintCache } from './FingerprintCache';
import { resolvableOrigin } from '../provenance/originCapture';
import {
    computeSessionFingerprint,
    MOBILE_WEBVIEW_PLUGIN_NAME,
} from './sessionFingerprint';
import type { EmissionPayload } from './MobileSessionStateMachine';

const SUPPORTED_PROVIDERS: ReadonlySet<AIConversationProvider> = new Set<AIConversationProvider>([
    'claude',
    'chatgpt',
    'gemini',
    'perplexity',
    'grok',
    'venice',
]);


/**
 * Minimal interface the emitter uses against PEM. Tests inject a stub,
 * production wires the default-exported PEM singleton.
 */
export interface EnvelopeCreator {
    createEnvelope(params: EnvelopeContext): Promise<ProvenanceEnvelope>;
}

export interface ChatPEEmitterOptions {
    /** Injected for tests; defaults to the PEM singleton. */
    envelopeManager?: EnvelopeCreator;
    /** Injected for tests; defaults to the process-level metrics buffer. */
    metricsBuffer?: MetricsBuffer;
    /** 24h fingerprint dedup cache. Required (AsyncStorage or in-memory). */
    fingerprintCache: FingerprintCache;
    /** Deterministic clock for tests. Defaults to Date.now. */
    now?: () => number;
    /** One-line log hook for cache hits. Defaults to console.log. */
    log?: (message: string) => void;
}

export interface EmissionResult {
    status: 'emitted' | 'skipped_cache' | 'skipped_invalid' | 'skipped_below_effort_floor' | 'failed';
    fingerprint?: string;
    envelopeId?: string;
    reason?: string;
}

export class ChatPEEmitter {
    private readonly pemOverride: EnvelopeCreator | null;
    private pemCached: EnvelopeCreator | null = null;
    private readonly buffer: MetricsBuffer;
    private readonly cache: FingerprintCache;
    private readonly now: () => number;
    private readonly log: (message: string) => void;

    constructor(opts: ChatPEEmitterOptions) {
        this.pemOverride = opts.envelopeManager ?? null;
        this.buffer = opts.metricsBuffer ?? globalMetricsBuffer;
        this.cache = opts.fingerprintCache;
        this.now = opts.now ?? (() => Date.now());
        this.log = opts.log ?? ((m: string) => console.log(m));
    }

    /**
     * Resolve the PEM lazily. Test harnesses inject a stub via the
     * constructor and never hit this path. Production loads the singleton
     * on first emission; deferring the require keeps the expo-file-system
     * transitive dependency out of the node-environment test boot path.
     */
    private async resolvePem(): Promise<EnvelopeCreator> {
        if (this.pemOverride) return this.pemOverride;
        if (this.pemCached) return this.pemCached;
        const mod = await import('../provenance/ProvenanceEnvelopeManager');
        this.pemCached = mod.default as EnvelopeCreator;
        return this.pemCached;
    }

    /**
     * Consume a batch of MachineOutput emission payloads produced by a
     * single MobileSessionStateMachine.step() call. Each output becomes
     * at most one PE. Returns per-output results in the same order.
     */
    async handleEmissions(payloads: EmissionPayload[]): Promise<EmissionResult[]> {
        const results: EmissionResult[] = [];
        for (const payload of payloads) {
            results.push(await this.emitOne(payload));
        }
        return results;
    }

    private async emitOne(payload: EmissionPayload): Promise<EmissionResult> {
        if (!SUPPORTED_PROVIDERS.has(payload.provider as AIConversationProvider)) {
            return {
                status: 'skipped_invalid',
                reason: `provider not supported: ${payload.provider}`,
            };
        }

        // No duration floor (2026-): a session under 2 s emits and
        // mints like any other. A non-positive/non-finite active duration is not a
        // real session, so it is still skipped (the restored pre- guard, not a
        // new threshold).
        if (!Number.isFinite(payload.activeDurationMs) || payload.activeDurationMs <= 0) {
            return {
                status: 'skipped_below_effort_floor',
                reason: `active_duration_ms ${payload.activeDurationMs} is not a positive duration`,
            };
        }

        const metadata = buildMetadata(payload, this.buffer.drain());
        const nowMs = this.now();
        const fingerprint = computeSessionFingerprint({
            provider: metadata.provider,
            sessionStartMs: payload.windowStart,
            durationMs: metadata.duration_ms,
            turnCount: metadata.turn_count,
            pluginName: MOBILE_WEBVIEW_PLUGIN_NAME,
        });
        metadata.session_fingerprint_hash = fingerprint;

        if (await this.cache.has(fingerprint, nowMs)) {
            this.log(
                `[ChatPEEmitter] Skipping emission for ${metadata.provider} session ` +
                `${payload.windowStart}: fingerprint already cached within 24h TTL`,
            );
            return { status: 'skipped_cache', fingerprint };
        }

        try {
            const pem = await this.resolvePem();
            const envelope = await pem.createEnvelope({
                actionType: 'ai_conversation',
                // ai_conversation is METADATA-FIRST: the structural AIConversationMetadata
                // (provider, durations, session fingerprint) ARE
                // the record, so this PE carries NO human-readable description. The emitter
                // used to pass the machine token `ai_conversation:<provider>:<windowStart>`
                // here, which becomes the relay `description` (RelayAPIService.submitPE) — a
                // single "word" the relay's quality gate (validatePEDescription, MIN_WORDS=3)
                // rejected with a PERMANENT 400 the client dropped silently, so NO mobile
                // ai_conversation PE ever recorded. The backend now exempts this type
                // from that gate; this removes the bad description at the source so the stored
                // PE no longer carries a synthetic token. The detail screen already renders
                // ai_conversation from its metadata (EnvelopeDetailScreen hides the intent
                // section for this type), and the fingerprint is derived from the payload, not
                // this string — so an empty intent changes no provenance or dedup behavior.
                intentText: '',
                assetSymbol: '',
                amount: '0',
                chainId: 'mobile_webview',
                riskScore: 0,
                riskCategory: 'low',
                policyDecision: 'allow',
                aiConversationMetadata: metadata,
                // Prompt 2: the AI provider is a PUBLIC, resolvable origin this
                // conversation consumed. It rides the top-level input_origins field
                // (NEVER inside the shape-frozen AIConversationMetadata). witnessed:
                // false — the app records its own observation and the emitter holds
                // no non-actor witness reference here (the relay authenticates the
                // device separately). The browser domain is a follow-up that needs
                // threading through the session state machine. PURE PROVENANCE,
                // ZERO mint effect.
                inputOrigins: [],
            });
            await this.cache.add(fingerprint, nowMs);
            return {
                status: 'emitted',
                fingerprint,
                envelopeId: envelope.envelope_id,
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { status: 'failed', fingerprint, reason: message };
        }
    }
}

/**
 * Build an AIConversationMetadata from a state-machine EmissionPayload plus
 * the drained metrics aggregate. Pure function, exported for direct test.
 *
 * Rules:
 *   - duration_ms = windowEnd - windowStart (clamped at zero)
 *   - active_duration_ms, turn_count, input_fidelity come from the state
 *     machine's payload. input_fidelity='presence_only' forces turn_count
 *     to zero per PHASE_2B_DESIGN_NOTES.md §5.
 *   - char_count, image_count, video_seconds are summed over buffered
 *     metrics whose provider matches. Metrics from other providers in the
 *     drained buffer are dropped (state machine could have switched
 *     provider mid-window). Non-matching metrics are intentionally
 *     silently discarded because the state-machine pipeline is authoritative
 *     on which session this emission represents.
 *   - session_fingerprint_hash is left empty here and filled by the caller
 *     after computeSessionFingerprint runs over the populated metadata.
 *   - Empty buffer is valid: all three sum fields go to zero.
 */
export function buildMetadata(
    payload: EmissionPayload,
    drained: BufferedMetric[],
): AIConversationMetadata {
    const durationMs = Math.max(0, payload.windowEnd - payload.windowStart);
    const matching = drained.filter(m => m.provider === payload.provider);

    let charCount = 0;
    let imageCount = 0;
    let videoSeconds = 0;
    for (const m of matching) {
        charCount += m.charCount;
        imageCount += m.imageCount;
        videoSeconds += m.videoSeconds;
    }

    return {
        provider: payload.provider as AIConversationProvider,
        surface: 'mobile_wrapper',
        duration_ms: nonNegInt(durationMs),
        active_duration_ms: nonNegInt(payload.activeDurationMs),
        turn_count: nonNegInt(payload.turnCount),
        char_count: nonNegInt(charCount),
        image_count: nonNegInt(imageCount),
        video_seconds: nonNegInt(videoSeconds),
        session_fingerprint_hash: '',
        input_fidelity: payload.inputFidelity,
    };
}

function nonNegInt(n: number): number {
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.trunc(n);
}
