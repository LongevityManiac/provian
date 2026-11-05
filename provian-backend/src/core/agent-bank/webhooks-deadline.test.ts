/**
 * webhook delivery has an overall deadline. Before, the only bound was
 * https.request's `timeout: 5000`, a socket-IDLE timer: an endpoint trickling one
 * byte inside every window (e.g. an endless header block) held the delivery — and
 * its slot in the MAX_CONCURRENT_DELIVERIES batch — indefinitely.
 *
 * RED control: a local TLS endpoint that trickles response headers under the idle
 * timer is aborted by the wall-clock deadline. Control: a normal endpoint answers
 * and its status comes back.
 */
import { describe, it, expect, afterEach, beforeAll } from '@jest/globals';
import https from 'https';
import type { AddressInfo } from 'net';
import { postWebhookPinned, WEBHOOK_DELIVERY_DEADLINE_MS, WEBHOOK_IDLE_TIMEOUT_MS } from './webhooks';
import { startDeadline, DeadlineExceededError } from '../net/bounded-fetch';
import { makeSelfSignedCert, loopbackAgent, type TestCert } from '../../__test-helpers__/tls-test-server';

describe('webhook delivery wall-clock deadline ', () => {
  let cert: TestCert;
  const servers: https.Server[] = [];
  const timers: NodeJS.Timeout[] = [];
  let received: string[] = [];

  beforeAll(() => {
    cert = makeSelfSignedCert(['hook.test']);
  });

  afterEach(async () => {
    received = [];
    while (timers.length) clearInterval(timers.pop());
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
      s.closeAllConnections();
      s.close(() => resolve());
    })));
  });

  async function serveTls(handler: (req: import('http').IncomingMessage, res: import('http').ServerResponse) => void): Promise<number> {
    const server = https.createServer({ key: cert.key, cert: cert.cert }, handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  function deliver(port: number, deadlineMs: number): Promise<number> {
    const agent = loopbackAgent(cert);
    const deadline = startDeadline(deadlineMs);
    return postWebhookPinned({
      url: `https://hook.test:${port}/hook`,
      agent,
      body: '{"event":"escrow_created"}',
      headers: { 'X-Provian-Signature': 'sha256=00', 'X-Provian-Event': 'escrow_created' },
      deadline,
    }).finally(() => { deadline.clear(); agent.destroy(); });
  }

  it('control: a normal endpoint receives the signed POST and its status is returned', async () => {
    const port = await serveTls((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
      req.on('end', () => {
        received.push(`${req.headers['x-provian-event']}|${req.headers['content-type']}|${raw}`);
        res.writeHead(204);
        res.end();
      });
    });
    await expect(deliver(port, 3000)).resolves.toBe(204);
    expect(received).toEqual(['escrow_created|application/json|{"event":"escrow_created"}']);
  });

  it('RED: response headers trickled under the idle timeout are aborted at the wall-clock deadline', async () => {
    const port = await serveTls((req) => {
      req.resume();
      req.socket.write('HTTP/1.1 200 OK\r\n');
      timers.push(setInterval(() => req.socket.write('X-Pad: a\r\n'), 100)); // << 5 s idle timer
    });
    const started = Date.now();
    const outcome = await Promise.race([
      deliver(port, 600).then((status) => ({ status }), (error: unknown) => ({ error })),
      new Promise<'still-open'>((resolve) => timers.push(setTimeout(() => resolve('still-open'), 3000))),
    ]);
    expect(outcome).not.toBe('still-open');
    expect((outcome as { error?: unknown }).error).toBeInstanceOf(DeadlineExceededError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('an endpoint that accepts but never answers is aborted at the deadline too', async () => {
    const port = await serveTls((req) => { req.resume(); /* never respond */ });
    await expect(deliver(port, 400)).rejects.toBeInstanceOf(DeadlineExceededError);
  });

  it('the production deadline exceeds the idle timeout but stays a real bound', () => {
    expect(WEBHOOK_DELIVERY_DEADLINE_MS).toBeGreaterThan(WEBHOOK_IDLE_TIMEOUT_MS);
    expect(WEBHOOK_DELIVERY_DEADLINE_MS).toBeLessThanOrEqual(15_000);
  });
});
