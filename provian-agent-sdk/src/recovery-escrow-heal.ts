import { guardedFetcher } from './guarded-fetch';
/**
 * recovery-escrow-heal — an agent with no recovery escrow escrows itself once its human's
 * phone has published a recovery anchor (item 11,).
 *
 * A fleet-onboarded agent (one of its human's linked agents issued the code) never passed through the
 * phone, so its code carried no anchor and it installed with no escrow — so its linked human
 * could not restore its key if it were lost. (Escrow never holds earnings: the agent mints and
 * can be paid out whether or not it is escrowed.) The fix: the phone publishes the PUBLIC
 * half of the human's recovery key once; a new fleet code carries it; and an agent already
 * installed reads it here, seals a copy of its own key to it ON THIS MACHINE, and escrows the
 * ciphertext. Only the phone holds the secret half, so only the phone can open it; the relay
 * stores ciphertext and a public key; no other agent ever sees this key.
 *
 * Runs in the daemon at start and on a slow cadence until escrowed. Never throws; an
 * unreachable relay, an unpublished anchor or a missing keystore is a retry later.
 */

import { sealAndEscrow } from './recovery-escrow-seal';
import { loadKeystore, getDefaultKeystorePath, withDecryptedKey, type AgentKeystore } from './keystore';
import { readLocalKeystoreSecret, LOCAL_KEYSTORE_SECRET_PATH } from './local-keystore-secret';

export type EscrowHealOutcome =
  | 'escrowed_now'
  | 'already_escrowed'
  | 'human_anchor_not_published'
  | 'not_linked'
  | 'no_keystore'
  | 'failed';

export interface EscrowHealInput {
  relayUrl: string;
  walletId: string;
  apiKey: string;
  apiSecret: string;
}

export interface EscrowHealDeps {
  fetchImpl?: typeof fetch;
  loadKeystore?: () => AgentKeystore | null;
  readSecret?: () => string | null;
  escrow?: typeof sealAndEscrow;
}

const B64U_32 = /^[A-Za-z0-9_-]{43}$/;

export async function ensureRecoveryEscrow(input: EscrowHealInput, deps: EscrowHealDeps = {}): Promise<EscrowHealOutcome> {
  const fetchImpl = guardedFetcher(deps.fetchImpl);
  const base = input.relayUrl.replace(/\/+$/, '');
  let target: { escrowed?: unknown; recovery_anchor_pubkey?: unknown; reason?: unknown };
  try {
    const res = await fetchImpl(`${base}/v1/agent/wallet/${input.walletId}/escrow-target`, {
      headers: { Authorization: `Bearer ${input.apiKey}:${input.apiSecret}` },
    });
    if (!res.ok) return 'failed';
    target = await res.json() as typeof target;
  } catch {
    return 'failed';
  }
  if (target.escrowed === true) return 'already_escrowed';
  const anchor = target.recovery_anchor_pubkey;
  if (typeof anchor !== 'string' || !B64U_32.test(anchor)) {
    return target.reason === 'not_linked' ? 'not_linked' : 'human_anchor_not_published';
  }
  const keystore = (deps.loadKeystore ?? (() => loadKeystore(getDefaultKeystorePath())))();
  const secret = (deps.readSecret ?? (() => readLocalKeystoreSecret(LOCAL_KEYSTORE_SECRET_PATH)))();
  if (!keystore || !secret) return 'no_keystore';
  // The key is decrypted only for the seal, and only this machine ever sees it.
  if (keystore.wallet_id && keystore.wallet_id !== input.walletId) return 'no_keystore';
  try {
    await withDecryptedKey(keystore, secret, (key) => (deps.escrow ?? sealAndEscrow)({
      relayUrl: input.relayUrl,
      walletId: input.walletId,
      apiKey: input.apiKey,
      apiSecret: input.apiSecret,
      privateKey: key.privateKey,
      anchorPubkeyB64u: anchor,
    }, fetchImpl));
    return 'escrowed_now';
  } catch {
    return 'failed';
  }
}
