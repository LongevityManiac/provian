/**
 * Dual-revision compatibility matrix for the stdio server (MCP TS SDK v2).
 *
 * Proves — not assumes — that the SAME `buildProvianMcpServer` factory, served
 * through `serveStdio`, answers BOTH a current-era client that opens with the
 * 2025 `initialize` handshake AND a modern 2026-07-28 client (stateless, `_meta`
 * envelope, `server/discover`, cacheable `tools/list`). The last test is a
 * in-suite RED negative control: it feeds a modern request pinned to an
 * unsupported protocol version and asserts the SDK reports the violation.
 *
 * The missing-required-header leg of the matrix is HTTP-only (the `Mcp-Method`/
 * `Mcp-Name` headers are a Streamable HTTP construct); it is exercised in the
 * relay's mcp-dual-revision.test.ts. Over stdio the version guard is the
 * applicable negative control.
 */
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { buildProvianMcpServer } from './server';
import type { ToolContext } from './types';
import { assertServedToolSet } from './tool-set';

const CTX: ToolContext = {
  baseUrl: 'https://relay.test',
  fetchImpl: fetch,
  auth: null,
  mode: 'local',
};

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'matrix', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

function modern(id: number, method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0', id, method, params: { ...params, _meta: { ...MODERN_META } } };
}

/** Open a fresh serveStdio connection over in-memory pipes, send one message,
 *  resolve the first response line. The opening message's envelope decides the
 *  wire era (legacy `initialize` vs modern `_meta`). */
async function serveOneShot(msg: unknown): Promise<Record<string, any>> {
  const cin = new PassThrough();
  const cout = new PassThrough();
  const handle = serveStdio(() => buildProvianMcpServer(() => CTX), {
    transport: new StdioServerTransport(cin, cout),
    legacy: 'serve',
  });
  const first = new Promise<string>((resolve, reject) => {
    let buf = '';
    cout.on('data', (d) => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i >= 0) resolve(buf.slice(0, i));
    });
    setTimeout(() => reject(new Error('serveOneShot timeout')), 4000);
  });
  cin.write(`${JSON.stringify(msg)}\n`);
  const line = await first;
  await handle.close();
  return JSON.parse(line);
}

// The served list is compared with the registry the server registers (tool-set.ts), never a
// redeclared literal: the literal that stood here went stale when added tools.

describe('stdio dual-revision compatibility matrix', () => {
  // ---- old-client × new-server ----
  it('old client (2025 `initialize` handshake) is served', async () => {
    const res = await serveOneShot({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy', version: '0' } },
    });
    expect(res.result.protocolVersion).toBe('2025-06-18');
    expect(res.result.serverInfo.name).toBe('provian');
  });

  // ---- new-client × new-server ----
  it('new client (2026-07-28) — server/discover advertises the modern revision', async () => {
    const res = await serveOneShot(modern(2, 'server/discover'));
    expect(res.result.supportedVersions).toContain('2026-07-28');
    expect(res.result.resultType).toBe('complete');
  });

  it('new client (2026-07-28) — tools/list returns the tool set with resultType + cache hints', async () => {
    const res = await serveOneShot(modern(3, 'tools/list'));
    assertServedToolSet(res.result.tools.map((t: { name: string }) => t.name));
    expect(res.result.resultType).toBe('complete');
    expect(res.result.cacheScope).toBe('private');
    expect(res.result.ttlMs).toBe(300_000);
  });

  // ---- NEGATIVE CONTROL (in-suite red): unsupported protocol version ----
  it('NEGATIVE CONTROL — a modern request pinned to an unsupported protocol version is rejected with UnsupportedProtocolVersion', async () => {
    const msg = modern(4, 'tools/list');
    (msg.params._meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion'] = '1999-01-01';
    const res = await serveOneShot(msg);
    // GREEN here requires the guard to fire; without the mutation above the same
    // request lists tools, so this control cannot pass vacuously.
    expect(res.error).toBeDefined();
    expect(res.error.code === -32022 || /unsupported.*version/i.test(JSON.stringify(res.error))).toBe(true);
  });
});
