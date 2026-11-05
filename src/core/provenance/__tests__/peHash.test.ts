/**
 * Canonical PE hash (peHash.ts) — WS1 chain-integrity fix.
 *
 * This is the single source of truth every chain hash flows through. The audit
 * found three divergent copies of hashEnvelope; two used JSON.stringify(pe)
 * which (a) included `signature` and (b) was non-canonical, so the chain head
 * one module wrote could never match the link another verified. These tests pin
 * the two invariants that make the chain consistent:
 *   1. signature is excluded (two envelopes differing only by signature hash equal)
 *   2. output is canonical (key insertion order does not change the hash)
 */
import { describe, it, expect } from 'vitest';
import { hashEnvelopeCanonical } from '../peHash';
import { ProvenanceEnvelope } from '../types';

function baseEnvelope(overrides: Partial<ProvenanceEnvelope> = {}): ProvenanceEnvelope {
    return {
        envelope_id: 'env-1',
        prev_envelope_hash: 'genesis',
        timestamp: 1_700_000_000_000,
        actor_address: '0xabc',
        chain_id: 8453,
        action_type: 'wallet_created',
        intent_text: 'test',
        asset_symbol: 'PVT',
        amount: '0',
        risk_score: 0,
        risk_category: 'low',
        policy_decision: 'allow',
        device_attestation_id: 'dev-1',
        subscription_state_snapshot: 'active',
        null_state_flags: [],
        ...overrides,
    } as ProvenanceEnvelope;
}

describe('hashEnvelopeCanonical', () => {
    it('excludes the signature field from the hash', async () => {
        const unsigned = baseEnvelope();
        const signed = baseEnvelope({ signature: 'a-real-signature' });
        const differentSig = baseEnvelope({ signature: 'a-different-signature' });

        const hUnsigned = await hashEnvelopeCanonical(unsigned);
        const hSigned = await hashEnvelopeCanonical(signed);
        const hDifferentSig = await hashEnvelopeCanonical(differentSig);

        // Signature must not affect the hash — the hash chains, the signature authenticates.
        expect(hSigned).toBe(hUnsigned);
        expect(hDifferentSig).toBe(hUnsigned);
    });

    it('is canonical: key insertion order does not change the hash', async () => {
        const a = baseEnvelope();
        // Rebuild the same logical envelope with keys inserted in a different order.
        const reordered: ProvenanceEnvelope = {
            null_state_flags: [],
            subscription_state_snapshot: 'active',
            device_attestation_id: 'dev-1',
            policy_decision: 'allow',
            risk_category: 'low',
            risk_score: 0,
            amount: '0',
            asset_symbol: 'PVT',
            intent_text: 'test',
            action_type: 'wallet_created',
            chain_id: 8453,
            actor_address: '0xabc',
            timestamp: 1_700_000_000_000,
            prev_envelope_hash: 'genesis',
            envelope_id: 'env-1',
        } as ProvenanceEnvelope;

        expect(await hashEnvelopeCanonical(reordered)).toBe(await hashEnvelopeCanonical(a));
    });

    it('changes when a chained field changes', async () => {
        const a = baseEnvelope();
        const b = baseEnvelope({ amount: '1' });
        const c = baseEnvelope({ prev_envelope_hash: 'something-else' });

        const hA = await hashEnvelopeCanonical(a);
        expect(await hashEnvelopeCanonical(b)).not.toBe(hA);
        expect(await hashEnvelopeCanonical(c)).not.toBe(hA);
    });

    it('produces a stable 64-char hex SHA-256 digest', async () => {
        const h = await hashEnvelopeCanonical(baseEnvelope());
        expect(h).toMatch(/^[0-9a-f]{64}$/);
    });
});
