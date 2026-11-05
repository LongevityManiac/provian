/**
 * work package O8 — the agent NAME REGISTRY (burn-gated scarcity).
 *
 * Claiming a globally-unique agent name COSTS a PVT burn: the agent first burns
 * PVT on-chain and records it via `recordAgentBurn` (→ a verified row in
 * `pvt_burn_records` keyed by `burn_id`), then claims a name BOUND to that
 * `burn_id`. Two invariants, both enforced atomically in ONE Firestore
 * transaction so neither can be raced:
 * - NAME UNIQUENESS: the normalized name doc is `create()`d — a taken name fails.
 * - ONE BURN → ONE BENEFIT (, GLOBAL single-use): the shared
 * `burn_consumptions/{burn_id}` marker is `create()`d in the same transaction
 * via `buildBurnConsumptionMarker(product:'name_registry')`. A burn already
 * spent on ANY product (a name, a vouch, a pledge, …) fails ALREADY_EXISTS —
 * so one burn buys exactly one benefit system-wide, and a name costs one burn.
 * The burn must be the CALLER'S OWN, verified + recorded (`status:'recorded'`,
 * `verified:true`, `wallet_id === walletId`) — an unverified/pending/foreign burn
 * cannot claim. The burn fence lives in `assertBurnRowUsable` (the shared ledger)
 * so every product applies it identically.
 *
 * DELIBERATELY NOT A PE (mirrors the O7 wants board + the burn substrate): this
 * records to its own `commons_name_claims` collection, adds no emitted action
 * type, and therefore does not touch the -pinned action-policy matrix. It
 * mints nothing; it consumes an already-provenance-anchored burn.
 *
 * LIVE: PVT9 minting is live on Base (non-zero supply) and the burn verifier is
 * active (ENABLE_PVT_PRINCIPAL=true, kernel pinned), so a real burn can back a
 * name claim. Unit tests still exercise the mechanism via mocked burns.
 */

import type { AgentBankDeps } from '../agent-bank/types';
import {
  BURN_CONSUMPTIONS_COLLECTION,
  PVT_BURN_RECORDS_COLLECTION,
  BurnConsumptionError,
  BURN_ALREADY_CONSUMED,
  assertBurnRowUsable,
  resolveBurnFloorAtomic,
  buildBurnConsumptionMarker,
  isBurnId,
} from './burn-consumption';

export const COMMONS_NAME_CLAIMS_COLLECTION = 'commons_name_claims';

export const NAME_MIN_LENGTH = 3;
export const NAME_MAX_LENGTH = 32;
/** Lowercased handle: alphanumerics + single internal hyphen/underscore. */
const NAME_RE = /^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])$/;

export interface NameClaimDocument {
  readonly name: string;
  readonly name_normalized: string;
  readonly wallet_id: string;
  readonly agent_id: string;
  readonly burn_id: string;
  readonly chain: string;
  readonly claimed_at: number;
}

export interface ClaimNameInput {
  readonly walletId: string;
  readonly agentWallet: { id: string; agent_id: string } | null | undefined;
  readonly name: string;
  readonly burnId: string;
  readonly nowMs?: number;
}

export type ClaimNameResult =
  | { ok: true; claim: NameClaimDocument }
  | { ok: false; status: number; error: string };

/** Normalize a submitted name to its canonical registry key, or null if invalid. */
export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length < NAME_MIN_LENGTH || trimmed.length > NAME_MAX_LENGTH) return null;
  const lowered = trimmed.toLowerCase();
  if (!NAME_RE.test(lowered)) return null;
  return lowered;
}

/**
 * Claim a globally-unique name, burning-gated. Fail-closed at every step; the
 * name doc and the shared burn-consumption marker are created together or not at all.
 */
export async function claimName(
  deps: AgentBankDeps,
  input: ClaimNameInput,
): Promise<ClaimNameResult> {
  const { walletId, agentWallet, name, burnId } = input;
  const nowMs = input.nowMs ?? Date.now();

  if (!agentWallet || agentWallet.id !== walletId) {
    return { ok: false, status: 403, error: 'Access denied - wallet_id mismatch' };
  }
  const normalized = normalizeName(name);
  if (normalized === null) {
    return {
      ok: false,
      status: 400,
      error: `name must be ${NAME_MIN_LENGTH}-${NAME_MAX_LENGTH} chars, lowercase alphanumerics with internal - or _`,
    };
  }
  if (!isBurnId(burnId)) {
    return { ok: false, status: 400, error: 'burn_id must be a 64-char hex burn identifier' };
  }

  // The burn must be the caller's own, on-chain-verified and recorded. The
  // transaction reads it to bind the exact state it consumes.
  const burnRef = deps.db.collection(PVT_BURN_RECORDS_COLLECTION).doc(burnId);
  const consumptionRef = deps.db.collection(BURN_CONSUMPTIONS_COLLECTION).doc(burnId);
  const nameRef = deps.db.collection(COMMONS_NAME_CLAIMS_COLLECTION).doc(normalized);
  // work package minimum-burn floor for this action (Part 1); resolved before the txn.
  const minBurnAtomic = await resolveBurnFloorAtomic(deps.db, 'name_registry');

  try {
    const claim = await deps.db.runTransaction(async (txn) => {
      // Atomic reads BEFORE any write (Firestore transaction rule): all gets
      // first, then the two creates.
      const [burnSnap, consumptionSnap, nameSnap] = await Promise.all([
        txn.get(burnRef),
        txn.get(consumptionRef),
        txn.get(nameRef),
      ]);
      assertBurnRowUsable(burnSnap.exists ? (burnSnap.data() as Record<string, unknown>) : undefined, walletId, minBurnAtomic);
      // GLOBAL single-use: a burn already spent by ANY product refuses here.
      if (consumptionSnap.exists) throw new BurnConsumptionError(409, BURN_ALREADY_CONSUMED);
      if (nameSnap.exists) throw new NameClaimError(409, 'name is already taken');

      const burn = burnSnap.data() as Record<string, unknown>;
      const doc: NameClaimDocument = {
        name: name.trim(),
        name_normalized: normalized,
        wallet_id: walletId,
        agent_id: agentWallet.agent_id,
        burn_id: burnId,
        chain: typeof burn.chain === 'string' ? burn.chain : 'base',
        claimed_at: nowMs,
      };
      txn.create(nameRef, doc as unknown as FirebaseFirestore.DocumentData);
      // The shared one-burn-one-benefit marker (product:'name_registry', ref:name).
      txn.create(
        consumptionRef,
        buildBurnConsumptionMarker({
          burnId,
          product: 'name_registry',
          walletId,
          ref: normalized,
          nowMs,
        }) as unknown as FirebaseFirestore.DocumentData,
      );
      return doc;
    });
    return { ok: true, claim };
  } catch (err) {
    if (err instanceof BurnConsumptionError || err instanceof NameClaimError) {
      return { ok: false, status: err.status, error: err.message };
    }
    throw err;
  }
}

class NameClaimError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'NameClaimError';
  }
}

/** Resolve a name to its owning agent (forward lookup). Null if unclaimed. */
export async function resolveName(
  deps: AgentBankDeps,
  name: string,
): Promise<NameClaimDocument | null> {
  const normalized = normalizeName(name);
  if (normalized === null) return null;
  const snap = await deps.db.collection(COMMONS_NAME_CLAIMS_COLLECTION).doc(normalized).get();
  return snap.exists ? (snap.data() as NameClaimDocument) : null;
}

/** Reverse lookup: every name a wallet has claimed. */
export async function namesForWallet(
  deps: AgentBankDeps,
  walletId: string,
): Promise<NameClaimDocument[]> {
  const q = await deps.db.collection(COMMONS_NAME_CLAIMS_COLLECTION)
    .where('wallet_id', '==', walletId).get();
  return q.docs.map((d) => d.data() as NameClaimDocument);
}
