import * as Crypto from 'expo-crypto';
import stableStringify from 'json-stable-stringify';
import { ProvenanceEnvelope } from './types';

/**
 * Canonical Provenance Envelope hash (PE_PROTOCOL_SPEC.md Section 6).
 *
 * SINGLE SOURCE OF TRUTH for every hash that participates in the chain:
 * `prev_envelope_hash`, `CHAIN_HEAD_KEY`, `warmBoundaryHash`, and cold-tier
 * hashes. `ProvenanceEnvelopeManager`, `PELifecycleManager`, and `PECloudSync`
 * MUST all hash through this function — historically each had its own copy and
 * two of them used `JSON.stringify(pe)` (which (a) INCLUDES `signature` and
 * (b) is not canonically ordered), so the chain head written by one component
 * could never match the link another verified. That divergence silently broke
 * the hot-tier chain check, the hot→warm boundary check, and post-recovery
 * head derivation.
 *
 * Rules (do not change without updating PE_PROTOCOL_SPEC.md and all conforming
 * implementations):
 *  - EXCLUDE the `signature` field. The signature authenticates the envelope;
 *    the hash chains it. Hashing must be reproducible by any verifier that has
 *    the envelope but did not produce the signature.
 *  - Use canonical JSON ordering (`json-stable-stringify`) so output is stable
 *    across platforms and serialization cycles.
 */
export async function hashEnvelopeCanonical(envelope: ProvenanceEnvelope): Promise<string> {
    const { signature: _signature, ...withoutSignature } = envelope;
    const serialized = stableStringify(withoutSignature);
    if (!serialized) {
        throw new Error('Failed to serialize envelope for hashing');
    }
    return Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        serialized
    );
}
