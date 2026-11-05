#!/usr/bin/env node
import { guardedFetch as fetch, guardedFetcher } from '../guarded-fetch';
/**
 * link-external-address - prove control of an external EVM wallet you already run.
 *
 * The address's go-forward on-chain FINANCIAL activity on Base (USDC receive /
 * send / swap / x402 settlement) then maps to Provenance Envelopes on the
 * standard record path. No new wallet, no custody move, no gas — the proof is a
 * single off-chain signature. Verify IS the link.
 *
 * Usage:
 *   npx @provian/agent-sdk link-external-address --address 0xabc...
 *   npx @provian/agent-sdk link-external-address --address 0xabc... --print-message
 *
 * Flags:
 *   --address <0x...>   The external address to prove (required)
 *   --relay <url>       Relay URL (default: https://api.provian.ai)
 *   --print-message     Print the challenge to sign elsewhere (hardware wallet,
 *                       EIP-1271 contract wallet, custodian) and exit WITHOUT
 *                       signing. Pair with --challenge-id/--signature to submit.
 *   --challenge-id <id> Submit a signature produced out of band
 *   --signature <0x...> Submit a signature produced out of band
 *   --help, -h          Show this help
 *
 * KEY HANDLING: the external private key is read from the environment variable
 * PROVIAN_EXTERNAL_PRIVATE_KEY. It is never accepted as a command-line flag (it
 * would land in shell history and `ps`), never printed, and never written to
 * disk. If you would rather not put the key on this machine at all, use
 * --print-message and sign wherever the key already lives.
 *
 * Agent auth comes from the 0600-enforced ~/.provian/agent-credentials.json.
 * The relay takes the agent_id from the authenticated wallet, never from this
 * command, so an address can only ever be bound to YOUR agent.
 *
 * EARNING BOUNDARY: proving is attribution, not activity. The proof PE is
 * record-only and does not mint separately. Prior and same-head history never
 * mints — it sets a read-only reputation tier. Go-forward on-chain work mints
 * once on the standard lane at its chain-witnessed value.
 */

import { loadAgentCredentialsFile } from './agent-credentials-file';
import {
  assertChallengeBindsToAddress,
  linkExternalAddress,
  requestExternalAddressChallenge,
  verifyExternalAddress,
  type ExternalAddressConfig,
} from '../external-address';
import { isDirectCliEntry } from './cli-entry';

const RELAY_URL = 'https://api.provian.ai';
const KEY_ENV = 'PROVIAN_EXTERNAL_PRIVATE_KEY';

interface LinkArgs {
  address?: string;
  relay?: string;
  printMessage?: boolean;
  challengeId?: string;
  signature?: string;
  help?: boolean;
}

export function parseArgs(argv: string[]): LinkArgs {
  const args: LinkArgs = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--address' && argv[i + 1]) args.address = argv[++i];
    else if (argv[i] === '--relay' && argv[i + 1]) args.relay = argv[++i];
    else if (argv[i] === '--challenge-id' && argv[i + 1]) args.challengeId = argv[++i];
    else if (argv[i] === '--signature' && argv[i + 1]) args.signature = argv[++i];
    else if (argv[i] === '--print-message') args.printMessage = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

function printHelp(): void {
  console.log(`
Usage: link-external-address --address <0x...> [options]

Prove control of an external EVM wallet you already run. Its go-forward on-chain
financial activity on Base then maps to Provenance Envelopes on the standard
record path. No new wallet, no custody move, no gas.

Options:
  --address <0x...>   The external address to prove (required)
  --relay <url>       Relay URL (default: ${RELAY_URL})
  --print-message     Print the challenge and exit without signing (sign it on a
                      hardware wallet / contract wallet / custodian instead)
  --challenge-id <id> Submit a signature produced out of band
  --signature <0x...> Submit a signature produced out of band
  --help, -h          Show this help

Key handling: set ${KEY_ENV} in the environment. The key is never
accepted as a flag, never printed, and never written to disk. Prefer
--print-message if the key should not touch this machine.

Examples:
  export ${KEY_ENV}=0x...
  npx @provian/agent-sdk link-external-address --address 0xabc...

  # sign elsewhere (contract wallet / hardware wallet):
  npx @provian/agent-sdk link-external-address --address 0xabc... --print-message
  npx @provian/agent-sdk link-external-address --address 0xabc... \\
      --challenge-id <id> --signature 0x...
`);
}

function printProof(proof: {
  proven_address: string;
  proven_at_block: number;
  proof_method: string;
  already_proven?: boolean;
  pe_id?: string;
  initial_reputation_tier?: number;
}): void {
  console.log('');
  console.log(proof.already_proven ? 'Address already linked (idempotent).' : 'External address linked.');
  console.log(`  Address:        ${proof.proven_address}`);
  console.log(`  Proof method:   ${proof.proof_method}`);
  console.log(`  Eligibility fence (H+1): block ${proof.proven_at_block}`);
  if (proof.pe_id) console.log(`  Proof PE:       ${proof.pe_id}`);
  if (typeof proof.initial_reputation_tier === 'number') {
    console.log(`  Reputation tier: ${proof.initial_reputation_tier} (read-only; mints 0 PVT)`);
  }
  console.log('');
  console.log('  Go-forward financial activity from this address on Base now maps to PEs on the');
  console.log('  standard record path. Prior and same-head history is never able to mint.');
  console.log('  Go-forward activity mints once at its best-supported value on the standard lane, subject to caps');
  console.log('  and protocol policy.');
  console.log('');
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.address) {
    console.error('Error: --address <0x...> is required.');
    console.error('Run: npx @provian/agent-sdk link-external-address --help');
    process.exit(2);
  }

  const creds = loadAgentCredentialsFile();
  if (!creds || !creds.api_key || !creds.api_secret) {
    console.error('Error: no usable agent credentials at ~/.provian/agent-credentials.json.');
    console.error('Create one with create-agent-wallet, then chmod 600 the file.');
    process.exit(2);
  }

  const config: ExternalAddressConfig = {
    relayUrl: args.relay ?? RELAY_URL,
    apiKey: creds.api_key,
    apiSecret: creds.api_secret,
    fetch: fetch,
  };

  try {
    // Out-of-band submit: the caller already signed the challenge elsewhere.
    if (args.challengeId || args.signature) {
      if (!args.challengeId || !args.signature) {
        console.error('Error: --challenge-id and --signature must be supplied together.');
        process.exit(2);
      }
      printProof(await verifyExternalAddress(config, {
        address: args.address,
        challengeId: args.challengeId,
        signature: args.signature,
      }));
      process.exit(0);
    }

    // Print-only: issue the challenge, verify it binds to this address, print it.
    if (args.printMessage) {
      const challenge = await requestExternalAddressChallenge(config, { address: args.address });
      assertChallengeBindsToAddress(challenge, args.address);
      console.log('');
      console.log('Sign this exact message with the address\'s key (EIP-191 personal_sign),');
      console.log('or with an EIP-1271 owner key for a contract wallet:');
      console.log('');
      console.log(challenge.message);
      console.log('');
      console.log(`  challenge_id: ${challenge.challenge_id}`);
      console.log(`  expires:      ${new Date(challenge.expires_at).toISOString()}`);
      console.log('');
      console.log('Then submit it:');
      console.log(`  npx @provian/agent-sdk link-external-address --address ${args.address} \\`);
      console.log(`      --challenge-id ${challenge.challenge_id} --signature 0x...`);
      console.log('');
      process.exit(0);
    }

    const privateKey = process.env[KEY_ENV];
    if (!privateKey) {
      console.error(`Error: ${KEY_ENV} is not set.`);
      console.error('Set it in the environment, or use --print-message to sign elsewhere.');
      console.error('The key is never accepted as a command-line flag.');
      process.exit(2);
    }

    printProof(await linkExternalAddress(config, { address: args.address, privateKey }));
    process.exit(0);
  } catch (err) {
    console.error('');
    console.error(`Link failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

// Only auto-run when invoked as a script, not when imported by tests.
if (isDirectCliEntry(module)) {
  main().catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
  });
}
