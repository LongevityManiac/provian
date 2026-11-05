#!/usr/bin/env node
/**
 * register-git-identity - bind this agent's git author identity to its wallet,
 * so pushes to a CONNECTED repository (Provian GitHub App, or a GitLab /
 * Bitbucket webhook) credit this agent (Part 2).
 *
 * The agent signs a claims-bound challenge with its OWN registered key — the
 * same key that created the wallet — and the relay records the mapping. Which
 * repository: an install this agent owns, or, when this agent is LINKED to the
 * install's human owner, that human's install (the link is the owner's
 * standing authorization for the agent to register ITS OWN identity there).
 *
 * Usage:
 * npx @provian/agent-sdk register-git-identity # git config user.email, github, the single install
 * npx @provian/agent-sdk register-git-identity --email atlas@example.com
 * npx @provian/agent-sdk register-git-identity --provider gitlab --installation 42714038
 * npx @provian/agent-sdk register-git-identity --challenge <id> # complete a challenge the repo owner issued in the app
 * npx @provian/agent-sdk register-git-identity --list
 * npx @provian/agent-sdk register-git-identity --revoke <mapping_id>
 *
 * Idempotent: an identity already registered for this agent on that
 * repository is reported, not re-signed. Plain sentences by default; --json
 * prints one JSON object.
 *
 * KEY HANDLING: the agent key is decrypted from ~/.provian/agent-keystore.json
 * for the single signature and dropped (withDecryptedKey). The passphrase
 * comes from PROVIAN_KEYSTORE_PASSPHRASE, else the bootstrap's local at-rest
 * secret (~/.provian/agent-keystore.secret), else a masked prompt on a TTY.
 * Never a flag. Agent auth comes from the 0600-enforced
 * ~/.provian/agent-credentials.json.
 *
 * EARNING BOUNDARY: registering is attribution, not activity — it does not
 * mint separately. Once mapped, verified pushes mint PVT once at their
 * best-supported value; local commits are already witnessed by the daemon.
 */

import { loadAgentCredentialsFile, type AgentCredentialsFile } from './agent-credentials-file';
import { readSecret } from './prompt-secret';
import { loadKeystore, withDecryptedKey, type AgentKeystore } from '../keystore';
import { readLocalKeystoreSecret } from '../local-keystore-secret';
import {
  GitIdentityError,
  githubIdentityLink,
  completeGitIdentityChallenge,
  listGitIdentities,
  readGitAuthorEmail,
  registerGitIdentity,
  revokeGitIdentity,
  type AuthorKeyType,
  type GitIdentityConfig,
  type GitIdentityMapping,
  type RegisterGitIdentityResult,
} from '../git-identity';
import type { GitIdentityProvider } from '../git-identity-guidance';
import { isDirectCliEntry } from './cli-entry';
import { cliCommand, HOSTED_BUNDLE } from '../cli-command';

const RELAY_URL = 'https://api.provian.ai';

export interface RegisterGitIdentityArgs {
  githubLink?: boolean;
  poll?: string;
  email?: string;
  username?: string;
  provider?: string;
  installation?: string;
  challenge?: string;
  relay?: string;
  revoke?: string;
  list: boolean;
  json: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): RegisterGitIdentityArgs {
  const args: RegisterGitIdentityArgs = { list: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--github-link') args.githubLink = true;
    else if ((a === '--poll' || a === '--state') && argv[i + 1]) args.poll = argv[++i];
    else if (a === '--email' && argv[i + 1]) args.email = argv[++i];
    else if (a === '--username' && argv[i + 1]) args.username = argv[++i];
    else if (a === '--provider' && argv[i + 1]) args.provider = argv[++i];
    else if (a === '--installation' && argv[i + 1]) args.installation = argv[++i];
    else if (a === '--challenge' && argv[i + 1]) args.challenge = argv[++i];
    else if ((a === '--relay' || a === '--relay-url') && argv[i + 1]) args.relay = argv[++i];
    else if (a === '--revoke' && argv[i + 1]) args.revoke = argv[++i];
    else if (a === '--list') args.list = true;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

export function helpText(): string {
  return `
Usage: register-git-identity [options]

Bind this agent's git author identity to its wallet so pushes to a connected
repository credit this agent. Signs with the agent's own key. Idempotent.

Options:
  --github-link             Start verified GitHub identity linking for the PR gate
  --poll, --state <state>    Poll the link after authorizing its code on GitHub
  --email <address>        Git author email to register (default: git config user.email)
  --username <login>       Register a forge username instead of an email
  --provider <name>        github | gitlab | bitbucket (default: github)
  --installation <id>      Name the connected repository when the owner has several
  --challenge <id>         Complete a challenge the repository owner issued in the Provian app
  --list                   Show this agent's registered identities
  --revoke <mapping_id>    Withdraw a registration
  --relay <url>            Relay URL (default: ${RELAY_URL})
  --json                   Print one JSON object instead of sentences
  --help, -h               Show this help

Registering is attribution, not activity: it mints nothing. Once mapped, eligible
verified pushes mint PVT once under protocol rules.
`;
}

/** Everything the run touches, injectable so the flow is testable without a keystore or relay. */
export interface RegisterGitIdentityDeps {
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
  stdout(line: string): void;
  stderr(line: string): void;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
}

function isProvider(value: string): value is GitIdentityProvider {
  return value === 'github' || value === 'gitlab' || value === 'bitbucket';
}

function describeMapping(m: GitIdentityMapping): string {
  const who = m.forge_account_login ? `${m.provider} account ${m.forge_account_login}` : `${m.provider} scope ${m.forge_account_id}`;
  return `${m.status === 'active' ? 'active ' : 'revoked'}  ${m.mapping_id}  ${m.author_key_type}  ${m.author_key_hash.slice(0, 12)}…  on ${who}  → ${m.agent_wallet_id}  (vouched by ${m.source_owner_wallet_id})`;
}

function printResult(result: RegisterGitIdentityResult, key: { type: AuthorKeyType; value: string }, deps: RegisterGitIdentityDeps, json: boolean): void {
  if (json) {
    deps.stdout(JSON.stringify({ status: result.status, author_key_type: key.type, author_key: key.value, mapping: result.mapping,
      installation_id: result.installationId ?? null, forge_account_id: result.forgeAccountId, source_owner_wallet_id: result.sourceOwnerWalletId }));
    return;
  }
  const where = result.installationId
    ? `${result.mapping.provider} installation ${result.installationId}`
    : `${result.mapping.provider} scope ${result.forgeAccountId}`;
  if (result.status === 'already_registered') {
    deps.stdout(`Already registered: ${key.value} already credits ${result.mapping.agent_wallet_id} on ${where}. Nothing to do.`);
    return;
  }
  deps.stdout(`Registered: commits authored as ${key.value} on ${where} now credit ${result.mapping.agent_wallet_id}.`);
  deps.stdout(`  Vouched by ${result.sourceOwnerWalletId}; mapping ${result.mapping.mapping_id}.`);
  deps.stdout('  Pushes to that repository become witnessed PEs on this agent\'s chain; every act of work mints PVT once at its best-supported value.');
}

function printError(err: unknown, deps: RegisterGitIdentityDeps, json: boolean): void {
  if (err instanceof GitIdentityError) {
    if (json) deps.stdout(JSON.stringify({ status: 'error', code: err.code, error: err.message }));
    else deps.stderr(`Error: ${err.message} (${err.code})`);
    return;
  }
  const message = (err as Error).message ?? String(err);
  if (json) deps.stdout(JSON.stringify({ status: 'error', code: 'UNEXPECTED', error: message }));
  else deps.stderr(`Error: ${message}`);
}

/** The flow as a pure function of args + deps. Returns the process exit code. */
export async function runRegisterGitIdentity(args: RegisterGitIdentityArgs, deps: RegisterGitIdentityDeps): Promise<number> {
  if (args.help) {
    deps.stdout(helpText());
    return 0;
  }

  const creds = deps.loadCreds();
  if (!creds || !creds.api_key || !creds.api_secret) {
    deps.stderr(HOSTED_BUNDLE
      ? 'No agent credentials at ~/.provian/agent-credentials.json. Generate a fresh code in the Provian app under "Connect an agent" and paste the install line again.'
      : `No agent credentials at ~/.provian/agent-credentials.json. Create your wallet first: ${cliCommand('create-agent-wallet')}`);
    return 2;
  }
  const keystore = deps.loadKeystore();
  const walletId = creds.wallet_id || keystore?.wallet_id || '';
  if (!walletId) {
    deps.stderr('Could not determine this agent\'s wallet id (no wallet_id in the credentials file or keystore).');
    return 2;
  }
  const config: GitIdentityConfig = {
    relayUrl: args.relay || deps.env.PROVIAN_RELAY_URL || RELAY_URL,
    apiKey: creds.api_key,
    apiSecret: creds.api_secret,
    walletId,
  };

  try {
    if (args.githubLink) {
      deps.stdout(JSON.stringify(await (deps.githubLink ?? githubIdentityLink)(config, args.poll)));
      return 0;
    }
    if (args.list) {
      const mappings = await deps.list(config);
      if (args.json) deps.stdout(JSON.stringify({ wallet_id: walletId, mappings }));
      else if (mappings.length === 0) deps.stdout('No git identities registered for this agent yet.');
      else for (const m of mappings) deps.stdout(describeMapping(m));
      return 0;
    }
    if (args.revoke) {
      const r = await deps.revoke(config, args.revoke);
      if (args.json) deps.stdout(JSON.stringify({ status: 'revoked', mapping_id: r.mappingId }));
      else deps.stdout(`Revoked ${r.mappingId}. Pushes by that identity no longer credit this agent through the connected repository.`);
      return 0;
    }

    if (args.email && args.username) {
      deps.stderr('Pass either --email or --username, not both.');
      return 2;
    }
    let key: { type: AuthorKeyType; value: string } | null = null;
    if (args.username) key = { type: 'username', value: args.username };
    else if (args.email) key = { type: 'email', value: args.email };
    else {
      const detected = deps.readGitAuthorEmail();
      if (detected) key = { type: 'email', value: detected };
    }
    if (!key) {
      deps.stderr('No git author email found. Set one with `git config --global user.email you@example.com`, or pass --email.');
      return 2;
    }

    const provider = (args.provider || 'github').toLowerCase();
    if (!isProvider(provider)) {
      deps.stderr(`Unknown provider "${args.provider}". Use github, gitlab, or bitbucket.`);
      return 2;
    }

    if (!keystore) {
      deps.stderr('The agent keystore (~/.provian/agent-keystore.json) is required to sign the registration; it was not found.');
      return 2;
    }
    if (keystore.wallet_id !== walletId) {
      deps.stderr(`The keystore belongs to ${keystore.wallet_id}, not ${walletId}; the relay would reject the signature.`);
      return 2;
    }
    const passphrase = await deps.resolvePassphrase();
    if (!passphrase) {
      deps.stderr('Set PROVIAN_KEYSTORE_PASSPHRASE for a non-interactive run (no local keystore secret was found).');
      return 2;
    }

    const result = await deps.withKey(keystore, passphrase, (privateKeyHex) =>
      args.challenge
        ? deps.complete(config, { challengeId: args.challenge, authorKeyType: key!.type, authorKey: key!.value, privateKeyHex })
        : deps.register(config, { provider, authorKeyType: key!.type, authorKey: key!.value, installationId: args.installation, privateKeyHex }));
    printResult(result, key, deps, args.json);
    return 0;
  } catch (err) {
    printError(err, deps, args.json);
    return 1;
  }
}

export function defaultDeps(): RegisterGitIdentityDeps {
  return {
    loadCreds: () => loadAgentCredentialsFile(),
    loadKeystore: () => loadKeystore(),
    async resolvePassphrase() {
      const fromEnv = process.env.PROVIAN_KEYSTORE_PASSPHRASE;
      if (fromEnv && fromEnv.length > 0) return fromEnv;
      const local = readLocalKeystoreSecret();
      if (local) return local;
      if (!process.stdin.isTTY) return null;
      const typed = await readSecret('  Keystore passphrase: ');
      return typed.length > 0 ? typed : null;
    },
    withKey: (keystore, passphrase, fn) => withDecryptedKey(keystore, passphrase, (key) => fn(key.privateKey)),
    readGitAuthorEmail: () => readGitAuthorEmail(),
    register: registerGitIdentity,
    complete: completeGitIdentityChallenge,
    list: listGitIdentities,
    revoke: revokeGitIdentity,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    env: process.env,
    isTTY: Boolean(process.stdin.isTTY),
  };
}

if (isDirectCliEntry(module)) {
  runRegisterGitIdentity(parseArgs(process.argv.slice(2)), defaultDeps())
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('Unexpected error:', err);
      process.exit(1);
    });
}
