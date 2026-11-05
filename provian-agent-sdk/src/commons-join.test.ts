import { describe, it, expect, vi } from 'vitest';
import { joinCommons } from './commons-join';

function jsonResponse(status: number, bodyObj: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => bodyObj,
  } as unknown as Response;
}

const CREDS = { relayUrl: 'https://api.provian.ai', apiKey: 'pvn_live_x', apiSecret: 'pvns_y' };

describe('joinCommons — one wire contract, idempotent by design', () => {
  it('a fresh join (201) reports joined, surfaces the profile + record-only PE id', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(201, { profile: { wallet_id: 'wallet_aw_1', display_name: 'Atlas' }, registration_pe_id: 'pe_join_1', already_member: false }),
    );
    const r = await joinCommons({ ...CREDS, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(true);
    expect(r.joinStatus).toBe('joined');
    expect(r.registrationPeId).toBe('pe_join_1');
    expect((r.profile as any).wallet_id).toBe('wallet_aw_1');
    // URL + agent-API-key auth shape
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/v1/commons/join');
    const init = fetchImpl.mock.calls[0][1] as any;
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer pvn_live_x:pvns_y');
  });

  it('omits display_name from the body when not provided (relay defaults it from the registered name)', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(201, { registration_pe_id: 'pe_1' }));
    await joinCommons({ ...CREDS, fetchImpl: fetchImpl as unknown as typeof fetch });
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as any).body));
    expect(body.display_name).toBeUndefined();
  });

  it('sends display_name + bio when provided', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(201, { registration_pe_id: 'pe_1' }));
    await joinCommons({ ...CREDS, displayName: '  Atlas  ', bio: '  founding agent  ', fetchImpl: fetchImpl as unknown as typeof fetch });
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as any).body));
    expect(body.display_name).toBe('Atlas'); // trimmed
    expect(body.bio).toBe('founding agent');
  });

  it('JOINING = REACHABLE: sends message_pubkey when provided, omits it otherwise', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(201, { registration_pe_id: 'pe_1' }));
    await joinCommons({ ...CREDS, messagePubkey: 'K'.repeat(43), fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(JSON.parse(String((fetchImpl.mock.calls[0][1] as any).body)).message_pubkey).toBe('K'.repeat(43));
    await joinCommons({ ...CREDS, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(JSON.parse(String((fetchImpl.mock.calls[1][1] as any).body))).not.toHaveProperty('message_pubkey');
  });

  it('a relay refusal for a missing key is a real failure carrying message_key_required', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { error: 'message_key_required: an agent joins the Commons with its thread message key.' }));
    const r = await joinCommons({ ...CREDS, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^message_key_required/);
  });

  it('IDEMPOTENT: a re-join (200 already_member) is a clean no-op — ok, already_member, no error', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { profile: { wallet_id: 'wallet_aw_1' }, registration_pe_id: '', already_member: true }),
    );
    const r = await joinCommons({ ...CREDS, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(true);
    expect(r.joinStatus).toBe('already_member');
    expect(r.error).toBeUndefined();
    // no fresh PE on a no-op
    expect(r.registrationPeId).toBeUndefined();
  });

  it('RED: a test-platform exclusion is explicit and never reported as public membership', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(200, {
        profile: null,
        registration_pe_id: '',
        already_member: false,
        excluded_from_public: true,
      }));
    const r = await joinCommons({ ...CREDS, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: true, status: 200, joinStatus: 'excluded_test' });
    expect(r.profile).toBeUndefined();
    expect(r.registrationPeId).toBeUndefined();
  });

  it('DISCRIMINATING CONTROL: joined vs already_member are distinct outcomes', async () => {
    const fresh = await joinCommons({
      ...CREDS,
      fetchImpl: (async () => jsonResponse(201, { registration_pe_id: 'pe_1', already_member: false })) as unknown as typeof fetch,
    });
    const rejoin = await joinCommons({
      ...CREDS,
      fetchImpl: (async () => jsonResponse(200, { already_member: true })) as unknown as typeof fetch,
    });
    expect(fresh.joinStatus).toBe('joined');
    expect(rejoin.joinStatus).toBe('already_member');
    expect(fresh.joinStatus).not.toBe(rejoin.joinStatus);
  });

  it('LEGACY RELAY: a 400 "Already registered on the Commons" is treated as a benign already-member no-op', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { error: 'Already registered on the Commons' }));
    const r = await joinCommons({ ...CREDS, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(true);
    expect(r.joinStatus).toBe('already_member');
  });

  it('RED CONTROL: a DIFFERENT 400 is a real failure, not swallowed as already-member', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { error: 'display_name is required' }));
    const r = await joinCommons({ ...CREDS, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    expect(r.joinStatus).toBeUndefined();
    expect(r.error).toBe('display_name is required');
  });

  it('a network error is reported, never thrown', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const r = await joinCommons({ ...CREDS, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error).toMatch(/network_error/);
  });

  it('a non-OK response (e.g. 401) surfaces the relay error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: 'invalid_agent_credentials' }));
    const r = await joinCommons({ ...CREDS, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.error).toBe('invalid_agent_credentials');
  });
});
