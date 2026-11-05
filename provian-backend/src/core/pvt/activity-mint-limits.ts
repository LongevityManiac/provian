/** Identity/count-only anti-farming for financial PE categories. */
import crypto from 'crypto';
import stableStringify from 'json-stable-stringify';
import type { DocumentSnapshot, Firestore, Transaction } from 'firebase-admin/firestore';
import { decideFinancialEconomicCaps } from './economics/financial-economic-authority';

const DAILY_COLLECTION = 'activity_mint_daily';
export const ACTIVITY_MINT_RESERVATIONS_COLLECTION = 'activity_mint_reservations';

export type FarmCapReason =
  | 'daily_ceiling'
  | 'unverifiable_counterparty'
  | 'cap_state_unavailable';

/**
 * `counterparty_cap` is no longer produced. It stays READABLE only so a
 * reservation sealed `capped` under the retired per-pair cap still parses on an
 * idempotent replay of that same PE.
 */
export type SealedFarmCapReason = FarmCapReason | 'counterparty_cap';

/**
 * the ONLY count on the financial family is the
 * per-actor daily mint ceiling per UTC day. The per-(actor, counterparty) caps
 * (send 2 for life, x402_payment 3) and the vacuous stake ceiling (stake is a
 * record_only row) were removed. `requiresVerifiedCounterparty` is an identity
 * requirement, not a count: a send/x402 whose counterparty is not a parseable
 * address cannot be wash-checked, so it is capped `unverifiable_counterparty`.
 */
export interface ActionTypeMintRule {
  readonly requiresVerifiedCounterparty?: true;
  readonly dailyMintCeiling: number;
}

export const ACTION_TYPE_MINT_RULES: Readonly<Record<string, ActionTypeMintRule>> = Object.freeze({
  send: Object.freeze({ requiresVerifiedCounterparty: true, dailyMintCeiling: 25 }),
  x402_payment: Object.freeze({ requiresVerifiedCounterparty: true, dailyMintCeiling: 50 }),
  swap: Object.freeze({ dailyMintCeiling: 25 }),
  receive: Object.freeze({ dailyMintCeiling: 50 }),
});

/**
 * Types whose reservations were sealed before with the per-pair slot
 * consumed. Their `counterparty_slot_consumed: true` is legacy evidence, not
 * tamper; every new reservation writes `false`.
 */
const RETIRED_PAIR_SLOT_ACTION_TYPES: ReadonlySet<string> = new Set(['send', 'x402_payment']);

/**
 * The financial types whose counterparty identity is extracted from metadata.
 * Deliberately NOT the cap table: `stake` has no cap, but its counterparty still
 * feeds same-owner detection exactly as before.
 */
const FINANCIAL_IDENTITY_ACTION_TYPES: ReadonlySet<string> = new Set([
  'send', 'x402_payment', 'swap', 'receive', 'stake',
]);

export function getActionTypeMintRule(actionType: string): ActionTypeMintRule | undefined {
  return ACTION_TYPE_MINT_RULES[actionType];
}

/** Extract identity only. Amounts and quote-like metadata are never read. */
export function financialIdentityFromMetadata(
  actionType: string,
  metadata: unknown,
): { counterparty: string | null } {
  if (!FINANCIAL_IDENTITY_ACTION_TYPES.has(actionType) || !metadata || typeof metadata !== 'object') {
    return { counterparty: null };
  }
  const value = metadata as Record<string, unknown>;
  const asIdentity = (candidate: unknown): string | null =>
    typeof candidate === 'string' && candidate.trim()
      ? candidate.trim().toLowerCase()
      : null;
  const counterparty = actionType === 'receive'
    ? asIdentity(value.counterparty_address)
      ?? asIdentity(value.from_address)
      ?? asIdentity(value.from)
      ?? asIdentity(value.sender)
    : asIdentity(value.counterparty_address)
      ?? asIdentity(value.to_address)
      ?? asIdentity(value.to)
      ?? asIdentity(value.recipient);
  return { counterparty };
}

export function utcDayKey(timestampMs: number): string {
  const date = new Date(timestampMs);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function dailyDocId(userId: string, actionType: string, dayKey: string): string {
  return crypto.createHash('sha256').update(`${userId}:${actionType}:${dayKey}`).digest('hex');
}

export interface ActivityMintCapDecision {
  readonly capped: boolean;
  readonly reason: SealedFarmCapReason | null;
  readonly reservation: ActivityMintReservationDocument | null;
  readonly reservationHash: string | null;
  readonly idempotent: boolean;
}

export interface ActivityMintReservationDocument {
  readonly schema_version: 'activity-mint-reservation/v2';
  readonly reservation_id: string;
  readonly pe_id: string;
  readonly user_id: string;
  readonly action_type: string;
  readonly timestamp_ms: number;
  readonly day_key: string;
  readonly counterparty: string | null;
  readonly input_sha256: string;
  readonly decision: 'reserved' | 'capped';
  readonly reason: SealedFarmCapReason | null;
  /** Always `false` since; `true` only on legacy send/x402 reservations. */
  readonly counterparty_slot_consumed: boolean;
  readonly daily_slot_consumed: boolean;
  readonly created_at_ms: number;
}

export interface ReservationInput {
  readonly peId: string;
  readonly userId: string;
  readonly actionType: string;
  readonly counterpartyAddress?: string | null;
  readonly timestampMs: number;
}

interface CounterDocument {
  readonly schema_version?: 'activity-mint-counter/v1';
  readonly user_id: string;
  readonly action_type: string;
  /** A daily counter never carries a counterparty; one that does is not a daily counter. */
  readonly counterparty?: unknown;
  readonly day_key: string;
  readonly count: number;
  readonly updated_at: number;
}

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SOLANA_ADDRESS_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * follow-up: is `value` the canonical base58 of a 32-byte Solana public key? Kept
 * inside this module on purpose — the runtime boundary external-value isolation audit pins this orchestrator's
 * import edges, so it carries its own few lines of base58 rather than importing a decoder. Mirrors
 * `external-address/solana-keys.ts::isSolanaAddress` (`activity-mint-limits.solana.test.ts` binds
 * the two together).
 */
export function isCanonicalSolanaCounterparty(value: unknown): boolean {
  if (typeof value !== 'string' || !SOLANA_ADDRESS_SHAPE.test(value)) return false;
  let n = 0n;
  for (const c of value) n = n * 58n + BigInt(B58_ALPHABET.indexOf(c));
  let zeros = 0;
  while (zeros < value.length && value[zeros] === '1') zeros += 1;
  let bytes = 0;
  for (let m = n; m > 0n; m >>= 8n) bytes += 1;
  if (zeros + bytes !== 32) return false;
  // Canonical spelling only (one key, one string): re-encode and compare.
  let out = '';
  for (let m = n; m > 0n; m /= 58n) out = B58_ALPHABET[Number(m % 58n)] + out;
  return '1'.repeat(zeros) + out === value;
}
const SHA256 = /^[a-f0-9]{64}$/;

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function activityMintReservationId(peId: string): string {
  return sha256(peId);
}

/**
 * The counterparty IDENTITY the requirement reads: a parseable address. An EVM address
 * (lowercased), or — follow-up, the x402 facilitator's Solana settlements — a
 * canonical base58 Solana address, kept EXACTLY as written (base58 is case-sensitive). A Solana
 * counterparty is checked by the same-owner fence exactly as an off-platform EVM address is: the
 * facilitator lane hands the fence the owner's EVM address whenever the Solana address is a proven
 * Provian identity, so only a genuine stranger reaches here as base58.
 */
function normalizedCounterparty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (isCanonicalSolanaCounterparty(trimmed)) return trimmed;
  const normalized = trimmed.toLowerCase();
  return EVM_ADDRESS.test(normalized) ? normalized : null;
}

function inputCommitment(params: ReservationInput): string {
  const counterparty = typeof params.counterpartyAddress === 'string'
    ? params.counterpartyAddress.trim().toLowerCase()
    : `${typeof params.counterpartyAddress}:${String(params.counterpartyAddress)}`;
  return sha256(stableStringify({
    pe_id: params.peId,
    user_id: params.userId,
    action_type: params.actionType,
    timestamp_ms: params.timestampMs,
    counterparty_identity: counterparty,
  }) ?? '');
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length
    && actual.every((key, index) => key === canonical[index]);
}

function parseReservation(value: unknown): ActivityMintReservationDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('activity_mint_reservation_invalid');
  }
  const raw = value as Record<string, unknown>;
  if (!exactKeys(raw, [
    'schema_version', 'reservation_id', 'pe_id', 'user_id', 'action_type',
    'timestamp_ms', 'day_key', 'counterparty', 'input_sha256', 'decision',
    'reason', 'counterparty_slot_consumed', 'daily_slot_consumed', 'created_at_ms',
  ])) {
    throw new Error('activity_mint_reservation_schema_mismatch');
  }
  const doc = raw as unknown as ActivityMintReservationDocument;
  const reasonValid = doc.reason === null || [
    'counterparty_cap', 'daily_ceiling', 'unverifiable_counterparty',
    'cap_state_unavailable',
  ].includes(doc.reason);
  if (doc.schema_version !== 'activity-mint-reservation/v2'
    || !doc.reservation_id || !doc.pe_id || !doc.user_id || !doc.action_type
    || !Number.isSafeInteger(doc.timestamp_ms) || doc.timestamp_ms < 0
    || !/^\d{8}$/.test(doc.day_key)
    || (doc.counterparty !== null && !EVM_ADDRESS.test(doc.counterparty) && !isCanonicalSolanaCounterparty(doc.counterparty))
    || !SHA256.test(doc.input_sha256)
    || !['reserved', 'capped'].includes(doc.decision)
    || !reasonValid
    || typeof doc.counterparty_slot_consumed !== 'boolean'
    || typeof doc.daily_slot_consumed !== 'boolean'
    || !Number.isSafeInteger(doc.created_at_ms) || doc.created_at_ms < 0
    || (doc.decision === 'reserved' && doc.reason !== null)
    || (doc.decision === 'capped' && doc.reason === null)) {
    throw new Error('activity_mint_reservation_invalid');
  }
  return doc;
}

export function hashActivityMintReservation(
  reservation: ActivityMintReservationDocument,
): string {
  return `sha256:${sha256(stableStringify(parseReservation(reservation)) ?? '')}`;
}

export function assertActivityMintReservationEvidence(
  reservation: ActivityMintReservationDocument | null | undefined,
  expected: {
    peId: string;
    userId: string;
    actionType: string;
    timestampMs: number;
    reservationHash: string | null | undefined;
  },
): ActivityMintReservationDocument {
  const parsed = parseReservation(reservation);
  if (parsed.reservation_id !== activityMintReservationId(expected.peId)
    || parsed.pe_id !== expected.peId
    || parsed.user_id !== expected.userId
    || parsed.action_type !== expected.actionType
    || parsed.timestamp_ms !== expected.timestampMs
    || parsed.decision !== 'reserved'
    || expected.reservationHash !== hashActivityMintReservation(parsed)) {
    throw new Error('activity_mint_reservation_binding_mismatch');
  }
  const rule = getActionTypeMintRule(expected.actionType);
  if (!rule
    || parsed.daily_slot_consumed !== true
    || (parsed.counterparty_slot_consumed
      && !RETIRED_PAIR_SLOT_ACTION_TYPES.has(expected.actionType))) {
    throw new Error('activity_mint_reservation_slot_mismatch');
  }
  return parsed;
}

function parseCounter(
  snap: DocumentSnapshot,
  expected: { userId: string; actionType: string; dayKey: string },
): number {
  if (!snap.exists) return 0;
  const raw = snap.data();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('activity_mint_counter_invalid');
  }
  const doc = raw as unknown as CounterDocument;
  if ((doc.schema_version !== undefined && doc.schema_version !== 'activity-mint-counter/v1')
    || doc.user_id !== expected.userId
    || doc.action_type !== expected.actionType
    || doc.counterparty !== undefined
    || doc.day_key !== expected.dayKey
    || !Number.isSafeInteger(doc.count) || doc.count < 0
    || !Number.isSafeInteger(doc.updated_at) || doc.updated_at < 0) {
    throw new Error('activity_mint_counter_binding_invalid');
  }
  return doc.count;
}

function reservationResult(
  reservation: ActivityMintReservationDocument,
  idempotent: boolean,
): ActivityMintCapDecision {
  return {
    capped: reservation.decision === 'capped',
    reason: reservation.reason,
    reservation,
    reservationHash: hashActivityMintReservation(reservation),
    idempotent,
  };
}

function makeReservation(
  params: ReservationInput,
  counterparty: string | null,
  decision: 'reserved' | 'capped',
  reason: FarmCapReason | null,
): ActivityMintReservationDocument {
  return {
    schema_version: 'activity-mint-reservation/v2',
    reservation_id: activityMintReservationId(params.peId),
    pe_id: params.peId,
    user_id: params.userId,
    action_type: params.actionType,
    timestamp_ms: params.timestampMs,
    day_key: utcDayKey(params.timestampMs),
    counterparty,
    input_sha256: inputCommitment(params),
    decision,
    reason,
    counterparty_slot_consumed: false,
    daily_slot_consumed: decision === 'reserved',
    created_at_ms: params.timestampMs,
  };
}

async function readExistingReservation(
  txn: Transaction,
  ref: FirebaseFirestore.DocumentReference,
  params: ReservationInput,
): Promise<ActivityMintCapDecision | null> {
  const snap = await txn.get(ref);
  if (!snap.exists) return null;
  const reservation = parseReservation(snap.data());
  if (reservation.reservation_id !== ref.id
    || reservation.pe_id !== params.peId
    || reservation.input_sha256 !== inputCommitment(params)) {
    throw new Error('activity_mint_reservation_conflict');
  }
  return reservationResult(reservation, true);
}

/**
 * The identity half of the decision, with no daily slot: for a row that can
 * never mint in place (held on the final-chain-receipt class, whose mint comes
 * only from the chain-record lane's own verified PE). It still fails closed on
 * an unverifiable counterparty exactly as the reservation does, but it reads
 * and books no daily count, because the row can never use a slot.
 */
export function decideActivityMintIdentityWithoutSlot(params: {
  readonly actionType: string;
  readonly counterpartyAddress?: string | null;
}): { readonly capped: boolean; readonly reason: SealedFarmCapReason | null } {
  const rule = getActionTypeMintRule(params.actionType);
  if (!rule) return { capped: false, reason: null };
  const decision = decideFinancialEconomicCaps({
    counterpartyRequired: rule.requiresVerifiedCounterparty === true,
    counterpartyVerified: normalizedCounterparty(params.counterpartyAddress) !== null,
    dailyCount: 0,
    dailyCeiling: rule.dailyMintCeiling,
  });
  return { capped: decision.capped, reason: decision.reason };
}

/**
 * The only financial cap reservation input is identity, action, counterparty,
 * and time. Extra runtime metadata is ignored by construction.
 */
export async function reserveActivityMintCaps(
  db: Firestore,
  params: ReservationInput,
): Promise<ActivityMintCapDecision> {
  const rule = getActionTypeMintRule(params.actionType);
  if (!rule) {
    return { capped: false, reason: null, reservation: null, reservationHash: null, idempotent: false };
  }
  if (!params.peId || !params.userId || !params.actionType
    || !Number.isSafeInteger(params.timestampMs) || params.timestampMs < 0) {
    throw new Error('activity_mint_reservation_input_invalid');
  }

  const counterparty = normalizedCounterparty(params.counterpartyAddress);
  const reservationRef = db.collection(ACTIVITY_MINT_RESERVATIONS_COLLECTION)
    .doc(activityMintReservationId(params.peId));
  const dayKey = utcDayKey(params.timestampMs);
  const dailyRef = db.collection(DAILY_COLLECTION)
    .doc(dailyDocId(params.userId, params.actionType, dayKey));

  return db.runTransaction(async (txn) => {
    const existing = await readExistingReservation(txn, reservationRef, params);
    if (existing) return existing;

    const dailySnap = await txn.get(dailyRef);
    const dailyCount = parseCounter(dailySnap, {
      userId: params.userId,
      actionType: params.actionType,
      dayKey,
    });
    const economicDecision = decideFinancialEconomicCaps({
      counterpartyRequired: rule.requiresVerifiedCounterparty === true,
      counterpartyVerified: counterparty !== null,
      dailyCount,
      dailyCeiling: rule.dailyMintCeiling,
    });
    const reason = economicDecision.reason;
    const reservation = makeReservation(
      params,
      counterparty,
      economicDecision.capped ? 'capped' : 'reserved',
      reason,
    );
    if (!economicDecision.capped) {
      txn.set(dailyRef, {
        schema_version: 'activity-mint-counter/v1',
        user_id: params.userId,
        action_type: params.actionType,
        day_key: dayKey,
        count: dailyCount + 1,
        updated_at: params.timestampMs,
      });
    }
    txn.create(reservationRef, reservation as unknown as Record<string, unknown>);
    return reservationResult(reservation, false);
  });
}
