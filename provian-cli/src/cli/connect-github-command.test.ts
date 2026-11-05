/**
 * B4 — `provian connect github` delegates to the SDK's runConnectFlow.
 * The copy has named this command all along (en.json:1723,
 * CAPTURE_ARCHITECTURE.md:49); this is the command existing.
 */
import { describe, expect, it, vi } from 'vitest';
import { cmdConnectGithub, type ConnectGithubDeps } from './commands';
import { parseArgs } from './parse-args';

const CREDS = {
  deviceKey: 'pdk_test',
  deviceSecret: 'pds_test',
  relayUrl: 'https://relay.test',
} as ReturnType<ConnectGithubDeps['loadCreds']>;

function depsWith(fetchImpl: typeof fetch, over: Partial<ConnectGithubDeps> = {}): ConnectGithubDeps {
  return {
    fetch: fetchImpl,
    sleep: async () => {},
    openBrowser: vi.fn(async () => {}),
    log: vi.fn(),
    loadCreds: () => CREDS,
    ...over,
  };
}

describe('parseArgs subcommand', () => {
  it('captures `connect github` as command + subcommand', () => {
    const parsed = parseArgs(['node', 'provian', 'connect', 'github', '--no-open']);
    expect(parsed.command).toBe('connect');
    expect(parsed.subcommand).toBe('github');
    expect(parsed.flags['no-open']).toBe(true);
  });

  it('[control] a bare token consumed as a flag value is NOT a subcommand', () => {
    const parsed = parseArgs(['node', 'provian', 'connect', '--token', 'tok_abc']);
    expect(parsed.subcommand).toBeNull();
    expect(parsed.flags.token).toBe('tok_abc');
  });
});

describe('cmdConnectGithub', () => {
  it('runs start → install URL → poll completed and reports the install', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.endsWith('/v1/witnesses/github/connect/start')) {
        return new Response(JSON.stringify({
          install_url: 'https://github.com/apps/provian/installations/new?state=s',
          expires_at: Date.now() + 300_000,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        status: 'completed', install_id: 'inst_1', pe_id: 'pe_gh_1',
      }), { status: 200 });
    }) as typeof fetch;

    const deps = depsWith(fetchImpl);
    const result = await cmdConnectGithub({ 'no-open': true }, deps);
    expect(result.status).toBe('connected');
    expect(result.installation_id).toBe('inst_1');
    expect(result.pe_id).toBe('pe_gh_1');
    expect(calls[0]).toContain('POST https://relay.test/v1/witnesses/github/connect/start');
    // --no-open: URL printed, browser NOT opened.
    expect(deps.openBrowser).not.toHaveBeenCalled();
    expect((deps.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n'))
      .toContain('https://github.com/apps/provian/installations/new');
  });

  it('[ control] no device credentials → actionable error, no network call', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await cmdConnectGithub({}, depsWith(fetchImpl, { loadCreds: () => null }));
    expect(result.status).toBe('error');
    expect(String(result.error)).toContain('register-device');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('[ control] a relay refusal surfaces as the error, never as success', async () => {
    const fetchImpl = (async () => new Response(
      JSON.stringify({ error: 'GitHub connect is not configured on this relay' }),
      { status: 503 },
    )) as typeof fetch;
    const result = await cmdConnectGithub({ 'no-open': true }, depsWith(fetchImpl));
    expect(result.status).toBe('error');
  });
});
