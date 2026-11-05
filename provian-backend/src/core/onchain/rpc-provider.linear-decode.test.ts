/**
 * Relay heap OOM, 2026-10-17. The relay aborted ~200 times in four days with
 * "Reached heap limit": ethers 6 decodes a JSON-RPC response body one byte at
 * a time into two JS arrays, so one 8.4 MB Base block cost ~170 MB of heap per
 * leg, and the inbound scan's full-block reads (4 blocks x 2 legs, batched)
 * crossed the ~700 MB ceiling. `LinearDecodeJsonRpcProvider` decodes with the
 * platform decoder.
 *
 * The growth is reproduced, not inferred: a child Node with a capped heap
 * fetches one synthetic 24 MB block. Through the stock ethers provider (the
 * permanent RED control, the provider the relay used before the fix) it dies
 * with the production FATAL; through the fixed provider it completes. The
 * equivalence cases pin that only the decoder changed.
 */
import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ethers } from 'ethers';
import { LinearDecodeJsonRpcProvider } from './rpc-provider';

const TSX = path.resolve(__dirname, '../../../node_modules/.bin/tsx');
const HEAP_CAP_MB = 128;
const BODY_MB = 24;

function runCappedBlockRead(provider: 'stock' | 'linear'): { status: number | null; stdout: string; stderr: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-heap-'));
  const script = path.join(dir, 'read-block.ts');
  fs.writeFileSync(script, `
import { ethers } from ${JSON.stringify(require.resolve('ethers'))};
import { LinearDecodeJsonRpcProvider } from ${JSON.stringify(path.resolve(__dirname, 'rpc-provider.ts'))};
// One block of ${BODY_MB} MB: transactions carrying 2 KB of calldata each.
const input = '0x' + 'ab'.repeat(1024);
const txs = [];
for (let i = 0; txs.length * 2200 < ${BODY_MB} * 1e6; i++) {
  txs.push({ hash: '0x' + i.toString(16).padStart(64, '0'), from: '0x' + '5'.repeat(40), to: '0x' + '6'.repeat(40), value: '0x1', input, nonce: '0x1' });
}
let body: Uint8Array | null = null;
const req = new ethers.FetchRequest('http://rpc.invalid/');
req.getUrlFunc = async (r) => {
  const payload = JSON.parse(Buffer.from(r.body ?? new Uint8Array()).toString('utf8'));
  if (body === null) body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { number: '0x1', transactions: txs } }));
  txs.length = 0;
  return { statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'application/json' }, body };
};
const Provider = ${provider === 'linear' ? 'LinearDecodeJsonRpcProvider' : 'ethers.JsonRpcProvider'};
const p = new Provider(req, ethers.Network.from(8453), { staticNetwork: ethers.Network.from(8453), batchMaxCount: 1 });
p.send('eth_getBlockByNumber', ['0x1', true]).then((b: { transactions: unknown[] }) => {
  console.log('transactions=' + b.transactions.length);
  p.destroy();
  process.exit(0);
}, (e: unknown) => { console.error('read failed', e); process.exit(3); });
`);
  try {
    const r = spawnSync(TSX, [script], {
      env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${HEAP_CAP_MB}` },
      encoding: 'utf8',
      timeout: 120_000,
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe(`one ${BODY_MB} MB block read under a ${HEAP_CAP_MB} MB heap`, () => {
  it('RED control: the stock ethers provider dies with the production heap FATAL', () => {
    const r = runCappedBlockRead('stock');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/heap out of memory/);
  }, 150_000);

  it('GREEN: the linear-decode provider reads the whole block', () => {
    const r = runCappedBlockRead('linear');
    expect(r.stderr).not.toMatch(/heap out of memory/);
    expect(r.status).toBe(0);
    const count = Number(/transactions=(\d+)/.exec(r.stdout)?.[1]);
    expect(count).toBeGreaterThan(10_000); // the read really carried the block
  }, 150_000);
});

describe('LinearDecodeJsonRpcProvider decodes exactly what ethers decodes', () => {
  function providerServing(bytes: Uint8Array, Ctor: typeof ethers.JsonRpcProvider): ethers.JsonRpcProvider {
    const req = new ethers.FetchRequest('http://rpc.invalid/');
    req.getUrlFunc = async () => ({ statusCode: 200, statusMessage: 'OK', headers: {}, body: bytes });
    return new Ctor(req, ethers.Network.from(8453), { staticNetwork: ethers.Network.from(8453), batchMaxCount: 1 });
  }
  const json = (result: unknown) => Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), 'utf8');

  it('multi-byte UTF-8 and astral characters decode to the same value', async () => {
    const bytes = json({ note: 'naïve – 東京 – 🦊', n: '0x2a' });
    const [a, b] = [providerServing(bytes, LinearDecodeJsonRpcProvider), providerServing(bytes, ethers.JsonRpcProvider)];
    const [ra, rb] = await Promise.all([a.send('x_read', []), b.send('x_read', [])]);
    expect(ra).toEqual({ note: 'naïve – 東京 – 🦊', n: '0x2a' });
    expect(ra).toEqual(rb);
    a.destroy(); b.destroy();
  });

  it('RED: invalid UTF-8 is refused, as ethers refuses it', async () => {
    const valid = json('ok');
    const invalid = Buffer.concat([valid.subarray(0, valid.length - 6), Buffer.from([0xc3, 0x28]), valid.subarray(valid.length - 4)]);
    const a = providerServing(invalid, LinearDecodeJsonRpcProvider);
    const b = providerServing(invalid, ethers.JsonRpcProvider);
    await expect(a.send('x_read', [])).rejects.toThrow();
    await expect(b.send('x_read', [])).rejects.toThrow();
    // GREEN twin: the same bytes without the bad sequence decode.
    const c = providerServing(valid, LinearDecodeJsonRpcProvider);
    await expect(c.send('x_read', [])).resolves.toBe('ok');
    a.destroy(); b.destroy(); c.destroy();
  });

  it('an RPC error object still surfaces as an error', async () => {
    const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'header not found' } }), 'utf8');
    const a = providerServing(bytes, LinearDecodeJsonRpcProvider);
    await expect(a.send('eth_getBlockByNumber', ['0x1', true])).rejects.toThrow(/header not found/);
    a.destroy();
  });
});

describe('every provider the relay builds decodes linearly (review r1: the builder was untested)', () => {
  const ENV = {
    BASE_RPC_URL: 'https://primary.example/base',
    BASE_RPC_OPERATOR_ID: 'primary-base',
    BASE_RPC_URL_SECONDARY: 'https://secondary.example/base',
    BASE_RPC_SECONDARY_OPERATOR_ID: 'secondary-base',
  };
  it('chain providers, verifier legs and trace legs are LinearDecodeJsonRpcProvider', () => {
    const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
    Object.assign(process.env, ENV);
    try {
      jest.isolateModules(() => {
        // A fresh module: its provider caches are empty, so every builder runs here.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const m = require('./rpc-provider') as typeof import('./rpc-provider');
        const built: unknown[] = [
          ...m.getChainProvider('base').providerConfigs.map((c) => c.provider),
          ...m.getVerifierProvider('base').providerConfigs.map((c) => c.provider),
          ...m.getOperatorBoundRpcLegs('base').map((leg) => leg.provider),
          ...m.getBaseTraceRpcLegs().map((leg) => leg.provider),
        ];
        expect(built).toHaveLength(8);
        const transport = require('./rpc-response-transport') as typeof import('./rpc-response-transport');
        for (const provider of built) {
          expect(provider).toBeInstanceOf(m.LinearDecodeJsonRpcProvider);
          expect((provider as ethers.JsonRpcProvider)._getConnection().getUrlFunc).toBe(transport.linearRpcGetUrl);
        }
      });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
