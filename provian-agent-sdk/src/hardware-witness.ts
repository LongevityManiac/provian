import { guardedFetch as fetch, egressResolver } from './guarded-fetch';
/**
 * HARDWARE WITNESS producers (Trust Layer build §2.9) — the `hardware_witness` slot every submit
 * lane carries. A producer receives the BINDING NONCE (sha256 hex over the canonical submission
 * body minus the slot — the same bytes the relay recomputes) and returns a report a NON-actor key
 * signed over that nonce, or `null` when this host has no such witness. A producer never blocks
 * or fails a submission: any error → `null` → the PE goes out at its ordinary class.
 *
 * Shipped producers:
 *   - `tpm2QuoteProvider()`            — TPM 2.0 quote via tpm2-tools (Compute Engine Shielded /
 *                                        Confidential VMs: the Google-certified AK at NV 0x01c10000).
 *   - `gcpConfidentialSpaceProvider()` — a Confidential Space launcher token carrying `eat_nonce`
 *                                        (unix socket /run/container_launcher/teeserver.sock).
 * The relay verifies each against ITS SCHEME's pinned public root (never a device catalog).
 */
import { createHash, createPublicKey, X509Certificate } from 'crypto';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import http from 'http';
import { validateEgressTarget } from './egress-guard';

export type HardwareScheme =
  | 'tpm2_quote'
  | 'apple_app_attest'
  | 'aws_nitro'
  | 'gcp_confidential_space'
  | 'azure_attestation'
  | 'nvidia_cc';

export interface HardwareWitnessInput {
  scheme: HardwareScheme;
  nonce_binding: 'body_sha256';
  quote?: string;
  signature?: string;
  ak_public?: string;
  ak_cert_chain?: string[];
  attestation?: string;
  key_id?: string;
  document?: string;
  token?: string;
  report?: string;
  cert_chain?: string;
}

/** Given the binding nonce (hex), produce the slot or null. MUST be side-effect-safe and never throw. */
export type HardwareWitnessProvider = (nonceHex: string) => Promise<HardwareWitnessInput | null>;

export const HARDWARE_WITNESS_FIELD = 'hardware_witness';

/** Canonical JSON (sorted keys, no whitespace, undefined dropped) — mirrors the relay's `canonicalJson`. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + canonicalJson(v));
  }
  return '{' + parts.join(',') + '}';
}

/** Excluded from the binding on every side: the slot, and the client-asserted identity keys the relay strips in place. */
export const HARDWARE_BINDING_EXCLUDED_FIELDS: readonly string[] = [HARDWARE_WITNESS_FIELD, 'user_id', 'wallet_id', 'actor_address'];

function bindingBody(body: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...body };
  for (const k of HARDWARE_BINDING_EXCLUDED_FIELDS) delete rest[k];
  return rest;
}

/** sha256 hex over the canonical body WITHOUT `hardware_witness` (and the stripped identity keys) — what the report must carry. */
export function hardwareBindingNonceHex(body: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(bindingBody(body))).digest('hex');
}

/** Attach a producer's slot to a body for THIS exact payload (recomputed per attempt, never cached). */
export async function attachHardwareWitness(
  body: Record<string, unknown>,
  provider: HardwareWitnessProvider | undefined,
): Promise<Record<string, unknown>> {
  if (!provider) return body;
  const { [HARDWARE_WITNESS_FIELD]: _omitted, ...rest } = body;
  try {
    const slot = await provider(hardwareBindingNonceHex(rest));
    return slot ? { ...rest, [HARDWARE_WITNESS_FIELD]: slot } : rest;
  } catch {
    return rest;
  }
}

// ─── TPM 2.0 (tpm2-tools) ──────────────────────────────────────────────────────

export interface Tpm2QuoteProviderOptions {
  /** NV index of the certified AK certificate (GCE RSA AK: 0x01c10000). */
  akCertNvIndex?: number;
  /** NV index of the AK template (GCE RSA AK: 0x01c10001). */
  akTemplateNvIndex?: number;
  /** PCR selection for the quote. */
  pcrSelection?: string;
  /** Override the tpm2-tools binaries' directory (default: PATH). */
  toolsDir?: string;
  /** Extra intermediates (PEM) to ship with the leaf; when set, the leaf's AIA issuer is not fetched. */
  intermediatePems?: string[];
}

function tool(dir: string | undefined, name: string): string {
  return dir ? join(dir, name) : name;
}

function publicKeysMatch(publicKeyPem: string, certPem: string): boolean {
  try {
    const a = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    const b = new X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' });
    return a.equals(b);
  } catch {
    return false;
  }
}

function derToPem(der: Buffer): string {
  const b64 = der.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----`;
}

/**
 * The GCE-certified AK is a PRIMARY under the endorsement hierarchy created from the EXACT template
 * Google stores at NV 0x01c10001 (a TPMT_PUBLIC whose `unique` carries per-instance bytes — not a
 * public key). A primary is derived deterministically from the hierarchy seed + template, so only
 * that byte-exact template reproduces the key the certificate at NV 0x01c10000 names. The attribute
 * set is read FROM the template (Google's has no `noda`), and the unique is passed through
 * tpm2-tools' `-u` file. tpm2-tools (≤5.6) reads that file's size prefix in HOST byte order, so the
 * producer tries the little-endian framing first, then big-endian, and ships a quote only when the
 * recreated key IS the certified key — never a quote a chain does not vouch for.
 */
const TPMA_NAMES: ReadonlyArray<[number, string]> = [
  [0x00000002, 'fixedtpm'], [0x00000004, 'stclear'], [0x00000010, 'fixedparent'], [0x00000020, 'sensitivedataorigin'],
  [0x00000040, 'userwithauth'], [0x00000080, 'adminwithpolicy'], [0x00000400, 'noda'], [0x00000800, 'encryptedduplication'],
  [0x00010000, 'restricted'], [0x00020000, 'decrypt'], [0x00040000, 'sign'],
];

/** Parse the RSA fields of a TPMT_PUBLIC template: attributes (tpm2-tools spelling), key bits, unique bytes. */
export function parseRsaAkTemplate(tmpl: Buffer): { attrs: string; keyBits: number; unique: Buffer; nameAlg: string } | null {
  try {
    let o = 0;
    if (tmpl.readUInt16BE(0) === tmpl.length - 2) o = 2; // TPM2B_PUBLIC wrapper
    const type = tmpl.readUInt16BE(o); o += 2;
    if (type !== 0x0001) return null; // TPM_ALG_RSA only
    const nameAlgCode = tmpl.readUInt16BE(o); o += 2;
    const attrBits = tmpl.readUInt32BE(o); o += 4;
    const policyLen = tmpl.readUInt16BE(o); o += 2 + policyLen;
    const sym = tmpl.readUInt16BE(o); o += 2;
    if (sym !== 0x0010) return null; // TPM_ALG_NULL symmetric
    const scheme = tmpl.readUInt16BE(o); o += 2;
    if (scheme !== 0x0014) return null; // RSASSA
    o += 2; // scheme hash
    const keyBits = tmpl.readUInt16BE(o); o += 2;
    o += 4; // exponent
    const uniqueLen = tmpl.readUInt16BE(o); o += 2;
    const unique = tmpl.subarray(o, o + uniqueLen);
    if (unique.length !== uniqueLen) return null;
    const attrs = TPMA_NAMES.filter(([bit]) => (attrBits & bit) !== 0).map(([, name]) => name).join('|');
    const nameAlg = nameAlgCode === 0x000b ? 'sha256' : nameAlgCode === 0x000c ? 'sha384' : 'sha256';
    return { attrs, keyBits, unique, nameAlg };
  } catch {
    return null;
  }
}

async function fetchAiaIssuer(leafPem: string): Promise<string | null> {
  try {
    const cert = new X509Certificate(leafPem);
    const uri = cert.infoAccess?.match(/CA Issuers - URI:(\S+)/)?.[1];
    if (!uri) return null;
    // Security Invariant #6: every SDK fetch site goes through the egress guard — HTTPS only,
    // private/loopback/link-local/metadata hosts blocked, resolve-and-re-check. The URI comes
    // from bytes in an NV index, i.e. from the host, so it is never trusted as a destination.
    const egress = await validateEgressTarget(uri, { resolveHost: egressResolver(uri) });
    if (!egress.ok) return null;
    const res = await fetch(uri, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
    if (!res.ok) return null;
    const body = Buffer.from(await res.arrayBuffer());
    const pem = body.subarray(0, 10).toString('utf8').includes('BEGIN') ? body.toString('utf8') : derToPem(body);
    const issuer = new X509Certificate(pem);
    return cert.checkIssued(issuer) ? pem : null;
  } catch {
    return null;
  }
}

export function tpm2QuoteProvider(options: Tpm2QuoteProviderOptions = {}): HardwareWitnessProvider {
  const akCertNv = `0x${(options.akCertNvIndex ?? 0x01c10000).toString(16)}`;
  const akTemplateNv = `0x${(options.akTemplateNvIndex ?? 0x01c10001).toString(16)}`;
  const pcrs = options.pcrSelection ?? 'sha256:0,1,2,3,4,5,6,7';
  return async (nonceHex: string): Promise<HardwareWitnessInput | null> => {
    let dir: string | null = null;
    try {
      dir = mkdtempSync(join(tmpdir(), 'provian-tpm-'));
      const run = (name: string, args: string[]): Buffer => execFileSync(tool(options.toolsDir, name), args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 });
      const akCrt = join(dir, 'ak.crt');
      const akTmpl = join(dir, 'ak.tmpl');
      const akPub = join(dir, 'ak.pub');
      const msg = join(dir, 'quote.msg');
      const sig = join(dir, 'quote.sig');
      run('tpm2_nvread', [akCertNv, '-o', akCrt]);
      run('tpm2_nvread', [akTemplateNv, '-o', akTmpl]);
      const template = parseRsaAkTemplate(readFileSync(akTmpl));
      if (!template) return null;
      const certDer = readFileSync(akCrt);
      const leafPem = certDer.subarray(0, 10).toString('utf8').includes('BEGIN') ? certDer.toString('utf8') : derToPem(certDer);
      let akCtx: string | null = null;
      for (const endian of ['LE', 'BE'] as const) {
        const uniqueFile = join(dir, `unique.${endian}`);
        const size = Buffer.alloc(2);
        if (endian === 'LE') size.writeUInt16LE(template.unique.length, 0); else size.writeUInt16BE(template.unique.length, 0);
        writeFileSync(uniqueFile, Buffer.concat([size, template.unique]));
        const ctx = join(dir, `ak.${endian}.ctx`);
        try {
          run('tpm2_createprimary', ['-C', 'e', '-G', `rsa${template.keyBits}:rsassa-sha256:null`, '-g', template.nameAlg, '-a', template.attrs, '-u', uniqueFile, '-c', ctx]);
        } catch { continue; }
        const pemFile = join(dir, `ak.${endian}.pem`);
        run('tpm2_readpublic', ['-c', ctx, '-f', 'pem', '-o', pemFile]);
        const pem = readFileSync(pemFile, 'utf8');
        // The key we quote with MUST be the key the certificate certifies — otherwise the chain
        // vouches for nothing and the relay refuses (`ak_public_not_certified`); ship nothing.
        if (publicKeysMatch(pem, leafPem)) { akCtx = ctx; break; }
      }
      if (!akCtx) return null;
      run('tpm2_readpublic', ['-c', akCtx, '-f', 'tpmt', '-o', akPub]);
      run('tpm2_quote', ['-c', akCtx, '-l', pcrs, '-q', nonceHex, '-g', 'sha256', '-m', msg, '-s', sig]);
      const issuer = options.intermediatePems?.length ? null : await fetchAiaIssuer(leafPem);
      return {
        scheme: 'tpm2_quote',
        nonce_binding: 'body_sha256',
        quote: readFileSync(msg).toString('base64'),
        signature: readFileSync(sig).toString('base64'),
        ak_public: readFileSync(akPub).toString('base64'),
        ak_cert_chain: [leafPem, ...(options.intermediatePems ?? []), ...(issuer ? [issuer] : [])],
      };
    } catch {
      return null;
    } finally {
      if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
  };
}

// ─── GCP Confidential Space launcher token ────────────────────────────────────

export interface GcpConfidentialSpaceProviderOptions {
  socketPath?: string;
  audience?: string;
}

const GCP_LAUNCHER_SOCKET = '/run/container_launcher/teeserver.sock';

/** Ask the Confidential Space launcher for an attestation token whose `eat_nonce` is the binding nonce. */
export function gcpConfidentialSpaceProvider(options: GcpConfidentialSpaceProviderOptions = {}): HardwareWitnessProvider {
  const socketPath = options.socketPath ?? GCP_LAUNCHER_SOCKET;
  const audience = options.audience ?? 'https://api.provian.ai';
  return async (nonceHex: string): Promise<HardwareWitnessInput | null> => {
    if (!existsSync(socketPath)) return null;
    const payload = JSON.stringify({ audience, token_type: 'OIDC', nonces: [nonceHex] });
    return new Promise<HardwareWitnessInput | null>((resolve) => {
      const req = http.request({ socketPath, path: '/v1/token', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 15_000 }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const token = Buffer.concat(chunks).toString('utf8').trim();
          if (res.statusCode === 200 && token.split('.').length === 3) resolve({ scheme: 'gcp_confidential_space', nonce_binding: 'body_sha256', token });
          else resolve(null);
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end(payload);
    });
  };
}

/** Pick the producer this host supports, by what is present — not by a catalog. */
/** The observer's hardware-witness switch, read by every lane that builds a PE outside the daemon (the post-commit hook). */
export const HARDWARE_WITNESS_ENV = 'PROVIAN_HARDWARE_WITNESS';

/**
 * The hardware witness a short-lived lane process attaches (2026-10-10). The daemon's lanes carry
 * the slot through the observer config; the post-commit hook builds its `coding_session` in its
 * own process and must carry the SAME slot, or a commit on a measured Confidential VM seals at the
 * lane's class while the daemon's idle sessions (which mint nothing) carry the quote. `none` opts
 * out exactly as the observer's `hardwareWitness: 'none'` does; anything else auto-detects.
 */
export function laneHardwareWitnessProvider(
  env: NodeJS.ProcessEnv,
  detect: () => HardwareWitnessProvider | undefined = autoHardwareWitnessProvider,
): HardwareWitnessProvider | undefined {
  const v = (env[HARDWARE_WITNESS_ENV] ?? '').trim().toLowerCase();
  return v === 'none' ? undefined : detect();
}

export function autoHardwareWitnessProvider(): HardwareWitnessProvider | undefined {
  if (existsSync(GCP_LAUNCHER_SOCKET)) return gcpConfidentialSpaceProvider();
  if (existsSync('/dev/tpmrm0') || existsSync('/dev/tpm0')) return tpm2QuoteProvider();
  return undefined;
}
