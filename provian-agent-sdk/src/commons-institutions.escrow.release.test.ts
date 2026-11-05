/**
 * Headless tests for the WS1-SDK depositor-side escrow release flow:
 *   - CommonsInstitutions.releaseEscrow -> on-chain releaseEscrow(bytes32) + POST
 *     /v1/escrow/:id/complete (the on-chain-truthful relay record)
 *   - encodeReleaseEscrow byte-exact calldata (selector + padded arg)
 *
 * Relay calls go through an injected `fetch` (captured + canned); on-chain
 * broadcasts go through an injected viem transport (raw txs captured + decoded).
 * Mirrors agent-institutions.evmFlows.test.ts and evm-bond.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { custom, keccak256, parseTransaction, type Hex } from 'viem';
import { CommonsInstitutions } from './commons-institutions';
import { encodeReleaseEscrow, escrowAddressForChain, ESCROW_USDC_ADDRESSES } from './evm-escrow';
import { EvmSignerError } from './evm-signer';

const TEST_PRIV_KEY = '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d';
const TEST_ADDRESS = '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1';
const WALLET = { privateKeyHex: TEST_PRIV_KEY, address: TEST_ADDRESS };
const FEES = { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };

const BASE_CONFIG = { relayUrl: 'https://relay.test', walletId: 'wallet_aw_x', apiKey: 'pvn_live_x', apiSecret: 'pvns_x' };

const ONCHAIN_ESCROW_ID = ('0x' + '7'.repeat(64)) as Hex;

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

/**
 * A viem `custom` transport that answers the RPC set an EIP-1559 sendTransaction
 * + (when waitForReceipt) waitForTransactionReceipt needs, recording raw txs.
 */
function makeMockTransport(chainId: number) {
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
          // waitForTransactionReceipt polls this; return a mined receipt.
          const hash = (params as Hex[])[0];
          return {
            transactionHash: hash,
            status: '0x1',
            blockNumber: '0x1',
            blockHash: '0x' + '1'.repeat(64),
            transactionIndex: '0x0',
            from: TEST_ADDRESS,
            to: ESCROW_USDC_ADDRESSES.base,
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

describe('encodeReleaseEscrow — byte-exact calldata', () => {
  it('matches the releaseEscrow(bytes32) selector + padded arg', () => {
    const data = encodeReleaseEscrow(ONCHAIN_ESCROW_ID);
    // selector = first 4 bytes of keccak256('releaseEscrow(bytes32)')
    const expectedSelector = ethers.id('releaseEscrow(bytes32)').slice(0, 10);
    expect(data.slice(0, 10)).toBe(expectedSelector);
    // bytes32 arg is left as-is (already 32 bytes), no padding needed.
    expect(data.toLowerCase()).toBe((expectedSelector + ONCHAIN_ESCROW_ID.slice(2)).toLowerCase());
    expect(data.length).toBe(2 + 8 + 64);
  });

  it('matches the ethers oracle', () => {
    const data = encodeReleaseEscrow(ONCHAIN_ESCROW_ID);
    const iface = new ethers.Interface(['function releaseEscrow(bytes32)']);
    expect(data.toLowerCase()).toBe(iface.encodeFunctionData('releaseEscrow', [ONCHAIN_ESCROW_ID]).toLowerCase());
  });

  it('rejects a malformed bytes32', () => {
    expect(() => encodeReleaseEscrow('0xnothex')).toThrow(EvmSignerError);
    expect(() => encodeReleaseEscrow('0x' + 'a'.repeat(63))).toThrow(/bytes32/);
  });
});

describe('escrowAddressForChain', () => {
  it('returns the USDC escrow per chain', () => {
    expect(escrowAddressForChain('usdc', 'base').toLowerCase()).toBe(ESCROW_USDC_ADDRESSES.base!.toLowerCase());
    expect(escrowAddressForChain('usdc', 'arbitrum').toLowerCase()).toBe(ESCROW_USDC_ADDRESSES.arbitrum!.toLowerCase());
  });

  it('resolves PVT on Base (B15, same institution deployment escrow); still throws elsewhere', () => {
    expect(escrowAddressForChain('pvt', 'base')).toBe(escrowAddressForChain('usdc', 'base'));
    expect(() => escrowAddressForChain('pvt', 'arbitrum')).toThrow(EvmSignerError);
    expect(() => escrowAddressForChain('pvt', 'optimism')).toThrow(/not configured/);
  });
});

describe('CommonsInstitutions.releaseEscrow — SDK boundary validation (no network)', () => {
  it('rejects an empty escrowId before any broadcast', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ body: {} }));
    const { transport, rawTxs } = makeMockTransport(8453);
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await expect(
      institutions.releaseEscrow(WALLET, { escrowId: '', onchainEscrowId: ONCHAIN_ESCROW_ID, transport, ...FEES }),
    ).rejects.toThrow(/escrowId is required/);
    expect(rawTxs).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('rejects a malformed onchainEscrowId before any broadcast', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ body: {} }));
    const { transport, rawTxs } = makeMockTransport(8453);
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await expect(
      institutions.releaseEscrow(WALLET, { escrowId: 'esc_1', onchainEscrowId: '0xdeadbeef', transport, ...FEES }),
    ).rejects.toThrow(/onchainEscrowId must be a 0x-prefixed 32-byte/);
    expect(rawTxs).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('B15 : currency:"pvt" on BASE releases against the institution deployment escrow; other chains still refuse before broadcast', async () => {
    const { mockFetch } = makeMockFetch(() => ({ body: {} }));
    const { transport, rawTxs } = makeMockTransport(8453);
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    const result = await institutions.releaseEscrow(WALLET, {
      escrowId: 'esc_1',
      onchainEscrowId: ONCHAIN_ESCROW_ID,
      currency: 'pvt',
      chain: 'base',
      transport,
      ...FEES,
    });
    expect(result.escrowId).toBe('esc_1');
    expect(rawTxs).toHaveLength(1);

    // Fail-closed leg preserved: PVT principal is Base-only.
    const { transport: t2, rawTxs: raw2 } = makeMockTransport(42161);
    await expect(
      institutions.releaseEscrow(WALLET, {
        escrowId: 'esc_2',
        onchainEscrowId: ONCHAIN_ESCROW_ID,
        currency: 'pvt',
        chain: 'arbitrum',
        transport: t2,
        ...FEES,
      }),
    ).rejects.toThrow(/not configured/);
    expect(raw2).toHaveLength(0);
  });
});

describe('CommonsInstitutions.releaseEscrow — happy path', () => {
  it('broadcasts releaseEscrow(bytes32) to the base USDC escrow and POSTs /complete', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ body: { escrow_id: 'esc_1', status: 'completed', completed_at: 't' } }));
    const { transport, rawTxs } = makeMockTransport(8453);
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });

    const res = await institutions.releaseEscrow(WALLET, {
      escrowId: 'esc_1',
      onchainEscrowId: ONCHAIN_ESCROW_ID,
      chain: 'base',
      currency: 'usdc',
      transport,
      ...FEES,
    });

    // (a) one on-chain tx: releaseEscrow to the base USDC escrow with exact calldata.
    expect(rawTxs).toHaveLength(1);
    const tx = parseTransaction(rawTxs[0]);
    expect(tx.to?.toLowerCase()).toBe(ESCROW_USDC_ADDRESSES.base!.toLowerCase());
    expect(tx.data).toBe(encodeReleaseEscrow(ONCHAIN_ESCROW_ID));

    // (b) a POST to /v1/escrow/:id/complete (empty body).
    const completeCall = calls.find((c) => c.url.endsWith('/v1/escrow/esc_1/complete'))!;
    expect(completeCall).toBeDefined();
    expect(completeCall.method).toBe('POST');
    expect(completeCall.body).toEqual({});

    expect(res.escrowId).toBe('esc_1');
    expect(res.chain).toBe('base');
    expect(res.releaseTxHash).toBe(keccak256(rawTxs[0]));
  });

  it('defaults to base + usdc when chain/currency omitted, skips receipt wait when waitForReceipt:false', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ body: { escrow_id: 'esc_2', status: 'completed' } }));
    const { transport, rawTxs } = makeMockTransport(8453);
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });

    const res = await institutions.releaseEscrow(WALLET, {
      escrowId: 'esc_2',
      onchainEscrowId: ONCHAIN_ESCROW_ID,
      waitForReceipt: false,
      transport,
      ...FEES,
    });

    expect(rawTxs).toHaveLength(1);
    expect(parseTransaction(rawTxs[0]).to?.toLowerCase()).toBe(ESCROW_USDC_ADDRESSES.base!.toLowerCase());
    expect(calls.some((c) => c.url.endsWith('/v1/escrow/esc_2/complete'))).toBe(true);
    expect(res.releaseTxHash).toBe(keccak256(rawTxs[0]));
  });
});
