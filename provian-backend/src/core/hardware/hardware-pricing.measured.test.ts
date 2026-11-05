/**
 * MEASURED OBSERVER — the hardware-rooted base pays when the attestation proves
 * Provian's own genuine software produced the record: App Attest by construction, and a TPM / Nitro /
 * GCP / Azure / NVIDIA attestation when the measurement its VERIFIER extracted is one the signed
 * observer release channel pins. Every control here is RED-observed: the same real attestation under
 * another pin, an operator-supplied measurement, an unadmitted report, and the empty channel all stay
 * at the lane's class.
 */
import { admitHardwareWitness, hardwarePricingLift, type HardwareAdmission } from './admit';
import { verifyTpm2Quote } from './tpm2';
import { hardwareMeasurementOf } from './measurement';
import { pinKey } from '../release/release-manifest-wire';
import { HARDWARE_SCHEMES } from './roots';
import { PROPOSED_MONETARY_POLICY_TEMPLATE } from '../pvt/policy/proposed-monetary-policy';
import type { HardwareVerifyContext } from './types';
import {
  GCE_CVM_BINDING_NONCE_HEX, GCE_CVM_QUOTE_B64, GCE_CVM_SIGNATURE_B64, GCE_CVM_AK_PUBLIC_TPMT_B64,
  GCE_CVM_AK_LEAF_PEM, GCE_CVM_AK_ISSUER_PEM, GCE_CVM_SAMPLE_NOW_MS,
} from './__fixtures__/gce-cvm-ak-sample';

const live = { scheme: 'tpm2_quote' as const, nonce_binding: 'body_sha256' as const, quote: GCE_CVM_QUOTE_B64, signature: GCE_CVM_SIGNATURE_B64, ak_public: GCE_CVM_AK_PUBLIC_TPMT_B64, ak_cert_chain: [GCE_CVM_AK_LEAF_PEM, GCE_CVM_AK_ISSUER_PEM] };
const ctx = (over: Partial<HardwareVerifyContext> = {}): HardwareVerifyContext => ({ bindingNonce: Buffer.from(GCE_CVM_BINDING_NONCE_HEX, 'hex'), actorKeyFingerprints: new Set<string>(), nowMs: GCE_CVM_SAMPLE_NOW_MS, ...over });

describe('the signed template names the measured schemes', () => {
  it('exactly the five measured schemes; App Attest stays the one unconditional scheme; the two lists never overlap', () => {
    const t = PROPOSED_MONETARY_POLICY_TEMPLATE;
    expect([...t.hardwarePricingMeasuredSchemes].sort()).toEqual(['aws_nitro', 'azure_attestation', 'gcp_confidential_space', 'nvidia_cc', 'tpm2_quote']);
    expect(t.hardwarePricingSchemes).toEqual(['apple_app_attest']);
    expect(t.hardwarePricingMeasuredSchemes.some((s) => t.hardwarePricingSchemes.includes(s))).toBe(false);
    // Every scheme the relay admits is in exactly one of the two lists.
    for (const s of HARDWARE_SCHEMES) expect(t.hardwarePricingSchemes.includes(s) !== t.hardwarePricingMeasuredSchemes.includes(s)).toBe(true);
  });
});

describe('a real vTPM quote (GCE Confidential VM, real Google-certified AK) under the measured observer rule', () => {
  let admitted: HardwareAdmission;
  let measurement: string;
  beforeAll(async () => {
    admitted = await admitHardwareWitness(live, ctx());
    expect(admitted.admitted).toBe(true);
    measurement = hardwareMeasurementOf({ ...admitted.verdict!.fields, scheme: 'tpm2_quote' })!;
    expect(measurement).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The measurement the rule reads IS the quoted PCR digest the verifier extracted.
    expect(measurement).toBe(verifyTpm2Quote(live, ctx()).fields!.pcr_digest);
  });

  it('GREEN: pinned by the signed release channel → the report prices at hardware_rooted', () => {
    expect(hardwarePricingLift(admitted, new Set([pinKey('tpm2_quote', measurement)]))).toBe(true);
  });

  it('RED: the same attestation under any other pinned measurement stays at the lane class', () => {
    expect(hardwarePricingLift(admitted, new Set([pinKey('tpm2_quote', 'sha256:' + 'aa'.repeat(32))]))).toBe(false);
    // The same digest pinned for ANOTHER scheme does not lift this scheme (the pin names both).
    expect(hardwarePricingLift(admitted, new Set([pinKey('gcp_confidential_space', measurement)]))).toBe(false);
    // The empty channel (nothing verified, nothing pinned) lifts nothing.
    expect(hardwarePricingLift(admitted, new Set())).toBe(false);
    expect(hardwarePricingLift(admitted)).toBe(false);
  });

  it('RED: an operator-supplied measurement is refused — only the verifier\'s own field is read', async () => {
    const pinned = 'sha256:' + 'bb'.repeat(32);
    const pins = new Set([pinKey('tpm2_quote', pinned)]);
    // The body names the pinned digest in every slot an operator could reach; the quote's real
    // PCR digest is another value, and that is the only one the rule reads.
    const supplied = await admitHardwareWitness({ ...live, pcr_digest: pinned, launch_measurement: pinned, measurement: pinned } as unknown as typeof live, ctx());
    expect(supplied.admitted).toBe(true);
    expect(supplied.verdict!.fields!.pcr_digest).toBe(measurement);
    expect(hardwarePricingLift(supplied, pins)).toBe(false);
    // Sanity: the same pin set with the REAL digest would have lifted (the control is live).
    expect(hardwarePricingLift(supplied, new Set([pinKey('tpm2_quote', measurement)]))).toBe(true);
  });

  it('RED: a report that is not admitted never lifts, even when its real measurement is pinned', async () => {
    const pins = new Set([pinKey('tpm2_quote', measurement)]);
    const wrongNonce = await admitHardwareWitness(live, ctx({ bindingNonce: Buffer.alloc(32, 7) }));
    expect(wrongNonce.admitted).toBe(false);
    expect(wrongNonce.verdict?.fields?.pcr_digest).toBe(measurement); // recorded…
    expect(hardwarePricingLift(wrongNonce, pins)).toBe(false);        // …never lifted
    const actorSigned = await admitHardwareWitness(live, ctx({ actorKeyFingerprints: new Set([admitted.verdict!.fields!.signer_key_sha256]) }));
    expect(actorSigned.verdict?.reason).toBe('signer_is_actor');
    expect(hardwarePricingLift(actorSigned, pins)).toBe(false);
  });
});

describe('App Attest is unchanged; a measured scheme without fields never lifts', () => {
  it('App Attest lifts with or without pins; a fieldless measured verdict does not', () => {
    const apple: HardwareAdmission = { present: true, admitted: true, verdict: { admitted: true, scheme: 'apple_app_attest', reason: 'verified', fields: null } };
    expect(hardwarePricingLift(apple)).toBe(true);
    expect(hardwarePricingLift(apple, new Set())).toBe(true);
    for (const scheme of PROPOSED_MONETARY_POLICY_TEMPLATE.hardwarePricingMeasuredSchemes) {
      const bare: HardwareAdmission = { present: true, admitted: true, verdict: { admitted: true, scheme: scheme as HardwareAdmission['verdict'] extends infer V ? V extends { scheme: infer S } ? S : never : never, reason: 'verified', fields: null } };
      expect(hardwarePricingLift(bare, new Set([pinKey(scheme, 'sha256:' + '07'.repeat(32))]))).toBe(false);
    }
  });
});
