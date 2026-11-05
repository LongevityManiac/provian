/**
 * Tests for the SE-signing branch of device-mode submission.
 *
 * Regression coverage for the audit's HIGH-1 finding: report-pe.ts and
 * ProvianObserver.ts used to construct ProvianClient with only
 * (relayUrl, deviceKey, deviceSecret), silently dropping signingMethod /
 * signingKeyAlias / deviceId. Devices registered with Secure Enclave then
 * submitted every PE via bearer DeviceKey instead of DeviceSignature,
 * nullifying the human Mac's hardware_partial attestation evidence.
 *
 * PE meter : a PE is recorded on the device and its act record
 * reaches the relay inside the daily batch — so the batch POST (`/v1/meter/batch`) is now the
 * device-signed, body-bound submission. These tests verify, end to end through the observed-PE
 * recorder and the batcher, that:
 * - When constructed with signingMethod='secure_enclave_p256' the batch carries
 * DeviceSignature + X-Provian-Signature headers bound to POST /v1/meter/batch, and the
 * wire body is the canonical sorted-key form (not JSON.stringify).
 * - When constructed without signingMethod the client falls back to the bearer DeviceKey
 * header, and binds the exact wire body with X-Provian-Body-HMAC (a batch that is not
 * body-bound has every act refused by the relay).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import * as child_process from 'child_process';
import { ProvianClient } from './ProvianClient';
import { SUBMIT_OBSERVED_PE } from './observed-submit';
import { MemoryPeStore } from './meter/pe-store';
import { FakeMeterRelay, type FakeRequest } from './meter/capturing-store.test-support';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execSync: vi.fn(), execFileSync: vi.fn() };
});

// signPayloadWithSecureEnclave invokes execFileSync (argv array, no shell).
const mockExec = vi.mocked(child_process.execFileSync);

/** Record one PE on the device, send the daily batch, return the batch POST the relay saw. */
async function recordAndSend(client: ProvianClient, relay: FakeMeterRelay, report: { actionType: string; description: string; metadata: Record<string, unknown> }): Promise<FakeRequest> {
  vi.stubGlobal('fetch', relay.fetch);
  const recorded = await client[SUBMIT_OBSERVED_PE]({ ...report, success: true });
  expect(recorded && 'pe_id' in recorded).toBe(true);
  expect(relay.requests).toHaveLength(0); // recording needs no network
  const sent = await (await client.createMeterBatcher()).flush();
  expect(sent.outcome).toBe('sent');
  const posts = relay.batchPosts();
  expect(posts).toHaveLength(1);
  return posts[0];
}

describe('ProvianClient device-mode submission with SE signing forwarded (the daily batch)', () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses DeviceSignature when signingMethod=secure_enclave_p256 is forwarded', async () => {
    // Mock the SE CLI to return a well-formed {r, s}.
    mockExec.mockReturnValue(JSON.stringify({
      r: 'a'.repeat(64),
      s: 'b'.repeat(64),
    }));
    const relay = new FakeMeterRelay('dev_test_456');
    const client = new ProvianClient({
      relayUrl: 'https://relay.test',
      deviceKey: 'pdk_test',
      deviceSecret: 'pds_test',
      deviceId: 'dev_test_456',
      signingMethod: 'secure_enclave_p256',
      signingKeyAlias: 'provian-device-xyz',
      seSignBinary: '/usr/local/bin/provian-se-sign',
      peStore: new MemoryPeStore('dev_test_456'),
    });
    const post = await recordAndSend(client, relay, {
      actionType: 'test_run',
      description: 'forwarded signingMethod actually triggers SE signing path',
      metadata: { tool: 'vitest' },
    });

    expect(post.headers['Authorization']).toBe('DeviceSignature dev_test_456');
    // BLOCKER-4 (2026-05-06): X-Provian-Signature carries the bound-preimage envelope as
    // <preimage_b64u>.<sig_b64u>. Both sides are base64url; the dot is the separator.
    const sigHeader = post.headers['X-Provian-Signature'];
    expect(sigHeader).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const [preimageB64u] = sigHeader.split('.');
    const envelope = JSON.parse(Buffer.from(preimageB64u, 'base64url').toString('utf8'));
    expect(envelope.mth).toBe('POST');
    expect(envelope.pth).toBe('/v1/meter/batch');
    expect(typeof envelope.bh).toBe('string');
    expect(typeof envelope.iat).toBe('number');
    expect(envelope.exp).toBeGreaterThan(envelope.iat);
    expect(typeof envelope.jti).toBe('string');
    expect(envelope.aud).toBe('provian-relay-prod');
    expect(post.headers['X-Provian-Pubkey-Id']).toBe('dev_test_456');

    // The signature binds the canonical ciphertext wrapper; private act fields never leave clear.
    const body = post.body!;
    expect(Object.keys(JSON.parse(body))).toEqual(['private_batch']);
    expect(body).not.toContain('acts_root');
    expect(relay.accepted).toHaveLength(1);

    // The SE CLI must have been invoked with the alias.
    expect(mockExec).toHaveBeenCalled();
    const [binary, argv] = mockExec.mock.calls[0] as [string, string[], unknown];
    expect(binary).toBe('/usr/local/bin/provian-se-sign');
    expect(argv).toContain('--key-alias');
    expect(argv).toContain('provian-device-xyz');
  });

  it('falls back to bearer DeviceKey when signingMethod is absent', async () => {
    const relay = new FakeMeterRelay('dev_bearer');
    const client = new ProvianClient({
      relayUrl: 'https://relay.test',
      deviceKey: 'pdk_test',
      deviceSecret: 'pds_test',
      peStore: new MemoryPeStore('dev_bearer'),
    });
    const post = await recordAndSend(client, relay, {
      actionType: 'test_run',
      description: 'no signingMethod set means bearer DeviceKey is used',
      metadata: { tool: 'vitest' },
    });
    expect(post.headers['Authorization']).toBe('DeviceKey pdk_test:pds_test');
    expect(post.headers['X-Provian-Signature']).toBeUndefined();
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('a bearer batch binds the body via X-Provian-Body-HMAC = hmac(secret, wireBody)', async () => {
    // The gate for device-witnessed VERIFIED earning on a bearer daemon (the agent/Atlas case).
    // The relay recomputes this hmac over req.rawBody; a batch that is not body-bound has every
    // act refused (`actor_declared:device_body_not_bound`).
    const relay = new FakeMeterRelay('dev_bearer');
    const client = new ProvianClient({
      relayUrl: 'https://relay.test',
      deviceKey: 'pdk_test',
      deviceSecret: 'pds_secret_xyz',
      peStore: new MemoryPeStore('dev_bearer'),
    });
    const post = await recordAndSend(client, relay, {
      actionType: 'agent_tool_orchestration',
      description: 'two tool calls this turn',
      metadata: { trace_id: 't1', tool_count: 2 },
    });
    const hmacHeader = post.headers['X-Provian-Body-HMAC'];
    // hmac over the EXACT wire body the SDK sent — byte-for-byte what the relay verifies.
    const expected = createHmac('sha256', 'pds_secret_xyz').update(post.body!, 'utf8').digest('hex');
    expect(hmacHeader).toBe(expected);
    // RED control: the same header does not verify any other body (a re-serialised batch).
    const reserialised = JSON.stringify(JSON.parse(post.body!), null, 1);
    expect(createHmac('sha256', 'pds_secret_xyz').update(reserialised, 'utf8').digest('hex')).not.toBe(hmacHeader);
  });
});
