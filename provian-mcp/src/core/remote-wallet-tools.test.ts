/**
 * a hosted agent creates its OWN wallet through the remote
 * endpoint — key generated and kept in its own runtime, only the public key and a
 * signature cross the wire — then asks its human to link it.
 *
 * The signing recipe is proven here with a ZERO-DEPENDENCY Node signer (node:crypto
 * supports secp256k1), the one a hosted agent can write for itself; the relay-side
 * acceptance of that exact signature is proven in the relay's jest suite
 * (provian-backend/src/routes/mcp-remote-wallet.test.ts) against the real verifier.
 */
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { callProvianTool, findTool, PROVIAN_TOOLS, WALLET_POP_SIGNING_RECIPE } from './tools';
import { privateKeyFieldViolations } from './tool-set';
import { findPrivateKeyFields, privateKeyArgumentNames, LOCAL_ONLY_PRIVATE_KEY_FIELDS } from './key-custody';
import { keccak256 } from './keccak256';
import type { ToolContext } from './types';

type Call = { url: string; method: string; headers: Headers; body: string };

function remoteCtx(respond: (call: Call) => Response, auth: ToolContext['auth'] = null): { ctx: ToolContext; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ''),
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { ctx: { baseUrl: 'https://relay.test', fetchImpl, auth, mode: 'remote' }, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function parse(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

/** What a hosted agent writes for itself: node:crypto only. */
function agentKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const hex = Buffer.from(jwk.x, 'base64url').toString('hex') + Buffer.from(jwk.y, 'base64url').toString('hex');
  return { privateKey, publicKeyHex: hex, publicKeyObject: publicKey };
}

describe('the signing recipe a hosted agent follows (zero-dependency node:crypto)', () => {
  it('produces a 128-hex public key and a DER signature over the UTF-8 challenge that verifies as ECDSA-SHA256', () => {
    const kp = agentKeyPair();
    expect(kp.publicKeyHex).toMatch(/^[0-9a-f]{128}$/);
    const challenge = 'a'.repeat(64);
    const sigHex = nodeSign('sha256', Buffer.from(challenge, 'utf8'), kp.privateKey).toString('hex');
    // DER SEQUENCE tag
    expect(sigHex.startsWith('30')).toBe(true);
    expect(nodeVerify('sha256', Buffer.from(challenge, 'utf8'), kp.publicKeyObject, Buffer.from(sigHex, 'hex'))).toBe(true);
    // RED control: signing the hex-DECODED bytes (the common mistake) does not verify over the text.
    const wrong = nodeSign('sha256', Buffer.from(challenge, 'hex'), kp.privateKey);
    expect(nodeVerify('sha256', Buffer.from(challenge, 'utf8'), kp.publicKeyObject, wrong)).toBe(false);
    expect(WALLET_POP_SIGNING_RECIPE.signature_encoding).toMatch(/DER/);
  });
});

describe('wallet_challenge', () => {
  it('sends only the public key + derived ids, returns the recipe and the values to keep', async () => {
    const kp = agentKeyPair();
    const { ctx, calls } = remoteCtx(() => json(200, { challenge_id: 'ch_1', challenge: 'c'.repeat(64), expires_at: 1 }));
    const result = await callProvianTool('wallet_challenge', { public_key: `04${kp.publicKeyHex}` }, ctx);
    expect(result.isError).toBeUndefined();
    const out = parse(result);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/v1/agent/wallet/challenge');
    expect(url.searchParams.get('public_key')).toBe(kp.publicKeyHex);
    expect(url.searchParams.get('registration_id')).toMatch(/^mcp-remote-[0-9a-f]{32}$/);
    expect(url.searchParams.get('agent_id')).toMatch(/^agent-[0-9a-f]{16}$/);
    expect(out.challenge).toBe('c'.repeat(64));
    expect(out.registration_id).toBe(url.searchParams.get('registration_id'));
    expect(out.sign).toEqual(WALLET_POP_SIGNING_RECIPE);
    expect(typeof out.constitution_accepted_at).toBe('string');
    const expectedAddress = '0x' + keccak256(Buffer.from(kp.publicKeyHex, 'hex')).subarray(12).toString('hex');
    expect(out.address).toBe(expectedAddress);
  });

  it('the same key resumes the same registration (deterministic defaults)', async () => {
    const kp = agentKeyPair();
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { ctx, calls } = remoteCtx(() => json(200, { challenge_id: `ch_${i}`, challenge: 'd'.repeat(64) }));
      await callProvianTool('wallet_challenge', { public_key: kp.publicKeyHex, constitution_accepted_at: '2026-09-27T00:00:00.000Z' }, ctx);
      ids.push(new URL(calls[0].url).searchParams.get('registration_id') as string);
    }
    expect(ids[0]).toBe(ids[1]);
  });

  it('RED control: a malformed public key is refused before any network call', async () => {
    const { ctx, calls } = remoteCtx(() => json(200, {}));
    const result = await callProvianTool('wallet_challenge', { public_key: 'abc' }, ctx);
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('wallet_create', () => {
  const created = (address: string) => ({
    wallet_id: 'wallet_aw_abc12345',
    address,
    public_key: 'x',
    api_key: `pvn_live_${'a'.repeat(32)}`,
    api_secret: `pvns_${'b'.repeat(64)}`,
  });

  it('posts the PoP (public key + signature, never a key) and returns the connector credential once', async () => {
    const kp = agentKeyPair();
    const address = '0x' + keccak256(Buffer.from(kp.publicKeyHex, 'hex')).subarray(12).toString('hex');
    const { ctx, calls } = remoteCtx(() => json(201, created(address)));
    const result = await callProvianTool('wallet_create', {
      public_key: kp.publicKeyHex,
      challenge_id: 'ch_1',
      signature: '3045' + 'ab'.repeat(20),
      agent_name: 'Hosted Agent',
      constitution_accepted_at: '2026-09-27T00:00:00.000Z',
      platform: 'cloud-vm',
      connection_token: 'PROV-ABCD-EFGH',
    }, ctx);
    expect(result.isError).toBeUndefined();
    const out = parse(result);
    expect(out.connector_credential).toBe(`pvn_live_${'a'.repeat(32)}:pvns_${'b'.repeat(64)}`);
    expect(String(out.store_now)).toMatch(/API-key field/);
    expect(String(out.next)).toMatch(/request_link/);
    const body = JSON.parse(calls[0].body) as Record<string, unknown>;
    expect(calls[0].url).toBe('https://relay.test/v1/agent/wallet/create');
    expect(body.platform).toBe('cloud-vm');
    expect(body.connection_token).toBe('PROV-ABCD-EFGH');
    expect(body.public_key).toBe(kp.publicKeyHex);
    expect(Object.keys(body).filter((k) => /priv|secret|mnemonic|seed/i.test(k))).toEqual([]);
  });

  it('RED control: a relay response whose address does not match the public key is refused', async () => {
    const kp = agentKeyPair();
    const { ctx } = remoteCtx(() => json(201, created('0x' + '0'.repeat(40))));
    const result = await callProvianTool('wallet_create', {
      public_key: kp.publicKeyHex, challenge_id: 'ch', signature: '30', agent_name: 'M',
      constitution_accepted_at: '2026-09-27T00:00:00.000Z',
    }, ctx);
    expect(result.isError).toBe(true);
  });

  it('RED control: a private key passed as an argument is refused before anything is forwarded', async () => {
    const kp = agentKeyPair();
    const { ctx, calls } = remoteCtx(() => json(201, {}));
    for (const field of ['private_key', 'privateKey', 'secret_key', 'mnemonic', 'seed_phrase']) {
      const result = await callProvianTool('wallet_create', {
        public_key: kp.publicKeyHex, challenge_id: 'ch', signature: '30', agent_name: 'M',
        constitution_accepted_at: '2026-09-27T00:00:00.000Z', [field]: 'f'.repeat(64),
      }, ctx);
      expect(result.isError).toBe(true);
      expect(parse(result).error).toMatch(/never send a private key/);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('request_link', () => {
  const auth = { apiKey: `pvn_live_${'a'.repeat(32)}`, apiSecret: `pvns_${'b'.repeat(64)}` };

  it('forwards the link code with the agent credential and explains pending', async () => {
    const { ctx, calls } = remoteCtx(() => json(201, { request_id: 'inv_1', status: 'pending' }), auth);
    const result = await callProvianTool('request_link', { wallet_id: 'wallet_aw_abc12345', connection_token: 'PROV-ABCD-EFGH' }, ctx);
    const out = parse(result);
    expect(calls[0].url).toBe('https://relay.test/v1/agent/wallet/wallet_aw_abc12345/request-link');
    expect(calls[0].headers.get('Authorization')).toBe(`Bearer ${auth.apiKey}:${auth.apiSecret}`);
    expect(JSON.parse(calls[0].body)).toEqual({ connection_token: 'PROV-ABCD-EFGH' });
    expect(out.status).toBe('pending');
    expect(String(out.next)).toMatch(/Accept/);
  });

  it('a directly linked result (fleet code) says so', async () => {
    const { ctx } = remoteCtx(() => json(200, { status: 'linked' }), auth);
    const out = parse(await callProvianTool('request_link', { wallet_id: 'wallet_aw_abc12345', connection_token: 'PROV-ABCD-EFGH' }, ctx));
    expect(String(out.next)).toMatch(/linked to your human/);
  });

  it('without a credential it asks for one and makes no call', async () => {
    const { ctx, calls } = remoteCtx(() => json(200, {}));
    const result = await callProvianTool('request_link', { wallet_id: 'wallet_aw_abc12345', connection_token: 'PROV-ABCD-EFGH' }, ctx);
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('no tool schema accepts a private key (key custody)', () => {
  it('the whole registry: only the declared local-only field names key material', () => {
    expect(PROVIAN_TOOLS.length).toBeGreaterThan(0);
    expect(privateKeyFieldViolations()).toEqual([]);
    // The declared exception is real (not a vacuous allowance).
    expect(findPrivateKeyFields(findTool('link_external_address')!.inputSchema)).toEqual(
      LOCAL_ONLY_PRIVATE_KEY_FIELDS.link_external_address,
    );
    for (const name of ['wallet_challenge', 'wallet_create', 'request_link']) {
      expect(findTool(name)).toBeDefined();
      expect(findPrivateKeyFields(findTool(name)!.inputSchema)).toEqual([]);
    }
  });

  it('RED control: a schema with private_key (top-level, nested, or in array items) fails the guard', () => {
    const bad = [
      { name: 'wallet_create', inputSchema: { type: 'object', properties: { private_key: { type: 'string' } } } },
      { name: 'x', inputSchema: { type: 'object', properties: { wallet: { type: 'object', properties: { privateKey: { type: 'string' } } } } } },
      { name: 'y', inputSchema: { type: 'object', properties: { keys: { type: 'array', items: { type: 'object', properties: { mnemonic: { type: 'string' } } } } } } },
    ];
    expect(privateKeyFieldViolations(bad)).toEqual([
      { tool: 'wallet_create', field: 'private_key' },
      { tool: 'x', field: 'wallet.privateKey' },
      { tool: 'y', field: 'keys[].mnemonic' },
    ]);
    // Credentials that are not keys stay allowed.
    expect(privateKeyArgumentNames({ device_secret: 'x', api_secret: 'y', public_key: 'z' })).toEqual([]);
  });

  it('the declared local-only field is not caught by the generic guard; its own remote refusal still applies', async () => {
    const fetchImpl = vi.fn();
    const result = await callProvianTool(
      'link_external_address',
      { address: '0x' + '1'.repeat(40), external_private_key: 'f'.repeat(64) },
      {
        baseUrl: 'https://relay.test',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        auth: { apiKey: `pvn_live_${'a'.repeat(32)}`, apiSecret: `pvns_${'b'.repeat(64)}` },
        mode: 'remote',
      },
    );
    // Remote: the handler's own refusal (not the generic guard) still applies.
    expect(parse(result).error).toMatch(/never send private keys/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
