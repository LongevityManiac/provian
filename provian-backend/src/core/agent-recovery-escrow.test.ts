import { describe, it, expect } from '@jest/globals';
import * as escrowModule from './agent-recovery-escrow';
import {
  isValidAnchorPubkeyB64u,
  isValidSealedKeyBlobB64u,
  storeRecoveryEscrow,
  readRecoveryEscrow,
  AGENT_RECOVERY_ESCROW_COLLECTION,
} from './agent-recovery-escrow';

/**
 * REAL cross-package vector — an x25519 anchor pubkey and a sealed blob actually
 * produced by the SDK sealed box (provian-agent-sdk/src/agent-key-recovery). If
 * the backend's shape validators drift from what the SDK emits, the two-touch
 * flow silently fails to escrow a recoverable key — so bind to a real artifact,
 * not a hand-built fixture.
 */
const REAL_ANCHOR_PUBKEY = 'E75P6uryBMf9M1j8nAByGIHRdCeBKCJ-xnTzf3_pe20';
const REAL_SEALED_BLOB =
  'AVfbSzWfI65eFG5OJRIFZwRyJQY0jBUMFHU9DJM9BNQhr_-CnW3w_T1hMIEMszdx7ur6VXxHlGpe0hY1CLWOQI3aTC8ivRgEzEvVwrzoN7wSOllRsPo';

function makeFakeDb() {
  const store = new Map<string, Record<string, unknown>>();
  const db = {
    collection(name: string) {
      return {
        doc(id: string) {
          const key = `${name}/${id}`;
          return {
            async get() {
              const data = store.get(key);
              return { exists: data !== undefined, data: () => data };
            },
            async set(record: Record<string, unknown>) {
              store.set(key, record);
            },
          };
        },
      };
    },
  };
  return { db: db as never, store };
}

describe('agent-recovery-escrow validators', () => {
  it('accepts a REAL SDK-produced anchor pubkey', () => {
    expect(isValidAnchorPubkeyB64u(REAL_ANCHOR_PUBKEY)).toBe(true);
  });

  it('accepts a REAL SDK-produced sealed blob', () => {
    expect(isValidSealedKeyBlobB64u(REAL_SEALED_BLOB)).toBe(true);
  });

  it('rejects an anchor pubkey of the wrong byte length', () => {
    expect(isValidAnchorPubkeyB64u(Buffer.alloc(31).toString('base64url'))).toBe(false);
    expect(isValidAnchorPubkeyB64u(Buffer.alloc(33).toString('base64url'))).toBe(false);
  });

  it('rejects non-base64url / empty / non-string anchor pubkeys', () => {
    for (const v of ['', 'not base64!!', '****', null, undefined, 42, {}]) {
      expect(isValidAnchorPubkeyB64u(v as unknown)).toBe(false);
    }
  });

  it('RED CONTROL: a blob with the wrong version byte is rejected', () => {
    const bytes = Buffer.from(REAL_SEALED_BLOB, 'base64url');
    const bad = Buffer.from(bytes);
    bad[0] = 0x02; // unsupported version
    expect(isValidSealedKeyBlobB64u(bad.toString('base64url'))).toBe(false);
    // non-vacuous: the untouched blob still validates
    expect(isValidSealedKeyBlobB64u(REAL_SEALED_BLOB)).toBe(true);
  });

  it('rejects a blob shorter than the minimum and larger than the ceiling', () => {
    expect(isValidSealedKeyBlobB64u(Buffer.alloc(10).toString('base64url'))).toBe(false);
    const huge = Buffer.alloc(5000);
    huge[0] = 0x01;
    expect(isValidSealedKeyBlobB64u(huge.toString('base64url'))).toBe(false);
  });

  it('STRUCTURAL: the module exposes no decrypt/open/unseal path (relay never decrypts)', () => {
    const names = Object.keys(escrowModule);
    expect(names.some((n) => /decrypt|unseal|\bopen\b/i.test(n))).toBe(false);
  });
});

describe('agent-recovery-escrow storage', () => {
  it('stores and reads back an escrow (ciphertext only)', async () => {
    const { db, store } = makeFakeDb();
    await storeRecoveryEscrow(db, 'wallet_aw_1', {
      sealed_key_blob: REAL_SEALED_BLOB,
      recovery_anchor_pubkey: REAL_ANCHOR_PUBKEY,
      now: 1000,
    });
    // stored under the right collection
    expect(store.has(`${AGENT_RECOVERY_ESCROW_COLLECTION}/wallet_aw_1`)).toBe(true);
    const rec = await readRecoveryEscrow(db, 'wallet_aw_1');
    expect(rec).not.toBeNull();
    expect(rec!.sealed_key_blob).toBe(REAL_SEALED_BLOB);
    expect(rec!.recovery_anchor_pubkey).toBe(REAL_ANCHOR_PUBKEY);
    expect(rec!.blob_version).toBe(1);
    expect(rec!.created_at).toBe(1000);
  });

  it('re-escrow overwrites the blob but preserves the original created_at', async () => {
    const { db } = makeFakeDb();
    await storeRecoveryEscrow(db, 'wallet_aw_2', {
      sealed_key_blob: REAL_SEALED_BLOB, recovery_anchor_pubkey: REAL_ANCHOR_PUBKEY, now: 1000,
    });
    await storeRecoveryEscrow(db, 'wallet_aw_2', {
      sealed_key_blob: REAL_SEALED_BLOB, recovery_anchor_pubkey: REAL_ANCHOR_PUBKEY, now: 2000,
    });
    const rec = await readRecoveryEscrow(db, 'wallet_aw_2');
    expect(rec!.created_at).toBe(1000);
    expect(rec!.updated_at).toBe(2000);
  });

  it('returns null when no escrow exists', async () => {
    const { db } = makeFakeDb();
    expect(await readRecoveryEscrow(db, 'wallet_aw_missing')).toBeNull();
  });
});

describe('listAgentRecoveryAlertsForHuman ', () => {
  it('surfaces active-alarm and escrow-missing linked agents; excludes recovered + other humans (RED controls)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createFakeFirestore } = require('./pvt/__test-helpers__/fake-firestore');
    const fs = createFakeFirestore();
    const HUMAN = 'user_frank';
    const link = (id: string, extra: Record<string, unknown> = {}) =>
      fs.store.set(`agent_wallets/${id}`, { linked_human_user_id: HUMAN, status: 'active', display_name: id, ...extra });

    // A: active at-rest-secret alarm → alerts with the alarm's reason.
    link('aw_A');
    fs.store.set('agent_recovery_alarms/aw_A', { wallet_id: 'aw_A', reason: 'at_rest_secret_missing', resolved: false, first_seen_at: 1, last_seen_at: 1 });
    // B: no alarm, no escrow → escrow_missing.
    link('aw_B');
    // C: no alarm, HAS escrow → no alert.
    link('aw_C');
    fs.store.set('agent_recovery_escrows/aw_C', { wallet_id: 'aw_C', sealed_key_blob: 'x', anchor_pubkey: 'y' });
    // D: RESOLVED alarm + no escrow → falls through to escrow_missing.
    link('aw_D');
    fs.store.set('agent_recovery_alarms/aw_D', { wallet_id: 'aw_D', reason: 'at_rest_secret_missing', resolved: true, first_seen_at: 1, last_seen_at: 1 });
    // E: another human's agent with an active alarm → MUST be excluded (RED control for the ownership filter).
    fs.store.set('agent_wallets/aw_E', { linked_human_user_id: 'user_someone_else', status: 'active', display_name: 'aw_E' });
    fs.store.set('agent_recovery_alarms/aw_E', { wallet_id: 'aw_E', reason: 'at_rest_secret_missing', resolved: false, first_seen_at: 1, last_seen_at: 1 });

    const alerts = await escrowModule.listAgentRecoveryAlertsForHuman(fs as never, HUMAN);
    const byId = Object.fromEntries(alerts.map((a) => [a.agent_wallet_id, a.reason]));
    expect(byId['aw_A']).toBe('at_rest_secret_missing');
    expect(byId['aw_B']).toBe('escrow_missing');
    expect(byId['aw_C']).toBeUndefined();       // has escrow, no alarm → not an alert
    expect(byId['aw_D']).toBe('escrow_missing'); // resolved alarm falls through to escrow check
    expect(byId['aw_E']).toBeUndefined();        // RED control: another human's agent excluded
    expect(alerts.length).toBe(3);
  });
});
