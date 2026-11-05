/**
 * `provian git-identity register|list|revoke` the generic-CLI front door for
 * git-identity → wallet registration (Part 2). One implementation, two
 * front doors: this delegates to the SDK's git-identity module exactly as
 * `npx @provian/agent-sdk register-git-identity` does, reading the SAME
 * ~/.provian/agent-credentials.json and ~/.provian/agent-keystore.json.
 *
 * Registering is attribution, not activity: it mints nothing. Once mapped,
 * pushes to a connected repository become witnessed PEs on the agent chain;
 * every act of work mints PVT once at its best-supported value.
 */

import {
  GitIdentityError,
  githubIdentityLink,
  completeGitIdentityChallenge,
  listGitIdentities,
  loadAgentCredentialsFile,
  loadKeystore,
  readGitAuthorEmail,
  readLocalKeystoreSecret,
  registerGitIdentity,
  revokeGitIdentity,
  withDecryptedKey,
  type AgentCredentialsFile,
  type AgentKeystore,
  type AuthorKeyType,
  type GitIdentityConfig,
  type GitIdentityProvider,
} from '@provian/agent-sdk';
import { DEFAULT_RELAY_URL, type CommandResult } from './relay-http';

export interface GitIdentityDeps {
  loadCreds(): AgentCredentialsFile | null;
  loadKeystore(): AgentKeystore | null;
  resolvePassphrase(): Promise<string | null>;
  withKey<T>(keystore: AgentKeystore, passphrase: string, fn: (privateKeyHex: string) => Promise<T>): Promise<T>;
  readGitAuthorEmail(): string | null;
  githubLink?: typeof githubIdentityLink;
  register: typeof registerGitIdentity;
  complete: typeof completeGitIdentityChallenge;
  list: typeof listGitIdentities;
  revoke: typeof revokeGitIdentity;
  env: NodeJS.ProcessEnv;
}

export function defaultGitIdentityDeps(): GitIdentityDeps {
  return {
    loadCreds: () => loadAgentCredentialsFile(),
    loadKeystore: () => loadKeystore(),
    async resolvePassphrase() {
      const fromEnv = process.env.PROVIAN_KEYSTORE_PASSPHRASE;
      if (fromEnv && fromEnv.length > 0) return fromEnv;
      // The two-touch bootstrap stores the at-rest secret beside the keystore.
      // The generic CLI never prompts (it is machine-driven; output is JSON).
      return readLocalKeystoreSecret();
    },
    withKey: (keystore, passphrase, fn) => withDecryptedKey(keystore, passphrase, (key) => fn(key.privateKey)),
    readGitAuthorEmail: () => readGitAuthorEmail(),
    register: registerGitIdentity,
    complete: completeGitIdentityChallenge,
    list: listGitIdentities,
    revoke: revokeGitIdentity,
    env: process.env,
  };
}

function isProvider(value: string): value is GitIdentityProvider {
  return value === 'github' || value === 'gitlab' || value === 'bitbucket';
}

function str(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export async function cmdGitIdentity(
  subcommand: string | null,
  flags: Record<string, string | boolean>,
  deps: GitIdentityDeps = defaultGitIdentityDeps(),
): Promise<CommandResult> {
  if (subcommand !== 'register' && subcommand !== 'list' && subcommand !== 'revoke' && subcommand !== 'github-link') {
    return {
      status: 'error',
      error: 'Usage: provian git-identity register|list|revoke [options]. Run provian git-identity --help.',
    };
  }

  const creds = deps.loadCreds();
  if (!creds || !creds.api_key || !creds.api_secret) {
    return {
      status: 'error',
      code: 'NO_AGENT_CREDENTIALS',
      error: 'No agent credentials at ~/.provian/agent-credentials.json. Create the wallet first: npx @provian/agent-sdk create-agent-wallet',
    };
  }
  const keystore = deps.loadKeystore();
  const walletId = creds.wallet_id || keystore?.wallet_id || '';
  if (!walletId) {
    return { status: 'error', code: 'NO_WALLET_ID', error: 'Could not determine this agent\'s wallet id.' };
  }
  const config: GitIdentityConfig = {
    relayUrl: str(flags, 'relay-url') || deps.env.PROVIAN_RELAY_URL || DEFAULT_RELAY_URL,
    apiKey: creds.api_key,
    apiSecret: creds.api_secret,
    walletId,
  };

  try {
    if (subcommand === 'github-link') return { status: 'github_identity', ...(await (deps.githubLink ?? githubIdentityLink)(config, str(flags, 'state'))) };
    if (subcommand === 'list') {
      const mappings = await deps.list(config);
      return { status: 'listed', wallet_id: walletId, count: mappings.length, mappings };
    }
    if (subcommand === 'revoke') {
      const id = str(flags, 'id');
      if (!id) return { status: 'error', error: 'Missing --id. Usage: provian git-identity revoke --id <mapping_id>' };
      const r = await deps.revoke(config, id);
      return { status: 'revoked', mapping_id: r.mappingId };
    }

    const email = str(flags, 'email');
    const username = str(flags, 'username');
    if (email && username) return { status: 'error', error: 'Pass either --email or --username, not both.' };
    let key: { type: AuthorKeyType; value: string } | null = null;
    if (username) key = { type: 'username', value: username };
    else if (email) key = { type: 'email', value: email };
    else {
      const detected = deps.readGitAuthorEmail();
      if (detected) key = { type: 'email', value: detected };
    }
    if (!key) {
      return {
        status: 'error',
        code: 'NO_GIT_AUTHOR_EMAIL',
        error: 'No git author email found. Set one with `git config --global user.email you@example.com`, or pass --email.',
      };
    }
    const provider = (str(flags, 'provider') || 'github').toLowerCase();
    if (!isProvider(provider)) {
      return { status: 'error', error: `Unknown provider "${provider}". Use github, gitlab, or bitbucket.` };
    }
    if (!keystore) {
      return { status: 'error', code: 'NO_KEYSTORE', error: 'The agent keystore (~/.provian/agent-keystore.json) is required to sign the registration.' };
    }
    if (keystore.wallet_id !== walletId) {
      return { status: 'error', code: 'KEYSTORE_WALLET_MISMATCH', error: `The keystore belongs to ${keystore.wallet_id}, not ${walletId}.` };
    }
    const passphrase = await deps.resolvePassphrase();
    if (!passphrase) {
      return { status: 'error', code: 'NO_PASSPHRASE', error: 'Set PROVIAN_KEYSTORE_PASSPHRASE (no local keystore secret was found).' };
    }
    const challengeId = str(flags, 'challenge');
    const installationId = str(flags, 'installation');
    const authorKey = key;
    const result = await deps.withKey(keystore, passphrase, (privateKeyHex) =>
      challengeId
        ? deps.complete(config, { challengeId, authorKeyType: authorKey.type, authorKey: authorKey.value, privateKeyHex })
        : deps.register(config, { provider, authorKeyType: authorKey.type, authorKey: authorKey.value, installationId, privateKeyHex }));
    return {
      status: result.status,
      author_key_type: authorKey.type,
      author_key: authorKey.value,
      provider: result.mapping.provider,
      installation_id: result.installationId ?? null,
      forge_account_id: result.forgeAccountId,
      source_owner_wallet_id: result.sourceOwnerWalletId,
      mapping: result.mapping,
      message: result.status === 'already_registered'
        ? 'This git identity already credits this agent on that repository. Nothing to do.'
        : 'Registered. Pushes to the connected repository authored as this identity now credit this agent; every act of work mints PVT once at its best-supported value.',
    };
  } catch (err) {
    if (err instanceof GitIdentityError) {
      return { status: 'error', code: err.code, httpStatus: err.status || undefined, error: err.message };
    }
    return { status: 'error', kind: 'unknown', error: (err as Error).message };
  }
}

export function printGitIdentityHelp(): void {
  console.log(`provian git-identity - Bind this agent's git author identity to its wallet

Pushes to a connected repository (Provian GitHub App, or a GitLab / Bitbucket
webhook) credit the commit AUTHOR only once that identity is registered. The
agent signs with its own key. Idempotent. Registering mints nothing; eligible
verified pushes mint PVT once under protocol rules.

Usage:
  provian git-identity register [--email <address> | --username <login>] [--provider github|gitlab|bitbucket]
                                [--installation <id>] [--challenge <id>] [--relay-url <url>]
  provian git-identity github-link [--state <state>]
  provian git-identity list
  provian git-identity revoke --id <mapping_id>

Options:
  --email          Git author email (default: git config user.email)
  --username       Register a forge username instead of an email
  --provider       github (default), gitlab, or bitbucket
  --installation   Name the connected repository when the owner has several
  --challenge      Complete a challenge the repository owner issued in the Provian app
  --id             Mapping id to revoke
  --relay-url      Relay URL (default: ${DEFAULT_RELAY_URL})

Credentials: ~/.provian/agent-credentials.json and ~/.provian/agent-keystore.json
(PROVIAN_KEYSTORE_PASSPHRASE, or the bootstrap's local keystore secret).`);
}
