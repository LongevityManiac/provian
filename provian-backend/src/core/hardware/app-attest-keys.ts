/**
 * App Attest KEY REGISTRY (§2.9, the iPhone's Secure Enclave on the mobile lane).
 *
 * Apple's model is attest-once / assert-per-request: the app attests a Secure-Enclave key ONCE
 * (`POST /v1/wallet/app-attest/register` verifies the attestation object against the pinned Apple
 * root and records the key), then every PE carries an ASSERTION signed by that key over the
 * submission's binding nonce. This registry holds the attested public key (JWK + SPKI sha256), the
 * root fingerprint it chained to, and the monotonic counter the assertions must advance.
 *
 * ONE KEY, ONE ACCOUNT. The per-(user, key) doc alone let one iPhone's attested key be
 * registered under N accounts and lift every one of them to hardware_rooted. A GLOBAL owner doc
 * (`app_attest_key_owner_v1/<sha256(key_id)>`) is now created in the register transaction and binds
 * the key to exactly one user; a second user's register is refused `key_bound_to_other_account`,
 * and lookup/advance admit only the owner. The counter lives on the owner doc, so it is GLOBAL per
 * key (Apple's counter is per key, not per account — a per-account counter let the same assertion
 * be spent once per account).
 *
 * Keys registered before the owner doc existed stay valid: when no owner doc exists, the owner is
 * resolved from the legacy per-(user, key) docs — the EARLIEST `attested_at_ms` wins (ties: lowest
 * doc id), its counter is the max any legacy doc saw — and materialized on the first transactional
 * write. `scripts/app-attest-key-owner-migration.ts` does the same resolution in bulk and disables
 * the losing docs.
 *
 * Metadata-only: no receipt bytes, no device serial — the key's own digest and a counter.
 */
import crypto from 'crypto';
import type { Firestore, Transaction, DocumentReference } from 'firebase-admin/firestore';

export const APP_ATTEST_KEYS_COLLECTION = 'app_attest_keys_v1';
export const APP_ATTEST_KEY_OWNER_COLLECTION = 'app_attest_key_owner_v1';
export const APP_ATTEST_REGISTER_PURPOSE = 'provian_app_attest_register';
export const KEY_BOUND_TO_OTHER_ACCOUNT = 'key_bound_to_other_account';

export interface AppAttestKeyDoc {
  readonly user_id: string;
  readonly key_id: string;              // base64 (Apple's key identifier = sha256 of the public key)
  readonly public_key_jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  readonly signer_key_sha256: string;   // sha256(SPKI DER)
  readonly issuer_root_fingerprint: string;
  readonly environment: 'production' | 'development';
  readonly counter: number;
  readonly attested_at_ms: number;
  readonly last_asserted_at_ms: number | null;
  /** Set by the owner migration on a doc whose key belongs to another (earlier) account. */
  readonly disabled_at_ms?: number;
  readonly disabled_reason?: string;
}

/** The GLOBAL binding of one attested key to one account; carries the key's global counter. */
export interface AppAttestKeyOwnerDoc {
  readonly key_id: string;
  readonly user_id: string;
  readonly counter: number;
  readonly bound_at_ms: number;
  readonly last_asserted_at_ms: number | null;
  /** `register` = bound by a fresh registration; `legacy_earliest_attested` = resolved from pre-owner docs. */
  readonly source: 'register' | 'legacy_earliest_attested';
}

export function appAttestKeyDocId(userId: string, keyIdB64: string): string {
  const safe = keyIdB64.replace(/[^A-Za-z0-9]/g, '_');
  return `${userId}__${safe}`;
}

/** Collision-free (the per-user id's `_` substitution maps `+` and `/` together): sha256 of the raw key id. */
export function appAttestKeyOwnerDocId(keyIdB64: string): string {
  return crypto.createHash('sha256').update(keyIdB64, 'utf8').digest('hex');
}

export type AppAttestRegisterOutcome =
  | { readonly created: boolean }
  | { readonly refused: typeof KEY_BOUND_TO_OTHER_ACCOUNT };

export interface AppAttestKeyStore {
  lookup(userId: string, keyIdB64: string): Promise<AppAttestKeyDoc | null>;
  register(doc: AppAttestKeyDoc): Promise<AppAttestRegisterOutcome>;
  /** Advance the counter iff `counter` > stored (returns false when the assertion replays or regresses, or the key is not this user's). */
  advance(userId: string, keyIdB64: string, counter: number, nowMs: number): Promise<boolean>;
}

interface LegacyRow { readonly id: string; readonly data: AppAttestKeyDoc }

/**
 * The owner of a key that has no owner doc yet: the EARLIEST-attested live legacy doc (ties broken
 * by doc id so every caller agrees), with the maximum counter any legacy doc recorded. Pure.
 */
export function resolveLegacyOwner(keyIdB64: string, rows: readonly LegacyRow[], nowMs: number): AppAttestKeyOwnerDoc | null {
  const live = rows.filter((r) => r.data.key_id === keyIdB64 && typeof r.data.user_id === 'string' && r.data.disabled_at_ms === undefined);
  if (live.length === 0) return null;
  const sorted = [...live].sort((a, b) => (a.data.attested_at_ms - b.data.attested_at_ms) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const winner = sorted[0];
  const counter = live.reduce((m, r) => Math.max(m, Number.isFinite(r.data.counter) ? r.data.counter : 0), 0);
  const lastAsserted = live.reduce<number | null>((m, r) => {
    const v = r.data.last_asserted_at_ms;
    return typeof v === 'number' && (m === null || v > m) ? v : m;
  }, null);
  return {
    key_id: keyIdB64,
    user_id: winner.data.user_id,
    counter,
    bound_at_ms: winner.data.attested_at_ms ?? nowMs,
    last_asserted_at_ms: lastAsserted,
    source: 'legacy_earliest_attested',
  };
}

export interface AppAttestKeyOwnerMigrationPlan {
  /** Owner docs to create (keys with no owner doc yet). */
  readonly owners: readonly { readonly id: string; readonly doc: AppAttestKeyOwnerDoc }[];
  /** Legacy per-user docs whose key another (earlier) account owns — to be disabled. */
  readonly disable: readonly { readonly id: string; readonly key_id: string; readonly user_id: string; readonly owner_user_id: string }[];
  /** Keys held under more than one account (the report). */
  readonly shared_keys: readonly { readonly key_id: string; readonly owner_user_id: string; readonly user_ids: readonly string[] }[];
}

/**
 * Bulk form of the lazy resolution (the migration script's planner). For every key with no owner
 * doc: create the owner doc from `resolveLegacyOwner`. For every key (owned or newly resolved):
 * disable each live legacy doc whose user is not the owner. Idempotent — a second run plans nothing.
 */
export function planAppAttestKeyOwnerMigration(
  legacy: readonly LegacyRow[],
  existingOwners: ReadonlyMap<string, AppAttestKeyOwnerDoc>,
  nowMs: number,
): AppAttestKeyOwnerMigrationPlan {
  const byKey = new Map<string, LegacyRow[]>();
  for (const r of legacy) {
    if (typeof r.data?.key_id !== 'string') continue;
    const list = byKey.get(r.data.key_id) ?? [];
    list.push(r);
    byKey.set(r.data.key_id, list);
  }
  const owners: { id: string; doc: AppAttestKeyOwnerDoc }[] = [];
  const disable: { id: string; key_id: string; user_id: string; owner_user_id: string }[] = [];
  const shared: { key_id: string; owner_user_id: string; user_ids: string[] }[] = [];
  for (const [keyId, rows] of [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    let owner = existingOwners.get(keyId) ?? null;
    if (!owner) {
      owner = resolveLegacyOwner(keyId, rows, nowMs);
      if (!owner) continue;
      owners.push({ id: appAttestKeyOwnerDocId(keyId), doc: owner });
    }
    const users = [...new Set(rows.map((r) => r.data.user_id))].sort();
    if (users.length > 1) shared.push({ key_id: keyId, owner_user_id: owner.user_id, user_ids: users });
    for (const r of rows) {
      if (r.data.user_id !== owner.user_id && r.data.disabled_at_ms === undefined) {
        disable.push({ id: r.id, key_id: keyId, user_id: r.data.user_id, owner_user_id: owner.user_id });
      }
    }
  }
  return { owners, disable, shared_keys: shared };
}

export function firestoreAppAttestKeyStore(db: Firestore): AppAttestKeyStore {
  const keyRef = (userId: string, keyId: string) => db.collection(APP_ATTEST_KEYS_COLLECTION).doc(appAttestKeyDocId(userId, keyId));
  const ownerRef = (keyId: string) => db.collection(APP_ATTEST_KEY_OWNER_COLLECTION).doc(appAttestKeyOwnerDocId(keyId));
  const legacyQuery = (keyId: string) => db.collection(APP_ATTEST_KEYS_COLLECTION).where('key_id', '==', keyId);

  /**
   * Read the key's owner inside `txn` (all reads — no writes). `materialize` is true when the owner
   * was resolved from legacy docs and must be written by the caller after its own reads.
   */
  async function readOwnerTx(txn: Transaction, keyId: string, nowMs: number): Promise<{ owner: AppAttestKeyOwnerDoc | null; ref: DocumentReference; materialize: boolean }> {
    const ref = ownerRef(keyId);
    const snap = await txn.get(ref);
    if (snap.exists) {
      const d = snap.data() as AppAttestKeyOwnerDoc;
      return { owner: d.key_id === keyId ? d : null, ref, materialize: false };
    }
    const q = await txn.get(legacyQuery(keyId));
    const rows = q.docs.map((doc) => ({ id: doc.id, data: doc.data() as AppAttestKeyDoc }));
    const owner = resolveLegacyOwner(keyId, rows, nowMs);
    return { owner, ref, materialize: owner !== null };
  }

  return {
    async lookup(userId, keyIdB64) {
      const ownerSnap = await ownerRef(keyIdB64).get();
      let owner: AppAttestKeyOwnerDoc | null;
      if (ownerSnap.exists) {
        const d = ownerSnap.data() as AppAttestKeyOwnerDoc;
        owner = d.key_id === keyIdB64 ? d : null;
      } else {
        const q = await legacyQuery(keyIdB64).get();
        owner = resolveLegacyOwner(keyIdB64, q.docs.map((doc) => ({ id: doc.id, data: doc.data() as AppAttestKeyDoc })), Date.now());
      }
      if (!owner || owner.user_id !== userId) return null;
      const snap = await keyRef(userId, keyIdB64).get();
      if (!snap.exists) return null;
      const d = snap.data() as AppAttestKeyDoc;
      if (d.user_id !== userId || d.key_id !== keyIdB64 || d.disabled_at_ms !== undefined) return null;
      // The counter an assertion must beat is the key's GLOBAL counter.
      return { ...d, counter: owner.counter };
    },
    async register(doc) {
      return db.runTransaction(async (txn): Promise<AppAttestRegisterOutcome> => {
        const { owner, ref: oRef, materialize } = await readOwnerTx(txn, doc.key_id, doc.attested_at_ms);
        const r = keyRef(doc.user_id, doc.key_id);
        const snap = await txn.get(r);
        if (owner && owner.user_id !== doc.user_id) return { refused: KEY_BOUND_TO_OTHER_ACCOUNT };
        if (!owner) {
          const fresh: AppAttestKeyOwnerDoc = { key_id: doc.key_id, user_id: doc.user_id, counter: doc.counter, bound_at_ms: doc.attested_at_ms, last_asserted_at_ms: null, source: 'register' };
          txn.set(oRef, fresh);
        } else if (materialize) {
          txn.set(oRef, owner);
        }
        if (snap.exists) return { created: false };
        txn.set(r, doc);
        return { created: true };
      });
    },
    async advance(userId, keyIdB64, counter, nowMs) {
      return db.runTransaction(async (txn) => {
        const { owner, ref: oRef } = await readOwnerTx(txn, keyIdB64, nowMs);
        const r = keyRef(userId, keyIdB64);
        const snap = await txn.get(r);
        if (!owner || owner.user_id !== userId || !snap.exists) return false;
        const d = snap.data() as AppAttestKeyDoc;
        if (d.user_id !== userId || d.disabled_at_ms !== undefined) return false;
        if (!(counter > owner.counter)) return false;
        txn.set(oRef, { ...owner, counter, last_asserted_at_ms: nowMs });
        txn.set(r, { ...d, counter, last_asserted_at_ms: nowMs });
        return true;
      });
    },
  };
}
