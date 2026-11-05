/**
 * The PVT read endpoints change their PRE-FLIP status code, and the client must
 * not notice.
 *
 * Before the runtime boundary PVT read-surface ruling those endpoints were unmounted, so the
 * runtime boundary runtime boundary answered 503 `PVT9_DEPENDENCY_UNAVAILABLE` and the client
 * recognised 503 as "feature not active". They are mounted now, each behind its
 * own `PUBLIC_LAUNCH` gate, so until the flip they answer **404**. Same meaning,
 * different number — and a client that recognised only 503 would turn a
 * gracefully-empty Abundance screen into a wrong one: `getPVTAllocation` would
 * return `null` instead of the `coming_soon` marker, and the dashboard would
 * render "0 sealed record points" as if that were the user's real balance.
 *
 * All five call sites are covered, including the three that already degraded on
 * any non-2xx — those needed no change, and this pins that they still don't.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// NotificationService pulls in expo-notifications/expo-constants, which fail
// under the node test env and are irrelevant to these reads.
vi.mock('../NotificationService', () => ({ default: {} }));

import RelayAPIService from '../RelayAPIService';

type AuthFetch = (endpoint: string, options?: RequestInit, retryOnAuth?: boolean) => Promise<Response>;
const svc = RelayAPIService as unknown as { makeAuthenticatedRequest: AuthFetch };

function fakeResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
  } as unknown as Response;
}

/** Both codes mean "not active here": 503 pre-mount, 404 post-mount pre-flip. */
const NOT_ACTIVE_STATUSES = [503, 404] as const;

const CALL_SITES: ReadonlyArray<{
  label: string;
  call: () => Promise<unknown>;
  /** What "gracefully degraded" looks like for this endpoint. */
  expected: unknown;
}> = [
  { label: 'getPVTAllocation', call: () => RelayAPIService.getPVTAllocation('user-1'), expected: { coming_soon: true } },
  { label: 'getPVTMilestones', call: () => RelayAPIService.getPVTMilestones(), expected: null },
  { label: 'getPVTWeights', call: () => RelayAPIService.getPVTWeights(), expected: null },
  { label: 'getPVTMintingHistory', call: () => RelayAPIService.getPVTMintingHistory(), expected: null },
  { label: 'getPVTBalance', call: () => RelayAPIService.getPVTBalance('0xabc'), expected: null },
];

describe('PVT reads degrade identically on 503 and 404', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('covers all five call sites — the population this suite quantifies over', () => {
    expect(CALL_SITES).toHaveLength(5);
    expect(NOT_ACTIVE_STATUSES).toHaveLength(2);
  });

  it.each(
    CALL_SITES.flatMap((site) => NOT_ACTIVE_STATUSES.map((status) => [`${site.label} @ ${status}`, site, status] as const)),
  )('%s degrades without throwing', async (_label, site, status) => {
    vi.spyOn(svc, 'makeAuthenticatedRequest').mockResolvedValue(fakeResponse(status));
    await expect(site.call()).resolves.toEqual(site.expected);
  });

  it('the two codes produce the SAME result at every call site', async () => {
    for (const site of CALL_SITES) {
      const results: unknown[] = [];
      for (const status of NOT_ACTIVE_STATUSES) {
        vi.spyOn(svc, 'makeAuthenticatedRequest').mockResolvedValue(fakeResponse(status));
        results.push(await site.call());
      }
      expect(results[0]).toEqual(results[1]);
    }
  });

  /**
   * NEGATIVE CONTROL. The assertions above would pass identically if every call
   * site simply returned `null` for everything — including for a genuine 200.
   * A status the client must NOT read as "not active" has to produce a
   * different answer, and `getPVTAllocation` is the one whose two branches
   * differ, so it is the one that can show it.
   */
  it('NEGATIVE CONTROL: a 500 is not "not active", and a 200 is not either', async () => {
    vi.spyOn(svc, 'makeAuthenticatedRequest').mockResolvedValue(fakeResponse(500));
    await expect(RelayAPIService.getPVTAllocation('user-1')).resolves.toBeNull();

    vi.spyOn(svc, 'makeAuthenticatedRequest').mockResolvedValue(fakeResponse(200));
    await expect(RelayAPIService.getPVTAllocation('user-1')).resolves.toEqual({});
  });
});
