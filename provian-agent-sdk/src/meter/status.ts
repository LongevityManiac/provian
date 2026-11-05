/**
 * PE METER — what `doctor` and the daemon say about this device's PE store.
 */

import type { ArchiveLocalState, MeterHalt, MeterReceiptTotals, PeStore } from './pe-store';

/** Printed once when a device first keeps its own PEs (and in `doctor`). */
export const PE_STORE_NOTICE =
  'Your PEs live on this machine; the relay keeps totals, minted PVT and the fingerprint; proving an act requires keeping its PE.';

export interface MeterStatus {
  readonly device_id: string;
  readonly location: string;
  readonly pes_stored: number;
  readonly unsent: number;
  readonly in_flight: { readonly seq: number; readonly acts: number } | null;
  readonly last_batch: {
    readonly seq: number;
    readonly accepted_at_ms: number | null;
    readonly acts: number;
    readonly totals: MeterReceiptTotals | null;
    readonly adopted: boolean;
  } | null;
  readonly proofs_fetched: number;
  readonly mailbox_received: number;
  /** Pre-meter PEs the relay handed back, filed in `legacy.jsonl`. */
  readonly legacy_pes: number;
  readonly halted: MeterHalt | null;
  /** The paid PE Archive keeper's last status ; null when it never ran here. */
  readonly archive: ArchiveLocalState | null;
  /** Days dropped from this machine after the Archive confirmed them (each PE left a pointer). */
  readonly archived_days: number;
}

export async function meterStatusOf(store: PeStore): Promise<MeterStatus> {
  const head = await store.head();
  const last = await store.lastBatch();
  const inflight = await store.inFlight();
  const batched = last === null ? 0 : last.first_index + last.count;
  return {
    device_id: store.deviceId,
    location: store.location,
    pes_stored: head.count,
    unsent: Math.max(0, head.count - batched),
    in_flight: inflight === null ? null : { seq: inflight.batch.seq, acts: inflight.count },
    last_batch: last === null ? null : {
      seq: last.seq,
      accepted_at_ms: last.accepted_at_ms,
      acts: last.count,
      totals: last.totals,
      adopted: last.adopted === true,
    },
    proofs_fetched: (await store.listProofs()).length,
    mailbox_received: (await store.listReceived()).length,
    legacy_pes: (await store.listLegacy()).length,
    halted: await store.halt(),
    archive: (await store.archiveState?.()) ?? null,
    archived_days: (await store.listArchivedDays?.())?.length ?? 0,
  };
}

const GB = 1_000_000_000;

/** One line about the paid PE Archive for `doctor` / `pes`. */
export function describeArchiveStatus(archive: ArchiveLocalState | null, archivedDays: number): string {
  if (archive === null || !archive.on) {
    return archivedDays > 0
      ? `PE Archive off (${archivedDays} older day(s) stay in the Archive and are pulled back when needed)`
      : 'PE Archive off (every PE stays on this machine)';
  }
  const used = (archive.used_bytes / GB).toFixed(3);
  const paid = (archive.paid_bytes / GB).toFixed(0);
  if (archive.space_exhausted) {
    return `ARCHIVE FULL (${used} of ${paid} GB used) — add 1 GB for $5: \`provian archive pay --yes\`. Until then new days stay on this machine; nothing is deleted`;
  }
  return `PE Archive on: ${used} of ${paid} GB used, ${archive.days_confirmed} day(s) confirmed, ${archivedDays} dropped here (the last 30 days stay on this machine)`
    + (archive.last_error ? `; last issue: ${archive.last_error}` : '');
}

/** One readable line for `doctor`. */
export function describeMeterStatus(status: MeterStatus): string {
  const parts = [`${status.pes_stored} PE(s) stored at ${status.location}`, `${status.unsent} not yet batched`];
  if (status.last_batch) {
    const when = status.last_batch.accepted_at_ms ? new Date(status.last_batch.accepted_at_ms).toISOString() : 'time unknown';
    const totals = status.last_batch.totals
      ? `, ${status.last_batch.totals.eligible}/${status.last_batch.totals.acts} eligible, ${status.last_batch.totals.eligible_points_atomic} points`
      : status.last_batch.adopted ? ', resynced from the relay tip' : '';
    parts.push(`last batch #${status.last_batch.seq} at ${when} (${status.last_batch.acts} act(s)${totals})`);
  } else {
    parts.push('no batch sent yet');
  }
  if (status.in_flight) parts.push(`batch #${status.in_flight.seq} in flight (${status.in_flight.acts} act(s))`);
  parts.push(`${status.proofs_fetched} proof(s) fetched`, `${status.mailbox_received} mailbox PE(s) received`, `${status.legacy_pes} pre-meter PE(s) held`);
  parts.push(describeArchiveStatus(status.archive, status.archived_days));
  if (status.halted) parts.push(`BATCHING HALTED: ${status.halted.reason} — ${status.halted.detail}`);
  return parts.join('; ');
}
