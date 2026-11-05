import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { checkConnectionCode, CONNECTION_CODE_CHECK_ROUTE } from './connection-code-check';
import { describeSetupFailure } from './setup-failure';

const LIVE = 'PROV-ABCD-2345';
const PLACEHOLDER = 'PROV-XXXX-XXXX';
// An address literal needs no DNS, so the guard passes it and the injected fetch answers.
const RELAY = 'https://93.184.216.34';

const scratch = mkdtempSync(join(tmpdir(), 'provian-code-check-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const NO_WALLET: readonly string[] = [join(scratch, 'agent-keystore.json'), join(scratch, 'pending-agent-wallet-registration.json')];

function answering(...statuses: Array<number | Error>): ReturnType<typeof vi.fn> & typeof fetch {
  const queue = [...statuses];
  return vi.fn(async (_url: unknown, _init?: RequestInit) => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return new Response(next === 204 ? null : '{}', { status: next });
  }) as unknown as ReturnType<typeof vi.fn> & typeof fetch;
}

const noSleep = async (): Promise<void> => undefined;
const check = (fetchImpl: typeof fetch, token = LIVE) =>
  checkConnectionCode({ connectionToken: token, relayUrl: RELAY }, { fetchImpl, walletFiles: NO_WALLET, sleep: noSleep });

describe('what the relay answers', () => {
  it.each([
    [200, 'proceed'],
    [404, 'dead'],
    [409, 'dead'],
    [410, 'dead'],
    [429, 'rate_limited'],
    [201, 'unruled'],
    [204, 'unruled'],
    [400, 'unruled'],
    [500, 'unruled'],
    [503, 'unruled'],
  ])('%i means %s', async (status, verdict) => {
    expect((await check(answering(status))).verdict).toBe(verdict);
  });

  it('a body that is no ruling is cancelled, so it lets go of its connection', async () => {
    const cancel = vi.fn();
    const held = (async () => new Response(new ReadableStream({ cancel }), { status: 403 })) as typeof fetch;
    await checkConnectionCode({ connectionToken: LIVE, relayUrl: RELAY }, { fetchImpl: held, walletFiles: NO_WALLET, sleep: noSleep });
    expect(cancel).toHaveBeenCalledTimes(3);
  });

  it('a body already broken when a status is no ruling changes nothing', async () => {
    const broken = (async () => new Response(
      new ReadableStream({ start(controller) { controller.error(new Error('broken')); } }),
      { status: 403 },
    )) as typeof fetch;
    expect(await check(broken)).toMatchObject({ verdict: 'unruled', answered: true });
  });

  it('a ruling takes one request', async () => {
    for (const status of [200, 404, 409, 410]) {
      const fetchImpl = answering(status);
      await check(fetchImpl);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('the placeholder is well formed, so only the relay can turn it away', async () => {
    const fetchImpl = answering(404);
    expect((await check(fetchImpl, PLACEHOLDER)).verdict).toBe('dead');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a malformed code is dead without asking, because no relay can know one', async () => {
    const fetchImpl = answering(200);
    expect((await check(fetchImpl, 'not-a-code')).verdict).toBe('dead');
    expect((await check(fetchImpl, 'PROV-abcd-2345')).verdict).toBe('dead');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('an unruled status carries the HTTP code describeSetupFailure names, and no connection advice', async () => {
    const result = await check(answering(503));
    if (result.verdict !== 'unruled') throw new Error(`expected unruled, got ${result.verdict}`);
    const failure = describeSetupFailure(result.error, { relayHost: 'api.provian.ai', retry: 'run onboard again' });
    expect(failure.kind).toBe('relay_http');
    expect(failure.connection).toBe(false);
  });
});

describe('the request', () => {
  it('asks the route, with the code in the header and never the URL', async () => {
    const fetchImpl = answering(200);
    await checkConnectionCode({ connectionToken: LIVE, relayUrl: `${RELAY}/` }, { fetchImpl, walletFiles: NO_WALLET });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`${RELAY}${CONNECTION_CODE_CHECK_ROUTE}`);
    expect((init.headers as Record<string, string>)['x-provian-token']).toBe(LIVE);
    expect(String(url)).not.toContain(LIVE);
  });

  it('is a read: no method and no body', async () => {
    const fetchImpl = answering(200);
    await check(fetchImpl);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('goes through the egress guard: a private relay is refused before any byte leaves', async () => {
    const fetchImpl = answering(200);
    const result = await checkConnectionCode(
      { connectionToken: LIVE, relayUrl: 'https://10.0.0.1' },
      { fetchImpl, walletFiles: NO_WALLET, sleep: noSleep },
    );
    expect(result.verdict).toBe('unruled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a redirect is refused, as every SDK request refuses one, and is an answer with no ruling', async () => {
    const result = await check(answering(307));
    expect(result).toMatchObject({ verdict: 'unruled', answered: true });
  });

  it('a status that is no ruling is an answer', async () => {
    expect(await check(answering(403))).toMatchObject({ verdict: 'unruled', answered: true });
  });

  it('RED control: a request that never got an answer is not marked as one', async () => {
    expect((await check(answering(new Error('fetch failed')))).verdict).toBe('unruled');
    expect(await check(answering(new Error('fetch failed')))).not.toHaveProperty('answered');
    const refused = await checkConnectionCode(
      { connectionToken: LIVE, relayUrl: 'http://relay.example:3000' },
      { fetchImpl: answering(200), walletFiles: NO_WALLET, sleep: noSleep },
    );
    expect(refused.verdict).toBe('unruled');
    expect(refused).not.toHaveProperty('answered');
  });
});

describe('retries, as the hosted check retries', () => {
  it('a passing blip is retried, one second then two', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const fetchImpl = answering(503, new Error('fetch failed'), 200);
    const result = await checkConnectionCode({ connectionToken: LIVE, relayUrl: RELAY }, { fetchImpl, walletFiles: NO_WALLET, sleep });
    expect(result.verdict).toBe('proceed');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
  });

  it('a dead code after a blip is dead', async () => {
    expect((await check(answering(503, 410))).verdict).toBe('dead');
  });

  it('three tries with no ruling stop at the last answer', async () => {
    const down = answering(new Error('fetch failed'));
    expect((await check(down)).verdict).toBe('unruled');
    expect(down).toHaveBeenCalledTimes(3);
    const limited = answering(429);
    expect((await check(limited)).verdict).toBe('rate_limited');
    expect(limited).toHaveBeenCalledTimes(3);
  });

  it('a relay that never answers is a timeout, read as a connection failure', async () => {
    const hanging = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;
    const result = await checkConnectionCode(
      { connectionToken: LIVE, relayUrl: RELAY },
      { fetchImpl: hanging, walletFiles: NO_WALLET, sleep: noSleep, timeoutMs: 5 },
    );
    if (result.verdict !== 'unruled') throw new Error(`expected unruled, got ${result.verdict}`);
    const failure = describeSetupFailure(result.error, { relayHost: 'api.provian.ai', retry: 'run onboard again' });
    expect(failure.kind).toBe('connect');
    expect(failure.connection).toBe(true);
    expect(result).not.toHaveProperty('answered');
  });

  it('the last try decides whether anything answered', async () => {
    expect(await check(answering(403, new Error('fetch failed')))).not.toHaveProperty('answered');
    expect(await check(answering(new Error('fetch failed'), 403))).toMatchObject({ verdict: 'unruled', answered: true });
  });
});

describe('a machine that already holds a wallet', () => {
  it.each(['agent-keystore.json', 'pending-agent-wallet-registration.json'])('holding %s proceeds without asking, whatever the code', async (file) => {
    const dir = mkdtempSync(join(scratch, 'holding-'));
    const held = join(dir, file);
    writeFileSync(held, '{}');
    const fetchImpl = answering(410);
    const walletFiles = [join(dir, 'agent-keystore.json'), join(dir, 'pending-agent-wallet-registration.json')];
    const result = await checkConnectionCode({ connectionToken: 'not-a-code', relayUrl: RELAY }, { fetchImpl, walletFiles });
    expect(result.verdict).toBe('proceed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('RED control: the same run with neither file is refused', async () => {
    expect((await check(answering(410))).verdict).toBe('dead');
  });
});

// The stubs above hand back a finished body. These run a real socket through the guarded stream.
describe('a real connection dropped mid-body', () => {
  async function onLoopback<T>(handler: RequestListener, run: (origin: string) => Promise<T>): Promise<T> {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  // The guard refuses loopback, so the guarded request carries a public address and this hands
  // it to the loopback server.
  const toLoopback = (origin: string): typeof fetch => (async (_url: unknown, init?: RequestInit) =>
    globalThis.fetch(`${origin}${CONNECTION_CODE_CHECK_ROUTE}`, { headers: init?.headers, signal: init?.signal })) as typeof fetch;

  // Each way the body can end early reaches undici as a different error.
  const dropAfterHeaders = (status: number, headers: Record<string, string>): RequestListener => (_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.write('{"status":"li', () => res.destroy());
  };
  const SHAPES: Array<[string, Record<string, string>]> = [
    ['keep-alive with a length', { 'Content-Length': '100' }],
    ['Connection: close with a length', { 'Content-Length': '100', Connection: 'close' }],
    ['chunked', {}],
  ];

  describe.each(SHAPES)('%s', (_label, headers) => {
    it.each([[200], [410], [429]])('a %i that never finishes is a failed connection, named as one', async (status) => {
      const result = await onLoopback(dropAfterHeaders(status, headers), (origin) => check(toLoopback(origin)));
      if (result.verdict !== 'unruled') throw new Error(`expected unruled, got ${result.verdict}`);
      expect(result).not.toHaveProperty('answered');
      expect((result.error as { code?: string }).code).toBe('ECONNRESET');
      const failure = describeSetupFailure(result.error, { relayHost: 'api.provian.ai', retry: 'run onboard again' });
      expect(failure.kind).toBe('connect');
      expect(failure.connection).toBe(true);
    });

    it('a proxy\'s 403 that never finishes is still an answer', async () => {
      const result = await onLoopback(dropAfterHeaders(403, headers), (origin) => check(toLoopback(origin)));
      expect(result).toMatchObject({ verdict: 'unruled', answered: true });
    });
  });

  it('a status that is no ruling returns at once: a stalled body is never waited for', async () => {
    const stall: RequestListener = (_req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Content-Length': '100' });
      res.write('{"error":');
    };
    const started = Date.now();
    const result = await onLoopback(stall, (origin) => checkConnectionCode(
      { connectionToken: LIVE, relayUrl: RELAY },
      { fetchImpl: toLoopback(origin), walletFiles: NO_WALLET, sleep: noSleep, timeoutMs: 2_000 },
    ));
    expect(result).toMatchObject({ verdict: 'unruled', answered: true });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('a body that stalls after a 200 times out, and is no ruling', async () => {
    const stall: RequestListener = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
      res.write('{"status":"li');
    };
    const result = await onLoopback(stall, (origin) => checkConnectionCode(
      { connectionToken: LIVE, relayUrl: RELAY },
      { fetchImpl: toLoopback(origin), walletFiles: NO_WALLET, sleep: noSleep, timeoutMs: 100 },
    ));
    if (result.verdict !== 'unruled') throw new Error(`expected unruled, got ${result.verdict}`);
    expect(result).not.toHaveProperty('answered');
    expect((result.error as { code?: string }).code).toBe('ETIMEDOUT');
  });

  it('RED control: the same server with the whole body proceeds', async () => {
    const whole: RequestListener = (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"live"}'); };
    expect((await onLoopback(whole, (origin) => check(toLoopback(origin)))).verdict).toBe('proceed');
  });
});
