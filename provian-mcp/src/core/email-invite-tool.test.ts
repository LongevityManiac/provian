import { describe, expect, it } from 'vitest';
import { callProvianTool, findTool } from './tools';
import type { ToolContext } from './types';
describe('agent email MCP surfaces', () => {
  it.each([['invite','invite','email'],['invite_human','invite-human','human_email'],['invite_device','device-invite','email']])('%s forwards language and uses agent auth', async (name, route, field) => {
    let init: RequestInit | undefined; let url = '';
    const fetchImpl = (async (input: string, options: RequestInit) => {
      url = input; init = options; return new Response(JSON.stringify({ sent: true }), { status: 201 });
    }) as typeof fetch;
    const ctx: ToolContext = { baseUrl: 'https://relay.test', fetchImpl, auth: { apiKey: 'key', apiSecret: 'secret' }, mode: 'local' };
    expect(findTool(name)?.inputSchema.properties).toHaveProperty('language');
    const result = await callProvianTool(name, { wallet_id: 'wallet_aw_123', [field]: 'person@example.com', language: 'ja' }, ctx);
    expect(result.isError).not.toBe(true);
    expect(url).toBe(`https://relay.test/v1/agent/wallet/wallet_aw_123/${route}`);
    expect(JSON.parse(String(init?.body))).toMatchObject({ [field]: 'person@example.com', language: 'ja' });
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer key:secret');
    // RED control: the same tool with no credentials cannot reach the network.
    url = ''; const refused = await callProvianTool(name, { wallet_id: 'wallet_aw_123', [field]: 'person@example.com' }, { ...ctx, auth: undefined });
    expect(refused.isError).toBe(true); expect(url).toBe('');
  });
});
