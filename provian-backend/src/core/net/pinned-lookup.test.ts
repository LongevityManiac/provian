/**
 * the pinned lookup must connect on the relay's Node (20+, `autoSelectFamily` → `all: true`).
 * A REAL socket to a local server, through an Agent carrying the hook: the single-address-only hook
 * this replaced fails here with "Invalid IP address: undefined" (the RED shape, asserted below).
 */
import { describe, it, expect, afterAll, beforeAll } from '@jest/globals';
import http from 'http';
import type { AddressInfo, LookupFunction } from 'net';
import { pinnedLookup } from './pinned-lookup';

let server: http.Server;
let port = 0;
beforeAll(async () => {
  server = http.createServer((_req, res) => { res.end('ok'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

function getVia(lookup: LookupFunction): Promise<string> {
  const agent = new http.Agent({ lookup });
  return new Promise<string>((resolve) => {
    // A hostname that does NOT resolve: only the pinned hook can make this connect.
    const req = http.request(`http://pinned-host.invalid:${port}/`, { agent }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { agent.destroy(); resolve(`status ${res.statusCode} ${body}`); });
    });
    req.on('error', (e) => { agent.destroy(); resolve(`error ${e.message}`); });
    req.end();
  });
}

describe('pinnedLookup', () => {
  it('connects a real socket to the pinned address (both lookup shapes answered)', async () => {
    expect(await getVia(pinnedLookup('127.0.0.1'))).toBe('status 200 ok');
  });

  it('answers the { all: true } shape with an array and the plain shape with one address', () => {
    const lookup = pinnedLookup('2600:1900:4244:200::') as unknown as (h: string, o: unknown, cb: (...a: unknown[]) => void) => void;
    lookup('x', { all: true }, (err, addrs) => expect([err, addrs]).toEqual([null, [{ address: '2600:1900:4244:200::', family: 6 }]]));
    lookup('x', {}, (err, addr, fam) => expect([err, addr, fam]).toEqual([null, '2600:1900:4244:200::', 6]));
  });

  it('RED control: the single-address-only hook it replaced cannot connect on this Node', async () => {
    const legacy: LookupFunction = (_h, _o, cb) => { cb(null, '127.0.0.1', 4); };
    expect(await getVia(legacy)).toMatch(/^error Invalid IP address/);
  });
});
