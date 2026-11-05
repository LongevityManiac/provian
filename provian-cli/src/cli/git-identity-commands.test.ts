/**
 * `provian git-identity register|list|revoke` — mirrors the SDK bin through the
 * same SDK module, with every dependency injected. Each refusal is a
 * constructible violating state (observed RED, not assumed).
 */
import { describe, expect, it, vi } from 'vitest';
import { GitIdentityError, type AgentKeystore, type GitIdentityMapping, type RegisterGitIdentityResult } from '@provian/agent-sdk';
import { cmdGitIdentity, type GitIdentityDeps } from './git-identity-commands';
import * as gitIdentityCommands from './git-identity-commands';
import { parseArgs } from './parse-args';
import { run } from './commands';

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

function depsWith(over: Partial<GitIdentityDeps> = {}): GitIdentityDeps {
  return {
    loadCreds: () => CREDS,
    loadKeystore: () => KEYSTORE,
    resolvePassphrase: async () => 'pass',
    withKey: async (_k, _p, fn) => fn('11'.repeat(32)),
    readGitAuthorEmail: () => 'atlas@example.com',
    register: vi.fn(async () => REGISTERED),
    complete: vi.fn(async () => REGISTERED),
    list: vi.fn(async () => [MAPPING]),
    revoke: vi.fn(async (_c, id: string) => ({ revoked: true as const, mappingId: id })),
    env: {},
    ...over,
  };
}

describe('parseArgs subcommand for git-identity', () => {
  it('captures `git-identity register` + flags', () => {
    const p = parseArgs(['node', 'provian', 'git-identity', 'register', '--email', 'a@b.co', '--provider', 'gitlab']);
    expect(p.command).toBe('git-identity');
    expect(p.subcommand).toBe('register');
    expect(p.flags.email).toBe('a@b.co');
  });
});

describe('cmdGitIdentity register', () => {
  it('registers with the detected email on github by default', async () => {
    const deps = depsWith();
    const r = await cmdGitIdentity('register', {}, deps);
    expect(r.status).toBe('registered');
    expect(r.installation_id).toBe('777');
    expect(deps.register).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: 'wallet_aw_atlas', relayUrl: 'https://api.provian.ai' }),
      expect.objectContaining({ provider: 'github', authorKeyType: 'email', authorKey: 'atlas@example.com', privateKeyHex: '11'.repeat(32) }),
    );
    expect(String(r.message)).not.toMatch(/every (commit|push) (earns|mints)/i);
  });
  it('honours --email/--provider/--installation/--relay-url', async () => {
    const deps = depsWith();
    await cmdGitIdentity('register', { email: 'x@y.co', provider: 'bitbucket', installation: '{u}', 'relay-url': 'https://r' }, deps);
    expect(deps.register).toHaveBeenCalledWith(
      expect.objectContaining({ relayUrl: 'https://r' }),
      expect.objectContaining({ provider: 'bitbucket', authorKey: 'x@y.co', installationId: '{u}' }),
    );
  });
  it('--challenge completes an owner-issued challenge', async () => {
    const deps = depsWith();
    const r = await cmdGitIdentity('register', { challenge: 'ch_1' }, deps);
    expect(r.status).toBe('registered');
    expect(deps.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ challengeId: 'ch_1' }));
    expect(deps.register).not.toHaveBeenCalled();
  });
  it('reports already_registered', async () => {
    const r = await cmdGitIdentity('register', {}, depsWith({ register: vi.fn(async () => ({ ...REGISTERED, status: 'already_registered' as const })) }));
    expect(r.status).toBe('already_registered');
  });

  it('RED: no credentials → error, no relay call', async () => {
    const deps = depsWith({ loadCreds: () => null });
    const r = await cmdGitIdentity('register', {}, deps);
    expect(r.status).toBe('error');
    expect(r.code).toBe('NO_AGENT_CREDENTIALS');
    expect(deps.register).not.toHaveBeenCalled();
  });
  it('RED: no git email → NO_GIT_AUTHOR_EMAIL', async () => {
    const r = await cmdGitIdentity('register', {}, depsWith({ readGitAuthorEmail: () => null }));
    expect(r.code).toBe('NO_GIT_AUTHOR_EMAIL');
  });
  it('RED: keystore mismatch / missing keystore / missing passphrase / unknown provider', async () => {
    expect((await cmdGitIdentity('register', {}, depsWith({ loadKeystore: () => ({ ...KEYSTORE, wallet_id: 'wallet_aw_other' } as AgentKeystore) }))).code).toBe('KEYSTORE_WALLET_MISMATCH');
    expect((await cmdGitIdentity('register', {}, depsWith({ loadKeystore: () => null }))).code).toBe('NO_KEYSTORE');
    expect((await cmdGitIdentity('register', {}, depsWith({ resolvePassphrase: async () => null }))).code).toBe('NO_PASSPHRASE');
    expect((await cmdGitIdentity('register', { provider: 'sourcehut' }, depsWith())).status).toBe('error');
  });
  it('RED: a typed relay refusal surfaces its code, never success', async () => {
    const deps = depsWith({ register: vi.fn(async () => { throw new GitIdentityError('nope', 'INSTALL_NOT_FOUND', 404); }) });
    const r = await cmdGitIdentity('register', {}, deps);
    expect(r).toMatchObject({ status: 'error', code: 'INSTALL_NOT_FOUND', httpStatus: 404 });
  });
});

describe('cmdGitIdentity list / revoke', () => {
  it('lists', async () => {
    const r = await cmdGitIdentity('list', {}, depsWith());
    expect(r.status).toBe('listed');
    expect(r.count).toBe(1);
  });
  it('revokes by --id and refuses without it', async () => {
    const deps = depsWith();
    expect((await cmdGitIdentity('revoke', { id: 'github_abc' }, deps)).status).toBe('revoked');
    expect(deps.revoke).toHaveBeenCalledWith(expect.anything(), 'github_abc');
    expect((await cmdGitIdentity('revoke', {}, deps)).status).toBe('error');
  });
  it('RED: an unknown subcommand is an error', async () => {
    expect((await cmdGitIdentity('frobnicate', {}, depsWith())).status).toBe('error');
    expect((await cmdGitIdentity(null, {}, depsWith())).status).toBe('error');
  });
});

describe('run() dispatch', () => {
  it('routes `git-identity list` through the command without reading host credentials or contacting the relay', async () => {
    const command = vi.spyOn(gitIdentityCommands, 'cmdGitIdentity').mockResolvedValue({
      status: 'error',
      error: 'No agent credentials at ~/.provian/agent-credentials.json.',
      code: 'NO_AGENT_CREDENTIALS',
    });
    try {
      const r = await run(['node', 'provian', 'git-identity', 'list']);
      expect(command).toHaveBeenCalledWith('list', {});
      expect(r).toMatchObject({ status: 'error', code: 'NO_AGENT_CREDENTIALS' });
      expect(String(r!.error ?? '')).not.toContain('Unknown command');
    } finally {
      command.mockRestore();
    }
  });
});


describe('verified GitHub identity link', () => {
  it('starts and polls using agent authentication without decrypting the wallet key', async () => {
    const githubLink = vi.fn(async (_config: import('@provian/agent-sdk').GitIdentityConfig, state?: string) => state ? { status: 'completed', github_id: '123' } : { state: 'opaque', user_code: 'ABCD-EFGH' });
    const withKey = vi.fn(); const deps = depsWith({ githubLink, withKey });
    expect(await cmdGitIdentity('github-link', {}, deps)).toMatchObject({ state: 'opaque', user_code: 'ABCD-EFGH' });
    expect(await cmdGitIdentity('github-link', { state: 'opaque' }, deps)).toMatchObject({ github_id: '123' });
    expect(githubLink.mock.calls[1][1]).toBe('opaque'); expect(withKey).not.toHaveBeenCalled();
  });
});
