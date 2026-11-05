import { type BiometricAction } from '../security/biometricAction';
/**
 * agentRekey — the phone side of the RECOVERY RE-KEY.
 *
 * When a linked agent's signing key is LOST (its machine's at-rest secret is gone
 * and no escrow was ever stored — the Atlas failure), it cannot be unsealed/
 * restored, only RE-KEYED. The linked human's phone is the recovery authority, so
 * it drives the whole re-key non-custodially:
 * 1. mint a fresh recovery anchor (secret half stays in this phone's cloud-backed
 * keychain — `mintAndPersistRecoveryAnchor`)
 * 2. generate a fresh secp256k1 agent keypair on the phone
 * 3. seal the new key to the anchor (`sealToAnchor`) → the escrow ciphertext
 * 4. prove possession of the new key (ECDSA-SHA256 over the recovery message)
 * 5. authorize the identity swap with the human's wallet auth
 * (`RelayAPIService.recoveryRekey`) — the relay cuts the identity to the new
 * address (PE chain + wallet_aw id preserved), stores the escrow, and returns
 * the rotated API credentials
 * 6. emit ONE restore command carrying the new key + rotated creds for the agent
 * machine (fed on stdin, never argv/env)
 *
 * The wallet key never touches Provian's servers except as the anchor-sealed escrow
 * blob, exactly as in the same-key recovery path (agentRecovery.ts).
 */

import { hexToBytes } from '@noble/hashes/utils';
import { sealToAnchor, fromB64u, toB64u } from '../security/agentKeyRecovery';
import { mintAndPersistRecoveryAnchor, recoverAgentKeyHex } from './agentRecovery';
import {
  generateAgentKeyPair,
  signRecoveryRekeyPoP,
  recoveryRekeyMessage,
  buildAgentRekeyCommand,
} from './agentRekeyCrypto';
import { sweepAgentPvt, type AgentSweepResult, type GasPrefundConfirm } from './agentBalanceSweep';
import RelayAPIService from '../../services/RelayAPIService';

export type {
  AgentKeyPair,
} from './agentRekeyCrypto';
export {
  generateAgentKeyPair,
  signRecoveryRekeyPoP,
  recoveryRekeyMessage,
  buildAgentRekeyCommand,
} from './agentRekeyCrypto';

export type RekeyResult =
  | { ok: true; newAddress: string; command: string; payload: string; sweep: AgentSweepResult }
  | { ok: false; code: string };

/**
 * Drive the whole non-custodial re-key. The caller (screen) has ALREADY passed a
 * biometric gate before invoking this — it mints anchor + key material and hands
 * the agent's fund-bearing new key to a restore command.
 *
 * BALANCE RECOVERY. Before minting the new key, this reads the agent's
 * recovery escrow: when the OLD key was escrowed to THIS phone, it is recovered
 * here and, after the identity swap, used to SWEEP the retired address's earned
 * PVT into the new one — otherwise a re-key strands that balance.
 * When there is no escrow (the true lost-key case this screen exists for), the
 * sweep is cleanly skipped (`no_old_key`). The recovered old key lives only inside
 * this function and `sweepAgentPvt`; it is NEVER returned to the caller.
 */
export async function rekeyAgent(params: {
  walletId: string;
  relayUrl: string;
  /** Human gate for pre-funding sweep gas from their own wallet; omit ⇒ report-only. */
  confirmGasPrefund?: GasPrefundConfirm;
}, biometricAction?: BiometricAction): Promise<RekeyResult> {
  // Recover the OLD key from escrow BEFORE minting the new one, so it can sweep the
  // retired address after the swap. Any failure (no escrow, anchor secret not on
  // this phone, tampered blob) → no old key, so the sweep is skipped, not fatal.
  let oldKeyHex: string | null = null;
  const escrow = await RelayAPIService.getRecoveryEscrow(params.walletId, biometricAction);
  if (escrow.ok) {
    try {
      oldKeyHex = await recoverAgentKeyHex({
        sealedKeyBlobB64u: escrow.escrow.sealed_key_blob,
        recoveryAnchorPubkeyB64u: escrow.escrow.recovery_anchor_pubkey,
        walletId: params.walletId,
      }, biometricAction);
    } catch {
      oldKeyHex = null;
    }
  }

  const anchor = await mintAndPersistRecoveryAnchor(undefined, biometricAction);
  if (!anchor.recoveryEnabled) {
    return { ok: false, code: anchor.reason };
  }
  const kp = await generateAgentKeyPair();
  const anchorPub = fromB64u(anchor.recoveryAnchorPubkeyB64u);
  const sealed = sealToAnchor(anchorPub, hexToBytes(kp.privateKeyHex));
  const timestamp = Date.now();
  const proof = await signRecoveryRekeyPoP(kp.privateKeyHex, recoveryRekeyMessage(params.walletId, kp.address, timestamp));

  const res = await RelayAPIService.recoveryRekey(params.walletId, {
    new_address: kp.address,
    new_public_key: kp.publicKeyHex,
    proof_of_new_key: proof,
    timestamp,
    sealed_key_blob: toB64u(sealed),
    recovery_anchor_pubkey: anchor.recoveryAnchorPubkeyB64u,
  }, biometricAction);
  if (!res.ok) {
    return { ok: false, code: res.code };
  }
  const instructions = buildAgentRekeyCommand({
    walletId: params.walletId,
    privateKeyHex: kp.privateKeyHex,
    apiKey: res.api_key,
    apiSecret: res.api_secret,
    relayUrl: params.relayUrl,
  });

  // The identity swap succeeded. If the old key was recovered, sweep the retired
  // address's PVT into the new one — the sweep is fail-closed, so it can never
  // undo the (now-committed) re-key. The old key never leaves this scope.
  const sweep: AgentSweepResult = oldKeyHex
    ? await sweepAgentPvt({ oldKeyHex, newAddress: res.new_address, confirmGasPrefund: params.confirmGasPrefund }, biometricAction)
    : { status: 'no_old_key' };

  return {
    ok: true,
    newAddress: res.new_address,
    command: instructions.command,
    payload: instructions.payload,
    sweep,
  };
}
