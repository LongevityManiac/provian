/**
 * human-recovery-anchor — the PUBLIC half of a human's agent-recovery key, published
 * once from their phone, so agents that never pass through the phone can still escrow
 * a key only that phone can open (item 11, ):
 *
 * "The fleet code carries the public half of the human's recovery key; the agent
 * seals its escrow to it at install; the relay stores only the public half."
 * Invariants: no per-agent tap in the app (one publish from the phone, once);
 * only the human's phone can unseal; the issuing agent never holds another agent's key.
 *
 * The phone derives the anchor from its wallet seed (so every phone holding that seed
 * derives the same one, and a restored wallet re-derives it) and publishes the x25519
 * public key with an EIP-191 signature by the human's wallet key. The relay stores the
 * public key and nothing else: no secret, no decrypt path (see agent-recovery-escrow.ts —
 * the same no-custody rule). The signature is what stops a stolen device auth token
 * from pointing the human's future agent escrows at an attacker's key.
 *
 * Consumers: a fleet code minted by any of the human's linked agents carries it (fleet-code.ts),
 * so `/create` hands it to the new agent exactly like a phone-minted invite anchor; and
 * an already-installed agent with no escrow reads it (`escrow-target`) and escrows.
 */

import { ethers } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { isValidAnchorPubkeyB64u } from './agent-recovery-escrow';

export const HUMAN_RECOVERY_ANCHOR_COLLECTION = 'human_recovery_anchors';

/** The exact text the human's wallet signs (EIP-191). Names Provian, so WalletConnect refuses to sign it for a dApp. */
export function humanRecoveryAnchorMessage(pubkeyB64u: string): string {
  return `Provian human recovery anchor v1\n${pubkeyB64u}`;
}

export interface HumanRecoveryAnchorRecord {
  user_id: string;
  recovery_anchor_pubkey: string;
  /** The human wallet address the signature recovered to (lowercase). */
  signer_address: string;
  signature: string;
  created_at: number;
  updated_at: number;
}

export async function readHumanRecoveryAnchor(db: Firestore, userId: string): Promise<string | null> {
  const snap = await db.collection(HUMAN_RECOVERY_ANCHOR_COLLECTION).doc(userId).get();
  if (!snap.exists) return null;
  const pub = (snap.data() as Partial<HumanRecoveryAnchorRecord>).recovery_anchor_pubkey;
  return isValidAnchorPubkeyB64u(pub) ? pub : null;
}

export type PublishAnchorResult =
  | { ok: true; changed: boolean }
  | { ok: false; status: number; error: string };

/**
 * Verify and store. `walletAddress` is the caller's first-party human wallet address
 * (resolved by the route from wallet auth); the signature must recover to it.
 */
export async function publishHumanRecoveryAnchor(
  db: Firestore,
  input: { userId: string; walletAddress: string; pubkey: unknown; signature: unknown; now: number },
): Promise<PublishAnchorResult> {
  if (!isValidAnchorPubkeyB64u(input.pubkey)) {
    return { ok: false, status: 400, error: 'recovery_anchor_pubkey must be a base64url 32-byte x25519 public key' };
  }
  if (typeof input.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(input.signature)) {
    return { ok: false, status: 400, error: 'signature must be a 65-byte EIP-191 signature (0x hex)' };
  }
  let recovered: string;
  try {
    recovered = ethers.verifyMessage(humanRecoveryAnchorMessage(input.pubkey), input.signature).toLowerCase();
  } catch {
    return { ok: false, status: 400, error: 'signature_invalid' };
  }
  if (recovered !== input.walletAddress.toLowerCase()) {
    return { ok: false, status: 403, error: 'signature_not_from_your_wallet' };
  }
  const ref = db.collection(HUMAN_RECOVERY_ANCHOR_COLLECTION).doc(input.userId);
  const existing = await ref.get();
  const prev = existing.exists ? existing.data() as HumanRecoveryAnchorRecord : null;
  if (prev && prev.recovery_anchor_pubkey === input.pubkey && prev.signer_address === recovered) {
    return { ok: true, changed: false };
  }
  const record: HumanRecoveryAnchorRecord = {
    user_id: input.userId,
    recovery_anchor_pubkey: input.pubkey,
    signer_address: recovered,
    signature: input.signature,
    created_at: prev?.created_at ?? input.now,
    updated_at: input.now,
  };
  await ref.set(record);
  return { ok: true, changed: true };
}
