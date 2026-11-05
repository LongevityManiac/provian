/**
 * Microsoft Azure Attestation (MAA) token — §2.9.
 *
 * A JWT whose `iss` is an `https://<instance>.<region>.attest.azure.net` provider; the provider
 * publishes its signing certificates at `${iss}/certs` (x5c JWKS). Claims: `x-ms-attestation-type`
 * (`sevsnpvm` | `tpm` | `vbs` | `sgx`), `nonce` (rp_data) or `x-ms-runtime.nonce` — must equal the
 * binding nonce; SEV-SNP: `x-ms-sevsnpvm-launchmeasurement`, `x-ms-sevsnpvm-is-debuggable`,
 * `x-ms-sevsnpvm-vmpl`; TPM: `secureBootEnabled`. The scheme's public root = the MAA issuer host
 * pattern + its `/certs` over TLS.
 */
import { decodeJwt, fetchJwks, jwtTimeValid, keyFromJwk, selectJwk, str, verifyJwsSignature } from './jwt';
import { spkiSha256OfKey, sha256Hex } from './x509';
import { AZURE_ATTESTATION_ISSUER_RE } from './roots';
import type { HardwareVerifyContext, HardwareWitnessInput, HardwareWitnessVerdict } from './types';

function nonceMatches(claim: unknown, binding: Buffer): boolean {
  if (typeof claim !== 'string') return false;
  return claim === binding.toString('hex') || claim === binding.toString('base64') || claim === binding.toString('base64url');
}

export async function verifyAzureAttestation(input: HardwareWitnessInput, ctx: HardwareVerifyContext): Promise<HardwareWitnessVerdict> {
  const fail = (reason: string): HardwareWitnessVerdict => ({ admitted: false, scheme: 'azure_attestation', reason, fields: null });
  const token = str(input.token);
  if (!token) return fail('token_missing');
  const jwt = decodeJwt(token);
  if (!jwt) return fail('token_malformed');
  const iss = str(jwt.payload.iss);
  if (!iss || !AZURE_ATTESTATION_ISSUER_RE.test(iss)) return fail('issuer_not_azure_attestation');
  if (!jwtTimeValid(jwt.payload, ctx.nowMs)) return fail('token_expired');
  const fetchImpl = ctx.fetch ?? ((url: string) => fetch(url));
  const keys = await fetchJwks(`${iss}/certs`, fetchImpl, ctx.nowMs);
  if (!keys) return fail('jwks_unavailable');
  const jwk = selectJwk(keys, jwt.header.kid);
  const key = jwk ? keyFromJwk(jwk) : null;
  if (!key) return fail('signing_key_unknown');
  if (!verifyJwsSignature(jwt, key)) return fail('signature_invalid');
  const signerKey = spkiSha256OfKey(key);
  if (ctx.actorKeyFingerprints.has(signerKey)) return fail('signer_is_actor');
  const p = jwt.payload;
  const runtime = (typeof p['x-ms-runtime'] === 'object' && p['x-ms-runtime'] !== null ? p['x-ms-runtime'] : {}) as Record<string, unknown>;
  const nonceBound = nonceMatches(p.nonce, ctx.bindingNonce) || nonceMatches(runtime.nonce, ctx.bindingNonce);
  const attType = str(p['x-ms-attestation-type'])?.toLowerCase() ?? 'unknown';
  const launch = str(p['x-ms-sevsnpvm-launchmeasurement']);
  const secureBoot = typeof p.secureBootEnabled === 'boolean' ? p.secureBootEnabled : undefined;
  const debug = typeof p['x-ms-sevsnpvm-is-debuggable'] === 'boolean' ? p['x-ms-sevsnpvm-is-debuggable'] : undefined;
  const fields = {
    tee_type: attType === 'sevsnpvm' ? 'amd_sev_snp' : attType === 'tpm' ? 'tpm2' : `azure_${attType}`,
    tee_version: str(p['x-ms-sevsnpvm-snpfw-svn']) ?? (typeof p['x-ms-sevsnpvm-snpfw-svn'] === 'number' ? String(p['x-ms-sevsnpvm-snpfw-svn']) : undefined),
    model: attType,
    manufacturer: 'Microsoft Azure',
    launch_measurement: launch ? `sha384:${launch.toLowerCase()}` : undefined,
    secure_boot: secureBoot,
    debug_enabled: debug,
    report_digest: `sha256:${sha256Hex(token)}`,
    signer_key_sha256: signerKey,
    attested_time_ms: typeof p.iat === 'number' ? p.iat * 1000 : undefined,
    time_source: typeof p.iat === 'number' ? 'token_iat' : undefined,
    nonce_bound: nonceBound,
  };
  if (!nonceBound) return { admitted: false, scheme: 'azure_attestation', reason: 'nonce_not_bound', fields };
  return { admitted: true, scheme: 'azure_attestation', reason: 'verified', fields };
}
