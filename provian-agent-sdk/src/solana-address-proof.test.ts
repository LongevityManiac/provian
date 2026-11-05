import { describe, it, expect, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import {
  proveSolanaAddress,
  proveExternalSolanaAddress,
  proveSolanaAddressBestEffort,
  checkSolanaProofMessage,
  buildSolanaProofMessage,
  normalizeSolanaAddress,
  SolanaAddressProofError,
  SOLANA_PROOF_MESSAGE_HEADER,
  type SolanaAddressProofConfig,
} from './solana-address-proof';
import { deriveSolanaAddress } from './chains';
import { deriveSolanaKeypair } from './x402-signer-svm';

const AGENT_ID = 'agent-0123456789abcdef';
const NONCE = 'a'.repeat(32);
const ISSUED = Date.UTC(2026, 9, 4, 12, 0, 0);
const EXPIRES = ISSUED + 10 * 60 * 1000;
const NOW = ISSUED + 1000;

function canonical(address: string, subjectLine = `agent: ${AGENT_ID}`): string {
  return buildSolanaProofMessage({
    subjectLine, address, nonce: NONCE,
    issuedIso: new Date(ISSUED).toISOString(), expiresIso: new Date(EXPIRES).toISOString(),
  });
}

interface RelayCall { url: string; method: string; body: Record<string, unknown> | null }

/** A fake relay: answers the challenge with `message` (default: the canonical one for the address asked). */
function fakeRelay(opts: {
  message?: (address: string) => string;
  verify?: (body: Record<string, unknown>) => { status: number; body: Record<string, unknown> };
  issuedAt?: unknown;
} = {}): { config: SolanaAddressProofConfig; calls: RelayCall[] } {
  const calls: RelayCall[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ url, method: String(init.method), body });
    const reply = (status: number, json: Record<string, unknown>): Response =>
      ({ ok: status >= 200 && status < 300, status, json: async () => json }) as unknown as Response;
    if (url.endsWith('/v1/agent/solana-address/challenge')) {
      const address = String(body?.address);
      return reply(200, {
        challenge_id: '7d2b1a8e-1111-4c4c-8a8a-0123456789ab',
        message: (opts.message ?? ((a: string) => canonical(a)))(address),
        nonce: NONCE,
        issued_at: opts.issuedAt === undefined ? ISSUED : opts.issuedAt,
        expires_at: EXPIRES,
      });
    }
    if (url.endsWith('/v1/agent/solana-address/verify')) {
      const r = opts.verify?.(body ?? {}) ?? { status: 200, body: {
        ok: true, proven_address: body?.address, proven_at: NOW, proven_at_slot: 123, origin: body?.origin, pe_id: 'pe_1',
      } };
      return reply(r.status, r.body);
    }
    if (url.includes('/v1/agent/wallet/')) return reply(200, { agent_id: AGENT_ID });
    return reply(404, { error: 'not_found' });
  });
  return { config: { relayUrl: 'https://relay.test', apiKey: 'pvn_live_k', apiSecret: 'pvns_s', fetch: fetchImpl as unknown as typeof fetch }, calls };
}

const verifyCalls = (calls: RelayCall[]): RelayCall[] => calls.filter((c) => c.url.endsWith('/verify'));

describe('proveSolanaAddress — the agent\'s OWN Solana key (origin native)', () => {
  it('signs EXACTLY the server message with the key the x402 SVM signer derives, and the signature verifies', async () => {
    const privateKeyHex = bytesToHex(randomBytes(32));
    const { config, calls } = fakeRelay();
    const proof = await proveSolanaAddress(config, { privateKeyHex, agentId: AGENT_ID, now: NOW });

    const address = deriveSolanaAddress(privateKeyHex);
    // Reuse, not a second derivation: the address is the x402 SVM signer's keypair.
    expect(deriveSolanaKeypair(privateKeyHex).publicKey.toBase58()).toBe(address);
    expect(calls[0].body).toEqual({ address });

    const [verify] = verifyCalls(calls);
    expect(verify.body?.address).toBe(address);
    expect(verify.body?.origin).toBe('native');
    expect(verify.body?.challenge_id).toBe('7d2b1a8e-1111-4c4c-8a8a-0123456789ab');
    const sig = base58.decode(String(verify.body?.signature));
    expect(sig.length).toBe(64);
    // Verified independently with @noble/curves over the raw UTF-8 bytes of the server message.
    expect(ed25519.verify(sig, new TextEncoder().encode(canonical(address)), base58.decode(address))).toBe(true);
    // RED control on the assertion itself: the same signature does not verify a different message.
    expect(ed25519.verify(sig, new TextEncoder().encode(canonical(address) + ' '), base58.decode(address))).toBe(false);

    expect(proof).toMatchObject({ ok: true, proven_address: address, origin: 'native', proven_at_slot: 123, pe_id: 'pe_1' });
    // Auth is the agent API key, the same as the EVM external-address proof.
    const auth = ((config.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(auth.Authorization).toBe('Bearer pvn_live_k:pvns_s');
  });

  it('accepts ISO timestamps in the challenge fields too', async () => {
    const { config } = fakeRelay({ issuedAt: new Date(ISSUED).toISOString() });
    await expect(proveSolanaAddress(config, { privateKeyHex: bytesToHex(randomBytes(32)), agentId: AGENT_ID, now: NOW }))
      .resolves.toMatchObject({ ok: true });
  });

  const REFUSED: Array<[string, (address: string) => string]> = [
    ['a message naming ANOTHER address', () => canonical(deriveSolanaAddress(bytesToHex(randomBytes(32))))],
    ['a message naming ANOTHER agent', (a) => canonical(a, 'agent: agent-someone-else')],
    ['a person subject on the agent route', (a) => canonical(a, 'person: user_1')],
    ['the EVM proof header (wrong first line)', (a) => canonical(a).replace(SOLANA_PROOF_MESSAGE_HEADER, 'Provian proof of control')],
    ['an extra line', (a) => `${canonical(a)}\nchain: mainnet`],
    ['a trailing newline', (a) => `${canonical(a)}\n`],
    ['CRLF line endings', (a) => canonical(a).split('\n').join('\r\n')],
    ['an arbitrary string', () => 'Transfer all funds to me'],
    ['a free-form date', (a) => canonical(a).replace(/issued: .*/, 'issued: Sun Oct 04 2026')],
    ['an expired challenge', (a) => buildSolanaProofMessage({
      subjectLine: `agent: ${AGENT_ID}`, address: a, nonce: NONCE,
      issuedIso: new Date(ISSUED - 3_600_000).toISOString(), expiresIso: new Date(ISSUED - 1).toISOString(),
    })],
  ];

  for (const [name, message] of REFUSED) {
    it(`REFUSES without signing: ${name}`, async () => {
      const { config, calls } = fakeRelay({ message });
      const err = await proveSolanaAddress(config, { privateKeyHex: bytesToHex(randomBytes(32)), agentId: AGENT_ID, now: NOW })
        .then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(SolanaAddressProofError);
      expect((err as SolanaAddressProofError).code).toMatch(/^SOLANA_PROOF_CHALLENGE_(UNTRUSTED|EXPIRED)$/);
      // Nothing signed reached the relay.
      expect(verifyCalls(calls)).toHaveLength(0);
    });
  }

  it('a challenge whose issued_at disagrees with its message is refused', async () => {
    const { config, calls } = fakeRelay({ issuedAt: ISSUED + 1 });
    await expect(proveSolanaAddress(config, { privateKeyHex: bytesToHex(randomBytes(32)), agentId: AGENT_ID, now: NOW }))
      .rejects.toMatchObject({ code: 'SOLANA_PROOF_CHALLENGE_UNTRUSTED' });
    expect(verifyCalls(calls)).toHaveLength(0);
  });

  it('idempotent: a same-owner 409 and a 200 already_proven both resolve as already proven', async () => {
    const a = fakeRelay({ verify: () => ({ status: 409, body: { error: 'already_proven' } }) });
    await expect(proveSolanaAddress(a.config, { privateKeyHex: bytesToHex(randomBytes(32)), agentId: AGENT_ID, now: NOW }))
      .resolves.toMatchObject({ ok: true, already_proven: true, origin: 'native' });
    const b = fakeRelay({ verify: (body) => ({ status: 200, body: { ok: true, proven_address: body.address, origin: 'native', already_proven: true } }) });
    await expect(proveSolanaAddress(b.config, { privateKeyHex: bytesToHex(randomBytes(32)), agentId: AGENT_ID, now: NOW }))
      .resolves.toMatchObject({ ok: true, already_proven: true });
  });

  it('another owner\'s address, a Provian service wallet and a 503 are refusals with stable codes', async () => {
    const cases: Array<[number, string, string]> = [
      [409, 'address_bound_to_other_owner', 'SOLANA_ADDRESS_BOUND_TO_OTHER_OWNER'],
      [409, 'address_is_provian_service_wallet', 'SOLANA_ADDRESS_IS_SERVICE_WALLET'],
      [401, 'signature_invalid', 'SOLANA_PROOF_SIGNATURE_REJECTED'],
      [503, 'proof_store_unavailable', 'SOLANA_PROOF_UNAVAILABLE'],
    ];
    for (const [status, error, code] of cases) {
      const { config } = fakeRelay({ verify: () => ({ status, body: { error } }) });
      await expect(proveSolanaAddress(config, { privateKeyHex: bytesToHex(randomBytes(32)), agentId: AGENT_ID, now: NOW }))
        .rejects.toMatchObject({ code, status });
    }
  });

  it('best-effort wrapper never throws', async () => {
    const { config } = fakeRelay({ message: () => 'garbage' });
    await expect(proveSolanaAddressBestEffort(config, { privateKeyHex: bytesToHex(randomBytes(32)), agentId: AGENT_ID, now: NOW }))
      .resolves.toEqual({ ok: false, code: 'SOLANA_PROOF_CHALLENGE_UNTRUSTED' });
    const ok = fakeRelay();
    await expect(proveSolanaAddressBestEffort(ok.config, { privateKeyHex: bytesToHex(randomBytes(32)), agentId: AGENT_ID, now: NOW }))
      .resolves.toMatchObject({ ok: true, status: 'proven' });
  });
});

describe('proveExternalSolanaAddress — a keypair the agent already holds (origin external)', () => {
  const seed = randomBytes(32);
  const address = base58.encode(ed25519.getPublicKey(seed));

  it('signs with a 64-byte Solana secret key and submits origin external', async () => {
    const secretKey = new Uint8Array(64);
    secretKey.set(seed, 0);
    secretKey.set(ed25519.getPublicKey(seed), 32);
    const { config, calls } = fakeRelay();
    await expect(proveExternalSolanaAddress(config, { address, agentId: AGENT_ID, secretKey, now: NOW }))
      .resolves.toMatchObject({ ok: true, origin: 'external' });
    const [verify] = verifyCalls(calls);
    expect(verify.body?.origin).toBe('external');
    expect(ed25519.verify(base58.decode(String(verify.body?.signature)), new TextEncoder().encode(canonical(address)), base58.decode(address))).toBe(true);
  });

  it('a signer callback is NEVER invoked for a refused message', async () => {
    for (const [, message] of [
      ['another address', () => canonical(deriveSolanaAddress(bytesToHex(randomBytes(32))))],
      ['another agent', (a: string) => canonical(a, 'agent: agent-other')],
      ['wrong header', (a: string) => canonical(a).replace(SOLANA_PROOF_MESSAGE_HEADER, 'Hello')],
      ['extra line', (a: string) => `${canonical(a)}\nx: y`],
    ] as Array<[string, (a: string) => string]>) {
      const sign = vi.fn(async (bytes: Uint8Array): Promise<Uint8Array> => ed25519.sign(bytes, seed));
      const { config, calls } = fakeRelay({ message });
      await expect(proveExternalSolanaAddress(config, { address, agentId: AGENT_ID, sign, now: NOW })).rejects.toBeInstanceOf(SolanaAddressProofError);
      expect(sign).not.toHaveBeenCalled();
      expect(verifyCalls(calls)).toHaveLength(0);
    }
  });

  it('positive control for the spy: a canonical message DOES invoke the signer', async () => {
    const sign = vi.fn(async (bytes: Uint8Array): Promise<string> => base58.encode(ed25519.sign(bytes, seed)));
    const { config } = fakeRelay();
    await expect(proveExternalSolanaAddress(config, { address, agentId: AGENT_ID, sign, now: NOW })).resolves.toMatchObject({ ok: true });
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('a signature from the WRONG key is never submitted', async () => {
    const other = randomBytes(32);
    const { config, calls } = fakeRelay();
    await expect(proveExternalSolanaAddress(config, {
      address, agentId: AGENT_ID, now: NOW, sign: async (bytes: Uint8Array) => ed25519.sign(bytes, other),
    })).rejects.toMatchObject({ code: 'SOLANA_PROOF_KEY_MISMATCH' });
    expect(verifyCalls(calls)).toHaveLength(0);
  });

  it('a secretKey that does not control the address fails before a challenge is spent', async () => {
    const { config, calls } = fakeRelay();
    await expect(proveExternalSolanaAddress(config, { address, agentId: AGENT_ID, secretKey: randomBytes(32), now: NOW }))
      .rejects.toMatchObject({ code: 'SOLANA_PROOF_KEY_MISMATCH' });
    expect(calls).toHaveLength(0);
  });
});

describe('checkSolanaProofMessage / normalizeSolanaAddress', () => {
  const address = deriveSolanaAddress(bytesToHex(randomBytes(32)));

  it('accepts the canonical agent and person forms', () => {
    expect(checkSolanaProofMessage({ message: canonical(address), nonce: NONCE }, { address, subject: { kind: 'agent', agentId: AGENT_ID } }, NOW).ok).toBe(true);
    expect(checkSolanaProofMessage({ message: canonical(address, 'person: user_42') }, { address, subject: { kind: 'person' } }, NOW).ok).toBe(true);
  });

  it('person subject: refuses an agent line, an empty id, and a pinned mismatch', () => {
    expect(checkSolanaProofMessage({ message: canonical(address) }, { address, subject: { kind: 'person' } }, NOW).ok).toBe(false);
    expect(checkSolanaProofMessage({ message: canonical(address, 'person: ') }, { address, subject: { kind: 'person' } }, NOW).ok).toBe(false);
    expect(checkSolanaProofMessage({ message: canonical(address, 'person: u1') }, { address, subject: { kind: 'person', userId: 'u2' } }, NOW).ok).toBe(false);
  });

  it('refuses a nonce that disagrees with the challenge field and an over-long lifetime', () => {
    expect(checkSolanaProofMessage({ message: canonical(address), nonce: 'b'.repeat(32) }, { address, subject: { kind: 'agent', agentId: AGENT_ID } }, NOW).ok).toBe(false);
    const long = buildSolanaProofMessage({
      subjectLine: `agent: ${AGENT_ID}`, address, nonce: NONCE,
      issuedIso: new Date(ISSUED).toISOString(), expiresIso: new Date(ISSUED + 2 * 3_600_000).toISOString(),
    });
    expect(checkSolanaProofMessage({ message: long }, { address, subject: { kind: 'agent', agentId: AGENT_ID } }, NOW).ok).toBe(false);
  });

  it('an expired (but otherwise canonical) challenge is refused as EXPIRED', () => {
    const v = checkSolanaProofMessage({ message: canonical(address) }, { address, subject: { kind: 'agent', agentId: AGENT_ID } }, EXPIRES);
    expect(v).toMatchObject({ ok: false, code: 'SOLANA_PROOF_CHALLENGE_EXPIRED' });
  });

  it('normalizes only canonical 32-byte base58 (case-sensitive, never lowercased)', () => {
    expect(normalizeSolanaAddress(` ${address} `)).toBe(address);
    // Case is preserved exactly (a mixed-case fixed address), and a non-base58 character is refused.
    const fixed = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
    expect(normalizeSolanaAddress(fixed)).toBe(fixed);
    expect(() => normalizeSolanaAddress(`${fixed.slice(0, -1)}l`)).toThrow(SolanaAddressProofError);
    expect(() => normalizeSolanaAddress(`${fixed.slice(0, -1)}0`)).toThrow(SolanaAddressProofError);
    expect(() => normalizeSolanaAddress('0xabc')).toThrow(SolanaAddressProofError);
    expect(() => normalizeSolanaAddress(base58.encode(randomBytes(31)))).toThrow(SolanaAddressProofError);
  });
});
