/**
 * The ONE launch measurement a hardware scheme attests, read from a VERIFIER's own fields (the
 * sealed admitted summary, or a fresh verdict) — never from a request body.
 *
 *   tpm2_quote             → the quoted PCR digest over the selected PCRs (`pcr_digest`)
 *   aws_nitro / azure      → the enclave / SEV-SNP launch measurement (`launch_measurement`)
 *   gcp_confidential_space → the container image digest the launcher measured (`image_digest`)
 *   nvidia_cc              → sha384 of the GPU measurement record (`measurement_digest`)
 *   apple_app_attest       → none (App Attest carries no launch measurement)
 *
 * The vocabulary keys `composition.measurement.<digest>` on it (actor-stats), and the measured
 * observer rule (`pinned-measurements.ts`) compares it with the measurements the signed observer
 * release channel pins. One reader, so the fact a gate asks for and the fact that prices are the
 * same bytes.
 */

const MEASUREMENT_RE = /^[a-z0-9:]{1,110}$/;

/**
 * A launch-measurement key — the scheme's measurement string lowercased, accepted only when it is
 * already `^[a-z0-9:]{1,110}$` (a `sha384:<96 hex>` digest is 103 chars). Never truncated or
 * rewritten: a digest that does not fit is not a digest we can name, so it is dropped (null).
 */
export function measurementKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const k = raw.trim().toLowerCase();
  return MEASUREMENT_RE.test(k) ? k : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

/** The scheme's launch measurement on a sealed witness summary / verdict fields (null for a scheme without one). */
export function hardwareMeasurementOf(sealed: unknown): string | null {
  const hw = asRecord(sealed);
  if (!hw) return null;
  switch (hw.scheme) {
    case 'aws_nitro':
    case 'azure_attestation':
      return measurementKey(hw.launch_measurement);
    case 'tpm2_quote':
      return measurementKey(hw.pcr_digest);
    case 'gcp_confidential_space':
      return measurementKey(hw.image_digest);
    case 'nvidia_cc':
      return measurementKey(hw.measurement_digest);
    default:
      return null; // apple_app_attest carries no launch measurement
  }
}
