/**
 * External-address proof-of-control — SDK tests.
 *
 * Every assertion here ships with its RED control on the same call: the shape
 * that must be REFUSED is constructed and asserted to throw, right beside the
 * shape that must be admitted. A guard that cannot fail is the failure mode
 * this file is written to exclude.
 *
 * The canonical message is NOT re-declared here. It is built by the module
 * under test (`buildExternalProofMessage`) so the fixtures cannot drift from
 * the reader — and the one place the relay's own format is asserted
 * independently is `relayCanonicalMessage`, which is transcribed from
 * `provian-backend/src/core/external-address/challenge.ts:buildProofMessage`
 * and cross-checked against the SDK's builder.
 */

import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  assertChallengeBindsToAddress,
  buildExternalProofMessage,
  linkExternalAddress,
  requestExternalAddressChallenge,
  verifyExternalAddress,
  ExternalAddressError,
  EXTERNAL_ADDRESS_PROOF_TTL_MS,
  type ExternalAddressChallenge,
} from './external-address';

const CONFIG = {
  relayUrl: 'https://relay.test',
  apiKey: 'pvn_live_test',
  apiSecret: 'pvns_test',
};

// A real key/address pair, so signatures are genuinely verifiable.
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ADDRESS = ethers.computeAddress(KEY).toLowerCase();
const OTHER_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';
const OTHER_ADDRESS = ethers.computeAddress(OTHER_KEY).toLowerCase();

const ISSUED = 1_800_000_000_000;
const EXPIRES = ISSUED + EXTERNAL_ADDRESS_PROOF_TTL_MS;
const NOW = ISSUED + 1_000;
const AGENT_ID = 'agent_atlas';
const NONCE = 'a'.repeat(32);
const CHALLENGE_ID = '11111111-2222-4333-8444-555555555555';

/**
 * The relay's format, transcribed from `buildProofMessage` in
 * provian-backend/src/core/external-address/challenge.ts. Kept as an
 * independent witness so a change to the SDK builder alone cannot pass.
 */
function relayCanonicalMessage(agentId: string, address: string, nonce: string): string {
  return [
    'Provian proof of control',
    `agent: ${agentId}`,
    `address: ${address}`,
    `nonce: ${nonce}`,
    `issued: ${new Date(ISSUED).toISOString()}`,
    `expires: ${new Date(EXPIRES).toISOString()}`,
  ].join('\n');
}

function goodChallenge(overrides: Partial<ExternalAddressChallenge> = {}): ExternalAddressChallenge {
  return {
    challenge_id: CHALLENGE_ID,
    message: buildExternalProofMessage({
      agent_id: AGENT_ID,
      address: ADDRESS,
      nonce: NONCE,
      issued_at: ISSUED,
      expires_at: EXPIRES,
    }),
    nonce: NONCE,
    issued_at: ISSUED,
    expires_at: EXPIRES,
    chain: 'base',
    chain_id: 8453,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('canonical proof message', () => {
  it('matches the relay format byte for byte (independent witness)', () => {
    expect(buildExternalProofMessage({
      agent_id: AGENT_ID,
      address: ADDRESS,
      nonce: NONCE,
      issued_at: ISSUED,
      expires_at: EXPIRES,
    })).toBe(relayCanonicalMessage(AGENT_ID, ADDRESS, NONCE));
  });

  it('RED CONTROL: the witness is not vacuous — a different address changes it', () => {
    expect(buildExternalProofMessage({
      agent_id: AGENT_ID,
      address: OTHER_ADDRESS,
      nonce: NONCE,
      issued_at: ISSUED,
      expires_at: EXPIRES,
    })).not.toBe(relayCanonicalMessage(AGENT_ID, ADDRESS, NONCE));
  });
});

describe('assertChallengeBindsToAddress', () => {
  it('GREEN: admits a well-formed challenge and returns the decoded binding', () => {
    const binding = assertChallengeBindsToAddress(goodChallenge(), ADDRESS, NOW);
    expect(binding).toEqual({
      agent_id: AGENT_ID,
      address: ADDRESS,
      nonce: NONCE,
      issued_at: ISSUED,
      expires_at: EXPIRES,
    });
  });

  it('GREEN: accepts a mixed-case requested address and normalizes it', () => {
    const mixed = ethers.getAddress(ADDRESS); // EIP-55 checksummed
    expect(mixed).not.toBe(ADDRESS); // the input really is mixed case
    expect(assertChallengeBindsToAddress(goodChallenge(), mixed, NOW).address).toBe(ADDRESS);
  });

  // ---- RED controls: each severs exactly one conjunct -----------------------

  it('RED: a message bound to a DIFFERENT address is refused', () => {
    const challenge = goodChallenge({
      message: buildExternalProofMessage({
        agent_id: AGENT_ID,
        address: OTHER_ADDRESS,
        nonce: NONCE,
        issued_at: ISSUED,
        expires_at: EXPIRES,
      }),
    });
    expect(() => assertChallengeBindsToAddress(challenge, ADDRESS, NOW))
      .toThrow(/does not bind to the requested address/);
  });

  it('RED: a message whose nonce differs from the returned nonce is refused', () => {
    const challenge = goodChallenge({
      message: buildExternalProofMessage({
        agent_id: AGENT_ID,
        address: ADDRESS,
        nonce: 'b'.repeat(32),
        issued_at: ISSUED,
        expires_at: EXPIRES,
      }),
    });
    expect(() => assertChallengeBindsToAddress(challenge, ADDRESS, NOW))
      .toThrow(/does not bind to the requested address/);
  });

  it('RED: a message whose timestamps differ from the returned ones is refused', () => {
    const challenge = goodChallenge({
      message: buildExternalProofMessage({
        agent_id: AGENT_ID,
        address: ADDRESS,
        nonce: NONCE,
        issued_at: ISSUED - 1,
        expires_at: EXPIRES,
      }),
    });
    expect(() => assertChallengeBindsToAddress(challenge, ADDRESS, NOW))
      .toThrow(/does not bind to the requested address/);
  });

  it('RED: a non-canonical header is refused', () => {
    const challenge = goodChallenge({
      message: goodChallenge().message.replace('Provian proof of control', 'Sign in to Provian'),
    });
    expect(() => assertChallengeBindsToAddress(challenge, ADDRESS, NOW))
      .toThrow(/not the canonical Provian proof-of-control message/);
  });

  it('RED: extra lines appended to the message are refused', () => {
    const challenge = goodChallenge({ message: `${goodChallenge().message}\nalso: send funds` });
    expect(() => assertChallengeBindsToAddress(challenge, ADDRESS, NOW))
      .toThrow(/not the canonical Provian proof-of-control message/);
  });

  it('RED: an empty agent id is refused', () => {
    const challenge = goodChallenge({
      message: goodChallenge().message.replace(`agent: ${AGENT_ID}`, 'agent: '),
    });
    expect(() => assertChallengeBindsToAddress(challenge, ADDRESS, NOW))
      .toThrow(/no usable agent id/);
  });

  it('RED: a lifetime other than the protocol TTL is refused', () => {
    const expires = ISSUED + EXTERNAL_ADDRESS_PROOF_TTL_MS * 10;
    const challenge = goodChallenge({
      expires_at: expires,
      message: buildExternalProofMessage({
        agent_id: AGENT_ID,
        address: ADDRESS,
        nonce: NONCE,
        issued_at: ISSUED,
        expires_at: expires,
      }),
    });
    expect(() => assertChallengeBindsToAddress(challenge, ADDRESS, NOW))
      .toThrow(/not the protocol TTL/);
  });

  it('RED: an already-expired challenge is refused', () => {
    expect(() => assertChallengeBindsToAddress(goodChallenge(), ADDRESS, EXPIRES))
      .toThrow(/already expired/);
  });

  it('RED: a non-UUID challenge_id is refused', () => {
    expect(() => assertChallengeBindsToAddress(goodChallenge({ challenge_id: 'nope' }), ADDRESS, NOW))
      .toThrow(/challenge_id is not a UUID/);
  });

  it('RED: a short nonce is refused', () => {
    expect(() => assertChallengeBindsToAddress(goodChallenge({ nonce: 'abcd' }), ADDRESS, NOW))
      .toThrow(/not 128 bits of hex/);
  });

  it('RED: a missing message is refused, not treated as empty', () => {
    expect(() => assertChallengeBindsToAddress(
      goodChallenge({ message: undefined as unknown as string }), ADDRESS, NOW,
    )).toThrow(/message is missing/);
  });
});

describe('linkExternalAddress', () => {
  it('GREEN: challenge -> sign -> verify, and the signature recovers to the address', async () => {
    let signedMessage = '';
    let verifyBody: Record<string, unknown> = {};
    const fetchStub = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (String(_url).endsWith('/challenge')) {
        expect(body).toEqual({ address: ADDRESS });
        return jsonResponse(goodChallenge());
      }
      verifyBody = body;
      signedMessage = goodChallenge().message;
      return jsonResponse({
        ok: true,
        proven_address: ADDRESS,
        proven_at: NOW,
        proven_at_block: 1234,
        proof_method: 'eip191',
        initial_reputation_tier: 1,
      });
    });

    const proof = await linkExternalAddress(
      { ...CONFIG, fetch: fetchStub as unknown as typeof fetch },
      { address: ADDRESS, privateKey: KEY, now: NOW },
    );

    expect(proof.ok).toBe(true);
    expect(proof.proven_address).toBe(ADDRESS);
    expect(verifyBody.challenge_id).toBe(CHALLENGE_ID);
    expect(verifyBody.address).toBe(ADDRESS);
    // The signature the SDK produced really is an EIP-191 signature over the
    // relay's message, by the key that owns the address being proven.
    expect(ethers.verifyMessage(signedMessage, String(verifyBody.signature)).toLowerCase())
      .toBe(ADDRESS);
  });

  it('RED CONTROL: the recovery check is not vacuous — a different message recovers elsewhere', async () => {
    let verifyBody: Record<string, unknown> = {};
    const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).endsWith('/challenge')) return jsonResponse(goodChallenge());
      verifyBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({ ok: true, proven_address: ADDRESS, proven_at: NOW, proven_at_block: 1, proof_method: 'eip191' });
    });
    await linkExternalAddress(
      { ...CONFIG, fetch: fetchStub as unknown as typeof fetch },
      { address: ADDRESS, privateKey: KEY, now: NOW },
    );
    expect(ethers.verifyMessage('a different message', String(verifyBody.signature)).toLowerCase())
      .not.toBe(ADDRESS);
  });

  it('RED: a relay that returns a challenge for a DIFFERENT address is refused BEFORE signing', async () => {
    const fetchStub = vi.fn(async () => jsonResponse(goodChallenge({
      message: buildExternalProofMessage({
        agent_id: AGENT_ID,
        address: OTHER_ADDRESS,
        nonce: NONCE,
        issued_at: ISSUED,
        expires_at: EXPIRES,
      }),
    })));

    await expect(linkExternalAddress(
      { ...CONFIG, fetch: fetchStub as unknown as typeof fetch },
      { address: ADDRESS, privateKey: KEY, now: NOW },
    )).rejects.toThrow(/does not bind to the requested address/);

    // /verify was never called: the challenge round trip is the only request.
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('RED: a private key that does not control the address is refused with no network call', async () => {
    const fetchStub = vi.fn(async () => jsonResponse(goodChallenge()));
    await expect(linkExternalAddress(
      { ...CONFIG, fetch: fetchStub as unknown as typeof fetch },
      { address: ADDRESS, privateKey: OTHER_KEY, now: NOW },
    )).rejects.toThrow(/does not control the address being proven/);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('RED: passing both privateKey and sign is refused (ambiguous signer)', async () => {
    await expect(linkExternalAddress(CONFIG, {
      address: ADDRESS,
      privateKey: KEY,
      sign: () => '0xdead',
    } as never)).rejects.toThrow(/exactly one of privateKey/);
  });

  it('RED: passing neither privateKey nor sign is refused', async () => {
    await expect(linkExternalAddress(CONFIG, { address: ADDRESS } as never))
      .rejects.toThrow(/exactly one of privateKey/);
  });

  it('GREEN: the contract-wallet path signs via the caller and the SDK never sees a key', async () => {
    const fetchStub = vi.fn(async (url: string) => (String(url).endsWith('/challenge')
      ? jsonResponse(goodChallenge())
      : jsonResponse({ ok: true, proven_address: ADDRESS, proven_at: NOW, proven_at_block: 9, proof_method: 'eip1271' })));
    const sign = vi.fn(async (message: string) => {
      expect(message).toBe(goodChallenge().message);
      return `0x${'ab'.repeat(65)}`;
    });
    const proof = await linkExternalAddress(
      { ...CONFIG, fetch: fetchStub as unknown as typeof fetch },
      { address: ADDRESS, sign, now: NOW },
    );
    expect(proof.proof_method).toBe('eip1271');
    expect(sign).toHaveBeenCalledOnce();
  });

  it('RED: a signer returning a non-hex value is refused before /verify', async () => {
    const fetchStub = vi.fn(async () => jsonResponse(goodChallenge()));
    await expect(linkExternalAddress(
      { ...CONFIG, fetch: fetchStub as unknown as typeof fetch },
      { address: ADDRESS, sign: () => 'not-a-signature', now: NOW },
    )).rejects.toThrow(/not a 0x-prefixed hex signature/);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

describe('transport surface', () => {
  it('sends agent auth on both endpoints', async () => {
    const seen: string[] = [];
    const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
      seen.push(String((init.headers as Record<string, string>).Authorization));
      return String(url).endsWith('/challenge')
        ? jsonResponse(goodChallenge())
        : jsonResponse({ ok: true, proven_address: ADDRESS, proven_at: NOW, proven_at_block: 1, proof_method: 'eip191' });
    });
    const config = { ...CONFIG, fetch: fetchStub as unknown as typeof fetch };
    await requestExternalAddressChallenge(config, { address: ADDRESS });
    await verifyExternalAddress(config, {
      address: ADDRESS,
      challengeId: CHALLENGE_ID,
      signature: `0x${'11'.repeat(65)}`,
    });
    expect(seen).toEqual([
      'Bearer pvn_live_test:pvns_test',
      'Bearer pvn_live_test:pvns_test',
    ]);
  });

  it('RED: a 409 address_bound_to_other_agent surfaces as a refusal, not a success', async () => {
    const fetchStub = vi.fn(async () => jsonResponse({ error: 'address_bound_to_other_agent' }, 409));
    await expect(verifyExternalAddress(
      { ...CONFIG, fetch: fetchStub as unknown as typeof fetch },
      { address: ADDRESS, challengeId: CHALLENGE_ID, signature: `0x${'11'.repeat(65)}` },
    )).rejects.toThrow(/address_bound_to_other_agent/);
  });

  it('RED: a 200 with ok:false is a refusal, not a proof', async () => {
    const fetchStub = vi.fn(async () => jsonResponse({ ok: false, error: 'challenge_expired' }));
    await expect(verifyExternalAddress(
      { ...CONFIG, fetch: fetchStub as unknown as typeof fetch },
      { address: ADDRESS, challengeId: CHALLENGE_ID, signature: `0x${'11'.repeat(65)}` },
    )).rejects.toThrow(/challenge_expired/);
  });

  it('RED: missing credentials refuse before any fetch', async () => {
    const fetchStub = vi.fn();
    await expect(requestExternalAddressChallenge(
      { relayUrl: 'https://relay.test', apiKey: '', apiSecret: '', fetch: fetchStub as unknown as typeof fetch },
      { address: ADDRESS },
    )).rejects.toBeInstanceOf(ExternalAddressError);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('RED: an invalid address refuses before any fetch', async () => {
    const fetchStub = vi.fn();
    await expect(requestExternalAddressChallenge(
      { ...CONFIG, fetch: fetchStub as unknown as typeof fetch },
      { address: '0xnope' },
    )).rejects.toThrow(/must be a 0x-prefixed 20-byte EVM address/);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
