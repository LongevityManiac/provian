/**
 * Tests for ChatPEEmitter: metrics buffer drain, fingerprint cache hit/miss,
 * state-machine output translation, idempotency on repeated events, empty
 * buffer edge case.
 *
 * PEM is mocked end-to-end. We do not exercise hardware signing, storage
 * writes, or the backend submit path in these tests; those are covered in
 * ProvenanceEnvelopeManager's own tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    ChatPEEmitter,
    buildMetadata,
    type EnvelopeCreator,
} from '../ChatPEEmitter';
import { MetricsBuffer } from '../MetricsBuffer';
import { FingerprintCache, createMemoryStorage } from '../FingerprintCache';
import type { EmissionPayload } from '../MobileSessionStateMachine';
import type { ProvenanceEnvelope } from '../../provenance/types';
import type { EnvelopeContext } from '../../provenance/ProvenanceEnvelopeManager';

function basePayload(overrides: Partial<EmissionPayload> = {}): EmissionPayload {
    return {
        provider: 'claude',
        sessionId: 'session-1',
        windowStart: 1_000_000,
        windowEnd: 1_180_000,
        inputEventCount: 6,
        turnCount: 3,
        activeDurationMs: 150_000,
        inputFidelity: 'full',
        ...overrides,
    };
}

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

describe('buildMetadata', () => {
    it('sums matching-provider metrics and zero-fills on empty buffer', () => {
        const md = buildMetadata(basePayload(), []);
        expect(md).toEqual({
            provider: 'claude',
            surface: 'mobile_wrapper',
            duration_ms: 180_000,
            active_duration_ms: 150_000,
            turn_count: 3,
            char_count: 0,
            image_count: 0,
            video_seconds: 0,
            session_fingerprint_hash: '',
            input_fidelity: 'full',
        });
    });

    it('sums char_count, image_count, video_seconds across matching metrics only', () => {
        const md = buildMetadata(basePayload(), [
            { provider: 'claude', surface: 'mobile_wrapper', receivedAtMs: 1, turnCount: 1, charCount: 300, imageCount: 1, videoSeconds: 0 },
            { provider: 'claude', surface: 'mobile_wrapper', receivedAtMs: 2, turnCount: 2, charCount: 500, imageCount: 0, videoSeconds: 4 },
            { provider: 'chatgpt', surface: 'mobile_wrapper', receivedAtMs: 3, turnCount: 5, charCount: 9999, imageCount: 10, videoSeconds: 100 },
        ]);
        expect(md.char_count).toBe(800);
        expect(md.image_count).toBe(1);
        expect(md.video_seconds).toBe(4);
    });

    it('clamps duration_ms to zero when windowEnd <= windowStart', () => {
        const md = buildMetadata(basePayload({ windowEnd: 0, windowStart: 100 }), []);
        expect(md.duration_ms).toBe(0);
    });

    it('truncates non-integer or negative numerics to zero safely', () => {
        const md = buildMetadata(
            basePayload({ activeDurationMs: -5, turnCount: 3.9 as unknown as number }),
            [],
        );
        expect(md.active_duration_ms).toBe(0);
        expect(md.turn_count).toBe(3);
    });

    it('mirrors input_fidelity from the state-machine payload', () => {
        const md = buildMetadata(basePayload({ inputFidelity: 'presence_only' }), []);
        expect(md.input_fidelity).toBe('presence_only');
    });
});

describe('ChatPEEmitter - emission path', () => {
    let buffer: MetricsBuffer;
    let cache: FingerprintCache;

    beforeEach(() => {
        buffer = new MetricsBuffer();
        cache = freshCache();
    });

    it('emits a PE with assembled metadata and caches the fingerprint', async () => {
        const { pem, calls } = stubPem();
        buffer.push({
            provider: 'claude', surface: 'mobile_wrapper', receivedAtMs: 1,
            turnCount: 1, charCount: 400, imageCount: 2, videoSeconds: 0,
        });
        const emitter = new ChatPEEmitter({
            envelopeManager: pem, metricsBuffer: buffer, fingerprintCache: cache,
            now: () => 2_000_000,
        });

        const results = await emitter.handleEmissions([basePayload()]);

        expect(results).toHaveLength(1);
        expect(results[0].status).toBe('emitted');
        expect(results[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(results[0].envelopeId).toBe('env-1');

        expect(calls).toHaveLength(1);
        expect(calls[0].actionType).toBe('ai_conversation');
        const md = calls[0].aiConversationMetadata!;
        expect(md.provider).toBe('claude');
        expect(md.surface).toBe('mobile_wrapper');
        expect(md.char_count).toBe(400);
        expect(md.image_count).toBe(2);
        expect(md.duration_ms).toBe(180_000);
        expect(md.session_fingerprint_hash).toBe(results[0].fingerprint);

        expect(await cache.has(results[0].fingerprint!, 2_000_000)).toBe(true);
        expect(buffer.size()).toBe(0);
    });

    it('model provider supplies no input origin; human chat metadata remains', async () => {
        const { pem, calls } = stubPem();
        const emitter = new ChatPEEmitter({
            envelopeManager: pem, metricsBuffer: buffer, fingerprintCache: cache,
            now: () => 2_000_000,
        });
        await emitter.handleEmissions([basePayload()]);

        // EnvelopeContext.inputOrigins is typed `unknown` (it is normalized server-side),
        // so narrow it here for the structural assertions.
        const origins = (calls[0].inputOrigins ?? []) as Array<{ origin_identifier: string; hash: string }>;
        expect(origins).toEqual([]);
        expect(calls[0].aiConversationMetadata!.provider).toBe('claude');
        // input_origins rides the TOP-LEVEL envelope field — never inside the
        // shape-frozen AIConversationMetadata (the backend validator rejects extras).
        expect('input_origins' in (calls[0].aiConversationMetadata as object)).toBe(false);
        // PRIVACY: no URL, path, or session id ever appears in an origin.
        const blob = JSON.stringify(origins);
        expect(blob).not.toMatch(/https?:\/\//);
        expect(blob).not.toContain('/');
        expect(blob).not.toMatch(/session/i);
    });

    it('emits NO human description (the token is gone), provenance intact', async () => {
        // The emitter used to set intentText to `ai_conversation:<provider>:<windowStart>`,
        // which becomes the relay `description` — a single word that failed the relay's
        // MIN_WORDS=3 quality gate with a permanent 400 the client dropped silently, so no
        // mobile ai_conversation PE ever recorded. ai_conversation is metadata-first: the
        // PE carries no human description; its metadata + provider origin ARE the record.
        const { pem, calls } = stubPem();
        const emitter = new ChatPEEmitter({
            envelopeManager: pem, metricsBuffer: buffer, fingerprintCache: cache,
            now: () => 2_000_000,
        });
        await emitter.handleEmissions([basePayload()]);

        expect(calls).toHaveLength(1);
        // Regression guard (the negative control): the single-word machine token must NOT
        // come back — it is exactly what tripped the relay MIN_WORDS=3 gate.
        expect(calls[0].intentText).toBe('');
        expect(calls[0].intentText).not.toMatch(/^ai_conversation:/);
        const words = calls[0].intentText.trim().split(/\s+/).filter(Boolean);
        expect(words.length).toBeLessThan(3);
        // The RECORD is untouched: full metadata + the provider input_origin still ride it.
        expect(calls[0].aiConversationMetadata!.provider).toBe('claude');
        expect(calls[0].aiConversationMetadata!.session_fingerprint_hash).toMatch(/^[0-9a-f]{64}$/);
        const captureOrigins = (calls[0].inputOrigins ?? []) as Array<{ origin_identifier: string; hash: string }>;
        expect(captureOrigins).toEqual([]);
    });

    it('no duration floor (2026-09-12): a sub-2 s session IS emitted; only a non-positive one is skipped (RED control)', async () => {
        // The 2 s floor is gone: a 125 ms session that used to be dropped now
        // emits and mints. The only remaining skip is a non-positive/non-finite
        // duration (the restored pre- guard — that is not a real session).
        const { pem, calls } = stubPem();
        const emitter = new ChatPEEmitter({
            envelopeManager: pem, metricsBuffer: buffer, fingerprintCache: cache,
            now: () => 2_000_000,
        });

        // A 125 ms blip NOW emits (this is the "a chat session under 2 s mints" case).
        const blip = await emitter.handleEmissions([basePayload({ activeDurationMs: 125 })]);
        expect(blip[0].status).toBe('emitted');

        // RED control: a zero-length (non-positive) session is NOT a real session.
        const zero = await emitter.handleEmissions([basePayload({ windowStart: 5_000_000, windowEnd: 5_000_000, activeDurationMs: 0 })]);
        expect(zero[0].status).toBe('skipped_below_effort_floor');

        // A genuine longer session still emits.
        const genuine = await emitter.handleEmissions([basePayload({ windowStart: 6_000_000, windowEnd: 6_020_000, activeDurationMs: 19_307 })]);
        expect(genuine[0].status).toBe('emitted');
        // Two emissions (125 ms + 19,307 ms); the zero-length one was skipped.
        expect(calls).toHaveLength(2);
    });

    it('drains the buffer on every emission (no carryover between calls)', async () => {
        const { pem, calls } = stubPem();
        buffer.push({
            provider: 'claude', surface: 'mobile_wrapper', receivedAtMs: 1,
            turnCount: 1, charCount: 100, imageCount: 0, videoSeconds: 0,
        });
        const emitter = new ChatPEEmitter({
            envelopeManager: pem, metricsBuffer: buffer, fingerprintCache: cache,
            now: () => 3_000_000,
        });

        await emitter.handleEmissions([basePayload()]);
        expect(calls[0].aiConversationMetadata!.char_count).toBe(100);

        // Second emission with no new metrics should see zero counts.
        await emitter.handleEmissions([
            basePayload({ windowStart: 2_000_000, windowEnd: 2_100_000 }),
        ]);
        expect(calls[1].aiConversationMetadata!.char_count).toBe(0);
    });

    it('skips emission when fingerprint already cached within 24h', async () => {
        const { pem, calls } = stubPem();
        const log = vi.fn();
        const emitter = new ChatPEEmitter({
            envelopeManager: pem, metricsBuffer: buffer, fingerprintCache: cache,
            now: () => 5_000_000, log,
        });

        const first = await emitter.handleEmissions([basePayload()]);
        expect(first[0].status).toBe('emitted');
        expect(calls).toHaveLength(1);

        // Same payload + same clock - fingerprint matches, cache hit.
        const second = await emitter.handleEmissions([basePayload()]);
        expect(second[0].status).toBe('skipped_cache');
        expect(second[0].fingerprint).toBe(first[0].fingerprint);
        expect(calls).toHaveLength(1);
        expect(log).toHaveBeenCalledTimes(1);
        expect(log.mock.calls[0][0]).toContain('fingerprint already cached');
    });

    it('idempotent against duplicate emission events in the same batch', async () => {
        const { pem, calls } = stubPem();
        const emitter = new ChatPEEmitter({
            envelopeManager: pem, metricsBuffer: buffer, fingerprintCache: cache,
            now: () => 6_000_000,
        });
        const payload = basePayload();
        const results = await emitter.handleEmissions([payload, payload]);
        expect(results.map(r => r.status)).toEqual(['emitted', 'skipped_cache']);
        expect(calls).toHaveLength(1);
    });

    it('handles empty buffer at session end: all aggregate fields go to zero', async () => {
        const { pem, calls } = stubPem();
        const emitter = new ChatPEEmitter({
            envelopeManager: pem, metricsBuffer: buffer, fingerprintCache: cache,
            now: () => 7_000_000,
        });
        const results = await emitter.handleEmissions([basePayload()]);
        expect(results[0].status).toBe('emitted');
        const md = calls[0].aiConversationMetadata!;
        expect(md.char_count).toBe(0);
        expect(md.image_count).toBe(0);
        expect(md.video_seconds).toBe(0);
    });

    it('does NOT cache fingerprint when createEnvelope throws', async () => {
        const pem: EnvelopeCreator = {
            async createEnvelope(): Promise<ProvenanceEnvelope> {
                throw new Error('hardware key missing');
            },
        };
        const emitter = new ChatPEEmitter({
            envelopeManager: pem, metricsBuffer: buffer, fingerprintCache: cache,
            now: () => 8_000_000,
        });
        const results = await emitter.handleEmissions([basePayload()]);
        expect(results[0].status).toBe('failed');
        expect(results[0].reason).toContain('hardware key missing');
        expect(results[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(await cache.has(results[0].fingerprint!, 8_000_000)).toBe(false);
    });

    it('rejects unknown providers as skipped_invalid', async () => {
        const { pem, calls } = stubPem();
        const emitter = new ChatPEEmitter({
            envelopeManager: pem, metricsBuffer: buffer, fingerprintCache: cache,
            now: () => 9_000_000,
        });
        const results = await emitter.handleEmissions([
            basePayload({ provider: 'mystery' }),
        ]);
        expect(results[0].status).toBe('skipped_invalid');
        expect(calls).toHaveLength(0);
    });

    it('carries presence_only fidelity into metadata and zeros turn_count', async () => {
        const { pem, calls } = stubPem();
        const emitter = new ChatPEEmitter({
            envelopeManager: pem, metricsBuffer: buffer, fingerprintCache: cache,
            now: () => 10_000_000,
        });
        await emitter.handleEmissions([
            basePayload({ inputFidelity: 'presence_only', turnCount: 0, activeDurationMs: 180_000 }),
        ]);
        const md = calls[0].aiConversationMetadata!;
        expect(md.input_fidelity).toBe('presence_only');
        expect(md.turn_count).toBe(0);
        expect(md.active_duration_ms).toBe(180_000);
    });

    it('emits distinct fingerprints for distinct window_start values', async () => {
        const { pem, calls } = stubPem();
        const emitter = new ChatPEEmitter({
            envelopeManager: pem, metricsBuffer: buffer, fingerprintCache: cache,
            now: () => 11_000_000,
        });
        const a = await emitter.handleEmissions([basePayload({ windowStart: 1_000_000 })]);
        const b = await emitter.handleEmissions([basePayload({ windowStart: 2_000_000 })]);
        expect(a[0].status).toBe('emitted');
        expect(b[0].status).toBe('emitted');
        expect(a[0].fingerprint).not.toBe(b[0].fingerprint);
        expect(calls).toHaveLength(2);
    });
});

describe('ChatPEEmitter - static metadata shape check', () => {
    it('assembled metadata satisfies AIConversationMetadata structurally', () => {
        const md = buildMetadata(basePayload(), []);
        const satisfies: {
            provider: string;
            surface: string;
            duration_ms: number;
            active_duration_ms: number;
            turn_count: number;
            char_count: number;
            image_count: number;
            video_seconds: number;
            session_fingerprint_hash: string;
            input_fidelity: string;
        } = md;
        expect(satisfies).toBeDefined();
    });
});
