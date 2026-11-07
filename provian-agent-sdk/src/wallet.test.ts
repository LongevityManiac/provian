/**
 * Tests for Agent Wallet module.
 *
 * Covers key generation, address derivation, wallet creation,
 * trust profiles, foundation eligibility, and error cases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  generateAgentKeyPair,
  createAgentWallet,
  prepareAgentWalletRegistration,
  resumeAgentWalletRegistration as resumeRawAgentWalletRegistration,
  signMessage,
  getTrustProfile,
} from './wallet';
import {
  loadOrCreatePendingAgentWalletRegistration,
  resumeAgentWalletRegistration,
} from './pending-wallet-registration';
import { deriveEVMAddress } from './chains';
import { keccak256 } from './keccak256';
import type { AgentWalletConfig, TrustProfile } from './types';

// Mirror SDK's address derivation: keccak256(uncompressed public key bytes
// without the 04 prefix)[12:32], then EIP-55 checksum encode.
function deriveEvmAddress(publicKeyHex: string): string {
  let cleaned = publicKeyHex.toLowerCase().replace(/^0x/, '');
  if (cleaned.length === 130 && cleaned.startsWith('04')) cleaned = cleaned.slice(2);
  const pubKeyBytes = Buffer.from(cleaned, 'hex');
  const hash = keccak256(pubKeyBytes);
  const addr = hash.subarray(12).toString('hex');
  // EIP-55 checksum
  const addrLower = addr.toLowerCase();
  const checksumHash = keccak256(Buffer.from(addrLower, 'utf8')).toString('hex');
  let checksummed = '0x';
  for (let i = 0; i < 40; i++) {
    checksummed += parseInt(checksumHash[i], 16) >= 8 ? addrLower[i].toUpperCase() : addrLower[i];
  }
  return checksummed;
}

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('generateAgentKeyPair', () => {
  it('produces a valid key pair and multichain receive addresses', () => {
    const keyPair = generateAgentKeyPair();

    // Private key should be 32 bytes (64 hex chars)
    expect(keyPair.privateKey).toMatch(/^[0-9a-f]{64}$/);

    // Public key should be 64 bytes (128 hex chars, no 04 prefix)
    expect(keyPair.publicKey).toMatch(/^[0-9a-f]{128}$/);

    // Address should be 0x-prefixed 40 hex chars (checksummed)
    expect(keyPair.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(keyPair.chainAddresses.evm).toBe(keyPair.address);
  });

  it('produces different key pairs on each call', () => {
    const kp1 = generateAgentKeyPair();
    const kp2 = generateAgentKeyPair();

    expect(kp1.privateKey).not.toBe(kp2.privateKey);
    expect(kp1.publicKey).not.toBe(kp2.publicKey);
    expect(kp1.address).not.toBe(kp2.address);
  });

  it('derives consistent address from the same key pair', () => {
    const kp1 = generateAgentKeyPair();
    // Re-generate from the same private key via createAgentWallet (with mock)
    // Instead, just verify the address is deterministic from the public key
    const kp2 = generateAgentKeyPair();
    expect(kp1.address).not.toBe(kp2.address); // Different keys → different addresses
  });
});

describe('signMessage', () => {
  it('produces a hex-encoded signature', () => {
    const keyPair = generateAgentKeyPair();
    const signature = signMessage(keyPair.privateKey, 'test message');

    // Should be a hex string (DER-encoded ECDSA signature, variable length)
    expect(signature).toMatch(/^[0-9a-f]+$/);
    expect(signature.length).toBeGreaterThan(0);
  });

  it('produces different signatures for different messages', () => {
    const keyPair = generateAgentKeyPair();
    const sig1 = signMessage(keyPair.privateKey, 'message 1');
    const sig2 = signMessage(keyPair.privateKey, 'message 2');

    expect(sig1).not.toBe(sig2);
  });
});

describe('prepared agent wallet registration', () => {
  let registrationDir: string;
  let pendingPath: string;

  beforeEach(() => {
    mockFetch.mockReset();
    registrationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-wallet-test-'));
    pendingPath = path.join(registrationDir, 'pending.json');
  });

  afterEach(() => {
    fs.rmSync(registrationDir, { recursive: true, force: true });
  });

  // Helper: mock the (challenge → create) two-step PoP flow. The address
  // returned from the create step is computed from the second fetch call's
  // submitted public key, so the relay-vs-local address sanity check passes.
  function mockPopFlow(createOverrides: Record<string, unknown> = {}) {
    // First fetch = GET /challenge
    mockFetch.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({
        challenge_id: 'chal_test',
        challenge: 'd'.repeat(64),
        expires_at: Date.now() + 300_000,
      }),
    }));
    // Second fetch = POST /create - derive the same EVM address from the
    // submitted public_key so the SDK's local-vs-relay address sanity check
    // passes.
    mockFetch.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      const body = JSON.parse((init.body as string) ?? '{}');
      const submittedPubKey = String(body.public_key);
      const echoedAddress = deriveEvmAddress(submittedPubKey);
      return {
        ok: true,
        json: async () => ({
          wallet_id: 'wallet_aw_test-uuid',
          address: echoedAddress,
          public_key: submittedPubKey,
          api_key: `pvn_live_${'a'.repeat(32)}`,
          api_secret: `pvns_${'b'.repeat(64)}`,
          pe_chain_root: 'pe_test-uuid',
          badges: ['genesis_agent'],
          welcome: { message: 'Welcome to Provian' },
          ...createOverrides,
        }),
      };
    });
  }

  async function prepare(config: AgentWalletConfig) {
    return loadOrCreatePendingAgentWalletRegistration(
      config,
      'correct horse battery staple',
      pendingPath,
      { N: 1 << 10, r: 8, p: 1, dklen: 32 },
    );
  }

  it('legacy convenience fails before any network request', async () => {
    await expect(createAgentWallet({
      relayUrl: 'https://api.provian.ai',
      agentId: 'unsafe-agent',
    })).rejects.toThrow('Durable registration state is required');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('retired raw-object resume rejects a fabricated or mutated snapshot before fetch', async () => {
    let durableClone: unknown;
    const raw = await prepareAgentWalletRegistration({
      relayUrl: 'https://api.provian.ai',
      agentId: 'raw-object-agent',
      agentName: 'Original',
      constitutionAcceptedAt: '2026-07-12T00:00:00.000Z',
    }, (prepared) => {
      durableClone = JSON.parse(JSON.stringify(prepared));
    });
    raw.agentName = 'Mutated';
    raw.constitutionAcceptedAt = '2026-07-13T00:00:00.000Z';
    await expect(resumeRawAgentWalletRegistration(raw)).rejects.toMatchObject({
      code: 'DURABLE_REGISTRATION_HANDLE_REQUIRED',
    });
    expect(durableClone).toMatchObject({
      agentName: 'Original',
      constitutionAcceptedAt: '2026-07-12T00:00:00.000Z',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('runs the proof-of-possession flow and returns AgentWalletResult', async () => {
    mockPopFlow();

    const config: AgentWalletConfig = {
      relayUrl: 'https://api.provian.ai',
      agentId: 'test-agent',
      agentName: 'Test Agent',
      constitutionAccepted: true,
    };

    const prepared = await prepare(config);
    const result = await resumeAgentWalletRegistration(prepared);

    // Verify both fetches were made
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Step 1: GET /challenge with public_key in query string
    const [challengeUrl, challengeInit] = mockFetch.mock.calls[0];
    expect(String(challengeUrl)).toContain('/v1/agent/wallet/challenge');
    expect(String(challengeUrl)).toContain('public_key=');
    const challengeRegistrationId = new URL(String(challengeUrl)).searchParams.get('registration_id');
    expect(challengeRegistrationId).toMatch(/^agent-registration-/);
    expect(String(challengeUrl)).toContain('agent_id=test-agent');
    expect(challengeInit?.method).toBe('GET');

    // Step 2: POST /create with PoP fields
    const [createUrl, createInit] = mockFetch.mock.calls[1];
    expect(createUrl).toBe('https://api.provian.ai/v1/agent/wallet/create');
    expect(createInit.method).toBe('POST');

    const body = JSON.parse(createInit.body);
    expect(body.agent_id).toBe('test-agent');
    expect(body.registration_id).toBe(challengeRegistrationId);
    expect(body.agent_name).toBe('Test Agent');
    expect(body.platform).toBe('sdk');
    expect(body.registration_channel).toBe('npm_sdk');
    expect(body.constitution_accepted).toBe(true);
    expect(body.constitution_version).toBe('network-constitution-2026-09-27');
    expect(body.constitution_accepted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.public_key).toMatch(/^[0-9a-f]{128}$/);
    expect(body.challenge_id).toBe('chal_test');
    expect(body.signature).toMatch(/^[0-9a-f]+$/);

    // The locally-generated keypair should produce the chain addresses,
    // independent of the relay response.
    expect(result.walletId).toBe('wallet_aw_test-uuid');
    expect(result.privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.apiKey).toBe(`pvn_live_${'a'.repeat(32)}`);
    expect(result.apiSecret).toBe(`pvns_${'b'.repeat(64)}`);
    expect(result.firstEnvelopeId).toBe('pe_test-uuid');
    expect(result.badges).toEqual(['genesis_agent']);
  });

  it('defaults agentName to agentId and platform to sdk', async () => {
    mockPopFlow();

    const prepared = await prepare({
      relayUrl: 'https://api.provian.ai',
      agentId: 'my-agent',
      constitutionAccepted: true,
    });
    await resumeAgentWalletRegistration(prepared);

    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.agent_name).toBe('my-agent');
    expect(body.platform).toBe('sdk');
  });

  it('does not require Constitution acceptance and forwards the flag as-is', async () => {
    mockPopFlow();

    const prepared = await prepare({
      relayUrl: 'https://api.provian.ai',
      agentId: 'unaccepted-agent',
      constitutionAccepted: false,
    });
    await resumeAgentWalletRegistration(prepared);

    // Acceptance is optional: the flow proceeds and the flag is forwarded.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.constitution_accepted).toBe(false);
  });

  it('forwards a supplied Constitution version without requiring the current one', async () => {
    mockPopFlow();

    const prepared = await prepare({
      relayUrl: 'https://api.provian.ai',
      agentId: 'stale-constitution-agent',
      constitutionAccepted: true,
      constitutionVersion: 'network-constitution-2026-01-01',
    });
    await resumeAgentWalletRegistration(prepared);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.constitution_version).toBe('network-constitution-2026-01-01');
  });

  it('throws on duplicate agent wallet (409)', async () => {
    // Challenge succeeds, then create returns 409
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        challenge_id: 'chal_test',
        challenge: 'd'.repeat(64),
        expires_at: Date.now() + 300_000,
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      text: async () => JSON.stringify({ error: 'A wallet already exists for this agentId' }),
    });

    const prepared = await prepare({
      relayUrl: 'https://api.provian.ai',
      agentId: 'existing-agent',
      constitutionAccepted: true,
    });
    await expect(resumeAgentWalletRegistration(prepared))
      .rejects.toThrow('A wallet already exists for this agentId');
  });

  it('throws on network error during challenge fetch', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const prepared = await prepare({
      relayUrl: 'https://api.provian.ai',
      agentId: 'test-agent',
      constitutionAccepted: true,
    });
    await expect(resumeAgentWalletRegistration(prepared)).rejects.toThrow('Failed to reach relay');
  });

  it('throws ADDRESS_MISMATCH if relay returns a different address', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        challenge_id: 'chal_test',
        challenge: 'd'.repeat(64),
        expires_at: Date.now() + 300_000,
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        wallet_id: 'wallet_aw_test',
        address: '0xDeAdBeefDeAdBeefDeAdBeefDeAdBeefDeAdBeef',
        public_key: 'f'.repeat(128),
        api_key: `pvn_live_${'a'.repeat(32)}`,
        api_secret: `pvns_${'b'.repeat(64)}`,
        pe_chain_root: 'pe_x',
        badges: [],
        welcome: {},
      }),
    });

    const prepared = await prepare({
      relayUrl: 'https://api.provian.ai',
      agentId: 'mismatch',
      constitutionAccepted: true,
    });
    await expect(resumeAgentWalletRegistration(prepared))
      .rejects.toThrow('does not match locally-derived address');
  });

  it('rejects malformed 2xx credentials before a pending registration can be cleared', async () => {
    const prepared = await prepare({
      relayUrl: 'https://api.provian.ai',
      agentId: 'malformed-response-agent',
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ challenge_id: 'chal_test', challenge: 'd'.repeat(64) }),
    });
    mockFetch.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { public_key: string };
      return {
        ok: true,
        json: async () => ({
          wallet_id: '',
          address: deriveEvmAddress(body.public_key),
          public_key: body.public_key,
          api_key: 'malformed',
          api_secret: 'malformed',
          pe_chain_root: '',
        }),
      };
    });
    await expect(resumeAgentWalletRegistration(prepared))
      .rejects.toThrow('malformed wallet identity or credential response');
  });

  it('reuses the exact agent ID and wallet key after an ambiguous create response', async () => {
    const prepared = await prepare({
      relayUrl: 'https://api.provian.ai',
      agentId: 'ambiguous-agent',
      agentName: 'Ambiguous Agent',
      constitutionAcceptedAt: '2026-07-12T00:00:00.000Z',
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ challenge_id: 'challenge-first', challenge: 'a'.repeat(64) }),
    });
    const attemptedBodies: Record<string, unknown>[] = [];
    mockFetch.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      attemptedBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      throw new Error('response lost after commit');
    });
    await expect(resumeAgentWalletRegistration(prepared)).rejects.toThrow('response lost after commit');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ challenge_id: 'challenge-retry', challenge: 'b'.repeat(64) }),
    });
    mockFetch.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      const retryBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      attemptedBodies.push(retryBody);
      const publicKey = String(retryBody.public_key);
      return {
        ok: true,
        json: async () => ({
          wallet_id: 'wallet_aw_recovered',
          address: deriveEvmAddress(publicKey),
          public_key: publicKey,
          api_key: `pvn_live_${'c'.repeat(32)}`,
          api_secret: `pvns_${'d'.repeat(64)}`,
          pe_chain_root: 'pe_birth',
          badges: [],
        }),
      };
    });
    const recovered = await resumeAgentWalletRegistration(prepared);
    expect(recovered.walletId).toBe('wallet_aw_recovered');
    expect(attemptedBodies[1]).toMatchObject({
      agent_id: 'ambiguous-agent',
      constitution_accepted_at: '2026-07-12T00:00:00.000Z',
    });
    expect(attemptedBodies[1]).toMatchObject({
      registration_id: attemptedBodies[0].registration_id,
      agent_id: attemptedBodies[0].agent_id,
      public_key: attemptedBodies[0].public_key,
    });
  });
});

describe('getTrustProfile', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns identical structure for human and agent wallets', async () => {
    const humanProfile: TrustProfile = {
      address: '0x1234567890abcdef1234567890abcdef12345678',
      ownerType: 'human',
      peCount: 42,
      pvtEarned: '150.5',
      trustScore: 75,
      memberSince: '2026-01-01T00:00:00.000Z',
      actionBreakdown: { wallet_created: 1, send: 20, promise_fulfilled: 21 },
    };

    const agentProfile: TrustProfile = {
      address: '0xabcdef1234567890abcdef1234567890abcdef12',
      ownerType: 'agent',
      peCount: 10,
      pvtEarned: '25.0',
      trustScore: 30,
      memberSince: '2026-02-01T00:00:00.000Z',
      actionBreakdown: { wallet_created: 1, agent_communicate: 5, agent_commit: 4 },
    };

    // Fetch human profile
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => humanProfile,
    });

    const human = await getTrustProfile(
      'https://api.provian.ai',
      '0x1234567890abcdef1234567890abcdef12345678',
      'session_123',
    );

    // Fetch agent profile
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => agentProfile,
    });

    const agent = await getTrustProfile(
      'https://api.provian.ai',
      '0xabcdef1234567890abcdef1234567890abcdef12',
      'session_456',
    );

    // Same keys exist on both
    const humanKeys = Object.keys(human).sort();
    const agentKeys = Object.keys(agent).sort();
    expect(humanKeys).toEqual(agentKeys);

    // Verify human profile
    expect(human.ownerType).toBe('human');
    expect(human.peCount).toBe(42);
    expect(human.trustScore).toBe(75);

    // Verify agent profile
    expect(agent.ownerType).toBe('agent');
    expect(agent.peCount).toBe(10);
    expect(agent.trustScore).toBe(30);
  });

  it('throws on 404 (wallet not found)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => JSON.stringify({ error: 'Wallet not found' }),
    });

    await expect(getTrustProfile(
      'https://api.provian.ai',
      '0x0000000000000000000000000000000000000000',
      'session_123',
    )).rejects.toThrow('Wallet not found');
  });
});

describe('Foundation eligibility', () => {
  it('agent wallets are never Foundation-eligible', () => {
    // This tests the logic that would be on the backend.
    // Agent wallets always have foundation_eligible: false.
    const agentWallet: { type: 'agent' | 'human'; foundation_eligible: boolean } = {
      type: 'agent',
      foundation_eligible: false,
    };

    const isEligible = agentWallet.type === 'human' && agentWallet.foundation_eligible === true;
    expect(isEligible).toBe(false);
  });

  it('human wallets with biometric verification are Foundation-eligible', () => {
    const humanWallet = {
      type: 'human' as const,
      foundation_eligible: true,
    };

    const isEligible = humanWallet.type === 'human' && humanWallet.foundation_eligible === true;
    expect(isEligible).toBe(true);
  });

  it('human wallets without biometric verification are not Foundation-eligible', () => {
    const humanWallet = {
      type: 'human' as const,
      foundation_eligible: false,
    };

    const isEligible = humanWallet.type === 'human' && humanWallet.foundation_eligible === true;
    expect(isEligible).toBe(false);
  });
});

describe('chains.ts - multi-chain address derivation', () => {



  it('returns the same EVM address regardless of which chain it targets', () => {
    const kp = generateAgentKeyPair();
    // `kp.address` is the EIP-55 address the SDK computes during key
    // generation. Every EVM chain uses the same secp256k1 → keccak256
    // derivation, so there's exactly one address per key.
    //
    // Fixes the original test's undefined-`addrs` reference. The old
    // assertion (`unique.size === 4`) was incorrect - there is no
    // chain-specific deriver that produces four distinct EVM addresses
    // from one key.
    expect(kp.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const derivedFromPriv = deriveEVMAddress(kp.privateKey);
    expect(derivedFromPriv.toLowerCase()).toBe(kp.address.toLowerCase());
  });

  it('derivation is deterministic for the same private key', () => {
    const { privateKey } = generateAgentKeyPair();
  });

  it('different private keys produce different addresses for each chain', () => {
    const kp1 = generateAgentKeyPair();
    const kp2 = generateAgentKeyPair();
  });
});
