/**
 * CommonsInstitutions.joinCommons — the typed helper that makes the SDK's advertised
 * "typed helpers for the join flow" real. Delegates to the shared
 * src/commons-join.ts wrapper; idempotent; agent joins itself with its own key.
 */

import { describe, it, expect } from 'vitest';
import {
  CommonsInstitutions,
  ProvianAuthError,
  ProvianNetworkError,
  type CommonsInstitutionsConfig,
} from './commons-institutions';
import { deriveMessageKeyPair } from './thread-crypto';

interface CapturedCall { url: string; method?: string; body?: unknown; headers?: Record<string, string>; }

function makeMockFetch(responder: (call: CapturedCall) => { status?: number; body: unknown }) {
  const calls: CapturedCall[] = [];
  const mockFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let parsed: unknown = undefined;
    if (typeof init?.body === 'string') {
      try { parsed = JSON.parse(init.body); } catch { parsed = init.body; }
    }
    const call: CapturedCall = {
      url: String(url), method: init?.method, body: parsed,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
    };
    calls.push(call);
    const { status = 200, body } = responder(call);
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  };
  return { mockFetch, calls };
}

const BASE_CONFIG: CommonsInstitutionsConfig = {
  relayUrl: 'https://relay.test',
  walletId: 'wallet_aw_test',
  apiKey: 'pvn_live_abc123',
  apiSecret: 'pvns_' + 'x'.repeat(64),
};

describe('CommonsInstitutions.joinCommons', () => {
  it('JOINING = REACHABLE: privateKeyHex derives the message key that rides the join (the key itself never does)', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ status: 201, body: { registration_pe_id: 'pe_join' } }));
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch as unknown as typeof fetch });
    const priv = '4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d';
    await institutions.joinCommons({ privateKeyHex: priv });
    expect((calls[0].body as Record<string, unknown>).message_pubkey).toBe(deriveMessageKeyPair(priv).pubkeyB64u);
    expect(JSON.stringify(calls[0].body)).not.toContain(priv);
    await institutions.joinCommons({ messagePubkey: 'Q'.repeat(43) });
    expect((calls[1].body as Record<string, unknown>).message_pubkey).toBe('Q'.repeat(43));
  });

  it('a fresh join (201) hits POST /v1/commons/join with agent-key auth and returns joined', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({
      status: 201,
      body: { profile: { wallet_id: 'wallet_aw_test' }, registration_pe_id: 'pe_join', already_member: false },
    }));
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch as unknown as typeof fetch });
    const r = await institutions.joinCommons({ displayName: 'Atlas' });
    expect(r.joinStatus).toBe('joined');
    expect(r.alreadyMember).toBe(false);
    expect(r.registrationPeId).toBe('pe_join');
    expect(calls[0].url).toBe('https://relay.test/v1/commons/join');
    expect(calls[0].method).toBe('POST');
    expect((calls[0].headers ?? {}).Authorization).toBe(`Bearer ${BASE_CONFIG.apiKey}:${BASE_CONFIG.apiSecret}`);
    expect((calls[0].body as any).display_name).toBe('Atlas');
  });

  it('IDEMPOTENT: a re-join (200 already_member) returns alreadyMember, does not throw', async () => {
    const { mockFetch } = makeMockFetch(() => ({ status: 200, body: { already_member: true } }));
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch as unknown as typeof fetch });
    const r = await institutions.joinCommons();
    expect(r.joinStatus).toBe('already_member');
    expect(r.alreadyMember).toBe(true);
  });

  it('RED: a test-platform exclusion is not misreported as a joined public profile', async () => {
    const { mockFetch } = makeMockFetch(() => ({
      status: 200,
      body: { excluded_from_public: true, already_member: false, profile: null },
    }));
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch as unknown as typeof fetch });
    const r = await institutions.joinCommons();
    expect(r.joinStatus).toBe('excluded_test');
    expect(r.alreadyMember).toBe(false);
    expect(r.profile).toBeUndefined();
  });

  it('omits display_name when not provided (relay defaults it)', async () => {
    const { mockFetch, calls } = makeMockFetch(() => ({ status: 201, body: { registration_pe_id: 'pe_1' } }));
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch as unknown as typeof fetch });
    await institutions.joinCommons();
    expect((calls[0].body as any).display_name).toBeUndefined();
  });

  it('RED CONTROL: a 401 throws ProvianAuthError', async () => {
    const { mockFetch } = makeMockFetch(() => ({ status: 401, body: { error: 'invalid_agent_credentials' } }));
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch as unknown as typeof fetch });
    await expect(institutions.joinCommons()).rejects.toBeInstanceOf(ProvianAuthError);
  });

  it('RED CONTROL: a 500 throws ProvianNetworkError', async () => {
    const { mockFetch } = makeMockFetch(() => ({ status: 500, body: { error: 'server_error' } }));
    const institutions = new CommonsInstitutions({ ...BASE_CONFIG, fetch: mockFetch as unknown as typeof fetch });
    await expect(institutions.joinCommons()).rejects.toBeInstanceOf(ProvianNetworkError);
  });
});
