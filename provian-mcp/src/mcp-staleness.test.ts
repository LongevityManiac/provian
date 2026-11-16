import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMcpVersionChecker, isOlder, mcpUpdateNotice, MCP_VERSION_REFRESH_MS } from './mcp-staleness';
import { PROVIAN_MCP_VERSION } from './core/tools';
import { buildProvianMcpServer } from './core/server';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';

const PKG = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const SERVER_JSON = JSON.parse(readFileSync(join(__dirname, '..', 'server.json'), 'utf8'));

function relay(latest: unknown, calls: string[] = []): typeof fetch {
  return (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ latest }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('running version', () => {
  it('the server reports the version it was published as', () => {
    expect(PROVIAN_MCP_VERSION).toBe(PKG.version);
    expect(SERVER_JSON.version).toBe(PKG.version);
  });
});

describe('mcpUpdateNotice', () => {
  it('names the latest version and the @latest launch line when behind', () => {
    const line = mcpUpdateNotice('1.3.4', '1.3.5');
    expect(line).toContain('1.3.5');
    expect(line).toContain('npx -y @provian/mcp@latest');
    expect(line).not.toContain('\n');
  });

  it('[negative control] says nothing when current, ahead, unknown or unparseable', () => {
    expect(mcpUpdateNotice('1.3.5', '1.3.5')).toBeNull();
    expect(mcpUpdateNotice('1.4.0', '1.3.5')).toBeNull();
    expect(mcpUpdateNotice('1.3.5', null)).toBeNull();
    expect(mcpUpdateNotice('1.3.5', 'garbage')).toBeNull();
    expect(isOlder('1.3.9', '1.10.0')).toBe(true);
    expect(isOlder('2.0.0', '1.10.0')).toBe(false);
  });
});

describe('createMcpVersionChecker', () => {
  it('learns latest from the relay and turns it into the notice', async () => {
    const calls: string[] = [];
    const c = createMcpVersionChecker({ baseUrl: 'https://relay.test/', fetchImpl: relay('9.0.0', calls), running: '1.3.5' });
    expect(c.notice()).toBeNull();
    c.refresh();
    await c.pending();
    expect(calls).toEqual(['https://relay.test/v1/mcp/version']);
    expect(c.notice()).toContain('9.0.0');
  });

  it('asks again only after the refresh window', async () => {
    let t = 0;
    const calls: string[] = [];
    const c = createMcpVersionChecker({ baseUrl: 'https://relay.test', fetchImpl: relay('1.3.5', calls), running: '1.3.5', now: () => t });
    c.refresh(); await c.pending();
    c.refresh(); c.refresh();
    expect(calls).toHaveLength(1);
    t = MCP_VERSION_REFRESH_MS;
    c.refresh(); await c.pending();
    expect(calls).toHaveLength(2);
  });

  it('fails open: a relay error or bad body yields no line and no throw', async () => {
    const failing = (async () => { throw new Error('offline'); }) as typeof fetch;
    const a = createMcpVersionChecker({ baseUrl: 'https://relay.test', fetchImpl: failing, running: '1.0.0' });
    a.refresh(); await a.pending();
    expect(a.notice()).toBeNull();
    const b = createMcpVersionChecker({ baseUrl: 'https://relay.test', fetchImpl: relay(42), running: '1.0.0' });
    b.refresh(); await b.pending();
    expect(b.notice()).toBeNull();
  });
});

describe('tool results', () => {
  type Content = Array<{ type: string; text: string }>;
  async function call(resultNotice?: () => string | null): Promise<{ content: Content; isError?: boolean }> {
    const server = buildProvianMcpServer(
      () => ({ baseUrl: 'https://relay.test', fetchImpl: relay('1.3.5'), auth: null, mode: 'local' }),
      resultNotice ? { resultNotice } : {},
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const r = await client.callTool({ name: 'no_such_tool', arguments: {} });
    return { content: r.content as Content, isError: r.isError as boolean | undefined };
  }

  it('a behind server adds exactly one line; the tool result itself is unchanged', async () => {
    const plain = await call();
    const noted = await call(() => 'NOTICE LINE');
    expect(noted.content.slice(0, -1)).toEqual(plain.content);
    expect(noted.content.at(-1)).toEqual({ type: 'text', text: 'NOTICE LINE' });
    expect(noted.isError).toBe(plain.isError);
  });

  it('[negative control] a current server adds nothing', async () => {
    const plain = await call();
    const current = await call(() => null);
    expect(current).toEqual(plain);
  });
});
