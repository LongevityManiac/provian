/**
 * Hosted-connector handshake harness for the /mcp relay (item 8).
 *
 * Plays the opening a hosted connector client (a custom MCP connector, Claude
 * connectors, agent platforms, a hand-written fetch) sends, against the REAL router:
 * initialize → notifications/initialized → tools/list, across the Accept variants,
 * with and without an MCP session id, notification-only bodies, batch bodies, id-less
 * requests and GET probes. The bar is "connects on the first try" every request a
 * client sends as its FIRST message is answered with a JSON body carrying its result
 * (or a JSON-RPC error that names the fix) — never an empty 202, never a 406, never
 * an SSE frame a naive client has to parse.
 *
 * RED record (the router before this change, `run/agent-path-closeout` 1074d6de):
 * every case tagged `[was RED]` below failed on it — see the run report for the
 * failing line of each. The permanent in-suite controls are the `RED control` cases:
 * each feeds a deliberately violating input and asserts the violation is reported.
 */
import express from 'express';
import request from 'supertest';
import { mountMCPRoutes, resolveConnectorCredential, type MCPRouteDeps } from './mcp';
import { assertServedToolSet } from '../mcp/core/tool-set';

const BOTH = 'application/json, text/event-stream';

function buildApp(deps: MCPRouteDeps = {}): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  mountMCPRoutes(app, deps);
  return app;
}

const INIT_PARAMS = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'connector-harness', version: '0' },
};

function rpc(id: number | string, method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0', id, method, params };
}

const INITIALIZE = rpc(1, 'initialize', INIT_PARAMS);
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };
const TOOLS_LIST = rpc(2, 'tools/list');

/** A first-try success: HTTP 200, a JSON (never SSE) body, and a JSON-RPC result. */
function expectJsonResult(res: request.Response): Record<string, unknown> {
  expect(res.status).toBe(200);
  expect(res.type).toBe('application/json');
  expect(res.body && typeof res.body).toBe('object');
  expect(res.body.error).toBeUndefined();
  expect(res.body.result).toBeDefined();
  return res.body.result as Record<string, unknown>;
}

function toolNames(result: Record<string, unknown>): string[] {
  return (result.tools as Array<{ name: string }>).map((t) => t.name);
}

describe('/mcp hosted-connector handshake — first try, every variant', () => {
  beforeEach(() => {
    delete process.env.PUBLIC_LAUNCH;
    // Production posture: the product is not public; agent onboarding is open.
    process.env.MCP_AGENT_ONBOARDING = 'true';
  });
  afterEach(() => {
    delete process.env.MCP_AGENT_ONBOARDING;
  });

  describe('Accept variants (initialize and tools/list as the FIRST request)', () => {
    const variants: Array<[string, string | undefined]> = [
      ['both (spec)', BOTH],
      ['application/json only [was RED: 406]', 'application/json'],
      ['*/* [was RED: 406]', '*/*'],
      ['missing [was RED: 406]', undefined],
      ['text/event-stream only [was RED: 406]', 'text/event-stream'],
      ['q-weighted', 'text/event-stream;q=0.8, application/json;q=0.9'],
    ];
    for (const [label, accept] of variants) {
      it(`initialize — Accept ${label}`, async () => {
        const req = request(buildApp()).post('/mcp').set('Content-Type', 'application/json');
        if (accept !== undefined) req.set('Accept', accept);
        const result = expectJsonResult(await req.send(INITIALIZE));
        expect((result.serverInfo as { name: string }).name).toBe('provian');
        expect(result.protocolVersion).toBe('2025-06-18');
      });
      it(`tools/list — Accept ${label}`, async () => {
        const req = request(buildApp()).post('/mcp').set('Content-Type', 'application/json');
        if (accept !== undefined) req.set('Accept', accept);
        assertServedToolSet(toolNames(expectJsonResult(await req.send(TOOLS_LIST))));
      });
    }
  });

  it('the full opening, in order, each on the first attempt: initialize → initialized → tools/list [was RED: SSE-framed]', async () => {
    const app = buildApp();
    const init = expectJsonResult(await request(app).post('/mcp').set('Accept', BOTH).send(INITIALIZE));
    expect((init.capabilities as { tools?: unknown }).tools).toBeDefined();
    // A notification is acknowledged with 202 and no body — spec-correct, and the
    // client sends nothing it waits on here.
    const ack = await request(app).post('/mcp').set('Accept', BOTH).send(INITIALIZED);
    expect(ack.status).toBe(202);
    const list = expectJsonResult(
      await request(app).post('/mcp').set('Accept', BOTH).set('MCP-Protocol-Version', '2025-06-18').send(TOOLS_LIST),
    );
    assertServedToolSet(toolNames(list));
  });

  it('a stray Mcp-Session-Id (client carried one over from another server) is ignored, not 400/404', async () => {
    const app = buildApp();
    for (const body of [INITIALIZE, TOOLS_LIST]) {
      const res = await request(app).post('/mcp').set('Accept', BOTH).set('Mcp-Session-Id', 'sess-from-elsewhere').send(body);
      expectJsonResult(res);
    }
  });

  it('Content-Type variants: charset suffix, missing, text/plain all parse as JSON [missing/text-plain were RED: 415]', async () => {
    const app = buildApp();
    expectJsonResult(
      await request(app).post('/mcp').set('Accept', BOTH).set('Content-Type', 'application/json; charset=utf-8')
        .send(JSON.stringify(TOOLS_LIST)),
    );
    expectJsonResult(
      await request(app).post('/mcp').set('Accept', BOTH).set('Content-Type', 'text/plain;charset=UTF-8')
        .send(JSON.stringify(TOOLS_LIST)),
    );
    // No Content-Type at all (a hand-rolled client posting a string body).
    const res = await request(app).post('/mcp').set('Accept', BOTH).unset('Content-Type')
      .send(Buffer.from(JSON.stringify(TOOLS_LIST)));
    expectJsonResult(res);
  });

  it('a request missing `jsonrpc: "2.0"` is still served [was RED: 400 invalid message]', async () => {
    const res = await request(buildApp()).post('/mcp').set('Accept', BOTH)
      .send({ id: 3, method: 'initialize', params: INIT_PARAMS });
    expectJsonResult(res);
  });

  describe('no request a client sends FIRST can yield an empty 202', () => {
    it('initialize without an id → a JSON-RPC error naming the fix, not an empty 202 [was RED: empty 202]', async () => {
      const res = await request(buildApp()).post('/mcp').set('Accept', BOTH)
        .send({ jsonrpc: '2.0', method: 'initialize', params: INIT_PARAMS });
      expect(res.status).toBe(400);
      expect(res.type).toBe('application/json');
      expect(res.body.error.code).toBe(-32600);
      expect(res.body.error.message).toMatch(/needs an "id"/);
      expect(res.body.id).toBeNull();
    });

    it('tools/list without an id → JSON-RPC error [was RED: empty 202]', async () => {
      const res = await request(buildApp()).post('/mcp').set('Accept', BOTH)
        .send({ jsonrpc: '2.0', method: 'tools/list' });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/tools\/list/);
    });

    it('id: null → JSON-RPC error [was RED: empty 202]', async () => {
      const res = await request(buildApp()).post('/mcp').set('Accept', BOTH)
        .send({ jsonrpc: '2.0', id: null, method: 'tools/list' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(-32600);
    });

    it('a genuine notification alone still gets the spec 202 with no body', async () => {
      const res = await request(buildApp()).post('/mcp').set('Accept', BOTH).send(INITIALIZED);
      expect(res.status).toBe(202);
      expect(res.text ?? '').toBe('');
    });

    it('a posted JSON-RPC response alone gets 202 (nothing to answer)', async () => {
      const res = await request(buildApp()).post('/mcp').set('Accept', BOTH)
        .send({ jsonrpc: '2.0', id: 9, result: {} });
      expect(res.status).toBe(202);
    });
  });

  describe('batch bodies (2025-03-26 clients) — every request in the batch answered', () => {
    it('[notification, tools/list] → the tools/list result [was RED: SSE-framed]', async () => {
      const res = await request(buildApp()).post('/mcp').set('Accept', BOTH).send([INITIALIZED, TOOLS_LIST]);
      expect(res.status).toBe(200);
      expect(res.type).toBe('application/json');
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe(2);
      assertServedToolSet(toolNames(res.body[0].result));
    });

    it('[initialize, initialized] → the initialize result [was RED: 400 "Only one initialization request"]', async () => {
      const res = await request(buildApp()).post('/mcp').set('Accept', BOTH).send([INITIALIZE, INITIALIZED]);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].result.serverInfo.name).toBe('provian');
    });

    it('[initialize, tools/list] → both answered, in order [was RED: 400]', async () => {
      const res = await request(buildApp()).post('/mcp').set('Accept', BOTH).send([INITIALIZE, TOOLS_LIST]);
      expect(res.status).toBe(200);
      expect(res.body.map((m: { id: number }) => m.id)).toEqual([1, 2]);
    });

    it('[an id-less request, tools/list] → an error entry for the first, the result for the second', async () => {
      const res = await request(buildApp()).post('/mcp').set('Accept', BOTH)
        .send([{ jsonrpc: '2.0', method: 'initialize', params: INIT_PARAMS }, TOOLS_LIST]);
      expect(res.status).toBe(200);
      expect(res.body[0].error.code).toBe(-32600);
      expect(res.body[1].result).toBeDefined();
    });

    it('a notification-only batch → 202', async () => {
      const res = await request(buildApp()).post('/mcp').set('Accept', BOTH).send([INITIALIZED]);
      expect(res.status).toBe(202);
    });

    it('two small tool calls are both answered within the batch budgets', async () => {
      const estimate = { action_type: 'agent_action', estimated_pvt: '0.8', mint_disposition: 'mint' };
      const fetchImpl = jest.fn(async (input: Parameters<typeof fetch>[0]) => {
        expect(String(input)).toContain('/v1/pvt/estimate?action_type=agent_action');
        return new Response(JSON.stringify(estimate), {status:200,headers:{'Content-Type':'application/json'}});
      });
      const res = await request(buildApp({fetchImpl})).post('/mcp').set('Accept', BOTH).send([1,2].map(id => ({
        jsonrpc:'2.0', id, method:'tools/call', params:{name:'get_pvt_estimate',arguments:{action_type:'agent_action'}},
      })));
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body.map((reply: {id:number})=>reply.id)).toEqual([1,2]);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      for (const reply of res.body) {
        expect(reply.error).toBeUndefined();
        expect(reply.result.isError).not.toBe(true);
        expect(JSON.parse(reply.result.content[0].text)).toEqual(estimate);
      }
    });

    it('an empty batch → a JSON-RPC Invalid Request, never 202', async () => {
      const res = await request(buildApp()).post('/mcp').set('Accept', BOTH).send([]);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(-32600);
    });
  });

  describe('GET probes (a client opening an SSE stream first)', () => {
    // Streamable HTTP (2025-06-18 §Listening for Messages from the Server): the server
    // MUST either return text/event-stream on GET or 405 Method Not Allowed. This
    // endpoint is stateless and offers no server stream, so 405 + Allow: POST, with a
    // JSON-RPC body saying what to do. Spec clients treat 405 as "no stream" and go on.
    for (const accept of ['text/event-stream', BOTH, '*/*']) {
      it(`GET Accept ${accept} → 405, Allow: POST, JSON body`, async () => {
        const res = await request(buildApp()).get('/mcp').set('Accept', accept);
        expect(res.status).toBe(405);
        expect(res.headers.allow).toBe('POST');
        expect(res.type).toBe('application/json');
        expect(res.body.error.message).toMatch(/POST JSON-RPC/);
      });
    }
  });
});

describe('/mcp connector credential — every common API-key header form', () => {
  const KEY = `pvn_live_${'a'.repeat(32)}`;
  const SECRET = `pvns_${'b'.repeat(64)}`;

  beforeEach(() => {
    process.env.MCP_AGENT_ONBOARDING = 'true';
  });
  afterEach(() => {
    delete process.env.MCP_AGENT_ONBOARDING;
  });

  async function forwardedAuthorization(headers: Record<string, string>): Promise<string | null> {
    let seen: string | null = null;
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen = new Headers(init?.headers).get('Authorization');
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const req = request(buildApp({ fetchImpl })).post('/mcp').set('Accept', BOTH);
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    const res = await req.send(rpc(7, 'tools/call', { name: 'genesis_status', arguments: { wallet_id: 'wallet_aw_x' } }));
    expect(res.status).toBe(200);
    return seen;
  }

  const forms: Array<[string, Record<string, string>]> = [
    ['Authorization: Bearer key:secret', { Authorization: `Bearer ${KEY}:${SECRET}` }],
    ['Authorization: bearer key:secret (scheme case)', { Authorization: `bearer ${KEY}:${SECRET}` }],
    ['Authorization: key:secret (no scheme) [was RED]', { Authorization: `${KEY}:${SECRET}` }],
    ['X-API-Key: key:secret [was RED]', { 'X-API-Key': `${KEY}:${SECRET}` }],
    ['x-provian-api-key: key:secret [was RED]', { 'x-provian-api-key': `${KEY}:${SECRET}` }],
    ['X-API-Key: Bearer key:secret [was RED]', { 'X-API-Key': `Bearer ${KEY}:${SECRET}` }],
    ['Authorization: Basic base64(key:secret) [was RED]', { Authorization: `Basic ${Buffer.from(`${KEY}:${SECRET}`).toString('base64')}` }],
  ];
  for (const [label, headers] of forms) {
    it(`${label} → forwarded to the REST route as Bearer key:secret`, async () => {
      expect(await forwardedAuthorization(headers)).toBe(`Bearer ${KEY}:${SECRET}`);
    });
  }

  it('a PROV- link code in the API-key field is refused with the reason and the fix [was RED: silently ignored]', async () => {
    for (const headers of [
      { Authorization: 'Bearer PROV-ABCD-EFGH' },
      { 'X-API-Key': 'PROV-ABCD-EFGH' },
      { 'x-provian-api-key': 'prov-abcd-efgh' },
    ]) {
      const req = request(buildApp()).post('/mcp').set('Accept', BOTH);
      for (const [k, v] of Object.entries(headers)) req.set(k, v);
      const res = await req.send(INITIALIZE);
      expect(res.status).toBe(401);
      expect(res.type).toBe('application/json');
      expect(res.body.error.message).toMatch(/link codes expire in an hour/i);
      expect(res.body.error.message).toMatch(/API credential your wallet creation returned/);
      expect(res.body.id).toBe(1);
    }
  });

  it('a key without its secret is refused with the exact expected shape', async () => {
    const res = await request(buildApp()).post('/mcp').set('Accept', BOTH).set('X-API-Key', KEY).send(INITIALIZE);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/pvn_live_…:pvns_…/);
  });

  it('a credential in the query string is never accepted, and the caller is told to rotate it', async () => {
    const res = await request(buildApp()).post(`/mcp?api_key=${KEY}:${SECRET}`).set('Accept', BOTH).send(INITIALIZE);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/never accepted in the URL/);
    expect(res.body.error.message).toMatch(/rotate/i);
  });

  it('admission is unchanged: onboarding off → 404 before any credential judgement (nothing becomes public)', async () => {
    process.env.MCP_AGENT_ONBOARDING = 'false';
    await request(buildApp()).post('/mcp').set('X-API-Key', 'PROV-ABCD-EFGH').send(INITIALIZE).expect(404);
    await request(buildApp()).get('/mcp').expect(404);
  });

  describe('resolveConnectorCredential (pure)', () => {
    it('RED control: an unrelated scheme and an absent header resolve to no credential, not a refusal', () => {
      expect(resolveConnectorCredential({}, {})).toEqual({ kind: 'none' });
      expect(resolveConnectorCredential({ authorization: 'DeviceKey pdk:pds' }, {})).toEqual({ kind: 'none' });
    });
    it('RED control: a link code is a refusal, never a credential', () => {
      const r = resolveConnectorCredential({ 'x-api-key': 'PROV-ABCD-EFGH' }, {});
      expect(r.kind).toBe('refused');
    });
    it('Authorization wins over X-API-Key when both are present', () => {
      const other = `pvn_live_${'c'.repeat(32)}`;
      const r = resolveConnectorCredential(
        { authorization: `Bearer ${KEY}:${SECRET}`, 'x-api-key': `${other}:${SECRET}` },
        {},
      );
      expect(r).toEqual({ kind: 'ok', auth: { apiKey: KEY, apiSecret: SECRET }, source: 'authorization' });
    });
  });
});
