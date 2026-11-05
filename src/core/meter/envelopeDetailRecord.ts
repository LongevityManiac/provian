/** Read a proof's actual held bytes for detail display; a history row is only an index. */
import type { ProvenanceEnvelope } from '../provenance/types';
import type { PhonePeStore } from './phonePeStore';
import { PE_V2_SCHEMA, type PeV2 } from './meter-wire';

export type EnvelopeDetailView = Omit<Partial<ProvenanceEnvelope>, 'action_type'> & {
    envelope_id: string;
    action_type: string;
    timestamp: number;
};
export interface HeldEnvelopeDetail {
    readonly kind: 'v1' | 'v2';
    readonly envelope: EnvelopeDetailView;
    readonly raw: unknown;
}
const stringOf = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;

export function v2EnvelopeDetail(pe: PeV2): HeldEnvelopeDetail {
    return {
        kind: 'v2', raw: pe,
        envelope: {
            envelope_id: pe.pe_id,
            action_type: pe.action_type,
            timestamp: pe.timestamp,
            prev_envelope_hash: pe.prev_hash,
            actor_address: stringOf(pe.actor_address),
            intent_text: stringOf(pe.description),
            signature: stringOf(pe.signature),
            chain_id: typeof pe.chain_id === 'number' ? pe.chain_id : undefined,
            device_attestation_id: stringOf(pe.device_attestation_id),
        },
    };
}

/** Owner-held records precede the lossy history projection. Nothing here rewrites a sealed PE. */
export async function heldEnvelopeDetail(store: PhonePeStore, id: string): Promise<HeldEnvelopeDetail | null> {
    for (const deviceId of store.deviceIds()) {
        for (const item of await (await store.chain(deviceId)).allPes()) {
            if (item.pe.pe_id !== id) continue;
            // The phone's full v1 detail is committed to by its PE v2's detail_hash.
            if (item.detail) return { kind: 'v1', envelope: item.detail, raw: item.detail };
            return v2EnvelopeDetail(item.pe);
        }
    }
    for (const item of await store.listReceived()) {
        if (item.pe_id !== id) continue;
        const pe = item.pe as Record<string, unknown>;
        if (pe.schema === PE_V2_SCHEMA) return v2EnvelopeDetail(item.pe as PeV2);
        if (typeof pe.action_type !== 'string' || typeof pe.timestamp !== 'number') return null;
        // This is a display model only. Missing fields remain unknown; no auth/trust flags are made.
        return { kind: 'v1', raw: pe, envelope: {
            ...pe as Partial<ProvenanceEnvelope>, envelope_id: id,
            action_type: pe.action_type, timestamp: pe.timestamp,
        } };
    }
    return null;
}
