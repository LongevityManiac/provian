import { beginLocationErasure, eraseActorLocationCopies } from '../jurisdiction/location-copy-erasure';


import { FieldValue } from 'firebase-admin/firestore';
import type { DocumentReference, Firestore, WriteBatch } from 'firebase-admin/firestore';
import { deleteOwnerMeterState } from '../meter/owner-reads';
import { HUMAN_PROVEN_ADDRESSES_COLLECTION } from '../external-address/link';
import { SOLANA_PROVEN_ADDRESSES_COLLECTION } from '../external-address/solana-link';
import { APP_OUTPUT_KEYS_COLLECTION } from '../pvt/output-signing-keys';
import { HUMAN_APPROVAL_REQUESTS_COLLECTION } from '../pe/human-approval-request';
import { PRESENTATION_REQUESTS_COLLECTION } from '../pe/presentation-request';
import { COMMONS_COLLECTIONS } from '../commons/types';
import { STORE_TRANSACTIONS_COLLECTION } from '../store-purchases/store-products';
import { deleteWalletLocation, COMPLIANCE_EVENTS_COLLECTION } from '../jurisdiction/location-retention';
import { SESSION_COLLECTION } from '../jurisdiction/mint-compliance';
import {
  SERVICE_INSTALLS_COLLECTION,
  markServiceInstallRevoked,
  type ServiceInstallDocument,
} from '../witnesses/service-installs';

/** Legacy collections holding records keyed by `user_id` that go with the account. */
export const USER_DATA_LEGACY_COLLECTIONS: readonly string[] = Object.freeze([
  'agents',
  'agent_sessions',
  'authorization_requests',
  'transactions',
]);

/**
 * Every collection the relay reads by a person's identity, and what this deletion does to it.
 * The test cross-checks this map against the relay's source: a collection the code queries by
 * `user_id` / `owner_user_id` / `human_user_id` that is not classified here fails it.
 */
export const USER_RECORD_DISPOSITIONS: Readonly<Record<string, 'deleted' | 'revoked' | 'released' | 'deactivated' | 'kept' | 'compliance_retention'>> =
  Object.freeze({
    users: 'deleted',
    auth_secrets: 'deleted',
    user_preferences: 'deleted',
    agents: 'deleted',
    agent_sessions: 'deleted',
    authorization_requests: 'deleted',
    transactions: 'deleted',
    setup_tokens: 'deleted',
    [HUMAN_PROVEN_ADDRESSES_COLLECTION]: 'deleted',
    [SOLANA_PROVEN_ADDRESSES_COLLECTION]: 'deleted',
    [APP_OUTPUT_KEYS_COLLECTION]: 'deleted',
    [HUMAN_APPROVAL_REQUESTS_COLLECTION]: 'deleted',
    [PRESENTATION_REQUESTS_COLLECTION]: 'deleted',
    [COMMONS_COLLECTIONS.MESSAGE_KEYS]: 'deleted',
    devices: 'revoked',
    [SERVICE_INSTALLS_COLLECTION]: 'revoked',
    wallets: 'released',
    agent_wallets: 'kept', // Beneficiary links end; the agent's identity and record stay its own.
    [COMMONS_COLLECTIONS.PROFILES]: 'deactivated',
    // A store transaction credits once, ever: its record is that purchase's replay guard and the
    // record of what was bought, so it stays (it holds no personal fields beyond the account id).
    [STORE_TRANSACTIONS_COLLECTION]: 'kept',
    // Erased unless an actual compliance hold/denial has a live ten-year deadline.
    [SESSION_COLLECTION]: 'compliance_retention',
    [COMPLIANCE_EVENTS_COLLECTION]: 'kept', // Opaque mint-decision clock; no location or wallet fields.
  });

/** Personal fields removed from a deactivated human Commons profile (display_name is emptied). */
export const COMMONS_PROFILE_PERSONAL_FIELDS: readonly string[] = Object.freeze([
  'avatar_url', 'bio', 'skills', 'location', 'availability', 'languages',
  'service_rate_pvt', 'service_rate_usdc',
]);

/** Firestore allows at most 500 writes per batch; stay well under it. */
const BATCH_LIMIT = 400;

export interface DeleteUserDataDeps {
  readonly db: Firestore;
  /** The revoke route's cache invalidation (`invalidateDeviceCache`), so a revoked device stops at once. */
  readonly invalidateDeviceCache: (db: Firestore, deviceId: string) => Promise<void>;
  /** The existing Commons leave path (`leaveCommons`), for the person's human profile. */
  readonly leaveCommons: (walletId: string) => Promise<void>;
  /** Drop the relay's cached copy of the auth secret (else it verifies tokens until its TTL). */
  readonly invalidateAuthSecret?: (userId: string) => Promise<void>;
  /** End every link through the human-alone unlink transaction, including its durable notice. */
  readonly endBeneficiaryLinks: (userId: string) => Promise<void>;
  readonly nowMs?: () => number;
}

export interface DeleteUserDataResult {
  /** Documents deleted. */
  readonly deleted: number;
  /** Human devices and forge installs revoked. */
  readonly revoked: number;
  /** Human wallet registrations released (kept, marked released). */
  readonly released_wallets: number;
  /** Human Commons profiles deactivated and stripped of personal fields. */
  readonly deactivated_profiles: number;
}

async function commitInChunks(
  db: Firestore,
  ops: ReadonlyArray<(batch: WriteBatch) => void>,
): Promise<void> {
  for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const op of ops.slice(i, i + BATCH_LIMIT)) op(batch);
    await batch.commit();
  }
}

async function refsWhere(db: Firestore, collection: string, field: string, value: string): Promise<DocumentReference[]> {
  const snap = await db.collection(collection).where(field, '==', value).get();
  return snap.docs.map((d) => d.ref);
}

export async function deleteUserRelayData(userId: string, deps: DeleteUserDataDeps): Promise<DeleteUserDataResult> {
  const { db } = deps;
  const now = deps.nowMs ?? Date.now;
  let deleted = 0;
  let revoked = 0;

  // 1. Stop everything that could keep writing under this id.
  //    a. The person's computers (human devices only), revoked + cache dropped like the revoke route.
  const deviceSnap = await db.collection('devices')
    .where('owner_user_id', '==', userId)
    .where('owner_type', '==', 'human')
    .get();
  for (const doc of deviceSnap.docs) {
    const data = doc.data() as Record<string, unknown>;
    if (data.owner_type !== 'human' || data.owner_user_id !== userId) continue;
    if (data.status !== 'revoked') {
      await doc.ref.update({ status: 'revoked' });
      revoked += 1;
    }
    await deps.invalidateDeviceCache(db, doc.id);
  }
  //    b. Their forge installs.
  const installSnap = await db.collection(SERVICE_INSTALLS_COLLECTION).where('user_id', '==', userId).get();
  for (const doc of installSnap.docs) {
    const install = doc.data() as ServiceInstallDocument;
    if (install.user_id !== userId || install.revoked_at != null) continue;
    if (await markServiceInstallRevoked(db, install.provider, install.installation_id)) revoked += 1;
  }
  // c. Their human wallets, released BEFORE the meter wipe: the chain lanes stop pricing
  //       a released wallet, so nothing regrows under this id in step 3. A re-sent request keeps the
  //       first release time.
  const humanWallets = await db.collection('wallets')
    .where('user_id', '==', userId)
    .where('type', '==', 'human')
    .get();
  const releasedAtMs = now();
  for (const doc of humanWallets.docs) {
    if (typeof (doc.data() as Record<string, unknown>).released_at_ms !== 'number') {
      await doc.ref.update({ released_at_ms: releasedAtMs });
    }
  }

  // Released wallets cannot accept new binds or be inherited by new children. End every
  // existing link before the account/auth disappear. A failed unlink leaves deletion retryable.
  await deps.endBeneficiaryLinks(userId);

  // 2. Bindings and person-addressed records (deleted in pages).
  const ops: Array<(batch: WriteBatch) => void> = [];
  const del = (ref: DocumentReference) => { ops.push((batch) => { batch.delete(ref); }); deleted += 1; };
  const setupSnap = await db.collection('setup_tokens').where('user_id', '==', userId).get();
  for (const doc of setupSnap.docs) if ((doc.data() as Record<string, unknown>).type === 'device_registration') del(doc.ref);
  for (const ref of await refsWhere(db, HUMAN_PROVEN_ADDRESSES_COLLECTION, 'user_id', userId)) del(ref);
  const solanaSnap = await db.collection(SOLANA_PROVEN_ADDRESSES_COLLECTION).where('user_id', '==', userId).get();
  for (const doc of solanaSnap.docs) if ((doc.data() as Record<string, unknown>).owner_type === 'human') del(doc.ref);
  for (const ref of await refsWhere(db, APP_OUTPUT_KEYS_COLLECTION, 'owner_user_id', userId)) del(ref);
  for (const ref of await refsWhere(db, HUMAN_APPROVAL_REQUESTS_COLLECTION, 'human_user_id', userId)) del(ref);
  for (const ref of await refsWhere(db, PRESENTATION_REQUESTS_COLLECTION, 'human_user_id', userId)) del(ref);
  await commitInChunks(db, ops.splice(0));

  // The deletion fence and copy traversal cover mutable country/region projections too.
  let locationRetentionUntil = 0;
  for (const wallet of humanWallets.docs) {
    const address: unknown = wallet.data().address;
    if (typeof address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(address)) continue;
    const observation = (await db.collection(SESSION_COLLECTION).doc(address.toLowerCase()).get()).data();
    if (typeof observation?.retention_until_ms === 'number') locationRetentionUntil = Math.max(locationRetentionUntil, observation.retention_until_ms);
  }
  locationRetentionUntil = await beginLocationErasure(db, userId, locationRetentionUntil, releasedAtMs);
  if (locationRetentionUntil <= releasedAtMs) await eraseActorLocationCopies(db, userId, releasedAtMs);
  // Wallet release above also fences delayed authenticated observation writes.
  for (const wallet of humanWallets.docs) {
    const address = wallet.data().address;
    if (typeof address === 'string' && await deleteWalletLocation(db, address, releasedAtMs)) deleted++;
  }

  // 3. The owner's meter state (paged by actor inside; earnings kept).
  deleted += await deleteOwnerMeterState(db, userId);

  // 4. The Commons profile (deactivated, personal fields removed) and message key. A person who
  //    joined or published from the app is keyed by their user id (commons-auth sets walletId to
  //    req.user.id; threads publish under the party ref); a wallet-keyed record may also exist.
  let deactivatedProfiles = 0;
  const partyIds = [...new Set([userId, ...humanWallets.docs.map((w) => w.id)])];
  for (const partyId of partyIds) {
    const profileRef = db.collection(COMMONS_COLLECTIONS.PROFILES).doc(partyId);
    const profile = await profileRef.get();
    if (profile.exists && (profile.data() as Record<string, unknown>).participant_type === 'human') {
      await deps.leaveCommons(partyId);
      const scrub: Record<string, unknown> = { display_name: '' };
      for (const field of COMMONS_PROFILE_PERSONAL_FIELDS) scrub[field] = FieldValue.delete();
      await profileRef.update(scrub);
      deactivatedProfiles += 1;
    }
    const keyRef = db.collection(COMMONS_COLLECTIONS.MESSAGE_KEYS).doc(partyId);
    if ((await keyRef.get()).exists) del(keyRef);
  }

  // 5. Legacy per-user records and settings.
  for (const name of USER_DATA_LEGACY_COLLECTIONS) {
    for (const ref of await refsWhere(db, name, 'user_id', userId)) del(ref);
  }
  const prefsRef = db.collection('user_preferences').doc(userId);
  if ((await prefsRef.get()).exists) del(prefsRef);
  await commitInChunks(db, ops.splice(0));

  // 6. The account record and the authentication record, together and last: until here a failed
  //    request can be sent again with the same credentials.
  const final = db.batch();
  for (const name of ['users', 'auth_secrets']) {
    const ref = db.collection(name).doc(userId);
    if ((await ref.get()).exists) {
      final.delete(ref);
      deleted += 1;
    }
  }
  await final.commit();
  if (deps.invalidateAuthSecret) await deps.invalidateAuthSecret(userId);

  return { deleted, revoked, released_wallets: humanWallets.docs.length, deactivated_profiles: deactivatedProfiles };
}
