/**
 * Signed outputs on the SDK side : the producer signs (wallet key, or the device's
 * registered key on a device without the wallet key), the consumer's device captures what it
 * RECEIVED signed and cites it on its next observed PE. Each claim carries its RED control.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { p256 } from '@noble/curves/p256';
import { createHash } from 'crypto';
import {
  decodeOutputSignatureHeader,
  encodeOutputSignatureHeader,
  outputCitationOrigin,
  outputHashOfBytes,
  outputHashOfText,
  outputSignatureDigestHex,
  outputSignatureMessage,
  signedCitationOf,
  appOutputKeyId,
  OUTPUT_SIGNATURE_HEADER,
  type OutputSignature,
} from './output-signature';
import {
  deviceOutputKeyRegistrationBody,
  loadOrCreateDeviceOutputKey,
  outputSignatureMatches,
  p256OutputSignatureVerifies,
  p256SignDigestHex,
  readOutputSignatureHeader,
  signOutputWithWalletKey,
  signResponse,
  walletOutputSignatureRecovers,
} from './output-signing';
import { drainOutputCitations, enqueueOutputCitation } from './meter/output-citations';
import { recognizeOutputSignaturesInText } from './output-citation-recognizer';
import { normalizeInputOrigins } from './input-origins';
import { MemoryPeStore } from './meter/pe-store';
import { ProvianClient } from './ProvianClient';
import { SUBMIT_OBSERVED_PE } from './observed-submit';

const V = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../docs/audit/output-signature-vectors.json'), 'utf8'));

function scalarKey(n: number): string {
  return n.toString(16).padStart(64, '0');
}

describe('pinned vectors — the SDK reproduces every signature byte for byte', () => {
  it('wallet (noble secp256k1 EIP-191) and device / app (noble P-256 over the digest)', () => {
    expect(V.cases).toHaveLength(4); // empty-population guard
    for (const c of V.cases) {
      const hash = c.input.kind === 'text' ? outputHashOfText(c.input.value) : outputHashOfBytes(Buffer.from(c.input.value, 'hex'));
      expect(hash).toBe(c.hash);
      expect(outputSignatureMessage(hash)).toBe(c.message);
      expect(outputSignatureDigestHex(hash)).toBe(c.digest);
      expect(encodeOutputSignatureHeader(c.signature)).toBe(c.header);
      expect(decodeOutputSignatureHeader(c.header)).toEqual(c.signature);
      expect(outputCitationOrigin(c.signature, V.citing_witness)).toEqual(c.citation_origin);
      if (c.signer_kind === 'wallet') {
        const input = c.input.kind === 'text' ? c.input.value : new Uint8Array(Buffer.from(c.input.value, 'hex'));
        expect(signOutputWithWalletKey(V.wallet_test_private_key, input)).toEqual(c.signature);
        expect(walletOutputSignatureRecovers(c.signature)).toBe(true);
      } else {
        const scalar = c.signer_kind === 'device' ? V.device_test_scalar : V.app_test_scalar;
        expect(p256SignDigestHex(scalarKey(scalar), c.digest)).toBe(c.signature.sig);
        expect(p256OutputSignatureVerifies(c.signer_kind === 'device' ? V.device_public_key : V.app_public_key, c.signature)).toBe(true);
      }
    }
    expect(appOutputKeyId(V.app_public_key)).toBe(V.app_key_id);
    const devDigest = createHash('sha256').update(V.registration.device.message, 'utf8').digest('hex');
    expect(p256SignDigestHex(scalarKey(V.device_test_scalar), devDigest)).toBe(V.registration.device.sig);
  });

  it('RED — a signature recovers only to its own signer and verifies only against its own key', () => {
    const [w] = V.cases;
    const foreign = { ...w.signature, signer: { kind: 'wallet', id: `0x${'1'.repeat(40)}` } } as OutputSignature;
    expect(walletOutputSignatureRecovers(foreign)).toBe(false);
    const d = V.cases[2];
    expect(p256OutputSignatureVerifies(V.app_public_key, d.signature)).toBe(false);
    expect(outputSignatureMatches(w.signature, w.input.value)).toBe(true);
    expect(outputSignatureMatches(w.signature, `${w.input.value} `)).toBe(false);
  });
});

describe('carrying a signature', () => {
  it('signResponse puts the header on the exact body; readOutputSignatureHeader reads it back', async () => {
    const key = V.wallet_test_private_key as string;
    const res = await signResponse(new Response('the answer', { status: 200, headers: { 'content-type': 'text/plain' } }), (b) => signOutputWithWalletKey(key, b));
    const sig = readOutputSignatureHeader(res.headers);
    expect(sig).not.toBeNull();
    expect(outputSignatureMatches(sig as OutputSignature, 'the answer')).toBe(true);
    expect(await res.text()).toBe('the answer');
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(readOutputSignatureHeader({ 'provian-output-signature': res.headers.get(OUTPUT_SIGNATURE_HEADER) ?? '' })).toEqual(sig);
    // RED: no header → null; garbage → null.
    expect(readOutputSignatureHeader(new Headers())).toBeNull();
    expect(readOutputSignatureHeader({ [OUTPUT_SIGNATURE_HEADER]: 'not-a-signature' })).toBeNull();
  });

  it('the input_origins normalizer keeps the signature on an out: entry; RED: on any other entry it is dropped', () => {
    const c = V.cases[0];
    expect(normalizeInputOrigins([c.citation_origin])![0].signature).toEqual(c.signature);
    expect(normalizeInputOrigins([{ ...c.citation_origin, origin_identifier: 'domain:example.com' }])![0].signature).toBeUndefined();
    expect(signedCitationOf({ ...c.citation_origin, hash: V.cases[1].hash })).toBeNull();
  });
});

describe('the transcript recognizer reads signatures out of a tool result', () => {
  it('header line, JSON field, and JSON-in-a-string; never anything else', () => {
    const [a, b] = V.cases;
    expect(recognizeOutputSignaturesInText(`HTTP/2 200\r\n${OUTPUT_SIGNATURE_HEADER}: ${a.header}\r\n\r\nbody`)).toEqual([a.signature]);
    expect(recognizeOutputSignaturesInText(JSON.stringify({ answer: 'x', provian_output_signature: b.signature }))).toEqual([b.signature]);
    expect(recognizeOutputSignaturesInText(JSON.stringify({ text: JSON.stringify({ provian_output_signature: a.signature }) }))).toEqual([a.signature]);
    // Duplicates collapse.
    expect(recognizeOutputSignaturesInText(`${OUTPUT_SIGNATURE_HEADER}: ${a.header}\n${OUTPUT_SIGNATURE_HEADER}: ${a.header}`)).toHaveLength(1);
    // RED: a tampered object, plain prose, and a header with a malformed value yield nothing.
    expect(recognizeOutputSignaturesInText(JSON.stringify({ provian_output_signature: { ...a.signature, scheme: 'p256_sha256' } }))).toEqual([]);
    expect(recognizeOutputSignaturesInText('the provian output signature was lost')).toEqual([]);
    expect(recognizeOutputSignaturesInText(`${OUTPUT_SIGNATURE_HEADER}: ${'A'.repeat(60)}`)).toEqual([]);
  });
});

describe('the consumer device cites what it RECEIVED signed on its next observed PE', () => {
  afterEach(() => vi.unstubAllGlobals());
  const relayUrl = 'https://relay.test';

  it('wrapFetchWithOutputCitations queues a matching signed response; the next PE carries it on the device witness', async () => {
    const store = new MemoryPeStore('dev_consumer', 'memory:consumer-1');
    const client = new ProvianClient({ relayUrl, deviceKey: 'pdk_x', deviceSecret: 'pds_x', deviceId: 'dev_consumer', peStore: store });
    const seller = async (): Promise<Response> => signResponse(new Response('paid content'), (b) => signOutputWithWalletKey(V.wallet_test_private_key, b));
    const fetchFn = client.wrapFetchWithOutputCitations(seller as unknown as typeof fetch);
    expect(await (await fetchFn('https://seller.test/x')).text()).toBe('paid content'); // response unchanged
    await client[SUBMIT_OBSERVED_PE]({ actionType: 'agent_tool_orchestration', success: true, metadata: { tool_count: 1 } });
    const [stored] = await store.readPes(0, 10);
    const origins = (stored.pe as unknown as { input_origins: Array<Record<string, unknown>> }).input_origins;
    expect(origins).toHaveLength(1);
    expect(origins[0]).toMatchObject({
      hash: outputHashOfText('paid content'),
      origin_identifier: `out:wallet:${V.wallet_signer}`,
      witnessed: true,
      witness: { type: 'observer_device', identity: 'dev_consumer' },
    });
    // The queue was emptied: the NEXT PE cites nothing.
    await client[SUBMIT_OBSERVED_PE]({ actionType: 'agent_tool_orchestration', success: true, metadata: { tool_count: 1 } });
    const second = (await store.readPes(1, 1))[0].pe as unknown as Record<string, unknown>;
    expect('input_origins' in second).toBe(false);
  });

  it('RED — a signature over OTHER bytes than the body received is never queued', async () => {
    const store = new MemoryPeStore('dev_consumer', 'memory:consumer-2');
    const client = new ProvianClient({ relayUrl, deviceKey: 'pdk_x', deviceSecret: 'pds_x', deviceId: 'dev_consumer', peStore: store });
    const sigOverOther = signOutputWithWalletKey(V.wallet_test_private_key, 'something else');
    const seller = async (): Promise<Response> => new Response('paid content', { headers: { [OUTPUT_SIGNATURE_HEADER]: encodeOutputSignatureHeader(sigOverOther) } });
    await client.wrapFetchWithOutputCitations(seller as unknown as typeof fetch)('https://seller.test/x');
    expect(drainOutputCitations('memory:consumer-2')).toEqual([]);
  });

  it('RED — a client without device credentials captures nothing (no witness to cite on)', async () => {
    const client = new ProvianClient({ relayUrl });
    const seller = async (): Promise<Response> => signResponse(new Response('x'), (b) => signOutputWithWalletKey(V.wallet_test_private_key, b));
    const res = await client.wrapFetchWithOutputCitations(seller as unknown as typeof fetch)('https://seller.test/x');
    expect(await res.text()).toBe('x');
  });

  it('the file queue survives across processes and drains oldest-first, deduped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-'));
    const [a, b] = V.cases;
    expect(enqueueOutputCitation(dir, a.signature)).toBe(true);
    expect(enqueueOutputCitation(dir, a.signature)).toBe(true);
    expect(enqueueOutputCitation(dir, b.signature)).toBe(true);
    expect(drainOutputCitations(dir, 1)).toEqual([a.signature]);
    expect(drainOutputCitations(dir, 10)).toEqual([b.signature]);
    expect(drainOutputCitations(dir, 10)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a brand-new device (store directory not created yet) still queues on disk, so another process can cite it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-new-'));
    const dir = path.join(root, 'pe-store', 'dev_new'); // never created: the device has recorded no PE
    const [a] = V.cases;
    expect(enqueueOutputCitation(dir, a.signature)).toBe(true);
    // RED (live finding 2026-10-04): the queue fell back to process memory here, so a capture by
    // one process (a fetch) was lost before the next PE (the hook / the daemon) could cite it.
    expect(fs.existsSync(dir)).toBe(true);
    expect(drainOutputCitations(dir, 10)).toEqual([a.signature]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('a device without the wallet key signs with its REGISTERED key', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a bearer device creates one P-256 output key, registers it once (proof of possession), then signs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-'));
    const keyPath = path.join(dir, 'k.json');
    const puts: Array<{ url: string; body: { public_key: string; proof: string } }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      puts.push({ url, body: JSON.parse(String(init?.body)) as { public_key: string; proof: string } });
      return new Response(JSON.stringify({ registered: true }), { status: 201 });
    }));
    const client = new ProvianClient({ relayUrl: 'https://relay.test', deviceKey: 'pdk_x', deviceSecret: 'pds_x', deviceId: 'dev_mac', outputKeyPath: keyPath, peStore: new MemoryPeStore('dev_mac', 'memory:signer') });
    const s1 = await client.signOutput('a MacBook output');
    const s2 = await client.signOutput('another');
    expect(puts).toHaveLength(1); // registered once
    expect(puts[0].url).toBe('https://relay.test/v1/devices/me/output-signing-key');
    const key = loadOrCreateDeviceOutputKey('dev_mac', keyPath);
    expect(key.registered).toBe(true);
    expect(puts[0].body).toEqual(deviceOutputKeyRegistrationBody(key));
    expect(s1.signer).toEqual({ kind: 'device', id: 'dev_mac' });
    expect(s1.scheme).toBe('p256_sha256');
    expect(p256OutputSignatureVerifies(key.public_key_hex, s1)).toBe(true);
    expect(p256OutputSignatureVerifies(key.public_key_hex, s2)).toBe(true);
    // RED: the signature does not verify under a different key, nor over different bytes.
    const other = Buffer.from(p256.getPublicKey(scalarKey(5), false)).toString('hex');
    expect(p256OutputSignatureVerifies(other, s1)).toBe(false);
    expect(outputSignatureMatches(s1, 'another')).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('RED — when the relay refuses the key, signOutput throws and the key stays unregistered', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-'));
    const keyPath = path.join(dir, 'k.json');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"proof_of_possession_invalid"}', { status: 400 })));
    const client = new ProvianClient({ relayUrl: 'https://relay.test', deviceKey: 'pdk_x', deviceSecret: 'pds_x', deviceId: 'dev_mac', outputKeyPath: keyPath, peStore: new MemoryPeStore('dev_mac', 'memory:signer2') });
    await expect(client.signOutput('x')).rejects.toThrow(/refused this device's output key/);
    expect(loadOrCreateDeviceOutputKey('dev_mac', keyPath).registered).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
