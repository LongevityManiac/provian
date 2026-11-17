/**
 * the Alchemy JSON-RPC proxy is bounded on both sides.
 *
 * RED controls:
 * - a batch over ALCHEMY_RPC_MAX_BATCH is refused 400 BEFORE the rate limiter or
 * the upstream is touched (old: forwarded verbatim);
 * - every call in a batch is charged against the rate limit (old: one hit);
 * - an oversized upstream answer is 502 UPSTREAM_RESPONSE_TOO_LARGE and the
 * upstream transfer is aborted (old: buffered whole by `.json()`);
 * - an upstream trickling its body is 504 at the deadline (old: open indefinitely).
 * The upstream here is a real local HTTP server reached through the SAME bounded
 * fetch production wires in (core/net/bounded-fetch.ts).
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import http from 'http';
import type { AddressInfo } from 'net';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  createAlchemyRpcHandler,
  classifyRpcBody,
  ALCHEMY_RPC_MAX_BATCH,
  ALCHEMY_RPC_MAX_RESPONSE_BYTES,
  ALCHEMY_EVM_ALLOWED_METHODS,
  ALCHEMY_SOLANA_ALLOWED_METHODS,
  firstDisallowedRpcMethod,
  type AlchemyRpcProxyDeps,
} from './alchemy-rpc-proxy';
import { fetchBounded, DeadlineExceededError } from '../core/net/bounded-fetch';

const servers: http.Server[] = [];
const timers: NodeJS.Timeout[] = [];

afterEach(async () => {
  while (timers.length) clearInterval(timers.pop());
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
    s.closeAllConnections();
    s.close(() => resolve());
  })));
});

async function upstream(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2/test-key`;
}

/** Echo each JSON-RPC call back as a result, like a node would. */
function echoRpc(req: http.IncomingMessage, res: http.ServerResponse): void {
  let raw = '';
  req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
  req.on('end', () => {
    const body = JSON.parse(raw) as unknown;
    const answer = Array.isArray(body)
      ? body.map((call: { id: number }) => ({ jsonrpc: '2.0', id: call.id, result: '0x1' }))
      : { jsonrpc: '2.0', id: (body as { id: number }).id, result: '0x1' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer));
  });
}

class TimeoutSentinel extends Error {}

interface Harness {
  app: express.Express;
  rateCalls: Array<{ service: string; max: number; cost: number | undefined }>;
  upstreamCalls: () => number;
}

function harness(upstreamUrl: string | null, opts: { deadlineMs?: number; allow?: boolean } = {}): Harness {
  const rateCalls: Harness['rateCalls'] = [];
  let upstreamCalls = 0;
  const deps: AlchemyRpcProxyDeps = {
    upstreamUrlFor: (network) => (network === 'base-mainnet' || network === 'solana-mainnet' ? upstreamUrl : null),
    apiKeyConfigured: () => true,
    checkProxyRateLimit: async (_user, service, max, cost) => {
      rateCalls.push({ service, max, cost });
      return opts.allow ?? true;
    },
    rateLimitPerMin: 100,
    fetch: async (url, init, maxBytes) => {
      upstreamCalls += 1;
      try {
        return await fetchBounded(url, init, { deadlineMs: opts.deadlineMs ?? 5000, maxBytes });
      } catch (err) {
        if (err instanceof DeadlineExceededError) throw new TimeoutSentinel('timeout');
        throw err;
      }
    },
    forwardUpstreamResponse: (res, up, body) => {
      if (up.ok) res.json(body);
      else res.status(up.status >= 500 ? 502 : up.status).json({ upstream_body: body });
    },
    isUpstreamTimeout: (err) => err instanceof TimeoutSentinel,
    logError: () => undefined,
  };
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = { id: 'user-1' } as Request['user'];
    next();
  });
  app.post('/api/proxy/alchemy/rpc/:network', createAlchemyRpcHandler(deps));
  return { app, rateCalls, upstreamCalls: () => upstreamCalls };
}

const call = (id: number) => ({ jsonrpc: '2.0', id, method: 'eth_blockNumber', params: [] });

describe('Alchemy RPC proxy — batch cap and per-call rate cost ', () => {
  it('RED: a batch over the cap is 400 and never reaches the rate limiter or upstream', async () => {
    const h = harness(await upstream(echoRpc));
    const batch = Array.from({ length: ALCHEMY_RPC_MAX_BATCH + 1 }, (_, i) => call(i));
    const res = await request(h.app).post('/api/proxy/alchemy/rpc/base-mainnet').send(batch);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('RPC_BATCH_TOO_LARGE');
    expect(h.rateCalls).toHaveLength(0);
    expect(h.upstreamCalls()).toBe(0);
  });

  it('RED: the ~1000-call batch the old proxy forwarded as one hit is refused', async () => {
    const h = harness(await upstream(echoRpc));
    const batch = Array.from({ length: 1000 }, (_, i) => call(i));
    const res = await request(h.app).post('/api/proxy/alchemy/rpc/base-mainnet').send(batch);
    expect(res.status).toBe(400);
    expect(h.upstreamCalls()).toBe(0);
  });

  it('RED: a legitimate batch passes and is charged one unit PER CALL against the rate limit', async () => {
    const h = harness(await upstream(echoRpc));
    const batch = Array.from({ length: ALCHEMY_RPC_MAX_BATCH }, (_, i) => call(i));
    const res = await request(h.app).post('/api/proxy/alchemy/rpc/base-mainnet').send(batch);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(ALCHEMY_RPC_MAX_BATCH);
    expect(h.rateCalls).toEqual([{ service: 'alchemy_rpc', max: 100, cost: ALCHEMY_RPC_MAX_BATCH }]);
  });

  it('control: the app\'s real shape (one call per request) passes at cost 1', async () => {
    const h = harness(await upstream(echoRpc));
    const res = await request(h.app).post('/api/proxy/alchemy/rpc/base-mainnet').send(call(7));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ jsonrpc: '2.0', id: 7, result: '0x1' });
    expect(h.rateCalls).toEqual([{ service: 'alchemy_rpc', max: 100, cost: 1 }]);
  });

  it('an empty batch is refused (it would otherwise cost nothing)', async () => {
    const h = harness(await upstream(echoRpc));
    const res = await request(h.app).post('/api/proxy/alchemy/rpc/base-mainnet').send([]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('RPC_BATCH_EMPTY');
    expect(h.upstreamCalls()).toBe(0);
  });

  it('a batch the rate limiter refuses is 429 and never reaches upstream', async () => {
    const h = harness(await upstream(echoRpc), { allow: false });
    const res = await request(h.app).post('/api/proxy/alchemy/rpc/base-mainnet').send([call(1), call(2)]);
    expect(res.status).toBe(429);
    expect(h.upstreamCalls()).toBe(0);
  });

  it('an unknown network is still 400 INVALID_NETWORK', async () => {
    const h = harness(await upstream(echoRpc));
    const res = await request(h.app).post('/api/proxy/alchemy/rpc/constructor').send(call(1));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_NETWORK');
  });

  it('classifyRpcBody: object=1, n-batch=n, boundaries at 0 and cap+1', () => {
    expect(classifyRpcBody({})).toEqual({ ok: true, cost: 1 });
    expect(classifyRpcBody([call(1), call(2), call(3)])).toEqual({ ok: true, cost: 3 });
    expect(classifyRpcBody(new Array(ALCHEMY_RPC_MAX_BATCH).fill(call(1)))).toEqual({ ok: true, cost: ALCHEMY_RPC_MAX_BATCH });
    expect(classifyRpcBody(new Array(ALCHEMY_RPC_MAX_BATCH + 1).fill(call(1))).ok).toBe(false);
    expect(classifyRpcBody([]).ok).toBe(false);
  });
});

describe('Alchemy RPC proxy — bounded upstream read ', () => {
  it('RED: an oversized upstream answer is 502 and the transfer is aborted, not buffered', async () => {
    const CHUNK = Buffer.alloc(64 * 1024, 0x20);
    const TOTAL = ALCHEMY_RPC_MAX_RESPONSE_BYTES * 8;
    let sent = 0;
    let closed = false;
    const url = await upstream((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.on('close', () => { closed = true; });
      const pump = (): void => {
        while (!closed && sent < TOTAL) {
          sent += CHUNK.length;
          if (!res.write(CHUNK)) { res.once('drain', pump); return; }
        }
        if (sent >= TOTAL) res.end();
      };
      pump();
    });
    const h = harness(url);
    const res = await request(h.app).post('/api/proxy/alchemy/rpc/base-mainnet').send(call(1));
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('UPSTREAM_RESPONSE_TOO_LARGE');
    await new Promise((r) => setTimeout(r, 200));
    expect(closed).toBe(true);
    expect(sent).toBeLessThan(TOTAL / 2);
  });

  it('RED: an upstream trickling its body under the idle timer is 504 at the deadline', async () => {
    const url = await upstream((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
      timers.push(setInterval(() => res.write(' '), 50));
    });
    const h = harness(url, { deadlineMs: 400 });
    const started = Date.now();
    const res = await request(h.app).post('/api/proxy/alchemy/rpc/base-mainnet').send(call(1)).timeout(4000);
    expect(res.status).toBe(504);
    expect(res.body.code).toBe('UPSTREAM_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(2500);
  });
});

describe('Alchemy RPC proxy — method allowlist', () => {
  const rpc = (method: unknown, id = 1) => ({ jsonrpc: '2.0', id, method, params: [] });
  const post = (h: Harness, network: string, body: unknown) =>
    request(h.app).post(`/api/proxy/alchemy/rpc/${network}`).send(body as object);

  it('RED: a method the app never sends is 403 and never reaches the rate limiter or upstream', async () => {
    const h = harness(await upstream(echoRpc));
    for (const method of ['eth_sendRawTransaction', 'eth_call', 'debug_traceTransaction', 'alchemy_getTokenBalances', 'eth_getBalance']) {
      const res = await post(h, 'base-mainnet', rpc(method));
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'RPC_METHOD_NOT_ALLOWED', method });
    }
    expect(h.rateCalls).toHaveLength(0);
    expect(h.upstreamCalls()).toBe(0);
  });

  it('RED: one disallowed method anywhere in a batch refuses the whole batch', async () => {
    const h = harness(await upstream(echoRpc));
    const res = await post(h, 'base-mainnet', [rpc('eth_blockNumber', 1), rpc('eth_sendRawTransaction', 2)]);
    expect(res.status).toBe(403);
    expect(h.upstreamCalls()).toBe(0);
  });

  it('RED: a call with no string method, or a body that is not a call, is refused', async () => {
    const h = harness(await upstream(echoRpc));
    for (const body of [{ jsonrpc: '2.0', id: 1 }, rpc(7), rpc(null), [rpc('eth_blockNumber'), 'eth_blockNumber'], [[rpc('eth_blockNumber')]]]) {
      expect((await post(h, 'base-mainnet', body)).status).toBe(403);
    }
    expect(h.upstreamCalls()).toBe(0);
  });

  it('RED: the families do not leak — a Solana method on an EVM network and an EVM method on Solana are refused', async () => {
    const h = harness(await upstream(echoRpc));
    expect((await post(h, 'base-mainnet', rpc('sendTransaction'))).status).toBe(403);
    expect((await post(h, 'solana-mainnet', rpc('eth_getLogs'))).status).toBe(403);
    expect(h.upstreamCalls()).toBe(0);
  });

  it('every method the app sends is forwarded on its own network family', async () => {
    const h = harness(await upstream(echoRpc));
    expect(ALCHEMY_EVM_ALLOWED_METHODS.size + ALCHEMY_SOLANA_ALLOWED_METHODS.size).toBeGreaterThan(0);
    for (const method of ALCHEMY_EVM_ALLOWED_METHODS) {
      expect((await post(h, 'base-mainnet', rpc(method))).status).toBe(200);
    }
    for (const method of ALCHEMY_SOLANA_ALLOWED_METHODS) {
      expect((await post(h, 'solana-mainnet', rpc(method))).status).toBe(200);
    }
    expect(h.upstreamCalls()).toBe(ALCHEMY_EVM_ALLOWED_METHODS.size + ALCHEMY_SOLANA_ALLOWED_METHODS.size);
  });

  /**
   * The methods the app actually sends, read from its two proxy call sites:
   * every `this.call(...)` in SolanaRpc.ts and every `this.alchemyRpc(...)` in
   * TransactionHistoryService.ts. A call site whose method is not a string
   * literal is not parsed, so the parsed count must equal the call-site count.
   */
  const APP_ROOT = resolve(__dirname, '../../..');
  function appProxyMethods(file: string, callSite: RegExp, method: RegExp): { sites: number; methods: Set<string> } {
    const source = readFileSync(resolve(APP_ROOT, file), 'utf8');
    const sites = (source.match(callSite) ?? []).length;
    const methods = [...source.matchAll(method)].map((m) => m[1]);
    expect([file, methods.length]).toEqual([file, sites]);
    return { sites, methods: new Set(methods) };
  }
  const solanaApp = () => appProxyMethods(
    'src/core/chains/solana/SolanaRpc.ts',
    /\bthis\.call\b/g,
    /\bthis\.call(?:<[\s\S]*?>)?\(\s*'([A-Za-z_]+)'/g,
  );
  const evmApp = () => appProxyMethods(
    'src/core/history/TransactionHistoryService.ts',
    /\bthis\.alchemyRpc\(/g,
    /\bthis\.alchemyRpc\(\s*[A-Za-z_.]+\s*,\s*'([A-Za-z_]+)'/g,
  );
  const notAllowed = (methods: Set<string>, network: string) =>
    [...methods].filter((m) => firstDisallowedRpcMethod(rpc(m), network) !== null).sort();

  it('every method the app sends through the proxy, read from its call sites, is allowed on its family', () => {
    const solana = solanaApp();
    const evm = evmApp();
    expect(solana.methods.size).toBeGreaterThan(0);
    expect(evm.methods.size).toBeGreaterThan(0);
    expect(notAllowed(solana.methods, 'solana-mainnet')).toEqual([]);
    expect(notAllowed(evm.methods, 'base-mainnet')).toEqual([]);
  });

  it('the allowlist carries nothing the app does not send', () => {
    expect([...ALCHEMY_SOLANA_ALLOWED_METHODS].sort()).toEqual([...solanaApp().methods].sort());
    expect([...ALCHEMY_EVM_ALLOWED_METHODS].sort()).toEqual([...evmApp().methods].sort());
  });

  it('RED control: the derivation reports a method missing from the allowlist', () => {
    expect(notAllowed(new Set(['getBalance', 'getProgramAccounts']), 'solana-mainnet')).toEqual(['getProgramAccounts']);
    expect(notAllowed(new Set(['eth_blockNumber', 'eth_call']), 'base-mainnet')).toEqual(['eth_call']);
    expect(firstDisallowedRpcMethod(rpc('eth_blockNumber'), 'base-mainnet')).toBeNull();
    expect(firstDisallowedRpcMethod(rpc('x'.repeat(500)), 'base-mainnet')).toHaveLength(64);
  });
});
