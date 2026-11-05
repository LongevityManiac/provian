/** Exact read-only preparation for per-user, per-UTC-day artifact novelty. */

import type { Firestore } from 'firebase-admin/firestore';
import {
  prepareMintOnceClaim,
  utcDayScope,
  type PreparedMintOnceClaim,
} from './mint-once-claim';

export async function prepareArtifactNoveltyClaim(
  db: Firestore,
  userId: string,
  artifactHash: string,
  peId: string,
  timestampMs: number,
  nowMs = Date.now(),
): Promise<PreparedMintOnceClaim> {
  return prepareMintOnceClaim(db, {
    kind: 'artifact',
    subjectId: userId,
    eventId: artifactHash,
    scopeId: utcDayScope(timestampMs),
    peId,
    userId,
    nowMs,
  });
}
