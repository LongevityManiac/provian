import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTransaction, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { createViemBaseChain } from './chain.js';
import { withBuilderCode } from './builder-code.js';
import type { NonceJournal } from '../canonical-nonce.js';

// The real viem chain against a local JSON-RPC stub: every facilitator Base transaction is estimated
// and signed with Provian's Builder Code (ERC-8021).
const estimated: string[] = [];
const sent: Hex[] = [];
let server: Server;
let rpcUrl = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const one = (call: { id: number; method: string; params: unknown[] }) => {
        const result = (() => {
          switch (call.method) {
            case 'eth_chainId': return '0x2105';
            case 'eth_blockNumber': return '0x64';
            case 'eth_getTransactionCount': return '0x0';
            case 'eth_estimateGas': estimated.push((call.params[0] as { data?: string }).data ?? '0x'); return '0xc350';
            case 'eth_maxPriorityFeePerGas': return '0x1';
            case 'eth_gasPrice': return '0x2';
            case 'eth_getBlockByNumber': return { number: '0x64', baseFeePerGas: '0x1', hash: `0x${'11'.repeat(32)}`, timestamp: '0x1', transactions: [] };
            case 'eth_sendRawTransaction': sent.push(call.params[0] as Hex); return `0x${'00'.repeat(32)}`;
            default: return null;
          }
        })();
        return { jsonrpc: '2.0', id: call.id, result };
      };
      const parsed = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  rpcUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function chain() {
  let state: NonceJournal | null = null;
  return createViemBaseChain({ rpcUrl, chain: base, account: privateKeyToAccount(`0x${'13'.repeat(32)}`),
    settler: `0x${'ab'.repeat(20)}`, nonceStore: { transact: async (_key, change) => { state = change(state); return state; } } });
}

describe('facilitator Builder Code', () => {
  it('estimates and signs a refill transaction with the Builder Code', async () => {
    estimated.length = 0; sent.length = 0;
    await chain().sendRaw(`0x${'cd'.repeat(20)}`, '0xdeadbeef', 0n).catch(() => undefined);
    expect(estimated).toEqual([withBuilderCode('0xdeadbeef')]);
    expect(sent).toHaveLength(1);
    expect(parseTransaction(sent[0]).data).toBe(withBuilderCode('0xdeadbeef'));
  });
  it('sends to the CREATE2 deployer exactly as planned (RED control)', async () => {
    estimated.length = 0; sent.length = 0;
    await chain().sendRaw('0x4e59b44847b379578588920cA78FbF26c0B4956C', '0xdeadbeef', 0n).catch(() => undefined);
    expect(parseTransaction(sent[0]).data).toBe('0xdeadbeef');
  });
});
