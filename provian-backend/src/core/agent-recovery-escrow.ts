/**
 * agent-recovery-escrow — the relay's HALF of the non-custodial agent-key
 * recovery, and the reason it stays non-custodial.
 *
 * In the two-touch onboarding the inviting human's phone mints an x25519 anchor
 * keypair at "Invite an agent"; its PUBLIC half rides the connection code. The
 * agent seals a copy of its own secp256k1 wallet key to that public key (SDK:
 * sealToAnchor) and escrows the resulting OPAQUE ciphertext here. When an agent
 * machine dies, the human's phone reads the ciphertext back and opens it with
 * the anchor secret that never left the phone.
 *
 * ── THE INVARIANT THIS MODULE EXISTS TO MAKE OBVIOUS ─────────────────────────
 * The relay stores CIPHERTEXT ONLY and can never read it. This module imports
 * NO crypto and holds NO key: it validates that the inputs are well-formed
 * base64url of a plausible size, then stores/reads them as opaque strings. There
 * is deliberately no decrypt path anywhere on the server. If a future change
 * needs the relay to read this material, that is a custody change — STOP and
 * report it, do not add a decrypt here.
 */

import type { Firestore } from 'firebase-admin/firestore';

export const AGENT_RECOVERY_ESCROW_COLLECTION = 'agent_recovery_escrows';

/** Wire version of the sealed blob (must match the SDK/mobile sealed-box). */
export const RECOVERY_BLOB_VERSION = 0x01;

/** An x25519 public key is 32 bytes → 43 base64url(no-pad) chars. */
const ANCHOR_PUBKEY_BYTES = 32;
/** Sealed blob = version(1) + ephemeral x25519 pub(32) + AEAD ciphertext(≥17). */
const SEALED_BLOB_MIN_BYTES = 1 + 32 + 16 + 1;
/** Generous ceiling; a sealed 32-byte key is ~81 bytes. The relay never parses it. */
const SEALED_BLOB_MAX_BYTES = 4096;

const B64URL_NO_PAD = /^[A-Za-z0-9_-]+$/;

function decodeB64u(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || !B64URL_NO_PAD.test(value)) {
    return null;
  }
  // Node's 'base64url' decoder is lenient about padding; the charset regex above
  // is what actually rejects malformed input.
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    return null;
  }
}

/** True iff `value` is a base64url string decoding to exactly a 32-byte key. */
export function isValidAnchorPubkeyB64u(value: unknown): value is string {
  const bytes = decodeB64u(value);
  return bytes !== null && bytes.length === ANCHOR_PUBKEY_BYTES;
}

/**
 * True iff `value` is a base64url sealed blob of plausible size whose first byte
 * is the supported version. The relay validates shape only — it never opens it.
 */
export function isValidSealedKeyBlobB64u(value: unknown): value is string {
  const bytes = decodeB64u(value);
  if (bytes === null) return false;
  if (bytes.length < SEALED_BLOB_MIN_BYTES || bytes.length > SEALED_BLOB_MAX_BYTES) return false;
  return bytes[0] === RECOVERY_BLOB_VERSION;
}

export interface RecoveryEscrowRecord {
  wallet_id: string;
  /** Opaque ciphertext (base64url). The relay cannot read this. */
  sealed_key_blob: string;
  /** The phone anchor public key the blob was sealed to (base64url). Public. */
  recovery_anchor_pubkey: string;
  blob_version: number;
  created_at: number;
  updated_at: number;
}

/**
 * Store (upsert) the sealed escrow for an agent wallet. Caller MUST have already
 * validated ownership and the two b64u inputs. One escrow per wallet; a re-escrow
 * (e.g. after key rotation) overwrites, preserving the original created_at.
 */
export async function storeRecoveryEscrow(
  db: Firestore,
  walletId: string,
  input: { sealed_key_blob: string; recovery_anchor_pubkey: string; now: number },
): Promise<void> {
  const ref = db.collection(AGENT_RECOVERY_ESCROW_COLLECTION).doc(walletId);
  const existing = await ref.get();
  const createdAt = existing.exists
    ? ((existing.data() as RecoveryEscrowRecord).created_at ?? input.now)
    : input.now;
  const record: RecoveryEscrowRecord = {
    wallet_id: walletId,
    sealed_key_blob: input.sealed_key_blob,
    recovery_anchor_pubkey: input.recovery_anchor_pubkey,
    blob_version: RECOVERY_BLOB_VERSION,
    created_at: createdAt,
    updated_at: input.now,
  };
  await ref.set(record);
}

/** Read the sealed escrow for a wallet, or null if none. Returns ciphertext only. */
export async function readRecoveryEscrow(
  db: Firestore,
  walletId: string,
): Promise<RecoveryEscrowRecord | null> {
  const snap = await db.collection(AGENT_RECOVERY_ESCROW_COLLECTION).doc(walletId).get();
  if (!snap.exists) return null;
  return snap.data() as RecoveryEscrowRecord;
}

/**
 * True iff a recoverable escrow exists for this wallet. Never opens the blob. No settlement or
 * payout path reads this: escrow never holds earnings (; the mint gate is
 * retired, pinned by `pvt/wp4/escrow-never-holds-earnings.test.ts`).
 */
export async function hasRecoveryEscrow(db: Firestore, walletId: string): Promise<boolean> {
  const snap = await db.collection(AGENT_RECOVERY_ESCROW_COLLECTION).doc(walletId).get();
  return snap.exists;
}

/**
 * Delete a wallet's recovery escrow. Called after a NORMAL dual-PoP rotation
 * (fail-safe): the old key is retired, so an escrow sealed to it now
 * recovers a key for a retired address — worse than no escrow. Deleting it leaves
 * the agent un-escrowed (surfaced by the Command Center recovery view and, for a
 * post-invariant agent, held by the settlement gate) rather than stale-recoverable.
 * The recovery re-key path re-escrows in the same handler instead of deleting.
 */
export async function deleteRecoveryEscrow(db: Firestore, walletId: string): Promise<void> {
  await db.collection(AGENT_RECOVERY_ESCROW_COLLECTION).doc(walletId).delete();
}

// ---------------------------------------------------------------------------
// Recovery alarm — the daemon reports here when it finds its wallet
// keystore present but its at-rest secret ABSENT (or non-decrypting): the key
// is locally unusable and, absent an escrow, unrecoverable — exactly Atlas's
// failure. This is a LOUD, durable signal the Command Center surfaces; the
// daemon also refuses to start earning. It carries NO secret and NO key
// material — only the fact, the reason, and a timestamp.
// ---------------------------------------------------------------------------

export const AGENT_RECOVERY_ALARM_COLLECTION = 'agent_recovery_alarms';

export type RecoveryAlarmReason =
  | 'at_rest_secret_missing'
  | 'at_rest_secret_nondecrypting'
  | 'keystore_missing';

export interface RecoveryAlarmRecord {
  wallet_id: string;
  reason: RecoveryAlarmReason;
  /** Free-form host label (hostname); never a path, secret, or key. */
  host?: string;
  first_seen_at: number;
  last_seen_at: number;
  /** Cleared to true once the agent is recoverable again (re-key / re-escrow / restore). */
  resolved: boolean;
  /** When the alarm auto-cleared (the daemon reported healthy again). Absent while active. */
  resolved_at?: number;
}

const ALARM_REASONS = new Set<RecoveryAlarmReason>([
  'at_rest_secret_missing',
  'at_rest_secret_nondecrypting',
  'keystore_missing',
]);

export function isValidRecoveryAlarmReason(value: unknown): value is RecoveryAlarmReason {
  return typeof value === 'string' && ALARM_REASONS.has(value as RecoveryAlarmReason);
}

/** Raise (upsert) a recovery alarm for a wallet. Preserves first_seen_at across repeats. */
export async function raiseRecoveryAlarm(
  db: Firestore,
  walletId: string,
  input: { reason: RecoveryAlarmReason; host?: string; now: number },
): Promise<void> {
  const ref = db.collection(AGENT_RECOVERY_ALARM_COLLECTION).doc(walletId);
  const existing = await ref.get();
  const firstSeen = existing.exists
    ? ((existing.data() as RecoveryAlarmRecord).first_seen_at ?? input.now)
    : input.now;
  const record: RecoveryAlarmRecord = {
    wallet_id: walletId,
    reason: input.reason,
    ...(input.host ? { host: input.host } : {}),
    first_seen_at: firstSeen,
    last_seen_at: input.now,
    resolved: false,
  };
  await ref.set(record);
}

/**
 * Clear (resolve) a recovery alarm once the daemon reports healthy again. Idempotent:
 * a no-op when no alarm doc exists or it is already resolved, so the daemon can post "healthy" on
 * every start without needless writes. The Command Center collector counts only `resolved !== true`,
 * so this auto-clears the alarm from ops with no manual intervention. Returns whether a write happened.
 */
export async function clearRecoveryAlarm(
  db: Firestore,
  walletId: string,
  input: { now: number } = { now: Date.now() },
): Promise<boolean> {
  const ref = db.collection(AGENT_RECOVERY_ALARM_COLLECTION).doc(walletId);
  const existing = await ref.get();
  if (!existing.exists) return false;
  const data = existing.data() as RecoveryAlarmRecord;
  if (data.resolved === true) return false;
  await ref.set({ resolved: true, resolved_at: input.now, last_seen_at: input.now }, { merge: true });
  return true;
}

/** A linked agent needing the human's recovery attention, for the app's attention center. */
export interface HumanRecoveryAlert {
  agent_wallet_id: string;
  agent_name: string;
  reason: RecoveryAlarmReason | 'escrow_missing';
}

/**
 * The recovery alerts to surface to THIS human across their linked agents. An agent shows
 * up when its daemon has raised an UNRESOLVED at-rest-secret alarm (the sharp signal, reason from
 * the alarm) OR — absent an alarm — when it has no recovery escrow at all (Atlas's exact case: the
 * key can never be recovered, only re-keyed → reason `escrow_missing`). One alert per agent; the
 * alarm reason wins over escrow_missing. Fan-out is bounded by the human's linked-agent count.
 */
export async function listAgentRecoveryAlertsForHuman(
  db: Firestore,
  humanUserId: string,
): Promise<HumanRecoveryAlert[]> {
  const linked = await db.collection('agent_wallets')
    .where('linked_human_user_id', '==', humanUserId)
    .where('status', '==', 'active')
    .get();
  const alerts: HumanRecoveryAlert[] = [];
  for (const doc of linked.docs) {
    const w = doc.data();
    const walletId = doc.id;
    const name = typeof w.display_name === 'string' && w.display_name.length > 0 ? w.display_name : walletId;
    const alarmSnap = await db.collection(AGENT_RECOVERY_ALARM_COLLECTION).doc(walletId).get();
    if (alarmSnap.exists) {
      const alarm = alarmSnap.data() as RecoveryAlarmRecord;
      if (alarm.resolved !== true && isValidRecoveryAlarmReason(alarm.reason)) {
        alerts.push({ agent_wallet_id: walletId, agent_name: name, reason: alarm.reason });
        continue;
      }
    }
    // No active alarm — an agent with no escrow is unrecoverable and needs a re-key.
    if (!(await hasRecoveryEscrow(db, walletId))) {
      alerts.push({ agent_wallet_id: walletId, agent_name: name, reason: 'escrow_missing' });
    }
  }
  return alerts;
}
