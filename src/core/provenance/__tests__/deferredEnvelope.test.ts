/**
 * [Audit Pass-3 N3] Durable deferred-PE creation.
 *
 * When createEnvelope throws AFTER a confirmed on-chain action (send/swap), the
 * caller must not silently skip the PE. It enqueues the create params here;
 * retryDeferredEnvelopes re-attempts them on foreground, draining successes and
 * keeping still-failing entries (and everything after) for the next attempt.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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
        signPayload: vi.fn().mockResolvedValue('sig'),
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

vi.mock('../PELifecycleManager', () => ({
    default: { addPEToHotTier: vi.fn(), initialize: vi.fn(), setPEHidden: vi.fn() },
}));

import ProvenanceEnvelopeManager, { EnvelopeContext } from '../ProvenanceEnvelopeManager';

const DEFERRED_KEY = 'provian_pe_deferred_create';

function ctx(i: number): EnvelopeContext {
    return {
        actionType: 'send',
        intentText: `deferred-send-${i}`,
        assetSymbol: 'USDC',
        amount: '5',
        chainId: 8453,
        counterparty: '0xdef0000000000000000000000000000000000002',
        riskScore: 10,
        riskCategory: 'low',
        policyDecision: 'allow',
    };
}

beforeEach(() => {
    mem.clear();
    vi.restoreAllMocks();
});

describe('deferred PE creation (N3)', () => {
    it('enqueueDeferredEnvelope persists the create params durably', async () => {
        await ProvenanceEnvelopeManager.enqueueDeferredEnvelope(ctx(1));
        const stored = JSON.parse(mem.get(DEFERRED_KEY)!);
        expect(stored).toHaveLength(1);
        expect(stored[0].intentText).toBe('deferred-send-1');
    });

    it('retryDeferredEnvelopes creates the PE and drains the queue', async () => {
        const createSpy = vi
            .spyOn(ProvenanceEnvelopeManager, 'createEnvelope')
            .mockResolvedValue({ envelope_id: 'pe-1' } as never);

        await ProvenanceEnvelopeManager.enqueueDeferredEnvelope(ctx(1));
        await ProvenanceEnvelopeManager.enqueueDeferredEnvelope(ctx(2));

        const created = await ProvenanceEnvelopeManager.retryDeferredEnvelopes();
        expect(created).toBe(2);
        expect(createSpy).toHaveBeenCalledTimes(2);
        // Queue fully drained.
        expect(JSON.parse(mem.get(DEFERRED_KEY)!)).toEqual([]);
    });

    it('keeps a still-failing entry (and the tail) queued for the next attempt', async () => {
        await ProvenanceEnvelopeManager.enqueueDeferredEnvelope(ctx(1));
        await ProvenanceEnvelopeManager.enqueueDeferredEnvelope(ctx(2));

        // First entry succeeds, second still fails → keep the second.
        const createSpy = vi
            .spyOn(ProvenanceEnvelopeManager, 'createEnvelope')
            .mockResolvedValueOnce({ envelope_id: 'pe-1' } as never)
            .mockRejectedValueOnce(new Error('hardware key still unavailable'));

        const created = await ProvenanceEnvelopeManager.retryDeferredEnvelopes();
        expect(created).toBe(1);
        expect(createSpy).toHaveBeenCalledTimes(2);
        const remaining = JSON.parse(mem.get(DEFERRED_KEY)!);
        expect(remaining).toHaveLength(1);
        expect(remaining[0].intentText).toBe('deferred-send-2');

        // A later attempt (now succeeding) drains it.
        vi.spyOn(ProvenanceEnvelopeManager, 'createEnvelope').mockResolvedValue({ envelope_id: 'pe-2' } as never);
        const created2 = await ProvenanceEnvelopeManager.retryDeferredEnvelopes();
        expect(created2).toBe(1);
        expect(JSON.parse(mem.get(DEFERRED_KEY)!)).toEqual([]);
    });

    it('retryDeferredEnvelopes is a no-op when nothing is queued', async () => {
        expect(await ProvenanceEnvelopeManager.retryDeferredEnvelopes()).toBe(0);
    });

    it('[follow-up] is re-entrancy guarded: a concurrent second call is a no-op (no duplicate creation)', async () => {
        await ProvenanceEnvelopeManager.enqueueDeferredEnvelope(ctx(1));
        await ProvenanceEnvelopeManager.enqueueDeferredEnvelope(ctx(2));

        // Hold createEnvelope open so the two invocations genuinely overlap.
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const createSpy = vi
            .spyOn(ProvenanceEnvelopeManager, 'createEnvelope')
            .mockImplementation(async () => { await gate; return { envelope_id: 'pe' } as never; });

        const p1 = ProvenanceEnvelopeManager.retryDeferredEnvelopes();
        const p2 = ProvenanceEnvelopeManager.retryDeferredEnvelopes(); // sees the in-flight guard
        release();
        const [c1, c2] = await Promise.all([p1, p2]);

        expect(c2).toBe(0); // second call no-oped
        expect(c1).toBe(2);
        // Each entry created exactly once — NOT 4x (which a missing guard would cause).
        expect(createSpy).toHaveBeenCalledTimes(2);
        expect(JSON.parse(mem.get(DEFERRED_KEY)!)).toEqual([]);
    });

    it('[follow-up] incrementally persists the un-created tail (crash-safe, ≤1 duplicate per crash)', async () => {
        await ProvenanceEnvelopeManager.enqueueDeferredEnvelope(ctx(1));
        await ProvenanceEnvelopeManager.enqueueDeferredEnvelope(ctx(2));
        await ProvenanceEnvelopeManager.enqueueDeferredEnvelope(ctx(3));

        // At the START of createEnvelope call k, the persisted queue reflects the
        // successes so far: entry k is still present (not yet drained), entries
        // <k are gone. A crash here re-creates at most the single in-flight entry.
        const persistedAtCall: number[] = [];
        let n = 0;
        vi.spyOn(ProvenanceEnvelopeManager, 'createEnvelope').mockImplementation(async () => {
            persistedAtCall.push(JSON.parse(mem.get(DEFERRED_KEY)!).length);
            n++;
            return { envelope_id: `pe-${n}` } as never;
        });

        const created = await ProvenanceEnvelopeManager.retryDeferredEnvelopes();
        expect(created).toBe(3);
        // Call 1 sees [1,2,3]; call 2 sees [2,3] (1 drained); call 3 sees [3].
        expect(persistedAtCall).toEqual([3, 2, 1]);
        expect(JSON.parse(mem.get(DEFERRED_KEY)!)).toEqual([]);
    });
});
