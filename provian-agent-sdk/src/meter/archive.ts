import { guardedFetch as fetch, guardedFetcher } from '../guarded-fetch';
/**
 * PE ARCHIVE — the device side of the paid PE Archive .
 *
 * "With the Archive on, once a day's PEs are confirmed in the Archive with their proofs, the
 * owner's devices and cloud backup drop that day, keeping only the most recent 30 days locally;
 * older PEs are pulled from the Archive when needed. When the paid space is used up and the next
 * GB isn't paid, new days stay on the owner's devices and cloud backup as before; nothing is
 * deleted."
 *
 * Once a day (the observer's tick), with the owner's Archive ON:
 * 1. UPLOAD every closed day since turn-on whose batches are all anchored (this device holds
 * each batch's anchor proof): its PEs, each with its inclusion proof, sealed on this machine
 * to the owner (and an agent's linked human) — `pe-archive-wire.ts`. A sealed part is kept in
 * a local outbox until the relay stores it, so a retry sends the same bytes. A 402
 * `archive_space_exhausted` stops uploading: the day stays here, nothing is dropped.
 * 2. DROP every day the relay reports CONFIRMED (its object matches the index and every batch is
 * anchored) that is 30+ days old — but only after this machine has pulled the day back, found
 * its own parts byte-identical to what the relay confirmed, opened them with the owner's key,
 * and matched every PE it is about to drop, field for field. Without the owner's key here,
 * nothing is dropped. The drop leaves a pointer per PE (`PeStore.dropArchivedDay`).
 * `uploadHistory` uploads older days the device still holds (an explicit command). `findArchivedPe`
 * pulls a dropped PE's day back so it presents exactly like a local one.
 */

import * as fs from 'fs';
import * as path from 'path';
import { x25519 } from '@noble/curves/ed25519';
import {
  archiveDayDroppable,
  archiveDayOf,
  buildArchiveEntries,
  bytesToB64u,
  findArchivedEntry,
  openArchivePart,
  parseArchivePart,
  planArchiveParts,
  sealArchivePart,
  splitArchiveObject,
  type ArchiveBatchInput,
  type ArchiveEntry,
  type ArchivePayload,
  type ArchiveRecipient,
} from '../pe-archive-wire';
import { canonicalJson, utf8Bytes } from '../meter-wire';
import type { ArchiveRandomBytes } from '../pe-archive-crypto';
import type { ArchiveBatchRef } from '../pe-archive-wire';
import { archivePayloadNeedsSegmentRepair, repairArchivePayloadSegments } from '../pe-export-wire';
import { archiveCacheKey, type ArchiveObjectCache } from './archive-cache';
import type { ArchiveLocalState, PeStore, StoredPe } from './pe-store';
import type { MeterAnswer } from './transport';

export const ARCHIVE_RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Retry soon after a failed run (relay down), never a tight loop. */
export const ARCHIVE_RETRY_MS = 60 * 60 * 1000;

export type ArchiveLog = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;

export interface ArchiveObjectAnswer {
  readonly status: number | null;
  readonly bytes: Uint8Array | null;
  readonly error: string | null;
}

/** The device-authenticated `/v1/archive/device/*` surface. */
export interface ArchiveTransport {
  getDayProofs?(day: string): Promise<MeterAnswer>;
  getStatus(): Promise<MeterAnswer>;
  uploadPart(line: string): Promise<MeterAnswer>;
  listDays(after: string | null): Promise<MeterAnswer>;
  getDayObject(day: string): Promise<ArchiveObjectAnswer>;
}

export interface HttpArchiveTransportOptions {
  readonly relayUrl: string;
  readonly boundEnvelope: (body: Record<string, unknown>, path: string) => Promise<{ headers: Record<string, string>; body: string }>;
  readonly authHeaders: () => Record<string, string>;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

export function createHttpArchiveTransport(options: HttpArchiveTransportOptions): ArchiveTransport {
  const doFetch = guardedFetcher(options.fetchImpl);
  const call = async (p: string, init: RequestInit, timeoutMs = options.timeoutMs): Promise<MeterAnswer> => {
    try {
      const response = await doFetch(`${options.relayUrl}${p}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      const text = await response.text().catch(() => '');
      let body: unknown = null;
      try { body = text.length > 0 ? JSON.parse(text) : null; } catch { body = null; }
      return { status: response.status, body, error: response.ok ? null : text.slice(0, 500) };
    } catch (err) {
      return { status: null, body: null, error: (err as Error).message };
    }
  };
  const get = (p: string): Promise<MeterAnswer> => call(p, { method: 'GET', headers: { accept: 'application/json', ...options.authHeaders() } });
  return {
    getDayProofs: (day) => get(`/v1/archive/device/days?day=${encodeURIComponent(day)}`),
    getStatus: () => get('/v1/archive/device'),
    async uploadPart(line: string): Promise<MeterAnswer> {
      let envelope: { headers: Record<string, string>; body: string };
      try {
        envelope = await options.boundEnvelope({ part: line }, '/v1/archive/device/parts');
      } catch (err) {
        return { status: null, body: null, error: `signing failed: ${(err as Error).message}` };
      }
      return call('/v1/archive/device/parts', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...envelope.headers }, body: envelope.body,
      }, Math.max(options.timeoutMs, 120_000));
    },
    listDays: (after) => get(`/v1/archive/device/days?limit=200${after ? `&after=${encodeURIComponent(after)}` : ''}`),
    async getDayObject(day: string): Promise<ArchiveObjectAnswer> {
      try {
        const response = await doFetch(`${options.relayUrl}/v1/archive/device/days/${encodeURIComponent(day)}/object`, {
          method: 'GET', headers: options.authHeaders(), signal: AbortSignal.timeout(Math.max(options.timeoutMs, 120_000)),
        });
        if (!response.ok) return { status: response.status, bytes: null, error: (await response.text().catch(() => '')).slice(0, 500) };
        return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()), error: null };
      } catch (err) {
        return { status: null, bytes: null, error: (err as Error).message };
      }
    },
  };
}

// ─── relay answers ──────────────────────────────────────────────────────────────

interface RelayStatus {
  readonly wallet: string;
  readonly on: boolean;
  readonly paid_bytes: number;
  readonly used_bytes: number;
  readonly space_exhausted: boolean;
  readonly turned_on_at_ms: number | null;
  readonly recipients: readonly { party_id: string; role: string; pubkey_b64u: string }[];
}

interface RelayDayPart {
  readonly device_id: string;
  readonly part: number;
  readonly sha256: string;
  readonly confirmed: boolean;
  readonly state: string;
  readonly batches: readonly { seq: number; batch_hash: string; first_index: number; count: number }[];
}

interface RelayDay {
  readonly day: string;
  readonly confirmed: boolean;
  readonly parts: readonly RelayDayPart[];
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function parseStatus(body: unknown): RelayStatus | null {
  if (!isRecord(body) || typeof body.wallet !== 'string' || !isRecord(body.archive)) return null;
  const a = body.archive;
  const recipients = Array.isArray(body.recipients)
    ? body.recipients.filter((r): r is { party_id: string; role: string; pubkey_b64u: string } => isRecord(r)
      && typeof r.party_id === 'string' && typeof r.role === 'string' && typeof r.pubkey_b64u === 'string')
    : [];
  return {
    wallet: body.wallet,
    on: a.on === true,
    paid_bytes: typeof a.paid_bytes === 'number' ? a.paid_bytes : 0,
    used_bytes: typeof a.used_bytes === 'number' ? a.used_bytes : 0,
    space_exhausted: a.space_exhausted === true,
    turned_on_at_ms: typeof a.turned_on_at_ms === 'number' ? a.turned_on_at_ms : null,
    recipients,
  };
}

function parseDays(body: unknown): RelayDay[] | null {
  if (!isRecord(body) || !Array.isArray(body.days)) return null;
  const out: RelayDay[] = [];
  for (const d of body.days) {
    if (!isRecord(d) || typeof d.day !== 'string' || !Array.isArray(d.parts)) continue;
    out.push({ day: d.day, confirmed: d.confirmed === true, parts: d.parts as RelayDayPart[] });
  }
  return out;
}

// ─── the keeper ─────────────────────────────────────────────────────────────────

export interface ArchiveKeeperOptions {
  readonly store: PeStore;
  readonly transport: ArchiveTransport;
  readonly log?: ArchiveLog;
  readonly now?: () => number;
  /**
   * The owner's x25519 message secret (an agent's `deriveMessageKeyPair(walletKey).secretKey`).
   * Needed to verify a day before dropping it and to open a pulled day. Zeroed after each use.
   * Absent / null → days are still uploaded (sealed to the published keys) but nothing is dropped.
   */
  readonly messageSecretKey?: () => Promise<Uint8Array | null>;
  /** The PEAnchor address carried in each archived PE's inclusion proof. */
  readonly anchorContract?: string;
  readonly randomBytes?: ArchiveRandomBytes;
  /**
   * Where a pulled day object (sealed ciphertext, as served) is kept so the next keeper — another
   * CLI call, a restarted daemon — opens it without re-fetching from Archive storage. Absent / null
   * → only this keeper's memory.
   */
  readonly objectCache?: ArchiveObjectCache | null;
}

export interface ArchivePullOptions {
  /** The relay's index for the day: a cached object whose part sha256s differ is not used. */
  readonly expectShas?: readonly string[];
  /** false → a fresh fetch is not written to the cache (a day being dropped stays off this machine). */
  readonly fill?: boolean;
  /** true → skip the cache and fetch. */
  readonly fresh?: boolean;
}

type PulledDay =
  | { ok: true; payloads: ArchivePayload[]; parts: { sha256: string; device_id: string; part: number }[]; source: 'cache' | 'archive' }
  | { ok: false; reason: string };

export interface ArchiveRunReport {
  readonly state: 'off' | 'ran' | 'error';
  readonly uploaded_days: number;
  readonly dropped_days: number;
  readonly dropped_pes: number;
  readonly space_exhausted: boolean;
  readonly detail: string | null;
}

interface DayPlan {
  readonly day: string;
  readonly batches: ArchiveBatchInput[];
}

export class ArchiveKeeper {
  private readonly store: PeStore;
  private readonly transport: ArchiveTransport;
  private readonly log: ArchiveLog;
  private readonly now: () => number;
  private nextRunAtMs = 0;
  private running: Promise<ArchiveRunReport> | null = null;
  private noKeyLogged = false;
  private readonly memoryOutbox = new Map<string, string>();
  private readonly pulled = new Map<string, { payloads: ArchivePayload[]; source: 'cache' | 'archive' }>();

  constructor(private readonly options: ArchiveKeeperOptions) {
    this.store = options.store;
    this.transport = options.transport;
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
  }

  /** The observer's schedule: run once a day (sooner after a failure). Never throws. */
  async tick(): Promise<ArchiveRunReport | null> {
    if (this.now() < this.nextRunAtMs) return null;
    const report = await this.run();
    this.nextRunAtMs = this.now() + (report.state === 'error' ? ARCHIVE_RETRY_MS : ARCHIVE_RUN_INTERVAL_MS);
    return report;
  }

  /** Upload ready days since turn-on, then drop confirmed days older than 30 days. Single-flight. */
  async run(options: { readonly history?: boolean } = {}): Promise<ArchiveRunReport> {
    if (this.running) return this.running;
    this.running = this.runOnce(options.history === true)
      .catch((err): ArchiveRunReport => {
        this.log('warn', 'pe archive run failed; it is retried', { error: (err as Error).message });
        return { state: 'error', uploaded_days: 0, dropped_days: 0, dropped_pes: 0, space_exhausted: false, detail: (err as Error).message };
      })
      .finally(() => { this.running = null; });
    return this.running;
  }

  /** Upload every day this device still holds that the Archive does not, including days before turn-on. */
  async uploadHistory(): Promise<ArchiveRunReport> {
    return this.run({ history: true });
  }

  private async withSecret<T>(fn: (secret: Uint8Array) => Promise<T> | T): Promise<T | null> {
    const provider = this.options.messageSecretKey;
    const secret = provider ? await provider().catch(() => null) : null;
    if (secret === null) return null;
    try {
      return await fn(secret);
    } finally {
      secret.fill(0);
    }
  }

  private async saveState(patch: Partial<ArchiveLocalState>): Promise<void> {
    if (!this.store.setArchiveState) return;
    const prior = (await this.store.archiveState?.()) ?? null;
    const next: ArchiveLocalState = {
      on: false, wallet: null, paid_bytes: 0, used_bytes: 0, space_exhausted: false,
      days_uploaded: 0, days_confirmed: 0, days_dropped: 0, last_error: null,
      ...(prior ?? {}),
      ...patch,
      last_run_at_ms: this.now(),
    };
    await this.store.setArchiveState(next);
  }

  private async allRelayDays(): Promise<RelayDay[] | null> {
    const out: RelayDay[] = [];
    let after: string | null = null;
    for (let page = 0; page < 200; page++) {
      const answer = await this.transport.listDays(after);
      if (answer.status !== 200) return null;
      const days = parseDays(answer.body);
      if (days === null) return null;
      out.push(...days);
      const next = isRecord(answer.body) && typeof answer.body.next_after === 'string' ? answer.body.next_after : null;
      if (days.length < 200 || next === null) break;
      after = next;
    }
    return out;
  }

  private async runOnce(history: boolean): Promise<ArchiveRunReport> {
    const statusAnswer = await this.transport.getStatus();
    const status = statusAnswer.status === 200 ? parseStatus(statusAnswer.body) : null;
    if (status === null) {
      await this.saveState({ last_error: `status_unreadable:${statusAnswer.status ?? statusAnswer.error ?? 'no answer'}` });
      return { state: 'error', uploaded_days: 0, dropped_days: 0, dropped_pes: 0, space_exhausted: false, detail: 'status_unreadable' };
    }
    if (!status.on) {
      // Off: nothing is uploaded and NOTHING is dropped.
      await this.saveState({ on: false, wallet: status.wallet, paid_bytes: status.paid_bytes, used_bytes: status.used_bytes, space_exhausted: false, last_error: null });
      return { state: 'off', uploaded_days: 0, dropped_days: 0, dropped_pes: 0, space_exhausted: false, detail: null };
    }
    const relayDays = await this.allRelayDays();
    if (relayDays === null) {
      await this.saveState({ last_error: 'days_unreadable' });
      return { state: 'error', uploaded_days: 0, dropped_days: 0, dropped_pes: 0, space_exhausted: false, detail: 'days_unreadable' };
    }
    const recipients = await this.recipientsFor(status);
    let uploaded = 0;
    let exhausted = status.space_exhausted;
    let lastError: string | null = null;
    if (recipients === null) {
      lastError = 'owner_key_unavailable';
    } else {
      const up = await this.uploadReadyDays(status, relayDays, recipients, history);
      uploaded = up.uploaded;
      exhausted = exhausted || up.exhausted;
      lastError = up.error;
    }
    const days = (await this.allRelayDays()) ?? relayDays;
    const drop = await this.dropConfirmedDays(status.wallet, days);
    const confirmedDays = days.filter((d) => d.parts.some((p) => p.device_id === this.store.deviceId) && d.confirmed).length;
    const dropped = (await this.store.listArchivedDays?.())?.length ?? 0;
    await this.saveState({
      on: true, wallet: status.wallet, paid_bytes: status.paid_bytes, used_bytes: status.used_bytes,
      space_exhausted: exhausted, days_confirmed: confirmedDays, days_dropped: dropped,
      days_uploaded: days.filter((d) => d.parts.some((p) => p.device_id === this.store.deviceId)).length,
      last_error: lastError ?? drop.error,
    });
    if (exhausted) {
      this.log('warn', 'pe archive: Archive full — add 1 GB for $5 (`provian archive pay --yes`). Until then new days stay on this machine; nothing is deleted.');
    }
    return { state: 'ran', uploaded_days: uploaded, dropped_days: drop.days, dropped_pes: drop.pes, space_exhausted: exhausted, detail: lastError ?? drop.error };
  }

  /** Whom to seal to: the owner's published key (checked against this machine's own key when it has it) and the linked human's. */
  private async recipientsFor(status: RelayStatus): Promise<ArchiveRecipient[] | null> {
    const own = await this.withSecret((secret) => bytesToB64u(x25519.getPublicKey(secret)));
    const published = status.recipients.find((r) => r.role === 'owner');
    if (own !== null && published !== undefined && published.pubkey_b64u !== own) {
      this.log('error', 'pe archive: the owner key the relay publishes is not this machine\'s key; nothing is uploaded until they match', { wallet: status.wallet });
      return null;
    }
    const ownerKey = published?.pubkey_b64u ?? own;
    if (ownerKey === null) return null;
    const out: ArchiveRecipient[] = [{ party_id: status.wallet, pubkey_b64u: ownerKey }];
    for (const r of status.recipients) {
      if (r.role === 'linked_human' && r.party_id !== status.wallet) out.push({ party_id: r.party_id, pubkey_b64u: r.pubkey_b64u });
    }
    return out;
  }

  /** Closed days whose every batch this device holds with a verified anchor proof. */
  async readyDays(): Promise<DayPlan[]> {
    const proofs = new Map((await this.store.listProofs()).filter((p) => p.verified).map((p) => [p.seq, p]));
    const byDay = new Map<string, { ready: boolean; batches: ArchiveBatchInput[] }>();
    for (const b of await this.store.listBatches()) {
      if (b.adopted === true || b.acts_root === null || b.actor_id === null || b.accepted_at_ms === null) continue;
      const day = archiveDayOf(b.accepted_at_ms);
      const slot = byDay.get(day) ?? { ready: true, batches: [] };
      byDay.set(day, slot);
      const proof = proofs.get(b.seq);
      if (proof === undefined || proof.batch_hash !== b.batch_hash || proof.anchor.day !== day) {
        slot.ready = false;
        continue;
      }
      const pes: StoredPe[] = await this.store.readPes(b.first_index, b.count);
      if (pes.length !== b.count || pes.some((p, i) => p.index !== b.first_index + i)) {
        slot.ready = false; // some of its PEs are already dropped (or missing): never re-archived from here
        continue;
      }
      slot.batches.push({
        device_id: this.store.deviceId,
        actor_id: b.actor_id,
        seq: b.seq,
        batch_hash: b.batch_hash,
        acts_root: b.acts_root,
        batch_leaf: proof.batch_leaf,
        first_index: b.first_index,
        pes: pes.map((p) => p.pe),
        anchor: {
          day: proof.anchor.day,
          ...(proof.anchor.segment !== undefined ? { segment: proof.anchor.segment } : {}),
          anchor_batch_id: proof.anchor.anchor_batch_id,
          leaf_index: proof.anchor.leaf_index,
          proof: [...proof.anchor.proof],
          merkle_root: proof.anchor.merkle_root,
          tx_hash: proof.anchor.anchor_tx_hash,
        },
      });
    }
    return [...byDay.entries()]
      .filter(([, v]) => v.ready && v.batches.length > 0)
      .map(([day, v]) => ({ day, batches: v.batches.sort((a, b) => a.seq - b.seq) }))
      .sort((a, b) => (a.day < b.day ? -1 : 1));
  }

  // ── outbox: a sealed part is kept until the relay stores it, so a retry sends the same bytes ──

  private outboxPath(day: string, part: number): string | null {
    let isDir = false;
    try { isDir = fs.statSync(this.store.location).isDirectory(); } catch { isDir = false; }
    return isDir ? path.join(this.store.location, 'archive-outbox', `${day}.${part}.pea`) : null;
  }

  private readOutbox(day: string, part: number): string | null {
    const p = this.outboxPath(day, part);
    if (p === null) return this.memoryOutbox.get(`${day}.${part}`) ?? null;
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
  }

  private writeOutbox(day: string, part: number, line: string): void {
    const p = this.outboxPath(day, part);
    if (p === null) {
      this.memoryOutbox.set(`${day}.${part}`, line);
      return;
    }
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, line, { mode: 0o600 });
  }

  /** The sealed copy is ciphertext of PEs this store still holds; removing it removes no PE. */
  private clearOutbox(day: string, part: number): void {
    const p = this.outboxPath(day, part);
    if (p === null) {
      this.memoryOutbox.delete(`${day}.${part}`);
      return;
    }
    try { fs.unlinkSync(p); } catch { /* already gone */ }
  }

  private async uploadReadyDays(
    status: RelayStatus,
    relayDays: readonly RelayDay[],
    recipients: readonly ArchiveRecipient[],
    history: boolean,
  ): Promise<{ uploaded: number; exhausted: boolean; error: string | null }> {
    const held = new Map(relayDays.map((d) => [d.day, d]));
    const turnedOnDay = status.turned_on_at_ms !== null ? archiveDayOf(status.turned_on_at_ms) : null;
    let uploaded = 0;
    let error: string | null = null;
    for (const plan of await this.readyDays()) {
      if (!history && turnedOnDay !== null && plan.day < turnedOnDay) continue;
      const relay = held.get(plan.day);
      const mine = relay?.parts.filter((p) => p.device_id === this.store.deviceId) ?? [];
      const archivedSeqs = new Set(mine.flatMap((p) => p.batches.map((b) => b.seq)));
      if (plan.batches.every((b) => archivedSeqs.has(b.seq))) continue;
      const parts = planArchiveParts(plan.batches);
      for (let n = 0; n < parts.length; n++) {
        const already = mine.find((p) => p.part === n);
        if (already !== undefined && already.state === 'stored') {
          this.clearOutbox(plan.day, n);
          continue;
        }
        let line = this.readOutbox(plan.day, n);
        if (line === null) {
          const { entries, refs } = buildArchiveEntries(plan.day, parts[n], this.options.anchorContract ?? '');
          line = sealArchivePart({
            wallet: status.wallet, day: plan.day, device_id: this.store.deviceId, part: n, entries, refs, recipients,
            ...(this.options.randomBytes ? { randomBytes: this.options.randomBytes } : {}),
          }).line;
          this.writeOutbox(plan.day, n, line);
        }
        const answer = await this.transport.uploadPart(line);
        if (answer.status === 200 || answer.status === 201) {
          this.clearOutbox(plan.day, n);
          continue;
        }
        const code = isRecord(answer.body) && typeof answer.body.error === 'string' ? answer.body.error : `http_${answer.status ?? 'none'}`;
        if (answer.status === 402) {
          // Archive full (or no paid space): stop; every day not stored stays on this machine.
          return { uploaded, exhausted: code === 'archive_space_exhausted' || code === 'archive_not_on', error: code };
        }
        if (code === 'archive_part_conflict') {
          // Another sealing of this part is stored; ours is redundant ciphertext.
          this.clearOutbox(plan.day, n);
          continue;
        }
        error = code;
        this.log('warn', 'pe archive: a part was not stored; it is retried on the next run', { day: plan.day, part: n, error: code });
        break;
      }
      if (error === null) uploaded += 1;
    }
    if (uploaded > 0) this.log('info', 'pe archive: days uploaded', { uploaded });
    return { uploaded, exhausted: false, error };
  }

  /** The owner's Archive as the relay reports it (wallet, on/off), or why it could not be read. */
  async readStatus(): Promise<{ ok: true; wallet: string; on: boolean } | { ok: false; reason: string }> {
    const answer = await this.transport.getStatus();
    const status = answer.status === 200 ? parseStatus(answer.body) : null;
    if (status === null) return { ok: false, reason: `status_unreadable:${answer.status ?? answer.error ?? 'no answer'}` };
    return { ok: true, wallet: status.wallet, on: status.on };
  }

  /** Every day the owner's Archive holds (every device's parts), paged in full. */
  async listDays(): Promise<{ ok: true; days: { day: string; confirmed: boolean; devices: string[] }[] } | { ok: false; reason: string }> {
    const days = await this.allRelayDays();
    if (days === null) return { ok: false, reason: 'days_unreadable' };
    return {
      ok: true,
      days: days.map((d) => ({ day: d.day, confirmed: d.confirmed, devices: [...new Set(d.parts.map((p) => p.device_id))] })),
    };
  }

  /** Pull a day this owner archived and open every part of it this machine's key opens. Cache first, unless `fresh`. */
  async pullDay(day: string, wallet?: string, opts: ArchivePullOptions = {}): Promise<PulledDay> {
    const cache = this.options.objectCache ?? null;
    // The object belongs to the Archive's owner; `wallet` may instead name the party opening it.
    const owner = cache === null ? null : wallet ?? (await this.store.archiveState?.().catch(() => null))?.wallet ?? null;
    if (cache !== null && owner !== null && opts.fresh !== true) {
      const bytes = await cache.get(archiveCacheKey(owner, day)).catch(() => null);
      if (bytes !== null) {
        const fromCache = await this.openDayObject(bytes, wallet, { owner, expectShas: opts.expectShas });
        if (fromCache.ok) {
          this.pulled.set(day, { payloads: fromCache.payloads, source: 'cache' });
          return { ...fromCache, source: 'cache' };
        }
        if (fromCache.reason === 'owner_key_unavailable') return fromCache; // a fetch would not open either
        this.log('debug', 'pe archive: cached day not used; fetching it', { day, reason: fromCache.reason });
      }
    }
    const answer = await this.transport.getDayObject(day);
    if (answer.status !== 200 || answer.bytes === null) return { ok: false, reason: `archive_day_unreadable:${answer.status ?? answer.error ?? 'none'}` };
    const opened = await this.openDayObject(answer.bytes, wallet, null);
    if (!opened.ok) return opened;
    this.pulled.set(day, { payloads: opened.payloads, source: 'archive' });
    if (cache !== null && owner !== null && opts.fill !== false && opened.owners.every((w) => w === owner)) {
      try {
        await cache.put(archiveCacheKey(owner, day), answer.bytes);
      } catch (err) {
        this.log('warn', 'pe archive: a pulled day could not be cached; it is fetched again next time', { day, error: (err as Error).message });
      }
    }
    return { ok: true, payloads: opened.payloads, parts: opened.parts, source: 'archive' };
  }

  /** Split, parse, (for a cached object) check it is the owner's and matches the index, then open with the owner's key. */
  private async openDayObject(
    bytes: Uint8Array,
    wallet: string | undefined,
    cached: { owner: string; expectShas: readonly string[] | undefined } | null,
  ): Promise<{ ok: true; payloads: ArchivePayload[]; parts: { sha256: string; device_id: string; part: number }[]; owners: string[] } | { ok: false; reason: string }> {
    let lines: Uint8Array[];
    try {
      lines = splitArchiveObject(bytes);
    } catch {
      return { ok: false, reason: 'archive_object_torn' };
    }
    const opened = await this.withSecret((secret) => {
      const parsedParts: Extract<ReturnType<typeof parseArchivePart>, { ok: true }>[] = [];
      for (const line of lines) {
        const parsed = parseArchivePart(line);
        if (!parsed.ok) return { ok: false as const, reason: `archive_part_invalid:${parsed.error}` };
        parsedParts.push(parsed);
      }
      if (cached !== null) {
        if (parsedParts.length === 0 || parsedParts.some((p) => p.header.wallet !== cached.owner)) return { ok: false as const, reason: 'archive_cache_other_owner' };
        if (cached.expectShas !== undefined) {
          const want = new Set(cached.expectShas);
          const have = new Set(parsedParts.map((p) => p.sha256));
          if (want.size !== have.size || [...want].some((s) => !have.has(s))) return { ok: false as const, reason: 'archive_cache_differs_from_index' };
        }
      }
      const payloads: ArchivePayload[] = [];
      const parts: { sha256: string; device_id: string; part: number }[] = [];
      for (const parsed of parsedParts) {
        parts.push({ sha256: parsed.sha256, device_id: parsed.header.device_id, part: parsed.header.part });
        const open = openArchivePart(parsed.header, secret, wallet ?? parsed.header.wallet);
        if (!open.ok) return { ok: false as const, reason: `archive_part_unopenable:${open.error}` };
        payloads.push(open.payload);
      }
      return { ok: true as const, payloads, parts, owners: [...new Set(parsedParts.map((p) => p.header.wallet))] };
    });
    if (opened === null) return { ok: false, reason: 'owner_key_unavailable' };
    if (opened.ok && opened.payloads.some(archivePayloadNeedsSegmentRepair) && this.transport.getDayProofs) {
      try {
        const day = opened.payloads[0].day;
        const answer = await this.transport.getDayProofs(day);
        if (answer.status !== 200 || !isRecord(answer.body) || !Array.isArray(answer.body.days)) throw new Error('archive_proof_metadata_unavailable');
        const index = answer.body.days.find((d: unknown) => isRecord(d) && d.day === day && d.wallet === opened.payloads[0].wallet);
        if (!isRecord(index) || !Array.isArray(index.proof_repairs)) throw new Error('archive_proof_metadata_unavailable');
        return { ...opened, payloads: opened.payloads.map(p => repairArchivePayloadSegments(p, index.proof_repairs as ArchiveBatchRef[])) };
      } catch (err) { return { ok: false, reason: err instanceof Error ? err.message : 'archive_proof_repair_failed' }; }
    }
    return opened;
  }

  /** A PE dropped here after its day was archived: pulled back, verified against its pointer. */
  async findArchivedPe(peId: string): Promise<{ ok: true; entry: ArchiveEntry } | { ok: false; reason: string }> {
    const stub = await this.store.findArchived?.(peId);
    if (!stub) return { ok: false, reason: 'not_archived' };
    let held = this.pulled.get(stub.day) ?? null;
    if (held === null) {
      const pulled = await this.pullDay(stub.day, stub.wallet);
      if (!pulled.ok) return pulled;
      held = { payloads: pulled.payloads, source: pulled.source };
    }
    const matches = (e: ArchiveEntry | null): e is ArchiveEntry => e !== null && e.pe.pe_hash === stub.pe_hash && e.index === stub.index;
    let entry = findArchivedEntry(held.payloads, peId);
    if (!matches(entry) && held.source === 'cache') {
      // A stale cached copy: the Archive's own object decides.
      const fresh = await this.pullDay(stub.day, stub.wallet, { fresh: true });
      if (!fresh.ok) return fresh;
      entry = findArchivedEntry(fresh.payloads, peId);
    }
    if (!matches(entry)) return { ok: false, reason: 'archive_entry_mismatch' };
    return { ok: true, entry };
  }

  private async dropConfirmedDays(wallet: string, days: readonly RelayDay[]): Promise<{ days: number; pes: number; error: string | null }> {
    if (!this.store.dropArchivedDay) return { days: 0, pes: 0, error: null };
    let droppedDays = 0;
    let droppedPes = 0;
    let error: string | null = null;
    for (const d of days) {
      const mine = d.parts.filter((p) => p.device_id === this.store.deviceId);
      if (mine.length === 0 || !mine.every((p) => p.confirmed && p.state === 'stored')) continue;
      if (!archiveDayDroppable(d.day, this.now())) continue;
      // Which of this device's PEs the confirmed parts cover, still held in full here.
      const planned: StoredPe[] = [];
      for (const part of mine) {
        for (const b of part.batches) {
          for (const p of await this.store.readPes(b.first_index, b.count)) {
            if (p.index >= b.first_index && p.index < b.first_index + b.count) planned.push(p);
          }
        }
      }
      if (planned.length === 0) continue; // already dropped
      // Read the day back and verify it here before dropping anything. A cached copy serves only if it
      // is exactly the relay's index; a day being dropped is not written onto this machine.
      const pulled = await this.pullDay(d.day, wallet, {
        expectShas: d.parts.filter((p) => p.state === 'stored').map((p) => p.sha256),
        fill: false,
      });
      if (!pulled.ok) {
        if (pulled.reason === 'owner_key_unavailable') {
          if (!this.noKeyLogged) {
            this.noKeyLogged = true;
            this.log('info', 'pe archive: this agent\'s key is not available here, so archived days cannot be verified on this machine; nothing is dropped');
          }
          return { days: droppedDays, pes: droppedPes, error: 'owner_key_unavailable' };
        }
        error = pulled.reason;
        continue;
      }
      const confirmedShas = new Set(mine.map((p) => p.sha256));
      const objectShas = new Set(pulled.parts.filter((p) => p.device_id === this.store.deviceId).map((p) => p.sha256));
      if (confirmedShas.size !== objectShas.size || [...confirmedShas].some((s) => !objectShas.has(s))) {
        error = 'archive_object_differs_from_confirmed_index';
        continue;
      }
      const archived = new Map<number, ArchiveEntry>();
      for (const payload of pulled.payloads) {
        if (payload.device_id !== this.store.deviceId) continue;
        for (const e of payload.entries) archived.set(e.index, e);
      }
      const intact = planned.every((p) => {
        const e = archived.get(p.index);
        return e !== undefined && canonicalJson(e.pe) === canonicalJson(p.pe);
      });
      if (!intact) {
        error = 'archive_day_does_not_match_local_pes';
        this.log('error', 'pe archive: an archived day does not match the PEs held here; nothing dropped', { day: d.day });
        continue;
      }
      const result = await this.store.dropArchivedDay({
        day: d.day,
        wallet,
        pes: planned.map((p) => ({ index: p.index, pe_id: p.pe.pe_id, pe_hash: p.pe.pe_hash })),
        part_sha256s: [...confirmedShas].sort(),
      });
      droppedDays += 1;
      droppedPes += result.dropped;
    }
    if (droppedDays > 0) this.log('info', 'pe archive: confirmed days dropped from this machine (kept in the Archive; the last 30 days stay here)', { days: droppedDays, pes: droppedPes });
    return { days: droppedDays, pes: droppedPes, error };
  }
}

/** Bytes of a sealed part line (for tests and status). */
export function archiveLineBytes(line: string): number {
  return utf8Bytes(line).length;
}
