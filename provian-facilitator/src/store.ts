/**
 * Durable state the facilitator keeps. It holds NO funds and NO balances: sellers (identified by
 * wallet signature), single-use registration nonces, single-use presentation ids, and one record
 * per settlement (the idempotency key that stops a retried /settle from broadcasting twice, and the
 * pending witness report the relay has not yet acknowledged).
 *
 * Collections (the relay's Firestore, database chosen by `FIRESTORE_DATABASE_ID`):
 *   x402_sellers_v1/{chain:address}           — public seller profiles (the relay lists them)
 *   x402_seller_nonces_v1/{nonce}               — registration nonces, single-use (TTL: expires_at)
 *   x402_presentations_used_v1/{presentation_id} — burn-backed presentations consumed by a settlement
 *   x402_facilitator_service_settlements_v1/{key} — one per settlement attempt key (the relay's own
 *     witness pointers live in `x402_facilitator_settlements_v1`; keep the two apart)
 *   x402_facilitator_refill_v1/{chain}          — the gas wallet's latest self-refill run, its last swap
 *     and its last error (the Command Center's Services page reads it; balances, hashes, no key)
 */
import type { ChainName } from './constants.js';
import type { RefillReport } from './refill.js';

/** The latest refill run on one chain, plus the last swap / sweep / error it has ever seen. */
export interface RefillState {
  readonly chain: ChainName;
  readonly last_run_at_ms: number;
  readonly gas_before: string;
  readonly usdc_before: string;
  readonly error: string | null;
  readonly skipped: readonly string[];
  readonly last_swap?: { readonly tx: string; readonly usdc: string; readonly at_ms: number };
  readonly last_sweep?: { readonly tx: string; readonly usdc: string; readonly at_ms: number };
  readonly last_error?: { readonly error: string; readonly at_ms: number };
}

/** The fields one run writes: a run without a swap keeps the last swap ever seen, and so on. */
export function refillStatePatch(report: RefillReport, atMs: number): Partial<RefillState> & Pick<RefillState, 'chain' | 'last_run_at_ms'> {
  return {
    chain: report.chain,
    last_run_at_ms: atMs,
    gas_before: report.gas_before,
    usdc_before: report.usdc_before,
    error: report.error,
    skipped: [...report.skipped],
    ...(report.swap_tx ? { last_swap: { tx: report.swap_tx, usdc: report.swapped_usdc, at_ms: atMs } } : {}),
    ...(report.sweep_tx ? { last_sweep: { tx: report.sweep_tx, usdc: report.swept_usdc, at_ms: atMs } } : {}),
    ...(report.error ? { last_error: { error: report.error, at_ms: atMs } } : {}),
  };
}

export interface PresentationRequirement {
  readonly tier: 'pe_fact' | 'reputation';
  readonly predicates?: ReadonlyArray<{
    readonly field: string;
    readonly op: 'gte' | 'gt' | 'lte' | 'lt' | 'eq' | 'in';
    readonly threshold?: number;
    readonly set?: readonly number[];
  }>;
}

export interface PvtPrice {
  /** The resource (URL or path) this price applies to. */
  readonly resource: string;
  /** PVT atomic units (18 decimals). Provian never converts PVT to dollars. */
  readonly amount_atomic: string;
}

export interface SellerRecord {
  readonly seller_id: string;
  readonly chain: ChainName;
  readonly network: string;
  readonly address: string;
  readonly display_name: string;
  readonly description: string;
  readonly resource_urls: readonly string[];
  readonly require_presentation: PresentationRequirement | null;
  readonly pvt_prices: readonly PvtPrice[];
  readonly status: 'active' | 'suspended';
  readonly registered_at_ms: number;
  readonly updated_at_ms: number;
  readonly settlement_count?: number;
  /** Settlements that reverted after broadcast (e.g. the seller front-ran its own authorization). */
  readonly strike_count?: number;
}

export type SettlementStatus = 'submitting' | 'submitted' | 'confirmed' | 'failed';
/** `refused`: the relay answered 400/409/422 — final, never retried (the relay owns its own re-checks). */
export type WitnessStatus = 'pending' | 'reported' | 'refused' | 'not_applicable';

export interface SettlementRecord {
  readonly key: string;
  readonly chain: ChainName;
  readonly network: string;
  readonly seller_id: string;
  readonly buyer: string;
  readonly seller: string;
  readonly asset: string;
  readonly amount: string;
  readonly fee: string;
  readonly scheme: 'eip3009' | 'permit2' | 'svm_exact';
  /** The authorization's own expiry (EIP-3009 validBefore / Permit2 deadline), unix seconds; absent on older records. */
  readonly expires_at_sec?: number;
  readonly status: SettlementStatus;
  readonly tx_hash: string | null;
  readonly error: string | null;
  readonly witness_status: WitnessStatus;
  readonly witness_attempts: number;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

export type ClaimResult = { readonly claimed: true } | { readonly claimed: false; readonly existing: SettlementRecord };

export interface FacilitatorStore {
  getSeller(sellerId: string): Promise<SellerRecord | null>;
  /** Insert or update; keeps registered_at_ms, status and counters of an existing seller. */
  upsertSeller(record: SellerRecord): Promise<SellerRecord>;
  /** True when the nonce was fresh (and is now consumed); false when it was already used. */
  consumeNonce(nonce: string, expiresAtMs: number): Promise<boolean>;
  isPresentationUsed(presentationId: string): Promise<boolean>;
  /** True when fresh (and now consumed). */
  consumePresentation(presentationId: string, settlementKey: string, expiresAtMs: number): Promise<boolean>;
  /** Create the settlement record iff absent (the broadcast lock). */
  claimSettlement(record: SettlementRecord): Promise<ClaimResult>;
  getSettlement(key: string): Promise<SettlementRecord | null>;
  updateSettlement(key: string, patch: Partial<Omit<SettlementRecord, 'key'>>): Promise<void>;
  listPendingWitness(limit: number): Promise<SettlementRecord[]>;
  /** `submitted` records of one chain not updated since `updatedBeforeMs` (a lost receipt wait), oldest first. */
  listStaleSubmitted(updatedBeforeMs: number, limit: number, chain: ChainName): Promise<SettlementRecord[]>;
  incrementSellerCounter(sellerId: string, field: 'settlement_count' | 'strike_count'): Promise<number>;
  /** A seller whose settlements keep reverting after broadcast is suspended (no further broadcasts). */
  suspendSeller(sellerId: string): Promise<void>;
  /** Keep the latest refill run per chain (merged: the last swap / sweep / error survive later runs). */
  recordRefill(report: RefillReport, atMs: number): Promise<void>;
}

/** In-memory store (tests and local runs). */
export class MemoryStore implements FacilitatorStore {
  readonly sellers = new Map<string, SellerRecord>();
  readonly nonces = new Set<string>();
  readonly presentations = new Map<string, string>();
  readonly settlements = new Map<string, SettlementRecord>();
  readonly refills = new Map<string, RefillState>();

  async getSeller(sellerId: string): Promise<SellerRecord | null> {
    return this.sellers.get(sellerId) ?? null;
  }

  async upsertSeller(record: SellerRecord): Promise<SellerRecord> {
    const prior = this.sellers.get(record.seller_id);
    const next: SellerRecord = prior
      ? {
          ...record,
          registered_at_ms: prior.registered_at_ms,
          status: prior.status,
          ...(prior.settlement_count !== undefined ? { settlement_count: prior.settlement_count } : {}),
          ...(prior.strike_count !== undefined ? { strike_count: prior.strike_count } : {}),
        }
      : record;
    this.sellers.set(record.seller_id, next);
    return next;
  }

  async consumeNonce(nonce: string, _expiresAtMs?: number): Promise<boolean> {
    if (this.nonces.has(nonce)) return false;
    this.nonces.add(nonce);
    return true;
  }

  async isPresentationUsed(presentationId: string): Promise<boolean> {
    return this.presentations.has(presentationId);
  }

  async consumePresentation(presentationId: string, settlementKey: string, _expiresAtMs?: number): Promise<boolean> {
    if (this.presentations.has(presentationId)) return false;
    this.presentations.set(presentationId, settlementKey);
    return true;
  }

  async claimSettlement(record: SettlementRecord): Promise<ClaimResult> {
    const existing = this.settlements.get(record.key);
    if (existing) return { claimed: false, existing };
    this.settlements.set(record.key, record);
    return { claimed: true };
  }

  async getSettlement(key: string): Promise<SettlementRecord | null> {
    return this.settlements.get(key) ?? null;
  }

  async updateSettlement(key: string, patch: Partial<Omit<SettlementRecord, 'key'>>): Promise<void> {
    const existing = this.settlements.get(key);
    if (!existing) throw new Error('settlement record missing');
    this.settlements.set(key, { ...existing, ...patch, updated_at_ms: Date.now() });
  }

  async listPendingWitness(limit: number): Promise<SettlementRecord[]> {
    return [...this.settlements.values()]
      .filter((s) => s.status === 'confirmed' && s.witness_status === 'pending')
      .slice(0, limit);
  }

  async listStaleSubmitted(updatedBeforeMs: number, limit: number, chain: ChainName): Promise<SettlementRecord[]> {
    return [...this.settlements.values()]
      .filter((s) => s.status === 'submitted' && s.chain === chain && s.updated_at_ms <= updatedBeforeMs)
      .sort((a, b) => a.updated_at_ms - b.updated_at_ms)
      .slice(0, limit);
  }

  async incrementSellerCounter(sellerId: string, field: 'settlement_count' | 'strike_count'): Promise<number> {
    const s = this.sellers.get(sellerId);
    if (!s) return 0;
    const next = (s[field] ?? 0) + 1;
    this.sellers.set(sellerId, { ...s, [field]: next });
    return next;
  }

  async suspendSeller(sellerId: string): Promise<void> {
    const s = this.sellers.get(sellerId);
    if (s) this.sellers.set(sellerId, { ...s, status: 'suspended', updated_at_ms: Date.now() });
  }

  async recordRefill(report: RefillReport, atMs: number): Promise<void> {
    const prior = this.refills.get(report.chain);
    this.refills.set(report.chain, { ...(prior ?? {}), ...refillStatePatch(report, atMs) } as RefillState);
  }
}
