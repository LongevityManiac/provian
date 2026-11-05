/**
 * Prompt 1 + 1b (app) — input_origins normalizer (incl. witnessed/witness),
 * whole-object PE hash three-state / forward-only (the PE v2 carrying them is
 * tested in src/core/meter/__tests__/phonePeBuilder.test.ts). Each guard ships an observed-red negative control.
 */
import { describe, it, expect } from 'vitest';
import type { ProvenanceEnvelope, InputOrigin } from './types';
import {
    normalizeInputOrigins,
    inputOriginsState,
    INPUT_ORIGINS_MAX_ENTRIES,
} from './inputOrigins';
import { hashEnvelopeCanonical } from './peHash';

const POPULATED: InputOrigin[] = [
    { hash: 'sha256:aaa', origin_identifier: 'https://example.com/a', witnessed: false },
    { hash: 'sha256:bbb', origin_identifier: 'npm:left-pad@1.3.0', witnessed: true, witness: { type: 'observer_device', identity: 'dev_x', attestation_tier: 'hardware_full' } },
];

describe('normalizeInputOrigins (app copy)', () => {
    it('non-array → absent; [] → present-empty; array → witnessed:false default, extras dropped', () => {
        const absentInputs: unknown[] = [undefined, null, 'x', 5, {}, { hash: 'a', origin_identifier: 'b' }];
        expect(absentInputs.length).toBeGreaterThan(0);
        for (const v of absentInputs) expect(normalizeInputOrigins(v)).toBeNull();
        expect(normalizeInputOrigins([])).toEqual([]);
        expect(inputOriginsState(normalizeInputOrigins([]))).toBe('present_empty');
        expect(normalizeInputOrigins([{ hash: 'h', origin_identifier: 'o', drop: 1 }]))
            .toEqual([{ hash: 'h', origin_identifier: 'o', witnessed: false }]);
    });
    it('witnessed:true+witness kept; NEGATIVE CONTROL: witnessed:true w/o witness → false', () => {
        expect(normalizeInputOrigins([{ hash: 'h', origin_identifier: 'o', witnessed: true, witness: { type: 't', identity: 'i' } }]))
            .toEqual([{ hash: 'h', origin_identifier: 'o', witnessed: true, witness: { type: 't', identity: 'i' } }]);
        expect(normalizeInputOrigins([{ hash: 'h', origin_identifier: 'o', witnessed: true }]))
            .toEqual([{ hash: 'h', origin_identifier: 'o', witnessed: false }]);
    });
    it('caps entries', () => {
        const many = Array.from({ length: INPUT_ORIGINS_MAX_ENTRIES + 5 }, (_, i) => ({ hash: `h${i}`, origin_identifier: `o${i}` }));
        expect(normalizeInputOrigins(many)!.length).toBe(INPUT_ORIGINS_MAX_ENTRIES);
    });
});

function makePE(over: Partial<ProvenanceEnvelope>): ProvenanceEnvelope {
    return {
        envelope_id: 'e1', prev_envelope_hash: 'GENESIS', timestamp: 1,
        action_type: 'test_action', intent_text: 'unit test envelope',
        device_attestation_id: 'dev_abc',
        ...over,
    } as ProvenanceEnvelope;
}

describe('hashEnvelopeCanonical — input_origins three-state + forward-only', () => {
    it('an envelope WITHOUT the key hashes identically to input_origins: undefined (forward-only)', async () => {
        const withoutKey = await hashEnvelopeCanonical(makePE({}));
        const undefinedKey = await hashEnvelopeCanonical(makePE({ input_origins: undefined }));
        expect(undefinedKey).toBe(withoutKey);
    });
    it('absent, present-empty, present-populated are all DISTINCT hashes', async () => {
        const absent = await hashEnvelopeCanonical(makePE({}));
        const empty = await hashEnvelopeCanonical(makePE({ input_origins: [] }));
        const populated = await hashEnvelopeCanonical(makePE({ input_origins: POPULATED }));
        expect(new Set([absent, empty, populated]).size).toBe(3);
        // Negative control: if the field were NOT in the whole-object preimage,
        // present-empty would equal absent. It must not.
        expect(empty).not.toBe(absent);
    });
    it('Prompt 1b: a legacy 2-key entry, witnessed:false, and witnessed:true hash DISTINCTLY', async () => {
        // The whole-object hash covers each entry verbatim, so a Prompt-1 (2-key)
        // entry, a witnessed:false entry, and a witnessed:true entry are three
        // different envelopes — the forward-only entry-shape evolution.
        const legacy = await hashEnvelopeCanonical(makePE({ input_origins: [{ hash: 'h', origin_identifier: 'o' }] as unknown as InputOrigin[] }));
        const wFalse = await hashEnvelopeCanonical(makePE({ input_origins: [{ hash: 'h', origin_identifier: 'o', witnessed: false }] }));
        const wTrue = await hashEnvelopeCanonical(makePE({ input_origins: [{ hash: 'h', origin_identifier: 'o', witnessed: true, witness: { type: 't', identity: 'i' } }] }));
        expect(new Set([legacy, wFalse, wTrue]).size).toBe(3);
    });
});

// The PE v2 carries input_origins in all three states: src/core/meter/__tests__/phonePeBuilder.test.ts.
