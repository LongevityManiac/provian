/**
 * Protocol-level test: a real MCP Client talking to buildProvianMcpServer
 * over a linked in-memory transport pair — the same Server both the stdio
 * entrypoint and the relay's /mcp route serve.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { buildProvianMcpServer } from './server';
import type { ToolContext } from './types';
import { assertServedToolSet } from './tool-set';

function makeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function connectedClient(ctx: ToolContext): Promise<Client> {
  const server = buildProvianMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('buildProvianMcpServer over MCP protocol', () => {
  it('lists the full tool set with schemas', async () => {
    const client = await connectedClient({
      baseUrl: 'https://relay.test',
      fetchImpl: fetch,
      auth: null,
      mode: 'local',
    });
    const { tools } = await client.listTools();
    // Bound to the registry the server registers (tool-set.ts), not a redeclared count or list.
    assertServedToolSet(tools.map((t) => t.name));
    const createWallet = tools.find((t) => t.name === 'create_wallet')!;
    expect(createWallet.inputSchema).toMatchObject({ type: 'object' });
    expect(createWallet.description).toContain('Every act of work mints PVT once at its best-supported value');
  });

  it('remote create_wallet fails closed before the stateless server calls the relay', async () => {
    let fetchCalls = 0;
    const fetchImpl = (async (url: string) => {
      fetchCalls += 1;
      if (String(url).includes('/challenge')) {
        return makeResponse(200, { challenge_id: 'c1', challenge: 'bytes', expires_at: 0 });
      }
      return makeResponse(201, {
        wallet_id: 'wallet_aw_mcp',
        address: '0x' + 'c'.repeat(40),
        api_key: 'pvn_live_x',
        api_secret: 'pvns_y',
      });
    }) as unknown as typeof fetch;

    const client = await connectedClient({
      baseUrl: 'https://relay.test',
      fetchImpl,
      auth: null,
      mode: 'remote',
    });
    const result = await client.callTool({ name: 'create_wallet', arguments: { agent_name: 'ProtoBot' } });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(result.isError).toBe(true);
    expect(parsed.error).toContain('Remote create_wallet is disabled before key generation');
    expect(fetchCalls).toBe(0);
  });

  it('returns isError results for unknown tools instead of protocol errors', async () => {
    const client = await connectedClient({
      baseUrl: 'https://relay.test',
      fetchImpl: fetch,
      auth: null,
      mode: 'local',
    });
    const result = await client.callTool({ name: 'nope', arguments: {} });
    expect(result.isError).toBe(true);
  });
});
