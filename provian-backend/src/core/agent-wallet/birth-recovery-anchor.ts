/**
 * birth-recovery-anchor — the recovery anchor a NEW agent wallet seals its key to at birth
 * (invariant: every agent's wallet key is escrowed for recovery at birth; OPEN_ITEMS L381).
 *
 * The escrow itself stays client-side and non-custodial: the agent seals its own key on its own
 * machine and POSTs only ciphertext (`/recovery-escrow`, agent-recovery-escrow.ts). What the relay
 * contributes at `POST /v1/agent/wallet/create` is the PUBLIC key to seal to, on the create
 * response (`recovery_anchor_pubkey`), so every creation route that knows its human at birth can
 * escrow before it does anything else. The anchor is always a key only the recovering human's
 * phone can open:
 *
 * 1. A parent-spawned child (`parent_wallet_id`) inherits its parent's linked human at birth, so
 * its recovery custodian is that human: the anchor is the PUBLIC half that human's phone
 * published under its own wallet signature (human-recovery-anchor.ts). Never the parent's own
 * escrow anchor and never anything the parent agent sent — an agent can POST its escrow to any
 * anchor it likes, so a parent-supplied key could be one the parent holds (item 11's invariant:
 * "the issuing agent never holds another agent's key").
 * 2. Otherwise a connection code (human or fleet): the anchor the code itself carries (the phone's
 * per-invite anchor, or the human anchor a fleet code copied at mint) — exactly the pre-existing
 * behaviour. When the code carries none (a fleet code minted before its human published), the
 * code's ISSUER human's published anchor, read now.
 * 3. No human at birth (no code, or an unknown code, and no linked parent) → null. Such an agent
 * cannot be escrowed at birth because no recovery custodian exists yet; it escrows when it links
 * (its daemon reads `escrow-target`). Escrow never holds earnings : such an
 * agent is paid like any other meanwhile. Never a fabricated or relay-held anchor.
 *
 * Read-only and fail-soft: any read error resolves to null (no anchor), which can only defer the
 * escrow to the daemon's heal — never seal to an anchor the relay did not name. It never consumes a code and never refuses a
 * creation (wallet creation has no containment, ).
 */

import type { Firestore } from 'firebase-admin/firestore';
import { readHumanRecoveryAnchor } from '../human-recovery-anchor';
import { isValidAnchorPubkeyB64u } from '../agent-recovery-escrow';
import { isValidConnectionTokenFormat } from '../connection-token-format';

export interface BirthRecoveryAnchorDeps {
  db: Firestore;
}

export interface BirthRecoveryAnchorInput {
  /** The trimmed `connection_token` the create carried, or null. */
  connectionToken: string | null;
  /** True when the create carried a validated `parent_wallet_id`. */
  isChild: boolean;
  /** The human user id a child inherits from its parent (null when the parent is unlinked). */
  inheritedHumanUserId: string | null;
}

export type BirthRecoveryAnchorSource =
  | 'inherited_human_published'
  | 'connection_code'
  | 'code_issuer_published'
  | 'none';

export interface BirthRecoveryAnchor {
  pubkey: string | null;
  source: BirthRecoveryAnchorSource;
}

const NONE: BirthRecoveryAnchor = { pubkey: null, source: 'none' };

async function readCodeDoc(db: Firestore, code: string): Promise<Record<string, unknown> | null> {
  const snap = await db.collection('connection_tokens').doc(code).get();
  return snap.exists ? (snap.data() ?? {}) as Record<string, unknown> : null;
}

export async function resolveBirthRecoveryAnchor(
  deps: BirthRecoveryAnchorDeps,
  input: BirthRecoveryAnchorInput,
): Promise<BirthRecoveryAnchor> {
  try {
    if (input.isChild && input.inheritedHumanUserId) {
      // The child's custodian is the human it is linked to from birth; a connection code it also
      // carried names nobody who can recover it (the child is already linked elsewhere).
      const pub = await readHumanRecoveryAnchor(deps.db, input.inheritedHumanUserId);
      return pub !== null ? { pubkey: pub, source: 'inherited_human_published' } : NONE;
    }
    const code = input.connectionToken;
    if (code === null || !isValidConnectionTokenFormat(code)) return NONE;
    const doc = await readCodeDoc(deps.db, code);
    if (doc === null) return NONE;
    if (isValidAnchorPubkeyB64u(doc.recovery_anchor_pubkey)) {
      return { pubkey: doc.recovery_anchor_pubkey, source: 'connection_code' };
    }
    const issuer = typeof doc.user_id === 'string' && doc.user_id.length > 0 ? doc.user_id : null;
    if (issuer === null) return NONE;
    const pub = await readHumanRecoveryAnchor(deps.db, issuer);
    return pub !== null ? { pubkey: pub, source: 'code_issuer_published' } : NONE;
  } catch {
    return NONE;
  }
}
