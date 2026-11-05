/**
 * Headless tests for the EVM-backed CommonsInstitutions flows (slices 1b + 2):
 *   - recordTransfer -> POST /transfer/record (verified PE)
 *   - postBond       -> approve + postBond + POST /v1/bonds/post
 *   - renewBond      -> renewBond + POST /v1/bonds/renew
 *
 * Relay calls go through an injected `fetch` (captured + canned); on-chain
 * broadcasts go through an injected viem transport (raw txs captured + decoded).
 * The receipt-wait between approve and postBond is exercised by the deferred
 * fork/live slice; here postBond runs with waitForApproval:false.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { custom, keccak256, parseTransaction, getAddress, type Hex } from 'viem';
import { CommonsInstitutions } from './commons-institutions';
import { encodeApprove, encodePostBond, encodeRenewBond, grossUpTotalDeposit, requiredBondWei, BOND_POOL_ADDRESSES } from './evm-bond';
import { TOKEN_ALLOWLIST } from './evm-allowlist';
import type { PETransferReport } from './evm-signer';

const TEST_PRIV_KEY = '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d';
const TEST_ADDRESS = '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1';
const WALLET = { privateKeyHex: TEST_PRIV_KEY, address: TEST_ADDRESS };
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const FEES = { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };

const BASE_CONFIG = { relayUrl: 'https://relay.test', walletId: 'wallet_aw_x', apiKey: 'pvn_live_x', apiSecret: 'pvns_x' };

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

// The bond flows now AWAIT each broadcast's receipt and inspect its status
// (audit Pass-3 #6/#20/#22/#26), so the mock answers eth_getTransactionReceipt.
// `revertedTxIndices` marks the Nth broadcast tx (0-based, in send order) as
// mined-but-REVERTED (status 0x0); everything else mines successfully.
let canonicalNonce = 0;
beforeEach(() => { canonicalNonce = 0; });

function makeMockTransport(chainId: number, opts: { revertedTxIndices?: number[] } = {}) {
  const rawTxs: Hex[] = [];
  const hashes: string[] = [];
  const reverted = new Set(opts.revertedTxIndices ?? []);
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      switch (method) {
        case 'eth_chainId': return `0x${chainId.toString(16)}`;
        case 'eth_getTransactionCount': return (params as string[])[1] === 'latest' ? `0x${canonicalNonce.toString(16)}` : '0x0';
        case 'eth_estimateGas': return '0x186a0';
        case 'eth_blockNumber': return '0x1';
        case 'eth_sendRawTransaction': {
          const raw = (params as Hex[])[0];
          canonicalNonce = Math.max(canonicalNonce, Number(parseTransaction(raw).nonce ?? 0) + 1);
          rawTxs.push(raw);
          const hash = keccak256(raw);
          hashes.push(hash);
          return hash;
        }
        case 'eth_getTransactionReceipt': {
          const hash = (params as string[])[0];
          const idx = hashes.indexOf(hash);
          return {
            transactionHash: hash,
            status: idx >= 0 && reverted.has(idx) ? '0x0' : '0x1',
            blockNumber: '0x1',
            blockHash: '0x' + '1'.repeat(64),
            transactionIndex: '0x0',
            from: TEST_ADDRESS,
            to: RECIPIENT,
            cumulativeGasUsed: '0x186a0',
            gasUsed: '0x186a0',
            contractAddress: null,
            logs: [],
            logsBloom: '0x' + '0'.repeat(512),
            type: '0x2',
            effectiveGasPrice: '0x3b9aca00',
          };
        }
        default:
          throw new Error(`mock transport: unexpected RPC method ${method}`);
      }
    },
  });
  return { transport, rawTxs };
}

describe('CommonsInstitutions.recordTransfer — verified transfer PE', () => {
  it('POSTs a transferToken report to /transfer/record and returns the verified PE', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ body: { pe_id: 'pe_abc', verified: true } }));
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    const report: PETransferReport = {
      actionType: 'agent_token_transfer',
      description: 'Agent transferred 1000000 atomic units of USDC ...',
      success: true,
      metadata: {
        tx_hash: '0x' + 'a'.repeat(64),
        chain: 'base',
        token: 'USDC',
        token_address: TOKEN_ALLOWLIST.base.USDC.address,
        recipient: getAddress(RECIPIENT),
        amount_atomic: '1000000',
        decimals: 6,
      },
    };
    const res = await institutions.recordTransfer(report);
    expect(res).toEqual({ peId: 'pe_abc', verified: true, idempotent: false });
    expect(calls[0].url).toBe('https://relay.test/v1/agent/wallet/wallet_aw_x/transfer/record');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({
      tx_hash: '0x' + 'a'.repeat(64),
      chain: 'base',
      currency: 'usdc',
      to: getAddress(RECIPIENT),
      amount_atomic: '1000000',
    });
  });

  it('maps a transferNative report to currency native + amount_wei, surfaces idempotent', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ body: { pe_id: 'pe_native', verified: false, idempotent: true } }));
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    const report: PETransferReport = {
      actionType: 'agent_native_transfer',
      description: 'Agent transferred 5 wei of native ETH ...',
      success: true,
      metadata: { tx_hash: '0x' + 'b'.repeat(64), chain: 'optimism', recipient: getAddress(RECIPIENT), amount_wei: '5' },
    };
    const res = await institutions.recordTransfer(report);
    expect(res).toEqual({ peId: 'pe_native', verified: false, idempotent: true });
    expect(calls[0].body).toMatchObject({ currency: 'native', amount_atomic: '5', chain: 'optimism' });
  });

  it('rejects a general sendTransaction report (no token / not native) at the SDK boundary', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ body: {} }));
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    const report: PETransferReport = {
      actionType: 'agent_evm_transaction',
      description: 'Agent EVM transaction ...',
      success: true,
      metadata: { tx_hash: '0x' + 'c'.repeat(64), chain: 'base', to: RECIPIENT, value_wei: '0', has_calldata: true },
    };
    await expect(institutions.recordTransfer(report)).rejects.toThrow(/transferToken \/ transferNative/);
    expect(calls).toHaveLength(0);
  });
});

describe('CommonsInstitutions.postBond — approve then postBond, two-tx sequence', () => {
  it('approves the grossed-up deposit on PVT, posts the bond, records via the relay', async () => {
    const { mockFetch, calls } = makeMockFetch((call) => {
      if (call.url.includes('/v1/bonds/requirements/')) {
        return { body: { autonomy_level: 2, base_pvt: 750, trust_discount_bps: 0, required_pvt: 750 } };
      }
      if (call.url.endsWith('/v1/bonds/post')) {
        return { status: 201, body: { bond_id: 'bond_test', status: 'active', renewal_deadline: 999 } };
      }
      return { status: 404, body: { error: 'unexpected' } };
    });
    const { transport, rawTxs } = makeMockTransport(8453);
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });

    const res = await institutions.postBond(WALLET, {
      autonomyLevel: 2,
      chain: 'base',
      transport,
      waitForApproval: false,
      nonce: 0, // required with waitForApproval:false (postBond uses nonce+1)
      ...FEES,
    });

    // Two on-chain txs, in order: approve (PVT) then postBond (BondPool).
    expect(rawTxs).toHaveLength(2);
    const expectedDeposit = grossUpTotalDeposit(requiredBondWei(750, 0));
    const pvt = TOKEN_ALLOWLIST.base.PVT.address;
    const bondPool = BOND_POOL_ADDRESSES.base!;

    const approve = parseTransaction(rawTxs[0]);
    expect(approve.to?.toLowerCase()).toBe(pvt.toLowerCase());
    expect(approve.data).toBe(encodeApprove(bondPool, expectedDeposit));

    const post = parseTransaction(rawTxs[1]);
    expect(post.to?.toLowerCase()).toBe(bondPool.toLowerCase());
    expect(post.data).toBe(encodePostBond(2, 0));

    // Relay record used the postBond tx hash.
    const postCall = calls.find((c) => c.url.endsWith('/v1/bonds/post'))!;
    expect(postCall.body).toEqual({ autonomy_level: 2, tx_hash: keccak256(rawTxs[1]), chain: 'base' });

    expect(res.bondId).toBe('bond_test');
    expect(res.postBondTxHash).toBe(keccak256(rawTxs[1]));
    expect(res.approveTxHash).toBe(keccak256(rawTxs[0]));
    expect(res.totalDepositAtomic).toBe(expectedDeposit.toString());
    expect(res.trustDiscountBps).toBe(0);
  });

  it('honors a caller-supplied trustDiscountBps in both the approve sizing and the postBond calldata', async () => {
    const { mockFetch } = makeMockFetch((call) => {
      if (call.url.includes('/v1/bonds/requirements/')) {
        return { body: { autonomy_level: 3, base_pvt: 3000, trust_discount_bps: 0, required_pvt: 3000 } };
      }
      return { status: 201, body: { bond_id: 'bond_3', status: 'active' } };
    });
    const { transport, rawTxs } = makeMockTransport(8453);
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });

    await institutions.postBond(WALLET, { autonomyLevel: 3, chain: 'base', transport, waitForApproval: false, nonce: 0, trustDiscountBps: 1500, ...FEES });

    const expectedDeposit = grossUpTotalDeposit(requiredBondWei(3000, 1500));
    expect(parseTransaction(rawTxs[0]).data).toBe(encodeApprove(BOND_POOL_ADDRESSES.base!, expectedDeposit));
    expect(parseTransaction(rawTxs[1]).data).toBe(encodePostBond(3, 1500));
  });

  it('fails closed BEFORE broadcasting on an out-of-range discount (no orphaned approval)', async () => {
    const { mockFetch } = makeMockFetch((call) =>
      call.url.includes('/requirements/') ? { body: { base_pvt: 750, trust_discount_bps: 0, required_pvt: 750 } } : { status: 201, body: { bond_id: 'x' } });
    const { transport, rawTxs } = makeMockTransport(8453);
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await expect(
      institutions.postBond(WALLET, { autonomyLevel: 2, chain: 'base', transport, waitForApproval: false, nonce: 0, trustDiscountBps: 6000, ...FEES }),
    ).rejects.toThrow(/0\.\.5000/);
    expect(rawTxs).toHaveLength(0); // nothing broadcast
  });

  it('requires an explicit nonce when waitForApproval is false (no nonce collision)', async () => {
    const { mockFetch } = makeMockFetch(() => ({ body: { base_pvt: 750, trust_discount_bps: 0, required_pvt: 750 } }));
    const { transport, rawTxs } = makeMockTransport(8453);
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await expect(
      institutions.postBond(WALLET, { autonomyLevel: 2, chain: 'base', transport, waitForApproval: false, ...FEES }),
    ).rejects.toThrow(/requires an explicit nonce/);
    expect(rawTxs).toHaveLength(0);
  });

  it('refuses bond origination on a chain without a configured BondPool (Base-only this slice)', async () => {
    const { mockFetch } = makeMockFetch(() => ({ body: { base_pvt: 750, trust_discount_bps: 0, required_pvt: 750 } }));
    const { transport } = makeMockTransport(42161);
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await expect(
      institutions.postBond(WALLET, { autonomyLevel: 2, chain: 'arbitrum', transport, waitForApproval: false, ...FEES }),
    ).rejects.toThrow(/Base only/);
  });
});

describe('CommonsInstitutions.renewBond — single tx, no approve', () => {
  it('broadcasts renewBond() to the BondPool and records via the relay', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ body: { ok: true } }));
    const { transport, rawTxs } = makeMockTransport(8453);
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });

    const res = await institutions.renewBond(WALLET, { bondId: 'bond_test', chain: 'base', transport, ...FEES });

    expect(rawTxs).toHaveLength(1); // no approve
    const tx = parseTransaction(rawTxs[0]);
    expect(tx.to?.toLowerCase()).toBe(BOND_POOL_ADDRESSES.base!.toLowerCase());
    expect(tx.data).toBe(encodeRenewBond());

    const renewCall = calls.find((c) => c.url.endsWith('/v1/bonds/renew'))!;
    expect(renewCall.body).toEqual({ bond_id: 'bond_test', tx_hash: keccak256(rawTxs[0]) });
    expect(res.renewTxHash).toBe(keccak256(rawTxs[0]));
  });
});

// ---------------------------------------------------------------------------
// Audit Pass-3 failure-path additions: #38 (recordTransfer strict reply),
// #20 (reverted approve), #22 (revoke dangling allowance), #6 (mined-but-
// unrecorded postBond resume), #26 (reverted / resumable renewBond).
// ---------------------------------------------------------------------------
describe('CommonsInstitutions.recordTransfer — strict reply (#38)', () => {
  it('throws when the relay reply omits pe_id (never returns peId "undefined" as a success)', async () => {
    const { mockFetch } = makeMockFetch(() => ({ body: { verified: true } })); // no pe_id
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    const report: PETransferReport = {
      actionType: 'agent_token_transfer',
      description: 'Agent transferred 1000000 atomic units of USDC ...',
      success: true,
      metadata: { tx_hash: '0x' + 'a'.repeat(64), chain: 'base', token: 'USDC', recipient: getAddress(RECIPIENT), amount_atomic: '1000000' },
    };
    await expect(institutions.recordTransfer(report)).rejects.toThrow(/missing pe_id/i);
  });
});

describe('CommonsInstitutions.postBond — reverted / orphaned on-chain state (#20, #22, #6)', () => {
  const requirementsBody = { base_pvt: 750, trust_discount_bps: 0, required_pvt: 750 };

  it('#20: a REVERTED approve throws BOND_APPROVE_REVERTED and never broadcasts postBond', async () => {
    const { mockFetch } = makeMockFetch((call) =>
      call.url.includes('/requirements/') ? { body: requirementsBody } : { status: 201, body: { bond_id: 'x' } });
    const { transport, rawTxs } = makeMockTransport(8453, { revertedTxIndices: [0] }); // approve reverts
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await expect(
      institutions.postBond(WALLET, { autonomyLevel: 2, chain: 'base', transport, ...FEES }),
    ).rejects.toMatchObject({ code: 'BOND_APPROVE_REVERTED' });
    expect(rawTxs).toHaveLength(1); // only the approve broadcast; postBond never fired
  });

  it('#22: a REVERTED postBond throws BOND_POST_REVERTED and revokes the dangling allowance (approve 0)', async () => {
    const { mockFetch, calls } = makeMockFetch((call) =>
      call.url.includes('/requirements/') ? { body: requirementsBody } : { status: 201, body: { bond_id: 'x' } });
    const { transport, rawTxs } = makeMockTransport(8453, { revertedTxIndices: [1] }); // postBond reverts
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await expect(
      institutions.postBond(WALLET, { autonomyLevel: 2, chain: 'base', transport, ...FEES }),
    ).rejects.toMatchObject({ code: 'BOND_POST_REVERTED' });
    // approve (0), postBond (1), revoke approve(0) (2) all broadcast.
    expect(rawTxs).toHaveLength(3);
    const pvt = TOKEN_ALLOWLIST.base.PVT.address;
    const revoke = parseTransaction(rawTxs[2]);
    expect(revoke.to?.toLowerCase()).toBe(pvt.toLowerCase());
    expect(revoke.data).toBe(encodeApprove(BOND_POOL_ADDRESSES.base!, 0n)); // allowance reset to 0
    // The relay /v1/bonds/post must NOT have been called (postBond reverted).
    expect(calls.find((c) => c.url.endsWith('/v1/bonds/post'))).toBeUndefined();
  });

  it('#6: a mined postBond whose relay record FAILS throws with a resumeFromTxHash recovery hint', async () => {
    const { mockFetch } = makeMockFetch((call) => {
      if (call.url.includes('/requirements/')) return { body: requirementsBody };
      if (call.url.endsWith('/v1/bonds/post')) return { status: 503, body: { error: 'relay unavailable' } };
      return { status: 404, body: {} };
    });
    const { transport, rawTxs } = makeMockTransport(8453);
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    let err: Error | undefined;
    try {
      await institutions.postBond(WALLET, { autonomyLevel: 2, chain: 'base', transport, waitForApproval: false, nonce: 0, ...FEES });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(rawTxs).toHaveLength(2); // approve + postBond both mined on-chain
    const postHash = keccak256(rawTxs[1]);
    expect(err!.message).toContain('resumeFromTxHash');
    expect(err!.message).toContain(postHash); // the mined hash is surfaced for re-POST
  });

  it('#6: resumeFromTxHash re-POSTs a mined bond WITHOUT re-broadcasting (recovers orphaned collateral)', async () => {
    const { mockFetch, calls } = makeMockFetch((call) => {
      if (call.url.includes('/requirements/')) return { body: requirementsBody };
      if (call.url.endsWith('/v1/bonds/post')) return { status: 201, body: { bond_id: 'bond_resumed', status: 'active', renewal_deadline: 42 } };
      return { status: 404, body: {} };
    });
    const { transport, rawTxs } = makeMockTransport(8453);
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    const resumeHash = '0x' + 'e'.repeat(64);
    const res = await institutions.postBond(WALLET, { autonomyLevel: 2, chain: 'base', transport, resumeFromTxHash: resumeHash, ...FEES });
    expect(rawTxs).toHaveLength(0); // NO on-chain broadcast on resume
    expect(res.bondId).toBe('bond_resumed');
    expect(res.postBondTxHash).toBe(resumeHash);
    const postCall = calls.find((c) => c.url.endsWith('/v1/bonds/post'))!;
    expect(postCall.body).toEqual({ autonomy_level: 2, tx_hash: resumeHash, chain: 'base' });
  });
});

describe('CommonsInstitutions.renewBond — reverted / resumable (#26)', () => {
  it('#26: a REVERTED renewBond throws BOND_RENEW_REVERTED and does not record', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ body: { ok: true } }));
    const { transport } = makeMockTransport(8453, { revertedTxIndices: [0] });
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await expect(
      institutions.renewBond(WALLET, { bondId: 'bond_test', chain: 'base', transport, ...FEES }),
    ).rejects.toMatchObject({ code: 'BOND_RENEW_REVERTED' });
    expect(calls.find((c) => c.url.endsWith('/v1/bonds/renew'))).toBeUndefined();
  });

  it('#26: resumeFromTxHash re-POSTs a mined renewal WITHOUT re-broadcasting', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ body: { ok: true } }));
    const { transport, rawTxs } = makeMockTransport(8453);
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    const resumeHash = '0x' + 'f'.repeat(64);
    const res = await institutions.renewBond(WALLET, { bondId: 'bond_test', chain: 'base', transport, resumeFromTxHash: resumeHash, ...FEES });
    expect(rawTxs).toHaveLength(0);
    expect(res.renewTxHash).toBe(resumeHash);
    const renewCall = calls.find((c) => c.url.endsWith('/v1/bonds/renew'))!;
    expect(renewCall.body).toEqual({ bond_id: 'bond_test', tx_hash: resumeHash });
  });
});
