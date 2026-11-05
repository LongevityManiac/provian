import { describe, expect, it, jest } from '@jest/globals';

jest.mock('../agent-bank/pvt-principal-config', () => ({ getPvtAddressForChain: () => null }));
jest.mock('../onchain/tx-verifier', () => ({ readErc20TotalSupply: async () => null }));

import { getInstitutionsStats, getCourtStats } from './feed';
import type { CommonsDeps } from './types';

type Row = Record<string, unknown> & { id: string };

/** Minimal Firestore double: equality filters honoured, doc ids from the row's `id`. */
function deps(fixtures: Record<string, Row[]>): CommonsDeps {
  return {
    db: {
      collection(name: string) {
        const eq: Array<[string, unknown]> = [];
        const q: Record<string, unknown> = {};
        q.where = (field: string, op: string, value: unknown) => { if (op === '==') eq.push([field, value]); return q; };
        q.count = () => ({ get: async () => ({ data: () => ({ count: (fixtures[name] ?? []).filter((r) => eq.every(([f, v]) => r[f] === v)).length }) }) });
        q.get = async () => ({
          docs: (fixtures[name] ?? [])
            .filter((r) => eq.every(([f, v]) => r[f] === v))
            .map((r) => ({ id: r.id, data: () => r })),
        });
        return q;
      },
    },
    cache: { get: async () => null, set: async () => undefined },
  } as unknown as CommonsDeps;
}

const AGENTS: Row[] = [
  { id: 'wallet_aw_atlas', platform: 'sdk' },
  { id: 'wallet_aw_testfixture', platform: 'test' },
  { id: 'wallet_aw_hidden', platform: 'sdk', public_visibility: 'hidden_prelaunch_test' },
];

const ESCROWS: Row[] = [
  { id: 'e1', status: 'funded', amount_usdc: 10, depositor_wallet_id: 'user_frank', recipient_wallet_id: 'wallet_aw_atlas' },
  { id: 'e2', status: 'funded', amount_usdc: 500, depositor_wallet_id: 'wallet_aw_testfixture', recipient_wallet_id: 'wallet_aw_atlas' },
  { id: 'e3', status: 'completed', amount_usdc: 700, depositor_wallet_id: 'wallet_aw_atlas', recipient_wallet_id: 'wallet_aw_hidden' },
  { id: 'e4', status: 'completed', amount_usdc: 5, depositor_wallet_id: 'wallet_aw_atlas', recipient_wallet_id: 'user_frank' },
];

describe('getInstitutionsStats — display filter', () => {
  it('RED: escrows with a test or display-hidden fixture agent on either side are not counted', async () => {
    const stats = await getInstitutionsStats(deps({ agent_wallets: AGENTS, escrows: ESCROWS }));
    expect(stats.total_escrow_value_usd).toBe(15);
    expect(stats.active_escrows).toBe(1);
    expect(stats.completed_escrows).toBe(1);
  });

  it('CONTROL: without the fixture markers every escrow counts (the filter is what removes them)', async () => {
    const unmarked = AGENTS.map(({ platform: _p, public_visibility: _v, ...rest }) => ({ ...rest, platform: 'sdk' }));
    const stats = await getInstitutionsStats(deps({ agent_wallets: unmarked, escrows: ESCROWS }));
    expect(stats.total_escrow_value_usd).toBe(1215);
    expect(stats.active_escrows).toBe(2);
    expect(stats.completed_escrows).toBe(2);
  });
});

it('aggregate counters preserve mixed statuses, missing statuses and exact resolution rate', async () => {
  const stats = await getInstitutionsStats(deps({
    promises: [{ id: '1', status: 'funded' }, { id: '2', status: 'settled' }, { id: '3', status: 'settled' }, { id: '4' }],
    pools: [{ id: '1', status: 'active' }, { id: '2', status: 'ended' }, { id: '3' }],
  }));
  expect(stats).toMatchObject({ promises_outstanding: 1, promises_settled: 2, active_pools: 1 });
  const court = await getCourtStats(deps({
    court_disputes: [{ id: '1', status: 'resolved' }, { id: '2', status: 'escalated' }, { id: '3' }],
    arbitrators: [{ id: '1', status: 'active' }, { id: '2', status: 'retired' }],
  }));
  expect(court).toMatchObject({ total_cases: 3, cases_resolved: 1, cases_escalated: 1, resolution_rate: 1 / 3, active_arbitrators: 1 });
  expect((await getCourtStats(deps({}))).resolution_rate).toBe(0);
});
