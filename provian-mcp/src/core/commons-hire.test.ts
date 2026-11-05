/**
 * the Commons hire tools: one board, four directions, PVT or USDC, with the dispute
 * fallback. The on-chain legs are two-step (plan → the caller signs → record); these tests
 * pin the exact calldata each plan returns and the refusals that fire BEFORE any plan is
 * handed out. Every refusal is a RED negative control and names the mutation that reddens it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { callProvianTool, COMMONS_HIRE_BASE_PINS, deriveHireOnchainEscrowId, encodeHireCall, usdcToAtomic } from './tools';
import type { ToolContext } from './types';

const REPO = resolve(__dirname, '../../..');
const AUTH = { apiKey: 'pvn_live_k', apiSecret: 'pvns_s' };
const ID = '0x' + '7'.repeat(64);
const RECIPIENT = '0x2222222222222222222222222222222222222222';
const DEPOSITOR = '0x90f8bf6a479f320ead074411a4b0e7944ea8c9c1';

/**
 * Calldata fixtures produced by viem's encodeFunctionData (the SDK's encoder) for the same
 * arguments — an independent oracle, not this module's own encoder.
 */
const VIEM = {
  create: '0xf8f3479b777777777777777777777777777777777777777777777777777777777777777700000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000000bebc2000000000000000000000000000000000000000000000000000000000713fb3000000000000000000000000000000000000000000000000000000000000000000',
  approve: '0x095ea7b300000000000000000000000096560fdf49e563efcdc2d502934676dc074732d00000000000000000000000000000000000000000000000000000000000bebc20',
  fund: '0x32d1e99177777777777777777777777777777777777777777777777777777777777777770000000000000000000000000000000000000000000000000000000000000000',
  release: '0xbf89fc617777777777777777777777777777777777777777777777777777777777777777',
  dispute: '0xcfd245227777777777777777777777777777777777777777777777777777777777777777',
  claim: '0xc2d8683d7777777777777777777777777777777777777777777777777777777777777777',
};

interface Call { url: string; method?: string; body?: unknown }

function ctxFor(route: (c: Call) => { status?: number; body: unknown }, extra: Partial<ToolContext> = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const call: Call = { url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const { status = 200, body } = route(call);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  const ctx: ToolContext = { baseUrl: 'https://relay.test', fetchImpl, auth: AUTH, mode: 'remote', ...extra };
  return { ctx, calls };
}

function parse(result: { content: Array<{ text: string }>; isError?: boolean }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

function escrow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    escrow_id: 'esc_1', currency: 'usdc', contract_address: '0x96560fDF49e563eFCdc2d502934676DC074732d0',
    amount_usdc: 12.5, status: 'created', chain: 'base', depositor_address: DEPOSITOR, recipient_address: RECIPIENT,
    auto_release_at: Date.now() + 86_400_000, token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    onchain_escrow_id: null, ...over,
  };
}

describe('pins bind to the checked-in sources of truth (not a copy)', () => {
  it('escrow = base-pvt9-institutions.json escrowV4; PVT + USDC = config/pvt9-base.json assets', () => {
    const inst = JSON.parse(readFileSync(resolve(REPO, 'contracts/deployments/base-pvt9-institutions.json'), 'utf8'));
    const cfg = JSON.parse(readFileSync(resolve(REPO, 'config/pvt9-base.json'), 'utf8'));
    expect(COMMONS_HIRE_BASE_PINS.escrow).toBe(String(inst.contracts.escrowV4.address).toLowerCase());
    expect(COMMONS_HIRE_BASE_PINS.tokens.pvt).toBe(String(cfg.assets.pvt9.address).toLowerCase());
    expect(COMMONS_HIRE_BASE_PINS.tokens.usdc).toBe(String(cfg.assets.usdc.address).toLowerCase());
    expect(inst.chainId).toBe(COMMONS_HIRE_BASE_PINS.chainId);
  });
});

describe('encodeHireCall matches viem byte-for-byte', () => {
  it('createEscrow / approve / fundEscrow / releaseEscrow / disputeEscrow / claimDisputeTimeout', () => {
    expect(encodeHireCall('createEscrow', { escrowId: ID, recipient: RECIPIENT, amount: 12_500_000n, autoReleaseAt: 1_900_000_000n, currency: 'usdc' })).toBe(VIEM.create);
    expect(encodeHireCall('approve', { spender: COMMONS_HIRE_BASE_PINS.escrow, amount: 12_500_000n })).toBe(VIEM.approve);
    expect(encodeHireCall('fundEscrow', { escrowId: ID })).toBe(VIEM.fund);
    expect(encodeHireCall('releaseEscrow', { escrowId: ID })).toBe(VIEM.release);
    expect(encodeHireCall('disputeEscrow', { escrowId: ID })).toBe(VIEM.dispute);
    expect(encodeHireCall('claimDisputeTimeout', { escrowId: ID })).toBe(VIEM.claim);
    expect(usdcToAtomic(12.5)).toBe(12_500_000n);
  });
});

describe('post_job / accept_applicant / read_job / market_jobs', () => {
  it('post_job sends seeking + currency + exactly one budget', async () => {
    const { ctx, calls } = ctxFor(() => ({ status: 201, body: { job_id: 'hjob_1' } }));
    await callProvianTool('post_job', { title: 't', description: 'd', seeking: 'agent', currency: 'usdc', budget_usdc: 25, deadline_hours: 48 }, ctx);
    expect(calls[0].url).toBe('https://relay.test/v1/commons/jobs/post');
    expect(calls[0].body).toMatchObject({ seeking: 'agent', currency: 'usdc', budget_usdc: 25, category: 'other', location: { type: 'remote' }, compensation_type: 'fixed' });
    expect((calls[0].body as Record<string, unknown>).budget_pvt).toBeUndefined();
  });

  it('post_job refuses a mixed or out-of-range budget before the relay', async () => {
    const { ctx, calls } = ctxFor(() => ({ body: {} }));
    expect((await callProvianTool('post_job', { title: 't', description: 'd', seeking: 'agent', currency: 'usdc', budget_usdc: 25, budget_pvt: '1', deadline_hours: 48 }, ctx)).isError).toBe(true);
    expect((await callProvianTool('post_job', { title: 't', description: 'd', seeking: 'agent', currency: 'usdc', budget_usdc: 10_001, deadline_hours: 48 }, ctx)).isError).toBe(true);
    expect((await callProvianTool('post_job', { title: 't', description: 'd', seeking: 'robot', currency: 'pvt', budget_pvt: '1', deadline_hours: 48 }, ctx)).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('accept_applicant, read_job (+applications, +escrow) and market_jobs (+stats) hit their routes', async () => {
    const { ctx, calls } = ctxFor(() => ({ body: { ok: true, applications: [] } }));
    await callProvianTool('accept_applicant', { job_id: 'hjob_1', applicant_wallet_id: 'user_1' }, ctx);
    await callProvianTool('read_job', { job_id: 'hjob_1', include: ['applications', 'escrow'] }, ctx);
    await callProvianTool('market_jobs', { seeking: 'all', stats: true }, ctx);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://relay.test/v1/commons/jobs/hjob_1/accept',
      'GET https://relay.test/v1/commons/jobs/hjob_1',
      'GET https://relay.test/v1/commons/jobs/hjob_1/applications',
      'GET https://relay.test/v1/commons/jobs/hjob_1/escrow',
      'GET https://relay.test/v1/commons/market/jobs?seeking=all',
      'GET https://relay.test/v1/commons/market/stats',
    ]);
    expect(calls[0].body).toEqual({ applicant_wallet_id: 'user_1' });
  });
});

describe('fund_job — ONE HIRE → ONE ON-CHAIN ESCROW ID (SDK parity)', () => {
  // Vectors computed by the SDK's deriveHireOnchainEscrowId (viem keccak256(encodeAbiParameters)).
  // A drift on either side (domain, field order, encoding) reddens here.
  it('derives byte-identically to the SDK', () => {
    expect(deriveHireOnchainEscrowId('0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1', 'esc_1'))
      .toBe('0x47ba724fba7d569073cf91bfc983064516d3e8bf89893b55a6af88ea7ed4d30f');
    expect(deriveHireOnchainEscrowId('0x76d4b06987e556dd570872714dee84f4211677a3', 'esc_e96079a3-d3ed-483c-bdf4-0999e44b2234'))
      .toBe('0xa6bfbff19154c9449bdc768f85fe853f92e56d283a2df32a35b632bfcc3aaccc');
    expect(deriveHireOnchainEscrowId('0x76d4b06987e556dd570872714dee84f4211677a3', 'x'.repeat(32)))
      .toBe('0xb62224079c61e3217ba2c157be72db7fb27be5f6395cfb239e915627d9cd564a');
  });

  it('RED control: two default plans for one hire name the SAME on-chain escrow (a random default differs)', async () => {
    const ids: unknown[] = [];
    for (let i = 0; i < 2; i++) {
      const { ctx } = ctxFor(() => ({ body: escrow() }));
      ids.push(parse(await callProvianTool('fund_job', { job_id: 'hjob_1' }, ctx)).onchain_escrow_id);
    }
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toBe(deriveHireOnchainEscrowId(DEPOSITOR, 'esc_1'));
  });
});

describe('fund_job — plan (unsigned calls) then record', () => {
  it('USDC plan: createEscrow(currency 0) → approve USDC for the exact atomic amount → fundEscrow, all on the pins', async () => {
    const e = escrow({ auto_release_at: 1_900_000_000_000 + 999 });
    const { ctx } = ctxFor(() => ({ body: e }));
    const out = parse(await callProvianTool('fund_job', { job_id: 'hjob_1', onchain_escrow_id: ID }, ctx));
    const calls = out.calls as Array<{ label: string; to: string; data: string }>;
    expect(calls.map((c) => [c.label, c.to])).toEqual([
      ['createEscrow', COMMONS_HIRE_BASE_PINS.escrow],
      ['approve', COMMONS_HIRE_BASE_PINS.tokens.usdc],
      ['fundEscrow', COMMONS_HIRE_BASE_PINS.escrow],
    ]);
    expect(calls[0].data).toBe(VIEM.create);
    expect(calls[1].data).toBe(VIEM.approve);
    expect(calls[2].data).toBe(VIEM.fund);
    expect(out.amount_atomic).toBe('12500000');
    expect(out.chain_id).toBe(8453);
  });

  it('PVT plan uses currency enum 1 and the PVT token', async () => {
    const { ctx } = ctxFor(() => ({ body: escrow({ currency: 'pvt', amount_usdc: undefined, amount_pvt: '5000000000000000000', token_address: '0x8811441914381143b9408c5C32247367F86F173A' }) }));
    const out = parse(await callProvianTool('fund_job', { job_id: 'hjob_1', onchain_escrow_id: ID }, ctx));
    const calls = out.calls as Array<{ label: string; to: string; data: string }>;
    expect(calls[1].to).toBe(COMMONS_HIRE_BASE_PINS.tokens.pvt);
    // The last word of createEscrow is the currency enum.
    expect(calls[0].data.endsWith('1'.padStart(64, '0'))).toBe(true);
    expect(out.decimals).toBe(18);
  });

  it('record POSTs the fundEscrow hash; insufficient_confirmations is reported as "retry, do not fund again"', async () => {
    const hash = '0x' + 'a'.repeat(64);
    const { ctx, calls } = ctxFor(() => ({ status: 400, body: { error: 'On-chain funding verification failed: insufficient_confirmations: 2/12' } }));
    const out = await callProvianTool('fund_job', { job_id: 'hjob_1', tx_hash: hash }, ctx);
    expect(calls[0].url).toBe('https://relay.test/v1/commons/jobs/hjob_1/fund');
    expect(calls[0].body).toEqual({ tx_hash: hash });
    expect(out.isError).toBe(true);
    expect(String(parse(out).error)).toContain('Do NOT fund again');
  });

  // Mutation that reddens it: drop the "a USDC escrow must not carry amount_pvt" branch in
  // fund_job — the plan would escrow USDC against an escrow whose amount field is PVT.
  it('RED: refuses a currency/amount mismatch (USDC escrow carrying amount_pvt)', async () => {
    const { ctx } = ctxFor(() => ({ body: escrow({ amount_pvt: '5000000000000000000' }) }));
    const out = await callProvianTool('fund_job', { job_id: 'hjob_1' }, ctx);
    expect(out.isError).toBe(true);
    expect(String(parse(out).error)).toContain('currency/amount mismatch');
  });

  // Mutation that reddens it: build the calls against `e.contract_address` / `e.token_address`
  // instead of COMMONS_HIRE_BASE_PINS (or delete checkPinnedEscrow's comparison).
  it('RED: refuses an escrow contract or token that is not the pin', async () => {
    const other = '0x1111111111111111111111111111111111111111';
    const a = ctxFor(() => ({ body: escrow({ contract_address: other }) }));
    expect(String(parse(await callProvianTool('fund_job', { job_id: 'hjob_1' }, a.ctx)).error)).toContain('not the pinned ProvianEscrowV4');
    const b = ctxFor(() => ({ body: escrow({ token_address: '0x8811441914381143b9408c5C32247367F86F173A' }) }));
    expect(String(parse(await callProvianTool('fund_job', { job_id: 'hjob_1' }, b.ctx)).error)).toContain('refusing');
  });

  // Mutation that reddens it: delete the local-identity depositor comparison in fund_job — a
  // machine whose agent is not the depositor would be handed calls that can never verify.
  it('RED (local): refuses when this machine\'s agent is not the depositor', async () => {
    const { ctx } = ctxFor(() => ({ body: escrow() }), {
      mode: 'local',
      withLocalSovereignIdentity: (<T>(fn: (id: { address: string; walletId: string; pubkey: string; signEip191: (m: string) => string; signPop: (b: string) => string }) => T) =>
        fn({ address: '0x3333333333333333333333333333333333333333', walletId: 'wallet_aw_x', pubkey: '', signEip191: () => '', signPop: () => '' })) as ToolContext['withLocalSovereignIdentity'],
    });
    const out = await callProvianTool('fund_job', { job_id: 'hjob_1' }, ctx);
    expect(String(parse(out).error)).toContain('is not the escrow depositor');
  });
});

describe('release_job / dispute_job / read_job_dispute / settle_job_dispute', () => {
  it('release plan returns releaseEscrow(onchain id); record POSTs /complete', async () => {
    const { ctx, calls } = ctxFor((c) => ({ body: c.url.endsWith('/escrow') ? escrow({ status: 'funded', onchain_escrow_id: ID }) : { status: 'completed' } }));
    const plan = parse(await callProvianTool('release_job', { job_id: 'hjob_1' }, ctx));
    expect((plan.calls as Array<{ data: string; to: string }>)[0]).toMatchObject({ data: VIEM.release, to: COMMONS_HIRE_BASE_PINS.escrow });
    await callProvianTool('release_job', { job_id: 'hjob_1', step: 'record' }, ctx);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: 'https://relay.test/v1/commons/jobs/hjob_1/complete' });
  });

  // Mutation that reddens it: drop the BYTES32 onchain_escrow_id check in release_job — a plan
  // would be built for an escrow that was never funded.
  it('RED: release refuses an escrow with no on-chain id', async () => {
    const { ctx } = ctxFor(() => ({ body: escrow({ status: 'funded', onchain_escrow_id: null }) }));
    expect(String(parse(await callProvianTool('release_job', { job_id: 'hjob_1' }, ctx)).error)).toContain('no on-chain escrow id');
  });

  it('dispute plan returns disputeEscrow; record files reason + evidence', async () => {
    const { ctx, calls } = ctxFor((c) => ({ body: c.url.endsWith('/escrow') ? escrow({ status: 'funded', onchain_escrow_id: ID }) : { court_escalation_available: false } }));
    const plan = parse(await callProvianTool('dispute_job', { job_id: 'hjob_1' }, ctx));
    expect((plan.calls as Array<{ data: string }>)[0].data).toBe(VIEM.dispute);
    await callProvianTool('dispute_job', { job_id: 'hjob_1', step: 'record', reason: 'not delivered', evidence: 'x' }, ctx);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: 'https://relay.test/v1/commons/jobs/hjob_1/dispute', body: { reason: 'not delivered', evidence: 'x' } });
  });

  // Mutation that reddens it: stop validating `reason` before the record POST.
  it('RED: dispute record refuses an empty reason before the relay', async () => {
    const { ctx, calls } = ctxFor(() => ({ body: {} }));
    expect((await callProvianTool('dispute_job', { job_id: 'hjob_1', step: 'record' }, ctx)).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('read_job_dispute GETs and settle_job_dispute POSTs; dispute_pending surfaces as an error with refund_opens_at', async () => {
    const { ctx, calls } = ctxFor((c) => (c.method === 'POST'
      ? { status: 409, body: { error: 'The dispute is with the escrow admin.', code: 'dispute_pending', refund_opens_at: 42 } }
      : { body: { onchain_status: 'disputed', court_escalation_available: false } }));
    expect(parse(await callProvianTool('read_job_dispute', { job_id: 'hjob_1' }, ctx)).court_escalation_available).toBe(false);
    const settled = await callProvianTool('settle_job_dispute', { job_id: 'hjob_1' }, ctx);
    expect(settled.isError).toBe(true);
    expect((parse(settled).details as Record<string, unknown>).refund_opens_at).toBe(42);
    expect(calls.map((c) => c.url)).toEqual([
      'https://relay.test/v1/commons/jobs/hjob_1/dispute',
      'https://relay.test/v1/commons/jobs/hjob_1/dispute/settle',
    ]);
  });
});

describe('vouch + feature_item', () => {
  it('vouch POSTs the agent vouch route; list_mine / list_for read', async () => {
    const { ctx, calls } = ctxFor(() => ({ body: { vouches: [] } }));
    await callProvianTool('vouch', { wallet_id: 'wallet_aw_1', target: 'user_2', note: 'reliable' }, ctx);
    await callProvianTool('vouch', { wallet_id: 'wallet_aw_1', action: 'list_mine' }, ctx);
    await callProvianTool('vouch', { action: 'list_for', target: 'user_2' }, ctx);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://relay.test/v1/agent/wallet/wallet_aw_1/vouch/burn',
      'GET https://relay.test/v1/agent/wallet/wallet_aw_1/vouches',
      'GET https://relay.test/v1/commons/agent/user_2/vouches',
    ]);
    expect(calls[0].body).toEqual({ target_agent_id: 'user_2', note: 'reliable' });
  });

  it("feature_item maps 'jobs' onto the Commons board and refuses a legacy job_ id", async () => {
    const { ctx, calls } = ctxFor(() => ({ status: 201, body: {} }));
    await callProvianTool('feature_item', { board: 'jobs', item_id: 'hjob_1', burn_id: 'b' }, ctx);
    expect(calls[0].url).toBe('https://relay.test/v1/commons/jobs/hjob_1/feature');
    expect((await callProvianTool('feature_item', { board: 'jobs', item_id: 'job_1', burn_id: 'b' }, ctx)).isError).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
