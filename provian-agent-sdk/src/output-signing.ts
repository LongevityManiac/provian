/**
 * Signing the outputs an agent (or a person's device) hands out, and reading the signature off what
 * it receives . The ONE definition of the message, the object and the
 * header is `output-signature.ts` (byte-identical in the relay, the SDK and the app); this module is
 * the SDK's signers over it.
 *
 * wallet `signOutputWithWalletKey(privateKeyHex, output)` the agent's own secp256k1 wallet key,
 * EIP-191. Key-per-call: hand it the key inside `withDecryptedKey`, it retains nothing.
 * device `ProvianClient.signOutput(output)` the observer device's REGISTERED key: the Secure
 * Enclave key of an SE device (`provian-se-sign`), or, on a bearer device (whose HMAC
 * secret no third party can verify), a P-256 output key created once on the device and
 * registered with `PUT /v1/devices/me/output-signing-key` (`signOutputWithP256Key`).
 *
 * The signature establishes WHO MADE an output. It never makes a citation count by itself: the
 * consumer's citing act must be witnessed (its observer device), and the ring and self filters
 * apply (constraint 1).
 *
 * Serving: put `outputSignatureHeaders(sig)` on the HTTP response (`Provian-Output-Signature`), or
 * the object itself under `provian_output_signature` in a JSON / MCP result. `signResponse(res, …)`
 * does it for a Fetch-API `Response` (x402 sellers on Hono / Next / Bun / Workers).
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { secp256k1 } from '@noble/curves/secp256k1';
import { p256 } from '@noble/curves/p256';
import { keccak256 } from './keccak256';
import { signEip191Message } from './link-signing';
import { deriveAddressFromPrivateKey } from './wallet';
import {
  canonicalOutputHash,
  canonicalP256PublicKey,
  decodeOutputSignatureHeader,
  encodeOutputSignatureHeader,
  normalizeOutputSignature,
  OUTPUT_SIGNATURE_HEADER,
  OUTPUT_SIGNATURE_JSON_KEY,
  outputHashOfBytes,
  outputHashOfText,
  outputKeyRegistrationMessage,
  outputSignatureDigestHex,
  outputSignatureMessage,
  type OutputSignature,
  type OutputSigner,
} from './output-signature';

export type OutputBytes = Uint8Array | string;

/** `sha256:<hex>` of an output (a string is hashed as UTF-8). */
export function outputHashOf(output: OutputBytes): string {
  return typeof output === 'string' ? outputHashOfText(output) : outputHashOfBytes(output);
}

function clean32(privateKeyHex: string): string {
  const k = privateKeyHex.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(k)) throw new Error('private key must be 32 bytes (64 hex chars)');
  return k;
}

/** Sign an output with the agent's OWN wallet key (EIP-191, secp256k1). Retains nothing. */
export function signOutputWithWalletKey(privateKeyHex: string, output: OutputBytes): OutputSignature {
  const key = clean32(privateKeyHex);
  const hash = outputHashOf(output);
  const sig = signEip191Message(key, outputSignatureMessage(hash)).toLowerCase();
  const signer: OutputSigner = { kind: 'wallet', id: deriveAddressFromPrivateKey(key).toLowerCase() };
  const out = normalizeOutputSignature({ hash, signer, scheme: 'eip191_secp256k1', sig });
  if (out === null) throw new Error('output signature did not normalize');
  return out;
}

/** Sign with a P-256 signer that signs a SHA-256 DIGEST (Secure Enclave, StrongBox, software). */
export async function signOutputWithDigestSigner(
  signer: OutputSigner,
  output: OutputBytes,
  signDigest: (digestHex: string) => Promise<string> | string,
): Promise<OutputSignature> {
  if (signer.kind === 'wallet') throw new Error('a wallet signer signs EIP-191; use signOutputWithWalletKey');
  const hash = outputHashOf(output);
  const rs = (await signDigest(outputSignatureDigestHex(hash))).trim().toLowerCase().replace(/^0x/, '');
  const out = normalizeOutputSignature({ hash, signer, scheme: 'p256_sha256', sig: rs });
  if (out === null) throw new Error('P-256 signer returned a malformed r||s');
  return out;
}

/** P-256 over a digest with a software key: 64-byte r‖s, low-s, deterministic (RFC 6979). */
export function p256SignDigestHex(privateKeyHex: string, digestHex: string): string {
  const sig = p256.sign(Buffer.from(digestHex, 'hex'), clean32(privateKeyHex), { lowS: true });
  return Buffer.from(sig.toCompactRawBytes()).toString('hex');
}

/** Sign an output with a software P-256 key (a bearer device's registered output key). */
export function signOutputWithP256Key(privateKeyHex: string, signer: OutputSigner, output: OutputBytes): Promise<OutputSignature> {
  return signOutputWithDigestSigner(signer, output, (digest) => p256SignDigestHex(privateKeyHex, digest));
}

/** Does this signature name the hash of exactly these bytes? (Run it before citing what you received.) */
export function outputSignatureMatches(signature: OutputSignature, output: OutputBytes): boolean {
  return canonicalOutputHash(signature.hash) === outputHashOf(output);
}

/**
 * Locally recover a WALLET signature's signer (the relay does the authoritative check against its
 * registries). True when the EIP-191 signature recovers to `signer.id`. Device / app signatures
 * verify only against the registered key the relay holds.
 */
export function walletOutputSignatureRecovers(signature: OutputSignature): boolean {
  if (signature.signer.kind !== 'wallet' || signature.scheme !== 'eip191_secp256k1') return false;
  try {
    const message = Buffer.from(outputSignatureMessage(signature.hash), 'utf8');
    const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${message.length}`, 'utf8');
    const digest = keccak256(Buffer.concat([prefix, message]));
    const raw = Buffer.from(signature.sig.slice(2), 'hex');
    const v = raw[64] >= 27 ? raw[64] - 27 : raw[64];
    const pub = secp256k1.Signature.fromCompact(raw.subarray(0, 64)).addRecoveryBit(v).recoverPublicKey(digest).toRawBytes(false);
    const address = `0x${keccak256(Buffer.from(pub.subarray(1))).subarray(12).toString('hex')}`;
    return address === signature.signer.id;
  } catch {
    return false;
  }
}

/** Verify a P-256 output signature against a known public key (SEC1 uncompressed hex). */
export function p256OutputSignatureVerifies(publicKeyHex: string, signature: OutputSignature): boolean {
  const key = canonicalP256PublicKey(publicKeyHex);
  if (key === null || signature.scheme !== 'p256_sha256') return false;
  try {
    return p256.verify(Buffer.from(signature.sig, 'hex'), Buffer.from(outputSignatureDigestHex(signature.hash), 'hex'), Buffer.from(key, 'hex'), { lowS: false });
  } catch {
    return false;
  }
}

// ─── carrying it ────────────────────────────────────────────────────────────────

/** The response header(s) that hand an output out signed. */
export function outputSignatureHeaders(signature: OutputSignature): Record<string, string> {
  return { [OUTPUT_SIGNATURE_HEADER]: encodeOutputSignatureHeader(signature) };
}

/** The JSON field a non-HTTP result (an MCP tool result, a JSON body) carries the signature under. */
export function outputSignatureJson(signature: OutputSignature): Record<string, OutputSignature> {
  return { [OUTPUT_SIGNATURE_JSON_KEY]: signature };
}

type HeaderSource = Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

/** The signature a response carries (`Provian-Output-Signature`), or null. */
export function readOutputSignatureHeader(headers: HeaderSource): OutputSignature | null {
  if (typeof (headers as Headers).get === 'function') {
    return decodeOutputSignatureHeader((headers as Headers).get(OUTPUT_SIGNATURE_HEADER));
  }
  const record = headers as Readonly<Record<string, string | readonly string[] | undefined>>;
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() !== OUTPUT_SIGNATURE_HEADER.toLowerCase()) continue;
    return decodeOutputSignatureHeader(Array.isArray(v) ? v[0] : v);
  }
  return null;
}

/**
 * A copy of `response` that carries the signature over its exact body bytes. `sign` receives the
 * body and returns the signature (e.g. `(b) => signOutputWithWalletKey(key, b)` or
 * `(b) => client.signOutput(b)`).
 */
export async function signResponse(
  response: Response,
  sign: (body: Uint8Array) => Promise<OutputSignature> | OutputSignature,
): Promise<Response> {
  const body = new Uint8Array(await response.arrayBuffer());
  const signature = await sign(body);
  const headers = new Headers(response.headers);
  headers.set(OUTPUT_SIGNATURE_HEADER, encodeOutputSignatureHeader(signature));
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

// ─── a bearer device's software output key ─────────────────────────────────────

export interface DeviceOutputKey {
  readonly device_id: string;
  readonly private_key_hex: string;
  readonly public_key_hex: string;
  /** True once the relay acknowledged the registration. */
  readonly registered: boolean;
}

/** Where a bearer device keeps its output key (`~/.provian/output-keys/<device>.json`, 0600). */
export function defaultDeviceOutputKeyPath(deviceId: string, home: string = process.env.HOME ?? '.'): string {
  const safe = deviceId.replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(home, '.provian', 'output-keys', `${safe}.json`);
}

/** Load this device's output key, creating it (never replacing it) on first use. */
export function loadOrCreateDeviceOutputKey(deviceId: string, filePath: string = defaultDeviceOutputKeyPath(deviceId)): DeviceOutputKey {
  if (fs.existsSync(filePath)) {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<DeviceOutputKey>;
    if (parsed.device_id !== deviceId || typeof parsed.private_key_hex !== 'string' || canonicalP256PublicKey(parsed.public_key_hex) === null) {
      throw new Error(`output key file ${filePath} does not belong to device ${deviceId}`);
    }
    return { device_id: deviceId, private_key_hex: parsed.private_key_hex, public_key_hex: parsed.public_key_hex as string, registered: parsed.registered === true };
  }
  const priv = Buffer.from(p256.utils.randomPrivateKey()).toString('hex');
  const pub = Buffer.from(p256.getPublicKey(priv, false)).toString('hex');
  const key: DeviceOutputKey = { device_id: deviceId, private_key_hex: priv, public_key_hex: pub, registered: false };
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(key)}\n`, { mode: 0o600, flag: 'wx' });
  return key;
}

/** Record that the relay accepted this key (so the registration is not re-sent). */
export function markDeviceOutputKeyRegistered(key: DeviceOutputKey, filePath: string = defaultDeviceOutputKeyPath(key.device_id)): DeviceOutputKey {
  const next = { ...key, registered: true };
  fs.writeFileSync(filePath, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  return next;
}

/** The body of `PUT /v1/devices/me/output-signing-key`: the key and its proof of possession. */
export function deviceOutputKeyRegistrationBody(key: DeviceOutputKey): { public_key: string; proof: string } {
  const message = outputKeyRegistrationMessage('device', key.device_id, key.public_key_hex);
  const digest = createHash('sha256').update(message, 'utf8').digest('hex');
  return { public_key: key.public_key_hex, proof: p256SignDigestHex(key.private_key_hex, digest) };
}
