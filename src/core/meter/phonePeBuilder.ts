/**
 * PE METER (app) — building the phone's PE v2.
 *
 * Every act the app records produces one PE v2, hashed and chained on THIS device
 * (`prev_hash` = the previous PE's `peHashOf`, 'genesis' first). What goes in it:
 *
 * identity schema, pe_id (= the act's envelope id), device_id (the relay device id the
 * phone's wallet-auth token carries — the batch must name the same device),
 * prev_hash, timestamp, action_type
 * free text description (the act's intent text) — inside the PE and its hash, never sent:
 * `actRecordOf` leaves it out of the act record the relay prices
 * pricing EXACTLY the fields the relay's phone lane reads (provian-backend
 * core/meter/mobile-act.ts) — the same fields the retired single-PE submit body
 * carried: attestation_depth, ai_conversation_metadata, approval_metadata,
 * corroboration_metadata, promise_id, counterparty_address, input_origins,
 * tx_hash + chain_id, hardware_witness
 * detail_hash the canonical hash of the act's full on-phone record (the signed envelope the
 * app's screens show), so the PE commits to that record without the relay ever
 * seeing it. The full record is kept beside the PE in the store and in the backup.
 *
 * Nothing else from the full record is put in the PE: risk scores, amounts, agreement terms,
 * message recipients and the like are private to the person and were never sent to the relay;
 * putting them in the PE would make them pricing inputs that leave the phone.
 *
 * A hardware witness (App Attest), when this phone has one, signs `hardwareNonceOfAct` over the PE
 * WITHOUT its witness slot — identity plus pricing inputs, bound to this exact chain position
 * (byte-identical to the relay's admission and the SDK builder).
 *
 * The PE's `signature` is this device's PE attestation key (P-256, hardware-held) over pe_hash.
 * It identifies the device; it is never the wallet key.
 */

import {blindDetailHash,privateCommitmentOpening,sealPrivatePricing} from './privatePricing';
import { isEvmTxHash } from '../provenance/txHash';
import type { ProvenanceEnvelope } from '../provenance/types';
import { actRecordOf, canonicalJson, hardwareNonceOfAct, peHashOf, PE_V2_SCHEMA, type PeV2 } from './meter-wire';
import type { StoredPeV2 } from './phonePeStore';

/** The pricing fields a phone PE may carry (the relay's phone lane reads exactly these). */
export const PHONE_PRICING_FIELDS: readonly string[] = [
    'attestation_depth',
    'ai_conversation_metadata',
    'approval_metadata',
    'corroboration_metadata',
    'promise_id',
    'counterparty_address',
    'input_origins',
    'tx_hash',
    'chain_id',
    'hardware_witness',
    'detail_hash',
];

export type HardwareWitnessProvider = (nonceHex: string) => Promise<unknown | null>;
export type PeSigner = (peHash: string) => Promise<string | null>;

/** The pricing projection of one full on-phone record. Absent fields are left out entirely. */
export function phonePricingOf(envelope: ProvenanceEnvelope, detailHash: string): Record<string, unknown> {
    const out: Record<string, unknown> = {
        attestation_depth: envelope.device_attestation_depth ?? 'software',
        detail_hash: detailHash,
    };
    if (envelope.ai_conversation_metadata !== undefined && envelope.ai_conversation_metadata !== null) {
        out.ai_conversation_metadata = envelope.ai_conversation_metadata;
    }
    if (envelope.approval_metadata !== undefined && envelope.approval_metadata !== null) out.approval_metadata = envelope.approval_metadata;
    if (envelope.corroboration_metadata !== undefined && envelope.corroboration_metadata !== null) {
        out.corroboration_metadata = envelope.corroboration_metadata;
    }
    if (typeof envelope.promise_id === 'string' && envelope.promise_id.length > 0) out.promise_id = envelope.promise_id;
    if (typeof envelope.counterparty_address === 'string' && envelope.counterparty_address.length > 0) {
        out.counterparty_address = envelope.counterparty_address;
    }
    if (envelope.input_origins !== undefined && envelope.input_origins !== null) out.input_origins = envelope.input_origins;
    if (isEvmTxHash(envelope.tx_hash)) {
        out.tx_hash = envelope.tx_hash;
        const chainId = typeof envelope.chain_id === 'number' ? envelope.chain_id : Number(envelope.chain_id);
        if (Number.isSafeInteger(chainId)) out.chain_id = chainId;
    }
    return out;
}

/**
 * Build one complete PE v2 at a given chain position. Throws on content canonical JSON refuses (a
 * non-finite number): such a PE could never be proven, so it is never recorded.
 */
export async function buildPhonePeV2(input: {
    readonly envelope: ProvenanceEnvelope;
    readonly detailHash: string;
    readonly deviceId: string;
    readonly prevHash: string;
    readonly witness?: HardwareWitnessProvider;
    readonly sign?: PeSigner;
    readonly privacySecret?: string;
}): Promise<StoredPeV2> {
    const env = input.envelope;
    const draft: Record<string, unknown> = {
        ...phonePricingOf(env, input.detailHash),
        schema: PE_V2_SCHEMA,
        pe_id: env.envelope_id,
        device_id: input.deviceId,
        prev_hash: input.prevHash,
        timestamp: env.timestamp,
        action_type: env.action_type,
        ...(typeof env.intent_text === 'string' && env.intent_text.length > 0 ? { description: env.intent_text } : {}),
    };
    if(input.privacySecret) {
        const opening=privateCommitmentOpening(input.privacySecret,env.envelope_id);
        const pricing=phonePricingOf(env,blindDetailHash(input.detailHash,opening));
        draft.private_commitment=opening;
        draft.detail_commitment='provian.detail-commitment.v1';
        draft.detail_hash=pricing.detail_hash;
        draft.private_pricing=sealPrivatePricing(pricing,opening,env.envelope_id);
    }
    canonicalJson(draft);
    const base = JSON.parse(JSON.stringify(draft)) as PeV2;
    let pe: PeV2 = base;
    if (input.witness) {
        try {
            const slot = await input.witness(hardwareNonceOfAct(actRecordOf(base)));
            if (slot !== null && slot !== undefined) pe = JSON.parse(JSON.stringify({ ...base, hardware_witness: slot })) as PeV2;
        } catch {
            // A witness never blocks or fails a record: no slot, ordinary class.
        }
    }
    const peHash = peHashOf(pe);
    let signature: string | null = null;
    if (input.sign) {
        try {
            signature = await input.sign(peHash);
        } catch {
            signature = null; // the chain and the batch never depend on the device signature
        }
    }
    return { ...pe, pe_hash: peHash, ...(signature ? { signature } : {}) } as StoredPeV2;
}
