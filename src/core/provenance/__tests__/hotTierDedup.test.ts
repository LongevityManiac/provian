/**
 * [Audit Pass-3 #40] addPEToHotTier must be idempotent by envelope_id.
 *
 * A partially-flushed batch re-queues its un-written tail and WAL crash-recovery
 * can re-present an already-written PE; without dedup the hot tier physically
 * duplicated a PE (two entries sharing envelope_id/prev_envelope_hash), tripping
 * the tiered-integrity diagnostic.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ProvenanceEnvelope } from '../types';

const { mem } = vi.hoisted(() => ({ mem: new Map<string, string>() }));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (mem.has(k) ? mem.get(k)! : null)),
        setItem: vi.fn(async (k: string, v: string) => { mem.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.delete(k); }),
        clear: vi.fn(async () => { mem.clear(); }),
    },
}));

vi.mock('../PECloudSync', () => ({
    default: {
        syncPEsToCloud: vi.fn().mockResolvedValue(undefined),
        pushToCloud: vi.fn().mockResolvedValue(undefined),
        pullFromCloud: vi.fn().mockResolvedValue([]),
    },
}));

import PELifecycleManager from '../PELifecycleManager';

function pe(id: string, timestamp = 1): ProvenanceEnvelope {
    return {
        envelope_id: id,
        prev_envelope_hash: 'genesis',
        timestamp,
        action_type: 'ai_conversation',
        intent_text: `pe-${id}`,
        actor_address: '0xabc0000000000000000000000000000000000001',
        risk_score: 0,
        risk_category: 'low',
        policy_decision: 'allow',
        device_attestation_id: 'dev-1',
        signature: 'sig',
    } as unknown as ProvenanceEnvelope;
}

beforeEach(() => {
    mem.clear();
    // Reset to defaults so a prior test's tiny cap doesn't leak.
    PELifecycleManager.setConfig({ hotMaxCount: 50000, hotMaxBytes: 50 * 1024 * 1024, warmMaxAgeMs: 365 * 24 * 60 * 60 * 1000 });
});

describe('PELifecycleManager.addPEToHotTier dedup (#40)', () => {
    it('does not physically duplicate a PE re-presented with the same envelope_id', async () => {
        await PELifecycleManager.addPEToHotTier(pe('A'));
        await PELifecycleManager.addPEToHotTier(pe('A')); // re-write (requeue/WAL replay)
        await PELifecycleManager.addPEToHotTier(pe('B'));

        expect(await PELifecycleManager.getHotTierCount()).toBe(2);
        const ids = (await PELifecycleManager.getHotTierPEs()).map(p => p.envelope_id).sort();
        expect(ids).toEqual(['A', 'B']);
    });

    it('[follow-up] does NOT lose the just-pushed PE on the overflow (archival-sweep) branch', async () => {
        // Tiny cap so the 3rd add trips the overflow branch (3 > 0.95*3=2.85),
        // which calls runArchivalSweep — that re-reads storage FRESH from disk.
        // Without persisting the pushed PE first, the 3rd PE would vanish.
        PELifecycleManager.setConfig({ hotMaxCount: 3 });
        const now = Date.now();
        await PELifecycleManager.addPEToHotTier(pe('P1', now)); // recent → stays hot
        await PELifecycleManager.addPEToHotTier(pe('P2', now));
        await PELifecycleManager.addPEToHotTier(pe('P3', now)); // triggers overflow branch

        const ids = (await PELifecycleManager.getHotTierPEs()).map(p => p.envelope_id).sort();
        // All three survive; the overflowing PE is durably persisted, not discarded.
        expect(ids).toEqual(['P1', 'P2', 'P3']);
    });
});
