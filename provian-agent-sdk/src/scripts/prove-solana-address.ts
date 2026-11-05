#!/usr/bin/env node
/**
 * prove-solana-address — prove this agent's Solana address to the relay, so its
 * Solana x402 payments and receipts become witnessed PEs. Proving pays nothing (a
 * record_only receipt); activity counts only from the proof's slot forward.
 *
 * The one-command onboarding already does this by default. This verb is the explicit /
 * catch-up form: run it if this agent was created before the proof was default-on, or
 * if the onboarding step did not complete. It calls the same implementation
 * (src/solana-address-proof.ts). IDEMPOTENT: an address already proven to this agent is
 * a clean no-op.
 *
 * Usage (npm: `npx @provian/agent-sdk prove-solana-address`; hosted: `"$HOME/.provian/bin/provian" prove-solana-address`):
 *   prove-solana-address                       # the agent's OWN Solana address (origin native)
 *   prove-solana-address --address <base58>    # a Solana keypair the agent already holds
 *                                              # (origin external; key from the env, below)
 *
 * KEY HANDLING: the agent's own key is decrypted from ~/.provian/agent-keystore.json for
 * one call and dropped. An external Solana secret key is read ONLY from the environment
 * variable PROVIAN_EXTERNAL_SOLANA_SECRET_KEY (base58, or a JSON array of 64 bytes — the
 * Solana CLI keypair file format) — never a flag, never printed, never written.
 */

import { base58 } from '@scure/base';
import { loadInstalledAgent, InstalledAgentError } from '../installed-agent';
import {
  fetchOwnAgentId,
  proveExternalSolanaAddress,
  proveSolanaAddress,
  SolanaAddressProofError,
  type SolanaAddressProof,
  type SolanaAddressProofConfig,
} from '../solana-address-proof';
import { isDirectCliEntry } from './cli-entry';

const EXTERNAL_KEY_ENV = 'PROVIAN_EXTERNAL_SOLANA_SECRET_KEY';

interface Args { address?: string; agentId?: string; relay?: string; help?: boolean }

export function parseProveSolanaArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--address' && argv[i + 1]) args.address = argv[++i];
    else if (argv[i] === '--agent-id' && argv[i + 1]) args.agentId = argv[++i];
    else if (argv[i] === '--relay' && argv[i + 1]) args.relay = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

const HELP = `
Usage: prove-solana-address [options]

Prove this agent's Solana address to Provian, so its Solana x402 payments and
receipts become witnessed PEs. Proving pays nothing. Idempotent.

Options:
  --address <base58>   Prove a Solana keypair you already hold instead of the agent's
                       own address (secret key from ${EXTERNAL_KEY_ENV})
  --agent-id <id>      This agent's id (default: read from the relay)
  --relay <url>        Relay URL (default: PROVIAN_RELAY_URL, else https://api.provian.ai)
  --help, -h           Show this help
`;

/** A Solana secret key from base58 or a JSON byte array. Never logged. */
export function parseSolanaSecretKey(raw: string): Uint8Array {
  const text = raw.trim();
  if (text.startsWith('[')) {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error('not a byte array');
    }
    return Uint8Array.from(parsed as number[]);
  }
  return base58.decode(text);
}

function describeFailure(err: unknown): string {
  if (err instanceof InstalledAgentError) return err.message;
  if (err instanceof SolanaAddressProofError) {
    switch (err.code) {
      case 'SOLANA_ADDRESS_BOUND_TO_OTHER_OWNER': return 'That Solana address is already proven by someone else, so it cannot be bound to this agent.';
      case 'SOLANA_ADDRESS_IS_SERVICE_WALLET': return 'That Solana address is one of Provian\'s own service wallets and cannot be proven.';
      case 'SOLANA_PROOF_AUTH_REJECTED': return 'Your agent credentials were rejected. Re-check ~/.provian/agent-credentials.json.';
      case 'SOLANA_PROOF_UNAVAILABLE': return 'The relay cannot take proofs right now. Try again shortly.';
      case 'SOLANA_PROOF_CHALLENGE_UNTRUSTED':
      case 'SOLANA_PROOF_CHALLENGE_EXPIRED': return 'The relay\'s challenge was not the expected proof message, so nothing was signed. Try again shortly.';
      case 'SOLANA_PROOF_KEY_MISMATCH': return `The key in ${EXTERNAL_KEY_ENV} does not control that address.`;
      default: return `Proving the Solana address did not complete (${err.code}). Try again later.`;
    }
  }
  return 'Proving the Solana address did not complete. Try again later.';
}

/** The verb body (the npm bin and the hosted bundle's `prove-solana-address`). Returns an exit code. */
export async function runProveSolanaAddressCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseProveSolanaArgs(argv);
  if (args.help) { console.log(HELP); return 0; }
  try {
    const env = args.relay ? { ...process.env, PROVIAN_RELAY_URL: args.relay } : process.env;
    const agent = loadInstalledAgent({ env });
    const config: SolanaAddressProofConfig = {
      relayUrl: agent.config.relayUrl, apiKey: agent.config.apiKey, apiSecret: agent.config.apiSecret,
    };
    const agentId = args.agentId ?? (process.env.PROVIAN_AGENT_ID || undefined) ?? await fetchOwnAgentId(config, agent.walletId);

    let proof: SolanaAddressProof;
    if (args.address) {
      const raw = process.env[EXTERNAL_KEY_ENV];
      if (!raw) {
        console.error(`  Set ${EXTERNAL_KEY_ENV} to that address's secret key (base58 or a JSON byte array) and run this again.`);
        return 2;
      }
      let secretKey: Uint8Array;
      try { secretKey = parseSolanaSecretKey(raw); } catch {
        console.error(`  ${EXTERNAL_KEY_ENV} is not a base58 key or a JSON byte array.`);
        return 2;
      }
      try {
        proof = await proveExternalSolanaAddress(config, { address: args.address, agentId, secretKey });
      } finally {
        secretKey.fill(0);
      }
    } else {
      proof = await agent.withKey((privateKeyHex) => proveSolanaAddress(config, { privateKeyHex, agentId }));
    }
    console.log(proof.already_proven
      ? `\n  Your Solana address ${proof.proven_address} was already proven — nothing to do.\n`
      : `\n  Proved your Solana address ${proof.proven_address}. Its Solana x402 payments and receipts are now witnessed (from this point forward). Proving paid nothing.\n`);
    return 0;
  } catch (err) {
    console.error(`  ${describeFailure(err)}`);
    return 1;
  }
}

if (isDirectCliEntry(module)) {
  runProveSolanaAddressCli().then((code) => process.exit(code)).catch(() => {
    console.error('  Proving the Solana address did not complete. Try again later.');
    process.exit(1);
  });
}
