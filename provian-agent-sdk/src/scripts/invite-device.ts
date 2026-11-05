#!/usr/bin/env node
import { guardedFetch as fetch, guardedFetcher } from '../guarded-fetch';
/**
 * invite-device - Agent-initiated, email-only device invite.
 *
 * An agent (holding ~/.provian/agent-credentials.json) emails a human a single
 * one-time setup line. The human runs that line ON the target machine to stand
 * up a device whose Provenance Envelopes attribute to the AGENT wallet - with
 * NO API key/secret to paste.
 *
 * Stand up a device for your agent in one emailed line - no API key to paste.
 * Work the device witnesses becomes Provenance Envelopes on the agent chain;
 * every act of work mints PVT once at its best-supported value. Linked agents follow
 * the configured split; unlinked agents keep their full contributor share. The
 * setup link authorizes device registration only.
 *
 * Usage:
 *   npx @provian/agent-sdk invite-device --email bob@example.com
 *   npx @provian/agent-sdk invite-device --email bob@example.com --device-name "Bob's CI box"
 *
 * Flags:
 *   --email <addr>        Destination email (required)
 *   --device-name <name>  Suggested device name (optional)
 *   --language <code>     Email locale (en/es/fr/hi/id/ja/ko/pt/sw/tl/vi/zh; default en)
  --message <text>      Note to include in the email (optional)
 *   --relay <url>         Relay URL (default: https://api.provian.ai)
 *   --wallet-id <id>      Agent wallet id override (otherwise resolved from
 *                         ~/.provian/agent-credentials.json, then the agent-wallet
 *                         / session files)
 *   --help, -h            Show this help
 *
 * Auth: the agent API key + secret are read from the 0600-enforced
 * ~/.provian/agent-credentials.json and sent ONLY to
 * POST /v1/agent/wallet/:wallet_id/device-invite. The api_secret is never
 * printed; the one-time token never leaves the relay (it goes only into the email).
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { loadAgentCredentialsFile } from './agent-credentials-file';
import { readSessionFile } from '../session-file';
import { runInviteDevice, type InviteDeviceResult } from './invite-device-flow';
import { isDirectCliEntry } from './cli-entry';

const RELAY_URL = 'https://api.provian.ai';
const AGENT_WALLET_FILE = path.join(homedir(), '.provian', 'agent-wallet');

interface InviteArgs {
  language?: string;
  email?: string;
  deviceName?: string;
  message?: string;
  relay?: string;
  walletId?: string;
  help?: boolean;
}

export function parseArgs(argv: string[]): InviteArgs {
  const args: InviteArgs = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--email' && argv[i + 1]) args.email = argv[++i];
    else if (argv[i] === '--device-name' && argv[i + 1]) args.deviceName = argv[++i];
    else if (argv[i] === '--language' && argv[i + 1]) args.language = argv[++i];
    else if (argv[i] === '--message' && argv[i + 1]) args.message = argv[++i];
    else if (argv[i] === '--relay' && argv[i + 1]) args.relay = argv[++i];
    else if (argv[i] === '--wallet-id' && argv[i + 1]) args.walletId = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

function printHelp(): void {
  console.log(`
Usage: invite-device --email <addr> [options]

Email a human a one-time line that stands up an AGENT-owned device - no API key
to paste. The device's Provenance Envelopes attribute to your agent wallet;
every act of work mints PVT once at its best-supported value. The setup link
authorizes device registration only.

Options:
  --email <addr>        Destination email (required)
  --device-name <name>  Suggested device name (optional)
  --language <code>     Email locale (en/es/fr/hi/id/ja/ko/pt/sw/tl/vi/zh; default en)
  --message <text>      Note to include in the email (optional)
  --relay <url>         Relay URL (default: ${RELAY_URL})
  --wallet-id <id>      Agent wallet id override (otherwise resolved from
                        ~/.provian/agent-credentials.json, then agent-wallet/session)
  --help, -h            Show this help

Auth: the agent API key + secret are read from the 0600-enforced
~/.provian/agent-credentials.json. The secret is never printed; the one-time
token never leaves the relay (it is delivered only in the email).

Example:
  npx @provian/agent-sdk invite-device --email bob@example.com --device-name "Bob's CI box"
`);
}

/**
 * Resolve the agent wallet id, in precedence order:
 *   1. --wallet-id flag
 *   2. agent-credentials.json wallet_id
 *   3. ~/.provian/agent-wallet (single-line file written by create-agent-wallet)
 *   4. session.json agentWalletId
 */
function resolveWalletId(flagWalletId: string | undefined, credsWalletId: string | undefined): string | null {
  if (flagWalletId) return flagWalletId;
  if (credsWalletId) return credsWalletId;
  try {
    if (fs.existsSync(AGENT_WALLET_FILE)) {
      const raw = fs.readFileSync(AGENT_WALLET_FILE, 'utf-8').trim();
      if (raw) return raw;
    }
  } catch {
    // fall through to session lookup
  }
  const session = readSessionFile();
  if (session?.agentWalletId) return session.agentWalletId;
  return null;
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (!args.email) {
    console.error('Error: --email <addr> is required.');
    console.error('Run: npx @provian/agent-sdk invite-device --help');
    process.exit(2);
  }

  // 0600-enforced loader; returns null and prints chmod guidance if the file is
  // too permissive or absent. We NEVER print the api_secret.
  const creds = loadAgentCredentialsFile();
  if (!creds || !creds.api_key || !creds.api_secret) {
    console.error('Error: no usable agent credentials at ~/.provian/agent-credentials.json.');
    console.error('Create one with create-agent-wallet, then chmod 600 the file.');
    process.exit(2);
  }

  const walletId = resolveWalletId(args.walletId, creds.wallet_id);
  if (!walletId) {
    console.error('Error: could not resolve the agent wallet id.');
    console.error('Add "wallet_id" to ~/.provian/agent-credentials.json or pass --wallet-id <wallet_aw_...>.');
    process.exit(2);
  }

  const relayUrl = args.relay ?? RELAY_URL;

  const result: InviteDeviceResult = await runInviteDevice({
    relayUrl,
    walletId,
    email: args.email,
    language: args.language,
    deviceName: args.deviceName,
    message: args.message,
    creds: { apiKey: creds.api_key, apiSecret: creds.api_secret },
    fetch: fetch,
  });

  if (result.status === 'error') {
    console.error('');
    console.error(`Invite failed: ${result.error}`);
    process.exit(1);
  }

  const expiresIso = new Date(result.expiresAt).toISOString();
  console.log('');
  console.log('Device invite sent.');
  console.log(`  Recipient:   ${args.email.trim()}`);
  console.log(`  Agent wallet: ${walletId}`);
  console.log(`  Expires:     ${expiresIso}`);
  console.log('');
  console.log('  What happens next:');
  console.log('  1. The recipient opens the email ON the machine to enroll.');
  console.log('  2. They run the one-time line:');
  console.log('       npx @provian/agent-sdk register-device --agent-token <token>');
  console.log('  3. The machine registers as an AGENT device. No API key to paste.');
  console.log('');
  console.log('  Work the device witnesses becomes Provenance Envelopes on the agent chain;');
  console.log('  every act of work mints PVT once at its best-supported value. Linked agents follow');
  console.log('  the configured split; unlinked agents keep their full contributor share.');
  console.log('  The setup link authorizes device registration only.');
  console.log('');
  process.exit(0);
}

// Only auto-run when invoked as a script, not when imported by tests.
if (isDirectCliEntry(module)) {
  main().catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
  });
}
