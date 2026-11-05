import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProvianObserver } from '../ProvianObserver';
import { ModelProxyPlugin } from './ModelProxyPlugin';
import { OTelPlugin } from './OTelPlugin';
import { listenWithRetry, PORT_RETRY_BURST_ATTEMPTS, PORT_RETRY_BURST_MS } from './port-retry';

// follow-up, review rounds 4–5: the lock holder stops a stray daemon that held the lanes' ports;
// the holder's lanes take them back then — and never contend for a port on their own (a user's own
// collector restarting must not lose 4318 to us).

const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
});
const hold = (port: number): Promise<net.Server> => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(port, '127.0.0.1', () => resolve(s));
});
const close = (s: net.Server): Promise<void> => new Promise((r) => s.close(() => r()));
const settle = async (until: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setImmediate(r));
};

afterEach(() => { vi.useRealTimers(); });

describe('listenWithRetry', () => {
  const manual = () => {
    const timers: Array<() => void> = [];
    return { timers, setTimer: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimer: () => { timers.length = 0; } };
  };
  it('a taken port is NOT retried on its own: freed later, the lane stays down (RED for ) until retry() is called', async () => {
    const port = await freePort();
    const blocker = await hold(port);
    const t = manual();
    let bound: http.Server | null = null; const inUse: boolean[] = [];
    const b = listenWithRetry({
      create: () => http.createServer(), port, host: '127.0.0.1', burstAttempts: 3,
      onBound: (s) => { bound = s; }, onInUse: (first) => inUse.push(first), onError: () => { throw new Error('unexpected'); }, ...t,
    });
    await b.first;
    expect(inUse).toEqual([true]);
    expect(t.timers).toHaveLength(0);                     // no timer: nothing contends for the port
    await close(blocker);
    await settle(() => false);
    expect(bound).toBeNull();
    b.retry();
    await settle(() => bound !== null);
    expect(bound).not.toBeNull();
    await new Promise((r) => (bound as http.Server).close(() => r(null)));
  });
  it('retry() is a bounded burst: still taken, it tries burstAttempts times in all, then waits again (RED: the burst ends)', async () => {
    const port = await freePort();
    const blocker = await hold(port);
    const t = manual();
    const inUse: boolean[] = [];
    const b = listenWithRetry({
      create: () => http.createServer(), port, host: '127.0.0.1', burstAttempts: 3,
      onBound: () => { throw new Error('unexpected'); }, onInUse: (first) => inUse.push(first), onError: () => { throw new Error('unexpected'); }, ...t,
    });
    await b.first;
    b.retry();
    for (let i = 0; i < 5; i++) { await settle(() => t.timers.length > 0); t.timers.shift()?.(); }
    await settle(() => false);
    expect(inUse).toEqual([true, false, false, false]);   // start + a burst of 3
    expect(t.timers).toHaveLength(0);
    b.cancel();
    await close(blocker);
  });
  it('a burst defaults to 60 s of tries every 2 s — past a stray\'s bounded 15 s shutdown', () => {
    expect(PORT_RETRY_BURST_MS * PORT_RETRY_BURST_ATTEMPTS).toBe(60_000);
  });
  it('cancel ends a burst (RED: the queued try never runs)', async () => {
    const port = await freePort();
    const blocker = await hold(port);
    const t = manual();
    let bound = false;
    const b = listenWithRetry({
      create: () => http.createServer(), port, host: '127.0.0.1', burstAttempts: 3,
      onBound: () => { bound = true; }, onInUse: () => {}, onError: () => {}, ...t,
    });
    await b.first;
    b.retry();
    await settle(() => t.timers.length > 0);
    const queued = t.timers[0];
    b.cancel();
    await close(blocker);
    queued?.();                                            // a timer that fired anyway
    await settle(() => false);
    expect(bound).toBe(false);
  });
  it('cancelled while a listen is in flight: the server it bound is closed, never handed to the lane (RED)', async () => {
    const port = await freePort();
    let bound = false;
    const b = listenWithRetry({
      create: () => http.createServer(), port, host: '127.0.0.1',
      onBound: () => { bound = true; }, onInUse: () => {}, onError: () => {},
    });
    b.cancel();                                            // a stop arriving before the listen completes
    await b.first;
    await settle(() => false);
    expect(bound).toBe(false);
    const again = await hold(port);                       // and the port is free again
    await close(again);
  });
  it('any other listen failure is reported once; retry() never re-tries it', async () => {
    const t = manual(); const errors: string[] = []; let created = 0;
    const b = listenWithRetry({
      create: () => { created += 1; return http.createServer(); }, port: 1, host: '203.0.113.7',   // not an address of this machine
      onBound: () => { throw new Error('unexpected'); }, onInUse: () => { throw new Error('unexpected'); },
      onError: (e) => errors.push(e.code ?? e.message), ...t,
    });
    await b.first;
    b.retry();
    await settle(() => false);
    expect(errors).toHaveLength(1);
    expect(created).toBe(1);
    expect(t.timers).toHaveLength(0);
  });
});

const observer = (logs: unknown[]) => ({
  log: (...a: unknown[]) => logs.push(a),
  observerDeviceWitness: () => ({ type: 'observer_device', identity: 'device-test', attestation_tier: 'software' }),
}) as unknown as ProvianObserver;
const journal = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-')), 'j.json');
const portFree = (port: number): Promise<boolean> => new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(port, '127.0.0.1', () => s.close(() => r(true))); });

describe('the lanes take their port back when the lock holder stops a stray observer', () => {
  it('model proxy: down while held; freed, still down on its own (RED); rebindIfWaiting → listening', async () => {
    const port = await freePort();
    const blocker = await hold(port);
    const plugin = new ModelProxyPlugin({ port, journalPath: journal() });
    await plugin.init(observer([]));
    await plugin.start();
    expect(plugin.isListening()).toBe(false);
    await close(blocker);
    await settle(() => false);
    expect(plugin.isListening()).toBe(false);
    plugin.rebindIfWaiting();
    await settle(() => plugin.isListening());
    expect(plugin.isListening()).toBe(true);
    await plugin.stop();
  });
  it('model proxy: a stopped lane never takes the port back (RED control for stop)', async () => {
    const port = await freePort();
    const blocker = await hold(port);
    const plugin = new ModelProxyPlugin({ port, journalPath: journal() });
    await plugin.init(observer([]));
    await plugin.start();
    await plugin.stop();
    await close(blocker);
    plugin.rebindIfWaiting();
    await settle(() => false);
    expect(plugin.isListening()).toBe(false);
    expect(await portFree(port)).toBe(true);
  });
  it('otel receiver: down while 4318 is held; rebindIfWaiting → listening; a stopped receiver never binds (RED)', async (ctx) => {
    for (const stopFirst of [false, true]) {
      let blocker: net.Server;
      try { blocker = await hold(4318); } catch { ctx.skip(); return; }   // this machine runs a collector on 4318
      const plugin = new OTelPlugin({ journalPath: null, forceActive: true });
      await plugin.init(observer([]));
      await plugin.start();
      expect(plugin.getListeningPort()).toBeNull();
      if (stopFirst) await plugin.stop();
      await close(blocker);
      plugin.rebindIfWaiting();
      await settle(() => plugin.getListeningPort() !== null);
      expect(plugin.getListeningPort()).toBe(stopFirst ? null : 4318);
      if (stopFirst) expect(await portFree(4318)).toBe(true);
      else await plugin.stop();
    }
  });
});
