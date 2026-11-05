/**
 * Google Cloud Confidential Space / Confidential VM attestation token — §2.9.
 *
 * A JWT issued by `https://confidentialcomputing.googleapis.com` (its OIDC discovery names the
 * JWKS), signed by Google's attestation signer. Claims: `eat_nonce` (the nonce the workload
 * requested — must equal the binding nonce, hex), `hwmodel` (GCP_AMD_SEV / GCP_INTEL_TDX / …),
 * `swname` (CONFIDENTIAL_SPACE | GCE), `swversion`, `secboot`, `dbgstat`, `submods.container.
 * image_digest`, `submods.gce.zone`. The scheme's public root = Google's issuer + its JWKS over
 * TLS (pinned issuer; keys fetched, cached an hour).
 */
import { decodeJwt, fetchJwks, jwtTimeValid, keyFromJwk, selectJwk, str, verifyJwsSignature, type JwksFetch } from './jwt';
import { spkiSha256OfKey, sha256Hex } from './x509';
import { GCP_CONFIDENTIAL_ISSUER, GCP_CONFIDENTIAL_OIDC_DISCOVERY } from './roots';
import type { HardwareVerifyContext, HardwareWitnessInput, HardwareWitnessVerdict } from './types';

let discoveredJwksUri: string | null = null;

async function resolveJwksUri(fetchImpl: JwksFetch): Promise<string | null> {
  if (discoveredJwksUri) return discoveredJwksUri;
  try {
    const res = await fetchImpl(GCP_CONFIDENTIAL_OIDC_DISCOVERY);
    if (!res.ok) return null;
    const body = await res.json() as { issuer?: unknown; jwks_uri?: unknown };
    if (body.issuer !== GCP_CONFIDENTIAL_ISSUER) return null;
    const uri = str(body.jwks_uri);
    if (!uri || !uri.startsWith('https://www.googleapis.com/')) return null;
    discoveredJwksUri = uri;
    return uri;
  } catch {
    return null;
  }
}

export function resetGcpDiscoveryForTests(): void { discoveredJwksUri = null; }

function nonceMatches(claim: unknown, binding: Buffer): boolean {
  const hex = binding.toString('hex');
  const b64 = binding.toString('base64');
  const b64url = binding.toString('base64url');
  const one = (v: unknown): boolean => typeof v === 'string' && (v === hex || v === b64 || v === b64url);
  if (Array.isArray(claim)) return claim.some(one);
  return one(claim);
}

export async function verifyGcpConfidential(input: HardwareWitnessInput, ctx: HardwareVerifyContext): Promise<HardwareWitnessVerdict> {
  const fail = (reason: string): HardwareWitnessVerdict => ({ admitted: false, scheme: 'gcp_confidential_space', reason, fields: null });
  const token = str(input.token);
  if (!token) return fail('token_missing');
  const jwt = decodeJwt(token);
  if (!jwt) return fail('token_malformed');
  if (jwt.payload.iss !== GCP_CONFIDENTIAL_ISSUER) return fail('issuer_mismatch');
  if (!jwtTimeValid(jwt.payload, ctx.nowMs)) return fail('token_expired');
  const fetchImpl = ctx.fetch ?? ((url: string) => fetch(url));
  const jwksUri = await resolveJwksUri(fetchImpl);
  if (!jwksUri) return fail('jwks_discovery_failed');
  const keys = await fetchJwks(jwksUri, fetchImpl, ctx.nowMs);
  if (!keys) return fail('jwks_unavailable');
  const jwk = selectJwk(keys, jwt.header.kid);
  const key = jwk ? keyFromJwk(jwk) : null;
  if (!key) return fail('signing_key_unknown');
  if (!verifyJwsSignature(jwt, key)) return fail('signature_invalid');
  const signerKey = spkiSha256OfKey(key);
  if (ctx.actorKeyFingerprints.has(signerKey)) return fail('signer_is_actor');
  const p = jwt.payload;
  const submods = (typeof p.submods === 'object' && p.submods !== null ? p.submods : {}) as Record<string, unknown>;
  const container = (typeof submods.container === 'object' && submods.container !== null ? submods.container : {}) as Record<string, unknown>;
  const gce = (typeof submods.gce === 'object' && submods.gce !== null ? submods.gce : {}) as Record<string, unknown>;
  const zone = str(gce.zone);
  const region = zone ? zone.replace(/-[a-z]$/, '') : undefined;
  const nonceBound = nonceMatches(p.eat_nonce, ctx.bindingNonce);
  const fields = {
    tee_type: str(p.hwmodel)?.toLowerCase() ?? 'gcp_confidential',
    tee_version: str(p.swversion) ?? undefined,
    model: str(p.swname)?.toLowerCase() ?? undefined,
    manufacturer: 'Google Cloud',
    image_digest: str(container.image_digest) ?? undefined,
    region,
    secure_boot: typeof p.secboot === 'boolean' ? p.secboot : undefined,
    debug_enabled: typeof p.dbgstat === 'string' ? p.dbgstat !== 'disabled-since-boot' : undefined,
    report_digest: `sha256:${sha256Hex(token)}`,
    signer_key_sha256: signerKey,
    attested_time_ms: typeof p.iat === 'number' ? p.iat * 1000 : undefined,
    time_source: typeof p.iat === 'number' ? 'token_iat' : undefined,
    nonce_bound: nonceBound,
  };
  if (!nonceBound) return { admitted: false, scheme: 'gcp_confidential_space', reason: 'nonce_not_bound', fields };
  return { admitted: true, scheme: 'gcp_confidential_space', reason: 'verified', fields };
}
