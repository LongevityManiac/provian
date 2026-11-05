/**
 * Tests for ProvianClient.signPayloadWithSecureEnclave().
 *
 * The SDK shells out to the `provian-se-sign` binary and converts its
 * `{r, s}` hex output into a compact 64-byte signature. To keep the test
 * hermetic we mock child_process.execSync so no real Secure Enclave call
 * happens - what we actually verify is:
 *
 *   1. The argv passed to the CLI contains the alias and the SHA-256 of
 *      the canonicalized payload.
 *   2. Canonicalization is stable across equivalent inputs (key order).
 *   3. r and s are concatenated in order and base64-encoded.
 *   4. The reported hashHex matches the manually-computed canonical hash.
 *   5. Missing / invalid config paths raise ProvianError with the right code.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import * as child_process from 'child_process';
import { ProvianClient } from './ProvianClient';
import { ProvianError } from './errors';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execSync: vi.fn(), execFileSync: vi.fn() };
});

// signPayloadWithSecureEnclave switched from execSync (shell-interpolated)
// to execFileSync (argv array, no shell). The mock and assertions follow.
const mockExec = vi.mocked(child_process.execFileSync);

function makeClient(overrides: Partial<ConstructorParameters<typeof ProvianClient>[0]> = {}) {
  return new ProvianClient({
    relayUrl: 'https://relay.test',
    deviceKey: 'pdk_test',
    deviceSecret: 'pds_test',
    deviceId: 'dev_test_123',
    signingMethod: 'secure_enclave_p256',
    signingKeyAlias: 'provian-device-abc',
    seSignBinary: '/usr/local/bin/provian-se-sign',
    ...overrides,
  });
}

describe('ProvianClient.signPayloadWithSecureEnclave', () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('canonicalizes payload with sorted keys before hashing', async () => {
    // Two payloads that differ only by key order - must hash identically.
    const payloadA = { action_type: 'test_run', metadata: { b: 2, a: 1 }, description: 'hello world, testing order' };
    const payloadB = { description: 'hello world, testing order', metadata: { a: 1, b: 2 }, action_type: 'test_run' };

    mockExec.mockReturnValue(JSON.stringify({
      r: 'a'.repeat(64),
      s: 'b'.repeat(64),
    }));

    const client = makeClient();
    const out1 = await client.signPayloadWithSecureEnclave(payloadA);
    const out2 = await client.signPayloadWithSecureEnclave(payloadB);

    expect(out1.hashHex).toBe(out2.hashHex);
    expect(out1.canonical).toBe(out2.canonical);
  });

  it('hashes the canonical form with SHA-256 and passes the hex to the CLI', async () => {
    const payload = { action_type: 'test_run', description: 'confirm sha-256 of canonical form' };
    const canonical = '{"action_type":"test_run","description":"confirm sha-256 of canonical form"}';
    const expectedHash = createHash('sha256').update(canonical, 'utf8').digest('hex');

    mockExec.mockReturnValue(JSON.stringify({ r: '1'.repeat(64), s: '2'.repeat(64) }));

    const client = makeClient();
    const out = await client.signPayloadWithSecureEnclave(payload);

    expect(out.canonical).toBe(canonical);
    expect(out.hashHex).toBe(expectedHash);

    const [binary, argv] = mockExec.mock.calls[0] as [string, string[], unknown];
    expect(binary).toBe('/usr/local/bin/provian-se-sign');
    expect(argv).toEqual([
      '--sign',
      '--key-alias',
      'provian-device-abc',
      '--hash',
      expectedHash,
    ]);
  });

  it('concatenates r||s and base64-encodes the 64-byte compact signature', async () => {
    const r = '11'.repeat(32); // 32 bytes
    const s = '22'.repeat(32);
    mockExec.mockReturnValue(JSON.stringify({ r, s }));

    const client = makeClient();
    const out = await client.signPayloadWithSecureEnclave({ a: 1, message: 'a short message for the test suite' });

    const decoded = Buffer.from(out.signatureBase64, 'base64');
    expect(decoded.length).toBe(64);
    expect(decoded.subarray(0, 32).toString('hex')).toBe(r);
    expect(decoded.subarray(32, 64).toString('hex')).toBe(s);
  });

  it('throws SIGNING_METHOD_MISMATCH when called without secure_enclave_p256', async () => {
    const client = new ProvianClient({
      relayUrl: 'https://relay.test',
      deviceKey: 'pdk_test',
      deviceSecret: 'pds_test',
      // no signingMethod - defaults to bearer
    });

    await expect(client.signPayloadWithSecureEnclave({ ok: true }))
      .rejects
      .toMatchObject({ code: 'SIGNING_METHOD_MISMATCH' });
  });

  it('throws SIGNING_KEY_ALIAS_MISSING when alias is absent', async () => {
    const client = makeClient({ signingKeyAlias: undefined });
    await expect(client.signPayloadWithSecureEnclave({ ok: true }))
      .rejects
      .toMatchObject({ code: 'SIGNING_KEY_ALIAS_MISSING' });
  });

  it('maps CLI failures to SECURE_ENCLAVE_SIGN_FAILED', async () => {
    mockExec.mockImplementation(() => {
      throw new Error('Keychain access denied');
    });
    const client = makeClient();
    await expect(client.signPayloadWithSecureEnclave({ ok: true }))
      .rejects
      .toMatchObject({ code: 'SECURE_ENCLAVE_SIGN_FAILED' });
  });

  it('rejects malformed {r,s} output from the CLI', async () => {
    mockExec.mockReturnValue(JSON.stringify({ r: 'short', s: 'also-short' }));
    const client = makeClient();
    await expect(client.signPayloadWithSecureEnclave({ ok: true }))
      .rejects
      .toMatchObject({ code: 'SECURE_ENCLAVE_SIGN_FAILED' });
  });
});
