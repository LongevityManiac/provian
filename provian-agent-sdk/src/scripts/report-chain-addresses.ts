#!/usr/bin/env node
import { guardedFetch as fetch, guardedFetcher } from '../guarded-fetch';
/**
 * report-chain-addresses — publish this agent's self-sovereign per-chain
 * addresses to the relay so the app can show + fund them.
 *
 * An agent's Solana address is derived from its OWN key (a SHA-512 KDF the relay
 * can never reproduce — it holds no private key). A wallet created before Solana
 * support, or before it reported one, has no `chain_addresses` on the relay, so
 * the app cannot display or fund the agent on Solana. This one-shot backfills it
 * WITHOUT re-onboarding: it reads the local keystore, derives the addresses, and
 * POSTs them under the agent's own API credentials.
 *
 * Usage:
 * npx @provian/agent-sdk report-chain-addresses
 * npx @provian/agent-sdk report-chain-addresses --print # derive + print only
 *
 * Key handling: the keystore passphrase is read from PROVIAN_KEYSTORE_PASSPHRASE,
 * or — for a passphrase-less two-touch install — from ~/.provian/agent-keystore.secret.
 * The private key is decrypted in-process, used to derive the addresses, and
 * never printed or written anywhere. Only the derived (public) addresses leave
 * this machine.
 *
 * EARNING BOUNDARY: chain addresses are display-only. Reporting them grants no
 * auth, mint, or economic effect.
 */

import { loadAgentCredentialsFile } from './agent-credentials-file';
import { loadKeystore, decryptKeystore, getDefaultKeystorePath } from '../keystore';
import { readLocalKeystoreSecret } from '../local-keystore-secret';
import { deriveEVMAddress, deriveSolanaAddress } from '../chains';
import { isDirectCliEntry } from './cli-entry';

const RELAY_URL = 'https://api.provian.ai';
const PASSPHRASE_ENV = 'PROVIAN_KEYSTORE_PASSPHRASE';

interface Args {
  relay?: string;
  print?: boolean;
  help?: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--relay' && argv[i + 1]) args.relay = argv[++i];
    else if (argv[i] === '--print') args.print = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

function printHelp(): void {
  console.log(`
Usage: report-chain-addresses [options]

Publish this agent's self-sovereign per-chain addresses (EVM + Solana) to the
relay so the app can show + fund them. Derives Solana from the local key; the
key never leaves this machine.

Options:
  --relay <url>   Relay URL (default: ${RELAY_URL})
  --print         Derive and print the addresses, do not report them
  --help, -h      Show this help

Key handling: set ${PASSPHRASE_ENV}, or rely on the passphrase-less
~/.provian/agent-keystore.secret for a two-touch install.
`);
}

/** Resolve the keystore passphrase from the env or the local at-rest secret. */
export function resolvePassphrase(): string | null {
  const fromEnv = process.env[PASSPHRASE_ENV];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return readLocalKeystoreSecret();
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const keystore = loadKeystore();
  if (!keystore) {
    console.error(`Error: no keystore at ${getDefaultKeystorePath()}.`);
    console.error('Create the agent wallet first (create-agent-wallet), then re-run this.');
    process.exit(2);
    return;
  }

  const passphrase = resolvePassphrase();
  if (!passphrase) {
    console.error(`Error: cannot unlock the keystore. Set ${PASSPHRASE_ENV}, or ensure`);
    console.error('~/.provian/agent-keystore.secret exists (two-touch installs).');
    process.exit(2);
    return;
  }

  let evm: string;
  let solana: string;
  try {
    const decrypted = decryptKeystore(keystore, passphrase);
    evm = deriveEVMAddress(decrypted.privateKey);
    solana = deriveSolanaAddress(decrypted.privateKey);
  } catch (err) {
    console.error(`Error: could not decrypt the keystore (${(err as Error).message}).`);
    console.error(`Check ${PASSPHRASE_ENV}.`);
    process.exit(1);
    return;
  }

  console.log('');
  console.log('Derived self-sovereign addresses:');
  console.log(`  EVM:    ${evm}`);
  console.log(`  Solana: ${solana}`);
  console.log('');

  if (args.print) {
    console.log('  Fund the agent on Solana by sending USDC + a little SOL for fees to the');
    console.log('  Solana address above. (--print: not reported to the relay.)');
    console.log('');
    process.exit(0);
    return;
  }

  const creds = loadAgentCredentialsFile();
  if (!creds || !creds.api_key || !creds.api_secret || !creds.wallet_id) {
    console.error('Error: no usable agent credentials at ~/.provian/agent-credentials.json.');
    console.error('Re-run --print to derive the address without reporting, or restore the');
    console.error('credentials file, then re-run.');
    process.exit(2);
    return;
  }

  const relayUrl = (args.relay ?? RELAY_URL).replace(/\/+$/, '');
  const url = `${relayUrl}/v1/agent/wallet/${encodeURIComponent(creds.wallet_id)}/chain-addresses`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creds.api_key}:${creds.api_secret}`,
      },
      body: JSON.stringify({ chain_addresses: { evm, solana } }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`Report failed (HTTP ${res.status}): ${body}`);
      process.exit(1);
      return;
    }
    console.log('Reported to the relay. The app can now show + fund the agent on Solana.');
    console.log('');
    process.exit(0);
  } catch (err) {
    console.error(`Report failed: ${(err as Error).message}`);
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
