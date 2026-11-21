/**
 * Records written before 2026-11-11 were signed and then given an `energy_estimate` annotation
 * (never signed). On a real phone all ten such records were reported "tampered" at every launch,
 * and the hot tier, put back out of time order by a failed archival pass, failed the chain check.
 * Verification must check exactly the bytes that were signed, still catch any other change, and
 * walk the chain in time order.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { p256 } from '@noble/curves/p256';
import { ethers } from 'ethers';
import stableStringify from 'json-stable-stringify';

const { mem, key } = vi.hoisted(() => ({ mem: new Map<string, string>(), key: { priv: new Uint8Array(32).fill(7) } }));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (mem.has(k) ? mem.get(k)! : null)),
        setItem: vi.fn(async (k: string, v: string) => { mem.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.delete(k); }),
        multiSet: vi.fn(async (pairs: [string, string][]) => { pairs.forEach(([k, v]) => mem.set(k, v)); }),
    },
}));

function actorAddress(): string {
    const pub = p256.getPublicKey(key.priv, false);
    return ethers.getAddress('0x' + ethers.keccak256(pub.slice(1)).slice(-40));
}

// The production P-256 path: verify r||s over hashMessage(payload) with the device key, and the
// actor address is keccak256(X||Y)[-20:].
vi.mock('../../security/KeyManager', () => ({
    default: {
        verifySignature: vi.fn(async (payload: string, signature: string, expected?: string) => {
            const digest = ethers.getBytes(ethers.hashMessage(payload));
            const ok = p256.verify(p256.Signature.fromCompact(signature.replace(/^0x/, '')).toCompactRawBytes(), digest, p256.getPublicKey(key.priv, false));
            return { isValid: ok && (!expected || expected.toLowerCase() === actorAddress().toLowerCase()), recoveredAddress: null };
        }),
    },
}));
vi.mock('../../footprint/FootprintService', () => ({ ingestPE: vi.fn(), estimateFromPE: vi.fn() }));
vi.mock('../../../services/RelayAPIService', () => ({ default: {} }));
vi.mock('../PELifecycleManager', () => ({ default: { addPEToHotTier: vi.fn(), initialize: vi.fn() } }));

import ProvenanceEnvelopeManager from '../ProvenanceEnvelopeManager';
import { hashEnvelopeCanonical } from '../peHash';
import type { ProvenanceEnvelope } from '../types';
import { setItemHmac } from '../../security/hmacAsyncStorage';
import { GENESIS_PREV_HASH } from '../constants';

function sign(env: Omit<ProvenanceEnvelope, 'signature'>): string {
    const digest = ethers.getBytes(ethers.hashMessage(stableStringify(env) || ''));
    return '0x' + p256.sign(digest, key.priv).toCompactHex();
}

/** Signed, then annotated: the order the pre-2026-11-11 builds wrote them. */
function legacyRecord(id: string, prev: string, timestamp: number): ProvenanceEnvelope {
    const env = {
        envelope_id: id, prev_envelope_hash: prev, timestamp, actor_address: actorAddress(), chain_id: 8453,
        action_type: 'send', intent_text: `Send 100 PVT (${id})`, asset_symbol: 'PVT', amount: '100',
        risk_score: 20, risk_category: 'low', policy_decision: 'allow', device_attestation_id: 'dev',
        subscription_state_snapshot: 'active', null_state_flags: [],
    } as unknown as Omit<ProvenanceEnvelope, 'signature'>;
    const signed = { ...env, signature: sign(env) } as ProvenanceEnvelope;
    (signed as unknown as Record<string, unknown>).energy_estimate = { estimatedWh: 0.005, confidence: 'inferred', method: 'pe-resource-fields', estimatedCO2g: 0.00218 };
    return signed;
}

beforeEach(() => {
    mem.clear();
    const mgr = ProvenanceEnvelopeManager as unknown as { hashCache: Map<string, string>; lastVerifiedIndex: number; lastVerifiedHash: string };
    mgr.hashCache?.clear?.(); mgr.lastVerifiedIndex = -1; mgr.lastVerifiedHash = '';
});

describe('records annotated after signing', () => {
    it('verify over the signed bytes', async () => {
        const r = legacyRecord('a', GENESIS_PREV_HASH, 1);
        expect((await ProvenanceEnvelopeManager.verifyPESignature(r)).isValid).toBe(true);
        expect((await ProvenanceEnvelopeManager.verifyAllPESignatures([r])).tamperedIds).toEqual([]);
    });

    it('still fail when any signed field changed', async () => {
        const r = { ...legacyRecord('a', GENESIS_PREV_HASH, 1), amount: '1000' } as ProvenanceEnvelope;
        expect((await ProvenanceEnvelopeManager.verifyPESignature(r)).isValid).toBe(false);
        expect((await ProvenanceEnvelopeManager.verifyAllPESignatures([r])).tamperedIds).toEqual(['a']);
    });

    it('a record with no annotation and a bad signature still fails', async () => {
        const r = legacyRecord('a', GENESIS_PREV_HASH, 1) as unknown as Record<string, unknown>;
        delete r.energy_estimate;
        r.intent_text = 'changed';
        expect((await ProvenanceEnvelopeManager.verifyPESignature(r as unknown as ProvenanceEnvelope)).isValid).toBe(false);
    });
});

describe('chain check order', () => {
    it('accepts an intact chain stored out of time order (aged records put back after newer ones)', async () => {
        const a = legacyRecord('a', GENESIS_PREV_HASH, 1_000);
        const b = legacyRecord('b', await hashEnvelopeCanonical(a), 2_000);
        const c = legacyRecord('c', await hashEnvelopeCanonical(b), 3_000);
        await setItemHmac('provian_pe_tiered', { version: 1, hotPEs: [c, a, b], coldHashes: [], warmBoundaryHash: GENESIS_PREV_HASH, lastArchivalAt: 0, migrationComplete: true });
        await setItemHmac('provian_pe_chain_head', await hashEnvelopeCanonical(c));
        expect((await ProvenanceEnvelopeManager.verifyChainIntegrity()).valid).toBe(true);
    });

    it('still rejects a broken link in time order', async () => {
        const a = legacyRecord('a', GENESIS_PREV_HASH, 1_000);
        const b = legacyRecord('b', 'not-a', 2_000);
        await setItemHmac('provian_pe_tiered', { version: 1, hotPEs: [b, a], coldHashes: [], warmBoundaryHash: GENESIS_PREV_HASH, lastArchivalAt: 0, migrationComplete: true });
        const result = await ProvenanceEnvelopeManager.verifyChainIntegrity();
        expect(result.valid).toBe(false);
        expect(result.brokenEnvelopeId).toBe('b');
    });
});
