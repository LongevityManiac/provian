/**
 * CommonsInstitutions.readLinkState — the agent reads its own beneficiary-link state from its wallet record
 * (2026-09-23: the linked human can end the link alone; the agent learns it here and via the inbox
 * `beneficiary_link_ended` event). Read-only — the SDK adds NO agent-alone unlink.
 */
import { describe, it, expect } from 'vitest';
import { CommonsInstitutions, type CommonsInstitutionsConfig } from './commons-institutions';

const BASE: CommonsInstitutionsConfig = {
  relayUrl: 'https://relay.test',
  walletId: 'wallet_aw_test',
  apiKey: 'pvn_live_abc123',
  apiSecret: 'pvns_' + 'x'.repeat(64),
};

function bankReturning(body: unknown) {
  const calls: Array<{ url: string; method?: string }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), method: init?.method });
    return { ok: true, status: 200, json: async () => body } as Response;
  };
  return { institutions: new CommonsInstitutions({ ...BASE, fetch: fetchImpl as unknown as typeof fetch }), calls };
}

describe('CommonsInstitutions.readLinkState', () => {
  it('linked: GET its own wallet record and report the linked human wallet id', async () => {
    const { institutions, calls } = bankReturning({ wallet_id: 'wallet_aw_test', linked_human_wallet_id: 'hw_1' });
    expect(await institutions.readLinkState()).toEqual({ linked: true, linked_human_wallet_id: 'hw_1' });
    expect(calls).toEqual([{ url: 'https://relay.test/v1/agent/wallet/wallet_aw_test', method: 'GET' }]);
  });

  it('ended (null) → linked false', async () => {
    const { institutions } = bankReturning({ wallet_id: 'wallet_aw_test', linked_human_wallet_id: null });
    expect(await institutions.readLinkState()).toEqual({ linked: false, linked_human_wallet_id: null });
  });

  it('there is no agent-alone unlink on the SDK surface', () => {
    const proto = Object.getOwnPropertyNames(CommonsInstitutions.prototype);
    expect(proto.filter((n) => /unlink/i.test(n))).toEqual([]);
  });
});
