/** Exact read-only preparation for a cross-witness git-commit mint claim. */

import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import {
  prepareMintOnceClaim,
  type PreparedMintOnceClaim,
} from './mint-once-claim';

export function commitClaimDocId(userId: string, commitSha: string): string {
  return crypto.createHash('sha256')
    .update(`${userId.trim()}:${commitSha.trim().toLowerCase()}`)
    .digest('hex');
}

/**
 * Prepare without mutating Firestore. writePEHistory commits the returned
 * canonical claim together with the PE row or rejects a concurrent race.
 */
export async function prepareCommitMintClaim(
  db: Firestore,
  userId: string,
  commitSha: string,
  peId: string,
  nowMs = Date.now(),
): Promise<PreparedMintOnceClaim> {
  return prepareMintOnceClaim(db, {
    kind: 'commit',
    subjectId: userId,
    eventId: commitSha,
    peId,
    userId,
    nowMs,
  });
}
