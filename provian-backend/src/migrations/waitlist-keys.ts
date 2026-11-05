/**
 * Waitlist key-migration logic (Chunk I L-25 closure).
 *
 * The mobile WaitlistService now writes to a deterministic doc id
 * (sha256 hex of the lowercased + trimmed email). Existing rows from
 * the pre-fix code path were keyed by random IDs from addDoc(); this
 * helper copies each old row to its hash-keyed counterpart and deletes
 * the legacy row.
 *
 * Idempotent: safe to run multiple times. The script wrapper at
 * scripts/migrate-waitlist-keys.ts is a thin CLI shim around this
 * function so the logic can be unit-tested with an in-memory Firestore
 * stub.
 */

import admin from 'firebase-admin';
import crypto from 'crypto';

const COLLECTION = 'waitlist';
const BATCH_SIZE = 200;

export function emailToDocId(email: string): string {
  const normalized = email.toLowerCase().trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export interface MigrationStats {
  migrated: number;
  skipped_already_keyed: number;
  skipped_target_exists: number;
  skipped_missing_email: number;
}

export async function migrateWaitlistKeys(db: admin.firestore.Firestore): Promise<MigrationStats> {
  const stats: MigrationStats = {
    migrated: 0,
    skipped_already_keyed: 0,
    skipped_target_exists: 0,
    skipped_missing_email: 0,
  };

  let snapshot = await db.collection(COLLECTION).limit(BATCH_SIZE).get();

  while (!snapshot.empty) {
    let progressedThisBatch = false;
    for (const sourceDoc of snapshot.docs) {
      const data = sourceDoc.data() as { email?: unknown };
      if (typeof data.email !== 'string' || data.email.length === 0) {
        stats.skipped_missing_email++;
        continue;
      }
      const targetId = emailToDocId(data.email);
      if (sourceDoc.id === targetId) {
        stats.skipped_already_keyed++;
        continue;
      }
      const targetRef = db.collection(COLLECTION).doc(targetId);
      const targetSnap = await targetRef.get();
      if (targetSnap.exists) {
        // Target already correct; remove the legacy duplicate.
        await sourceDoc.ref.delete();
        stats.skipped_target_exists++;
        progressedThisBatch = true;
        continue;
      }
      await db.runTransaction(async (txn) => {
        const recheck = await txn.get(targetRef);
        if (recheck.exists) return;
        txn.set(targetRef, data);
        txn.delete(sourceDoc.ref);
      });
      stats.migrated++;
      progressedThisBatch = true;
    }
    if (!progressedThisBatch || snapshot.docs.length < BATCH_SIZE) break;
    snapshot = await db.collection(COLLECTION).limit(BATCH_SIZE).get();
  }

  return stats;
}
