/**
 * fleet onboarding, SDK side.
 *
 * - issueFleetCode: the one implementation behind CommonsInstitutions.issueFleetCode, the
 * `fleet-code` bin and the hosted bundle's `fleet-code` verb.
 * - requestLink: a fleet-code link comes back `linked` / `fleet_code`.
 * - renderBootstrapOutcome: prints "Linked to your human (fleet code)" instead
 * of "tap Accept", and the fleet wording beside the self-reporting block.
 */

import { describe, it, expect, vi } from 'vitest';
import { issueFleetCode, friendlyFleetCodeError } from './fleet-code';
import { requestLink } from './request-link';
import { renderBootstrapOutcome, fleetOnboardingLines, FLEET_ONBOARDING_LINE, type BootstrapResult } from './bootstrap-flow';
import { CommonsInstitutions } from './commons-institutions';
import { BOOTSTRAP_VERBS, resolveBootstrapVerb } from './scripts/bootstrap';

function fakeFetch(status: number, body: unknown, capture?: (url: string, init: RequestInit) => void) {
  return vi.fn(async (url: string, init: RequestInit) => {
    capture?.(url, init);
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

const CODE = 'PROV-HJKM-2345';
const ISSUED = {
  code: CODE,
  expires_at: 1_900_000_000_000,
  install_line: {
    sh: `curl -sSL -H 'x-provian-token: ${CODE}' "https://api.provian.ai/v1/bootstrap/agent" | sh`,
    powershell: `irm -Headers @{'x-provian-token'='${CODE}';'x-provian-platform'='windows'} "https://api.provian.ai/v1/bootstrap/agent" | iex`,
  },
};
const CREDS = { relayUrl: 'https://api.provian.ai/', walletId: 'wallet_aw_main', apiKey: 'pvn_live_key', apiSecret: 'pvns_secret' };

describe('issueFleetCode', () => {
  it('POSTs agent API auth to /v1/agent/wallet/:id/fleet-code with a body, and returns the code + install lines', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const r = await issueFleetCode({ ...CREDS, fetchImpl: fakeFetch(201, ISSUED, (url, init) => { seen = { url, init }; }) });
    expect(r).toEqual({ ok: true, status: 201, code: CODE, expiresAt: ISSUED.expires_at, installLine: ISSUED.install_line });
    expect(seen!.url).toBe('https://api.provian.ai/v1/agent/wallet/wallet_aw_main/fleet-code');
    expect(seen!.init.method).toBe('POST');
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe('Bearer pvn_live_key:pvns_secret');
    expect(typeof seen!.init.body).toBe('string'); // always a Content-Length
  });

  it('RED control: an unlinked issuer → ok:false not_linked, with a plain sentence', async () => {
    const r = await issueFleetCode({ ...CREDS, fetchImpl: fakeFetch(403, { error: 'not_linked' }) });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_linked');
    expect(friendlyFleetCodeError(r.error)).toMatch(/not linked to a human/);
  });

  it('a malformed relay answer is refused, never passed through as a code', async () => {
    const r = await issueFleetCode({ ...CREDS, fetchImpl: fakeFetch(201, { ...ISSUED, code: 'conn_bogus' }) });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('malformed_fleet_code_response');
  });

  it('CommonsInstitutions.issueFleetCode is the same call; an unlinked issuer throws', async () => {
    const ok = new CommonsInstitutions({ ...CREDS, fetch: fakeFetch(201, ISSUED) });
    await expect(ok.issueFleetCode()).resolves.toEqual({ code: CODE, expiresAt: ISSUED.expires_at, installLine: ISSUED.install_line });
    const unlinked = new CommonsInstitutions({ ...CREDS, fetch: fakeFetch(403, { error: 'not_linked' }) });
    await expect(unlinked.issueFleetCode()).rejects.toThrow();
  });

  it('the hosted bundle dispatches `fleet-code` as a verb (argv position only)', () => {
    expect(BOOTSTRAP_VERBS).toContain('fleet-code');
    expect(resolveBootstrapVerb(['node', 'agent.js', 'fleet-code'])).toBe('fleet-code');
    expect(resolveBootstrapVerb(['node', 'agent.js', 'report-pe', '--branch', 'fleet-code'])).toBe('report-pe');
  });
});

describe('requestLink — a fleet code links directly', () => {
  const BASE = { relayUrl: 'https://api.provian.ai', walletId: 'wallet_aw_scout', connectionToken: CODE, apiKey: 'k', apiSecret: 's' };
  it('status linked / linked_via fleet_code → linkStatus linked, linkedVia fleet_code', async () => {
    const r = await requestLink({ ...BASE, fetchImpl: fakeFetch(201, { status: 'linked', linked_via: 'fleet_code', request_id: 'inv_fleet_x' }) });
    expect(r).toMatchObject({ ok: true, linkStatus: 'linked', linkedVia: 'fleet_code', requestId: 'inv_fleet_x' });
  });
  it('RED control: a human code still reads as pending', async () => {
    const r = await requestLink({ ...BASE, fetchImpl: fakeFetch(201, { status: 'pending', request_id: 'inv_1' }) });
    expect(r.linkStatus).toBe('pending');
    expect(r.linkedVia).toBeUndefined();
  });
  it('an expired code surfaces connection_token_expired', async () => {
    const r = await requestLink({ ...BASE, fetchImpl: fakeFetch(410, { error: 'connection_token_expired' }) });
    expect(r).toMatchObject({ ok: false, status: 410, error: 'connection_token_expired' });
  });
});

describe('renderBootstrapOutcome — fleet wording and the fleet-code link', () => {
  const base: BootstrapResult = {
    walletId: 'wallet_aw_boot', address: '0xabc', recoveryEscrowed: false,
    deviceRegistered: true, observerStarted: true, commonsJoined: true,
    commonsJoinStatus: 'joined', linkRequested: true, linkStatus: 'pending', notes: [],
  };

  it('a fleet-code link prints "Linked to your human (fleet code)" and never asks for an Accept', () => {
    const v = renderBootstrapOutcome({ ...base, linkStatus: 'linked' });
    const text = v.stdout.join('\n');
    expect(v.exitCode).toBe(0);
    expect(text).toContain('Linked to your human (fleet code)');
    expect(text).not.toMatch(/tap Accept/);
    // Linked → the command that issues a code for the next agent.
    expect(text).toContain(FLEET_ONBOARDING_LINE);
    expect(text).toContain('fleet-code');
  });

  it('RED control: a pending link still says tap Accept, and says the command waits for it', () => {
    const text = renderBootstrapOutcome(base).stdout.join('\n');
    expect(text).toMatch(/tap Accept to finish the link/);
    expect(text).not.toContain('Linked to your human (fleet code)');
    expect(text).toContain(FLEET_ONBOARDING_LINE);
    expect(fleetOnboardingLines('pending').join('\n')).toMatch(/Once your human taps Accept/);
  });

  it('an expired code at the link step is a plain "ask for a fresh code" failure (exit 1)', () => {
    const v = renderBootstrapOutcome({ ...base, linkRequested: false, linkStatus: undefined, notes: ['link_request_error:connection_token_expired'] });
    expect(v.exitCode).toBe(1);
    expect(v.stderr.join('\n')).toMatch(/expired \(codes last one hour\)/);
  });

  it('the wording never says "sub-agents"', () => {
    expect(FLEET_ONBOARDING_LINE).toBe('Any of your linked agents can onboard your other agents — each gets its own wallet, linked to you.');
    expect(FLEET_ONBOARDING_LINE.toLowerCase()).not.toContain('sub-agent');
  });
});
