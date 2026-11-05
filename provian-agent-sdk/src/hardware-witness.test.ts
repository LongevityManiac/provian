/** Trust Layer §2.9 — the SDK side of the hardware-witness slot. */
import { describe, it, expect } from 'vitest';
import { attachHardwareWitness, canonicalJson, hardwareBindingNonceHex, tpm2QuoteProvider, gcpConfidentialSpaceProvider, autoHardwareWitnessProvider, parseRsaAkTemplate, laneHardwareWitnessProvider
} from './hardware-witness';

// Cross-package pin: the relay's `hardwareBindingNonce` over this exact body (provian-backend
// src/core/hardware/binding.ts) — both sides must agree byte-for-byte or no report ever binds.
const BODY = { action_type: 'coding_session', description: 'x', metadata: { a: 1 }, output_digests: [{ hash: 'sha256:' + 'ab'.repeat(32), kind: 'file' }] };
const PINNED_CANONICAL = '{"action_type":"coding_session","description":"x","metadata":{"a":1},"output_digests":[{"hash":"sha256:abababababababababababababababababababababababababababababababab","kind":"file"}]}';

describe('binding nonce', () => {
  it('canonical JSON is sorted-key, no-whitespace, undefined-dropped (the relay/device-auth form)', () => {
    expect(canonicalJson(BODY)).toBe(PINNED_CANONICAL);
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe('{"a":[1,{"d":2}],"b":1}');
  });
  it('the slot itself never changes the nonce; any other byte does', () => {
    const n = hardwareBindingNonceHex(BODY);
    expect(n).toMatch(/^[0-9a-f]{64}$/);
    expect(n).toBe('5687bb54f26bcd785b650ac896f304ff759b458b38747e11b476c330c0bac036'); // = provian-backend core/hardware/binding.ts over the same body
    expect(hardwareBindingNonceHex({ ...BODY, hardware_witness: { scheme: 'tpm2_quote' } })).toBe(n);
    expect(hardwareBindingNonceHex({ ...BODY, description: 'y' })).not.toBe(n);
    // The relay's global middleware strips these three identity keys IN PLACE before any handler; they are excluded on every side.
    expect(hardwareBindingNonceHex({ ...BODY, actor_address: '0x1234', user_id: 'u', wallet_id: 'w' })).toBe(n);
  });
});

describe('attachHardwareWitness', () => {
  it('calls the producer with the nonce of the slot-less body and attaches what it returns; null / throw → no slot', async () => {
    const seen: string[] = [];
    const out = await attachHardwareWitness({ ...BODY, hardware_witness: { scheme: 'nvidia_cc' } }, async (nonce) => { seen.push(nonce); return { scheme: 'tpm2_quote', nonce_binding: 'body_sha256', quote: 'AA==' }; });
    expect(seen).toEqual([hardwareBindingNonceHex(BODY)]);
    expect(out.hardware_witness).toEqual({ scheme: 'tpm2_quote', nonce_binding: 'body_sha256', quote: 'AA==' });
    expect(await attachHardwareWitness(BODY, async () => null)).toEqual(BODY);
    expect(await attachHardwareWitness(BODY, async () => { throw new Error('boom'); })).toEqual(BODY);
    expect(await attachHardwareWitness(BODY, undefined)).toEqual(BODY);
  });
});

describe('producers never block a submission', () => {
  it('tpm2 without tpm2-tools → null; confidential space without the launcher socket → null; auto on this host → undefined or a function', async () => {
    expect(await tpm2QuoteProvider({ toolsDir: '/nonexistent/provian-tpm2-tools' })('00'.repeat(32))).toBeNull();
    expect(await gcpConfidentialSpaceProvider({ socketPath: '/nonexistent/teeserver.sock' })('00'.repeat(32))).toBeNull();
    const auto = autoHardwareWitnessProvider();
    expect(auto === undefined || typeof auto === 'function').toBe(true);
  });
});

describe('tpm2 producer — the certified AK is reproduced from the byte-exact stored template', () => {
  // The TPMT_PUBLIC Google stores at NV 0x01c10001 on the Confidential VM `provian-tpm-proof`
  // (2026-09-17; public bytes). Its attribute set has NO `noda`, and its `unique` is 256 per-instance
  // bytes — the two facts that made a spelled-out template derive a DIFFERENT (uncertified) key.
  const TEMPLATE = Buffer.from('0001000b00050072000000100014000b0800000000000100e8fe96b4c3d671c3e955eba892259d21706df63555950c16066da6fa744b4990519c9e085d61709d0c3a40968c9f156310cfaccc57a2d45a197beca790490a6bd3151c33878f571a96c935fbec2783d46b7ef4e5b62d97fa4af0a5ddd2e3a36118496060e9b1ebb58a2b4045db678561cb69082e7a4872de26f295401450de53f69ce8dde37117ea3a8b212ddea16239518e04b739216fc79051fd5ef0d6847328e0712833caadff7cfd25c596c8c321b49c778098522a8cefb988cfaae1eb45895894af00c9f7d6204474260b2634fe5400b3a24d453d9af971cafdcfef4bee20127903b76d27df05898da57cd3264905824e1560d61f957085a745684a2a0a', 'hex');
  it('parses attrs (without noda), key bits and the 256-byte unique; a TPM2B wrapper is unwrapped; non-RSA / non-RSASSA is null', () => {
    const t = parseRsaAkTemplate(TEMPLATE);
    expect(t).not.toBeNull();
    expect(t!.attrs).toBe('fixedtpm|fixedparent|sensitivedataorigin|userwithauth|restricted|sign');
    expect(t!.keyBits).toBe(2048);
    expect(t!.nameAlg).toBe('sha256');
    expect(t!.unique.length).toBe(256);
    expect(t!.unique.subarray(0, 4).toString('hex')).toBe('e8fe96b4');
    const wrapped = Buffer.concat([Buffer.from([(TEMPLATE.length >> 8) & 0xff, TEMPLATE.length & 0xff]), TEMPLATE]);
    expect(parseRsaAkTemplate(wrapped)!.unique.equals(t!.unique)).toBe(true);
    const ecc = Buffer.from(TEMPLATE); ecc.writeUInt16BE(0x0023, 0);
    expect(parseRsaAkTemplate(ecc)).toBeNull();
    expect(parseRsaAkTemplate(TEMPLATE.subarray(0, 40))).toBeNull();
  });
});

describe('laneHardwareWitnessProvider — the commit lane carries the hardware_witness slot (2026-10-10)', () => {
  const provider = (async () => null) as unknown as import('./hardware-witness').HardwareWitnessProvider;
  it('GREEN: without an opt-out the lane attaches what the box detects', () => {
    expect(laneHardwareWitnessProvider({}, () => provider)).toBe(provider);
    expect(laneHardwareWitnessProvider({ PROVIAN_HARDWARE_WITNESS: 'auto' }, () => provider)).toBe(provider);
  });
  it('RED: PROVIAN_HARDWARE_WITNESS=none opts the lane out, exactly like the observer', () => {
    let detected = 0;
    expect(laneHardwareWitnessProvider({ PROVIAN_HARDWARE_WITNESS: 'none' }, () => { detected += 1; return provider; })).toBeUndefined();
    expect(detected).toBe(0);
  });
  it('a box with nothing to attest attaches nothing', () => {
    expect(laneHardwareWitnessProvider({}, () => undefined)).toBeUndefined();
  });
});
