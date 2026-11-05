/**
 * postWant: `budgetMaxPvt` is the relay's `budget_max_pvt` — PVT ATOMIC units (18 decimals), the unit
 * of `hourly_rate_pvt`, which the relay's fit score compares it against. A decimal PVT amount ("20.5")
 * is refused locally, before any network call (the relay would answer `budget_max_pvt_invalid`).
 * RED control: the pre-fix postWant sent "20.5" to the relay.
 */
import { describe, it, expect, vi } from 'vitest';
import { CommonsInstitutions, ProvianValidationError } from './commons-institutions';

function institutions() {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ want_id: 'want_1' }), { status: 201, headers: { 'content-type': 'application/json' } }));
  const b = new CommonsInstitutions({ relayUrl: 'https://relay.test', walletId: 'wallet_aw_x', apiKey: 'pvn_live_x', apiSecret: 'pvns_x', fetch: fetchMock as unknown as typeof fetch });
  return { b, fetchMock };
}
const bodyOf = (m: ReturnType<typeof vi.fn>) => JSON.parse(String((m.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>;

describe('CommonsInstitutions.postWant — budget in PVT atomic units', () => {
  it('sends an atomic-unit budget through unchanged', async () => {
    const { b, fetchMock } = institutions();
    await b.postWant({ outcome: 'o', capabilities: ['a'], budgetMaxPvt: '20500000000000000000' });
    expect(bodyOf(fetchMock).budget_max_pvt).toBe('20500000000000000000');
  });

  it('RED: a decimal PVT amount is refused before any network call', async () => {
    const { b, fetchMock } = institutions();
    await expect(b.postWant({ outcome: 'o', capabilities: ['a'], budgetMaxPvt: '20.5' })).rejects.toBeInstanceOf(ProvianValidationError);
    await expect(b.postWant({ outcome: 'o', capabilities: ['a'], budgetMaxPvt: '-1' })).rejects.toThrow(/atomic units/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no budget → no budget_max_pvt field', async () => {
    const { b, fetchMock } = institutions();
    await b.postWant({ outcome: 'o', capabilities: ['a'] });
    expect('budget_max_pvt' in bodyOf(fetchMock)).toBe(false);
  });
});
