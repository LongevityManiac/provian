import {openTestPrivateRequest} from './private-request.test-support';
/**
 * every step of a Commons hire, agent side (SDK): post in any direction and
 * currency, browse / read the board and the Market, fund (createEscrow → approve →
 * fundEscrow → POST /fund, PVT or USDC), release, dispute, settle, claim the 30-day
 * refund, and vouch.
 *
 * Relay calls go through an injected `fetch` (captured + canned); on-chain broadcasts go
 * through an injected viem transport (raw txs captured and DECODED, so each test asserts
 * the exact contract, function and arguments the agent signed).
 *
 * Every money-moving helper carries at least one RED negative control that proves the
 * guard refuses BEFORE any broadcast. Each control names the mutation that reddens it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { custom, decodeFunctionData, encodeFunctionResult, keccak256, parseAbi, parseTransaction, type Hex } from 'viem';
import {
  CommonsInstitutions,
  ProvianNetworkError,
  ProvianValidationError,
  ProvianVouchRefusedError,
  COMMONS_RELAY_CODES,
  type CommonsJobEscrow,
} from './commons-institutions';
import { ProvianError } from './errors';
import { escrowAddressForChain, usdcToAtomic, ESCROW_CURRENCY_ENUM, deriveHireOnchainEscrowId } from './evm-escrow';
import { getToken } from './evm-allowlist';

const TEST_PRIV_KEY = '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d';
const TEST_ADDRESS = '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1';
const WALLET = { privateKeyHex: TEST_PRIV_KEY, address: TEST_ADDRESS };
const OTHER_ADDRESS = '0x1111111111111111111111111111111111111111';
const RECIPIENT = '0x2222222222222222222222222222222222222222';
const FEES = { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
const FAST = { confirmations: 1, recordRetryDelayMs: 0 };

const BASE_CONFIG = { relayUrl: 'https://relay.test', walletId: 'wallet_aw_poster', apiKey: 'pvn_live_x', apiSecret: 'pvns_x' };
const ESCROW = escrowAddressForChain('pvt', 'base');
const PVT = getToken('base', 'PVT').address;
const USDC = getToken('base', 'USDC').address;
const ONCHAIN_ID = ('0x' + '7'.repeat(64)) as Hex;
const FUND_HASH_RE = /^0x[0-9a-f]{64}$/;

const ESCROW_ABI = parseAbi([
  'function createEscrow(bytes32 escrowId, address recipient, uint256 amount, uint256 autoReleaseAt, uint8 currencyType)',
  'function fundEscrow(bytes32 escrowId, bool payFeeInPVT)',
  'function releaseEscrow(bytes32 escrowId)',
  'function disputeEscrow(bytes32 escrowId)',
  'function claimDisputeTimeout(bytes32 escrowId)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function escrows(bytes32) view returns (address depositor, address recipient, uint256 amount, uint256 fee, uint256 autoReleaseAt, uint8 status, uint8 currency, bool feePaidInPVT)',
]);

interface FetchCall { url: string; method?: string; body: unknown }
type Responder = (call: FetchCall) => { status?: number; body: unknown };
function makeMockFetch(responder: Responder) {
  const calls: FetchCall[] = [];
  const mockFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let parsed: unknown;
    if (typeof init?.body === 'string') {
      try { parsed = openTestPrivateRequest(JSON.parse(init.body),String(url),init.headers); } catch { parsed = init.body; }
    }
    const call: FetchCall = { url: String(url), method: init?.method, body: parsed };
    calls.push(call);
    const { status = 200, body } = responder(call);
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  };
  return { mockFetch: mockFetch as unknown as typeof fetch, calls };
}

/**
 * A viem transport that mines every tx; `revertFn` names a function whose receipt reverts;
 * `estimateFails` refuses that many gas estimates of `estimateFailFn` (a lagging RPC node that
 * has not seen the approve); `onchainEscrow` is what `escrows(bytes32)` reads.
 */
type OnchainStruct = readonly [`0x${string}`, `0x${string}`, bigint, bigint, bigint, number, number, boolean];
const ZERO = '0x0000000000000000000000000000000000000000' as const;
const ZERO_STRUCT: OnchainStruct = [ZERO, ZERO, 0n, 0n, 0n, 0, 0, false];
/** The on-chain struct matching a relay escrow (PVT), with overrides. */
function hireStruct(escrow: CommonsJobEscrow, over: { depositor?: `0x${string}`; recipient?: `0x${string}`; amount?: bigint; status?: number }): OnchainStruct {
  return [over.depositor ?? (TEST_ADDRESS as `0x${string}`), over.recipient ?? (RECIPIENT as `0x${string}`), over.amount ?? 5_000_000_000_000_000_000n,
    0n, BigInt(Math.floor(escrow.auto_release_at / 1000)), over.status ?? 0, ESCROW_CURRENCY_ENUM.pvt, false];
}
let canonicalNonce = 0;
beforeEach(() => { canonicalNonce = 0; });

function makeMockTransport(opts: { revertFn?: string; estimateFailFn?: string; estimateFails?: number; onchainEscrow?: OnchainStruct; acceptThenErrorFn?: string; receiptErrorFn?: string } = {}) {
  const sent: { to: string; fn: string; args: readonly unknown[]; hash: Hex }[] = [];
  const byHash = new Map<string, string>();
  let estimateFailsLeft = opts.estimateFails ?? 0;
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      switch (method) {
        case 'eth_chainId': return '0x2105';
        case 'eth_getTransactionCount': {
          return (params as string[])[1] === 'latest' ? `0x${canonicalNonce.toString(16)}` : '0x0';
        }
        case 'eth_estimateGas': {
          const req = (params as { data?: Hex }[])[0];
          const fn = req?.data ? decodeFunctionData({ abi: ESCROW_ABI, data: req.data }).functionName : '';
          if (fn === opts.estimateFailFn && estimateFailsLeft > 0) {
            estimateFailsLeft -= 1;
            throw new Error('execution reverted: ERC20: insufficient allowance');
          }
          return '0x186a0';
        }
        case 'eth_call': {
          // Default: no escrow at the id (the zero struct), so a fresh fund creates one.
          return encodeFunctionResult({ abi: ESCROW_ABI, functionName: 'escrows', result: opts.onchainEscrow ?? ZERO_STRUCT });
        }
        case 'eth_sendRawTransaction': {
          const raw = (params as Hex[])[0];
          canonicalNonce = Math.max(canonicalNonce, Number(parseTransaction(raw).nonce ?? 0) + 1);
          const tx = parseTransaction(raw);
          const decoded = decodeFunctionData({ abi: ESCROW_ABI, data: tx.data as Hex });
          const hash = keccak256(raw);
          sent.push({ to: String(tx.to), fn: decoded.functionName, args: decoded.args ?? [], hash });
          byHash.set(hash, decoded.functionName);
          // The node ACCEPTED the tx, then the call errors (timeout / 5xx): broadcast state unknown to the caller.
          if (decoded.functionName === opts.acceptThenErrorFn) throw new Error('request timed out');
          return hash;
        }
        case 'eth_getTransactionReceipt': {
          const hash = (params as Hex[])[0];
          if (opts.receiptErrorFn !== undefined && byHash.get(hash) === opts.receiptErrorFn) throw new Error('HTTP 503 Service Unavailable');
          const reverted = opts.revertFn !== undefined && byHash.get(hash) === opts.revertFn;
          return {
            transactionHash: hash, status: reverted ? '0x0' : '0x1', blockNumber: '0x1',
            blockHash: '0x' + '1'.repeat(64), transactionIndex: '0x0', from: TEST_ADDRESS, to: ESCROW,
            cumulativeGasUsed: '0x186a0', gasUsed: '0x186a0', contractAddress: null, logs: [],
            logsBloom: '0x' + '0'.repeat(512), type: '0x2', effectiveGasPrice: '0x3b9aca00',
          };
        }
        case 'eth_getBlockByNumber': return { number: '0x1', hash: '0x' + '1'.repeat(64), parentHash: '0x' + '0'.repeat(64),
          nonce: '0x0000000000000000', timestamp: '0x64', gasLimit: '0x1000000', gasUsed: '0x0', difficulty: '0x0',
          miner: ESCROW, extraData: '0x', transactions: [], baseFeePerGas: '0x1' };
        case 'eth_blockNumber': return '0x1';
        default:
          throw new Error(`mock transport: unexpected RPC method ${method}`);
      }
    },
  }, { retryCount: 0 }); // viem's own transport retry would mask the SDK's fundEscrow retry
  return { transport, sent };
}

function escrowDetails(over: Partial<CommonsJobEscrow> = {}): CommonsJobEscrow {
  return {
    escrow_id: 'esc_1',
    currency: 'pvt',
    contract_address: ESCROW,
    amount_pvt: '5000000000000000000',
    status: 'created',
    chain: 'base',
    depositor_address: TEST_ADDRESS.toLowerCase(),
    recipient_address: RECIPIENT,
    auto_release_at: Date.now() + 7 * 86_400_000,
    token_address: PVT.toLowerCase(),
    onchain_escrow_id: null,
    disputed_at: null,
    resolution: null,
    ...over,
  };
}

function usdcEscrow(over: Partial<CommonsJobEscrow> = {}): CommonsJobEscrow {
  const base = escrowDetails({ currency: 'usdc', token_address: USDC, amount_usdc: 12.5, ...over });
  delete base.amount_pvt;
  if (over.amount_pvt !== undefined) base.amount_pvt = over.amount_pvt;
  return base;
}

/** A relay that serves GET /escrow from `escrow` and answers everything else with `rest`. */
function relayWith(escrow: CommonsJobEscrow, rest: Responder = () => ({ body: { ok: true } })): Responder {
  return (call) => (call.url.endsWith('/escrow') && call.method === 'GET' ? { body: escrow } : rest(call));
}

// ---------------------------------------------------------------------------
// Post / browse / Market
// ---------------------------------------------------------------------------

const POST_BASE = {
  title: 'Summarise three papers',
  description: 'Read and summarise three papers on provenance.',
  category: 'other' as const,
  skills_required: ['research'],
  location: { type: 'remote' as const },
  compensation_type: 'fixed' as const,
  requires_identity_verification: false,
  requires_pe_history: false,
  deadline_hours: 72,
};

describe('postHumanJob — four directions, PVT or USDC', () => {
  it('posts an agent→agent USDC job with seeking + currency + budget_usdc only', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ status: 201, body: { job_id: 'hjob_1' } }));
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await institutions.postHumanJob({ ...POST_BASE, seeking: 'agent', currency: 'usdc', budget_usdc: 12.5 });
    expect(calls[0].url).toBe('https://relay.test/v1/commons/jobs/post');
    const body = calls[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ seeking: 'agent', currency: 'usdc', budget_usdc: 12.5 });
    expect(body.budget_pvt).toBeUndefined();
  });

  it('posts a PVT job with the currency named explicitly', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ status: 201, body: { job_id: 'hjob_2' } }));
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await institutions.postHumanJob({ ...POST_BASE, seeking: 'human', budget_pvt: '1000000000000000000' });
    expect(calls[0].body).toMatchObject({ seeking: 'human', currency: 'pvt', budget_pvt: '1000000000000000000' });
  });

  it('refuses a USDC budget the relay would refuse (> 10000, > 6 decimals, ≤ 0) before the network', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ body: {} }));
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await expect(institutions.postHumanJob({ ...POST_BASE, currency: 'usdc', budget_usdc: 10_000.01 })).rejects.toThrow(/at most 10000/);
    await expect(institutions.postHumanJob({ ...POST_BASE, currency: 'usdc', budget_usdc: 1.0000001 })).rejects.toThrow(/6 decimal/);
    await expect(institutions.postHumanJob({ ...POST_BASE, currency: 'usdc', budget_usdc: 0 })).rejects.toThrow(ProvianValidationError);
    await expect(institutions.postHumanJob({ ...POST_BASE, deadline_hours: 673, budget_pvt: '1' })).rejects.toThrow(/672/);
    expect(calls).toHaveLength(0);
  });

  it('refuses a mixed-currency body (budget_pvt on a USDC job) — the relay would read the wrong one', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ body: {} }));
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    const mixed = { ...POST_BASE, currency: 'usdc', budget_usdc: 5, budget_pvt: '1' } as unknown as Parameters<CommonsInstitutions['postHumanJob']>[0];
    await expect(institutions.postHumanJob(mixed)).rejects.toThrow(/budget_usdc only/);
    expect(calls).toHaveLength(0);
  });
});

describe('board + Market reads', () => {
  it('browseCommonsJobs encodes seeking / posted_by / currency / direction', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ body: { jobs: [{ job_id: 'hjob_1' }], total: 1, featured: [] } }));
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    const page = await institutions.browseCommonsJobs({ seeking: 'agent', posted_by: 'human', currency: 'usdc', direction: 'human_seeking_agent', page_size: 10 });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/v1/commons/jobs');
    expect(Object.fromEntries(url.searchParams)).toEqual({ seeking: 'agent', posted_by: 'human', currency: 'usdc', direction: 'human_seeking_agent', page_size: '10' });
    expect(page.total).toBe(1);
    expect(page.featured).toEqual([]);
  });

  it('marketJobs / marketStats / getCommonsJob / listCommonsJobApplications / getCommonsJobEscrow hit their routes', async () => {
    const { mockFetch, calls } = makeMockFetch((c) => ({ body: c.url.includes('/applications') ? { applications: [{ application_id: 'a' }] } : { jobs: [], total: 0, featured: [] } }));
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await institutions.marketJobs({ seeking: 'all', currency: 'pvt' });
    await institutions.marketStats();
    await institutions.getCommonsJob('hjob_1');
    const apps = await institutions.listCommonsJobApplications('hjob_1');
    await institutions.getCommonsJobEscrow('hjob_1');
    expect(calls.map((c) => c.url)).toEqual([
      'https://relay.test/v1/commons/market/jobs?seeking=all&currency=pvt',
      'https://relay.test/v1/commons/market/stats',
      'https://relay.test/v1/commons/jobs/hjob_1',
      'https://relay.test/v1/commons/jobs/hjob_1/applications',
      'https://relay.test/v1/commons/jobs/hjob_1/escrow',
    ]);
    expect(apps).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// FUND
// ---------------------------------------------------------------------------

describe('fundCommonsJob — createEscrow → approve → fundEscrow → POST /fund', () => {
  it('PVT: signs the three legs against the pinned escrow + PVT token with currency enum 1, then records the fund tx', async () => {
    const escrow = escrowDetails();
    const { mockFetch, calls } = makeMockFetch(relayWith(escrow, () => ({ body: { status: 'funded', escrow_id: 'esc_1' } })));
    const { transport, sent } = makeMockTransport();
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    const out = await institutions.fundCommonsJob('hjob_1', WALLET, { transport, ...FEES, ...FAST, onchainEscrowId: ONCHAIN_ID });

    expect(sent.map((t) => t.fn)).toEqual(['createEscrow', 'approve', 'fundEscrow']);
    expect(sent[0].to.toLowerCase()).toBe(ESCROW.toLowerCase());
    expect(sent[0].args).toEqual([ONCHAIN_ID, RECIPIENT, 5_000_000_000_000_000_000n, BigInt(Math.floor(escrow.auto_release_at / 1000)), ESCROW_CURRENCY_ENUM.pvt]);
    expect(sent[1].to.toLowerCase()).toBe(PVT.toLowerCase());
    expect((sent[1].args[0] as string).toLowerCase()).toBe(ESCROW.toLowerCase());
    expect(sent[1].args[1]).toBe(5_000_000_000_000_000_000n);
    expect(sent[2].args).toEqual([ONCHAIN_ID, false]);
    const fund = calls.find((c) => c.url.endsWith('/fund'))!;
    expect(fund.body).toEqual({ tx_hash: sent[2].hash });
    expect(out.fundTxHash).toMatch(FUND_HASH_RE);
    expect(out.currency).toBe('pvt');
  });

  it('USDC: approves the USDC token for exactly usdcToAtomic(amount_usdc) with currency enum 0', async () => {
    const { mockFetch } = makeMockFetch(relayWith(usdcEscrow(), () => ({ body: { status: 'funded' } })));
    const { transport, sent } = makeMockTransport();
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    const out = await institutions.fundCommonsJob('hjob_1', WALLET, { transport, ...FEES, ...FAST, expectedCurrency: 'usdc', expectedAmountAtomic: '12500000' });
    expect(sent[0].args[2]).toBe(12_500_000n);
    expect(sent[0].args[4]).toBe(ESCROW_CURRENCY_ENUM.usdc);
    expect(sent[1].to.toLowerCase()).toBe(USDC.toLowerCase());
    expect(sent[1].args[1]).toBe(12_500_000n);
    expect(out.amountAtomic).toBe('12500000');
    expect(usdcToAtomic(12.5)).toBe(12_500_000n);
  });

  it('re-tries the relay record while it reports insufficient_confirmations, then succeeds', async () => {
    let fundCalls = 0;
    const { mockFetch } = makeMockFetch(relayWith(escrowDetails(), () => {
      fundCalls += 1;
      return fundCalls < 3
        ? { status: 400, body: { error: 'On-chain funding verification failed: insufficient_confirmations: 3/12' } }
        : { body: { status: 'funded' } };
    }));
    const { transport } = makeMockTransport();
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await institutions.fundCommonsJob('hjob_1', WALLET, { transport, ...FEES, ...FAST });
    expect(fundCalls).toBe(3);
  });

  it('a final relay refusal (wrong amount) is NOT retried', async () => {
    let fundCalls = 0;
    const { mockFetch } = makeMockFetch(relayWith(escrowDetails(), () => {
      fundCalls += 1;
      return { status: 400, body: { error: 'On-chain funding verification failed: amount_mismatch' } };
    }));
    const { transport } = makeMockTransport();
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await expect(institutions.fundCommonsJob('hjob_1', WALLET, { transport, ...FEES, ...FAST })).rejects.toThrow(/amount_mismatch/);
    expect(fundCalls).toBe(1);
  });

  it('resumeFromTxHash re-records without broadcasting', async () => {
    const { mockFetch, calls } = makeMockFetch(relayWith(escrowDetails({ status: 'funded' }), () => ({ body: { status: 'funded' } })));
    const { transport, sent } = makeMockTransport();
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    const hash = '0x' + 'e'.repeat(64);
    await institutions.fundCommonsJob('hjob_1', WALLET, { transport, ...FAST, resumeFromTxHash: hash });
    expect(sent).toHaveLength(0);
    expect(calls.find((c) => c.url.endsWith('/fund'))!.body).toEqual({ tx_hash: hash });
  });

  it('2026-09-23 lagging-RPC stop: a refused fundEscrow estimate is re-tried and the hire funds (ONE fundEscrow broadcast)', async () => {
    const { mockFetch, calls } = makeMockFetch(relayWith(escrowDetails(), () => ({ body: { status: 'funded' } })));
    const { transport, sent } = makeMockTransport({ estimateFailFn: 'fundEscrow', estimateFails: 2 });
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    const out = await institutions.fundCommonsJob('hjob_1', WALLET, { transport, ...FEES, ...FAST, fundRetryDelayMs: 0, onchainEscrowId: ONCHAIN_ID });
    expect(sent.map((t) => t.fn)).toEqual(['createEscrow', 'approve', 'fundEscrow']);
    expect(calls.find((c) => c.url.endsWith('/fund'))!.body).toEqual({ tx_hash: sent[2].hash });
    expect(out.fundTxHash).toBe(sent[2].hash);
  });

  it('RED: with one attempt the same lag stops — ESCROW_FUND_INCOMPLETE naming the on-chain id and saying a re-run is safe', async () => {
    const { mockFetch, calls } = makeMockFetch(relayWith(escrowDetails()));
    const { transport, sent } = makeMockTransport({ estimateFailFn: 'fundEscrow', estimateFails: 2 });
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    const err = await institutions.fundCommonsJob('hjob_1', WALLET, { transport, ...FEES, ...FAST, fundAttempts: 1 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'ESCROW_FUND_INCOMPLETE' });
    expect((err as Error).message).toContain(deriveHireOnchainEscrowId(TEST_ADDRESS, 'esc_1'));
    expect((err as Error).message).toContain('can never create a second escrow');
    expect(sent.map((t) => t.fn)).toEqual(['createEscrow', 'approve']);
    expect(calls.some((c) => c.url.endsWith('/fund'))).toBe(false);
  });

  it('round-4 defect: after an EXPLICIT id the stop message re-runs with THAT id, never a plain re-run (which targets the derived escrow)', async () => {
    // Explicit (legacy random) id: the instruction must carry it and warn against a plain re-run.
    {
      const { mockFetch } = makeMockFetch(relayWith(escrowDetails()));
      const { transport } = makeMockTransport({ estimateFailFn: 'fundEscrow', estimateFails: 1 });
      const err = await new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch })
        .fundCommonsJob('hjob_1', WALLET, { transport, ...FEES, ...FAST, fundAttempts: 1, onchainEscrowId: ONCHAIN_ID }).catch((e: unknown) => e);
      const msg = (err as Error).message;
      expect(msg).toContain(`{ onchainEscrowId: '${ONCHAIN_ID}' }`);
      expect(msg).toContain(`--resume-escrow ${ONCHAIN_ID}`);
      expect(msg).toContain('Do NOT re-run without that id');
      expect(msg).not.toContain('can never create a second escrow');
    }
    // Default (derived) id: a plain re-run IS the safe instruction.
    {
      const { mockFetch } = makeMockFetch(relayWith(escrowDetails()));
      const { transport } = makeMockTransport({ estimateFailFn: 'fundEscrow', estimateFails: 1 });
      const err = await new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch })
        .fundCommonsJob('hjob_1', WALLET, { transport, ...FEES, ...FAST, fundAttempts: 1 }).catch((e: unknown) => e);
      const msg = (err as Error).message;
      expect(msg).toContain(`Re-run fundCommonsJob("hjob_1", wallet) once`);
      expect(msg).toContain(deriveHireOnchainEscrowId(TEST_ADDRESS, 'esc_1'));
      expect(msg).not.toContain('onchainEscrowId:');
    }
  });

  it('round-5 defect: ESCROW_CANCELLED on an EXPLICIT (legacy) id points at the derived escrow via a plain re-run; on the derived id, at a fresh id', async () => {
    const escrow = escrowDetails();
    {
      const { mockFetch } = makeMockFetch(relayWith(escrow));
      const { transport, sent } = makeMockTransport({ onchainEscrow: hireStruct(escrow, { status: 5 }) });
      const err = await new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch })
        .fundCommonsJob('hjob_1', WALLET, { transport, ...FEES, ...FAST, onchainEscrowId: ONCHAIN_ID }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'ESCROW_CANCELLED' });
      expect((err as Error).message).toContain('re-run WITHOUT an id');
      expect((err as Error).message).toContain(deriveHireOnchainEscrowId(TEST_ADDRESS, 'esc_1'));
      expect((err as Error).message).not.toContain('pass a fresh');
      expect(sent).toHaveLength(0);
    }
    {
      const { mockFetch } = makeMockFetch(relayWith(escrow));
      const { transport } = makeMockTransport({ onchainEscrow: hireStruct(escrow, { status: 5 }) });
      const err = await new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch })
        .fundCommonsJob('hjob_1', WALLET, { transport, ...FEES, ...FAST }).catch((e: unknown) => e);
      expect((err as Error).message).toContain('pass a fresh { onchainEscrowId }');
      expect((err as Error).message).not.toContain('re-run WITHOUT an id');
    }
  });

  it('ONE HIRE → ONE ON-CHAIN ESCROW ID: the default id is derived from (depositor, relay escrow id), identical on every run', async () => {
    const ids: unknown[] = [];
    for (let run = 0; run < 2; run++) {
      const { mockFetch } = makeMockFetch(relayWith(escrowDetails(), () => ({ body: { status: 'funded' } })));
      const { transport, sent } = makeMockTransport();
      await new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch }).fundCommonsJob('hjob_1', WALLET, { transport, ...FEES, ...FAST });
      ids.push(sent[0].args[0]);
    }
    // RED control: a random default id (the pre-fix behaviour) makes the two runs differ.
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toBe(deriveHireOnchainEscrowId(TEST_ADDRESS, 'esc_1'));
    expect(deriveHireOnchainEscrowId(TEST_ADDRESS, 'esc_2')).not.toBe(ids[0]);
    expect(deriveHireOnchainEscrowId(OTHER_ADDRESS, 'esc_1')).not.toBe(ids[0]);
  });

  it('an accepted send with a lost reply recovers its mined receipt without sending another fund transaction', async () => {
    const { mockFetch, calls } = makeMockFetch(relayWith(escrowDetails()));
    const { transport, sent } = makeMockTransport({ acceptThenErrorFn: 'fundEscrow' });
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    const err = await institutions.fundCommonsJob('hjob_1', WALLET, { transport, ...FEES, ...FAST, fundRetryDelayMs: 0 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ fundTxHash: sent[2].hash });
    expect(sent.map((t) => t.fn)).toEqual(['createEscrow', 'approve', 'fundEscrow']);
    expect(calls.some((c) => c.url.endsWith('/fund'))).toBe(true);
  });

  it('a failed receipt wait on a BROADCAST fundEscrow names its tx hash for resumeFromTxHash (never a bare RPC error)', async () => {
    const { mockFetch } = makeMockFetch(relayWith(escrowDetails()));
    const { transport, sent } = makeMockTransport({ receiptErrorFn: 'fundEscrow' });
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    const err = await institutions.fundCommonsJob('hjob_1', WALLET, { transport, ...FEES, ...FAST, onchainEscrowId: ONCHAIN_ID }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'ESCROW_FUND_UNCONFIRMED' });
    expect((err as Error).message).toContain(`resumeFromTxHash: '${sent[2].hash}'`);
  }, 30_000); // viem rejects on the next block poll after the failed receipt read

  it('a re-run on an on-chain escrow already Created for this hire skips createEscrow: approve → fundEscrow → record', async () => {
    const escrow = escrowDetails();
    const { mockFetch, calls } = makeMockFetch(relayWith(escrow, () => ({ body: { status: 'funded' } })));
    const { transport, sent } = makeMockTransport({ onchainEscrow: hireStruct(escrow, {}) });
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    const out = await institutions.fundCommonsJob('hjob_1', WALLET, { transport, ...FEES, ...FAST });
    expect(sent.map((t) => t.fn)).toEqual(['approve', 'fundEscrow']);
    expect(sent[1].args).toEqual([deriveHireOnchainEscrowId(TEST_ADDRESS, 'esc_1'), false]);
    expect(out.createTxHash).toBeNull();
    expect(calls.find((c) => c.url.endsWith('/fund'))!.body).toEqual({ tx_hash: sent[1].hash });
  });

  it('RED: an existing on-chain escrow that is NOT this hire, already funded, or cancelled — nothing is sent', async () => {
    const escrow = escrowDetails();
    const variants: [string, OnchainStruct, string][] = [
      ['recipient', hireStruct(escrow, { recipient: OTHER_ADDRESS as `0x${string}` }), 'ESCROW_ID_CONFLICT'],
      ['amount', hireStruct(escrow, { amount: 1n }), 'ESCROW_ID_CONFLICT'],
      ['depositor', hireStruct(escrow, { depositor: OTHER_ADDRESS as `0x${string}` }), 'ESCROW_ID_CONFLICT'],
      ['funded', hireStruct(escrow, { status: 1 }), 'ESCROW_ALREADY_FUNDED'],
      ['cancelled', hireStruct(escrow, { status: 5 }), 'ESCROW_CANCELLED'],
    ];
    for (const [label, struct, code] of variants) {
      const { mockFetch, calls } = makeMockFetch(relayWith(escrow));
      const { transport, sent } = makeMockTransport({ onchainEscrow: struct });
      const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
      await expect(institutions.fundCommonsJob('hjob_1', WALLET, { transport, ...FEES, ...FAST }), label).rejects.toMatchObject({ code });
      expect(sent, label).toHaveLength(0);
      expect(calls.some((c) => c.url.endsWith('/fund'))).toBe(false);
    }
  });

  it('a reverted fundEscrow revokes the standing allowance and never records', async () => {
    const { mockFetch, calls } = makeMockFetch(relayWith(escrowDetails()));
    const { transport, sent } = makeMockTransport({ revertFn: 'fundEscrow' });
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await expect(institutions.fundCommonsJob('hjob_1', WALLET, { transport, ...FEES, ...FAST })).rejects.toMatchObject({ code: 'ESCROW_FUND_REVERTED' });
    expect(sent.map((t) => t.fn)).toEqual(['createEscrow', 'approve', 'fundEscrow', 'approve']);
    expect(sent[3].args[1]).toBe(0n);
    expect(calls.some((c) => c.url.endsWith('/fund'))).toBe(false);
  });

  // ---- RED negative controls (each refuses BEFORE any broadcast) ----

  // Mutation that reddens it: drop the "a USDC escrow must not carry amount_pvt" check in
  // planCommonsJobFunding — the SDK would then approve/escrow USDC for an escrow whose
  // amount field is the PVT one (a currency/amount mismatch).
  it('RED: refuses a currency/amount mismatch (USDC escrow carrying amount_pvt)', async () => {
    const bad = usdcEscrow({ amount_pvt: '5000000000000000000' });
    const { mockFetch, calls } = makeMockFetch(relayWith(bad));
    const { transport, sent } = makeMockTransport();
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await expect(institutions.fundCommonsJob('hjob_1', WALLET, { transport, ...FEES, ...FAST })).rejects.toThrow(/currency\/amount mismatch/);
    expect(sent).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  // Mutation that reddens it: compare token_address against the PVT pin regardless of
  // currency (or skip the token pin) — a USDC escrow naming the PVT token would then be approved.
  it('RED: refuses a token the SDK does not pin for the currency (USDC escrow naming the PVT token)', async () => {
    const { mockFetch } = makeMockFetch(relayWith(usdcEscrow({ token_address: PVT })));
    const { transport, sent } = makeMockTransport();
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await expect(institutions.fundCommonsJob('hjob_1', WALLET, { transport, ...FEES, ...FAST })).rejects.toThrow(/refusing to approve/);
    expect(sent).toHaveLength(0);
  });

  // Mutation that reddens it: sign for `escrow.contract_address` instead of the SDK pin
  // (pinnedCommonsEscrow's comparison removed) — funds would go to a relay-named contract.
  it('RED: refuses an escrow contract the SDK does not pin', async () => {
    const { mockFetch } = makeMockFetch(relayWith(escrowDetails({ contract_address: OTHER_ADDRESS })));
    const { transport, sent } = makeMockTransport();
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await expect(institutions.fundCommonsJob('hjob_1', WALLET, { transport, ...FEES, ...FAST })).rejects.toThrow(/refusing to sign/);
    expect(sent).toHaveLength(0);
  });

  // Mutation that reddens it: delete the depositor check in planCommonsJobFunding — a
  // non-depositor would escrow funds the relay can never verify (expectedFrom = depositor).
  it('RED: refuses when this wallet is not the escrow depositor', async () => {
    const { mockFetch } = makeMockFetch(relayWith(escrowDetails({ depositor_address: OTHER_ADDRESS })));
    const { transport, sent } = makeMockTransport();
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await expect(institutions.fundCommonsJob('hjob_1', WALLET, { transport, ...FEES, ...FAST })).rejects.toThrow(/not the escrow depositor/);
    expect(sent).toHaveLength(0);
  });

  // Mutation that reddens it: ignore params.expectedAmountAtomic — a relay-inflated amount
  // would be escrowed although the caller priced the hire differently.
  it('RED: refuses when the escrow amount is not the caller-expected amount', async () => {
    const { mockFetch } = makeMockFetch(relayWith(escrowDetails()));
    const { transport, sent } = makeMockTransport();
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await expect(institutions.fundCommonsJob('hjob_1', WALLET, { transport, ...FEES, ...FAST, expectedAmountAtomic: 1n })).rejects.toThrow(/not the expected/);
    await expect(institutions.fundCommonsJob('hjob_1', WALLET, { transport, ...FEES, ...FAST, expectedCurrency: 'usdc' })).rejects.toThrow(/not the expected usdc/);
    expect(sent).toHaveLength(0);
  });

  it('refuses an already-funded escrow (no double funding) and a lapsed deadline', async () => {
    const { transport, sent } = makeMockTransport();
    const funded = new CommonsInstitutions({ ...BASE_CONFIG, fetch: makeMockFetch(relayWith(escrowDetails({ status: 'funded' }))).mockFetch });
    await expect(funded.fundCommonsJob('hjob_1', WALLET, { transport, ...FAST })).rejects.toThrow(/not 'created'/);
    const lapsed = new CommonsInstitutions({ ...BASE_CONFIG, fetch: makeMockFetch(relayWith(escrowDetails({ auto_release_at: Date.now() - 1000 }))).mockFetch });
    await expect(lapsed.fundCommonsJob('hjob_1', WALLET, { transport, ...FAST })).rejects.toThrow(/already passed/);
    expect(sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// RELEASE
// ---------------------------------------------------------------------------

describe('releaseCommonsJob — releaseEscrow(onchain id) → POST /complete', () => {
  it('signs releaseEscrow on the pinned escrow with the recorded on-chain id, then records', async () => {
    const { mockFetch, calls } = makeMockFetch(relayWith(escrowDetails({ status: 'funded', onchain_escrow_id: ONCHAIN_ID }), () => ({ body: { status: 'completed', payment_released: true } })));
    const { transport, sent } = makeMockTransport();
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    const out = await institutions.releaseCommonsJob('hjob_1', WALLET, { transport, ...FEES, ...FAST });
    expect(sent.map((t) => [t.fn, t.to.toLowerCase(), t.args[0]])).toEqual([['releaseEscrow', ESCROW.toLowerCase(), ONCHAIN_ID]]);
    expect(calls.at(-1)!.url).toBe('https://relay.test/v1/commons/jobs/hjob_1/complete');
    expect(out.job.payment_released).toBe(true);
  });

  // Mutation that reddens it: pass requireDepositor:false from releaseCommonsJob (or drop
  // the depositor comparison) — a non-depositor would broadcast a release that reverts
  // before autoReleaseAt and then call /complete.
  it('RED: refuses when the caller is not the depositor', async () => {
    const { mockFetch, calls } = makeMockFetch(relayWith(escrowDetails({ status: 'funded', onchain_escrow_id: ONCHAIN_ID, depositor_address: OTHER_ADDRESS })));
    const { transport, sent } = makeMockTransport();
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await expect(institutions.releaseCommonsJob('hjob_1', WALLET, { transport, ...FAST })).rejects.toThrow(/only the escrow depositor/);
    expect(sent).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  // Mutation that reddens it: drop the onchain_escrow_id BYTES32 check in
  // resolveCommonsEscrowTarget — the SDK would try to release an escrow that was never funded.
  it('RED: refuses when there is no on-chain escrow id (not funded)', async () => {
    const { mockFetch } = makeMockFetch(relayWith(escrowDetails({ status: 'funded', onchain_escrow_id: null })));
    const { transport, sent } = makeMockTransport();
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await expect(institutions.releaseCommonsJob('hjob_1', WALLET, { transport, ...FAST })).rejects.toThrow(/no on-chain escrow id/);
    expect(sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DISPUTE / SETTLE / REFUND
// ---------------------------------------------------------------------------

const DISPUTE_VIEW = {
  job_id: 'hjob_1', escrow_id: 'esc_1', escrow_status: 'disputed', currency: 'pvt', disputed_at: 1, dispute_reason: 'late',
  resolution: null, resolution_tx_hash: null, onchain_status: 'disputed', refund_opens_at: Date.now() + 86_400_000,
  refund_claimable: false, court_escalation_available: false, onchain_escrow_id: ONCHAIN_ID,
};

describe('disputeCommonsJob — disputeEscrow(onchain id) → POST /dispute', () => {
  it('signs disputeEscrow, then files; re-tries a lagging 409 onchain_dispute_required', async () => {
    let posts = 0;
    const { mockFetch, calls } = makeMockFetch(relayWith(escrowDetails({ status: 'funded', onchain_escrow_id: ONCHAIN_ID }), () => {
      posts += 1;
      return posts === 1
        ? { status: 409, body: { error: 'Raise the dispute on-chain first', code: 'onchain_dispute_required', onchain_escrow_id: ONCHAIN_ID } }
        : { body: DISPUTE_VIEW };
    }));
    const { transport, sent } = makeMockTransport();
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    const out = await institutions.disputeCommonsJob('hjob_1', WALLET, { reason: 'Nothing was delivered', evidence: 'thread hash abc', transport, ...FEES, ...FAST });
    expect(sent.map((t) => [t.fn, t.args[0]])).toEqual([['disputeEscrow', ONCHAIN_ID]]);
    expect(posts).toBe(2);
    expect(calls.at(-1)!.body).toEqual({ reason: 'Nothing was delivered', evidence: 'thread hash abc' });
    expect(out.dispute.court_escalation_available).toBe(false);
  });

  // Mutation that reddens it: move the reason validation after the broadcast (or drop it) —
  // an on-chain dispute would be raised that the relay then refuses to record.
  it('RED: refuses an empty reason before any network or broadcast', async () => {
    const { mockFetch, calls } = makeMockFetch(relayWith(escrowDetails({ status: 'funded', onchain_escrow_id: ONCHAIN_ID })));
    const { transport, sent } = makeMockTransport();
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await expect(institutions.disputeCommonsJob('hjob_1', WALLET, { reason: '   ', transport, ...FAST })).rejects.toThrow(/reason is required/);
    expect(calls).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  // Mutation that reddens it: requireDepositor:false in disputeCommonsJob — the hired party
  // would broadcast a disputeEscrow the contract reverts (onlyDepositor).
  it('RED: refuses a non-depositor (the hired party cannot dispute)', async () => {
    const { mockFetch } = makeMockFetch(relayWith(escrowDetails({ status: 'funded', onchain_escrow_id: ONCHAIN_ID, depositor_address: OTHER_ADDRESS })));
    const { transport, sent } = makeMockTransport();
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await expect(institutions.disputeCommonsJob('hjob_1', WALLET, { reason: 'late', transport, ...FAST })).rejects.toThrow(/only the escrow depositor/);
    expect(sent).toHaveLength(0);
  });
});

describe('dispute read / settle / refund', () => {
  it('getCommonsJobDispute and settleCommonsJobDispute hit their routes; dispute_pending surfaces as a relayCode', async () => {
    const { mockFetch, calls } = makeMockFetch((c) => (c.method === 'POST'
      ? { status: 409, body: { error: 'The dispute is with the escrow admin.', code: 'dispute_pending', refund_opens_at: 123 } }
      : { body: DISPUTE_VIEW }));
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    expect((await institutions.getCommonsJobDispute('hjob_1')).onchain_status).toBe('disputed');
    const err = await institutions.settleCommonsJobDispute('hjob_1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvianNetworkError);
    expect((err as ProvianNetworkError).relayCode).toBe(COMMONS_RELAY_CODES.DISPUTE_PENDING);
    expect((err as ProvianNetworkError).details?.refund_opens_at).toBe(123);
    expect(calls.map((c) => c.url)).toEqual([
      'https://relay.test/v1/commons/jobs/hjob_1/dispute',
      'https://relay.test/v1/commons/jobs/hjob_1/dispute/settle',
    ]);
  });

  it('claims the refund once claimable: claimDisputeTimeout(onchain id), then settles', async () => {
    const claimable = { ...DISPUTE_VIEW, refund_opens_at: Date.now() - 1, refund_claimable: true };
    const { mockFetch, calls } = makeMockFetch((c) => {
      if (c.url.endsWith('/escrow')) return { body: escrowDetails({ status: 'disputed', onchain_escrow_id: ONCHAIN_ID, depositor_address: OTHER_ADDRESS }) };
      if (c.url.endsWith('/dispute/settle')) return { body: { ...claimable, escrow_status: 'resolved', resolution: 'refund_to_depositor' } };
      return { body: claimable };
    });
    const { transport, sent } = makeMockTransport();
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    // Permissionless: the caller need not be the depositor (the refund only ever pays the depositor).
    const out = await institutions.claimCommonsJobRefund('hjob_1', WALLET, { transport, ...FEES, ...FAST });
    expect(sent.map((t) => [t.fn, t.args[0]])).toEqual([['claimDisputeTimeout', ONCHAIN_ID]]);
    expect(calls.at(-1)!.url).toBe('https://relay.test/v1/commons/jobs/hjob_1/dispute/settle');
    expect(out.dispute.resolution).toBe('refund_to_depositor');
  });

  // Mutation that reddens it: drop the `!view.refund_claimable` guard — the SDK would
  // broadcast a claimDisputeTimeout the contract reverts (DisputeTimeoutNotReached).
  it('RED: refuses to claim while the dispute is still with the admin (DISPUTE_PENDING, no broadcast)', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ body: DISPUTE_VIEW }));
    const { transport, sent } = makeMockTransport();
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    const err = await institutions.claimCommonsJobRefund('hjob_1', WALLET, { transport, ...FAST }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvianError);
    expect((err as ProvianError).code).toBe('DISPUTE_PENDING');
    expect(sent).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('an admin-resolved dispute only settles (no broadcast)', async () => {
    const { mockFetch } = makeMockFetch(() => ({ body: { ...DISPUTE_VIEW, onchain_status: 'resolved' } }));
    const { transport, sent } = makeMockTransport();
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    const out = await institutions.claimCommonsJobRefund('hjob_1', WALLET, { transport, ...FAST });
    expect(out.claimTxHash).toBeNull();
    expect(sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Vouch + featured
// ---------------------------------------------------------------------------

describe('vouch', () => {
  it('POSTs the agent vouch route with target_agent_id + note', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ body: { vouch_id: 'v1', target_agent_id: 'user_abc', created_at: 1 } }));
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await institutions.vouch('user_abc', 'Delivered twice, on time');
    expect(calls[0].url).toBe('https://relay.test/v1/agent/wallet/wallet_aw_poster/vouch/burn');
    expect(calls[0].body).toEqual({ target_agent_id: 'user_abc', note: 'Delivered twice, on time' });
  });

  // Mutation that reddens it: stop mapping relayCode linked_pair_vouch_refused in vouch()
  // (or stop reading `reason` in requestJSON) — it would surface as a credential failure.
  it('RED: a linked-pair refusal is a typed ProvianVouchRefusedError, not an auth error', async () => {
    const { mockFetch } = makeMockFetch(() => ({ status: 403, body: { error: 'An agent cannot vouch for its own linked human', reason: 'linked_pair_vouch_refused' } }));
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    const err = await institutions.vouch('user_mine').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvianVouchRefusedError);
    expect((err as ProvianVouchRefusedError).code).toBe('LINKED_PAIR_VOUCH_REFUSED');
  });

  it('listMyVouches and vouchesFor read their routes', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ body: { vouches: [{ vouch_id: 'v1' }] } }));
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    expect(await institutions.listMyVouches()).toHaveLength(1);
    expect(await institutions.vouchesFor('user_abc')).toHaveLength(1);
    expect(calls.map((c) => c.url)).toEqual([
      'https://relay.test/v1/agent/wallet/wallet_aw_poster/vouches',
      'https://relay.test/v1/commons/agent/user_abc/vouches',
    ]);
  });
});

describe('feature — the folded agent board maps onto the Commons board', () => {
  it("'jobs' and 'human_jobs' both feature on /v1/commons/jobs/:id/feature; a legacy job_ id is refused", async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ status: 201, body: { placement: {} } }));
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch });
    await institutions.feature('jobs', 'hjob_1', 'burn_1');
    await institutions.feature('human_jobs', 'hjob_1', 'burn_2');
    expect(calls.map((c) => c.url)).toEqual([
      'https://relay.test/v1/commons/jobs/hjob_1/feature',
      'https://relay.test/v1/commons/jobs/hjob_1/feature',
    ]);
    await expect(institutions.feature('jobs', 'job_legacy', 'burn_3')).rejects.toMatchObject({ code: 'JOB_BOARD_MOVED' });
    expect(calls).toHaveLength(2);
  });
});
