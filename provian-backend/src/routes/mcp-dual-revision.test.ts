/**
 * Dual-revision compatibility matrix for the hosted /mcp relay (MCP TS SDK v2).
 *
 * Proves — not assumes — that ONE server serves BOTH protocol eras, and that the
 * modern era's required-header and version guards actually fire. The two
 * NEGATIVE CONTROL tests are in-suite red controls: each feeds a
 * deliberately violating modern request and asserts the SDK reports the
 * violation (a passing test here means the guard is live, not vacuous).
 *
 * matrix legs: guard (must RED on violation):
 * old-client × new-server (2025 initialize) UnsupportedProtocolVersion (-32022)
 * new-client × new-server HeaderMismatch (-32020)
 *
 * The modern wire shape (headers + `_meta` envelope) is exactly what the v2
 * `@modelcontextprotocol/client` emits for a `2026-07-28`-pinned connection.
 */
import express from 'express';
import request from 'supertest';
import { mountMCPRoutes } from './mcp';
import { assertServedToolSet } from '../mcp/core/tool-set';

const ACCEPT = 'application/json, text/event-stream';
const MODERN = '2026-07-28';

function buildApp(): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  mountMCPRoutes(app);
  return app;
}

/** Read the single JSON-RPC message from a plain-JSON or SSE-framed response. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readRpc(res: request.Response): any {
  if (res.type === 'text/event-stream') {
    const line = (res.text ?? '').split('\n').find((l) => l.startsWith('data:'));
    return line ? JSON.parse(line.slice('data:'.length).trim()) : {};
  }
  return res.body;
}

const CLIENT_META = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 'matrix-modern-client', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

function modernBody(id: number, method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0', id, method, params: { ...params, _meta: { ...CLIENT_META } } };
}

function modernHeaders(method: string, protocolVersion: string = MODERN): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: ACCEPT,
    'Mcp-Method': method,
    'Mcp-Protocol-Version': protocolVersion,
  };
}

// The served list is compared with the registry the served core registers (mcp/core/tool-set.ts),
// never a redeclared literal: the literal that stood here went stale when added tools.

describe('/mcp dual-revision compatibility matrix', () => {
  beforeEach(() => {
    process.env.PUBLIC_LAUNCH = 'true';
  });
  afterEach(() => {
    delete process.env.PUBLIC_LAUNCH;
  });

  // ---- old-client × new-server ----
  it('old client (2025 `initialize` handshake) is served by the new server', async () => {
    const res = await request(buildApp())
      .post('/mcp')
      .set('Accept', ACCEPT)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy', version: '0' } },
      })
      .expect(200);
    const msg = readRpc(res);
    expect(msg.result.protocolVersion).toBe('2025-06-18');
    expect(msg.result.serverInfo.name).toBe('provian');
  });

  // ---- new-client × new-server ----
  it('new client (2026-07-28) — server/discover advertises the modern revision', async () => {
    const res = await request(buildApp())
      .post('/mcp')
      .set(modernHeaders('server/discover'))
      .send(modernBody(2, 'server/discover'))
      .expect(200);
    const msg = readRpc(res);
    expect(msg.result.supportedVersions).toContain(MODERN);
  });

  it('new client (2026-07-28) — tools/list returns the tool set with resultType + cache hints', async () => {
    const res = await request(buildApp())
      .post('/mcp')
      .set(modernHeaders('tools/list'))
      .send(modernBody(3, 'tools/list'))
      .expect(200);
    const msg = readRpc(res);
    assertServedToolSet(msg.result.tools.map((t: { name: string }) => t.name));
    // 2026-07-28 CacheableResult + resultType, filled from the server's cacheHints.
    expect(msg.result.resultType).toBe('complete');
    expect(msg.result.cacheScope).toBe('private');
    expect(msg.result.ttlMs).toBe(300_000);
  });

  // ---- NEGATIVE CONTROL 1 (in-suite red): missing required header ----
  it('NEGATIVE CONTROL — a modern request missing the required Mcp-Method header is rejected with HeaderMismatch', async () => {
    const headers = modernHeaders('tools/list');
    delete headers['Mcp-Method'];
    const res = await request(buildApp())
      .post('/mcp')
      .set(headers)
      .send(modernBody(4, 'tools/list'));
    const msg = readRpc(res);
    // The guard MUST report the violation. A GREEN here without the delete above
    // would mean the header requirement is not enforced.
    expect(msg.error).toBeDefined();
    expect(msg.error.code === -32020 || /header/i.test(JSON.stringify(msg.error))).toBe(true);
  });

  // ---- NEGATIVE CONTROL 2 (in-suite red): unsupported protocol version ----
  it('NEGATIVE CONTROL — a modern request pinned to an unsupported protocol version is rejected with UnsupportedProtocolVersion', async () => {
    const body = modernBody(5, 'tools/list');
    (body.params._meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion'] = '1999-01-01';
    const res = await request(buildApp())
      .post('/mcp')
      .set(modernHeaders('tools/list', '1999-01-01'))
      .send(body);
    const msg = readRpc(res);
    expect(msg.error).toBeDefined();
    expect(msg.error.code === -32022 || /unsupported.*version/i.test(JSON.stringify(msg.error))).toBe(true);
  });

  // ---- gate invariant unchanged: unauth stays 404 regardless of era ----
  it('unauthenticated /mcp stays 404 pre-launch for both a legacy and a modern request', async () => {
    delete process.env.PUBLIC_LAUNCH;
    const app = buildApp();
    await request(app)
      .post('/mcp')
      .set('Accept', ACCEPT)
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } } })
      .expect(404);
    await request(app).post('/mcp').set(modernHeaders('tools/list')).send(modernBody(9, 'tools/list')).expect(404);
  });
});
