/**
 * Firestore-backed FacilitatorStore (production). Same GCP project as the relay; the database is
 * chosen by `FIRESTORE_DATABASE_ID` (unset = `(default)`), exactly like the relay's `relayDb()`.
 * Every single-use write is a transactional create (`create()` fails if the document exists).
 */
import { initializeApp, getApps, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  refillStatePatch,
  type ClaimResult,
  type FacilitatorStore,
  type SellerRecord,
  type SettlementRecord,
} from './store.js';
import type { ChainName } from './constants.js';
import type { RefillReport } from './refill.js';

export const SELLERS_COLLECTION = 'x402_sellers_v1';
export const NONCES_COLLECTION = 'x402_seller_nonces_v1';
export const PRESENTATIONS_COLLECTION = 'x402_presentations_used_v1';
/**
 * The service's own settlement records. Its own name: the relay's witness lane keeps its pointers in
 * `x402_facilitator_settlements_v1` in the same database, and the two schemas shared that collection
 * until 2026-10-05 (the two records written before the split were copied here).
 */
export const SETTLEMENTS_COLLECTION = 'x402_facilitator_service_settlements_v1';
/** The gas wallets' latest self-refill run per chain (read by the relay's Command Center). */
export const REFILL_COLLECTION = 'x402_facilitator_refill_v1';

/** Firestore's "already exists" gRPC code. */
const ALREADY_EXISTS = 6;

function isAlreadyExists(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === ALREADY_EXISTS;
}

/** Firestore document ids may not contain '/'. Seller ids are `chain:address`, nonces are validated upstream. */
function safeId(id: string): string {
  if (id.length === 0 || id.length > 300 || id.includes('/') || id === '.' || id === '..') {
    throw new Error('invalid document id');
  }
  return id;
}

export function createFirestore(projectId: string, databaseId: string | null): Firestore {
  const app: App = getApps()[0] ?? initializeApp({ projectId });
  return databaseId ? getFirestore(app, databaseId) : getFirestore(app);
}

export class FirestoreStore implements FacilitatorStore {
  constructor(private readonly db: Firestore) {}

  async getSeller(sellerId: string): Promise<SellerRecord | null> {
    const snap = await this.db.collection(SELLERS_COLLECTION).doc(safeId(sellerId)).get();
    return snap.exists ? (snap.data() as SellerRecord) : null;
  }

  async upsertSeller(record: SellerRecord): Promise<SellerRecord> {
    const ref = this.db.collection(SELLERS_COLLECTION).doc(safeId(record.seller_id));
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const prior = snap.exists ? (snap.data() as SellerRecord) : null;
      const next: SellerRecord = prior
        ? {
            ...record,
            registered_at_ms: prior.registered_at_ms,
            status: prior.status,
            ...(prior.settlement_count !== undefined ? { settlement_count: prior.settlement_count } : {}),
            ...(prior.strike_count !== undefined ? { strike_count: prior.strike_count } : {}),
          }
        : record;
      tx.set(ref, next);
      return next;
    });
  }

  async consumeNonce(nonce: string, expiresAtMs: number): Promise<boolean> {
    try {
      await this.db.collection(NONCES_COLLECTION).doc(safeId(nonce)).create({
        used_at_ms: Date.now(),
        expires_at: Timestamp.fromMillis(expiresAtMs),
      });
      return true;
    } catch (err) {
      if (isAlreadyExists(err)) return false;
      throw err;
    }
  }

  async isPresentationUsed(presentationId: string): Promise<boolean> {
    const snap = await this.db.collection(PRESENTATIONS_COLLECTION).doc(safeId(presentationId)).get();
    return snap.exists;
  }

  async consumePresentation(presentationId: string, settlementKey: string, expiresAtMs: number): Promise<boolean> {
    try {
      await this.db.collection(PRESENTATIONS_COLLECTION).doc(safeId(presentationId)).create({
        settlement_key: settlementKey,
        used_at_ms: Date.now(),
        expires_at: Timestamp.fromMillis(expiresAtMs),
      });
      return true;
    } catch (err) {
      if (isAlreadyExists(err)) return false;
      throw err;
    }
  }

  async claimSettlement(record: SettlementRecord): Promise<ClaimResult> {
    const ref = this.db.collection(SETTLEMENTS_COLLECTION).doc(safeId(record.key));
    try {
      await ref.create(record);
      return { claimed: true };
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      const snap = await ref.get();
      return { claimed: false, existing: snap.data() as SettlementRecord };
    }
  }

  async getSettlement(key: string): Promise<SettlementRecord | null> {
    const snap = await this.db.collection(SETTLEMENTS_COLLECTION).doc(safeId(key)).get();
    return snap.exists ? (snap.data() as SettlementRecord) : null;
  }

  async updateSettlement(key: string, patch: Partial<Omit<SettlementRecord, 'key'>>): Promise<void> {
    await this.db.collection(SETTLEMENTS_COLLECTION).doc(safeId(key)).update({ ...patch, updated_at_ms: Date.now() });
  }

  async listPendingWitness(limit: number): Promise<SettlementRecord[]> {
    const snap = await this.db
      .collection(SETTLEMENTS_COLLECTION)
      .where('witness_status', '==', 'pending')
      .limit(limit)
      .get();
    return snap.docs.map((d) => d.data() as SettlementRecord).filter((s) => s.status === 'confirmed');
  }

  async listStaleSubmitted(updatedBeforeMs: number, limit: number, chain: ChainName): Promise<SettlementRecord[]> {
    // One equality filter (no composite index); the chain and age cuts are applied here. The Base
    // and Solana facilitators share this store (the Base reconciler
    // was sweeping Solana records and closing them against a Base RPC that could never find them).
    const snap = await this.db
      .collection(SETTLEMENTS_COLLECTION)
      .where('status', '==', 'submitted')
      .limit(Math.max(limit * 4, 50))
      .get();
    return snap.docs
      .map((d) => d.data() as SettlementRecord)
      .filter((s) => s.chain === chain && s.updated_at_ms <= updatedBeforeMs)
      .sort((a, b) => a.updated_at_ms - b.updated_at_ms)
      .slice(0, limit);
  }

  async incrementSellerCounter(sellerId: string, field: 'settlement_count' | 'strike_count'): Promise<number> {
    const ref = this.db.collection(SELLERS_COLLECTION).doc(safeId(sellerId));
    await ref.update({ [field]: FieldValue.increment(1), updated_at_ms: Date.now() });
    const snap = await ref.get();
    const v = (snap.data() as SellerRecord | undefined)?.[field];
    return typeof v === 'number' ? v : 0;
  }

  async suspendSeller(sellerId: string): Promise<void> {
    await this.db.collection(SELLERS_COLLECTION).doc(safeId(sellerId)).update({ status: 'suspended', updated_at_ms: Date.now() });
  }

  async recordRefill(report: RefillReport, atMs: number): Promise<void> {
    await this.db.collection(REFILL_COLLECTION).doc(safeId(report.chain)).set(refillStatePatch(report, atMs), { merge: true });
  }
}
