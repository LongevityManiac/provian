/**
 * The phone's PE v2: exactly the pricing inputs the relay's phone lane reads (the fields the
 * retired single-PE submit used to carry — attestation depth, corroboration, input_origins,
 * tx_hash, …), a commitment to the full on-phone record, and nothing private. These replace the
 * submit-body forwarding tests (attestationDepth / corroborationForward / inputOrigins /
 * txHashForward), which drove the deleted `submitPEToBackend`. RED controls per.
 */
import { describe, it, expect } from 'vitest';
import type { CorroborationSignalPEDetails } from '../../provenance/CorroborationTypes';
import type { InputOrigin } from '../../provenance/types';
import { actRecordOf, hardwareNonceOfAct, peHashOf, PE_V2_SCHEMA, validateBatchShape, buildBatch } from '../meter-wire';
import { buildPhonePeV2, phonePricingOf, PHONE_PRICING_FIELDS } from '../phonePeBuilder';
import { DEVICE, envelope } from './meterTestkit';

const DETAIL = 'd'.repeat(64);
const TX = `0x${'ab'.repeat(32)}`;

describe('phonePricingOf — the relay-read pricing inputs only', () => {
    it('attestation depth: software and hardware are carried as recorded; a missing depth fails closed to software', () => {
        expect(phonePricingOf(envelope({ device_attestation_depth: 'software' }), DETAIL).attestation_depth).toBe('software');
        expect(phonePricingOf(envelope({ device_attestation_depth: 'hardware' }), DETAIL).attestation_depth).toBe('hardware');
        expect(phonePricingOf(envelope({ device_attestation_depth: undefined }), DETAIL).attestation_depth).toBe('software');
    });

    it('never claims the unregistered local device anchor : no device_attestation_id in the PE', async () => {
        const pe = await buildPhonePeV2({ envelope: envelope({ device_attestation_id: 'dev_abc' }), detailHash: DETAIL, deviceId: DEVICE, prevHash: 'genesis' });
        expect(JSON.stringify(pe)).not.toContain('device_attestation_id');
        // RED: the field would be detected if it were carried.
        expect(JSON.stringify({ ...pe, device_attestation_id: 'dev_abc' })).toContain('device_attestation_id');
    });

    it('carries corroboration_metadata when present and omits the key when absent', () => {
        const corroboration: CorroborationSignalPEDetails = {
            target_pe_id: 'pe_target', target_pe_hash: 'targethash', corroborating_party: '0xother',
            signal_type: 'counterparty_attestation', evidence_hash: 'evhash', evidence_ref: 'promise_1', automated: true,
        };
        expect(phonePricingOf(envelope({ corroboration_metadata: corroboration }), DETAIL).corroboration_metadata).toEqual(corroboration);
        expect('corroboration_metadata' in phonePricingOf(envelope({}), DETAIL)).toBe(false);
    });

    it('input_origins: populated and present-empty are carried verbatim, absent stays absent (three states)', () => {
        const populated: InputOrigin[] = [{ hash: 'sha256:aaa', origin_identifier: 'npm:left-pad@1.3.0', witnessed: false }];
        expect(phonePricingOf(envelope({ input_origins: populated }), DETAIL).input_origins).toEqual(populated);
        expect(phonePricingOf(envelope({ input_origins: [] }), DETAIL).input_origins).toEqual([]);
        expect('input_origins' in phonePricingOf(envelope({}), DETAIL)).toBe(false);
    });

    it('tx_hash + chain_id for a well-formed EVM hash; RED: short / Solana / absent carries nothing', () => {
        expect(phonePricingOf(envelope({ action_type: 'send', tx_hash: TX, chain_id: 8453 }), DETAIL)).toMatchObject({ tx_hash: TX, chain_id: 8453 });
        for (const bad of [envelope({ tx_hash: '0x1234', chain_id: 8453 }), envelope({ tx_hash: '5h8xQ1rUYbD3o2fZTg9w', chain_id: 'Solana' as unknown as number }), envelope({})]) {
            const p = phonePricingOf(bad, DETAIL);
            expect('tx_hash' in p).toBe(false);
            expect('chain_id' in p).toBe(false);
        }
    });

    it('privacy: risk score, amount, recipients and free text never become pricing fields', () => {
        const p = phonePricingOf(envelope({ risk_score: 99, amount: '1000', recipient: '0xfriend' } as never), DETAIL);
        for (const k of Object.keys(p)) expect(PHONE_PRICING_FIELDS).toContain(k);
        expect(JSON.stringify(p)).not.toMatch(/1000|0xfriend|private words/);
    });
});

describe('buildPhonePeV2', () => {
    it('builds a PE v2 whose act record (what the relay sees) carries no free text and passes the relay shape check', async () => {
        const env = envelope({ intent_text: 'Paid Maria for tamales' });
        const pe = await buildPhonePeV2({ envelope: env, detailHash: DETAIL, deviceId: DEVICE, prevHash: 'genesis' });
        expect(pe.schema).toBe(PE_V2_SCHEMA);
        expect(pe.pe_id).toBe(env.envelope_id);
        expect(pe.description).toBe('Paid Maria for tamales'); // inside the PE the owner keeps
        expect(peHashOf(pe)).toBe(pe.pe_hash);
        const act = actRecordOf(pe);
        expect(JSON.stringify(act)).not.toContain('tamales');
        expect(act.pricing.detail_hash).toBe(DETAIL);
        expect(validateBatchShape(JSON.parse(JSON.stringify(buildBatch({ device_id: DEVICE, seq: 1, prev_batch_hash: 'genesis', created_at_ms: 1, pes: [pe] })))).ok).toBe(true);
    });

    it('the device signature is the PE attestation key over pe_hash, outside the hash; a signer failure never blocks the PE', async () => {
        const signed: string[] = [];
        const pe = await buildPhonePeV2({ envelope: envelope(), detailHash: DETAIL, deviceId: DEVICE, prevHash: 'genesis', sign: async (h) => { signed.push(h); return 'sig_' + h.slice(0, 8); } });
        expect(signed).toEqual([pe.pe_hash]);
        expect(pe.signature).toBe('sig_' + pe.pe_hash.slice(0, 8));
        expect(peHashOf(pe)).toBe(pe.pe_hash);
        const unsigned = await buildPhonePeV2({ envelope: envelope(), detailHash: DETAIL, deviceId: DEVICE, prevHash: 'genesis', sign: async () => { throw new Error('no key'); } });
        expect(unsigned.signature).toBeUndefined();
    });

    it('a hardware witness signs hardwareNonceOfAct over the PE WITHOUT its slot; a witness failure leaves no slot', async () => {
        let seenNonce = '';
        const env = envelope();
        const pe = await buildPhonePeV2({
            envelope: env, detailHash: DETAIL, deviceId: DEVICE, prevHash: 'genesis',
            witness: async (nonce) => { seenNonce = nonce; return { scheme: 'apple_app_attest', report: 'r' }; },
        });
        expect(pe.hardware_witness).toEqual({ scheme: 'apple_app_attest', report: 'r' });
        const withoutSlot = { ...pe } as Record<string, unknown>;
        delete withoutSlot.hardware_witness;
        delete withoutSlot.pe_hash;
        expect(seenNonce).toBe(hardwareNonceOfAct(actRecordOf({ ...withoutSlot, pe_hash: peHashOf(withoutSlot as never) } as never)));
        const none = await buildPhonePeV2({ envelope: envelope(), detailHash: DETAIL, deviceId: DEVICE, prevHash: 'genesis', witness: async () => { throw new Error('attest down'); } });
        expect('hardware_witness' in none).toBe(false);
    });
});
