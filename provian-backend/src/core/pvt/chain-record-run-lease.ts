/**
 * Independent single-flight leases for Base discovery, verification and auxiliary work.
 * Discovery keeps its five-minute cadence while other chains or verification are busy.
 * During migration it stays inactive until old combined requests have drained, and
 * also honors any live older lease. Observation leases retain transaction-level safety.
 *
 * Expiry is the crash backstop: holders release before responding. The lease
 * outlives the executing request deadline by the platform's one-minute margin.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { SCHEDULED_REQUEST_DEADLINE_MS } from '../../instance-health';

export const CHAIN_RECORD_RUN_LEASE_COLLECTION = 'chain_record_run_leases';
export const CHAIN_RECORD_RUN_LEASE_DOCUMENT = 'chain_record';
export const CHAIN_RECORD_DISCOVERY_LEASE_DOCUMENT = 'base_discovery';
export const CHAIN_RECORD_AUXILIARY_LEASE_DOCUMENT = 'chain_record_auxiliary';
export const CHAIN_RECORD_AUXILIARY_CUTOVER_DOCUMENT = 'independent_auxiliary';
export const CHAIN_RECORD_DISCOVERY_CUTOVER_COLLECTION = 'chain_record_discovery_cutovers_v1';
export const CHAIN_RECORD_DISCOVERY_CUTOVER_DOCUMENT = 'independent_discovery';
const LEASE_SCHEMA = 'chain-record-run-lease/v1' as const;

/** Outlive the executing-handler deadline by one minute, matching the platform timeout. */
export const CHAIN_RECORD_RUN_LEASE_TTL_MS = SCHEDULED_REQUEST_DEADLINE_MS + 60_000;

/**
 * CPU may be throttled as soon as the response finishes. Complete lease cleanup
 * while the request is still active, including when the work itself fails.
 */
export async function finishChainRecordRun<T>(
  work: () => Promise<T>,
  release: () => Promise<void>,
): Promise<T> {
  try {
    return await work();
  } finally {
    await release();
  }
}

interface RunLeaseDoc {
  readonly schema_version: typeof LEASE_SCHEMA;
  readonly owner: string;
  readonly acquired_at_ms: number;
  readonly expires_at_ms: number;
  readonly workload?: 'drain' | 'discovery' | 'auxiliary';
}

type LeaseDb = Pick<Firestore, 'collection' | 'runTransaction'>;

/** Take the lease, or return false while another run holds a live one. */
export async function acquireChainRecordRunLease(
  db: LeaseDb,
  params: { readonly workerId: string; readonly nowMs: number; readonly leaseTtlMs: number; readonly workload?: 'drain' | 'discovery' | 'auxiliary' },
): Promise<boolean> {
  const collection = db.collection(CHAIN_RECORD_RUN_LEASE_COLLECTION);
  const ref = collection.doc(params.workload === 'discovery' ? CHAIN_RECORD_DISCOVERY_LEASE_DOCUMENT
    : params.workload === 'auxiliary' ? CHAIN_RECORD_AUXILIARY_LEASE_DOCUMENT : CHAIN_RECORD_RUN_LEASE_DOCUMENT);
  return db.runTransaction<boolean>(async (txn) => {
    const snap = await txn.get(ref);
    if (params.workload === 'auxiliary') {
      const cutover = (await txn.get(db.collection(CHAIN_RECORD_DISCOVERY_CUTOVER_COLLECTION)
        .doc(CHAIN_RECORD_AUXILIARY_CUTOVER_DOCUMENT))).data();
      if (!cutover || cutover.schema_version !== 'chain-record-auxiliary-cutover/v1' || cutover.active !== true
        || !Number.isSafeInteger(cutover.not_before_ms) || cutover.not_before_ms < 0 || cutover.not_before_ms > params.nowMs
        || !Number.isSafeInteger(cutover.activated_at_ms) || cutover.activated_at_ms < cutover.not_before_ms
        || cutover.activated_at_ms > params.nowMs
        || typeof cutover.proof_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(cutover.proof_sha256)) return false;
    }
    if (params.workload === 'discovery') {
      const cutover = (await txn.get(db.collection(CHAIN_RECORD_DISCOVERY_CUTOVER_COLLECTION)
        .doc(CHAIN_RECORD_DISCOVERY_CUTOVER_DOCUMENT))).data();
      // An old-source request may reach its old lease late. The operator proves
      // all such requests drained before activating the separate discovery lane.
      if (!cutover || cutover.schema_version !== 'chain-record-discovery-cutover/v1' || cutover.active !== true
        || !Number.isSafeInteger(cutover.not_before_ms) || cutover.not_before_ms < 0 || cutover.not_before_ms > params.nowMs
        || !Number.isSafeInteger(cutover.activated_at_ms) || cutover.activated_at_ms < cutover.not_before_ms
        || cutover.activated_at_ms > params.nowMs
        || typeof cutover.proof_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(cutover.proof_sha256)) return false;
      // Older revisions scanned Base inside the combined run. Honor that live
      // lease during cutover; a new drain explicitly identifies its workload.
      const legacy = (await txn.get(collection.doc(CHAIN_RECORD_RUN_LEASE_DOCUMENT))).data() as Partial<RunLeaseDoc> | undefined;
      if (legacy && legacy.workload !== 'drain'
        && (!Number.isSafeInteger(legacy.expires_at_ms) || (legacy.expires_at_ms as number) > params.nowMs)) return false;
    }
    const fresh: RunLeaseDoc = {
      schema_version: LEASE_SCHEMA,
      owner: params.workerId,
      acquired_at_ms: params.nowMs,
      expires_at_ms: params.nowMs + params.leaseTtlMs,
      ...(params.workload ? { workload: params.workload } : {}),
    };
    if (snap.exists) {
      const existing = (snap.data() ?? {}) as Partial<RunLeaseDoc>;
      if (existing.schema_version !== LEASE_SCHEMA || typeof existing.owner !== 'string' || existing.owner.length === 0
        || !Number.isSafeInteger(existing.expires_at_ms) || (existing.expires_at_ms as number) < 0) return false;
      const live = (existing.expires_at_ms as number) > params.nowMs;
      if (live && existing.owner !== params.workerId) return false;
    }
    txn.set(ref, fresh as unknown as Record<string, unknown>);
    return true;
  });
}

/** Release the lease this worker holds. A lease another worker took over after expiry is left alone. */
export async function releaseChainRecordRunLease(
  db: LeaseDb,
  params: { readonly workerId: string; readonly nowMs: number; readonly workload?: 'drain' | 'discovery' | 'auxiliary' },
): Promise<void> {
  const ref = db.collection(CHAIN_RECORD_RUN_LEASE_COLLECTION).doc(params.workload === 'discovery' ? CHAIN_RECORD_DISCOVERY_LEASE_DOCUMENT
    : params.workload === 'auxiliary' ? CHAIN_RECORD_AUXILIARY_LEASE_DOCUMENT : CHAIN_RECORD_RUN_LEASE_DOCUMENT);
  await db.runTransaction<void>(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) return;
    const existing = (snap.data() ?? {}) as Partial<RunLeaseDoc>;
    if (existing.owner !== params.workerId) return;
    txn.set(ref, { ...existing, expires_at_ms: params.nowMs } as unknown as Record<string, unknown>);
  });
}
