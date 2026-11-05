/**
 * SINGLE-USE LINK / UNLINK / SHARE-CHANGE SIGNATURES.
 *
 * The three owner-state writes an agent carries a human's consent for — `POST /link-human`,
 * `POST /unlink-human`, `PUT /link-human` (share change) — each verify the linked human's EIP-191
 * `personal_sign` over a stable-stringified payload. Before that payload was
 * `{action, agent_wallet_id, human_wallet_id, [operational_reserve_bps], timestamp}` with a ±5 min
 * window and nothing else, so inside the window the SAME signature could be replayed: re-link after
 * the human unlinked, revert a share change, or apply an old unlink after a relink.
 *
 * Two guards, both inside the same Firestore transaction as the bind / unbind / share write:
 *
 * 1. LINK EPOCH. The payload now names `link_epoch` = the agent's beneficiary-relationship
 * `revision` (read at `GET /v1/agent/wallet/:wallet_id/link-epoch`). Every link, unlink and
 * share change increments that revision in the same transaction that writes it
 * (`link-human-binding.ts`), and the transaction refuses a relationship that moved since it was
 * read. So a signature made before ANY later state change names a stale epoch and can never
 * apply (`link_epoch_stale`). This is the compare-and-increment.
 * 2. CONSUMED RECORD. A `beneficiary_link_signature_consumptions/{sha256(canonical payload)}` doc is
 * created in the transaction; one that already exists refuses (`link_signature_already_used`).
 * Keyed on the signed PAYLOAD (not the signature bytes), so a malleated second signature over the
 * same payload is the same consumption. It covers the one transition the epoch does not move — a
 * share "change" to the share already in force (a no-op that writes nothing else).
 *
 * A payload without `link_epoch` (every pre- signature) is refused: an epoch-less signature
 * cannot be made single-use against a LATER state change, only against its own replay.
 *
 * The payload keeps the keys `action` / `agent_wallet_id` / `human_wallet_id` the app's WalletConnect
 * guard refuses any dApp `personal_sign` request that parses as JSON with those keys, so no external
 * dApp can obtain one of these signatures from the human.
 */
import { createHash } from 'crypto';
import stableStringify from 'json-stable-stringify';
import type { Firestore, Transaction } from 'firebase-admin/firestore';

export const LINK_SIGNATURE_CONSUMPTIONS_COLLECTION = 'beneficiary_link_signature_consumptions';

export type LinkSignatureAction = 'link_agent' | 'unlink_agent' | 'update_beneficiary_share';

export interface LinkSignaturePayload {
  action: LinkSignatureAction;
  agent_wallet_id: string;
  human_wallet_id: string;
  /** The relationship revision the human consents to move FROM (`GET /:wallet_id/link-epoch`). */
  link_epoch: number;
  /** Share changes only: the exact agent share the human consents to. */
  operational_reserve_bps?: number;
  timestamp: number;
}

/** The exact string the human signs (sorted keys, `json-stable-stringify`, byte-equal to the SDK). */
export function canonicalLinkSignaturePayload(payload: LinkSignaturePayload): string {
  return stableStringify(payload) || '';
}

/** `link_epoch` from a request body: a positive safe integer, else null (→ 400). */
export function parseLinkEpoch(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 1 ? raw : null;
}

export interface LinkSignatureAuthorization {
  action: LinkSignatureAction;
  walletId: string;
  linkEpoch: number;
  /** sha256 (hex) of the canonical signed payload — the consumption key. */
  payloadSha256: string;
  /** sha256 (hex) of the signature as submitted — audit only. */
  signatureSha256: string;
}

const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** Build the single-use authorization for a VERIFIED signature (the caller has already recovered the signer). */
export function linkSignatureAuthorization(
  payload: LinkSignaturePayload,
  signature: string,
): LinkSignatureAuthorization {
  return {
    action: payload.action,
    walletId: payload.agent_wallet_id,
    linkEpoch: payload.link_epoch,
    payloadSha256: sha256Hex(canonicalLinkSignaturePayload(payload)),
    signatureSha256: sha256Hex(signature.toLowerCase()),
  };
}

export type LinkSignatureRefusal = 'link_signature_already_used' | 'link_epoch_stale';

export class LinkSignatureRefusedError extends Error {
  constructor(readonly code: LinkSignatureRefusal) {
    super(code);
    this.name = 'LinkSignatureRefusedError';
  }
}

/** The signature authorizes a transition FROM exactly this relationship revision. */
export function assertLinkEpochCurrent(auth: LinkSignatureAuthorization, relationshipRevision: number): void {
  if (auth.linkEpoch !== relationshipRevision) throw new LinkSignatureRefusedError('link_epoch_stale');
}

export function linkSignatureConsumptionRef(db: Firestore, auth: LinkSignatureAuthorization) {
  return db.collection(LINK_SIGNATURE_CONSUMPTIONS_COLLECTION).doc(auth.payloadSha256);
}

/** Transaction READ: refuse a payload already consumed. Call before any transaction write. */
export async function assertLinkSignatureUnconsumed(
  db: Firestore,
  txn: Transaction,
  auth: LinkSignatureAuthorization,
): Promise<void> {
  const snap = await txn.get(linkSignatureConsumptionRef(db, auth));
  if (snap.exists) throw new LinkSignatureRefusedError('link_signature_already_used');
}

/** Transaction WRITE: consume the payload, in the same transaction as the state change it authorized. */
export function recordLinkSignatureConsumption(
  db: Firestore,
  txn: Transaction,
  auth: LinkSignatureAuthorization,
  outcome: { peId: string | null; nowMs: number },
): void {
  txn.create(linkSignatureConsumptionRef(db, auth), {
    action: auth.action,
    wallet_id: auth.walletId,
    link_epoch: auth.linkEpoch,
    payload_sha256: auth.payloadSha256,
    signature_sha256: auth.signatureSha256,
    pe_id: outcome.peId,
    consumed_at_ms: outcome.nowMs,
  });
}
