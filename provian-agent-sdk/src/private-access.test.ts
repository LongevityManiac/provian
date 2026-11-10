import { expect, test } from 'vitest';
import { getBytes, sha256, concat } from 'ethers';
import { privateRecourseEnvelope } from './private-access';
import { privateRecourseIntent, copyPrivateRecourseRequest } from './private-access-data';

const identity = `0x${'11'.repeat(32)}`, id = `0x${'22'.repeat(32)}`;
test('private access signs the exact HTTP request with independent recovery material', async () => {
  const { slh_dsa_sha2_128s } = await import('@noble/post-quantum/slh-dsa.js');
  const secret = new Uint8Array(32).fill(3), seed = new Uint8Array(32).fill(4);
  const path = `break-restorations/${id}/receipt`, body = { transactionHash: id };
  const pending = privateRecourseEnvelope(identity, secret, seed, path, body, 1000000);
  body.transactionHash = identity;
  const envelope = await pending, authorization = envelope.authorization;
  expect(envelope.request).toEqual({ transactionHash: id });
  expect(authorization.commitment).toBe(sha256(concat([secret, sha256(authorization.publicKey)])));
  const signature = getBytes(authorization.signature), publicKey = getBytes(authorization.publicKey);
  expect(slh_dsa_sha2_128s.verify(signature, getBytes(privateRecourseIntent(authorization, path, envelope.request)), publicKey)).toBe(true);
  expect(slh_dsa_sha2_128s.verify(signature, getBytes(privateRecourseIntent(authorization, path, body)), publicKey)).toBe(false);
  expect(slh_dsa_sha2_128s.verify(signature, getBytes(privateRecourseIntent(authorization, `break-restorations/${id}`, envelope.request)), publicKey)).toBe(false);
  expect(slh_dsa_sha2_128s.verify(new Uint8Array(7856), getBytes(privateRecourseIntent(authorization, path, envelope.request)), publicKey)).toBe(false);
  expect(secret).toEqual(new Uint8Array(32).fill(3)); expect(seed).toEqual(new Uint8Array(32).fill(4));
}, 15000);
test('ambiguous payloads and routes outside private access fail closed', async () => {
  for (const body of [{ omitted: undefined }, { value: NaN }, JSON.parse('{"__proto__":{}}')]) {
    expect(() => copyPrivateRecourseRequest(body)).toThrow('refused');
  }
  await expect(privateRecourseEnvelope(identity, new Uint8Array(32), new Uint8Array(32), 'recover-agent')).rejects.toThrow('refused');
  await expect(privateRecourseEnvelope(identity, new Uint8Array(32), new Uint8Array(32),
    `break-entitlements/0x${'33'.repeat(20)}/${id}`)).rejects.toThrow('refused');
});
