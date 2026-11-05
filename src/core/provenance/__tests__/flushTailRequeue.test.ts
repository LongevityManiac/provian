/**
 * [Audit Pass-3 #40] flushQueueInternal must re-queue ONLY the un-written tail.
 *
 * Bug: a mid-batch addPEToHotTier failure re-queued the WHOLE batch, so the
 * already-persisted head was written a SECOND time on the next flush (physical
 * duplicates sharing an envelope_id). Fix tracks writtenCount and re-queues only
 * batch.slice(writtenCount).
 *
 * We drive the manager on the tiered path with a stubbed addPEToHotTier that
 * throws once mid-batch, then assert the already-written head PEs are NOT
 * re-attempted on the subsequent flush.
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

vi.mock('../../security/KeyManager', () => ({
    default: {
        getAddress: vi.fn().mockResolvedValue('0xabc0000000000000000000000000000000000001'),
        hasKey: vi.fn().mockResolvedValue(true),
        generateKey: vi.fn().mockResolvedValue({}),
        performDeviceAttestation: vi.fn().mockResolvedValue({
            deviceId: 'dev-1', isHardwareBacked: true, securityLevel: 'hardware',
        }),
        signPayload: vi.fn().mockResolvedValue('sig-deadbeef'),
        verifySignature: vi.fn().mockResolvedValue({ isValid: true }),
    },
}));

vi.mock('../../footprint/FootprintService', () => ({
    ingestPE: vi.fn().mockResolvedValue(undefined),
    estimateFromPE: vi.fn().mockReturnValue(0),
}));

vi.mock('../../../services/RelayAPIService', () => ({
    default: { submitPE: vi.fn().mockResolvedValue({ outcome: 'recorded', estimated_pvt: 0 }) },
}));

// Record every PE handed to the hot tier and throw exactly once (the 3rd call)
// to simulate a mid-batch disk/quota failure.
const { hotCalls, addPEToHotTier } = vi.hoisted(() => {
    const calls: string[] = [];
    let callNo = 0;
    return {
        hotCalls: calls,
        addPEToHotTier: vi.fn(async (pe: ProvenanceEnvelope) => {
            callNo++;
            if (callNo === 3) throw new Error('simulated hot-tier write failure (#40)');
            calls.push(pe.envelope_id);
        }),
    };
});

vi.mock('../PELifecycleManager', () => ({
    default: { addPEToHotTier, initialize: vi.fn(), setPEHidden: vi.fn() },
}));

import ProvenanceEnvelopeManager, { EnvelopeContext } from '../ProvenanceEnvelopeManager';

function ctx(i: number): EnvelopeContext {
    return {
        actionType: 'ai_conversation',
        intentText: `pe-${i}`,
        assetSymbol: 'NONE',
        amount: '0',
        chainId: 8453,
        riskScore: 0,
        riskCategory: 'low',
        policyDecision: 'allow',
    };
}

beforeEach(() => {
    mem.clear();
    mem.set('provian_pe_migration_complete', 'true'); // tiered path
    hotCalls.length = 0;
    addPEToHotTier.mockClear();
});

describe('flushQueueInternal tail-only requeue (#40)', () => {
    it('re-queues only the un-written tail; the persisted head is never re-attempted', async () => {
        const ids: string[] = [];
        // BATCH_SIZE is 10 — the 10th createEnvelope triggers a flush. The 3rd
        // hot-tier write throws, so PE1..PE2 are written and PE3..PE10 re-queue.
        for (let i = 0; i < 10; i++) {
            const env = await ProvenanceEnvelopeManager.createEnvelope(ctx(i));
            ids.push(env.envelope_id);
        }
        // Two more PEs push the (8 re-queued) pending queue back to 10 → second flush.
        for (let i = 10; i < 12; i++) {
            const env = await ProvenanceEnvelopeManager.createEnvelope(ctx(i));
            ids.push(env.envelope_id);
        }

        const countOf = (id: string) =>
            addPEToHotTier.mock.calls.filter((c) => (c[0] as ProvenanceEnvelope).envelope_id === id).length;

        // The two durably-written head PEs are attempted EXACTLY once (not
        // re-queued). Under the old whole-batch requeue they'd be attempted twice.
        expect(countOf(ids[0])).toBe(1);
        expect(countOf(ids[1])).toBe(1);
        // The PE that failed is retried on the second flush (attempted twice).
        expect(countOf(ids[2])).toBe(2);
        // All 12 PEs end up successfully written exactly once to the hot tier.
        const persisted = new Set(hotCalls);
        for (const id of ids) expect(persisted.has(id)).toBe(true);
        expect(hotCalls.length).toBe(12);
    });
});
