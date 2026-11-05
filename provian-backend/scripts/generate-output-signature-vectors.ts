/**
 * Generate the pinned output-signature vectors (docs/audit/output-signature-vectors.json).
 *
 * The relay, the SDK, the app, the MCP server and the x402 facilitator each sign / verify over the
 * message `core/meter/output-signature.ts` defines, with their own crypto library. These vectors
 * bind every one of them to the same bytes: each package's test re-derives the hash, the message,
 * the digest and the header from the inputs, checks its signer reproduces the signature (RFC 6979 is
 * deterministic for both curves) and that its verifier accepts it.
 *
 * Three signer kinds: `wallet` (secp256k1 EIP-191), `device` and `app` (P-256 over SHA-256 of the
 * message — what a Secure Enclave / StrongBox key signs when handed the digest). The keys are PUBLIC
 * TEST KEYS (Hardhat/Anvil account #0; P-256 scalars 7 and 11) — never Provian keys.
 *
 *   cd provian-backend && npx tsx scripts/generate-output-signature-vectors.ts [--check]
 */
import fs from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { Wallet } from 'ethers';
import {
  appOutputKeyId,
  encodeOutputSignatureHeader,
  outputCitationOrigin,
  outputHashOfBytes,
  outputHashOfText,
  outputKeyRegistrationMessage,
  outputSignatureDigestHex,
  outputSignatureMessage,
  type OutputSignature,
} from '../src/core/meter/output-signature';

const OUT = path.resolve(__dirname, '../../docs/audit/output-signature-vectors.json');
const WALLET_TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const DEVICE_TEST_SCALAR = 7;
const APP_TEST_SCALAR = 11;
const DEVICE_ID = 'dev_vector_macbook';
const CITING_WITNESS = { type: 'observer_device', identity: 'dev_vector_consumer', attestation_tier: 'software' };

function scalarKey(n: number): Uint8Array {
  const k = new Uint8Array(32);
  k[31] = n;
  return k;
}

async function main(): Promise<void> {
  const { p256 } = await import('@noble/curves/nist.js') as unknown as {
    p256: {
      sign(digest: Uint8Array, key: Uint8Array, opts: { prehash: boolean }): Uint8Array;
      getPublicKey(key: Uint8Array, compressed: boolean): Uint8Array;
    };
  };
  const p256Sign = (digestHex: string, scalar: number): string =>
    Buffer.from(p256.sign(Buffer.from(digestHex, 'hex'), scalarKey(scalar), { prehash: false })).toString('hex');
  const p256Pub = (scalar: number): string => Buffer.from(p256.getPublicKey(scalarKey(scalar), false)).toString('hex');
  const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

  const wallet = new Wallet(WALLET_TEST_KEY);
  const devicePub = p256Pub(DEVICE_TEST_SCALAR);
  const appPub = p256Pub(APP_TEST_SCALAR);
  const appId = appOutputKeyId(appPub);
  const text = 'A research summary the producer agent handed out.\n';
  const bytesHex = '00ff10204080c0e0f1f2f3f4f5f6f7f8f9fafbfcfdfeff';

  const cases = [];
  const specs = [
    { kind: 'wallet', input: { kind: 'text', value: text } },
    { kind: 'wallet', input: { kind: 'bytes_hex', value: bytesHex } },
    { kind: 'device', input: { kind: 'text', value: text } },
    { kind: 'app', input: { kind: 'text', value: 'An answer a phone handed out.' } },
  ] as const;
  for (const spec of specs) {
    const hash = spec.input.kind === 'text' ? outputHashOfText(spec.input.value) : outputHashOfBytes(Buffer.from(spec.input.value, 'hex'));
    const message = outputSignatureMessage(hash);
    const digest = outputSignatureDigestHex(hash);
    let signature: OutputSignature;
    if (spec.kind === 'wallet') {
      signature = {
        hash,
        signer: { kind: 'wallet', id: wallet.address.toLowerCase() },
        scheme: 'eip191_secp256k1',
        sig: (await wallet.signMessage(message)).toLowerCase(),
      };
    } else if (spec.kind === 'device') {
      signature = { hash, signer: { kind: 'device', id: DEVICE_ID }, scheme: 'p256_sha256', sig: p256Sign(digest, DEVICE_TEST_SCALAR) };
    } else {
      signature = { hash, signer: { kind: 'app', id: appId }, scheme: 'p256_sha256', sig: p256Sign(digest, APP_TEST_SCALAR) };
    }
    cases.push({
      signer_kind: spec.kind,
      input: spec.input,
      hash,
      message,
      digest,
      signature,
      header: encodeOutputSignatureHeader(signature),
      citation_origin: outputCitationOrigin(signature, CITING_WITNESS),
    });
  }
  const deviceRegistration = outputKeyRegistrationMessage('device', DEVICE_ID, devicePub);
  const appRegistration = outputKeyRegistrationMessage('app', 'user_vector', appPub);
  const doc = {
    note: 'Pinned output-signature vectors (core/meter/output-signature.ts). Public test keys only.',
    wallet_test_private_key: WALLET_TEST_KEY,
    wallet_signer: wallet.address.toLowerCase(),
    device_test_scalar: DEVICE_TEST_SCALAR,
    device_id: DEVICE_ID,
    device_public_key: devicePub,
    app_test_scalar: APP_TEST_SCALAR,
    app_public_key: appPub,
    app_key_id: appId,
    citing_witness: CITING_WITNESS,
    cases,
    registration: {
      device: { message: deviceRegistration, sig: p256Sign(sha256Hex(deviceRegistration), DEVICE_TEST_SCALAR) },
      app: { owner_id: 'user_vector', message: appRegistration, sig: p256Sign(sha256Hex(appRegistration), APP_TEST_SCALAR) },
    },
  };
  const json = `${JSON.stringify(doc, null, 2)}\n`;
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current !== json) {
      console.error('output-signature vectors drift: regenerate');
      process.exit(1);
    }
    console.log('output-signature vectors: ok');
    return;
  }
  fs.writeFileSync(OUT, json);
  console.log(`wrote ${OUT}`);
}

void main();
