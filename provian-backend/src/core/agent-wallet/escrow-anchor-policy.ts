/**
 * escrow-anchor-policy — WHICH anchor an agent may escrow its key to (hardening).
 *
 * A recovery escrow is how the linked human can restore an agent's key (it never holds earnings,
 *). The escrow is agent-authored ciphertext (`POST /:wallet_id/recovery-escrow`,
 * agent API auth), and the relay can never open it — so without this policy an agent could seal its
 * key to a key IT holds and be reported recoverable while no human could ever recover it. The relay cannot check the ciphertext, but it CAN check
 * the public key it was sealed to: an escrow is accepted only when its anchor is one the relay itself
 * names for that agent, i.e. a key only the recovering human's phone can open:
 *
 * 1. `birth` the anchor the relay named on this wallet's create response
 * (birth-recovery-anchor.ts), recorded at creation in
 * `agent_birth_recovery_anchors/{wallet_id}` the inviting code's phone anchor, its
 * issuer's published anchor, or a child's inherited human's published anchor;
 * 2. `linked_human_published` the PUBLISHED, wallet-signed anchor of the agent's CURRENT linked
 * human (human-recovery-anchor.ts; exactly what `escrow-target` hands the daemon);
 * 3. `existing_escrow` the anchor of the escrow the agent already holds (a re-seal to the same
 * anchor, e.g. a rotation re-escrowing its new key, changes no custodian).
 *
 * Anything else is refused (403 `recovery_anchor_not_recognized`). A read failure refuses too (503):
 * Unknown = Block. The recovery re-key route is NOT governed here — there the linked human's own
 * wallet auth authorizes the fresh anchor its phone minted. Like agent-recovery-escrow.ts this module
 * imports no crypto and holds no key; it compares public keys only.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { readRecoveryEscrow, isValidAnchorPubkeyB64u } from '../agent-recovery-escrow';
import { readHumanRecoveryAnchor } from '../human-recovery-anchor';
import type { BirthRecoveryAnchorSource } from './birth-recovery-anchor';

export const AGENT_BIRTH_RECOVERY_ANCHOR_COLLECTION = 'agent_birth_recovery_anchors';

export interface AgentBirthRecoveryAnchorRecord {
  wallet_id: string;
  recovery_anchor_pubkey: string;
  source: Exclude<BirthRecoveryAnchorSource, 'none'>;
  created_at: number;
}

export function birthRecoveryAnchorRecord(input: {
  walletId: string; pubkey: string; source: Exclude<BirthRecoveryAnchorSource, 'none'>; now: number;
}): AgentBirthRecoveryAnchorRecord {
  return {
    wallet_id: input.walletId,
    recovery_anchor_pubkey: input.pubkey,
    source: input.source,
    created_at: input.now,
  };
}

/**
 * Record the birth anchor when none is recorded yet (the lost-response replay path, and any wallet
 * created before the record existed). First write wins: a later replay never moves the custodian
 * named at birth — a later custodian is covered by `linked_human_published`.
 */
export async function recordBirthRecoveryAnchorIfAbsent(
  db: Firestore,
  input: { walletId: string; pubkey: string; source: Exclude<BirthRecoveryAnchorSource, 'none'>; now: number },
): Promise<void> {
  const ref = db.collection(AGENT_BIRTH_RECOVERY_ANCHOR_COLLECTION).doc(input.walletId);
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (snap.exists) return;
    txn.create(ref, birthRecoveryAnchorRecord(input) as unknown as Record<string, unknown>);
  });
}

export async function readBirthRecoveryAnchor(db: Firestore, walletId: string): Promise<string | null> {
  const snap = await db.collection(AGENT_BIRTH_RECOVERY_ANCHOR_COLLECTION).doc(walletId).get();
  if (!snap.exists) return null;
  const pub = (snap.data() as Partial<AgentBirthRecoveryAnchorRecord>).recovery_anchor_pubkey;
  return isValidAnchorPubkeyB64u(pub) ? pub : null;
}

export type EscrowAnchorBasis = 'birth' | 'linked_human_published' | 'existing_escrow';

export type EscrowAnchorVerdict =
  | { ok: true; basis: EscrowAnchorBasis }
  | { ok: false; status: 403 | 503; error: 'recovery_anchor_not_recognized' | 'recovery_anchor_check_unavailable'; detail: string };

export const RECOVERY_ANCHOR_NOT_RECOGNIZED_DETAIL =
  'A recovery escrow must be sealed to an anchor the relay names for this agent: the anchor on its '
  + 'create response, or its linked human\'s published recovery anchor (GET /v1/agent/wallet/:wallet_id/escrow-target). '
  + 'An escrow sealed to any other key would pass the recovery gate with no human able to recover it.';

/** Decide whether `anchor` is one the relay names for `walletId`. Never throws. */
export async function checkEscrowAnchor(
  db: Firestore,
  walletId: string,
  anchor: string,
): Promise<EscrowAnchorVerdict> {
  try {
    const existing = await readRecoveryEscrow(db, walletId);
    if (existing && existing.recovery_anchor_pubkey === anchor) return { ok: true, basis: 'existing_escrow' };
    const birth = await readBirthRecoveryAnchor(db, walletId);
    if (birth !== null && birth === anchor) return { ok: true, basis: 'birth' };
    // Authoritative read: the link is the human's, and it may have changed since auth cached it.
    const walletSnap = await db.collection('agent_wallets').doc(walletId).get();
    const wallet = walletSnap.exists ? walletSnap.data() ?? {} : {};
    const humanUserId = wallet.status === 'active' && typeof wallet.linked_human_user_id === 'string'
      && wallet.linked_human_user_id.length > 0
      ? wallet.linked_human_user_id
      : null;
    if (humanUserId !== null) {
      const published = await readHumanRecoveryAnchor(db, humanUserId);
      if (published !== null && published === anchor) return { ok: true, basis: 'linked_human_published' };
    }
    return { ok: false, status: 403, error: 'recovery_anchor_not_recognized', detail: RECOVERY_ANCHOR_NOT_RECOGNIZED_DETAIL };
  } catch {
    return {
      ok: false,
      status: 503,
      error: 'recovery_anchor_check_unavailable',
      detail: 'The relay could not verify the recovery anchor; nothing was stored. Retry shortly.',
    };
  }
}
