/**
 * every supertest server in this suite listens on 127.0.0.1, so no other socket can answer
 * a test's request (jest.setup.js). The intermittent full-suite 401s (sovereign-pe `replay realism`,
 * mcp.test, devices-owner-type-management) were requests answered by a STRANGER: supertest bound
 * the wildcard [::]:P and connected to 127.0.0.1:P, and on macOS a socket bound explicitly to
 * 127.0.0.1:P elsewhere (another process, another test run) is the more specific match.
 */
import { describe, it, expect } from '@jest/globals';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import request from 'supertest';

function tryBind(port: number, host: string): Promise<{ server: http.Server | null; code: string | null }> {
  return new Promise((resolve) => {
    const server = http.createServer((_q, r) => { r.statusCode = 401; r.end('auth required'); });
    server.once('error', (err: NodeJS.ErrnoException) => resolve({ server: null, code: err.code ?? 'error' }));
    server.listen(port, host, () => resolve({ server, code: null }));
  });
}

describe('supertest listens on 127.0.0.1 (jest.setup.js)', () => {
  it('the test app is reached on IPv4 loopback itself, not through the dual-stack wildcard', async () => {
    const app = express();
    app.get('/whoami', (req, res) => { res.json({ local: req.socket.localAddress }); });
    const res = await request(app).get('/whoami');
    expect(res.status).toBe(200);
    // Through a [::] wildcard socket this reads '::ffff:127.0.0.1' — the unpatched, hijackable bind.
    expect(res.body.local).toBe('127.0.0.1');
  });

  it('while a test server holds its port, a foreign 127.0.0.1 bind of that port is refused', async () => {
    const app = express();
    app.get('/', async (req, res) => {
      const foreign = await tryBind(req.socket.localPort as number, '127.0.0.1');
      foreign.server?.close();
      res.json({ foreignBound: foreign.server !== null, code: foreign.code });
    });
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ foreignBound: false, code: 'EADDRINUSE' });
  });

  it('query strings and chained calls still reach the app on the real port', async () => {
    const app = express();
    app.post('/echo', express.json(), (req, res) => { res.json({ q: req.query.a, body: req.body }); });
    const res = await request(app).post('/echo').query({ a: '1' }).set('X-T', 'y').send({ b: 2 });
    expect(res.body).toEqual({ q: '1', body: { b: 2 } });
  });
});

describe('RED CONTROL — the unpatched wildcard bind is hijackable (the defect, reproduced)', () => {
  it('a [::]:P server loses 127.0.0.1:P to an explicit foreign bind on macOS; Linux refuses the bind', async () => {
    const ours = http.createServer((_q, r) => { r.statusCode = 201; r.end('ours'); });
    await new Promise<void>((resolve) => ours.listen(0, resolve)); // what supertest did before the fix
    const port = (ours.address() as AddressInfo).port;
    // The foreign bind usually succeeds (macOS). If it reports EADDRINUSE on macOS, a THIRD process
    // already holds 127.0.0.1:P — the same hijack, by someone else — so the request is sent either way.
    const foreign = await tryBind(port, '127.0.0.1');
    const status = await new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/', agent: false }, (r) => { r.resume(); resolve(r.statusCode ?? 0); })
        .on('error', reject);
    });
    foreign.server?.close();
    ours.close();
    if (process.platform === 'darwin') {
      expect(status).not.toBe(201); // our wildcard server did NOT answer a request sent to its own port
      if (foreign.code === null) expect(status).toBe(401); // the stranger we bound did
    } else {
      expect(foreign.code).toBe('EADDRINUSE');
      expect(status).toBe(201);
    }
  });
});
