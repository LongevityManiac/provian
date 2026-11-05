/** Trust Layer §2.9 — the phone's binding nonce equals the relay's and the SDK's (cross-package pin). */
import { describe, it, expect } from 'vitest';
import { canonicalJson, hardwareBindingNonceHex, hardwareBindingNonceBase64 } from './hardwareBinding';
import { registrationClientDataHashBase64 } from './AppAttest';

const BODY = { action_type: 'coding_session', description: 'x', metadata: { a: 1 }, output_digests: [{ hash: 'sha256:' + 'ab'.repeat(32), kind: 'file' }] };
const PINNED_CANONICAL = '{"action_type":"coding_session","description":"x","metadata":{"a":1},"output_digests":[{"hash":"sha256:abababababababababababababababababababababababababababababababab","kind":"file"}]}';

describe('hardwareBinding (mirror of provian-backend core/hardware/binding.ts)', () => {
  it('canonical JSON: sorted keys, no whitespace, undefined dropped', () => {
    expect(canonicalJson(BODY)).toBe(PINNED_CANONICAL);
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe('{"a":[1,{"d":2}],"b":1}');
  });
  it('the slot never changes the nonce; other bytes do; base64 and hex agree', () => {
    const hex = hardwareBindingNonceHex(BODY);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hex).toBe('5687bb54f26bcd785b650ac896f304ff759b458b38747e11b476c330c0bac036'); // = the relay's hardwareBindingNonce over the same body
    expect(hardwareBindingNonceHex({ ...BODY, hardware_witness: { scheme: 'apple_app_attest' } })).toBe(hex);
    expect(hardwareBindingNonceHex({ ...BODY, description: 'y' })).not.toBe(hex);
    // actor_address / user_id / wallet_id are stripped in place by the relay before its handler runs — excluded on every side .
    expect(hardwareBindingNonceHex({ ...BODY, actor_address: '0x1234567890abcdef', user_id: 'u', wallet_id: 'w' })).toBe(hex);
    expect(Buffer.from(hardwareBindingNonceBase64(BODY), 'base64').toString('hex')).toBe(hex);
  });
  it('registration binding = sha256(canonicalJson({ purpose, key_id, user_id })) — binds the account', () => {
    const b64 = registrationClientDataHashBase64('AQID', 'user_1');
    expect(Buffer.from(b64, 'base64').length).toBe(32);
    expect(registrationClientDataHashBase64('AQID', 'user_1')).toBe(b64);
    expect(registrationClientDataHashBase64('BAUG', 'user_1')).not.toBe(b64);
    expect(registrationClientDataHashBase64('AQID', 'user_2')).not.toBe(b64);
  });
});
