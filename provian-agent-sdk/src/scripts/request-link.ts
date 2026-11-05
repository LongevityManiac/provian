#!/usr/bin/env node
/**
 * request-link - ask your human to link this agent, using the connection code
 * they handed you. Closes the onboarding gap: after create-agent-wallet +
 * register-device, this files the link request so the whole flow is one
 * connection code. The bootstrap flow (`onboard`) already does this automatically
 * when it has your API credentials; this command is the explicit/retry form.
 *
 * The human authorizes the link in their app (their wallet auth + biometric) —
 * that is the security anchor. This command only files the request.
 *
 * Usage:
 * npx @provian/agent-sdk request-link --token PROV-XXXX-XXXX
 */

import { loadAgentCredentialsFile } from './agent-credentials-file';
import { requestLink } from '../request-link';

const RELAY_URL = 'https://api.provian.ai';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--token' && argv[i + 1]) args.token = argv[++i];
    else if (argv[i] === '--relay' && argv[i + 1]) args.relay = argv[++i];
    else if (argv[i] === '--wallet' && argv[i + 1]) args.wallet = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(`
Usage: request-link [options]

Options:
  --token <token>    Connection code from your human's Provian app (required)
  --wallet <id>      Agent wallet id (default: from ~/.provian/agent-credentials.json)
  --relay <url>      Relay URL (default: ${RELAY_URL})
  --help, -h         Show this help
`);
      process.exit(0);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = args.token as string;
  if (!token) {
    console.error('  Error: --token is required (the connection code from your human\'s app).\n');
    process.exit(1);
  }
  const relayUrl = (args.relay as string) || RELAY_URL;

  const creds = loadAgentCredentialsFile();
  if (!creds || !creds.api_key || !creds.api_secret || !creds.wallet_id) {
    console.error('  Error: no agent credentials found at ~/.provian/agent-credentials.json.');
    console.error('  Create your wallet first: npx @provian/agent-sdk create-agent-wallet\n');
    process.exit(1);
  }
  const walletId = (args.wallet as string) || creds.wallet_id;
  if (walletId !== creds.wallet_id) {
    console.error(`  Error: --wallet ${walletId} does not match your stored credentials (${creds.wallet_id}).\n`);
    process.exit(1);
  }

  console.log('\n  Filing a link request to your human...\n');
  const result = await requestLink({
    relayUrl, walletId, connectionToken: token,
    apiKey: creds.api_key, apiSecret: creds.api_secret,
  });

  if (result.ok && result.linkStatus === 'already_linked') {
    console.log('  Already linked to your human — earning at the linked rate.\n');
    return;
  }
  if (result.ok && result.linkStatus === 'linked') {
    // a fleet code from any of the human's linked agents links directly.
    console.log('  Linked to your human (fleet code) — no Accept needed.\n');
    return;
  }
  if (result.ok) {
    console.log('  ┌───────────────────────────────────────────┐');
    console.log('  │  Link requested — waiting on your human    │');
    console.log('  └───────────────────────────────────────────┘\n');
    console.log('  Open the Provian app and tap Accept to authorize the link.');
    console.log('  Only your human can approve it — they are the security anchor.\n');
    return;
  }

  if (result.error === 'connection_token_issuer_unresolved') {
    console.error('  Error: that connection code is unknown or expired.');
    console.error('  Ask your human to generate a fresh code in the Provian app.\n');
  } else if (result.error === 'agent_already_linked') {
    console.error('  Error: this agent is already linked to a different human.\n');
  } else if (result.error === 'connection_token_expired') {
    console.error('  Error: that code has expired (codes last one hour).');
    console.error('  Ask for a fresh code — from the Provian app, or from any of your linked agents (`fleet-code`).\n');
  } else if (result.error === 'connection_token_already_used') {
    console.error('  Error: that fleet code already linked another agent. Ask any of your linked agents for a fresh one.\n');
  } else {
    console.error(`  Error: link request failed (${result.error ?? 'unknown'}).\n`);
  }
  process.exit(1);
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
