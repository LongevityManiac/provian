/**
 * The relay's Firestore database selection — ONE setting for every Firestore
 * client in the relay.
 *
 * `FIRESTORE_DATABASE_ID` names the database. Unset or empty means `(default)`,
 * which is exactly what every client used before this module existed, so the
 * move to a named database (and the rollback) is a change of one env var.
 *
 * - `(default)` → `relayDb()` returns `admin.firestore()` EXACTLY, every call,
 *   so every existing jest mock of `admin.firestore` keeps working and the
 *   default path is byte-for-byte the pre-existing behavior. `server.ts`
 *   applies `RELAY_FIRESTORE_SETTINGS` to that client at boot, as before.
 * - a named id → `relayDb()` returns ONE cached `getFirestore(admin.app(), id)`
 *   with `RELAY_FIRESTORE_SETTINGS` applied exactly once (Firestore refuses a
 *   second `settings()` call, and refuses one after first use).
 *
 * An id that is not a valid Firestore database id throws (fail closed): a typo
 * must never silently fall back to `(default)`.
 */

import adminDefault from 'firebase-admin';
import * as adminNamespace from 'firebase-admin';
import type { App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { RELAY_FIRESTORE_SETTINGS } from './firestore-settings';
import {privateFirestore,rawPrivateFirestore} from './core/provenance/private-store';

export const DEFAULT_FIRESTORE_DATABASE_ID = '(default)';

/**
 * Firestore database ids: `(default)`, or 4–63 characters of lowercase
 * letters, digits and hyphens, starting with a letter and ending with a letter
 * or digit.
 */
const NAMED_DATABASE_ID = /^[a-z][a-z0-9-]{2,61}[a-z0-9]$/;

export function isValidFirestoreDatabaseId(id: string): boolean {
  return id === DEFAULT_FIRESTORE_DATABASE_ID || NAMED_DATABASE_ID.test(id);
}

/**
 * Validate a database id; returns it unchanged or throws. Shared by the relay
 * and the operator scripts so both refuse the same ids.
 */
export function assertFirestoreDatabaseId(id: string, source = 'FIRESTORE_DATABASE_ID'): string {
  if (!isValidFirestoreDatabaseId(id)) {
    throw new Error(
      `${source}=${JSON.stringify(id)} is not a valid Firestore database id ` +
      `(expected "(default)" or 4-63 chars of [a-z0-9-], starting with a letter, ending with a letter or digit)`,
    );
  }
  return id;
}

/** The database the relay reads and writes. Throws on an invalid id. */
export function relayDatabaseId(): string {
  const raw = (process.env.FIRESTORE_DATABASE_ID ?? '').trim();
  if (raw === '') return DEFAULT_FIRESTORE_DATABASE_ID;
  return assertFirestoreDatabaseId(raw);
}

interface AdminSurface {
  firestore: () => Firestore;
  app: () => App;
}

/**
 * The firebase-admin namespace. In production the default and namespace
 * imports are the same object (firebase-admin is CommonJS); in tests a mock
 * may populate only one of them, so take whichever carries `firestore`.
 */
function adminSurface(): AdminSurface {
  const viaDefault = adminDefault as unknown as Partial<AdminSurface> | undefined;
  if (viaDefault && typeof viaDefault.firestore === 'function') return viaDefault as AdminSurface;
  return adminNamespace as unknown as AdminSurface;
}

const namedClients = new Map<string, Firestore>();
/**
 * firebase-admin itself caches one instance per (app, database id), so the
 * settings guard keys on the instance, not on our own map — and it is shared
 * with the operator scripts (`scripts/lib/script-db.ts`), which reach the same
 * instances.
 */
const settingsApplied = new WeakSet<Firestore>();

/**
 * Apply `RELAY_FIRESTORE_SETTINGS` to a client once. Firestore refuses a
 * second `settings()` call, so every caller that configures a client goes
 * through here.
 */
export function applyRelayFirestoreSettingsOnce(db: Firestore): Firestore {
  db=rawPrivateFirestore(db);
  if (!settingsApplied.has(db)) {
    db.settings(RELAY_FIRESTORE_SETTINGS);
    settingsApplied.add(db);
  }
  return db;
}

/** The relay's Firestore client, for the database `relayDatabaseId()` names. */
export function relayDb(): Firestore {
  const id = relayDatabaseId();
  const admin = adminSurface();
  if (id === DEFAULT_FIRESTORE_DATABASE_ID) return privateFirestore(admin.firestore());
  const cached = namedClients.get(id);
  if (cached) return privateFirestore(cached);
  const db = applyRelayFirestoreSettingsOnce(getFirestore(admin.app(), id));
  namedClients.set(id, db);
  return privateFirestore(db);
}

/** Test-only: forget cached named clients. */
export function __resetRelayDbCacheForTests(): void {
  namedClients.clear();
}
