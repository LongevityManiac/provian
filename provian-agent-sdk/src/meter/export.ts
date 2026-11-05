/**
 * PE EXPORT — everything this agent owns, in ONE file anyone can verify without Provian
 * (`provian.pe-export.v1`, docs/PE_PROTOCOL_SPEC.md §14; the format itself is `pe-export-wire.ts`).
 *
 * One action collects:
 *   - every device chain held on this machine (every device directory under the PE store root,
 *     the configured device first): each PE in index order, with its two-hop inclusion proof built
 *     here from the batch's own PEs and the anchor proof the device kept;
 *   - every PE dropped here after its day was confirmed in the paid PE Archive, pulled back and
 *     opened with the agent's key, checked against the pointer the store kept;
 *   - every day the agent's Archive holds (any of its machines), pulled once: PEs of chains this
 *     machine does not hold are added; a copy that differs from one already here is reported;
 *   - every batch this machine's devices sent, with the relay's receipt and its anchor proof;
 *   - every PE sealed to the agent (received.jsonl), with its proof from the kept batch-proofs
 *     record (fetched now when none is kept);
 *   - every pre-meter record the relay handed back (legacy.jsonl), verbatim;
 *   - before any of that (export-local.ts), the relay mailbox drained: PEs sealed to the agent that
 *     no device here had filed yet are fetched, opened and filed, so they land in `received` lines.
 *
 * What it cannot hold is named, never silent: mailbox items still waiting on the relay (no key here,
 * unopenable, unreachable) by count; and the chains this agent recorded on OTHER machines, which
 * reach this file only through the paid PE Archive (named whenever the Archive was not pulled, or
 * holds another machine whose newest days are still only on that machine).
 *
 * Whatever cannot be included in full is named in the end line's `incomplete`. After building, the
 * export is verified offline exactly as a third party would (`verifyExportOffline`); a failure in a
 * fresh export means the local store is corrupt — reported loudly, and the file is still written.
 */

import * as fs from 'fs';
import * as path from 'path';
import { atomicReplacePrivateFile } from '../durable-private-file';
import { actLeafOf, actRecordOf, batchLeafOf, merkleRootOf, PE_V2_SCHEMA, type ActInclusionProof, type PeV2 } from '../meter-wire';
import {
  chainOrderOf,
  inclusionFromBatch,
  inclusionFromLeaves,
  parseExport,
  PE_EXPORT_ANCHOR_RULES,
  PE_EXPORT_SCHEMA,
  PE_EXPORT_SPEC_URL,
  serializeExport,
  verifyExportOffline,
  withPinnedContract,
  type ExportBatchAnchor,
  type ExportBodyLine,
  type ExportHeader,
  type ExportOfflineReport,
  type ExportPeLine,
  type ExportPeStatus,
  type ExportReceivedLine,
  type PeV2WithHash,
} from '../pe-export-wire';
import type { ArchiveEntry, ArchivePayload } from '../pe-archive-wire';
import { SDK_VERSION } from '../version';
import {
  deviceDirName,
  FsPeStore,
  type AcceptedBatch,
  type MeterAnchorProofWire,
  type PeChainRow,
  type PeStore,
  type ReceivedBatchProof,
  type ReceivedPe,
  type StoredBatchProof,
} from './pe-store';
import { fetchBatchProofs, receivedBatchHashes, type BatchProofsFetch } from './received-proofs';
import type { MeterTransport } from './transport';

// ─── inputs ─────────────────────────────────────────────────────────────────────

/** The parts of the Archive keeper an export uses (`ArchiveKeeper` satisfies it). */
export interface PeExportArchiveSource {
  readStatus(): Promise<{ ok: true; wallet: string; on: boolean } | { ok: false; reason: string }>;
  listDays(): Promise<{ ok: true; days: readonly { readonly day: string }[] } | { ok: false; reason: string }>;
  pullDay(day: string, wallet?: string): Promise<{ ok: true; payloads: ArchivePayload[] } | { ok: false; reason: string }>;
}

export interface BuildPeExportInput {
  /** Every device store to export, this machine's configured device first. */
  readonly stores: readonly PeStore[];
  readonly owner: { readonly wallet_id: string | null; readonly address: string | null };
  /** The agent's paid PE Archive (null: none reachable here — e.g. no device credentials). */
  readonly archive?: PeExportArchiveSource | null;
  /** Fetches anchoring records for received PEs that have none kept (`POST /v1/meter/batch-proofs`). */
  readonly batchProofs?: Pick<MeterTransport, 'getBatchProofs'> | null;
  /**
   * What draining the relay mailbox just before this export left on the relay (export-local.ts
   * drains first). Absent → the mailbox was not checked, and the export names that.
   */
  readonly mailbox?: PeExportMailboxState | null;
  /** Where a record fetched now is kept (default: the first store). */
  readonly keepIn?: PeStore | null;
  readonly producerVersion?: string;
  readonly now?: () => number;
}

/** The relay mailbox after the export's drain (PEs sealed to the agent and not filed here). */
export interface PeExportMailboxState {
  /** Mailbox items still on the relay that no store here has filed (null: could not be counted). */
  readonly waiting: number | null;
  /** More mailbox pages remained than were read: `waiting` is a lower bound. */
  readonly truncated: boolean;
  /** Why they stay there (e.g. `no_message_key_here`, `unopenable`, `mailbox_unreachable`), or null. */
  readonly reason: string | null;
}

export interface IncompleteEntry {
  readonly what: string;
  readonly reason: string;
}

export interface BuiltPeExport {
  readonly text: string;
  readonly header: ExportHeader;
  readonly counts: { readonly pe: number; readonly batch: number; readonly received: number; readonly legacy: number };
  readonly incomplete: readonly IncompleteEntry[];
}

// ─── helpers ────────────────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;

function exportAnchorOf(a: MeterAnchorProofWire): ExportBatchAnchor {
  return {
    day: a.day,
    anchor_batch_id: a.anchor_batch_id,
    ...(a.segment !== undefined ? { segment: a.segment } : {}),
    leaf_index: a.leaf_index,
    leaf_count: a.leaf_count,
    leaf_hash: a.leaf_hash,
    proof: [...a.proof],
    merkle_root: a.merkle_root,
    tx_hash: a.anchor_tx_hash,
  };
}

/** The batch leaf of an own batch (null when the batch's identity is not fully known). */
function ownBatchLeaf(deviceId: string, b: AcceptedBatch): string | null {
  if (b.adopted === true || b.acts_root === null || b.actor_id === null) return null;
  try {
    return batchLeafOf({ device_id: deviceId, actor_id: b.actor_id, seq: b.seq, batch_hash: b.batch_hash, acts_root: b.acts_root });
  } catch {
    return null;
  }
}

/** The kept anchor proof of an own batch, only when it is verified and binds this exact batch leaf. */
function usableProof(proofs: readonly StoredBatchProof[], b: AcceptedBatch, leaf: string | null): { proof: StoredBatchProof | null; unusable: boolean } {
  const matching = proofs.filter((p) => p.seq === b.seq && p.batch_hash === b.batch_hash);
  const good = matching.find((p) => p.verified && leaf !== null && p.batch_leaf === leaf && p.acts_root === b.acts_root);
  return { proof: good ?? null, unusable: good === undefined && matching.length > 0 };
}

/** Rows of a store that has no `listChainRows` (an operator's own store): every PE it can read. */
async function fallbackRows(store: PeStore): Promise<PeChainRow[]> {
  const head = await store.head();
  const live = new Map((await store.readPes(0, head.count)).map((p) => [p.index, p]));
  const rows: PeChainRow[] = [];
  for (let i = 0; i < head.count; i++) {
    const stored = live.get(i);
    rows.push(stored !== undefined
      ? { kind: 'pe', index: i, stored }
      : { kind: 'unreadable', index: i, detail: 'this store does not expose the PE at this position' });
  }
  return rows;
}

function withHash(pe: PeV2, hash: string): PeV2WithHash {
  return { ...pe, pe_hash: hash } as PeV2WithHash;
}

// ─── building ───────────────────────────────────────────────────────────────────

export async function buildPeExport(input: BuildPeExportInput): Promise<BuiltPeExport> {
  const now = input.now ?? Date.now;
  const stores = input.stores;
  if (stores.length === 0) throw new Error('pe_export_no_store');
  const incomplete: IncompleteEntry[] = [];
  const devices = stores.map((s) => s.deviceId);

  // 1. Every line of every local chain.
  const rowsByStore = new Map<PeStore, PeChainRow[]>();
  for (const store of stores) {
    const rows = store.listChainRows ? await store.listChainRows() : await fallbackRows(store);
    rowsByStore.set(store, rows);
    for (const r of rows) {
      if (r.kind === 'unreadable') incomplete.push({ what: `pe ${store.deviceId}#${r.index}`, reason: `local_store_line_unreadable: ${r.detail}` });
    }
  }

  // 2. The Archive: its state, every day it holds, and every day a pointer names. Each pulled once.
  let archiveState: 'on' | 'off' | 'unknown' = 'unknown';
  const dayKeys = new Map<string, { wallet: string; day: string }>();
  const addDay = (wallet: string, day: string): void => {
    dayKeys.set(`${wallet}\u0000${day}`, { wallet, day });
  };
  const archive = input.archive ?? null;
  if (archive === null) {
    incomplete.push({ what: 'archive', reason: 'archive_unreachable_here: no device credentials on this machine, so the PE Archive cannot be listed or opened' });
  } else {
    const status = await archive.readStatus();
    if (!status.ok) {
      incomplete.push({ what: 'archive', reason: status.reason });
    } else {
      archiveState = status.on ? 'on' : 'off';
      const listed = await archive.listDays();
      if (!listed.ok) incomplete.push({ what: `archive days of ${status.wallet}`, reason: listed.reason });
      else for (const d of listed.days) addDay(status.wallet, d.day);
    }
  }
  for (const rows of rowsByStore.values()) {
    for (const r of rows) if (r.kind === 'pointer') addDay(r.stub.wallet, r.stub.day);
  }
  const archiveDays: { wallet: string; day: string; pulled: boolean; reason: string | null }[] = [];
  /** device \0 index → the archived entry (first copy seen). */
  const archived = new Map<string, { entry: ArchiveEntry; device_id: string; wallet: string; day: string }>();
  const pulledDays = new Set<string>();
  const sortedDays = [...dayKeys.values()].sort((a, b) => (a.wallet === b.wallet ? (a.day < b.day ? -1 : 1) : a.wallet < b.wallet ? -1 : 1));
  for (const { wallet, day } of sortedDays) {
    const pulled = archive === null ? { ok: false as const, reason: 'archive_unreachable_here' } : await archive.pullDay(day, wallet);
    archiveDays.push({ wallet, day, pulled: pulled.ok, reason: pulled.ok ? null : pulled.reason });
    if (!pulled.ok) {
      incomplete.push({ what: `archive day ${wallet} ${day}`, reason: pulled.reason });
      continue;
    }
    pulledDays.add(`${wallet}\u0000${day}`);
    for (const payload of pulled.payloads) {
      for (const entry of payload.entries) {
        const key = `${payload.device_id}\u0000${entry.index}`;
        const prior = archived.get(key);
        if (prior === undefined) archived.set(key, { entry, device_id: payload.device_id, wallet, day });
        else if (prior.entry.pe.pe_hash !== entry.pe.pe_hash) {
          incomplete.push({ what: `pe ${payload.device_id}#${entry.index}`, reason: `archive_copies_differ: ${prior.day} holds ${prior.entry.pe.pe_hash}, ${day} holds ${entry.pe.pe_hash}` });
        }
      }
    }
  }

  // 2b. The relay mailbox: PEs sealed to the agent that are still waiting there are named by count.
  incomplete.push(...mailboxIncompleteOf(input.mailbox));

  // 3. Each local device's chain: what this machine holds, plus pointers resolved from the Archive.
  const peLines = new Map<string, Map<number, ExportPeLine>>();
  const emittedHash = new Map<string, string>();
  const refusedKeys = new Set<string>();
  const body: ExportBodyLine[] = [];
  for (const store of stores) {
    const deviceId = store.deviceId;
    const rows = rowsByStore.get(store) ?? [];
    const content = new Map<number, { pe: PeV2WithHash; archivedInclusion: ActInclusionProof | null }>();
    for (const r of rows) {
      if (r.kind === 'pe') {
        content.set(r.index, { pe: r.stored.pe, archivedInclusion: null });
      } else if (r.kind === 'pointer') {
        const key = `${deviceId}\u0000${r.index}`;
        const got = archived.get(key);
        if (got === undefined) {
          if (pulledDays.has(`${r.stub.wallet}\u0000${r.stub.day}`)) {
            incomplete.push({ what: `pe ${deviceId}#${r.index} (${r.stub.pe_id})`, reason: `not_in_archive_day: day ${r.stub.day} was pulled but does not hold it` });
          }
          continue;
        }
        if (got.entry.pe.pe_hash !== r.stub.pe_hash || got.entry.pe.pe_id !== r.stub.pe_id) {
          refusedKeys.add(key);
          incomplete.push({
            what: `pe ${deviceId}#${r.index} (${r.stub.pe_id})`,
            reason: `archive_entry_differs_from_pointer: this machine kept ${r.stub.pe_hash}, the Archive holds ${got.entry.pe.pe_hash}; not included`,
          });
          continue;
        }
        content.set(r.index, { pe: got.entry.pe, archivedInclusion: got.entry.inclusion });
      }
    }

    // Statuses and inclusion proofs, computing each batch's act leaves once.
    const recordedBatches = await store.listBatches();
    // A restored complete record replaces its earlier catch-up placeholder in this view.
    // Raw log entries remain untouched, and conflicting complete records still get checked.
    const batches = recordedBatches.filter(b => !(b.adopted || b.acts_root === null || b.actor_id === null)
      || !recordedBatches.some(full => full.seq === b.seq && full.batch_hash === b.batch_hash
        && !full.adopted && full.acts_root !== null && full.actor_id !== null));
    const proofs = await store.listProofs();
    const lineOf = new Map<number, { status: ExportPeStatus; inclusion: ActInclusionProof | null }>();
    for (const b of batches) {
      const range: number[] = [];
      for (let i = b.first_index; i < b.first_index + b.count; i++) range.push(i);
      if (b.adopted === true || b.acts_root === null || b.actor_id === null) {
        for (const i of range) lineOf.set(i, { status: 'batch_composition_unknown', inclusion: null });
        continue;
      }
      const pes = range.map((i) => content.get(i)?.pe);
      if (pes.some((p) => p === undefined)) {
        for (const i of range) {
          if (content.has(i)) {
            lineOf.set(i, { status: 'proof_unavailable', inclusion: null });
            incomplete.push({ what: `pe ${deviceId}#${i}`, reason: `proof_unavailable: batch ${b.seq} cannot be rebuilt because a PE it carried is not in this export` });
          }
        }
        continue;
      }
      const leaves = (pes as PeV2WithHash[]).map((p) => actLeafOf(actRecordOf(p)));
      if (merkleRootOf(leaves) !== b.acts_root) {
        for (const i of range) lineOf.set(i, { status: 'acts_root_mismatch', inclusion: null });
        incomplete.push({ what: `batch ${deviceId}#${b.seq}`, reason: 'acts_root_mismatch: the PEs this store holds for the batch do not rebuild its acts_root (the store was altered)' });
        continue;
      }
      const leaf = ownBatchLeaf(deviceId, b);
      const { proof } = usableProof(proofs, b, leaf);
      const anchor = proof === null ? null : exportAnchorOf(proof.anchor);
      range.forEach((i, at) => {
        lineOf.set(i, {
          status: anchor === null ? 'not_anchored_yet' : 'anchored',
          inclusion: inclusionFromLeaves({
            leaves, at, device_id: deviceId, actor_id: b.actor_id as string, seq: b.seq, batch_hash: b.batch_hash,
            acts_root: b.acts_root as string, anchor,
          }),
        });
      });
    }

    const lines = new Map<number, ExportPeLine>();
    for (const [index, c] of [...content.entries()].sort((a, b) => a[0] - b[0])) {
      let status: ExportPeStatus;
      let inclusion: ActInclusionProof | null;
      let source: 'device' | 'archive' = 'device';
      if (c.archivedInclusion !== null) {
        source = 'archive';
        inclusion = withPinnedContract(c.archivedInclusion);
        status = inclusion.anchor !== undefined ? 'anchored' : 'not_anchored_yet';
      } else {
        const computed = lineOf.get(index);
        status = computed?.status ?? 'not_batched_yet';
        inclusion = computed?.inclusion ?? null;
      }
      lines.set(index, { type: 'pe', source, device_id: deviceId, index, pe: c.pe, status, inclusion });
      emittedHash.set(`${deviceId}\u0000${index}`, c.pe.pe_hash);
    }
    peLines.set(deviceId, lines);

    // This device's batches, with receipts and anchor proofs.
    for (const b of batches) {
      const leaf = ownBatchLeaf(deviceId, b);
      const { proof, unusable } = usableProof(proofs, b, leaf);
      if (unusable) incomplete.push({ what: `batch ${deviceId}#${b.seq}`, reason: 'anchor_proof_unverified: the relay\'s proof does not match this machine\'s batch record; not included' });
      const receipt = b.adopted === true ? null : await store.readReceipt(b.seq);
      body.push({
        type: 'batch',
        device_id: deviceId,
        seq: b.seq,
        batch_hash: b.batch_hash,
        prev_batch_hash: b.prev_batch_hash,
        acts_root: b.acts_root,
        actor_id: b.actor_id,
        first_index: b.first_index,
        count: b.count,
        last_pe_hash: b.last_pe_hash,
        created_at_ms: b.created_at_ms,
        accepted_at_ms: b.accepted_at_ms,
        adopted: b.adopted === true,
        batch_leaf: leaf,
        receipt: receipt === null ? null : (receipt as unknown as Record<string, unknown>),
        anchor: proof === null ? null : exportAnchorOf(proof.anchor),
      });
    }
  }

  // 4. Archived chain positions not held here: other machines' chains, days dropped elsewhere.
  for (const [key, got] of archived) {
    if (refusedKeys.has(key)) continue;
    const held = emittedHash.get(key);
    if (held !== undefined) {
      if (held !== got.entry.pe.pe_hash) {
        incomplete.push({
          what: `pe ${got.device_id}#${got.entry.index}`,
          reason: `archive_copy_differs: this machine holds ${held}, the Archive (day ${got.day}) holds ${got.entry.pe.pe_hash}; the copy here is included`,
        });
      }
      continue;
    }
    const inclusion = withPinnedContract(got.entry.inclusion);
    const lines = peLines.get(got.device_id) ?? new Map<number, ExportPeLine>();
    peLines.set(got.device_id, lines);
    lines.set(got.entry.index, {
      type: 'pe', source: 'archive', device_id: got.device_id, index: got.entry.index, pe: got.entry.pe,
      status: inclusion.anchor !== undefined ? 'anchored' : 'not_anchored_yet', inclusion,
    });
    emittedHash.set(key, got.entry.pe.pe_hash);
  }
  const deviceOrder = [...devices, ...[...peLines.keys()].filter((d) => !devices.includes(d)).sort()];
  // Chains of other machines reach this file only through the Archive: name what that leaves out.
  const otherMachines = deviceOrder.filter((d) => !devices.includes(d));
  if (archiveState !== 'on') {
    incomplete.push({
      what: 'chains this agent recorded on other machines',
      reason: `only_this_machine: this export holds the device chain(s) on this machine (${devices.join(', ')}); a chain recorded on another machine is kept there (run export-pes there) and reaches this file only through the paid PE Archive, which ${archiveState === 'off' ? 'is off for this agent' : 'could not be read here'}`,
    });
  } else if (otherMachines.length > 0) {
    incomplete.push({
      what: `PEs recorded on ${otherMachines.join(', ')} since that machine's last Archive day`,
      reason: 'kept_on_that_machine: the Archive holds closed days only; the newest PEs of another machine are kept there until its next Archive upload (run export-pes there)',
    });
  }
  const peBody: ExportBodyLine[] = [];
  for (const d of deviceOrder) {
    const lines = peLines.get(d);
    if (lines === undefined) continue;
    for (const index of [...lines.keys()].sort((a, b) => a - b)) peBody.push(lines.get(index) as ExportPeLine);
  }

  // 5. PEs sealed to the agent, with proofs from the kept batch records (fetched now when missing).
  const received: ReceivedPe[] = [];
  const seenMailbox = new Set<string>();
  const kept = new Map<string, ReceivedBatchProof>();
  for (const store of stores) {
    for (const r of await store.listReceived()) {
      if (seenMailbox.has(r.mailbox_id)) continue;
      seenMailbox.add(r.mailbox_id);
      received.push(r);
    }
    for (const p of (await store.listReceivedProofs?.()) ?? []) {
      const prior = kept.get(p.batch_hash);
      if (prior === undefined || (!prior.anchored && p.anchored)) kept.set(p.batch_hash, p);
    }
  }
  const needed = receivedBatchHashes(received).filter((h) => kept.get(h)?.anchored !== true);
  let fetched: BatchProofsFetch | null = null;
  if (needed.length > 0 && input.batchProofs) {
    fetched = await fetchBatchProofs(input.batchProofs, needed, now());
    const keepIn = input.keepIn ?? stores[0];
    for (const [hash, proof] of fetched.answers) {
      kept.set(hash, proof);
      if (proof.anchored && keepIn.recordReceivedProof) await keepIn.recordReceivedProof(proof);
    }
  }
  const byBatch = new Map<string, { pe: PeV2WithHash }[]>();
  for (const r of received) {
    const list = byBatch.get(r.batch_hash) ?? [];
    list.push({ pe: withHash(r.pe, r.pe_hash) });
    byBatch.set(r.batch_hash, list);
  }
  const unavailable = (r: ReceivedPe): string => {
    if (!HEX64.test(r.batch_hash)) return 'batch_hash_unknown: the mailbox item did not name its batch';
    if (fetched === null) return input.batchProofs ? 'not_fetched' : 'relay_unreachable_here: no device credentials on this machine to fetch the batch record';
    const refused = fetched.refused.get(r.batch_hash);
    if (refused !== undefined) return `relay_answer_refused: ${refused}`;
    if (fetched.missing.has(r.batch_hash)) return 'relay_no_longer_holds_batch: its record is dropped 30 days after the anchor and none was kept here';
    return fetched.error ?? 'not_answered';
  };
  for (const r of received) {
    const pe = withHash(r.pe, r.pe_hash);
    const fromDevice = r.from_device.length > 0 ? r.from_device : r.pe.device_id;
    const answer = kept.get(r.batch_hash);
    let status: ExportPeStatus;
    let inclusion: ActInclusionProof | null = null;
    let why: string | null = null;
    if (r.pe.schema !== PE_V2_SCHEMA) {
      status = 'proof_unavailable';
      why = 'not_a_pe_v2';
    } else if (answer === undefined) {
      status = 'proof_unavailable';
      why = unavailable(r);
    } else if (answer.device_id !== fromDevice) {
      status = 'proof_unavailable';
      why = `relay_record_names_another_device: ${answer.device_id}`;
    } else {
      const anchor = answer.anchored && answer.anchor !== null ? exportAnchorOf(answer.anchor) : null;
      const identity = { device_id: answer.device_id, actor_id: answer.actor_id, seq: answer.seq, batch_hash: answer.batch_hash, acts_root: answer.acts_root, anchor };
      if (answer.act_leaves !== null) {
        const at = answer.act_leaves.indexOf(actLeafOf(actRecordOf(pe)));
        if (at === -1) {
          status = 'proof_unavailable';
          why = 'received_pe_not_in_named_batch: its act leaf is not among the batch\'s act leaves';
        } else {
          inclusion = inclusionFromLeaves({ ...identity, leaves: answer.act_leaves, at });
          status = anchor === null ? 'not_anchored_yet' : 'anchored';
        }
      } else {
        const ordered = chainOrderOf(byBatch.get(r.batch_hash) ?? []);
        const at = ordered === null ? -1 : ordered.findIndex((x) => x.pe.pe_hash === pe.pe_hash);
        if (ordered === null || at === -1) {
          status = 'proof_unavailable';
          why = 'batch_composition_unknown: the relay did not record this batch\'s act leaves and the copies held here do not form one run';
        } else {
          const built = inclusionFromBatch({ ...identity, pes: ordered.map((x) => x.pe), at });
          if (!built.ok) {
            status = 'acts_root_mismatch';
            why = `acts_root_mismatch: the ${ordered.length} PE(s) of this batch held here do not rebuild its acts_root (the batch carried others not sealed to this agent)`;
          } else {
            inclusion = built.inclusion;
            status = anchor === null ? 'not_anchored_yet' : 'anchored';
          }
        }
      }
    }
    if (why !== null) incomplete.push({ what: `received ${r.mailbox_id} (${r.pe_id})`, reason: why });
    const line: ExportReceivedLine = {
      type: 'received', source: 'device', mailbox_id: r.mailbox_id, from_actor: r.from_actor, from_device: fromDevice,
      batch_hash: r.batch_hash, received_at_ms: r.received_at_ms, pe, status, inclusion,
    };
    body.push(line);
  }

  // 6. Pre-meter records handed back, verbatim.
  const seenLegacy = new Set<string>();
  for (const store of stores) {
    for (const l of await store.listLegacy()) {
      if (seenLegacy.has(l.pe_id)) continue;
      seenLegacy.add(l.pe_id);
      const hash = typeof l.envelope.hash === 'string' ? l.envelope.hash : null;
      body.push({ type: 'legacy', source: 'handed_back', id: l.pe_id, hash, record: l.envelope, status: 'pre_meter' });
    }
  }

  const header: ExportHeader = {
    type: 'header',
    schema: PE_EXPORT_SCHEMA,
    spec: PE_EXPORT_SPEC_URL,
    exported_at_ms: now(),
    producer: { kind: 'sdk', version: input.producerVersion ?? SDK_VERSION },
    owner: { kind: 'agent', wallet_id: input.owner.wallet_id, address: input.owner.address },
    anchor: PE_EXPORT_ANCHOR_RULES,
    devices,
    archive: { state: archiveState, days: archiveDays },
  };
  const all = [...peBody, ...body];
  const text = serializeExport(header, all, incomplete);
  const counts = { pe: 0, batch: 0, received: 0, legacy: 0 };
  for (const l of all) counts[l.type] += 1;
  return { text, header, counts, incomplete };
}

// ─── the mailbox ────────────────────────────────────────────────────────────────

/** The `incomplete` entries for the mailbox state the export was given (none when nothing waits). */
export function mailboxIncompleteOf(state: PeExportMailboxState | null | undefined): IncompleteEntry[] {
  if (state === undefined || state === null) {
    return [{ what: 'mailbox: PEs sealed to this agent waiting on the relay', reason: 'mailbox_not_checked: this export did not drain the relay mailbox, so PEs sealed to this agent and not filed here may be missing' }];
  }
  if (state.waiting === null) {
    return [{ what: 'mailbox: PEs sealed to this agent waiting on the relay', reason: `mailbox_not_counted: ${state.reason ?? 'the relay mailbox could not be read'}` }];
  }
  if (state.waiting === 0 && !state.truncated) return [];
  return [{
    what: `mailbox: ${state.truncated ? 'at least ' : ''}${state.waiting} PE(s) sealed to this agent still waiting on the relay`,
    reason: state.reason ?? 'not_filed_here',
  }];
}

export interface MailboxDrainForExportDeps {
  /** One drain of the mailbox into the store (`MeterBatcher.drainMailbox`). */
  readonly drain: () => Promise<{ readonly ok: boolean; readonly received: number; readonly skipped: 'no_key' | null; readonly unopenable: number }>;
  /** One page of the mailbox (`MeterTransport.getMailbox`). */
  readonly getMailbox: MeterTransport['getMailbox'];
  /** Every mailbox id already filed by a store here (received + legacy). */
  readonly filedIds: () => Promise<ReadonlySet<string>>;
  /** Pages read when counting what is left (default 200 × 100 items). */
  readonly maxPages?: number;
  /** Drains run while each one files something (default 20: a migrated history of many pages). */
  readonly maxDrains?: number;
}

/**
 * Drain the relay mailbox before an export — file every PE sealed to the agent that this key can
 * open — then count what is still there and not filed here. Never throws.
 */
export async function drainMailboxForExport(deps: MailboxDrainForExportDeps): Promise<PeExportMailboxState> {
  let reason: string | null = null;
  let unopenable = 0;
  try {
    for (let i = 0; i < (deps.maxDrains ?? 20); i++) {
      const report = await deps.drain();
      if (!report.ok) {
        reason = 'mailbox_unreachable: the relay mailbox could not be read';
        break;
      }
      if (report.skipped === 'no_key') {
        reason = 'no_message_key_here: this agent\'s keystore (and its passphrase) is not on this machine, so PEs sealed to it cannot be opened here';
        break;
      }
      unopenable = report.unopenable;
      if (report.received === 0) break;
    }
  } catch (err) {
    reason = `mailbox_drain_failed: ${(err as Error).message}`;
  }
  let filed: ReadonlySet<string>;
  try {
    filed = await deps.filedIds();
  } catch (err) {
    return { waiting: null, truncated: false, reason: `local_store_unreadable: ${(err as Error).message}` };
  }
  let waiting = 0;
  let after: string | null = null;
  let truncated = true;
  try {
    for (let page = 0; page < (deps.maxPages ?? 200); page++) {
      const answer = await deps.getMailbox(after, 100);
      const body = answer.body as { items?: unknown; next?: unknown } | null;
      if (answer.status !== 200 || body === null || typeof body !== 'object' || !Array.isArray(body.items)) {
        return { waiting: null, truncated: false, reason: reason ?? `mailbox_unreachable: the relay answered ${answer.status}` };
      }
      for (const raw of body.items as unknown[]) {
        const id = raw !== null && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
        if (typeof id === 'string' && !filed.has(id)) waiting += 1;
      }
      if (typeof body.next !== 'string' || body.next.length === 0) {
        truncated = false;
        break;
      }
      after = body.next;
    }
  } catch (err) {
    return { waiting: null, truncated: false, reason: reason ?? `mailbox_unreachable: ${(err as Error).message}` };
  }
  if (reason === null && waiting > 0) {
    reason = unopenable > 0
      ? `unopenable: ${unopenable} item(s) this agent's key cannot open, or whose opened PE is not the PE it names, were left on the relay`
      : 'not_filed_here';
  }
  return { waiting, truncated, reason };
}

// ─── self-check ─────────────────────────────────────────────────────────────────

export interface PeExportSelfCheck {
  /** No failure: every line that claims a proof verifies offline up to its day root. */
  readonly ok: boolean;
  readonly parse_error: string | null;
  readonly failures: ExportOfflineReport['failures'];
  /** Gaps in a chain listed under `devices` (PEs this machine's store should have supplied). */
  readonly gaps_in_listed_devices: ExportOfflineReport['gaps'];
  /** Gaps in chains known only from the Archive (days never archived). */
  readonly gaps_archive_only: ExportOfflineReport['gaps'];
  readonly counts: ExportOfflineReport['counts'] | null;
  readonly pending: number;
  readonly day_roots: number;
}

/** Verify an export text offline exactly as a third party would. */
export function selfCheckPeExport(text: string): PeExportSelfCheck {
  const parsed = parseExport(text);
  if (!parsed.ok) {
    return { ok: false, parse_error: `${parsed.error}${parsed.line !== undefined ? ` (line ${parsed.line})` : ''}`, failures: [], gaps_in_listed_devices: [], gaps_archive_only: [], counts: null, pending: 0, day_roots: 0 };
  }
  const report = verifyExportOffline(parsed.body);
  const listed = new Set(parsed.header.devices);
  return {
    ok: report.failures.length === 0,
    parse_error: null,
    failures: report.failures,
    gaps_in_listed_devices: report.gaps.filter((g) => listed.has(g.device_id)),
    gaps_archive_only: report.gaps.filter((g) => !listed.has(g.device_id)),
    counts: report.counts,
    pending: report.pending.length,
    day_roots: report.anchors.length,
  };
}

// ─── local stores + writing ─────────────────────────────────────────────────────

const STORE_FILES = ['pes.jsonl', 'batches.jsonl', 'received.jsonl', 'legacy.jsonl'];

/** The device id a store directory belongs to (null when it cannot be told). */
function deviceIdOfDir(root: string, dir: string): string | null {
  if (/^dev_[A-Za-z0-9]{1,128}$/.test(dir)) return dir;
  // Another id shape (a ':' is written as '_'): read it from the chain's first PE.
  try {
    const first = fs.readFileSync(path.join(root, dir, 'pes.jsonl'), 'utf8').split('\n', 1)[0];
    const id = (JSON.parse(first) as { pe?: { device_id?: unknown } }).pe?.device_id;
    if (typeof id === 'string' && deviceDirName(id) === dir) return id;
  } catch {
    /* not a device store */
  }
  return null;
}

/**
 * Every device store under the root (the configured device first, even before its directory
 * exists). A directory whose device cannot be told is returned in `unknown`.
 */
export function listLocalDeviceStores(root: string, configuredDeviceId: string | null): { stores: FsPeStore[]; unknown: string[] } {
  const ids: string[] = [];
  const unknown: string[] = [];
  if (configuredDeviceId) ids.push(configuredDeviceId);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root).sort();
  } catch {
    entries = [];
  }
  for (const dir of entries) {
    const full = path.join(root, dir);
    let isDir = false;
    try { isDir = fs.statSync(full).isDirectory(); } catch { isDir = false; }
    if (!isDir || !STORE_FILES.some((f) => fs.existsSync(path.join(full, f)))) continue;
    const id = deviceIdOfDir(root, dir);
    if (id === null) {
      unknown.push(full);
      continue;
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return { stores: ids.map((id) => new FsPeStore(id, root)), unknown };
}

/** `provian-pe-export-<owner>-<YYYYMMDDTHHMMSSZ>.jsonl` */
export function defaultExportFileName(owner: string, atMs: number): string {
  const stamp = new Date(atMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `provian-pe-export-${owner.replace(/[^A-Za-z0-9_.-]/g, '_')}-${stamp}.jsonl`;
}

export interface PeExportResult {
  readonly status: 'ok' | 'error';
  readonly path: string;
  readonly bytes: number;
  readonly owner: ExportHeader['owner'];
  readonly devices: readonly string[];
  readonly counts: BuiltPeExport['counts'];
  readonly archive: { readonly state: string; readonly days: number; readonly pulled: number };
  /** Everything included in full, and no gap in a chain held here. */
  readonly complete: boolean;
  readonly incomplete: readonly IncompleteEntry[];
  readonly self_check: PeExportSelfCheck;
  readonly warning: string | null;
  readonly next: string;
}

/** Write an export atomically, private to this user (it holds the agent's PE content). */
export function writePeExportFile(filePath: string, text: string): void {
  atomicReplacePrivateFile(filePath, text);
}

/** Build, write (0600, atomic) and self-check one export. */
export async function exportPesToFile(input: BuildPeExportInput & { readonly out?: string | null; readonly cwd?: string }): Promise<PeExportResult> {
  const built = await buildPeExport(input);
  const owner = built.header.owner.wallet_id ?? input.stores[0].deviceId;
  const filePath = path.resolve(input.cwd ?? process.cwd(), input.out ?? defaultExportFileName(owner, built.header.exported_at_ms));
  writePeExportFile(filePath, built.text);
  const check = selfCheckPeExport(built.text);
  const warning = check.ok
    ? null
    : `THE LOCAL PE STORE IS CORRUPT: a fresh export failed its own verification (${check.parse_error ?? `${check.failures.length} failing line(s)`}). The file was written as found; do not alter the store — keep a copy of ${input.stores.map((s) => s.location).join(', ')} and report it.`;
  return {
    status: check.ok ? 'ok' : 'error',
    path: filePath,
    bytes: Buffer.byteLength(built.text, 'utf8'),
    owner: built.header.owner,
    devices: built.header.devices,
    counts: built.counts,
    archive: { state: built.header.archive.state, days: built.header.archive.days.length, pulled: built.header.archive.days.filter((d) => d.pulled).length },
    complete: built.incomplete.length === 0 && check.gaps_in_listed_devices.length === 0,
    incomplete: built.incomplete,
    self_check: check,
    warning,
    next: `verify it anywhere (only a Base RPC is contacted): provian verify-export ${filePath}`,
  };
}
