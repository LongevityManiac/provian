/**
 * a hosted agent creates its own wallet over the hosted
 * /mcp endpoint with NO credential, keeping its key in its own runtime, then connects
 * with the returned credential and asks its human to link it.
 *
 * The relay side of the loopback is a stub, but the signature check in it is the
 * relay's REAL verifier (`verifyEcdsaSha256`, the function verifyAndConsumePopChallenge
 * uses), so this proves that the signature a hosted agent produces with node:crypto
 * alone — following the recipe wallet_challenge returns — is exactly what the relay
 * accepts. RED control: a signature over the hex-decoded challenge is refused.
 */
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from 'crypto';
import express from 'express';
import request from 'supertest';
import { mountMCPRoutes, type MCPRouteDeps } from './mcp';
import { verifyEcdsaSha256 } from '../core/agent-wallet/proof-of-possession';
import { keccak256 } from '../mcp/core/keccak256';

function buildApp(deps: MCPRouteDeps = {}): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  mountMCPRoutes(app, deps);
  return app;
}

function rpcCall(id: number, name: string, args: Record<string, unknown>) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

function toolPayload(res: request.Response): Record<string, unknown> {
  expect(res.status).toBe(200);
  expect(res.type).toBe('application/json');
  return JSON.parse(res.body.result.content[0].text) as Record<string, unknown>;
}

const API_KEY = `pvn_live_${'1'.repeat(32)}`;
const API_SECRET = `pvns_${'2'.repeat(64)}`;

/** A stub of the three REST routes whose PoP check is the relay's real verifier. */
function relayStub() {
  const challenges = new Map<string, { publicKey: string; challenge: string }>();
  const seen: Array<{ path: string; auth: string | null; body: string }> = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = String(init?.body ?? '');
    seen.push({ path: url.pathname, auth: headers.get('Authorization'), body });
    const reply = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/v1/agent/wallet/challenge') {
      const id = `ch_${challenges.size + 1}`;
      const challenge = 'f0'.repeat(32);
      challenges.set(id, { publicKey: url.searchParams.get('public_key') ?? '', challenge });
      return reply(200, { challenge_id: id, challenge, expires_at: Date.now() + 60_000 });
    }
    if (url.pathname === '/v1/agent/wallet/create') {
      const b = JSON.parse(body) as { challenge_id: string; public_key: string; signature: string; platform: string };
      const issued = challenges.get(b.challenge_id);
      if (!issued || issued.publicKey !== b.public_key
        || !verifyEcdsaSha256(b.public_key, issued.challenge, b.signature)) {
        return reply(401, { error: 'Proof-of-possession verification failed' });
      }
      challenges.delete(b.challenge_id);
      const address = '0x' + keccak256(Buffer.from(b.public_key, 'hex')).subarray(12).toString('hex');
      return reply(201, { wallet_id: 'wallet_aw_host0001', address, public_key: b.public_key, api_key: API_KEY, api_secret: API_SECRET });
    }
    if (url.pathname === '/v1/agent/wallet/wallet_aw_host0001/request-link') {
      if (headers.get('Authorization') !== `Bearer ${API_KEY}:${API_SECRET}`) return reply(401, { error: 'unauthorized' });
      return reply(201, { request_id: 'inv_1', status: 'pending', expires_at: Date.now() + 1 });
    }
    return reply(404, { error: 'not found' });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

function hostedAgentKey(): { privateKey: KeyObject; publicKeyHex: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return {
    privateKey,
    publicKeyHex: Buffer.from(jwk.x, 'base64url').toString('hex') + Buffer.from(jwk.y, 'base64url').toString('hex'),
  };
}

describe('hosted agent: create its own wallet over /mcp, connect with the credential, request the link', () => {
  beforeEach(() => {
    process.env.MCP_AGENT_ONBOARDING = 'true';
  });
  afterEach(() => {
    delete process.env.MCP_AGENT_ONBOARDING;
  });

  it('wallet_challenge → sign in the runtime → wallet_create → request_link over X-API-Key', async () => {
    const { fetchImpl, seen } = relayStub();
    const app = buildApp({ fetchImpl, getSelfBaseUrl: () => 'http://127.0.0.1:9' });
    const key = hostedAgentKey();

    const ch = toolPayload(
      await request(app).post('/mcp').set('Accept', 'application/json')
        .send(rpcCall(1, 'wallet_challenge', { public_key: key.publicKeyHex })),
    );
    // The agent signs in its own runtime, following the returned recipe.
    const signature = nodeSign('sha256', Buffer.from(String(ch.challenge), 'utf8'), key.privateKey).toString('hex');

    const created = toolPayload(
      await request(app).post('/mcp').set('Accept', 'application/json').send(rpcCall(2, 'wallet_create', {
        public_key: key.publicKeyHex,
        challenge_id: ch.challenge_id,
        signature,
        registration_id: ch.registration_id,
        agent_id: ch.agent_id,
        constitution_accepted_at: ch.constitution_accepted_at,
        agent_name: 'Hosted Agent',
        platform: 'cloud-vm',
        connection_token: 'PROV-ABCD-EFGH',
      })),
    );
    expect(created.connector_credential).toBe(`${API_KEY}:${API_SECRET}`);

    // The connector now carries the credential in its API-key field.
    const linked = toolPayload(
      await request(app).post('/mcp').set('Accept', 'application/json').set('X-API-Key', String(created.connector_credential))
        .send(rpcCall(3, 'request_link', { wallet_id: created.wallet_id, connection_token: 'PROV-ABCD-EFGH' })),
    );
    expect(linked.status).toBe('pending');

    // Nothing that crossed the wire carried the private key.
    const pkcs8 = key.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex');
    const d = (key.privateKey.export({ format: 'jwk' }) as { d: string }).d;
    const dHex = Buffer.from(d, 'base64url').toString('hex');
    for (const call of seen) {
      expect(call.body).not.toContain(dHex);
      expect(call.body).not.toContain(pkcs8);
      expect(call.body).not.toContain(d);
    }
    expect(seen.map((c) => c.path)).toEqual([
      '/v1/agent/wallet/challenge',
      '/v1/agent/wallet/create',
      '/v1/agent/wallet/wallet_aw_host0001/request-link',
    ]);
  });

  it('RED control: a signature over the hex-DECODED challenge is refused by the real verifier', async () => {
    const { fetchImpl } = relayStub();
    const app = buildApp({ fetchImpl, getSelfBaseUrl: () => 'http://127.0.0.1:9' });
    const key = hostedAgentKey();
    const ch = toolPayload(
      await request(app).post('/mcp').send(rpcCall(1, 'wallet_challenge', { public_key: key.publicKeyHex })),
    );
    const wrong = nodeSign('sha256', Buffer.from(String(ch.challenge), 'hex'), key.privateKey).toString('hex');
    const res = await request(app).post('/mcp').send(rpcCall(2, 'wallet_create', {
      public_key: key.publicKeyHex, challenge_id: ch.challenge_id, signature: wrong,
      registration_id: ch.registration_id, agent_id: ch.agent_id,
      constitution_accepted_at: ch.constitution_accepted_at, agent_name: 'Hosted Agent',
    }));
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toMatch(/HTTP 401/);
  });

  it('a private key sent as a tool argument is refused on /mcp and never forwarded', async () => {
    const { fetchImpl, seen } = relayStub();
    const app = buildApp({ fetchImpl });
    const res = await request(app).post('/mcp').send(rpcCall(1, 'wallet_challenge', {
      public_key: hostedAgentKey().publicKeyHex, private_key: 'a'.repeat(64),
    }));
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toMatch(/never send a private key/);
    expect(seen).toHaveLength(0);
  });
});
