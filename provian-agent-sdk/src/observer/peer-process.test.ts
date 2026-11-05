/**
 * peer-process: who opened a loopback connection, from the operating system's process table — the
 * sender the model proxy and the OTLP receiver record. RED controls: the reverse
 * socket, another port, and an unrelated process never name a harness.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  PeerAttributor, defaultPeerLookup, parseLsofOwner, parseNetstatOwner, parseProcNetTcpInode,
} from './peer-process';

describe('parsers', () => {
  it('lsof: the pid whose socket is LOCAL client → REMOTE server; RED: the reverse end and another port never match', () => {
    const out = [
      'p100', 'f18', 'n127.0.0.1:4320->127.0.0.1:53001', // the daemon's own end (reverse)
      'p200', 'f7', 'n127.0.0.1:53001->127.0.0.1:4320',
      'p300', 'f9', 'n127.0.0.1:53001->127.0.0.1:9999',
    ].join('\n');
    expect(parseLsofOwner(out, 53001, 4320)).toBe(200);
    expect(parseLsofOwner(out.replace('p200\nf7\nn127.0.0.1:53001->127.0.0.1:4320\n', ''), 53001, 4320)).toBeNull();
    expect(parseLsofOwner(out, 53002, 4320)).toBeNull();
  });

  it('/proc/net/tcp: the inode of the ESTABLISHED loopback client → server socket; RED: a listening socket, and the same ports to a remote host, do not count', () => {
    const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
    const est = '   1: 0100007F:CF09 0100007F:10E0 01 00000000:00000000 00:00000000 00000000  1000        0 424242 1 0000000000000000 20 4 30 10 -1';
    const remote = '   2: 0A00000F:CF09 5DB8D822:10E0 01 00000000:00000000 00:00000000 00000000  1000        0 999999 1 0000000000000000 20 4 30 10 -1';
    const listen = '   0: 0100007F:10E0 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111111 1 0000000000000000 100 0 0 10 0';
    expect(parseProcNetTcpInode([head, listen, remote, est].join('\n'), 0xCF09, 4320)).toBe(424242);
    expect(parseProcNetTcpInode([head, listen, remote].join('\n'), 0xCF09, 4320)).toBeNull();
  });
});

describe('Windows', () => {
  it('netstat: the pid of the ESTABLISHED loopback client → server row; RED: the daemon\'s own end, another state and a remote peer do not count', () => {
    const out = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    127.0.0.1:4320         127.0.0.1:53001        ESTABLISHED     900',
      '  TCP    127.0.0.1:53001        127.0.0.1:4320         TIME_WAIT       0',
      '  TCP    10.0.0.5:53001         52.1.2.3:4320          ESTABLISHED     700',
      '  TCP    127.0.0.1:53001        127.0.0.1:4320         ESTABLISHED     1234',
    ].join('\r\n');
    expect(parseNetstatOwner(out, 53001, 4320)).toBe(1234);
    expect(parseNetstatOwner(out.replace('ESTABLISHED     1234', 'CLOSE_WAIT     1234'), 53001, 4320)).toBeNull();
    expect(parseNetstatOwner('  TCP    [::1]:53001   [::1]:4320   ESTABLISHED   77', 53001, 4320)).toBe(77);
  });

});

describe('PeerAttributor', () => {
  it('looks a socket up once; a failed, throwing, or portless lookup is unattributed', async () => {
    let calls = 0;
    const a = new PeerAttributor({ identifyProgram: p => p.args === '/usr/local/bin/claude' ? 'local-program' : null, lookup: async () => { calls += 1; return [{ pid: 5, args: '/usr/local/bin/claude' }]; } });
    const sock = { remotePort: 50000, localPort: 4320 };
    expect(await a.attribute(sock)).toBe('local-program');
    expect(await a.attribute(sock)).toBe('local-program');
    expect(calls).toBe(1);
    expect(await new PeerAttributor({ lookup: async () => null }).attribute({ remotePort: 1, localPort: 2 })).toBeNull();
    expect(await new PeerAttributor({ lookup: async () => { throw new Error('x'); } }).attribute({ remotePort: 1, localPort: 2 })).toBeNull();
    expect(await new PeerAttributor({ lookup: async () => [{ pid: 5, args: 'claude' }] }).attribute({})).toBeNull();
  });

  /** Spawn `cmd args…` connecting to a loopback listener; resolve the platform lookup of its socket. */
  async function lookupOf(cmd: string, args: string[]): Promise<{ chain: Awaited<ReturnType<ReturnType<typeof defaultPeerLookup>>>; pid: number | undefined }> {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as net.AddressInfo).port;
    const accepted = new Promise<net.Socket>((r) => server.once('connection', (s) => r(s)));
    const child = spawn(cmd, args.map((a) => a.replace('PORT', String(port))), { stdio: 'ignore' });
    try {
      const sock = await accepted;
      // Give a title the process sets once connected time to land.
      await new Promise((r) => setTimeout(r, 300));
      const chain = await defaultPeerLookup()(sock.remotePort!, sock.localPort!);
      sock.destroy();
      return { chain, pid: child.pid };
    } finally {
      child.kill();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('the platform lookup finds a real client process by its socket', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as net.AddressInfo).port;
    const accepted = new Promise<net.Socket>((r) => server.once('connection', (s) => r(s)));
    const child = spawn(process.execPath, ['-e', `const s=require('net').connect(${port},'127.0.0.1');setTimeout(()=>s.end(),5000);`], { stdio: 'ignore' });
    try {
      const sock = await accepted;
      const chain = await defaultPeerLookup()(sock.remotePort!, sock.localPort!);
      expect(chain?.[0]?.pid).toBe(child.pid);
      expect(chain?.[0]?.args).toContain('-e');
      sock.destroy();
    } finally {
      child.kill();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 15_000);
});
