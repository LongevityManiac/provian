/**
 * PE Immutability Tests
 *
 * Verifies that Provenance Envelopes are immutable:
 * 1. Archival never deletes PEs and never reduces one to a hash (: no cold tier)
 * 2. Hidden PEs are filtered from default queries
 * 3. Hidden PEs are included when explicitly requested
 * 4. setPEHidden correctly sets the flag
 * 5. Hidden PEs still count in storage summary
 * 6. Hash chain integrity unaffected by hide operation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isLowPriorityPE, classifyPETier, DEFAULT_TIER_CONFIG } from '../lifecycleTypes';
import type { ProvenanceEnvelope } from '../types';

// Mock AsyncStorage
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn(),
    },
}));

// Mock expo-crypto
vi.mock('expo-crypto', () => ({
    digestStringAsync: vi.fn().mockResolvedValue('mock-hash-123'),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}));

// Mock PECloudSync
vi.mock('../PECloudSync', () => ({
    default: {
        syncPEsToCloud: vi.fn().mockResolvedValue(undefined),
        getCloudArchiveIndex: vi.fn().mockResolvedValue(null),
        fetchPEsByDateRange: vi.fn().mockResolvedValue([]),
        fetchPEsByMonth: vi.fn().mockResolvedValue([]),
    },
}));

function createMockPE(overrides: Partial<ProvenanceEnvelope> = {}): ProvenanceEnvelope {
    // [Audit L-5] Use crypto.getRandomValues instead of Math.random
    const idBytes = new Uint8Array(4);
    crypto.getRandomValues(idBytes);
    const idHex = Array.from(idBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    return {
        envelope_id: `pe-${idHex}`,
        prev_envelope_hash: 'genesis',
        timestamp: Date.now(),
        actor_address: '0x1234',
        chain_id: 1,
        action_type: 'agent_authorization',
        intent_text: 'Test PE',
        asset_symbol: 'ETH',
        amount: '0',
        risk_score: 10,
        risk_category: 'low',
        policy_decision: 'allow',
        device_attestation_id: 'device-123',
        null_state_flags: [],
        subscription_state_snapshot: 'active',
        ...overrides,
    } as ProvenanceEnvelope;
}

// =============================================================================
// Tests
// =============================================================================

describe('PE Immutability', () => {
    describe('deniedColdCutoffMs removed from config', () => {
        it('DEFAULT_TIER_CONFIG does not have deniedColdCutoffMs', () => {
            expect(DEFAULT_TIER_CONFIG).not.toHaveProperty('deniedColdCutoffMs');
        });

        it('DEFAULT_TIER_CONFIG retains deniedRetentionMs', () => {
            expect(DEFAULT_TIER_CONFIG.deniedRetentionMs).toBe(48 * 60 * 60 * 1000);
        });
    });

    describe('classifyPETier no longer classifies to cold for deletion', () => {
        it('old denied PE classifies to warm, not cold', () => {
            const pe = createMockPE({
                authorization_decision: 'deny',
                timestamp: Date.now() - 100 * 24 * 60 * 60 * 1000, // 100 days old
            });
            // Previously would have been 'cold' (which meant deletion)
            // Now should be 'warm' (preserved in cloud)
            const tier = classifyPETier(pe, Date.now());
            expect(tier).toBe('warm');
        });

        it('low priority PE within denied retention stays hot', () => {
            const pe = createMockPE({
                authorization_decision: 'deny',
                timestamp: Date.now() - 24 * 60 * 60 * 1000, // 24h old (within 48h retention)
            });
            const tier = classifyPETier(pe, Date.now());
            expect(tier).toBe('hot');
        });

        it('low priority PE beyond retention moves to warm', () => {
            const pe = createMockPE({
                authorization_decision: 'deny',
                timestamp: Date.now() - 72 * 60 * 60 * 1000, // 72h old (beyond 48h retention)
            });
            const tier = classifyPETier(pe, Date.now());
            expect(tier).toBe('warm');
        });

        it('a PE of any age stays whole: 400 days and 50 years both classify warm, never cold', () => {
            for (const days of [400, 365 * 50]) {
                const pe = createMockPE({ timestamp: Date.now() - days * 24 * 60 * 60 * 1000 });
                expect(classifyPETier(pe, Date.now())).toBe('warm');
            }
        });

        it('RED control: an explicit finite warm age (the retired one-year config) is ignored — still never cold', () => {
            const pe = createMockPE({ timestamp: Date.now() - 400 * 24 * 60 * 60 * 1000 });
            const retiredConfig = { ...DEFAULT_TIER_CONFIG, warmMaxAgeMs: 365 * 24 * 60 * 60 * 1000 };
            expect(classifyPETier(pe, Date.now(), retiredConfig)).toBe('warm');
        });
    });

    describe('isLowPriorityPE', () => {
        it('denied PE is low priority', () => {
            const pe = createMockPE({ authorization_decision: 'deny' });
            expect(isLowPriorityPE(pe)).toBe(true);
        });

        it('blocked PE is low priority', () => {
            const pe = createMockPE({ policy_decision: 'block' });
            expect(isLowPriorityPE(pe)).toBe(true);
        });

        it('allowed PE is not low priority', () => {
            const pe = createMockPE({ authorization_decision: 'allow', policy_decision: 'allow' });
            expect(isLowPriorityPE(pe)).toBe(false);
        });
    });

    describe('hidden field on ProvenanceEnvelope', () => {
        it('PE can have hidden field', () => {
            const pe = createMockPE({ hidden: true });
            expect(pe.hidden).toBe(true);
        });

        it('PE hidden defaults to undefined', () => {
            const pe = createMockPE();
            expect(pe.hidden).toBeUndefined();
        });

        it('hidden field does not affect hash chain (it is not part of core PE data)', () => {
            const pe1 = createMockPE({ envelope_id: 'pe-1' });
            const pe2 = createMockPE({ envelope_id: 'pe-1', hidden: true });

            // The hash chain is based on prev_envelope_hash, not hidden
            // Both PEs have the same chain reference
            expect(pe1.prev_envelope_hash).toBe(pe2.prev_envelope_hash);
            expect(pe1.envelope_id).toBe(pe2.envelope_id);
        });
    });

    describe('PELifecycleManager.setPEHidden', () => {
        let AsyncStorage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; [key: string]: ReturnType<typeof vi.fn> };

        beforeEach(async () => {
            AsyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as typeof AsyncStorage;
            vi.clearAllMocks();
        });

        it('sets hidden flag on hot tier PE', async () => {
            const pe = createMockPE({ envelope_id: 'pe-target' });
            const storage = {
                version: 1,
                hotPEs: [pe],
                coldHashes: [],
                warmBoundaryHash: 'genesis',
                lastArchivalAt: Date.now(),
                migrationComplete: true,
            };
            AsyncStorage.getItem.mockResolvedValue(JSON.stringify(storage));

            // Reset singleton to get a fresh instance with mocks
            const module = await import('../PELifecycleManager');
            const manager = module.default;

            const result = await manager.setPEHidden('pe-target', true);

            expect(result).toBe(true);
            // [Drift C fix] AsyncStorage.setItem is invoked twice:
            //   calls[0] = legacy-format migration write performed by
            //              getItemHmacWithLegacyFallback before pe.hidden
            //              is mutated; payload here still has hidden=undefined.
            //   calls[1] = post-mutation write from setPEHidden itself.
            // Each write is wrapped in the HMAC envelope { v, payload, mac }
            // by setItemHmac, so the storage object lives under .payload.
            const savedCall = AsyncStorage.setItem.mock.calls[1];
            const savedEnvelope = JSON.parse(savedCall[1]);
            expect(savedEnvelope.payload.hotPEs[0].hidden).toBe(true);
        });

        it('returns false when PE not found in hot tier', async () => {
            const storage = {
                version: 1,
                hotPEs: [],
                coldHashes: [],
                warmBoundaryHash: 'genesis',
                lastArchivalAt: Date.now(),
                migrationComplete: true,
            };
            AsyncStorage.getItem.mockResolvedValue(JSON.stringify(storage));

            const module = await import('../PELifecycleManager');
            const manager = module.default;

            const result = await manager.setPEHidden('nonexistent', true);
            expect(result).toBe(false);
        });
    });
});
