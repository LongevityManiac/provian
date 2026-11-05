/**
 * installed-agent — the identity a hosted install leaves on its machine, loaded for the act verbs
 * ("each signed with its own key on its VM").
 *
 * The hosted `curl … | sh` install writes, under ~/.provian:
 * - agent-credentials.json — the agent API key + secret, bound to wallet_id + address (0600);
 * - agent-keystore.json — the wallet key, AES-256-GCM encrypted at rest;
 * - agent-keystore.secret — the machine's at-rest secret that decrypts it (0600).
 *
 * The same three files `rotate-key` and `register-git-identity` read. The key is released only
 * through `withKey`, which decrypts it for ONE callback (`keystore.ts::withDecryptedKey`) and drops
 * the reference afterwards; it is never returned, logged or printed. Nothing here creates a secret:
 * a machine with no at-rest secret (or an operator-passphrase keystore) supplies
 * PROVIAN_KEYSTORE_PASSPHRASE, exactly as `register-git-identity` does.
 */
import * as path from 'path';
import { homedir } from 'os';
import { loadKeystore, withDecryptedKey, type AgentKeystore } from './keystore';
import { loadBoundAgentCredentialsFile } from './scripts/agent-credentials-file';
import { readLocalKeystoreSecret } from './local-keystore-secret';
import type { CommonsInstitutionsConfig } from './commons-institutions';

export const DEFAULT_RELAY_URL = 'https://api.provian.ai';

export interface InstalledAgent {
  walletId: string;
  /** The wallet's EVM address (checked against both the credentials and the keystore). */
  address: string;
  /** Agent API config for `CommonsInstitutions` (relay from PROVIAN_RELAY_URL, else api.provian.ai). */
  config: CommonsInstitutionsConfig;
  /** The API secret, so output can be scrubbed of it. Never printed. */
  apiSecret: string;
  /** Decrypt the wallet key for exactly one callback (key-per-call). */
  withKey<T>(fn: (privateKeyHex: string) => Promise<T>): Promise<T>;
}

export class InstalledAgentError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'InstalledAgentError';
  }
}

export interface LoadInstalledAgentOptions {
  /** Home directory holding `.provian` (tests point this at a fixture). */
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/** Load and cross-check the install's identity. Throws a plain-sentence InstalledAgentError. */
export function loadInstalledAgent(opts: LoadInstalledAgentOptions = {}): InstalledAgent {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const dir = path.join(home, '.provian');

  const creds = loadBoundAgentCredentialsFile(path.join(dir, 'agent-credentials.json'));
  if (!creds) {
    throw new InstalledAgentError(
      'No agent credentials were found in ~/.provian/agent-credentials.json (it must be a private 0600 file with api_key, api_secret, wallet_id and address). Run the Provian install line on this machine first.',
      'NO_CREDENTIALS',
    );
  }
  let keystore: AgentKeystore | null;
  try {
    keystore = loadKeystore(path.join(dir, 'agent-keystore.json'));
  } catch {
    throw new InstalledAgentError('The agent keystore (~/.provian/agent-keystore.json) is not readable.', 'BAD_KEYSTORE');
  }
  if (!keystore) {
    throw new InstalledAgentError('No agent keystore was found at ~/.provian/agent-keystore.json.', 'NO_KEYSTORE');
  }
  if (keystore.wallet_id !== creds.wallet_id) {
    throw new InstalledAgentError(
      `The keystore belongs to ${keystore.wallet_id} but the credentials to ${creds.wallet_id}; refusing to sign for either.`,
      'IDENTITY_MISMATCH',
    );
  }
  if (keystore.address.toLowerCase() !== creds.address.toLowerCase()) {
    throw new InstalledAgentError(
      'The keystore address does not match the credentials address; refusing to sign.',
      'IDENTITY_MISMATCH',
    );
  }
  const passphrase = (env.PROVIAN_KEYSTORE_PASSPHRASE && env.PROVIAN_KEYSTORE_PASSPHRASE.length > 0)
    ? env.PROVIAN_KEYSTORE_PASSPHRASE
    : readLocalKeystoreSecret(path.join(dir, 'agent-keystore.secret'));
  const relayUrl = (env.PROVIAN_RELAY_URL ?? '').trim() || DEFAULT_RELAY_URL;
  const ks = keystore;
  return {
    walletId: creds.wallet_id,
    address: creds.address,
    apiSecret: creds.api_secret,
    config: { relayUrl, walletId: creds.wallet_id, apiKey: creds.api_key, apiSecret: creds.api_secret },
    async withKey<T>(fn: (privateKeyHex: string) => Promise<T>): Promise<T> {
      if (!passphrase) {
        throw new InstalledAgentError(
          'The keystore secret (~/.provian/agent-keystore.secret) is missing; set PROVIAN_KEYSTORE_PASSPHRASE to sign.',
          'NO_KEYSTORE_SECRET',
        );
      }
      let decrypted = false;
      try {
        return await withDecryptedKey(ks, passphrase, (dk) => {
          decrypted = true;
          return fn(dk.privateKey);
        });
      } catch (err) {
        if (!decrypted) {
          throw new InstalledAgentError('The keystore could not be decrypted with this machine\'s secret.', 'KEYSTORE_DECRYPT_FAILED');
        }
        throw err;
      }
    },
  };
}
