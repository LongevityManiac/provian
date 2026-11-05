#!/usr/bin/env node
/**
 * fleet-code — any of your linked agents onboards your other agents.
 *
 * "Any of your linked agents can onboard your other agents — each gets its own
 * wallet, linked to you."
 *
 * Run by an agent that is already LINKED to its human. Prints a one-hour,
 * single-use link code and the install line for ONE other agent. That agent runs
 * the line on its own machine: its wallet key is generated there (this command
 * never sees, carries or ships a key), and the link to the same human forms
 * without a tap in the app. Run it once per agent.
 *
 * Usage:
 * npx @provian/agent-sdk fleet-code # after the npm publish
 * node "$HOME/.provian/agent.js" fleet-code # the hosted install's bundle
 * … fleet-code --json # one JSON object on stdout
 */

import { loadAgentCredentialsFile } from './agent-credentials-file';
import { issueFleetCode, friendlyFleetCodeError } from '../fleet-code';
import { isDirectCliEntry } from './cli-entry';

const RELAY_URL = 'https://api.provian.ai';
const FLEET_ONBOARDING_LINE = 'Any of your linked agents can onboard your other agents — each gets its own wallet, linked to you.';

function printHelp(): void {
  console.log(`
Usage: fleet-code [--json] [--relay <url>]

${FLEET_ONBOARDING_LINE}

Prints a one-hour, single-use link code and the install line for ONE other agent
of your human. That agent runs the line on its own machine; its key is generated
there, and it links to your human with no tap in the app. Run once per agent.
Requires this agent to be linked to its human already.

Options:
  --json          Print one JSON object: { code, expires_at, install_line: { sh, powershell } }
  --relay <url>   Relay URL (default: ${RELAY_URL})
  --help, -h      Show this help
`);
}

export async function runFleetCodeCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  let json = false;
  let relay: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') json = true;
    else if (argv[i] === '--relay' && argv[i + 1]) relay = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') { printHelp(); process.exit(0); }
  }
  const relayUrl = relay || process.env.PROVIAN_RELAY_URL || RELAY_URL;

  const creds = loadAgentCredentialsFile();
  if (!creds || !creds.api_key || !creds.api_secret || !creds.wallet_id) {
    console.error('  Error: no agent credentials with a wallet id at ~/.provian/agent-credentials.json.');
    console.error('  This command runs on an agent that was installed with the Provian install line.\n');
    process.exit(1);
  }

  const result = await issueFleetCode({
    relayUrl, walletId: creds.wallet_id, apiKey: creds.api_key, apiSecret: creds.api_secret,
  });
  if (!result.ok || !result.code || !result.installLine || result.expiresAt === undefined) {
    console.error(`  ${friendlyFleetCodeError(result.error)}\n`);
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify({
      code: result.code,
      expires_at: result.expiresAt,
      install_line: result.installLine,
    }));
    return;
  }
  const minutes = Math.max(1, Math.round((result.expiresAt - Date.now()) / 60_000));
  console.log('');
  console.log(`  ${FLEET_ONBOARDING_LINE}`);
  console.log('');
  console.log(`  Code: ${result.code}   (one agent, expires in ${minutes} min)`);
  console.log('');
  console.log('  Run this on the OTHER agent\'s own machine:');
  console.log(`    macOS / Linux:  ${result.installLine.sh}`);
  console.log(`    Windows:        ${result.installLine.powershell}`);
  console.log('');
  console.log('  It gets its own wallet (its key is made there) and links to your human — no tap needed.');
  console.log('  Run this command again for each additional agent.\n');
}

if (isDirectCliEntry(module)) {
  runFleetCodeCli().catch((error) => {
    console.error('Unexpected error:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
