import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseUnits } from 'ethers';
import {
  assertRuleMatchesChain, defaultAgentRecourseDeps, loadRecourseIdentity, parseRecoursePoolReply, parseRestorationRequests, renderRecourseStatus,
  runAgentRecourseCommand, type AgentRecourseDeps, type AgentRecourseStatus, type RecourseMembershipStatus,
} from './recourse-agent';
import { parseRecourseArgs, runRecourseCli } from './scripts/recourse';
import type { MembershipConsentChallenge, MembershipTransitionView } from './recourse-membership-client';
import type { RecoursePoolState } from './recourse-pool-chain';
import type { VerifiedTheftTransfer } from './recourse-theft-transfers';

const h = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const POOL = '0x92e9c83d00000000000000000000000000000001';
const KERNEL = '0x2af3a065dc3c0c51b054cb8c6baee7df76189e0e';
const ME = '0x1111111111111111111111111111111111111111';
const THIEF = '0x2222222222222222222222222222222222222222';
// Rule amounts are fixture values for the parser, never product literals.
const BURN = parseUnits('11', 18).toString(), FLAT = parseUnits('13', 18).toString(), BPS = 250;
const MAY_2026 = String(2026 * 12 + 4), JUNE_2026 = String(2026 * 12 + 5);

function relayPool(status: RecourseMembershipStatus, unpaid = '0'): Record<string, unknown> {
  const enrolled = status === 'protected' || status === 'grace';
  return { pool: POOL, kernel: KERNEL, identity: h(5), month: JUNE_2026, participationBurnAtomic: BURN, noEarningsContributionAtomic: FLAT,
    earningsBps: BPS, signedRuleHash: h(9), reserveAtomic: parseUnits('1000', 18).toString(), block: 1, blockHash: h(1),
    membership: { enrolled, grace: status === 'grace', month: JUNE_2026, endMonthExclusive: '0', unpaidAtomic: unpaid, block: 1, blockHash: h(1),
      details: { status, protectionStartedAtMs: enrolled ? Date.UTC(2026, 4, 3) : null, nextMonthAtMs: enrolled ? Date.UTC(2026, 6, 1) : null,
        nextBurnAtomic: enrolled ? BURN : null, noEarningsContributionAtomic: enrolled ? FLAT : null, earningsBps: enrolled ? BPS : null } } };
}
const status = (s: RecourseMembershipStatus, unpaid = '0'): AgentRecourseStatus => ({ ...parseRecoursePoolReply(relayPool(s, unpaid)), pendingAction: null });

function challenge(over: Partial<MembershipConsentChallenge> = {}): MembershipConsentChallenge {
  return { domain: { chainId: '8453', pointer: h(2).slice(0, 42), kernel: KERNEL, pool: POOL },
    consent: { binding: h(5), account: ME, nonce: '1', joined: true, revision: '1', ruleHash: h(9), expiresAt: '100' },
    messageHex: h(3), admissionMonth: JUNE_2026, rejoinPayments: [], fixedChargePayer: true, burnLimit: BURN, reserveLimit: FLAT, earningsBpsLimit: BPS, ...over };
}
const view = (kind: 'join' | 'leave', st: MembershipTransitionView['status'], challenges: MembershipConsentChallenge[] = []): MembershipTransitionView =>
  ({ id: h(42), kind, status: st, challenges, pending: [] });

function deps(s: AgentRecourseStatus, over: Partial<AgentRecourseDeps> = {}): AgentRecourseDeps & Record<string, ReturnType<typeof vi.fn>> {
  const d = {
    address: ME,
    readStatus: vi.fn(async () => s),
    readTransition: vi.fn(async (): Promise<MembershipTransitionView | null> => null),
    beginTransition: vi.fn(async (kind: 'join' | 'leave') => view(kind, 'consenting', [challenge()])),
    authorize: vi.fn(async () => ({ id: h(7), status: 'queued' as const, transactionHash: null })),
    leave: vi.fn(async () => undefined),
    listTransfers: vi.fn(),
    resolveTransfer: vi.fn(async (): Promise<VerifiedTheftTransfer> => ({ transactionHash: h(1), from: ME, to: THIEF, amount: '42.5',
      timestamp: Date.UTC(2026, 5, 2), block: 99_000, blockHash: h(99) })),
    submitRestoration: vi.fn(async () => ({ walletId: 'wallet_aw_x', destination: '0x4444444444444444444444444444444444444444', generation: 1, restorationRequestId: h(55) })),
    readRequests: vi.fn(async () => ({ requests: [] })),
    sleep: vi.fn(async () => undefined),
    command: (sub: string) => `provian ${sub}`,
    ...over,
  };
  return d as AgentRecourseDeps & Record<string, ReturnType<typeof vi.fn>>;
}

describe('status', () => {
  it('renders a protected member with dates and the rule amounts read from the reply', async () => {
    const out = await runAgentRecourseCommand('status', {}, deps(status('protected')));
    const text = out.lines.join('\n');
    expect(out.exitCode).toBe(0);
    expect(text).toContain('Recourse membership: Protected');
    expect(text).toContain('Protection started 2026-05-03 (UTC).');
    expect(text).toContain('Next month begins 2026-07-01 (UTC): burn 11 PVT.');
    expect(text).toContain('If that month has no earnings: contribute 13 PVT.');
    expect(text).toContain('Otherwise 2.5% of your earnings');
    expect(text).toContain('signed membership rule for 2026-06');
    expect(out.result).toMatchObject({ membership: { status: 'protected', protected: true, next_burn_pvt: '11', earnings_bps: 250 }, next_step: 'provian recourse leave' });
  });

  it('renders a lapsed member with the unpaid amount to complete before rejoining', async () => {
    const out = await runAgentRecourseCommand('status', {}, deps(status('lapsed', parseUnits('24', 18).toString())));
    expect(out.lines.join('\n')).toContain('Recourse membership: Lapsed');
    expect(out.lines.join('\n')).toContain('To rejoin, first complete the unpaid protected months: 24 PVT.');
    expect(out.result).toMatchObject({ membership: { status: 'lapsed', unpaid_pvt: '24', unpaid_meaning: 'complete_before_rejoining' },
      next_step: 'provian recourse rejoin' });
  });

  it('grace is still protected; not_member names join; an unavailable private view still shows the rule', () => {
    expect(renderRecourseStatus(status('grace'))[0]).toBe('Recourse membership: In grace — still protected');
    expect(renderRecourseStatus(status('not_member'))[0]).toBe('Recourse membership: Not a member');
    const unavailable = renderRecourseStatus({ ...status('not_member'), membership: null, pendingAction: view('join', 'consenting') });
    expect(unavailable[0]).toMatch(/unavailable right now/);
    expect(unavailable.join('\n')).toMatch(/Open membership action: join \(consenting\)/);
  });

  it('RED: a malformed relay reply is refused, not rendered', () => {
    expect(() => parseRecoursePoolReply({ ...relayPool('protected'), earningsBps: 10_001 })).toThrow('recourse_reply_invalid');
    const bad = relayPool('protected');
    (bad.membership as Record<string, unknown>).details = { ...(bad.membership as { details: Record<string, unknown> }).details, status: 'insured' };
    expect(() => parseRecoursePoolReply(bad)).toThrow('recourse_reply_invalid');
  });
});

describe('the relay rule must equal the chain rule', () => {
  const chain = { pool: POOL, kernel: KERNEL, month: JUNE_2026, participationBurnAtomic: BURN, noEarningsContributionAtomic: FLAT,
    earningsBps: BPS, signedRuleHash: h(9) } as RecoursePoolState;
  it('passes when every rule field matches', () => {
    expect(() => assertRuleMatchesChain(status('protected'), chain)).not.toThrow();
  });
  it('RED: a relay burn above the chain rule is refused', () => {
    expect(() => assertRuleMatchesChain(status('protected'), { ...chain, participationBurnAtomic: '1' })).toThrow(/recourse_rule_mismatch/);
    expect(() => assertRuleMatchesChain(status('protected'), { ...chain, signedRuleHash: h(10) })).toThrow(/recourse_rule_mismatch/);
  });
});

describe('join', () => {
  it('without --yes shows the terms and signs nothing', async () => {
    const d = deps(status('not_member'));
    const out = await runAgentRecourseCommand('join', {}, d);
    const text = out.lines.join('\n');
    expect(out.exitCode).toBe(0);
    expect(out.result).toMatchObject({ status: 'review', signed: false, next_step: 'provian recourse join --yes' });
    expect(text).toContain('burn 11 PVT, plus contribute 2.5%');
    expect(text).toContain('approve once');
    expect(text).toContain('not refundable');
    expect(text).toContain('PVT only');
    expect(text).toContain('discretionary');
    expect(text).not.toMatch(/insurance|premium|\bfee\b|price|purchase/i);
    expect(d.beginTransition).not.toHaveBeenCalled();
    expect(d.authorize).not.toHaveBeenCalled();
  });

  it('RED control: the same command with --yes begins, approves and reports', async () => {
    const d = deps(status('not_member'));
    vi.mocked(d.readTransition).mockResolvedValueOnce(null).mockResolvedValueOnce(view('join', 'consenting', [challenge()])).mockResolvedValue(view('join', 'complete'));
    const out = await runAgentRecourseCommand('join', { yes: true }, d);
    expect(d.beginTransition).toHaveBeenCalledWith('join');
    expect(d.authorize).toHaveBeenCalledTimes(1);
    expect(out.result).toMatchObject({ status: 'joined', signed: true });
  });

  it('refuses to approve amounts above the rule shown', async () => {
    const d = deps(status('not_member'), { beginTransition: vi.fn(async () => view('join', 'consenting', [challenge({ burnLimit: parseUnits('12', 18).toString() })])) });
    const out = await runAgentRecourseCommand('join', { yes: true }, d);
    expect(out.result).toMatchObject({ code: 'AMOUNTS_CHANGED' });
    expect(d.authorize).not.toHaveBeenCalled();
  });

  it('a lapsed member with unpaid months is sent to rejoin; a challenge with rejoin months is refused under join', async () => {
    expect((await runAgentRecourseCommand('join', { yes: true }, deps(status('lapsed', '5')))).result).toMatchObject({ code: 'REJOIN_REQUIRED' });
    const months = [{ month: MAY_2026, burn: BURN, reserve: FLAT, ruleHash: h(9) }];
    const d = deps(status('not_member'), { beginTransition: vi.fn(async () => view('join', 'consenting', [challenge({ rejoinPayments: months })])) });
    expect((await runAgentRecourseCommand('join', { yes: true }, d)).result).toMatchObject({ code: 'REJOIN_REQUIRED' });
    expect(d.authorize).not.toHaveBeenCalled();
  });

  it('already protected: nothing to sign', async () => {
    const d = deps(status('protected'));
    expect((await runAgentRecourseCommand('join', { yes: true }, d)).result).toMatchObject({ status: 'already_member' });
    expect(d.beginTransition).not.toHaveBeenCalled();
  });
});

describe('rejoin', () => {
  const unpaid = (BigInt(BURN) + BigInt(FLAT)).toString();
  const months = [{ month: MAY_2026, burn: BURN, reserve: FLAT, ruleHash: h(9) }];
  it('shows the unpaid protected months without --yes, and approves them with --yes', async () => {
    const review = await runAgentRecourseCommand('rejoin', {}, deps(status('lapsed', unpaid)));
    expect(review.lines.join('\n')).toContain('To rejoin, first complete the unpaid protected months: 24 PVT.');
    const d = deps(status('lapsed', unpaid), { beginTransition: vi.fn(async () => view('join', 'consenting', [challenge({ rejoinPayments: months })])) });
    const out = await runAgentRecourseCommand('rejoin', { yes: true }, d);
    expect(d.authorize).toHaveBeenCalledTimes(1);
    expect(out.lines.join('\n')).toContain('2026-05: burn 11 PVT and contribute 13 PVT before rejoining.');
  });
  it('RED: rejoin months above the unpaid amount shown are refused', async () => {
    const d = deps(status('lapsed', BURN), { beginTransition: vi.fn(async () => view('join', 'consenting', [challenge({ rejoinPayments: months })])) });
    expect((await runAgentRecourseCommand('rejoin', { yes: true }, d)).result).toMatchObject({ code: 'AMOUNTS_CHANGED' });
    expect(d.authorize).not.toHaveBeenCalled();
  });
  it('rejoin is only for a lapsed membership', async () => {
    expect((await runAgentRecourseCommand('rejoin', { yes: true }, deps(status('not_member')))).result).toMatchObject({ code: 'NOT_LAPSED' });
  });
});

describe('leave', () => {
  it('without --yes signs nothing; with --yes retains the departure', async () => {
    const d = deps(status('protected'));
    expect((await runAgentRecourseCommand('leave', {}, d)).result).toMatchObject({ status: 'review', signed: false });
    expect(d.leave).not.toHaveBeenCalled();
    vi.mocked(d.readTransition).mockResolvedValueOnce(null).mockResolvedValue(view('leave', 'complete'));
    expect((await runAgentRecourseCommand('leave', { yes: true }, d)).result).toMatchObject({ status: 'left', signed: true });
    expect(d.beginTransition).toHaveBeenCalledWith('leave');
    expect(d.leave).toHaveBeenCalledTimes(1);
  });
  it('a non-member has nothing to leave', async () => {
    const d = deps(status('not_member'));
    expect((await runAgentRecourseCommand('leave', { yes: true }, d)).result).toMatchObject({ status: 'not_member' });
    expect(d.leave).not.toHaveBeenCalled();
  });
});

describe('report', () => {
  it('needs a chosen transaction', async () => {
    expect((await runAgentRecourseCommand('report', { yes: true }, deps(status('protected')))).result).toMatchObject({ code: 'MISSING_TX' });
  });
  it('without --yes reviews the transfer and submits nothing', async () => {
    const d = deps(status('protected'));
    const out = await runAgentRecourseCommand('report', { tx: h(1) }, d);
    expect(out.lines.join('\n')).toContain('I did not authorize this transfer of 42.5 PVT.');
    expect(d.resolveTransfer).toHaveBeenCalledWith(h(1), undefined);
    expect(d.submitRestoration).not.toHaveBeenCalled();
  });
  it('RED control: with --yes the restoration path receives the chosen transaction and its verified block', async () => {
    const d = deps(status('protected'));
    const out = await runAgentRecourseCommand('report', { tx: h(1), to: THIEF, yes: true }, d);
    expect(d.resolveTransfer).toHaveBeenCalledWith(h(1), THIEF);
    expect(d.submitRestoration).toHaveBeenCalledWith(expect.objectContaining({ transactionHash: h(1), block: 99_000 }));
    expect(out.result).toMatchObject({ status: 'reported', restoration_request_id: h(55) });
  });
  it('a chain refusal surfaces as an error code, never a silent success', async () => {
    const d = deps(status('protected'), { resolveTransfer: vi.fn(async () => { throw Error('recourse_transfer_not_outgoing: no'); }) });
    const out = await runAgentRecourseCommand('report', { tx: h(1), yes: true }, d);
    expect(out.exitCode).toBe(1);
    expect(out.result).toMatchObject({ code: 'recourse_transfer_not_outgoing' });
    expect(d.submitRestoration).not.toHaveBeenCalled();
  });
});

describe('requests', () => {
  it('lists newest first', async () => {
    const raw = { requests: [
      { requestId: h(1), identity: h(5), status: 'pending_review', transactionHash: h(2), reversalTransactionHash: null, destination: ME, createdAtMs: 1 },
      { requestId: h(3), identity: h(5), status: 'restored', transactionHash: h(4), reversalTransactionHash: h(6), destination: ME, createdAtMs: 2 }] };
    const out = await runAgentRecourseCommand('requests', {}, deps(status('protected'), { readRequests: vi.fn(async () => raw) }));
    expect((out.result.requests as { request_id: string }[]).map(r => r.request_id)).toEqual([h(3), h(1)]);
    expect(() => parseRestorationRequests({ requests: [{ requestId: 'x' }] })).toThrow('recourse_reply_invalid');
  });
});

describe('the recourse CLI', () => {
  it('parses subcommands and flags; refuses unknown options', () => {
    expect(parseRecourseArgs(['report', '--tx', h(1), '--yes', '--json'])).toMatchObject({ sub: 'report', json: true, options: { tx: h(1), yes: true } });
    expect(parseRecourseArgs(['transfers', '--before=500', '--window', '100'])).toMatchObject({ options: { beforeBlock: 500, windowBlocks: 100 } });
    expect(() => parseRecourseArgs(['join', '--private-key', 'x'])).toThrow(/Unknown option/);
    expect(() => parseRecourseArgs(['transfers', '--limit', '0'])).toThrow(/whole number/);
  });
  it('prints JSON and exits 0 on success, 1 on refusal', async () => {
    const out: string[] = [], err: string[] = [];
    const io = { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
    expect(await runRecourseCli(['status', '--json'], io, () => deps(status('protected')))).toBe(0);
    expect(JSON.parse(out[0])).toMatchObject({ status: 'recourse_status' });
    expect(await runRecourseCli(['report', '--json'], io, () => deps(status('protected')))).toBe(1);
    expect(JSON.parse(err[0])).toMatchObject({ code: 'MISSING_TX' });
    expect(await runRecourseCli([], io, () => deps(status('protected')))).toBe(2);
  });
});

describe('loadRecourseIdentity', () => {
  it('reads credentials from the directory; signing without a keystore is refused before any relay call', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recourse-id-'));
    fs.writeFileSync(path.join(dir, 'agent-credentials.json'), JSON.stringify({ api_key: `pvn_live_${'a'.repeat(32)}`, api_secret: `pvns_${'b'.repeat(64)}`,
      wallet_id: 'wallet_aw_test', address: ME }), { mode: 0o600 });
    const id = loadRecourseIdentity({ directory: dir, env: {} });
    expect(id).toMatchObject({ walletId: 'wallet_aw_test', address: ME, keystore: null });
    const fetchSpy = vi.fn();
    const d = defaultAgentRecourseDeps({ ...id, config: { ...id.config, fetch: fetchSpy } }, (s: string) => s);
    await expect(d.leave(view('leave', 'consenting'))).rejects.toThrow(/needs the agent keystore/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(() => loadRecourseIdentity({ directory: path.join(dir, 'missing'), env: {} })).toThrow(/No agent credentials/);
  });
});
