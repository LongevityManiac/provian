

import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { generateConnectionToken, isValidConnectionTokenFormat } from '../connection-token-format';
import { AGENT_BENEFICIARY_RELATIONSHIP_COLLECTION } from './beneficiary-relationship';
import { readHumanRecoveryAnchor } from '../human-recovery-anchor';

/** A link code lives one hour ("link codes expire in an hour"), human- or agent-issued. */
export const FLEET_CODE_TTL_MS = 60 * 60 * 1000;

/** Per issuing wallet. A transport limit, not an economic gate. */
export const FLEET_CODE_HOURLY_LIMIT = 30;

export type ConnectionTokenKind = 'human' | 'fleet';

/** What request-link needs to know about a connection code. */
export interface ConnectionTokenRecord {
  issuerUserId: string;
  /** null = unknown → treated as expired (fail closed). */
  expiresAt: number | null;
  kind: ConnectionTokenKind;
  /** The linked agent that minted a fleet code; null for a human code. */
  issuedByAgentWalletId: string | null;
  used: boolean;
  usedByWalletId: string | null;
  /**
   * review 2 #5: the bind this code's consume led to has COMMITTED. Set
   * false at the consume and true inside the bind's own transaction
   * (`bindAgentToHuman` with `fleet`), so "consumed but not bound" a bind that
   * failed after the consume — is distinguishable from "bound, and the link
   * since ended". Absent on a code consumed before the field existed (treated
   * as not completed; the in-transaction never-linked check still refuses a
   * re-link of an agent that was ever linked).
   */
  bindCompleted: boolean;
}

interface ConnectionTokenReadDeps {
  db: Firestore;
  cache: {
    getConnectionToken(token: string): Promise<{ user_id?: unknown; expires_at?: unknown } | null>;
  };
}

const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const finiteMs = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Resolve a connection code to its record. Read-only: never burns, never writes.
 * Cache-first for a HUMAN code (the 30 s write-through entry the in-app mint
 * leaves, which carries the issuer and expiry); Firestore otherwise. A fleet code
 * is never cached, so its kind and single-use state always come from Firestore.
 * Returns null for an absent or malformed code.
 */
export async function resolveConnectionTokenRecord(
  deps: ConnectionTokenReadDeps,
  token: string,
): Promise<ConnectionTokenRecord | null> {
  if (!isValidConnectionTokenFormat(token)) return null;
  try {
    const cached = await deps.cache.getConnectionToken(token);
    const cachedUser = cached ? nonEmpty(cached.user_id) : null;
    const cachedExpiry = cached ? finiteMs(cached.expires_at) : null;
    if (cachedUser !== null && cachedExpiry !== null) {
      return {
        issuerUserId: cachedUser, expiresAt: cachedExpiry, kind: 'human',
        issuedByAgentWalletId: null, used: false, usedByWalletId: null, bindCompleted: false,
      };
    }
  } catch {
    // Redis down — fall through to Firestore, do not fail the request.
  }
  const snap = await deps.db.collection('connection_tokens').doc(token).get();
  if (!snap.exists) return null;
  const data = (snap.data() ?? {}) as Record<string, unknown>;
  const issuerUserId = nonEmpty(data.user_id);
  if (issuerUserId === null) return null;
  const kind: ConnectionTokenKind = data.kind === 'fleet' ? 'fleet' : 'human';
  return {
    issuerUserId,
    expiresAt: finiteMs(data.expires_at),
    kind,
    issuedByAgentWalletId: kind === 'fleet' ? nonEmpty(data.issued_by_agent_wallet_id) : null,
    used: data.used === true,
    usedByWalletId: nonEmpty(data.used_by_wallet_id),
    bindCompleted: data.bind_completed === true,
  };
}

/** The Firestore ref of a connection code (human or fleet). */
export function connectionTokenRef(db: Firestore, code: string) {
  return db.collection('connection_tokens').doc(code);
}

/** Expired at or after `expiresAt`; an unknown expiry is expired (Unknown = Block). */
export function isConnectionTokenExpired(record: Pick<ConnectionTokenRecord, 'expiresAt'>, nowMs: number): boolean {
  return record.expiresAt === null || nowMs >= record.expiresAt;
}

/**
 * A fleet code takes its authority from the agent that issued it, which must still be
 * active and linked to the code's human. A code dies with the link that minted it.
 */
export function isFleetIssuerLinked(
  issuer: { status?: unknown; linked_human_user_id?: unknown } | null,
  humanUserId: string,
): boolean {
  return issuer !== null && issuer.status === 'active' && issuer.linked_human_user_id === humanUserId;
}

export type ConnectionCodeStanding = 'live' | 'unknown' | 'used' | 'expired' | 'issuer_not_linked';

/**
 * Where a connection code stands for an install, before any wallet exists. Read-only: it
 * never burns a code. request-link stays the authority once a wallet exists, because it
 * knows which agent is asking.
 */
export async function readConnectionCodeStanding(
  deps: ConnectionTokenReadDeps,
  token: string,
  nowMs: number,
): Promise<ConnectionCodeStanding> {
  const record = await resolveConnectionTokenRecord(deps, token);
  if (!record) return 'unknown';
  if (record.kind === 'fleet' && record.used) return 'used';
  if (isConnectionTokenExpired(record, nowMs)) return 'expired';
  if (record.kind === 'fleet') {
    const issuedBy = record.issuedByAgentWalletId;
    const issuerSnap = issuedBy ? await deps.db.collection('agent_wallets').doc(issuedBy).get() : null;
    const issuer = issuerSnap && issuerSnap.exists ? (issuerSnap.data() ?? {}) : null;
    if (!isFleetIssuerLinked(issuer, record.issuerUserId)) return 'issuer_not_linked';
  }
  return 'live';
}

/** The Firestore shape of a fleet code (a `connection_tokens` doc with kind 'fleet'). */
export interface FleetCodeDocument {
  token: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  used: false;
  kind: 'fleet';
  issued_by_agent_wallet_id: string;
  /** The human's published recovery anchor (public half), when they have published one. */
  recovery_anchor_pubkey?: string;
}

/**
 * Mint one fleet code for `humanUserId`, issued by `issuerWalletId`. Durable
 * first (request-link resolves it from Firestore); never written to the Redis
 * connection-token cache, so a cache hit is always a human code.
 */
export async function mintFleetCode(
  db: Firestore,
  params: { humanUserId: string; issuerWalletId: string; nowMs: number },
): Promise<{ code: string; expiresAt: number }> {
  const code = generateConnectionToken();
  const expiresAt = params.nowMs + FLEET_CODE_TTL_MS;
  const anchor = await readHumanRecoveryAnchor(db, params.humanUserId);
  const doc: FleetCodeDocument = {
    token: code,
    user_id: params.humanUserId,
    created_at: params.nowMs,
    expires_at: expiresAt,
    used: false,
    kind: 'fleet',
    issued_by_agent_wallet_id: params.issuerWalletId,
    ...(anchor !== null ? { recovery_anchor_pubkey: anchor } : {}),
  };
  await db.collection('connection_tokens').doc(code).set(doc);
  return { code, expiresAt };
}

export type FleetConsumeResult =
  | { ok: true; resumed: boolean; bindCompleted: boolean }
  | { ok: false; reason: 'not_found' | 'not_fleet' | 'issuer_mismatch' | 'expired' | 'already_used' };

/**
 * The single-use flip, inside a Firestore transaction (fresh read + conditional
 * write), so two agents racing one code cannot both link. The same agent
 * re-running after a partial failure RESUMES (its own prior consumption is not
 * "used by another"), which is what makes the link retry-safe; the result says
 * whether the bind that consume led to has committed (review 2 #5), so a bind
 * that failed after the consume is completed by the same agent's retry.
 */
export async function consumeFleetCodeTransactional(
  db: Firestore,
  params: { code: string; walletId: string; humanUserId: string; nowMs: number },
): Promise<FleetConsumeResult> {
  const ref = db.collection('connection_tokens').doc(params.code);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) return { ok: false, reason: 'not_found' } as const;
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    if (data.kind !== 'fleet') return { ok: false, reason: 'not_fleet' } as const;
    if (data.user_id !== params.humanUserId) return { ok: false, reason: 'issuer_mismatch' } as const;
    if (data.used === true) {
      return data.used_by_wallet_id === params.walletId
        ? { ok: true, resumed: true, bindCompleted: data.bind_completed === true } as const
        : { ok: false, reason: 'already_used' } as const;
    }
    if (isConnectionTokenExpired({ expiresAt: finiteMs(data.expires_at) }, params.nowMs)) {
      return { ok: false, reason: 'expired' } as const;
    }
    // Records WHICH agent consumed the code and that its bind has not yet
    // committed (the bind's own transaction flips `bind_completed`).
    txn.update(ref, { used: true, used_by_wallet_id: params.walletId, used_at: params.nowMs, bind_completed: false });
    return { ok: true, resumed: false, bindCompleted: false } as const;
  });
}

/**
 * The deterministic `agent_invites` id for a fleet-code link: one record per code,
 * so a retry reuses the record and the `invite_accepted` PE id derived from it.
 * Hashed, so the code itself never lands in an id.
 */
export function fleetInviteId(code: string): string {
  return `inv_fleet_${crypto.createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 32)}`;
}

/**
 * Whether an agent has ANY beneficiary-link history (a fleet
 * code reaches only a NEW, never-linked agent). Read from durable state only:
 * - the agent is linked right now (`linked_human_*` on its wallet doc);
 * - its canonical relationship document has moved past its birth record.
 * Birth is revision 1, `source_action_type` `agent_wallet_created`, state
 * `unlinked`; every link, unlink and share change bumps `revision`, so a
 * higher revision, any other source, or a linked state is history. A
 * MISSING relationship document is unknown and counts as history
 * (Unknown = Block) — `bindAgentToHuman` could not bind it anyway;
 * - any accepted `agent_invites` record names this agent (a past Accept or
 * fleet link, including one whose link was later ended).
 * A link the human ended stays ended as far as agent credentials go: a fleet
 * code, fresh or re-presented, never re-links that agent — only the human's
 * own Accept can.
 */
export async function agentHasLinkHistory(db: Firestore, walletId: string): Promise<boolean> {
  const [walletSnap, relationshipSnap, accepted] = await Promise.all([
    db.collection('agent_wallets').doc(walletId).get(),
    db.collection(AGENT_BENEFICIARY_RELATIONSHIP_COLLECTION).doc(walletId).get(),
    db.collection('agent_invites')
      .where('agent_wallet_id', '==', walletId)
      .where('status', '==', 'accepted')
      .limit(1)
      .get(),
  ]);
  if (!walletSnap.exists) return true;
  const wallet = (walletSnap.data() ?? {}) as Record<string, unknown>;
  if (wallet.linked_human_user_id != null
    || wallet.linked_human_wallet_id != null
    || wallet.linked_human_address != null) return true;
  if (!relationshipSnap.exists) return true;
  const rel = (relationshipSnap.data() ?? {}) as Record<string, unknown>;
  if (rel.revision !== 1 || rel.state !== 'unlinked' || rel.source_action_type !== 'agent_wallet_created') {
    return true;
  }
  return !accepted.empty;
}
