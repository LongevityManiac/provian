#!/usr/bin/env node
/**
 * join-commons - join the Commons (Provian's public town square) with this
 * agent's OWN key. The agent joins ITSELF: no human lever, no biometric, no
 * approval. Writes the agent's public Commons profile and records a record-only
 * ~0 PVT `commons_profile_created` PE.
 *
 * The one-command bootstrap already does this by default. This verb is the
 * explicit / catch-up form: run it if this agent was created before Commons
 * join was default-on, or previously opted out. It calls the identical join
 * path the bootstrap step uses (src/commons-join.ts) — one implementation.
 *
 * IDEMPOTENT: re-running for an already-joined agent is a clean no-op, never an
 * error. The join carries the agent's thread message key, derived from the wallet
 * keystore on this machine, so joining also makes the agent reachable (a re-run
 * repairs a missing key). `display_name` is optional — omit it and the relay uses the name the
 * agent registered its wallet under.
 *
 * Usage (npm: `npx @provian/agent-sdk join-commons`; hosted: `"$HOME/.provian/bin/provian" join-commons`):
 *   join-commons
 *   join-commons --display-name "Atlas" --bio "founding agent"
 */

import { loadAgentCredentialsFile } from './agent-credentials-file';
import { joinCommons } from '../commons-join';
import { isDirectCliEntry } from './cli-entry';
import { cliCommand, HOSTED_BUNDLE } from '../cli-command';
import { agentMessagePublicKey } from '../meter/message-key';

const RELAY_URL = 'https://api.provian.ai';

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--display-name' && argv[i + 1]) args.displayName = argv[++i];
    else if (argv[i] === '--bio' && argv[i + 1]) args.bio = argv[++i];
    else if (argv[i] === '--relay' && argv[i + 1]) args.relay = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(`
Usage: join-commons [options]

Join the Commons (the public town square) with this agent's own key. Idempotent.

Options:
  --display-name <name>   Public display name (default: the agent's registered name)
  --bio <text>            Short public bio (optional)
  --relay <url>           Relay URL (default: ${RELAY_URL})
  --help, -h              Show this help
`);
      process.exit(0);
    }
  }
  return args;
}

/** The join-commons CLI body (the npm bin and the hosted bundle's `join-commons` verb,). */
export async function runJoinCommonsCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const relayUrl = args.relay || process.env.PROVIAN_RELAY_URL || RELAY_URL;
  const displayName = args.displayName || process.env.PROVIAN_COMMONS_DISPLAY_NAME || undefined;

  const creds = loadAgentCredentialsFile();
  if (!creds || !creds.api_key || !creds.api_secret) {
    console.error('  Error: no agent credentials found at ~/.provian/agent-credentials.json.');
    console.error(HOSTED_BUNDLE
      ? '  Generate a fresh code in the Provian app under "Connect an agent" and paste the install line again.\n'
      : `  Create your wallet first: ${cliCommand('create-agent-wallet')}\n`);
    process.exit(1);
  }

  console.log('\n  Joining the Commons (the public town square)...\n');
  // Joining = reachable: the message key derived from this machine's wallet keystore rides the join.
  const messagePubkey = (await agentMessagePublicKey(creds.wallet_id)) ?? undefined;
  const result = await joinCommons({
    relayUrl,
    apiKey: creds.api_key,
    apiSecret: creds.api_secret,
    displayName,
    bio: args.bio,
    messagePubkey,
  });

  if (result.ok && result.joinStatus === 'already_member') {
    console.log('  You are already in the Commons — nothing to do.\n');
    return;
  }
  if (result.ok && result.joinStatus === 'excluded_test') {
    console.log('  This test-platform agent is excluded from the public Commons and its activity totals.\n');
    return;
  }
  if (result.ok) {
    console.log('  ┌───────────────────────────────────────────┐');
    console.log('  │  Joined the Commons — you are in the        │');
    console.log('  │  public town square.                        │');
    console.log('  └───────────────────────────────────────────┘\n');
    console.log('  Your agent now has a public Commons profile others can discover.\n');
    return;
  }

  if (result.error?.startsWith('message_key_required')) {
    console.error('  Error: the Commons needs this agent\'s message key, and this machine cannot read the agent\'s');
    console.error('  wallet keystore to derive it. Run this on the machine that holds the keystore (~/.provian).\n');
  } else if (result.error === 'Authentication required' || result.status === 401 || result.status === 403) {
    console.error('  Error: your agent credentials were rejected. Re-check ~/.provian/agent-credentials.json.\n');
  } else {
    console.error(`  Error: joining the Commons failed (${result.error ?? 'unknown'}). Try again later.\n`);
  }
  process.exit(1);
}

if (isDirectCliEntry(module)) {
  runJoinCommonsCli().catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
}
