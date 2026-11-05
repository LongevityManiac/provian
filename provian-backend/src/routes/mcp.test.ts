/**
 * Tests for the remote MCP endpoint (POST /mcp, streamable HTTP, stateless).
 *
 * Follows the repo's DI conventions: a bare express app + supertest, with the
 * tool core's outbound self-calls looped through deps.fetchImpl. No real
 * network or production Firestore is used. (The submit_pe first-use
 * integration tests went with the tool,.)
 */
import express from 'express';
import request from 'supertest';
import { mountMCPRoutes, parseForwardableAuth, type MCPRouteDeps } from './mcp';
import { assertServedToolSet } from '../mcp/core/tool-set';

const MCP_ACCEPT = 'application/json, text/event-stream';

function buildApp(deps: MCPRouteDeps = {}): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  mountMCPRoutes(app, deps);
  return app;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function rpc(id: number, method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0', id, method, params };
}

/**
 * Extract the single JSON-RPC message from an /mcp response. The MCP TS SDK v2
 * stateless streamable-HTTP transport frames responses as an `event: message\n
 * data: {…}` SSE frame whenever the client accepts `text/event-stream` (which
 * MCP_ACCEPT does, as real MCP clients do). This reads the message out of either
 * a plain JSON body or that SSE frame.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readRpc(res: request.Response): any {
  if (res.type === 'text/event-stream') {
    const line = (res.text ?? '').split('\n').find((l) => l.startsWith('data:'));
    return line ? JSON.parse(line.slice('data:'.length).trim()) : {};
  }
  return res.body;
}

const INITIALIZE = rpc(1, 'initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'jest', version: '0' },
});

describe('parseForwardableAuth', () => {
  it('splits Bearer api_key:api_secret on the first colon', () => {
    expect(parseForwardableAuth('Bearer pvn_live_abc:pvns_def')).toEqual({
      apiKey: 'pvn_live_abc',
      apiSecret: 'pvns_def',
    });
  });

  it('returns null for missing/other schemes or colon-less tokens', () => {
    expect(parseForwardableAuth(undefined)).toBeNull();
    expect(parseForwardableAuth('DeviceKey pdk:pds')).toBeNull();
    expect(parseForwardableAuth('Bearer no-colon-token')).toBeNull();
  });
});

describe('PUBLIC_LAUNCH gate', () => {
  afterEach(() => {
    delete process.env.PUBLIC_LAUNCH;
  });

  it('404s every verb pre-launch (same pattern as the descriptor routes)', async () => {
    delete process.env.PUBLIC_LAUNCH;
    const app = buildApp();
    await request(app).post('/mcp').set('Accept', MCP_ACCEPT).send(INITIALIZE).expect(404);
    await request(app).get('/mcp').expect(404);
    await request(app).delete('/mcp').expect(404);
  });
});

describe('agent onboarding is decoupled from PUBLIC_LAUNCH (wiring, not just logic)', () => {
  const ALLOWED = 'pvn_live_route_allowed';
  const auth = (key: string) => `Bearer ${key}:secret`;

  afterEach(() => {
    delete process.env.PUBLIC_LAUNCH;
    delete process.env.MCP_AGENT_ONBOARDING;
    delete process.env.MCP_AGENT_ALLOWLIST;
  });

  it('THE CONTROL — onboarding flag OFF, PUBLIC_LAUNCH false: 404 for everyone', async () => {
    process.env.PUBLIC_LAUNCH = 'false';
    const app = buildApp();
    await request(app).post('/mcp').set('Accept', MCP_ACCEPT).set('Authorization', auth(ALLOWED))
      .send(INITIALIZE).expect(404);
    await request(app).get('/mcp').set('Authorization', auth(ALLOWED)).expect(404);
  });

  it('flag ON: a key is served while PUBLIC_LAUNCH stays false', async () => {
    process.env.PUBLIC_LAUNCH = 'false';
    process.env.MCP_AGENT_ONBOARDING = 'true';
    const app = buildApp();
    const res = await request(app).post('/mcp').set('Accept', MCP_ACCEPT)
      .set('Authorization', auth(ALLOWED)).send(INITIALIZE).expect(200);
    expect(readRpc(res).result.serverInfo.name).toBe('provian');
    expect(process.env.PUBLIC_LAUNCH).toBe('false');
  });

  it('flag ON is OPEN : an arbitrary key AND an anonymous caller are BOTH admitted', async () => {
    // The inverse of the retired allowlist. A stale MCP_AGENT_ALLOWLIST that does
    // NOT contain the caller must not gate them — it is ignored entirely.
    process.env.PUBLIC_LAUNCH = 'false';
    process.env.MCP_AGENT_ONBOARDING = 'true';
    process.env.MCP_AGENT_ALLOWLIST = ALLOWED; // stale value present — must be ignored
    const app = buildApp();
    await request(app).post('/mcp').set('Accept', MCP_ACCEPT)
      .set('Authorization', auth('pvn_live_someone_else')).send(INITIALIZE).expect(200);
    await request(app).post('/mcp').set('Accept', MCP_ACCEPT).send(INITIALIZE).expect(200);
  });

  it('finding 13c: a refused admission (onboarding OFF) LOGS the verdict and the attempted key id (never the secret)', async () => {
    process.env.PUBLIC_LAUNCH = 'false';
    process.env.MCP_AGENT_ONBOARDING = 'false';
    const app = buildApp();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await request(app).post('/mcp').set('Accept', MCP_ACCEPT)
        .set('Authorization', 'Bearer pvn_live_intruder:super-secret').send(INITIALIZE).expect(404);
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toMatch(/admission refused/);
      expect(logged).toMatch(/verdict=onboarding_flag_false/);
      expect(logged).toMatch(/attempted_key_id=pvn_live_intruder/);
      expect(logged).not.toMatch(/super-secret/); // key id only, never the secret half
    } finally {
      warn.mockRestore();
    }
  });

  it('finding 13c RED: an ADMITTED request logs NO refusal (the log is not a constant)', async () => {
    process.env.PUBLIC_LAUNCH = 'false';
    process.env.MCP_AGENT_ONBOARDING = 'true';
    const app = buildApp();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await request(app).post('/mcp').set('Accept', MCP_ACCEPT)
        .set('Authorization', auth(ALLOWED)).send(INITIALIZE).expect(200);
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).not.toMatch(/admission refused/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('POST /mcp (PUBLIC_LAUNCH=true)', () => {
  beforeEach(() => {
    process.env.PUBLIC_LAUNCH = 'true';
  });
  afterEach(() => {
    delete process.env.PUBLIC_LAUNCH;
  });

  it('answers initialize with the provian server info', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
      .send(INITIALIZE)
      .expect(200);
    expect(readRpc(res).result.serverInfo.name).toBe('provian');
    expect(readRpc(res).result.capabilities.tools).toBeDefined();
  });

  it('lists the full tool set statelessly (no prior initialize on this instance)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
      .send(rpc(2, 'tools/list'))
      .expect(200);
    const names = readRpc(res).result.tools.map((t: { name: string }) => t.name).sort();
    // Bound to the registry the served core registers (mcp/core/tool-set.ts), not a redeclared
    // literal: the literal that stood here went stale when added tools.
    assertServedToolSet(names);
  });

  it('routes tools/call through the shared core with loopback self-calls', async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return jsonResponse(200, { wallet_id: 'wallet_aw_1', pe_count: 4 });
    }) as typeof fetch;

    const app = buildApp({ fetchImpl, getSelfBaseUrl: () => 'http://127.0.0.1:9999' });
    const res = await request(app)
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
      .set('X-Forwarded-For', '203.0.113.7')
      .send(rpc(3, 'tools/call', { name: 'get_agent_record', arguments: { agent_id: 'wallet_aw_1' } }))
      .expect(200);

    expect(seen[0].url).toBe('http://127.0.0.1:9999/v1/agents/wallet_aw_1/record');
    // Original client IP forwarded so per-IP rate limits key on the caller.
    expect(seen[0].headers.get('X-Forwarded-For')).toBe('203.0.113.7');

    const payload = JSON.parse(readRpc(res).result.content[0].text);
    expect(payload.pe_count).toBe(4);
    expect(readRpc(res).result.isError).toBeUndefined();
  });

  it('returns tool-level guidance (isError result) for authenticated tools without credentials', async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const app = buildApp({ fetchImpl });
    const res = await request(app)
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
      .send(rpc(5, 'tools/call', { name: 'browse_jobs', arguments: {} }))
      .expect(200);
    expect(readRpc(res).result.isError).toBe(true);
    const payload = JSON.parse(readRpc(res).result.content[0].text);
    expect(payload.error).toContain('Authorization: Bearer <api_key>:<api_secret>');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects private-key material on the remote endpoint', async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const app = buildApp({ fetchImpl });
    const res = await request(app)
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
      .set('Authorization', 'Bearer pvn_live_k:pvns_s')
      .send(
        rpc(6, 'tools/call', {
          name: 'link_external_address',
          arguments: { address: '0x' + '1'.repeat(40), external_private_key: 'f'.repeat(64) },
        }),
      )
      .expect(200);
    expect(readRpc(res).result.isError).toBe(true);
    const payload = JSON.parse(readRpc(res).result.content[0].text);
    expect(payload.error).toContain('never send private keys');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // an agent declaring its own work has no path to a PE. The hosted
  // /mcp serves no report tool; a call to one is an unknown tool and reaches no relay route.
  it('the hosted /mcp serves neither submit_pe nor submit_sovereign_work, and a call to either writes nothing', async () => {
    const listed = readRpc(
      await request(buildApp()).post('/mcp').set('Accept', MCP_ACCEPT).send(rpc(11, 'tools/list')).expect(200),
    ).result.tools as Array<{ name: string }>;
    expect(listed.length).toBeGreaterThan(5);
    const names = listed.map((t) => t.name);
    expect(names).not.toContain('submit_pe');
    expect(names).not.toContain('submit_sovereign_work');

    for (const name of ['submit_pe', 'submit_sovereign_work']) {
      const fetchImpl = jest.fn() as unknown as typeof fetch;
      const res = await request(buildApp({ fetchImpl }))
        .post('/mcp')
        .set('Accept', MCP_ACCEPT)
        .set('Authorization', 'Bearer pvn_live_k:pvns_s')
        .send(rpc(12, 'tools/call', { name, arguments: { action_type: 'agent_task_completed' } }))
        .expect(200);
      const result = readRpc(res).result ?? {};
      const text = JSON.stringify(readRpc(res));
      expect(result.isError === true || /Unknown tool|not found/i.test(text)).toBe(true);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('405s GET and DELETE (stateless endpoint, POST only)', async () => {
    const app = buildApp();
    const getRes = await request(app).get('/mcp').expect(405);
    expect(getRes.headers.allow).toBe('POST');
    await request(app).delete('/mcp').expect(405);
  });
});

describe(' (§Q4 item 9): /mcp rate buckets on a shared egress IP', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mcpRateLimitBuckets, MCP_IP_BACKSTOP_PER_MIN } = require('./mcp') as typeof import('./mcp');
  it('two tenants with their own keys behind ONE IP get separate 120/min buckets', () => {
    const a = mcpRateLimitBuckets('10.0.0.1', 'pvn_live_tenantA');
    const b = mcpRateLimitBuckets('10.0.0.1', 'pvn_live_tenantB');
    expect(a[1].key).not.toBe(b[1].key);
    expect(a[1].limit).toBe(120);
    // the per-IP backstop is shared and 10x higher
    expect(a[0]).toEqual({ key: 'rl:mcp-ip:10.0.0.1', limit: MCP_IP_BACKSTOP_PER_MIN });
    expect(a[0]).toEqual(b[0]);
    expect(a[1].key).not.toContain('pvn_live_tenantA'); // hashed, never the raw key id
  });
  it('RED control: anonymous callers keep the original single per-IP 120/min bucket', () => {
    expect(mcpRateLimitBuckets('10.0.0.1', null)).toEqual([{ key: 'rl:mcp:10.0.0.1', limit: 120 }]);
  });
});
