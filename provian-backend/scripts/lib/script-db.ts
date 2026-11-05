/**
 * The Firestore client for operator scripts — the SAME database selection as
 * the relay (`src/firestore-db.ts`): `FIRESTORE_DATABASE_ID`, unset/empty =
 * "(default)". A script run during or after the move to a named database
 * reads and writes the database the relay uses, never a hardcoded "(default)".
 *
 * - Initializes firebase-admin only when no app exists yet (application
 *   default credentials; project from GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT,
 *   else 'provian-ai'). A script that runs its own `initializeApp` first keeps it.
 * - Applies `RELAY_FIRESTORE_SETTINGS` exactly once per client (shared guard
 *   with the relay modules a script imports, which reach the same instance).
 * - Throws on an invalid `FIRESTORE_DATABASE_ID` (fail closed).
 */

import admin from 'firebase-admin';
import type { Firestore } from 'firebase-admin/firestore';
import {
  applyRelayFirestoreSettingsOnce,
  relayDatabaseId,
  relayDb,
} from '../../src/firestore-db';

export { relayDatabaseId };

export function scriptProjectId(): string {
  return process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || 'provian-ai';
}

export function scriptDb(): Firestore {
  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: scriptProjectId(),
    });
  }
  applyRelayFirestoreSettingsOnce(relayDb());
  return relayDb();
}
