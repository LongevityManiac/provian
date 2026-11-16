/**
 * `provian recourse …` — mirrors the SDK bin through the same SDK module, with every
 * dependency injected. Nothing is signed without --yes (RED controls below).
 */
import { describe, expect, it, vi } from 'vitest';
import { RecourseIdentityError, type AgentRecourseDeps, type AgentRecourseStatus } from '@provian/agent-sdk';
import { cmdRecourse } from './recourse-commands';
import { parseArgs } from './parse-args';

const h = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const ME = '0x1111111111111111111111111111111111111111';
const STATUS: AgentRecourseStatus = {
  identity: h(5), pool: '0x92e9c83d00000000000000000000000000000001', kernel: '0x2af3a065dc3c0c51b054cb8c6baee7df76189e0e',
  reserveAtomic: '0', pendingAction: null,
  rule: { month: String(2026 * 12 + 5), participationBurnAtomic: '3000000000000000000', noEarningsContributionAtomic: '7000000000000000000', earningsBps: 150, ruleHash: h(9) },
  membership: { status: 'lapsed', enrolled: false, grace: false, protectionStartedAtMs: null, nextMonthAtMs: null, nextBurnAtomic: null,
    nextNoEarningsContributionAtomic: null, earningsBps: null, unpaidAtomic: '10000000000000000000' },
};

function deps(over: Partial<AgentRecourseDeps> = {}): AgentRecourseDeps {
  return {
    address: ME,
    readStatus: vi.fn(async () => STATUS),
    readTransition: vi.fn(async () => null),
    beginTransition: vi.fn(),
    authorize: vi.fn(),
    leave: vi.fn(),
    listTransfers: vi.fn(async () => ({ account: ME, kernel: STATUS.kernel, fromBlock: 1, toBlock: 10, nextBeforeBlock: null,
      transfers: [{ transactionHash: h(1), from: ME, to: '0x2222222222222222222222222222222222222222', amount: '4.0', timestamp: 0, block: 7 }] })),
    resolveTransfer: vi.fn(),
    submitRestoration: vi.fn(),
    readRequests: vi.fn(async () => ({ requests: [] })),
    sleep: vi.fn(async () => undefined),
    command: (sub: string) => `provian ${sub}`,
    ...over,
  };
}
const flagsOf = (argv: string[]) => parseArgs(['node', 'provian', ...argv]);

describe('provian recourse', () => {
  it('status reports the lapsed state and the unpaid amount to complete before rejoining', async () => {
    const { subcommand, flags } = flagsOf(['recourse', 'status']);
    const out = await cmdRecourse(subcommand, flags, () => deps());
    expect(out).toMatchObject({ status: 'recourse_status', membership: { status: 'lapsed', unpaid_pvt: '10' }, next_step: 'provian recourse rejoin' });
    expect((out.summary as string[]).join('\n')).toContain('To rejoin, first complete the unpaid protected months: 10 PVT.');
  });

  it('rejoin without --yes prints the terms and signs nothing', async () => {
    const d = deps();
    const { subcommand, flags } = flagsOf(['recourse', 'rejoin']);
    const out = await cmdRecourse(subcommand, flags, () => d);
    expect(out).toMatchObject({ status: 'review', signed: false, next_step: 'provian recourse rejoin --yes' });
    expect(d.beginTransition).not.toHaveBeenCalled();
    expect(d.authorize).not.toHaveBeenCalled();
  });

  it('RED control: rejoin --yes reaches the membership transition', async () => {
    const d = deps({ beginTransition: vi.fn(async () => ({ id: h(4), kind: 'join' as const, status: 'preparing' as const, challenges: [], pending: [] })) });
    const { subcommand, flags } = flagsOf(['recourse', 'rejoin', '--yes']);
    const out = await cmdRecourse(subcommand, flags, () => d);
    expect(d.beginTransition).toHaveBeenCalledWith('join');
    expect(out).toMatchObject({ status: 'in_progress', signed: false });
  });

  it('transfers passes the scan flags through', async () => {
    const d = deps();
    const { subcommand, flags } = flagsOf(['recourse', 'transfers', '--before', '500', '--window=100']);
    const out = await cmdRecourse(subcommand, flags, () => d);
    expect(d.listTransfers).toHaveBeenCalledWith({ beforeBlock: 500, windowBlocks: 100, windows: undefined, limit: undefined });
    expect(out).toMatchObject({ status: 'transfers', transfers: [{ transaction_hash: h(1), block: 7 }] });
  });

  it('a missing identity and a bad number are refused before any relay call', async () => {
    const { subcommand, flags } = flagsOf(['recourse', 'status', '--directory', '/nope']);
    const out = await cmdRecourse(subcommand, flags, () => { throw new RecourseIdentityError('No agent credentials in /nope', 'NO_CREDENTIALS'); });
    expect(out).toMatchObject({ status: 'error', code: 'NO_CREDENTIALS' });
    const bad = flagsOf(['recourse', 'transfers', '--limit', '0']);
    expect(await cmdRecourse(bad.subcommand, bad.flags, () => deps())).toMatchObject({ code: 'USAGE' });
    expect(await cmdRecourse(null, {}, () => deps())).toMatchObject({ status: 'error' });
  });
});
