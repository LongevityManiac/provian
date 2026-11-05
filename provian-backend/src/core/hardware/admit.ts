import {PROPOSED_MONETARY_POLICY_TEMPLATE} from '../pvt/policy/proposed-monetary-policy';
/**
 * HARDWARE-ROOTED ADMISSION — the one entry every lane calls (§2.9).
 *
 *   const hw = await admitHardwareWitness(body.hardware_witness, { bindingNonce: hardwareBindingNonce(body), … });
 *   witnessClass = hw.admitted ? 'hardware_rooted' : laneClass;
 *   metadata.hardware_witness = sealedHardwareWitness(hw);   // metadata-only, never the raw report
 *
 * Absent slot → `{ present: false }` and nothing is sealed. Present-but-unverifiable → the typed
 * fields (when the report parsed) + the failing reason are sealed and the lane's class stands.
 * Verified reports remain presentation facts; App Attest alone → `hardware_rooted`, and a measured scheme
 * (TPM / Nitro / GCP / Azure / NVIDIA) → `hardware_rooted` only under a measurement the signed observer
 * release channel pins (`hardwarePricingLift`, measured observer 2026-10-10). Admission never depends on a manufacturer/device catalog: each
 * verifier reaches ITS SCHEME's pinned public root and nothing else.
 */
import crypto from 'crypto';
import { isHardwareScheme } from './roots';
import { hardwareMeasurementOf } from './measurement';
import { pinKey } from '../release/release-manifest-wire';
import type { HardwareVerifyContext, HardwareWitnessFields, HardwareWitnessInput, HardwareWitnessVerdict } from './types';
import { verifyTpm2Quote } from './tpm2';
import { verifyAppleAppAttest } from './apple-app-attest';
import { verifyAppleAppAttestAssertion } from './apple-app-attest-assertion';
import { verifyAwsNitro } from './aws-nitro';
import { verifyGcpConfidential } from './gcp-confidential';
import { verifyAzureAttestation } from './azure-attestation';
import { verifyNvidiaCc } from './nvidia-cc';

export interface HardwareAdmission {
  readonly present: boolean;
  readonly admitted: boolean;
  readonly verdict: HardwareWitnessVerdict | null;
}

const MAX_SLOT_BYTES = 256 * 1024;

export function parseHardwareWitnessInput(raw: unknown): HardwareWitnessInput | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!isHardwareScheme(o.scheme)) return null;
  if (JSON.stringify(o).length > MAX_SLOT_BYTES) return null;
  return o as unknown as HardwareWitnessInput;
}

export async function admitHardwareWitness(raw: unknown, ctx: HardwareVerifyContext): Promise<HardwareAdmission> {
  if (raw === undefined || raw === null) return { present: false, admitted: false, verdict: null };
  const input = parseHardwareWitnessInput(raw);
  if (!input) return { present: true, admitted: false, verdict: { admitted: false, scheme: null, reason: 'slot_malformed', fields: null } };
  let verdict: HardwareWitnessVerdict;
  try {
    switch (input.scheme) {
      case 'tpm2_quote': verdict = verifyTpm2Quote(input, ctx); break;
      case 'apple_app_attest':
        // Per-PE ASSERTION from an attested key (the mobile lane) vs a one-time ATTESTATION object.
        verdict = typeof input.assertion === 'string'
          ? (ctx.appleAssertion ? await verifyAppleAppAttestAssertion(input, ctx, ctx.appleAssertion) : { admitted: false, scheme: 'apple_app_attest', reason: 'assertion_registry_unavailable', fields: null })
          : verifyAppleAppAttest(input, ctx);
        break;
      case 'aws_nitro': verdict = verifyAwsNitro(input, ctx); break;
      case 'gcp_confidential_space': verdict = await verifyGcpConfidential(input, ctx); break;
      case 'azure_attestation': verdict = await verifyAzureAttestation(input, ctx); break;
      case 'nvidia_cc': verdict = verifyNvidiaCc(input, ctx); break;
      default: verdict = { admitted: false, scheme: null, reason: 'scheme_unknown', fields: null };
    }
  } catch (err) {
    verdict = { admitted: false, scheme: input.scheme, reason: `verifier_threw:${err instanceof Error ? err.name : 'error'}`, fields: null };
  }
  return { present: true, admitted: verdict.admitted, verdict };
}

/** The metadata-only object sealed under `metadata.hardware_witness` (never the raw report). */
export function sealedHardwareWitness(adm: HardwareAdmission): Record<string, unknown> | null {
  if (!adm.present || !adm.verdict) return null;
  const v = adm.verdict;
  const fields: Partial<HardwareWitnessFields> = v.fields ?? {};
  const out: Record<string, unknown> = { admitted: v.admitted, scheme: v.scheme, reason: v.reason };
  for (const [k, val] of Object.entries(fields)) if (val !== undefined && val !== null) out[k] = val;
  return out;
}

/** sha256(SPKI DER) for a SEC1 uncompressed P-256 point (a registered Secure-Enclave device key). */
export function p256PointToSpkiSha256(hex: string): string | null {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^04[0-9a-fA-F]{128}$/.test(clean)) return null;
  try {
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(clean.slice(2, 66), 'hex').toString('base64url'), y: Buffer.from(clean.slice(66), 'hex').toString('base64url') }, format: 'jwk' });
    return crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
  } catch {
    return null;
  }
}

export function actorKeyFingerprints(keys: ReadonlyArray<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const k of keys) {
    if (!k) continue;
    const fp = p256PointToSpkiSha256(k);
    if (fp) out.add(fp);
  }
  return out;
}

/** Body metadata may never carry the sealed key itself — only the relay writes `metadata.hardware_witness`. */
export function metadataWithHardwareWitness(metadata: unknown, sealed: Record<string, unknown> | null): Record<string, unknown> | null {
  const base = typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata) ? { ...(metadata as Record<string, unknown>) } : null;
  if (base) delete base.hardware_witness;
  if (!sealed) return base;
  return { ...(base ?? {}), hardware_witness: sealed };
}

export { hardwareBindingNonce, hardwareBindingNonceHex, HARDWARE_WITNESS_FIELD } from './binding';

/**
 * Verification remains a presentation fact. Only genuine Provian software receives a price lift:
 * - an admitted report of a scheme in `hardwarePricingSchemes` (App Attest) lifts on its own;
 * - an admitted report of a scheme in `hardwarePricingMeasuredSchemes` (TPM, Nitro, GCP, Azure,
 * NVIDIA) lifts ONLY when the measurement its VERIFIER extracted is one the signed observer
 * release channel pins (`pinnedMeasurements`, from `pinned-measurements.ts`) — the measured
 * observer rule. The measurement is read from the verdict's own fields,
 * never from the request body, so an operator-supplied value is refused by construction.
 * No pins (undefined / empty) means no measured lift. Sealed PEs never reprice.
 */
export function hardwarePricingLift(adm: HardwareAdmission, pinnedMeasurements?: ReadonlySet<string>): boolean {
  if (!adm.admitted || !adm.verdict?.scheme) return false;
  const scheme = adm.verdict.scheme;
  if (PROPOSED_MONETARY_POLICY_TEMPLATE.hardwarePricingSchemes.includes(scheme)) return true;
  if (!PROPOSED_MONETARY_POLICY_TEMPLATE.hardwarePricingMeasuredSchemes.includes(scheme)) return false;
  if (!pinnedMeasurements || pinnedMeasurements.size === 0 || adm.verdict.fields === null) return false;
  const measurement = hardwareMeasurementOf({ ...adm.verdict.fields, scheme });
  return measurement !== null && pinnedMeasurements.has(pinKey(scheme, measurement));
}
export { ordinaryHardwareAttestationTier } from '../pvt/policy/evidence-class';
