/**
 * register-git-identity bin — the flow with every dependency injected (no
 * keystore, no relay, no process.exit). Each refusal is a constructible
 * violating input, so the guards are observed RED, not assumed.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseArgs,
  runRegisterGitIdentity,
  type RegisterGitIdentityDeps,
} from './register-git-identity';
import { GitIdentityError, type GitIdentityMapping, type RegisterGitIdentityResult } from '../git-identity';
import type { AgentKeystore } from '../keystore';

const KEYSTORE = { wallet_id: 'wallet_aw_atlas', address: '0xatlas', public_key: 'ab'.repeat(64) } as unknown as AgentKeystore;
const CREDS = { api_key: 'pvn_live_k', api_secret: 'pvns_s', wallet_id: 'wallet_aw_atlas', address: '0xatlas' };

const MAPPING: GitIdentityMapping = {
  mapping_id: 'github_abc', provider: 'github', forge_account_id: '21031067', forge_account_login: 'frank',
  source_owner_wallet_id: 'wallet_frank', agent_wallet_id: 'wallet_aw_atlas', agent_id: 'atlas',
  author_key_type: 'email', author_key_hash: 'ff'.repeat(32), verified_by: 'agent_wallet_signature',
  status: 'active', created_at: 1, verified_at: 1, revoked_at: null,
};
const REGISTERED: RegisterGitIdentityResult = {
  status: 'registered', mapping: MAPPING, installationId: '777', forgeAccountId: '21031067', sourceOwnerWalletId: 'wallet_frank',
};

function depsWith(over: Partial<RegisterGitIdentityDeps> = {}): RegisterGitIdentityDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out, err,
    loadCreds: () => CREDS,
    loadKeystore: () => KEYSTORE,
    resolvePassphrase: async () => 'pass',
    withKey: async (_k, _p, fn) => fn('11'.repeat(32)),
    readGitAuthorEmail: () => 'atlas@example.com',
    register: vi.fn(async () => REGISTERED),
    complete: vi.fn(async () => REGISTERED),
    list: vi.fn(async () => [MAPPING]),
    revoke: vi.fn(async (_c, id: string) => ({ revoked: true as const, mappingId: id })),
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    env: {},
    isTTY: false,
    ...over,
  };
}

describe('parseArgs', () => {
  it('parses every flag', () => {
    const a = parseArgs(['--email', 'a@b.co', '--provider', 'gitlab', '--installation', '42', '--challenge', 'ch', '--relay', 'https://r', '--json', '--list', '--revoke', 'm1']);
    expect(a).toEqual({ email: 'a@b.co', provider: 'gitlab', installation: '42', challenge: 'ch', relay: 'https://r', json: true, list: true, revoke: 'm1', help: false });
  });
  it('--help and -h', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });
});

describe('runRegisterGitIdentity', () => {
  it('registers with the detected git email on github by default and prints a plain sentence', async () => {
    const deps = depsWith();
    const code = await runRegisterGitIdentity(parseArgs([]), deps);
    expect(code).toBe(0);
    expect(deps.register).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: 'wallet_aw_atlas', apiKey: 'pvn_live_k', relayUrl: 'https://api.provian.ai' }),
      expect.objectContaining({ provider: 'github', authorKeyType: 'email', authorKey: 'atlas@example.com', privateKeyHex: '11'.repeat(32) }),
    );
    expect(deps.out.join('\n')).toContain('Registered: commits authored as atlas@example.com on github installation 777 now credit wallet_aw_atlas.');
    expect(deps.out.join('\n')).not.toMatch(/every (commit|push) (earns|mints)/i);
  });

  it('honours --email / --provider / --installation / --relay and env relay', async () => {
    const deps = depsWith({ env: { PROVIAN_RELAY_URL: 'https://env.relay' } });
    await runRegisterGitIdentity(parseArgs(['--email', 'Other@Example.com', '--provider', 'gitlab', '--installation', '42']), deps);
    expect(deps.register).toHaveBeenCalledWith(
      expect.objectContaining({ relayUrl: 'https://env.relay' }),
      expect.objectContaining({ provider: 'gitlab', authorKey: 'Other@Example.com', installationId: '42' }),
    );
  });

  it('--json prints exactly one parseable object', async () => {
    const deps = depsWith();
    await runRegisterGitIdentity(parseArgs(['--json']), deps);
    expect(deps.out).toHaveLength(1);
    const parsed = JSON.parse(deps.out[0]);
    expect(parsed).toMatchObject({ status: 'registered', author_key: 'atlas@example.com', installation_id: '777', mapping: { mapping_id: 'github_abc' } });
  });

  it('reports an idempotent already_registered outcome and exits 0', async () => {
    const deps = depsWith({ register: vi.fn(async () => ({ ...REGISTERED, status: 'already_registered' as const })) });
    expect(await runRegisterGitIdentity(parseArgs([]), deps)).toBe(0);
    expect(deps.out.join('\n')).toContain('Already registered');
  });

  it('--challenge completes the owner-issued challenge instead of self-registering', async () => {
    const deps = depsWith();
    expect(await runRegisterGitIdentity(parseArgs(['--challenge', 'ch_9']), deps)).toBe(0);
    expect(deps.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ challengeId: 'ch_9', authorKey: 'atlas@example.com' }));
    expect(deps.register).not.toHaveBeenCalled();
  });

  it('--list and --revoke', async () => {
    const deps = depsWith();
    expect(await runRegisterGitIdentity(parseArgs(['--list']), deps)).toBe(0);
    expect(deps.out[0]).toContain('github_abc');
    expect(deps.out[0]).toContain('wallet_aw_atlas');
    const deps2 = depsWith();
    expect(await runRegisterGitIdentity(parseArgs(['--revoke', 'github_abc']), deps2)).toBe(0);
    expect(deps2.revoke).toHaveBeenCalledWith(expect.anything(), 'github_abc');
    expect(deps2.out[0]).toContain('Revoked github_abc');
  });

  // RED controls — every refusal is a constructible violating state.
  it('RED: no credentials → exit 2, no relay call, no key touched', async () => {
    const deps = depsWith({ loadCreds: () => null });
    expect(await runRegisterGitIdentity(parseArgs([]), deps)).toBe(2);
    expect(deps.err[0]).toContain('create-agent-wallet');
    expect(deps.register).not.toHaveBeenCalled();
  });
  it('RED: no git email and no --email → exit 2 with the git config hint', async () => {
    const deps = depsWith({ readGitAuthorEmail: () => null });
    expect(await runRegisterGitIdentity(parseArgs([]), deps)).toBe(2);
    expect(deps.err[0]).toContain('git config --global user.email');
    expect(deps.register).not.toHaveBeenCalled();
  });
  it('RED: unknown provider → exit 2', async () => {
    const deps = depsWith();
    expect(await runRegisterGitIdentity(parseArgs(['--provider', 'sourcehut']), deps)).toBe(2);
    expect(deps.register).not.toHaveBeenCalled();
  });
  it('RED: keystore for a different wallet → exit 2 (the relay would reject the signature anyway)', async () => {
    const deps = depsWith({ loadKeystore: () => ({ ...KEYSTORE, wallet_id: 'wallet_aw_other' } as AgentKeystore) });
    expect(await runRegisterGitIdentity(parseArgs([]), deps)).toBe(2);
    expect(deps.err[0]).toContain('wallet_aw_other');
    expect(deps.register).not.toHaveBeenCalled();
  });
  it('RED: no keystore → exit 2; no passphrase → exit 2', async () => {
    expect(await runRegisterGitIdentity(parseArgs([]), depsWith({ loadKeystore: () => null }))).toBe(2);
    const deps = depsWith({ resolvePassphrase: async () => null });
    expect(await runRegisterGitIdentity(parseArgs([]), deps)).toBe(2);
    expect(deps.err[0]).toContain('PROVIAN_KEYSTORE_PASSPHRASE');
  });
  it('RED: --email and --username together → exit 2', async () => {
    expect(await runRegisterGitIdentity(parseArgs(['--email', 'a@b.co', '--username', 'x']), depsWith())).toBe(2);
  });
  it('RED: a relay refusal exits 1 with the typed code, and --json keeps it machine-readable', async () => {
    const failing = vi.fn(async () => { throw new GitIdentityError('No connected repository.', 'NO_ACTIVE_INSTALL', 404); });
    const deps = depsWith({ register: failing });
    expect(await runRegisterGitIdentity(parseArgs([]), deps)).toBe(1);
    expect(deps.err[0]).toContain('NO_ACTIVE_INSTALL');
    const deps2 = depsWith({ register: failing });
    expect(await runRegisterGitIdentity(parseArgs(['--json']), deps2)).toBe(1);
    expect(JSON.parse(deps2.out[0])).toMatchObject({ status: 'error', code: 'NO_ACTIVE_INSTALL' });
  });
});
