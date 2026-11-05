/**
 * DELETE /v1/user/data — every relay-side record class the Privacy Policy ties to the person's
 * account is deleted, revoked, released or deactivated; what the Policy keeps stays (2026-10-23
 * close-out, ).
 *
 * Two independent bindings, so the suite cannot pass by checking a list it declares itself:
 *  1. SOURCE CROSS-CHECK. The relay's own source is scanned for every collection it queries by a
 *     person's identity (`user_id`, `owner_user_id`, `human_user_id`); each one must be classified
 *     in the module's `USER_RECORD_DISPOSITIONS`. A new collection keyed by a person that nobody
 *     classified fails here. In-suite RED: the scanner finds a planted query, and an unclassified
 *     name is reported.
 *  2. BEHAVIOUR. Every class is seeded from the Policy text (declared HERE, not read from the
 *     module) and the deletion is run; each must end in the state the Policy gives it. The seeded
 *     list must also cover every class the module claims to delete, revoke or deactivate.
 *
 * RED controls by hand (2026-10-23), each against the module with one step removed — every one
 * fails 3 tests with the named class reported:
 *  - the device revoke             → `devices/u1_mac (§4.2 …) is not revoked`;
 *  - the proven-address delete     → `human_proven_addresses/0xa1… (§4.15 …) is not gone`;
 *  - the approval-request delete   → `human_approval_requests_v1/u1_req (§4.16 …) is not gone`;
 *  - the app output key delete     → `app_output_keys_v1/u1_key (§4.1 …) is not gone`;
 *  - the message key delete        → `commons_message_keys/hw_u1 (§4.17 …) is not gone`;
 *  - the profile deactivation      → `commons_profiles/hw_u1 (§4.7 …) is not deactivated`;
 *  - `auth_secrets` from the final batch → `auth_secrets/u1 (§8.2 …) is not gone`;
 *  and dropping `service_installs` from USER_RECORD_DISPOSITIONS fails the source cross-check.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { actKeyDocFor } from '../meter/__test-helpers__/seed-act-keys';
import { COUNTERPARTY_PAIRS_COLLECTION } from '../meter/counterparty-pairs';
import { IDENTITY_ACTS_COLLECTION } from '../meter/identity-acts';
import {
  METER_ACT_KEYS_COLLECTION,
  METER_HELD_ACTS_COLLECTION,
  METER_PENDING_CLAIMS_COLLECTION,
  PE_MAILBOX_COLLECTION,
} from '../meter/meter-store';
import { leaveCommons } from '../commons/profiles';
import type { CommonsDeps } from '../commons/types';
import { USER_RECORD_DISPOSITIONS, deleteUserRelayData, type DeleteUserDataDeps } from './delete-user-data';
import { SESSION_COLLECTION } from '../jurisdiction/mint-compliance';

const DB = (fake: FakeFirestore) => fake as unknown as Firestore;
const T0 = Date.parse('2026-10-01T00:00:00Z');
const BACKEND_SRC = path.resolve(__dirname, '../..');

// ─── 1. Source cross-check ────────────────────────────────────────────────────

const IDENTITY_FIELDS = ['user_id', 'owner_user_id', 'human_user_id'];

/** Collections the given sources query by a person's identity (`.collection(X).where(<field>, '==', …)`). */
function collectionsQueriedByPerson(sources: ReadonlyArray<{ file: string; text: string }>): Map<string, string[]> {
  const constants = new Map<string, string>();
  for (const { text } of sources) {
    for (const m of text.matchAll(/export const ([A-Z0-9_]+)\s*=\s*['"]([a-z0-9_]+)['"]/g)) constants.set(m[1], m[2]);
    for (const m of text.matchAll(/\b([A-Z_]+):\s*['"]([a-z0-9_]+)['"]/g)) constants.set(m[1], m[2]);
  }
  const query = new RegExp(
    `collection\\(\\s*(['"][A-Za-z0-9_]+['"]|[A-Za-z_][A-Za-z0-9_.]*)\\s*\\)\\s*\\.where\\(\\s*['"](${IDENTITY_FIELDS.join('|')})['"]\\s*,\\s*['"]==['"]`,
    'g',
  );
  const found = new Map<string, string[]>();
  for (const { file, text } of sources) {
    // A file-local alias of a constant (`const COLLECTION = SERVICE_INSTALLS_COLLECTION;`).
    const local = new Map<string, string>();
    for (const m of text.matchAll(/const ([A-Z0-9_]+)\s*=\s*([A-Z0-9_]+)\s*;/g)) {
      const target = constants.get(m[2]);
      if (target) local.set(m[1], target);
    }
    for (const m of text.matchAll(query)) {
      const raw = m[1];
      const key = raw.split('.').pop() ?? '';
      const name = /^['"]/.test(raw) ? raw.slice(1, -1) : (local.get(key) ?? constants.get(key) ?? `<unresolved ${raw}>`);
      found.set(name, [...(found.get(name) ?? []), file]);
    }
  }
  return found;
}

function relaySources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('__test')) walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
        out.push({ file: path.relative(BACKEND_SRC, full), text: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(BACKEND_SRC);
  return out;
}

function unclassified(found: Map<string, string[]>, dispositions: Readonly<Record<string, string>>): string[] {
  return [...found.keys()].filter((name) => !(name in dispositions)).sort();
}

describe('the deletion covers every collection the relay reads by a person', () => {
  it('in-suite RED: a planted query is found, and an unclassified collection is reported', () => {
    const planted = collectionsQueriedByPerson([{
      file: 'planted.ts',
      text: "export const PLANTED_COLLECTION = 'planted_person_records';\n"
        + "db.collection(PLANTED_COLLECTION)\n  .where('owner_user_id', '==', userId).get();",
    }]);
    expect([...planted.keys()]).toEqual(['planted_person_records']);
    expect(unclassified(planted, USER_RECORD_DISPOSITIONS)).toEqual(['planted_person_records']);
  });

  it('every collection the relay source queries by user_id / owner_user_id / human_user_id is classified', () => {
    const found = collectionsQueriedByPerson(relaySources());
    // Never a pass over an empty population: the scan must see the known person-keyed collections.
    expect(found.size).toBeGreaterThanOrEqual(8);
    for (const known of ['devices', 'human_proven_addresses', 'human_approval_requests_v1', 'wallets']) {
      expect(found.has(known)).toBe(true);
    }
    expect([...found.keys()].filter((n) => n.startsWith('<unresolved'))).toEqual([]);
    expect(unclassified(found, USER_RECORD_DISPOSITIONS)).toEqual([]);
  });
});

// ─── 2. Behaviour ─────────────────────────────────────────────────────────────

type Expect = 'gone' | 'kept' | 'revoked' | 'released' | 'deactivated';

/** Record classes from the Policy text: [store key, expected end state, Policy reason]. */
function policyClasses(user: string): Array<[string, Expect, string]> {
  const hw = `hw_${user}`;
  return [
    [`users/${user}`, 'gone', '§4.1 account information (device ids, push tokens, display name)'],
    [`auth_secrets/${user}`, 'gone', '§8.2 authentication record'],
    [`user_preferences/${user}`, 'gone', '§11.2 settings'],
    [`devices/${user}_mac`, 'revoked', '§4.2 registered computer (owner_user_id)'],
    [`service_installs/github_${user}`, 'revoked', '§4.13 code-witness install'],
    [`setup_tokens/${user}_token`, 'gone', '§4.1 device invitation'],
    [`human_proven_addresses/0x${user === 'u1' ? 'a1' : 'b2'}${'0'.repeat(38)}`, 'gone', '§4.15 proven wallet'],
    [`solana_proven_addresses/Sol${user}`, 'gone', '§4.15 proven Solana wallet'],
    [`app_output_keys_v1/${user}_key`, 'gone', '§4.1 the phone key registered to the account'],
    [`human_approval_requests_v1/${user}_req`, 'gone', '§4.16 approval request (plaintext description)'],
    [`presentation_requests_v1/${user}_pres`, 'gone', '§4.18 presentation request (Tier-3 note)'],
    [`commons_message_keys/${hw}`, 'gone', '§4.17 published message key'],
    [`commons_profiles/${hw}`, 'deactivated', '§4.7 human Commons profile'],
    // The app keys a person's profile and message key by their user id (commons-auth walletId = user id).
    [`commons_message_keys/${user}`, 'gone', '§4.17 published message key (app, user-id keyed)'],
    [`commons_profiles/${user}`, 'deactivated', '§4.7 human Commons profile (app, user-id keyed)'],
    [`${METER_ACT_KEYS_COLLECTION}/${user}_act_minted`, 'gone', '§4.3 priced act record'],
    [`${METER_HELD_ACTS_COLLECTION}/${user}_held_done`, 'gone', '§4.3 held act'],
    [`${PE_MAILBOX_COLLECTION}/${user}_mail_in`, 'gone', '§4.3 sealed PE copy'],
    [`${PE_MAILBOX_COLLECTION}/${user}_mail_out`, 'gone', '§4.3 sealed PE copy'],
    [`${IDENTITY_ACTS_COLLECTION}/${user}_identity`, 'gone', '§4.3 identity-event record'],
    [`${COUNTERPARTY_PAIRS_COLLECTION}/${user}_pair`, 'gone', '§4.3 per-relationship count'],
    [`agents/${user}_agent`, 'gone', '§8.2 agent request metadata (legacy)'],
    [`agent_sessions/${user}_session`, 'gone', '§8.2 agent request metadata (legacy)'],
    [`authorization_requests/${user}_auth_req`, 'gone', '§8.2 agent request metadata (legacy)'],
    [`transactions/${user}_tx`, 'gone', '§8.2 per-user records (legacy)'],
    // Kept, each with the Policy section that keeps it.
    [`wallets/${hw}`, 'released', '; §9 integrity: released, not deleted'],
    [`${METER_PENDING_CLAIMS_COLLECTION}/${user}_claim`, 'kept', '§9 earnings not yet minted'],
    [`${METER_ACT_KEYS_COLLECTION}/${user}_act_unminted`, 'kept', '§9 earnings not yet minted'],
    [`${METER_HELD_ACTS_COLLECTION}/${user}_held_payee`, 'kept', '§9 earnings not yet minted'],
    [`actor_stats_v1/${user}`, 'kept', '§11.2 running totals may remain'],
    [`commons_human_jobs/${user}_job`, 'kept', '§9 job records are kept'],
    [`commons_forum_posts/${user}_post`, 'kept', '§4.7 public forum post'],
    [`archive_accounts_v1/${user}`, 'kept', '§9 paid PE Archive index'],
  ];
}

/** Records that belong to someone else and must never be touched by this person's deletion. */
const NOT_THEIRS: Array<[string, Record<string, unknown>]> = [
  ['devices/agent_box', { device_id: 'agent_box', owner_type: 'agent', owner_user_id: 'u1', status: 'active' }],
  ['solana_proven_addresses/SolAgent', { user_id: 'u1', owner_type: 'agent', agent_id: 'ag1' }],
  ['setup_tokens/agent_invite', { user_id: 'u1', type: 'agent_device_registration', used: false }],
];

function seedUser(fake: FakeFirestore, user: string): void {
  const hw = `hw_${user}`;
  const set = (key: string, value: Record<string, unknown>) => fake.store.set(key, value);
  set(`users/${user}`, { id: user, devices: [{ id: 'device_1' }], fcm_tokens: ['tok'] });
  set(`auth_secrets/${user}`, { secret: 's'.repeat(64), created_at: T0 });
  set(`user_preferences/${user}`, { notifications: { announcements: false } });
  set(`devices/${user}_mac`, { device_id: `${user}_mac`, owner_type: 'human', owner_user_id: user, owner_wallet_id: hw, status: 'active' });
  set(`service_installs/github_${user}`, { user_id: user, provider: 'github', installation_id: user, installed_at: T0, revoked_at: null });
  set(`setup_tokens/${user}_token`, { user_id: user, type: 'device_registration', used: false, expires_at: T0 });
  set(`human_proven_addresses/0x${user === 'u1' ? 'a1' : 'b2'}${'0'.repeat(38)}`, { user_id: user, wallet_id: hw });
  set(`solana_proven_addresses/Sol${user}`, { user_id: user, owner_type: 'human', wallet_id: hw });
  set(`app_output_keys_v1/${user}_key`, { owner_user_id: user, status: 'active' });
  set(`human_approval_requests_v1/${user}_req`, { human_user_id: user, action_description: 'pay the plumber' });
  set(`presentation_requests_v1/${user}_pres`, { human_user_id: user, note: 'private note' });
  set(`commons_message_keys/${hw}`, { pubkey_b64u: 'k', key_version: 1 });
  set(`commons_profiles/${hw}`, {
    wallet_id: hw, participant_type: 'human', status: 'active', display_name: 'Ana', bio: 'I fix bikes',
    location: { city: 'Oaxaca' }, skills: ['bikes'], forum_post_count: 3,
  });
  set(`commons_message_keys/${user}`, { pubkey_b64u: 'k2', key_version: 1 });
  set(`commons_profiles/${user}`, {
    wallet_id: user, participant_type: 'human', status: 'active', display_name: 'Ana', bio: 'I fix bikes',
    location: { city: 'Oaxaca' }, skills: ['bikes'], forum_post_count: 3,
  });
  set(`commons_published_pes/${user}_pub`, { published_by: hw });
  set(`${METER_ACT_KEYS_COLLECTION}/${user}_act_minted`, actKeyDocFor({
    peId: `${user}_act_minted`, userId: user, timestamp: T0, actionType: 'coding_session', mint_status: 'minted',
  }));
  set(`${METER_ACT_KEYS_COLLECTION}/${user}_act_unminted`, actKeyDocFor({
    peId: `${user}_act_unminted`, userId: user, timestamp: T0, actionType: 'coding_session', mint_status: 'eligible',
  }));
  set(`${METER_HELD_ACTS_COLLECTION}/${user}_held_done`, { actor_id: user, key: { row: { mint_status: 'record_only' } } });
  set(`${METER_HELD_ACTS_COLLECTION}/${user}_held_payee`, { actor_id: user, key: { row: { mint_status: 'eligible' } } });
  set(`${PE_MAILBOX_COLLECTION}/${user}_mail_in`, { to: `human:${user}`, from_actor: 'agent_x' });
  set(`${PE_MAILBOX_COLLECTION}/${user}_mail_out`, { to: 'human:other', from_actor: user });
  set(`${IDENTITY_ACTS_COLLECTION}/${user}_identity`, { actor_id: user });
  set(`${COUNTERPARTY_PAIRS_COLLECTION}/${user}_pair`, { actor_id: user });
  for (const [name, suffix] of [['agents', 'agent'], ['agent_sessions', 'session'], ['authorization_requests', 'auth_req'], ['transactions', 'tx']]) {
    set(`${name}/${user}_${suffix}`, { user_id: user });
  }
  set(`wallets/${hw}`, { id: hw, user_id: user, type: 'human', address: '0xabc' });
  set(`${METER_PENDING_CLAIMS_COLLECTION}/${user}_claim`, { actor_id: user, status: 'pending' });
  set(`actor_stats_v1/${user}`, { pe_count: 3 });
  set(`commons_human_jobs/${user}_job`, { poster_id: hw, status: 'completed' });
  set(`commons_forum_posts/${user}_post`, { author_wallet_id: hw, body_hash: 'h' });
  set(`archive_accounts_v1/${user}`, { wallet_id: hw });
}

/**
 * The fake's document snapshots carry no `ref` (real Firestore's do, and `leaveCommons` updates
 * through it); this view adds it so the REAL leave path runs against the fake.
 */
function withSnapshotRefs(fake: FakeFirestore): Firestore {
  return {
    ...fake,
    batch: () => fake.batch(),
    collection: (name: string) => {
      const col = fake.collection(name);
      return {
        ...col,
        where: col.where.bind(col),
        doc: (id: string) => {
          const ref = col.doc(id);
          return { ...ref, get: async () => ({ ...(await ref.get()), ref }) };
        },
      };
    },
  } as unknown as Firestore;
}

function depsFor(fake: FakeFirestore, log: { devices: string[]; auth: string[] } = { devices: [], auth: [] }): DeleteUserDataDeps {
  return {
    db: DB(fake),
    invalidateDeviceCache: async (_db, deviceId) => { log.devices.push(deviceId); },
    leaveCommons: (walletId) => leaveCommons({ db: withSnapshotRefs(fake) } as unknown as CommonsDeps, walletId),
    invalidateAuthSecret: async (userId) => { log.auth.push(userId); },
    endBeneficiaryLinks: async () => {},
    nowMs: () => T0 + 5,
  };
}

/** Every Policy class not in its expected end state, with its reason (an empty list is a pass). */
function violations(fake: FakeFirestore, user: string): string[] {
  const out: string[] = [];
  for (const [key, want, why] of policyClasses(user)) {
    const doc = fake.store.get(key) as Record<string, unknown> | undefined;
    const ok = want === 'gone' ? doc === undefined
      : want === 'kept' ? doc !== undefined
        : want === 'revoked' ? doc !== undefined && (doc.status === 'revoked' || typeof doc.revoked_at === 'number')
          : want === 'released' ? doc !== undefined && typeof doc.released_at_ms === 'number'
            : doc !== undefined && doc.status === 'inactive' && doc.display_name === '' && !('bio' in doc) && !('location' in doc) && !('skills' in doc);
    if (!ok) out.push(`${key} (${why}) is not ${want}`);
  }
  return out;
}

describe('deleteUserRelayData — the Privacy Policy\'s deletion, record class by record class', () => {
  it('erases an ordinary wallet observation with the account', async () => {
    const fake = createFakeFirestore();
    seedUser(fake, 'u1');
    const address = `0x${'a1'.repeat(20)}`;
    fake.store.set('wallets/hw_u1', { user_id: 'u1', type: 'human', address });
    const key = `${SESSION_COLLECTION}/${address}`;
    fake.store.set(key, { address, country: 'US', region: 'US-Texas', observed_at_ms: T0 });
    await deleteUserRelayData('u1', depsFor(fake, { devices: [], auth: [] }));
    expect(USER_RECORD_DISPOSITIONS[SESSION_COLLECTION]).toBe('compliance_retention');
    expect(fake.store.has(key)).toBe(false);
    expect(fake.store.has('users/u1')).toBe(false);
  });

  it('the seeded Policy classes cover every collection the module claims to delete, revoke or deactivate', () => {
    const seeded = new Set(policyClasses('u1').map(([key]) => key.split('/')[0]));
    const claimed = Object.entries(USER_RECORD_DISPOSITIONS).filter(([, d]) => d !== 'kept' && d !== 'compliance_retention').map(([name]) => name);
    expect(claimed.filter((name) => !seeded.has(name))).toEqual([]);
  });

  it('in-suite control: before deletion the checker reports every class that must change', () => {
    const fake = createFakeFirestore();
    seedUser(fake, 'u1');
    const changing = policyClasses('u1').filter(([, want]) => want !== 'kept').length;
    expect(changing).toBeGreaterThan(0);
    expect(violations(fake, 'u1').length).toBe(changing);
  });

  it('ends every class in its Policy state, never touches an agent\'s records, and touches no one else', async () => {
    const fake = createFakeFirestore();
    seedUser(fake, 'u1');
    seedUser(fake, 'u2');
    for (const [key, value] of NOT_THEIRS) fake.store.set(key, value);
    const log = { devices: [] as string[], auth: [] as string[] };

    const result = await deleteUserRelayData('u1', depsFor(fake, log));

    expect(violations(fake, 'u1')).toEqual([]);
    expect(result.revoked).toBe(2);
    expect(result.released_wallets).toBe(1);
    expect(result.deactivated_profiles).toBe(2); // the app's user-id-keyed profile and a wallet-keyed one
    // (a) the revoked computer's cached auth entries are dropped, so its next batch is refused.
    expect(log.devices).toEqual(['u1_mac']);
    expect(log.auth).toEqual(['u1']);
    // The published PE projections stay public, flagged by the existing leave path.
    expect(fake.store.get('commons_published_pes/u1_pub')).toMatchObject({ profile_inactive: true });
    for (const [key, value] of NOT_THEIRS) expect(fake.store.get(key)).toEqual(value);
    expect(violations(fake, 'u2').length).toBe(policyClasses('u2').filter(([, w]) => w !== 'kept').length);
  });

  it('a request that fails part-way is finished by sending it again (idempotent), with the auth record kept until then', async () => {
    const fake = createFakeFirestore();
    seedUser(fake, 'u1');
    const realBatch = fake.batch.bind(fake);
    let commits = 0;
    fake.batch = () => {
      const batch = realBatch();
      const commit = batch.commit.bind(batch);
      batch.commit = async () => {
        commits += 1;
        if (commits === 3) throw new Error('precondition failed (a concurrent batch)');
        return commit();
      };
      return batch;
    };
    await expect(deleteUserRelayData('u1', depsFor(fake))).rejects.toThrow('precondition failed');
    // Part of it is gone, and the person can still authenticate to send it again.
    expect(fake.store.has('human_proven_addresses/0xa1' + '0'.repeat(38))).toBe(false);
    expect(fake.store.has('auth_secrets/u1')).toBe(true);
    expect(fake.store.has('users/u1')).toBe(true);

    await deleteUserRelayData('u1', depsFor(fake));
    expect(violations(fake, 'u1')).toEqual([]);

    const third = await deleteUserRelayData('u1', depsFor(fake));
    expect(third.deleted).toBe(0);
    expect(third.revoked).toBe(0);
  });

  it('releases wallets before ending links, and keeps authentication until every unlink finishes', async () => {
    const fake = createFakeFirestore();
    seedUser(fake, 'u1');
    const deps = depsFor(fake);
    const end = jest.fn(async (userId: string): Promise<void> => {
      expect(userId).toBe('u1');
      expect(fake.store.get('wallets/hw_u1')).toHaveProperty('released_at_ms');
      expect(fake.store.has('users/u1')).toBe(true);
      expect(fake.store.has('auth_secrets/u1')).toBe(true);
      throw new Error('unlink transaction unavailable');
    });
    await expect(deleteUserRelayData('u1', { ...deps, endBeneficiaryLinks: end }))
      .rejects.toThrow('unlink transaction unavailable');
    expect(end).toHaveBeenCalledTimes(1); // RED: omitting link ending must fail.
    expect(fake.store.has('auth_secrets/u1')).toBe(true);
    end.mockImplementation(async () => {});
    await deleteUserRelayData('u1', { ...deps, endBeneficiaryLinks: end });
    expect(end).toHaveBeenCalledTimes(2);
    expect(fake.store.has('auth_secrets/u1')).toBe(false);
  });

  it('pages past the 500-write batch limit (a person with many legacy records)', async () => {
    const fake = createFakeFirestore();
    seedUser(fake, 'u1');
    for (let i = 0; i < 1100; i += 1) fake.store.set(`transactions/u1_bulk_${String(i).padStart(4, '0')}`, { user_id: 'u1' });
    let largestBatch = 0;
    const realBatch = fake.batch.bind(fake);
    fake.batch = () => {
      const batch = realBatch();
      let writes = 0;
      const del = batch.delete.bind(batch);
      const upd = batch.update.bind(batch);
      batch.delete = (ref) => { writes += 1; largestBatch = Math.max(largestBatch, writes); del(ref); };
      batch.update = (ref, data, pre) => { writes += 1; largestBatch = Math.max(largestBatch, writes); upd(ref, data, pre); };
      return batch;
    };
    await deleteUserRelayData('u1', depsFor(fake));
    expect(violations(fake, 'u1')).toEqual([]);
    expect([...fake.store.keys()].filter((k) => k.startsWith('transactions/u1_'))).toEqual([]);
    expect(largestBatch).toBeGreaterThan(0);
    expect(largestBatch).toBeLessThanOrEqual(500);
  });
});
