/**
 * The relay's Firestore client settings — ONE source for the relay (`server.ts`)
 * and every operator script that drives relay write paths from a shell.
 *
 * `ignoreUndefinedProperties: true` is load-bearing, not cosmetic: shared write
 * paths (e.g. `pe-history.ts` `tx_hash: params.tx_hash || undefined`) rely on it.
 * A client without it rejects those documents. round 2: the inbound
 * backfill CLI initialized a bare client, and its first prod `--execute` failed
 * with `Cannot use "undefined" as a Firestore value (found in field "tx_hash")`
 * AFTER the receive PE had been sealed — the pe_history row never landed.
 */

import type { Firestore } from 'firebase-admin/firestore';

export const RELAY_FIRESTORE_SETTINGS = Object.freeze({
  ignoreUndefinedProperties: true as const,
  // A request-billed instance can lose sockets while CPU is throttled. Do not
  // carry a gRPC channel across idle periods. Active calls still get transport
  // keepalive; no pings run without calls or keep an idle instance active.
  maxIdleChannels: 0,
  'grpc.keepalive_time_ms': 30_000,
  'grpc.keepalive_timeout_ms': 10_000,
  'grpc.keepalive_permit_without_calls': 0,
});

/** Minimal surface the probe needs, so the in-memory test double satisfies it too. */
export interface UndefinedProbeDb {
  batch(): { set(ref: never, data: Record<string, unknown>): unknown };
  collection(name: string): { doc(id: string): unknown };
}

/**
 * Write-free runtime probe: does THIS client accept a document holding
 * `undefined`, as the relay's does? `WriteBatch.set` validates synchronously;
 * the batch is never committed, so nothing is written. Returns the SDK's own
 * refusal text, or null when the client matches the relay.
 */
export function probeFirestoreUndefinedRejection(db: Firestore | UndefinedProbeDb): string | null {
  const probeDb = db as unknown as UndefinedProbeDb;
  try {
    probeDb.batch().set(
      probeDb.collection('__provian_settings_probe__').doc('probe') as never,
      { probe: undefined },
    );
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
