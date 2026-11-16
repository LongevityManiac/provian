/**
 * The Recourse MCP tools: status, transfers and requests read; recourse_action never signs or writes.
 *
 * RED controls in-suite: a report without a transaction is refused before any call; a picker whose
 * RPC refuses the log range is an error, never an empty list; a lapsed membership's unpaid amount is
 * shown as what to complete before rejoining, not as an amount awaiting collection.
 */
import { describe, expect, it } from 'vitest';
import { Interface, parseUnits } from 'ethers';
import { callProvianTool } from './tools';
import { PROTOCOL_COMPONENTS, type PointerRpc, type ProtocolDeployment } from './protocol-pointer';
import type { RecourseChainNetwork } from './recourse-theft-transfers';
import type { ToolContext } from './types';

type Call = { url: string; method: string };
const API_KEY = `pvn_live_${'a'.repeat(32)}`;
const API_SECRET = `pvns_${'b'.repeat(64)}`;
const h = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const KERNEL = '0x2af3a065dc3c0c51b054cb8c6baee7df76189e0e';
const POOL = '0x92e9c83d00000000000000000000000000000001';
const ME = '0x1111111111111111111111111111111111111111';
const THIEF = '0x2222222222222222222222222222222222222222';
const ZERO = '0x0000000000000000000000000000000000000000';
// Rule amounts are fixture values for the parser, never product literals.
const BURN = parseUnits('11', 18).toString(), FLAT = parseUnits('13', 18).toString();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function parse(r: { content: Array<{ text: string }> }): Record<string, any> { return JSON.parse(r.content[0].text) as Record<string, any>; }

function ctxWith(respond: (c: Call) => Response, extra: Partial<ToolContext> = {}): { ctx: ToolContext; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? 'GET' };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { ctx: { baseUrl: 'https://relay.test', fetchImpl, auth: { apiKey: API_KEY, apiSecret: API_SECRET }, mode: 'remote', ...extra }, calls };
}

function pool(status: 'protected' | 'lapsed' | 'not_member', unpaid = '0'): Record<string, unknown> {
  const enrolled = status === 'protected';
  return { pool: POOL, kernel: KERNEL, identity: h(5), month: String(2026 * 12 + 10), participationBurnAtomic: BURN,
    noEarningsContributionAtomic: FLAT, earningsBps: 250, signedRuleHash: h(9), reserveAtomic: parseUnits('1000', 18).toString(),
    membership: { enrolled, grace: false, unpaidAtomic: unpaid,
      details: { status, protectionStartedAtMs: enrolled ? Date.UTC(2026, 9, 3) : null, nextMonthAtMs: enrolled ? Date.UTC(2026, 11, 1) : null,
        nextBurnAtomic: enrolled ? BURN : null, noEarningsContributionAtomic: enrolled ? FLAT : null, earningsBps: enrolled ? 250 : null } } };
}
const relay = (p: Record<string, unknown>) => (c: Call): Response =>
  c.url.endsWith('/v1/recourse/pool') ? json(200, p) : c.url.endsWith('/membership-transitions') ? json(404, { error: 'none' }) : json(500, {});

describe('recourse_status', () => {
  it('shows a protected membership with its dates and the rule amounts from the relay reply', async () => {
    const { ctx, calls } = ctxWith(relay(pool('protected')));
    const out = parse(await callProvianTool('recourse_status', {}, ctx));
    expect(out.membership).toMatchObject({ status: 'protected', protected: true, protection_started_at: '2026-10-03T00:00:00.000Z',
      next_month_at: '2026-12-01T00:00:00.000Z', next_burn_pvt: '11', next_no_earnings_contribution_pvt: '13', earnings_contribution_percent: 2.5 });
    expect(out.rule).toMatchObject({ month: '2026-11', participation_burn_pvt: '11', no_earnings_contribution_pvt: '13' });
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('RED CONTROL: a lapsed membership\'s unpaid amount is what to complete before rejoining', async () => {
    const { ctx } = ctxWith(relay(pool('lapsed', parseUnits('24', 18).toString())));
    const out = parse(await callProvianTool('recourse_status', {}, ctx));
    expect(out.membership).toMatchObject({ status: 'lapsed', protected: false, unpaid_pvt: '24', unpaid_meaning: 'complete_before_rejoining' });
    expect(out.next_step).toBe('npx @provian/agent-sdk@latest recourse rejoin');
  });
});

describe('recourse_action signs nothing', () => {
  it('returns the review and approve commands where the key lives, reading only', async () => {
    const { ctx, calls } = ctxWith(relay(pool('not_member')));
    const out = parse(await callProvianTool('recourse_action', { action: 'join' }, ctx));
    expect(out.signed).toBe(false);
    expect(out.review_first.npx).toBe('npx @provian/agent-sdk@latest recourse join');
    expect(out.approve.cli).toBe('npx -y @provian/cli@latest recourse join --yes');
    expect(out.terms.join(' ')).toMatch(/approve once/);
    expect(out.terms.join(' ')).toMatch(/Provian reviews a theft report and decides what the pool can restore/);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('RED CONTROL: a report without the transaction is refused before any call', async () => {
    const { ctx, calls } = ctxWith(relay(pool('protected')));
    const result = await callProvianTool('recourse_action', { action: 'report' }, ctx);
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('a report names the chosen transfer in the command', async () => {
    const { ctx } = ctxWith(relay(pool('protected')));
    const out = parse(await callProvianTool('recourse_action', { action: 'report', tx_hash: h(1).toUpperCase().replace('0X', '0x') }, ctx));
    expect(out.approve.hosted).toBe(`"$HOME/.provian/bin/provian" recourse report --tx ${h(1)} --yes`);
  });
});

const TOKEN = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const deployment = (): ProtocolDeployment => ({ pointer: '0x619eae740ce56c5a8edbb2b047e58369281ddad7', revision: 1n, manifestHash: h(77),
  blockHash: h(1), runtimeHashes: [], addresses: Object.fromEntries(PROTOCOL_COMPONENTS.map(c => [c, c === 'kernel' ? KERNEL : ZERO])) as ProtocolDeployment['addresses'] });
function rpc(refuseLogs: boolean): PointerRpc {
  return { async request(method, params) {
    if (method === 'eth_getBlockByNumber') {
      if (params[0] === 'finalized') return { number: `0x${(100_000).toString(16)}` };
      return { hash: h(0xb000000 + Number(BigInt(String(params[0])))), number: params[0], timestamp: '0x6a000000' };
    }
    if (method === 'eth_getLogs') {
      if (refuseLogs) throw new Error('block range too large');
      const q = params[0] as { fromBlock: string; toBlock: string };
      const block = 99_000;
      if (block < Number(BigInt(q.fromBlock)) || block > Number(BigInt(q.toBlock))) return [];
      const encoded = TOKEN.encodeEventLog('Transfer', [ME, THIEF, parseUnits('40', 18)]);
      return [{ address: KERNEL, topics: encoded.topics, data: encoded.data, transactionHash: h(1), blockHash: h(0xb000000 + block),
        blockNumber: `0x${block.toString(16)}`, logIndex: '0x0', removed: false }];
    }
    throw new Error(`unexpected ${method}`);
  } };
}
const network = (refuse: boolean): RecourseChainNetwork => ({ rpcs: [rpc(false), rpc(refuse)], deployment: async () => deployment() });

describe('recourse_transfers', () => {
  it('lists the outgoing kernel transfer to choose from, with no relay call', async () => {
    const { ctx, calls } = ctxWith(() => json(500, {}), { recourseChainNetwork: () => network(false) });
    const out = parse(await callProvianTool('recourse_transfers', { address: ME, window_blocks: 10_000, windows: 2 }, ctx));
    expect(out.transfers.map((t: Record<string, unknown>) => [t.transaction_hash, t.to])).toEqual([[h(1), THIEF]]);
    expect(calls).toHaveLength(0);
  });

  it('RED CONTROL: an RPC that refuses the range is an error, never an empty list', async () => {
    const { ctx } = ctxWith(() => json(500, {}), { recourseChainNetwork: () => network(true) });
    const result = await callProvianTool('recourse_transfers', { address: ME, window_blocks: 10_000, windows: 2 }, ctx);
    expect(result.isError).toBe(true);
  });
});
