/**
 * PE METER — the agent's mailbox key, when this machine can reach it.
 *
 * PEs sealed to an agent (from its other devices, or authored by the relay) are boxed to the
 * agent's x25519 MESSAGE key, which is derived deterministically from its wallet key
 * (`deriveMessageKeyPair`, thread-crypto.ts). The daemon can open them only where the agent's
 * encrypted keystore and its passphrase (PROVIAN_KEYSTORE_PASSPHRASE, or the machine-local
 * keystore secret) are both present. The wallet key is decrypted for the derivation only
 * (`withDecryptedKey`) and never retained; the caller zeroes the derived secret after use.
 * Anything missing → null, and the mailbox stays on the relay.
 */

import { loadKeystore, withDecryptedKey, type AgentKeystore } from '../keystore';
import { readLocalKeystoreSecret } from '../local-keystore-secret';
import { deriveMessageKeyPair, messagePublicKeyOf } from '../thread-crypto';

export interface AgentMessageKeyDeps {
  readonly loadKeystore?: () => AgentKeystore | null;
  readonly passphrase?: () => string | null;
}

export function agentMessageSecretProvider(
  agentWalletId: string | undefined,
  deps: AgentMessageKeyDeps = {},
): () => Promise<Uint8Array | null> {
  return async () => {
    try {
      const keystore = (deps.loadKeystore ?? (() => loadKeystore()))();
      if (!keystore || (agentWalletId !== undefined && keystore.wallet_id !== agentWalletId)) return null;
      const passphrase = (deps.passphrase ?? (() => {
        const fromEnv = process.env.PROVIAN_KEYSTORE_PASSPHRASE;
        return fromEnv && fromEnv.length > 0 ? fromEnv : readLocalKeystoreSecret();
      }))();
      if (!passphrase) return null;
      return await withDecryptedKey(keystore, passphrase, (key) => deriveMessageKeyPair(key.privateKey).secretKey);
    } catch {
      return null;
    }
  };
}

/**
 * The agent's message PUBLIC key (base64url, 43 chars) — what the relay holds at
 * `PUT /v1/threads/keys` — derived the same way, where this machine can reach the keystore; else
 * null. The derived secret is zeroed before returning.
 */
export async function agentMessagePublicKey(
  agentWalletId: string | undefined,
  deps: AgentMessageKeyDeps = {},
): Promise<string | null> {
  try {
    const keystore = (deps.loadKeystore ?? (() => loadKeystore()))();
    if (!keystore || (agentWalletId !== undefined && keystore.wallet_id !== agentWalletId)) return null;
    const passphrase = (deps.passphrase ?? (() => {
      const fromEnv = process.env.PROVIAN_KEYSTORE_PASSPHRASE;
      return fromEnv && fromEnv.length > 0 ? fromEnv : readLocalKeystoreSecret();
    }))();
    if (!passphrase) return null;
    return await withDecryptedKey(keystore, passphrase, (key) => messagePublicKeyOf(key.privateKey));
  } catch {
    return null;
  }
}
