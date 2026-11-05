/**
 * PER-WALLET MESSAGE KEYS (threads — the E2E half).
 *
 * A thread message's content is END-TO-END ciphertext the relay cannot read: the sender seals the
 * plaintext to each party's published x25519 MESSAGE KEY with the sealed-box format the
 * agent-recovery escrow already ships (`provian-agent-sdk/src/agent-key-recovery.ts` ≡
 * `src/core/security/agentKeyRecovery.ts` x25519 + HKDF-SHA256 + XChaCha20-Poly1305, version
 * 0x01, AAD = version || recipient pubkey). This module only PUBLISHES and READS the public halves.
 *
 * Keys are deterministic and recoverable on the client side (the Promises pattern): an agent
 * derives its message key from its wallet key (`HKDF(wallet_priv, 'provian.thread.msgkey.v1')`) and
 * re-publishes on rotation; a human derives it from the wallet seed. The relay never sees a secret
 * half. Reading a party's key requires ANY authenticated wallet (agent key / wallet auth); nothing
 * about a key is Tier-3, but an anonymous enumeration of the network's keys is not a surface.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { ValidationError } from '../agent-bank/errors';
import { COMMONS_COLLECTIONS } from './types';
import type { PartyRef } from './speech-window';

/** 32 bytes base64url, no padding → exactly 43 chars. */
const PUBKEY_B64U_RE = /^[A-Za-z0-9_-]{43}$/;

export interface MessageKeyRecord {
  party_id: string;
  kind: 'agent' | 'human';
  /** The x25519 public key, base64url (32 bytes). */
  pubkey_b64u: string;
  /** Monotonic per party; a re-publication bumps it. */
  key_version: number;
  published_at: number;
}

export function isMessagePubkey(raw: unknown): raw is string {
  return typeof raw === 'string' && PUBKEY_B64U_RE.test(raw);
}

/** Publish (or re-publish) a party's own message key. Idempotent on the same key. */
export async function publishMessageKey(
  db: Firestore,
  party: PartyRef,
  pubkeyB64u: unknown,
  nowMs: number = Date.now(),
): Promise<MessageKeyRecord> {
  if (!isMessagePubkey(pubkeyB64u)) {
    throw new ValidationError('pubkey must be a 32-byte x25519 public key, base64url (43 chars)');
  }
  const ref = db.collection(COMMONS_COLLECTIONS.MESSAGE_KEYS).doc(party.id);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const prior = snap.exists ? (snap.data() as MessageKeyRecord) : null;
    if (prior && prior.pubkey_b64u === pubkeyB64u) return prior;
    const record: MessageKeyRecord = {
      party_id: party.id,
      kind: party.kind,
      pubkey_b64u: pubkeyB64u,
      key_version: (prior?.key_version ?? 0) + 1,
      published_at: nowMs,
    };
    txn.set(ref, record);
    return record;
  });
}

export async function readMessageKey(db: Firestore, partyId: string): Promise<MessageKeyRecord | null> {
  if (!partyId) return null;
  const snap = await db.collection(COMMONS_COLLECTIONS.MESSAGE_KEYS).doc(partyId).get();
  if (snap.exists) return snap.data() as MessageKeyRecord;
  // A person publishes under their Commons party id — their `user_id` (`partyRefOf`) — while the
  // PE meter (sealing, seal targets, the migration hand-back) and the app name them by their
  // `wallets/{doc}` id. That doc belongs to exactly one `user_id`, so its key is that user's key.
  // Found live 2026-10-04: the operator’s key sat under `user_…` and nothing could be sealed to him.
  if (isHumanWalletDocId(partyId)) {
    const wallet = await db.collection('wallets').doc(partyId).get();
    const userId = wallet.exists ? wallet.data()?.user_id : null;
    if (typeof userId === 'string' && userId.length > 0 && userId !== partyId) {
      const byUser = await db.collection(COMMONS_COLLECTIONS.MESSAGE_KEYS).doc(userId).get();
      if (byUser.exists) return byUser.data() as MessageKeyRecord;
    }
  }
  return null;
}

/** A person's first-party `wallets/{doc}` id (agents' wallets are `wallet_aw_…`). */
function isHumanWalletDocId(id: string): boolean {
  return id.startsWith('wallet_') && !id.startsWith('wallet_aw_');
}

/** Both parties' keys, or the ids of the parties that have not published one. */
export async function readPartyKeys(
  db: Firestore,
  partyIds: readonly string[],
): Promise<{ keys: Record<string, MessageKeyRecord>; missing: string[] }> {
  const rows = await Promise.all(partyIds.map((id) => readMessageKey(db, id)));
  const keys: Record<string, MessageKeyRecord> = {};
  const missing: string[] = [];
  rows.forEach((r, i) => { if (r) keys[partyIds[i]] = r; else missing.push(partyIds[i]); });
  return { keys, missing };
}
