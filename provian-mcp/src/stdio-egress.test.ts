/**
 * (C) — the stdio server (`@provian/mcp`) reaches the relay through a
 * forward proxy (a proxy-only cloud box), end to end through the REAL bin.
 *
 * A fake proxy on loopback records the CONNECT it receives; the server is asked
 * for the public `get_action_type_status` over stdio (newline-delimited JSON-RPC). With the entry
 * apply in place the relay request goes to the proxy; the RED control bypasses
 * the apply (its re-exec guard pre-set) and the proxy sees nothing — the
 * pre- behaviour, where native fetch ignored HTTPS_PROXY.
 *
 * Needs a Node with env-proxy support (22.21+ / 24.5+). an older runner
 * with none installed the test is SKIPPED and says so; the decision logic itself
 * is covered in provian-agent-sdk/src/runtime-env.test.ts (byte-identical copy).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { nodeSupportsEnvProxy } from './runtime-env';

const BIN = path.resolve(__dirname, '..', 'bin', 'provian-mcp.mjs');

function envProxyNode(): string | null {
  const candidates = [process.execPath, '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
  for (const c of candidates) {
    try {
      const v = execFileSync(c, ['-p', 'process.versions.node'], { encoding: 'utf8' }).trim();
      if (nodeSupportsEnvProxy(v)) return c;
    } catch { /* not present */ }
  }
  return null;
}

const NODE = envProxyNode();
const children: ChildProcess[] = [];
const servers: net.Server[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  for (const s of servers.splice(0)) s.close();
});

async function fakeProxy(): Promise<{ port: number; connects: string[] }> {
  const connects: string[] = [];
  const server = net.createServer((sock) => {
    sock.once('data', (buf) => {
      const first = buf.toString('latin1').split('\r\n')[0];
      connects.push(first);
      sock.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });
    sock.on('error', () => undefined);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as net.AddressInfo).port, connects };
}

async function runPublicRead(env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(NODE as string, [BIN], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const send = (m: unknown) => child.stdin!.write(`${JSON.stringify(m)}\n`);
  let out = '';
  child.stdout!.on('data', (d) => { out += d.toString(); });
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  await waitFor(() => out.includes('"id":1'), 15_000);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_action_type_status', arguments: { action_type: 'agent_action' } } });
  await waitFor(() => out.includes('"id":2'), 20_000);
}

async function waitFor(pred: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function baseEnv(port: number): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-egress-'));
  return { PATH: process.env.PATH, HOME: home, HTTPS_PROXY: `http://127.0.0.1:${port}` };
}

describe.skipIf(NODE === null)('@provian/mcp stdio honours HTTPS_PROXY (C)', () => {
  it('the relay call goes through the configured proxy', async () => {
    const p = await fakeProxy();
    await runPublicRead(baseEnv(p.port));
    expect(p.connects.some((l) => /^CONNECT api\.provian\.ai:443 /.test(l))).toBe(true);
  }, 45_000);

  it('RED control: with the entry apply bypassed, native fetch ignores the proxy', async () => {
    const p = await fakeProxy();
    await runPublicRead({ ...baseEnv(p.port), PROVIAN_RUNTIME_ENV_REEXEC: '1' });
    expect(p.connects).toEqual([]);
  }, 45_000);
});

it('reports when the env-proxy e2e cannot run here', () => {
  if (NODE === null) console.warn('[stdio-egress] SKIPPED: no Node >= 22.21 / 24.5 on this machine');
  expect(true).toBe(true);
});
