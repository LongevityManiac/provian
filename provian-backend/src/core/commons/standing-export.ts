/**
 * work package O9 — standing export, REMEDIATED to the burn-to-present primitive.
 *
 * A standing export was a Provian-attested snapshot of an agent's reputation
 * (governance score, PE count, streak) that anyone could resolve by `export_id`
 * via the public resolver. That snapshot was UNSIGNED, REQUESTER-UNBOUND, and
 * INFINITELY REPLAYABLE by any holder of the id — a bearer credential, which is
 * exactly what a presentation must never be.
 *
 * The standing export is now brought under the presentation primitive: producing
 * one is producing a REPUTATION-tier presentation (signed, requester-bound, fresh,
 * single-use — see `core/presentation/service.ts`), and the standing-export mint
 * route delegates to it. This module keeps only the NON-presentation surfaces:
 *
 * - `getStandingPresentationMeta` a raw id lookup that returns ONLY
 * non-sensitive existence metadata (NO scores). It is NOT a presentation: a
 * counterparty must be handed, and must verify, a requester-bound presentation
 * at POST /v1/present/verify. This is the fix for the bearer-snapshot defect.
 * - `standingPresentationsByWallet` the owner's own history of the reputation
 * presentations they have produced (metadata only), an owner-guarded read.
 *
 * The legacy `commons_standing_exports` bearer docs (if any exist) are no longer
 * resolvable to their scores by any path.
 */

import type { AgentBankDeps } from '../agent-bank/types';
import { COMMONS_PRESENTATIONS_COLLECTION } from '../presentation/service';

/** Legacy collection of pre-remediation bearer snapshots. Retained as a constant
 *  for awareness; nothing resolves its scores any more. */
export const COMMONS_STANDING_EXPORTS_COLLECTION = 'commons_standing_exports';

/** Non-sensitive metadata about a produced reputation presentation. NO scores. */
export interface StandingPresentationMeta {
  readonly presentation_id: string;
  readonly tier: string;
  readonly wallet_id: string;
  readonly presenter_address: string;
  readonly audience: string;
  readonly issued_at: number;
  readonly expires_at: number;
}

/**
 * Raw id lookup — returns ONLY non-sensitive metadata (never scores). A standing
 * export is no longer a bearer snapshot; a verifiable standing is a requester-bound
 * presentation verified at POST /v1/present/verify. Looks up by burn_id (the
 * presentation record key) or by presentation_id. Null if not found.
 */
export async function getStandingPresentationMeta(
  deps: AgentBankDeps,
  id: string,
): Promise<StandingPresentationMeta | null> {
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null;
  // The presentation record is keyed by burn_id.
  let snap = await deps.db.collection(COMMONS_PRESENTATIONS_COLLECTION).doc(id).get();
  if (!snap.exists) {
    const byPid = await deps.db
      .collection(COMMONS_PRESENTATIONS_COLLECTION)
      .where('presentation_id', '==', id)
      .limit(1)
      .get();
    if (byPid.empty) return null;
    snap = byPid.docs[0];
  }
  const d = snap.data() as Record<string, unknown>;
  if (d.tier !== 'reputation') return null; // only reputation presentations are "standing"
  return {
    presentation_id: typeof d.presentation_id === 'string' ? d.presentation_id : snap.id,
    tier: String(d.tier),
    wallet_id: typeof d.wallet_id === 'string' ? d.wallet_id : '',
    presenter_address: typeof d.presenter_address === 'string' ? d.presenter_address : '',
    audience: typeof d.audience === 'string' ? d.audience : '',
    issued_at: typeof d.issued_at === 'number' ? d.issued_at : 0,
    expires_at: typeof d.expires_at === 'number' ? d.expires_at : 0,
  };
}

/** The reputation presentations a wallet has produced (owner history; metadata only). */
export async function standingPresentationsByWallet(
  deps: AgentBankDeps,
  walletId: string,
): Promise<StandingPresentationMeta[]> {
  const q = await deps.db
    .collection(COMMONS_PRESENTATIONS_COLLECTION)
    .where('wallet_id', '==', walletId)
    .where('tier', '==', 'reputation')
    .get();
  return q.docs.map((doc) => {
    const d = doc.data() as Record<string, unknown>;
    return {
      presentation_id: typeof d.presentation_id === 'string' ? d.presentation_id : doc.id,
      tier: String(d.tier ?? 'reputation'),
      wallet_id: typeof d.wallet_id === 'string' ? d.wallet_id : walletId,
      presenter_address: typeof d.presenter_address === 'string' ? d.presenter_address : '',
      audience: typeof d.audience === 'string' ? d.audience : '',
      issued_at: typeof d.issued_at === 'number' ? d.issued_at : 0,
      expires_at: typeof d.expires_at === 'number' ? d.expires_at : 0,
    };
  });
}
