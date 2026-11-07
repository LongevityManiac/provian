#!/usr/bin/env node
/**
 * create-agent-wallet - Agent opt-in: self-create a Provian agent wallet and
 * persist its key in an AES-256-GCM encrypted keystore.
 *
 * This is the explicit, agent-initiated opt-in step. Connecting to a human
 * (the retired connect-agent,) never created a wallet; it left the agent in governance-
 * only mode. Running this command is how the agent chooses to mint a wallet,
 * unlock PVT earning, and - if the human issued a beneficiary invite when they
 * generated the connection token - bind that pending link onto the new wallet.
 *
 * Non-custodial: the secp256k1 key is generated on this machine. The relay
 * verifies proof-of-possession and never holds the key or anything that can
 * decrypt it; any copy that leaves this machine is ciphertext (the encrypted
 * keystore export below, or a recovery copy sealed to the inviting human's phone).
 *
 * The private key is encrypted at rest with a passphrase. Provide it via
 * PROVIAN_KEYSTORE_PASSPHRASE (required for non-interactive runs) or you will
 * be prompted. There is NO cloud backup - back up the keystore yourself:
 * npx @provian/agent-sdk export-agent-keystore./agent-keystore.backup.json
 *
 * Usage:
 * npx @provian/agent-sdk create-agent-wallet --accept-constitution
 * npx @provian/agent-sdk create-agent-wallet --accept-constitution --name "Atlas" --platform sdk
 * PROVIAN_KEYSTORE_PASSPHRASE=... npx @provian/agent-sdk create-agent-wallet --accept-constitution
 */

import { hostname } from 'os';
import * as fs from 'fs';
import {
  decryptKeystore,
  persistAgentWalletKey,
  getDefaultKeystorePath,
  exportKeystore,
  loadKeystore,
} from '../keystore';
import {
  DEFAULT_PENDING_AGENT_WALLET_REGISTRATION_PATH,
  assertPendingAgentWalletRegistrationIdentity,
  loadOrCreatePendingAgentWalletRegistration,
  resumeAgentWalletRegistration,
} from '../pending-wallet-registration';
import {
  AGENT_CREDS_PATH,
  loadBoundAgentCredentialsFile,
  persistAgentCredentialsFile,
} from './agent-credentials-file';
import { readSecret } from './prompt-secret';
import { readSessionFile } from '../session-file';
import type { AgentWalletRegistrationHandle } from '../types';
import { deriveAddressFromPrivateKey } from '../wallet';
import { sealAndEscrow } from '../recovery-escrow-seal';
import {
  finalizeAgentWalletPromotion,
  restoreAgentWalletMarkers,
} from '../agent-wallet-promotion';

const RELAY_URL = 'https://api.provian.ai';

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--name' && argv[i + 1]) args.name = argv[++i];
    else if (argv[i] === '--platform' && argv[i + 1]) args.platform = argv[++i];
    else if (argv[i] === '--relay' && argv[i + 1]) args.relay = argv[++i];
    else if (argv[i] === '--agent-id' && argv[i + 1]) args.agentId = argv[++i];
    else if (argv[i] === '--backup' && argv[i + 1]) args.backup = argv[++i];
    else if (argv[i] === '--accept-constitution') args.acceptConstitution = 'true';
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(`
Usage: create-agent-wallet [options]

Options:
  --name <name>        Agent display name (default: hostname)
  --platform <id>      Platform identifier (default: sdk)
  --agent-id <id>      Agent id (default: from ~/.provian/session.json, else name)
  --backup <path>      Also write an encrypted off-device backup to <path> now
  --accept-constitution
                       Record optional acceptance of the Network Constitution
  --relay <url>        Relay URL (default: ${RELAY_URL})
  --help, -h           Show this help

Passphrase: set PROVIAN_KEYSTORE_PASSPHRASE for non-interactive runs, or you
will be prompted. The key is encrypted at rest; there is no cloud backup.

WARNING: the key exists only on this machine. If the machine is lost, wiped,
or fails before you back the keystore up off-device, the wallet and any funds
in it are permanently unrecoverable. Use --backup, or run export-agent-keystore
right after creation.
`);
      process.exit(0);
    }
  }
  return args;
}

async function resolvePassphrase(): Promise<string> {
  const fromEnv = process.env.PROVIAN_KEYSTORE_PASSPHRASE;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  if (!process.stdin.isTTY) {
    console.error('  Error: PROVIAN_KEYSTORE_PASSPHRASE is required for non-interactive runs.');
    process.exit(1);
  }

  const p1 = await readSecret('  Keystore passphrase (min 8 chars): ');
  if (p1.length < 8) {
    console.error('  Error: passphrase must be at least 8 characters.');
    process.exit(1);
  }
  const p2 = await readSecret('  Confirm passphrase: ');
  if (p1 !== p2) {
    console.error('  Error: passphrases do not match.');
    process.exit(1);
  }
  return p1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const session = readSessionFile();

  const relayUrl = args.relay || session?.relayUrl || RELAY_URL;
  const agentName = args.name || session?.agentId || hostname();
  const agentId = args.agentId || session?.serverAgentId || session?.agentId || agentName;
  const platform = args.platform || 'sdk';
  const pendingExists = fs.existsSync(DEFAULT_PENDING_AGENT_WALLET_REGISTRATION_PATH);
  const keystorePath = getDefaultKeystorePath();
  const keystoreExists = fs.existsSync(keystorePath);

  // Constitution acceptance is optional. Pass --accept-constitution to record
  // it on the birth-certificate PE; omitting it no longer blocks creation.
  if (session?.agentWalletId && !pendingExists && !keystoreExists) {
    console.error(`  This agent already has a wallet: ${session.agentWalletId}`);
    console.error('  Refusing to create a second wallet. Remove ~/.provian/session.json to start over.\n');
    process.exit(1);
  }

  const passphrase = await resolvePassphrase();

  // Repair the legacy legal-crash state from the old promotion order: final
  // encrypted key + exact same-wallet credentials survived, pending was
  // removed, but one or both non-secret markers were lost. Cross-bind every
  // durable artifact before writing anything; unknown/unbound state blocks.
  if (keystoreExists && !pendingExists) {
    try {
      const existingKeystore = loadKeystore(keystorePath);
      const existingCredentials = loadBoundAgentCredentialsFile();
      if (!existingKeystore
        || !existingCredentials?.wallet_id
        || !existingCredentials.address
        || existingCredentials.wallet_id !== existingKeystore.wallet_id
        || existingCredentials.address.toLowerCase() !== existingKeystore.address.toLowerCase()) {
        throw new Error('keystore and credentials do not carry one exact wallet/address binding');
      }
      const decrypted = decryptKeystore(existingKeystore, passphrase);
      if (deriveAddressFromPrivateKey(decrypted.privateKey).toLowerCase()
        !== existingKeystore.address.toLowerCase()) {
        throw new Error('encrypted key does not control the bound wallet address');
      }
      restoreAgentWalletMarkers({
        walletId: existingKeystore.wallet_id,
        session,
      });
      console.log(`\n  Restored durable local markers for existing wallet ${existingKeystore.wallet_id}.\n`);
      return;
    } catch (error) {
      console.error(`  A keystore already exists at ${keystorePath}, but safe marker recovery failed.`);
      console.error(`  ${(error as Error).message}`);
      console.error('  Refusing to overwrite or guess the existing wallet identity.\n');
      process.exit(1);
    }
  }

  console.log('\n  Generating agent wallet (key stays on this device)...\n');

  const registrationConfig = {
    relayUrl,
    agentId,
    agentName,
    platform,
    constitutionAccepted: args.acceptConstitution === 'true',
  };
  let registrationHandle: AgentWalletRegistrationHandle;
  try {
    registrationHandle = await loadOrCreatePendingAgentWalletRegistration(
      registrationConfig,
      passphrase,
    );
  } catch (error) {
    console.error(`  Unable to secure pending wallet identity: ${(error as Error).message}\n`);
    process.exit(1);
  }

  // Before any retry can rotate server credentials, cross-bind local artifacts
  // left by an earlier response/promotion attempt. A legacy or unrelated
  // credential file is never "migrated" by trying the network first.
  let completedLocalWalletId: string | null = null;
  try {
    const existingKeystore = loadKeystore(keystorePath);
    const credentialsFileExists = fs.existsSync(AGENT_CREDS_PATH);
    const existingCredentials = loadBoundAgentCredentialsFile();
    if (credentialsFileExists && !existingCredentials) {
      throw new Error('existing credentials file is malformed, unsafe, or unreadable');
    }
    if (existingCredentials && !existingKeystore) {
      throw new Error('existing credentials are not bound to a local final keystore');
    }
    if (existingKeystore) {
      const decrypted = decryptKeystore(existingKeystore, passphrase);
      if (deriveAddressFromPrivateKey(decrypted.privateKey).toLowerCase()
        !== existingKeystore.address.toLowerCase()) {
        throw new Error('existing encrypted key does not control its declared address');
      }
      assertPendingAgentWalletRegistrationIdentity(registrationHandle, {
        address: existingKeystore.address,
        publicKey: existingKeystore.public_key,
      });
      if (session?.agentWalletId && session.agentWalletId !== existingKeystore.wallet_id) {
        throw new Error('session wallet does not match the existing final keystore');
      }
      if (existingCredentials
        && (existingCredentials.wallet_id !== existingKeystore.wallet_id
          || existingCredentials.address?.toLowerCase()
            !== existingKeystore.address.toLowerCase())) {
        throw new Error('existing credentials do not match the final keystore wallet/address');
      }
      if (existingCredentials) {
        completedLocalWalletId = existingKeystore.wallet_id;
      }
    }
  } catch (error) {
    console.error(`  Local retry identity is contradictory: ${(error as Error).message}`);
    console.error('  No relay request was made; pending identity retained.\n');
    process.exit(1);
  }

  // A successful relay response is the only path that can have installed both
  // the final encrypted keystore and the exact four-field wallet-bound API
  // credentials. If those durable artifacts survived a crash, finish the
  // non-secret marker promotion locally and remove the still-authenticated
  // pending snapshot only after both marker fsync barriers. Do not contact the
  // relay and rotate an otherwise current credential merely because the prior
  // process died before this final promotion boundary.
  if (completedLocalWalletId !== null) {
    try {
      finalizeAgentWalletPromotion({
        walletId: completedLocalWalletId,
        registrationHandle,
        session,
      });
      console.log(
        `\n  Restored durable local markers for completed wallet ${completedLocalWalletId}; no relay request was needed.\n`,
      );
      return;
    } catch (error) {
      console.error(`  Completed wallet artifacts are durable, but safe marker recovery failed: ${(error as Error).message}`);
      console.error('  No relay request was made; pending identity retained.\n');
      process.exit(1);
    }
  }

  let result;
  try {
    result = await resumeAgentWalletRegistration(registrationHandle, { registrationChannel: 'cli' });
  } catch (error) {
    console.error(`  Wallet creation is pending and safe to retry: ${(error as Error).message}`);
    console.error(`  Encrypted pending identity retained at ${DEFAULT_PENDING_AGENT_WALLET_REGISTRATION_PATH}\n`);
    process.exit(1);
  }

  // Encrypt + persist the private key, or verify a prior post-response write.
  // The pending file remains until the keystore, API credentials, and local
  // wallet/session records are all durable.
  let written: string;
  try {
    const existingKeystore = loadKeystore(keystorePath);
    if (existingKeystore) {
      const existingKey = decryptKeystore(existingKeystore, passphrase);
      if (existingKey.privateKey !== result.privateKey
        || existingKey.address.toLowerCase() !== result.address.toLowerCase()
        || existingKey.walletId !== result.walletId) {
        throw new Error('existing keystore does not match the pending registration key');
      }
      written = keystorePath;
    } else {
      const persisted = persistAgentWalletKey({
        privateKey: result.privateKey,
        address: result.address,
        publicKey: result.publicKey,
        walletId: result.walletId,
        passphrase,
        createdAt: result.createdAt,
      });
      written = persisted.path;
    }
    persistAgentCredentialsFile({
      api_key: result.apiKey,
      api_secret: result.apiSecret,
      wallet_id: result.walletId,
      address: result.address,
    });
  } catch (error) {
    console.error(`  Wallet committed, but durable local finalization failed: ${(error as Error).message}`);
    console.error('  The encrypted pending identity was retained. Re-run the same command to recover safely.\n');
    process.exit(1);
  }

  // Record both non-secret markers durably, then and only then delete the exact
  // pending registration. Every file and parent rename crosses an fsync
  // barrier, so any restart either retains pending recovery or sees the final
  // wallet/session identity.
  try {
    finalizeAgentWalletPromotion({
      walletId: result.walletId,
      registrationHandle,
      session,
    });
  } catch (error) {
    console.error(`  Wallet/key/credentials are durable, but final promotion failed: ${(error as Error).message}`);
    console.error('  Pending identity retained; re-run to finish safely.\n');
    process.exit(1);
  }

  // / L381: the birth escrow runs inside the create; if it did not land, retry it now that the
  // credential is durable (a failure never costs the credential), and say plainly if it still failed.
  let recoveryLine: string | null = null;
  if (result.recoveryAnchorPubkey) {
    let escrowed = result.recoveryEscrowed === true;
    if (!escrowed) {
      try {
        await sealAndEscrow({
          relayUrl, walletId: result.walletId, apiKey: result.apiKey, apiSecret: result.apiSecret,
          privateKey: result.privateKey, anchorPubkeyB64u: result.recoveryAnchorPubkey,
        });
        escrowed = true;
      } catch (error) {
        recoveryLine = `  Recovery escrow did NOT land (${(error as Error).message}). Re-run this command to retry; your wallet and credentials are saved, and your earnings do not wait on it.`;
      }
    }
    if (escrowed) recoveryLine = '  Recovery:  escrowed to your human\'s phone (ciphertext only), so they can restore this key if it is lost. It never holds earnings.';
  }

  // Optional one-step off-device backup. Done before the summary so the
  // backup result is reported alongside the loss warning.
  let backupPath: string | null = null;
  let backupError: string | null = null;
  if (args.backup) {
    try {
      backupPath = exportKeystore(args.backup);
    } catch (error) {
      backupError = (error as Error).message;
    }
  }

  console.log('  ┌─────────────────────────────────────┐');
  console.log('  │  Agent wallet created               │');
  console.log('  └─────────────────────────────────────┘\n');
  console.log(`  Wallet:    ${result.walletId}`);
  console.log(`  Address:   ${result.address}`);
  console.log(`  Keystore:  ${written} (AES-256-GCM, 0600)`);
  console.log(`  API creds: ${AGENT_CREDS_PATH} (0600)`);
  if (recoveryLine) console.log(recoveryLine);
  console.log('  API key/secret are shown once below. Store them now:\n');
  console.log(`    PROVIAN_API_KEY=${result.apiKey}`);
  console.log(`    PROVIAN_API_SECRET=${result.apiSecret}\n`);

  // Explicit, unmissable loss warning. The key is single-copy on this machine.
  console.log('  ' + '!'.repeat(60));
  console.log('  WARNING: BACK UP YOUR KEYSTORE NOW.');
  console.log('  This key exists ONLY on this machine. There is no cloud backup');
  console.log('  and no reset. If this machine is lost, wiped, or fails before');
  console.log('  you back the keystore up off-device, the wallet and ANY FUNDS');
  console.log('  in it are PERMANENTLY UNRECOVERABLE.');
  console.log('  ' + '!'.repeat(60) + '\n');

  if (backupPath) {
    console.log(`  Off-device backup written: ${backupPath}`);
    console.log('  Keep it (and your passphrase, stored separately) somewhere safe.\n');
  } else {
    if (backupError) {
      console.log(`  Requested --backup FAILED: ${backupError}`);
    }
    console.log('  You have NOT backed up yet. Export an encrypted backup now:');
    console.log('    npx @provian/agent-sdk export-agent-keystore ./agent-keystore.backup.json\n');
  }
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
