/**
 * getMarketplace behavior tests.
 *
 * removed the governance layer: the Wave-4 HIGH-6 mechanic this file once
 * covered — the live borrower governance-score pull, the `min_governance_score`
 * marketplace filter / fund-gate, the `live_governance_score` field, the
 * `governance_desc` sort, and `GovernanceSlashedError` is GONE. getMarketplace
 * no longer reads agent_wallets and takes no governance option, and fundPromise
 * no longer takes an options arg. These tests pin the SURVIVING behavior of
 * getMarketplace: it lists open promises, applies the max_amount filter, sorts
 * by implied rate, and paginates.
 */

import { describe, it, expect } from '@jest/globals';
import { getMarketplace } from './promises';

/**
 * A fake Firestore whose `promises` collection returns the seeded open-promise
 * docs. getMarketplace reads ONLY this collection now (no agent_wallets lookup).
 */
function makeMarketplaceDb(promises: Record<string, unknown>[]): any {
  return {
    collection(name: string) {
      const chain = {
        where() { return chain; },
        orderBy() { return chain; },
        limit() { return chain; },
        async get() {
          if (name === 'promises') {
            return { docs: promises.map((p) => ({ data: () => p })) };
          }
          return { docs: [] };
        },
      };
      return chain;
    },
  };
}

function usdcPromise(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    promise_id: 'p_default',
    borrower_wallet_id: 'wallet_aw_borrower',
    status: 'open',
    principal_usdc: 100,
    repay_usdc: 110,
    currency: 'usdc',
    created_at: 1,
    ...overrides,
  };
}

describe('getMarketplace', () => {
  it('lists open promises with a total count', async () => {
    const db = makeMarketplaceDb([
      usdcPromise({ promise_id: 'p_a', created_at: 2 }),
      usdcPromise({ promise_id: 'p_b', created_at: 1 }),
    ]);
    const result = await getMarketplace({ db } as any, {});
    expect(result.total).toBe(2);
    expect(result.promises).toHaveLength(2);
    expect(result.promises.map((p) => p.promise_id).sort()).toEqual(['p_a', 'p_b']);
  });

  it('filters out USDC promises above max_amount', async () => {
    const db = makeMarketplaceDb([
      usdcPromise({ promise_id: 'p_small', principal_usdc: 50 }),
      usdcPromise({ promise_id: 'p_big', principal_usdc: 500 }),
    ]);
    const result = await getMarketplace({ db } as any, { max_amount: 100 });
    expect(result.total).toBe(1);
    expect(result.promises[0].promise_id).toBe('p_small');
  });

  it('sorts by implied rate ascending under sort=rate_asc', async () => {
    const db = makeMarketplaceDb([
      // 20% implied rate (100 → 120)
      usdcPromise({ promise_id: 'p_expensive', principal_usdc: 100, repay_usdc: 120 }),
      // 5% implied rate (100 → 105)
      usdcPromise({ promise_id: 'p_cheap', principal_usdc: 100, repay_usdc: 105 }),
    ]);
    const result = await getMarketplace({ db } as any, { sort: 'rate_asc' });
    expect(result.promises[0].promise_id).toBe('p_cheap');
    expect(result.promises[1].promise_id).toBe('p_expensive');
  });

  it('paginates the result set', async () => {
    const db = makeMarketplaceDb([
      usdcPromise({ promise_id: 'p_1' }),
      usdcPromise({ promise_id: 'p_2' }),
      usdcPromise({ promise_id: 'p_3' }),
    ]);
    const result = await getMarketplace({ db } as any, { page: 2, limit: 2 });
    // total reflects the full set; the page returns the remainder.
    expect(result.total).toBe(3);
    expect(result.promises).toHaveLength(1);
    expect(result.promises[0].promise_id).toBe('p_3');
  });
});
