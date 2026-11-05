/**
 * PE hash-chain integrity — WS1 behavioral coverage.
 *
 * Proves the audit fixes at the manager level:
 *   1. PEs created within a single flush window chain to EACH OTHER (no fork).
 *      The old code derived prev_envelope_hash from getHistory()[last] (flushed
 *      storage only), so every PE in a batch got the same prev hash.
 *   2. prev_envelope_hash derivation survives archival: with the oldest PEs
 *      shed from storage, a new PE links to the canonical chain head, not
 *      GENESIS.
 *   3. verifyChainIntegrity accepts an archival-truncated chain whose first
 *      retained PE links to the warm boundary (not GENESIS), and still rejects
 *      a chain whose first PE links to neither anchor.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mem } = vi.hoisted(() => ({ mem: new Map<string, string>() }));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (mem.has(k) ? mem.get(k)! : null)),
        setItem: vi.fn(async (k: string, v: string) => { mem.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.delete(k); }),
        clear: vi.fn(async () => { mem.clear(); }),
        multiSet: vi.fn(async (pairs: [string, string][]) => { pairs.forEach(([k, v]) => mem.set(k, v)); }),
    },
}));

// NOTE: vi.mock specifiers resolve relative to THIS test file. The manager
// imports these as '../security/...', '../footprint/...', '../../services/...'
// from src/core/provenance/; from src/core/provenance/__tests__/ that is one
// extra '../'.
vi.mock('../../security/KeyManager', () => ({
    default: {
        getAddress: vi.fn().mockResolvedValue('0xabc0000000000000000000000000000000000001'),
        hasKey: vi.fn().mockResolvedValue(true),
        generateKey: vi.fn().mockResolvedValue({}),
        performDeviceAttestation: vi.fn().mockResolvedValue({
            deviceId: 'dev-1',
            isHardwareBacked: true,
            securityLevel: 'hardware',
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
    default: { submitPE: vi.fn().mockResolvedValue({ estimated_pvt: 0 }) },
}));

// PELifecycleManager is imported by the manager but not exercised on the legacy
// storage path used here; stub it so the test stays isolated.
vi.mock('../PELifecycleManager', () => ({
    default: { addPEToHotTier: vi.fn(), initialize: vi.fn(), setPEHidden: vi.fn() },
}));

import ProvenanceEnvelopeManager, { EnvelopeContext } from '../ProvenanceEnvelopeManager';
import { hashEnvelopeCanonical } from '../peHash';
import { ProvenanceEnvelope } from '../types';
import { setItemHmac } from '../../security/hmacAsyncStorage';
import { GENESIS_PREV_HASH } from '../constants';

const TIERED_KEY = 'provian_pe_tiered';
const CHAIN_HEAD_KEY = 'provian_pe_chain_head';

function ctx(i: number): EnvelopeContext {
    return {
        actionType: 'ai_conversation',
        intentText: `pe-${i}`,
        assetSymbol: 'PVT',
        amount: '0',
        chainId: 8453,
        riskScore: 0,
        riskCategory: 'low',
        policyDecision: 'allow',
    };
}

function seededPE(overrides: Partial<ProvenanceEnvelope>): ProvenanceEnvelope {
    return {
        envelope_id: 'seed',
        prev_envelope_hash: GENESIS_PREV_HASH,
        timestamp: 1_700_000_000_000,
        actor_address: '0xabc',
        chain_id: 8453,
        action_type: 'ai_conversation',
        intent_text: 'seed',
        asset_symbol: 'PVT',
        amount: '0',
        risk_score: 0,
        risk_category: 'low',
        policy_decision: 'allow',
        device_attestation_id: 'dev-1',
        signature: 'sig',
        subscription_state_snapshot: 'active',
        null_state_flags: [],
        ...overrides,
    } as ProvenanceEnvelope;
}

function resetManager(): void {
    const mgr = ProvenanceEnvelopeManager as unknown as {
        pendingQueue: ProvenanceEnvelope[];
        flushTimer: ReturnType<typeof setTimeout> | null;
        hashCache: Map<string, string>;
        lastVerifiedIndex: number;
        lastVerifiedHash: string;
    };
    if (mgr.flushTimer) { clearTimeout(mgr.flushTimer); mgr.flushTimer = null; }
    mgr.pendingQueue = [];
    mgr.hashCache?.clear?.();
    mgr.lastVerifiedIndex = -1;
    mgr.lastVerifiedHash = '';
}

beforeEach(() => {
    mem.clear();
    resetManager();
});

describe('WS1 PE chain integrity', () => {
    it('chains PEs created within one flush window without forking', async () => {
        const created: ProvenanceEnvelope[] = [];
        for (let i = 0; i < 5; i++) {
            created.push(await ProvenanceEnvelopeManager.createEnvelope(ctx(i)));
        }

        // First PE links to genesis (fresh chain).
        expect(created[0].prev_envelope_hash).toBe(GENESIS_PREV_HASH);

        // Each subsequent PE links to the canonical hash of the previous PE —
        // NOT all to the same stored tail (the old fork bug).
        for (let i = 1; i < created.length; i++) {
            expect(created[i].prev_envelope_hash).toBe(await hashEnvelopeCanonical(created[i - 1]));
        }

        // All prev hashes distinct (a fork would repeat the same value).
        const prevHashes = created.map(p => p.prev_envelope_hash);
        expect(new Set(prevHashes).size).toBe(prevHashes.length);
    });

    it('links a new PE to the canonical chain head after archival (not genesis)', async () => {
        // Simulate post-archival state: oldest PEs shed from storage, but the
        // canonical head still points at the true latest PE.
        const archivedTail = seededPE({ envelope_id: 'archived-tail' });
        const headHash = await hashEnvelopeCanonical(archivedTail);
        await setItemHmac(CHAIN_HEAD_KEY, headHash);

        const next = await ProvenanceEnvelopeManager.createEnvelope(ctx(99));

        expect(next.prev_envelope_hash).toBe(headHash);
        expect(next.prev_envelope_hash).not.toBe(GENESIS_PREV_HASH);
    });

    it('verifyChainIntegrity accepts a chain truncated by archival', async () => {
        // Warm boundary = hash of the last archived PE; first retained hot PE
        // links to it (not GENESIS).
        const boundaryPE = seededPE({ envelope_id: 'boundary' });
        const warmBoundaryHash = await hashEnvelopeCanonical(boundaryPE);

        const h1 = seededPE({ envelope_id: 'h1', prev_envelope_hash: warmBoundaryHash, timestamp: 2_000 });
        const h2 = seededPE({ envelope_id: 'h2', prev_envelope_hash: await hashEnvelopeCanonical(h1), timestamp: 3_000 });

        await setItemHmac(TIERED_KEY, {
            version: 1,
            hotPEs: [h1, h2],
            coldHashes: [],
            warmBoundaryHash,
            lastArchivalAt: 0,
            migrationComplete: true,
        });
        await setItemHmac(CHAIN_HEAD_KEY, await hashEnvelopeCanonical(h2));

        const result = await (ProvenanceEnvelopeManager as unknown as {
            verifyChainIntegrity: () => Promise<{ valid: boolean; error?: string }>;
        }).verifyChainIntegrity();

        expect(result.valid).toBe(true);
    });

    it('verifyChainIntegrity still rejects a first PE that links to neither anchor', async () => {
        // First retained PE links to a bogus hash; warm boundary is genesis.
        const bad = seededPE({ envelope_id: 'bad', prev_envelope_hash: 'not-an-anchor', timestamp: 2_000 });

        await setItemHmac(TIERED_KEY, {
            version: 1,
            hotPEs: [bad],
            coldHashes: [],
            warmBoundaryHash: GENESIS_PREV_HASH,
            lastArchivalAt: 0,
            migrationComplete: true,
        });

        const result = await (ProvenanceEnvelopeManager as unknown as {
            verifyChainIntegrity: () => Promise<{ valid: boolean; error?: string }>;
        }).verifyChainIntegrity();

        expect(result.valid).toBe(false);
    });
});
