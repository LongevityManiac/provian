/**
 * Headless tests for the P4-01-SDK contributor-side pool withdrawal flow:
 *   - CommonsInstitutions.withdrawFromPool -> on-chain withdrawContribution(bytes32) + POST
 *     /v1/pools/:id/withdraw with the mined tx_hash (the relay verifies the
 *     on-chain PoolWithdrawal before deleting the Firestore contribution).
 *
 * Relay calls go through an injected `fetch` (captured + canned); on-chain
 * broadcasts go through an injected viem transport (raw txs captured + decoded).
 * Mirrors agent-institutions.escrow.release.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { custom, keccak256, parseTransaction, type Hex } from 'viem';
import { CommonsInstitutions } from './commons-institutions';
import { encodeWithdrawContribution, POOL_ADDRESSES } from './evm-pool';

const TEST_PRIV_KEY = '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d';
const TEST_ADDRESS = '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1';
const WALLET = { privateKeyHex: TEST_PRIV_KEY, address: TEST_ADDRESS };
const FEES = { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };

const BASE_CONFIG = { relayUrl: 'https://relay.test', walletId: 'wallet_aw_x', apiKey: 'pvn_live_x', apiSecret: 'pvns_x' };
const ONCHAIN_POOL_ID = ('0x' + '9'.repeat(64)) as Hex;

interface FetchCall { url: string; method?: string; body: unknown }
function makeMockFetch(responder: (call: FetchCall) => { status?: number; body: unknown }) {
  const calls: FetchCall[] = [];
  const mockFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let parsed: unknown;
    if (typeof init?.body === 'string') {
      try { parsed = JSON.parse(init.body); } catch { parsed = init.body; }
    }
    const call: FetchCall = { url: String(url), method: init?.method, body: parsed };
    calls.push(call);
    const { status = 200, body } = responder(call);
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  };
  return { mockFetch: mockFetch as unknown as typeof fetch, calls };
}

function makeMockTransport(chainId: number, receiptStatus: '0x1' | '0x0' = '0x1') {
  const rawTxs: Hex[] = [];
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      switch (method) {
        case 'eth_chainId': return `0x${chainId.toString(16)}`;
        case 'eth_getTransactionCount': return '0x0';
        case 'eth_estimateGas': return '0x186a0';
        case 'eth_sendRawTransaction': {
          const raw = (params as Hex[])[0];
          rawTxs.push(raw);
          return keccak256(raw);
        }
        case 'eth_getTransactionReceipt': {
          const hash = (params as Hex[])[0];
          return {
            transactionHash: hash,
            status: receiptStatus,
            blockNumber: '0x1',
            blockHash: '0x' + '1'.repeat(64),
            transactionIndex: '0x0',
            from: TEST_ADDRESS,
            to: POOL_ADDRESSES.base,
            cumulativeGasUsed: '0x186a0',
            gasUsed: '0x186a0',
            contractAddress: null,
            logs: [],
            logsBloom: '0x' + '0'.repeat(512),
            type: '0x2',
            effectiveGasPrice: '0x3b9aca00',
          };
        }
        case 'eth_blockNumber': return '0x1';
        default:
          throw new Error(`mock transport: unexpected RPC method ${method}`);
      }
    },
  });
  return { transport, rawTxs };
}

describe('CommonsInstitutions.withdrawFromPool — SDK boundary validation (no network)', () => {
  it('rejects an empty poolId before any broadcast', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ body: {} }));
    const { transport, rawTxs } = makeMockTransport(8453);
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await expect(
      institutions.withdrawFromPool(WALLET, { poolId: '', onchainPoolId: ONCHAIN_POOL_ID, transport, ...FEES }),
    ).rejects.toThrow(/poolId is required/);
    expect(rawTxs).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('rejects a malformed onchainPoolId before any broadcast', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ body: {} }));
    const { transport, rawTxs } = makeMockTransport(8453);
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await expect(
      institutions.withdrawFromPool(WALLET, { poolId: 'pool_1', onchainPoolId: '0xdeadbeef', transport, ...FEES }),
    ).rejects.toThrow(/onchainPoolId must be a 0x-prefixed 32-byte/);
    expect(rawTxs).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('rejects an unconfigured chain before any broadcast', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ body: {} }));
    const { transport, rawTxs } = makeMockTransport(42161);
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await expect(
      institutions.withdrawFromPool(WALLET, { poolId: 'pool_1', onchainPoolId: ONCHAIN_POOL_ID, chain: 'arbitrum', transport, ...FEES }),
    ).rejects.toThrow(/not configured/);
    expect(rawTxs).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe('CommonsInstitutions.withdrawFromPool — happy path', () => {
  it('broadcasts withdrawContribution(bytes32) to the Base pool and POSTs /withdraw with the tx_hash', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ body: { pool_id: 'pool_1', status: 'open', message: 'ok' } }));
    const { transport, rawTxs } = makeMockTransport(8453);
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });

    const res = await institutions.withdrawFromPool(WALLET, {
      poolId: 'pool_1',
      onchainPoolId: ONCHAIN_POOL_ID,
      chain: 'base',
      transport,
      ...FEES,
    });

    // (a) one on-chain tx: withdrawContribution to the base pool with exact calldata.
    expect(rawTxs).toHaveLength(1);
    const tx = parseTransaction(rawTxs[0]);
    expect(tx.to?.toLowerCase()).toBe(POOL_ADDRESSES.base!.toLowerCase());
    expect(tx.data).toBe(encodeWithdrawContribution(ONCHAIN_POOL_ID));

    // (b) a POST to /v1/pools/:id/withdraw carrying the mined tx_hash.
    const withdrawCall = calls.find((c) => c.url.endsWith('/v1/pools/pool_1/withdraw'))!;
    expect(withdrawCall).toBeDefined();
    expect(withdrawCall.method).toBe('POST');
    expect(withdrawCall.body).toEqual({ tx_hash: keccak256(rawTxs[0]) });

    expect(res.poolId).toBe('pool_1');
    expect(res.chain).toBe('base');
    expect(res.withdrawTxHash).toBe(keccak256(rawTxs[0]));
  });

  it('defaults to base + skips the receipt wait when waitForReceipt:false', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ body: { pool_id: 'pool_2', status: 'open' } }));
    const { transport, rawTxs } = makeMockTransport(8453);
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });

    const res = await institutions.withdrawFromPool(WALLET, {
      poolId: 'pool_2',
      onchainPoolId: ONCHAIN_POOL_ID,
      waitForReceipt: false,
      transport,
      ...FEES,
    });

    expect(rawTxs).toHaveLength(1);
    expect(parseTransaction(rawTxs[0]).to?.toLowerCase()).toBe(POOL_ADDRESSES.base!.toLowerCase());
    expect(calls.some((c) => c.url.endsWith('/v1/pools/pool_2/withdraw'))).toBe(true);
    expect(res.withdrawTxHash).toBe(keccak256(rawTxs[0]));
  });
});

describe('CommonsInstitutions.withdrawFromPool — fail closed on a reverted withdrawal', () => {
  it('does NOT record with the relay when the on-chain withdrawal reverts', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ body: {} }));
    const { transport, rawTxs } = makeMockTransport(8453, '0x0'); // reverted receipt
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });

    await expect(
      institutions.withdrawFromPool(WALLET, { poolId: 'pool_1', onchainPoolId: ONCHAIN_POOL_ID, chain: 'base', transport, ...FEES }),
    ).rejects.toThrow(/reverted on-chain/);

    // The broadcast happened, but NO relay record — a reverted withdrawal moved nothing.
    expect(rawTxs).toHaveLength(1);
    expect(calls.some((c) => c.url.includes('/withdraw'))).toBe(false);
  });
});
