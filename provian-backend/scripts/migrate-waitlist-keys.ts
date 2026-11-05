/**
 * One-time migration: re-key waitlist collection by sha256(normalizedEmail).
 *
 * Closes Chunk I L-25 (TOCTOU dedup race in WaitlistService). Path (a)
 * per the inventory: zero current callers of the mobile WaitlistService
 * so the production row count is at most trivial.
 *
 * The migration logic lives in src/migrations/waitlist-keys.ts so it can
 * be unit-tested by jest. This file is a thin CLI wrapper.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json \
 *     npx ts-node scripts/migrate-waitlist-keys.ts
 */

import admin from 'firebase-admin';
import { migrateWaitlistKeys } from '../src/migrations/waitlist-keys';
import { scriptDb } from './lib/script-db';

admin.initializeApp();
const db = scriptDb();

migrateWaitlistKeys(db).then(
  (stats) => {
    console.log(JSON.stringify(stats, null, 2));
    process.exit(0);
  },
  (err) => {
    console.error('migration failed:', err);
    process.exit(1);
  },
);
