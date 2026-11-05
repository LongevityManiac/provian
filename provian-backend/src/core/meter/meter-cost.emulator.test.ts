import { PACKED_DAY_COUNTERS } from './packed-day-counters';
import { rawPrivateFirestore } from '../provenance/private-store';
/**
 * PE METER — MEASURED Firestore cost of one Atlas-sized agent (emulator; not an estimate).
 *
 * Skipped unless FIRESTORE_EMULATOR_HOST is set. Run on a private port:
 *
 *   (in a dir OUTSIDE the repo) firebase.json = {"emulators":{"firestore":{"port":8098,"host":"127.0.0.1"},"ui":{"enabled":false}}}
 *   JAVA_HOME=/opt/homebrew/opt/openjdk@21 npx -y firebase-tools@latest emulators:start --only firestore --project demo-cost
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8098 METER_COST_OUT=/tmp/meter-cost.json \
 *     npx jest src/core/meter/meter-cost.emulator.test.ts
 *
 * HOW OPS ARE COUNTED. The Firestore client's two wire funnels (`Firestore.prototype.request` and
 * `requestStream`) are wrapped, so every billed RPC the PRODUCTION code makes is counted however it
 * reaches Firestore (doc get, query, getAll, transactions, WriteBatch, BulkWriter, and any
 * `admin.firestore()` instance a module builds itself):
 *   - batchGetDocuments: 1 read per `found` and per `missing` (a get of an absent doc bills a read);
 *   - runQuery: 1 read per returned document, 1 read for a query that returns none;
 *   - runAggregationQuery: 1 read per started 1,000 counted entries (min 1);
 *   - commit / batchWrite: 1 write per update/set/create (transforms ride the same write), 1 delete
 *     per delete — counted only when the RPC succeeds (BulkWriter: per write with status OK).
 * The harness's own seeding and storage scans run with counting OFF.
 *
 * WHAT IS DRIVEN (all real code paths; only the chain and Redis are faked):
 *   - each batch (METER_COST_BATCHES_PER_DAY a day; 8 acts an hour, each with a sealed copy to the
 *     linked human): the daemon's `GET /v1/meter/seal-targets` and `POST /v1/meter/batch` through
 *     the real meter router and device-key auth with a body HMAC; every hour its
 *     `GET /v1/meter/mailbox`;
 *   - METER_COST_PHONE_DRAINS_PER_DAY times a day (default 1): the linked human's phone draining its mailbox (`listMailbox` + `ackMailbox`, the
 *     exact calls behind `GET /v1/meter/mobile/mailbox` and `POST …/ack`; wallet auth is Redis-only);
 *   - daily 00:25: `runDailyMeterAnchor` (fake PEAnchor contract), and at 12:30 the daemon's
 *     `GET /v1/meter/proofs`;
 *   - daily 12:00: the settlement run's meter half — `runMeterClaimInlet` (no escrow gate: escrow never holds earnings),
 *     signer lease, orphan retire, stranded-batch reconcile, cycle resolution, `runSettlementCycle`
 *     (fake kernel + fake verifier, real approval gate with `createMeterClaimVerifier`, real writeback
 *     incl. `settleMeterClaims`), lease release.
 * At the end of each simulated day every document is scanned and sized with Firestore's storage
 * rules (doc name + fields + 32; single-field and composite index entries from
 * `firestore.indexes.json` incl. fieldOverrides/exemptions).
 */
import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';
import { createHash, createHmac, generateKeyPairSync, randomBytes, scrypt } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { performance } from 'perf_hooks';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import { NOVELTY_COUNTERS_COLLECTION } from './batch-pricing-counters';
import { cloudRunSizing } from './__test-helpers__/cloud-run-sizing';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const suite = EMULATOR ? describe : describe.skip;
const PROJECT = process.env.METER_COST_PROJECT ?? 'demo-cost';
if (!/^demo-[a-z0-9-]+$/.test(PROJECT)) throw new Error('meter cost project must be emulator-only');
const PRIVATE_STORAGE = process.env.METER_COST_PRIVATE_STORE !== '0';
const PRICES = {
  nam5: { read: 0.06 / 100_000, write: 0.18 / 100_000, del: 0.02 / 100_000, gibMonth: 0.18 },
  'us-central1': { read: 0.03 / 100_000, write: 0.09 / 100_000, del: 0.01 / 100_000, gibMonth: 0.15 },
} as const;
const COST_REGION = process.env.METER_COST_REGION ?? 'nam5';
if (!Object.prototype.hasOwnProperty.call(PRICES, COST_REGION)) throw new Error(`unknown METER_COST_REGION ${COST_REGION}`);
const PRICE = PRICES[COST_REGION as keyof typeof PRICES];


const memory = new Map<string, unknown>();
jest.mock('../../cache', () => ({
  cache: {
    getUserDailyPECountStrict: async () => 0,
    getUserActionTypeCountStrict: async () => 0,
    isArtifactHashSeen: async () => false,
    recordArtifactHash: async () => {},
    incrementUserActionTypeCount: async () => 1,
    incrementHourlyPECount: async () => {},
    commitPEAccountingCountersOnce: async () => ({ idempotent: false }),
    checkRateLimit: async () => ({ allowed: true }),
    get: async (k: string) => memory.get(k) ?? null,
    set: async (k: string, v: unknown) => { memory.set(k, v); },
    del: async (k: string) => { memory.delete(k); },
    setBeneficiaryStatus: async () => {},
    getBeneficiaryStatus: async () => null,
    isEnabled: () => true,
  },
  CacheUnavailableError: class CacheUnavailableError extends Error {},
}));
// Exercise real signed activation selection: the unit-test policy shortcut would hide per-act reads.
jest.mock('../pvt/policy/runtime-monetary-policy', () => {
  const actual = jest.requireActual<typeof import('../pvt/policy/runtime-monetary-policy')>('../pvt/policy/runtime-monetary-policy');
  return { ...actual, loadRuntimeMonetaryPolicy: actual.loadActivatedRuntimeMonetaryPolicy };
});
jest.mock('../foundation-membership/client', () => ({
  loadFoundationMembershipConfig: () => ({ enabled: false }), queueInitialMembershipGrants: async () => {},
}));

jest.setTimeout(30 * 60_000);

// ─── simulation shape ─────────────────────────────────────────────────────────────
const DAYS = Number(process.env.METER_COST_DAYS ?? Math.max(100, 2 * Number(process.env.METER_COST_SETTLE_EVERY_DAYS ?? 1) + 68));
/** Acts per hour of agent work (the Atlas-sized mix below). */
const ACTS_PER_HOUR = 8;
/**
 * Batches per day: 24 = the original hourly cadence (the default, so the pinned fingerprint holds);
 * 1 = the daily cadence. A batch carries every act since the previous one.
 */
const BATCHES_PER_DAY = Number(process.env.METER_COST_BATCHES_PER_DAY ?? 24);
const HOURS_PER_BATCH = 24 / BATCHES_PER_DAY;
const ACTS_PER_BATCH = ACTS_PER_HOUR * HOURS_PER_BATCH;
/** The daily standard run uses each payee’s own N-day interval. */
const SETTLE_EVERY_DAYS = Number(process.env.METER_COST_SETTLE_EVERY_DAYS ?? 1);
/** The phone checks its mailbox once a day (: was hourly); 24 models the old cadence. */
const PHONE_DRAINS_PER_DAY = Number(process.env.METER_COST_PHONE_DRAINS_PER_DAY ?? 1);
/** `takeover_topup` adds the commit's forge witness (see `forgeWitness`); unset = the plain Atlas mix. */
const SCENARIO = process.env.METER_COST_SCENARIO ?? '';
if (SCENARIO !== '' && SCENARIO !== 'takeover_topup') throw new Error(`unknown METER_COST_SCENARIO ${SCENARIO}`);
if (SCENARIO === 'takeover_topup' && BATCHES_PER_DAY !== 1) throw new Error('takeover_topup models the daily cadence only');
/** Per hour of work: 6 tool-orchestration turns, 1 compute session, 1 coding session (commit). */
const MIX = ['agent_tool_orchestration', 'agent_tool_orchestration', 'agent_tool_orchestration',
  'agent_tool_orchestration', 'agent_tool_orchestration', 'agent_tool_orchestration',
  'compute_session', 'coding_session'] as const;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 9, 5); // 2026-10-05T00:00Z

// ─── op counting at the wire ──────────────────────────────────────────────────────
interface Counts { reads: number; missing: number; writes: number; deletes: number }
const zero = (): Counts => ({ reads: 0, missing: 0, writes: 0, deletes: 0 });
/** key = `${day}|${phase}` → collection → counts */
const tallies = new Map<string, Map<string, Counts>>();
let phase: string | null = null;
let currentDay = -1;
const runtimeSamples = new Map<string, { seconds: number; invocations: number; cpu_seconds: number }>();
let runtimeStarted = performance.now();
let cpuStarted = process.cpuUsage();
function setPhase(next: string | null): void {
  const now = performance.now(), cpu = process.cpuUsage(cpuStarted);
  if (phase !== null && currentDay >= 0) {
    const key = `${currentDay}|${phase}`, v = runtimeSamples.get(key) ?? { seconds: 0, invocations: 0, cpu_seconds: 0 };
    v.seconds += Math.ceil((now - runtimeStarted) / 100) / 10;
    v.cpu_seconds += (cpu.user + cpu.system) / 1_000_000; v.invocations++;
    runtimeSamples.set(key, v);
  }
  phase = next; runtimeStarted = now; cpuStarted = process.cpuUsage();
}

function bump(at: string | null, collection: string, field: keyof Counts, n = 1): void {
  if (at === null) return;
  const byColl = tallies.get(at) ?? new Map<string, Counts>();
  const c = byColl.get(collection) ?? zero();
  c[field] += n;
  byColl.set(collection, c);
  tallies.set(at, byColl);
}

/** `projects/p/databases/(default)/documents/a/b/c/d` → `a` (or `a/c` for a subcollection). */
function collectionOfName(name: string): string {
  const i = name.indexOf('/documents/');
  const segs = (i >= 0 ? name.slice(i + 11) : name).split('/');
  const colls: string[] = [];
  for (let k = 0; k < segs.length; k += 2) colls.push(segs[k]);
  return colls.join('/');
}

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function countWrites(at: string | null, request: unknown, response: unknown, method: string): void {
  const writes = obj(request)?.writes;
  if (!Array.isArray(writes)) return;
  const statuses = method === 'batchWrite' ? obj(response)?.status : null;
  writes.forEach((w, i) => {
    if (Array.isArray(statuses)) {
      const code = obj(statuses[i])?.code;
      if (typeof code === 'number' && code !== 0) return;
    }
    const write = obj(w);
    if (write === null) return;
    if (typeof write.delete === 'string') bump(at, collectionOfName(write.delete), 'deletes');
    else {
      const name = obj(write.update)?.name ?? obj(write.transform)?.document;
      bump(at, typeof name === 'string' ? collectionOfName(name) : '?', 'writes');
    }
  });
}

interface StreamLike { emit: (event: string | symbol, ...args: unknown[]) => boolean }

function instrumentStream(at: string | null, method: string, request: unknown, stream: StreamLike): void {
  let docs = 0;
  const original = stream.emit.bind(stream);
  const queryCollection = (): string => {
    const from = obj(obj(request)?.structuredQuery)?.from ?? obj(obj(obj(request)?.structuredAggregationQuery)?.structuredQuery)?.from;
    const first = Array.isArray(from) ? obj(from[0]) : null;
    return typeof first?.collectionId === 'string' ? first.collectionId : '?';
  };
  stream.emit = (event: string | symbol, ...args: unknown[]): boolean => {
    if (event === 'data') {
      const chunk = obj(args[0]);
      if (chunk !== null) {
        if (method === 'batchGetDocuments') {
          const found = obj(chunk.found);
          if (found !== null && typeof found.name === 'string') bump(at, collectionOfName(found.name), 'reads');
          else if (typeof chunk.missing === 'string') {
            bump(at, collectionOfName(chunk.missing), 'reads');
            bump(at, collectionOfName(chunk.missing), 'missing');
          }
        } else if (method === 'runQuery') {
          const doc = obj(chunk.document);
          if (doc !== null && typeof doc.name === 'string') {
            docs += 1;
            bump(at, collectionOfName(doc.name), 'reads');
          }
        } else if (method === 'runAggregationQuery') {
          const fields = obj(obj(chunk.result)?.aggregateFields);
          if (fields !== null) {
            let n = 0;
            for (const f of Object.values(fields)) {
              const iv = obj(f)?.integerValue;
              if (iv !== undefined) n = Math.max(n, Number(iv));
            }
            bump(at, queryCollection(), 'reads', Math.max(1, Math.ceil(n / 1000)));
            docs += 1;
          }
        }
      }
    }
    if (event === 'end' && (method === 'runQuery' || method === 'runAggregationQuery') && docs === 0) {
      bump(at, queryCollection(), 'reads');
      docs = -1; // once
    }
    return original(event, ...args);
  };
}

type RequestFn = (this: unknown, method: string, request: unknown, ...rest: unknown[]) => Promise<unknown>;
type StreamFn = (this: unknown, method: string, bidi: unknown, request: unknown, ...rest: unknown[]) => Promise<StreamLike>;

function installCounter(db: FirebaseFirestore.Firestore): () => void {
  const proto = Object.getPrototypeOf(db) as { request: RequestFn; requestStream: StreamFn };
  const origRequest = proto.request;
  const origStream = proto.requestStream;
  proto.request = function (this: unknown, method: string, request: unknown, ...rest: unknown[]): Promise<unknown> {
    const at = phase === null ? null : `${currentDay}|${phase}`;
    return origRequest.call(this, method, request, ...rest).then((response) => {
      if (method === 'commit' || method === 'batchWrite') countWrites(at, request, response, method);
      return response;
    });
  };
  proto.requestStream = function (this: unknown, method: string, bidi: unknown, request: unknown, ...rest: unknown[]): Promise<StreamLike> {
    const at = phase === null ? null : `${currentDay}|${phase}`;
    return origStream.call(this, method, bidi, request, ...rest).then((stream) => {
      instrumentStream(at, method, request, stream);
      return stream;
    });
  };
  return () => { proto.request = origRequest; proto.requestStream = origStream; };
}

// ─── optional read tracing (METER_COST_TRACE=<phase>): billed reads by calling site ───
const traceSites = new Map<string, { reads: number; missing: number; calls: number }>();
function traceSite(): string {
  const frames = (new Error().stack ?? '').split('\n').slice(2)
    .filter((l) => l.includes('/src/') && !l.includes('node_modules') && !l.includes('meter-cost.emulator'))
    .map((l) => l.trim().replace(/^at /, '').replace(/\(.*\/src\//, '(').replace(/^.*\/src\//, ''));
  return frames.slice(0, 4).join(' <- ');
}
function traceAdd(site: string, reads: number, missing: number): void {
  const t = traceSites.get(site) ?? { reads: 0, missing: 0, calls: 0 };
  t.reads += reads; t.missing += missing; t.calls += 1;
  traceSites.set(site, t);
}
async function installTracer(isOn: () => boolean): Promise<void> {
  const mod = await import('firebase-admin/firestore');
  type Snap = { exists?: boolean; size?: number; docs?: unknown[] };
  const wrap = (proto: Record<string, unknown>, name: string, count: (r: unknown, args: unknown[]) => [number, number]): void => {
    const orig = proto[name] as (...a: unknown[]) => Promise<unknown>;
    proto[name] = function (this: unknown, ...args: unknown[]): Promise<unknown> {
      if (!isOn()) return orig.apply(this, args);
      const site = traceSite();
      return orig.apply(this, args).then((r) => {
        const [reads, missing] = count(r, args);
        traceAdd(site, reads, missing);
        return r;
      });
    };
  };
  const docCount = (r: unknown): [number, number] => {
    const s = r as Snap;
    if (Array.isArray(r)) return [r.length, (r as Snap[]).filter((x) => x.exists === false).length];
    if (typeof s.exists === 'boolean') return [1, s.exists ? 0 : 1];
    return [Math.max(1, s.size ?? 0), 0];
  };
  wrap(mod.DocumentReference.prototype as unknown as Record<string, unknown>, 'get', docCount);
  wrap(mod.Query.prototype as unknown as Record<string, unknown>, 'get', docCount);
  wrap(mod.Transaction.prototype as unknown as Record<string, unknown>, 'get', docCount);
  wrap(mod.Transaction.prototype as unknown as Record<string, unknown>, 'getAll', docCount);
  wrap(mod.Firestore.prototype as unknown as Record<string, unknown>, 'getAll', docCount);
}

// ─── Firestore storage-size rules ─────────────────────────────────────────────────
interface IndexSpec { readonly order?: string; readonly arrayConfig?: string }
interface IndexModel {
  readonly overrides: Map<string, Map<string, IndexSpec[]>>;
  readonly composites: Map<string, string[][]>;
  readonly ttl: Set<string>;
}

function loadIndexModel(): IndexModel {
  const raw = JSON.parse(readFileSync(path.join(__dirname, '../../../firestore.indexes.json'), 'utf8')) as {
    indexes: { collectionGroup: string; fields: { fieldPath: string }[] }[];
    fieldOverrides?: { collectionGroup: string; fieldPath: string; indexes?: IndexSpec[]; ttl?: boolean }[];
  };
  const overrides = new Map<string, Map<string, IndexSpec[]>>();
  const ttl = new Set<string>();
  for (const f of raw.fieldOverrides ?? []) {
    const m = overrides.get(f.collectionGroup) ?? new Map<string, IndexSpec[]>();
    m.set(f.fieldPath, f.indexes ?? []);
    overrides.set(f.collectionGroup, m);
    if (f.ttl === true) ttl.add(f.collectionGroup);
  }
  const composites = new Map<string, string[][]>();
  for (const i of raw.indexes) {
    const list = composites.get(i.collectionGroup) ?? [];
    list.push(i.fields.map((f) => f.fieldPath).filter((p) => p !== '__name__'));
    composites.set(i.collectionGroup, list);
  }
  return { overrides, composites, ttl };
}

let TimestampCtor: (new (s: number, n: number) => unknown) | null = null;
function isTimestamp(v: unknown): boolean {
  return TimestampCtor !== null && v instanceof TimestampCtor;
}
const strSize = (s: string): number => Buffer.byteLength(s, 'utf8') + 1;
function docNameSize(docPath: string): number {
  return docPath.split('/').reduce((t, s) => t + strSize(s), 0) + 16;
}
function valueSize(v: unknown): number {
  if (v === null || v === undefined || typeof v === 'boolean') return 1;
  if (typeof v === 'number' || typeof v === 'bigint') return 8;
  if (typeof v === 'string') return strSize(v);
  if (isTimestamp(v)) return 8;
  if (v instanceof Uint8Array) return v.length;
  if (Array.isArray(v)) return v.reduce((t: number, e) => t + valueSize(e), 0);
  const o = obj(v);
  if (o !== null) {
    const ref = o as { path?: unknown; firestore?: unknown };
    if (typeof ref.path === 'string' && ref.firestore !== undefined) return docNameSize(ref.path);
    return Object.entries(o).reduce((t, [k, e]) => t + strSize(k) + valueSize(e), 0);
  }
  return 8;
}
function isPlainMap(v: unknown): v is Record<string, unknown> {
  return obj(v) !== null && !isTimestamp(v) && !(v instanceof Uint8Array);
}
function getPath(data: Record<string, unknown>, fieldPath: string): { present: boolean; value: unknown } {
  let cur: unknown = data;
  for (const seg of fieldPath.split('.')) {
    const o = isPlainMap(cur) ? cur : null;
    if (o === null || !(seg in o)) return { present: false, value: undefined };
    cur = o[seg];
  }
  return { present: true, value: cur };
}

function indexBytes(model: IndexModel, collection: string, nameSize: number, data: Record<string, unknown>): number {
  const ov = model.overrides.get(collection);
  const overrideFor = (p: string): IndexSpec[] | undefined => {
    if (!ov) return undefined;
    let q = p;
    for (;;) {
      const hit = ov.get(q);
      if (hit !== undefined) return hit;
      const i = q.lastIndexOf('.');
      if (i < 0) return undefined;
      q = q.slice(0, i);
    }
  };
  let total = 0;
  const entry = (p: string, size: number): number => nameSize + strSize(p) + size + 32;
  const walk = (v: unknown, p: string): void => {
    if (isPlainMap(v) && Object.keys(v).length > 0 && !(typeof (v as { path?: unknown }).path === 'string')) {
      for (const [k, e] of Object.entries(v)) walk(e, p ? `${p}.${k}` : k);
      return;
    }
    const spec = overrideFor(p);
    const distinct = Array.isArray(v) ? [...new Map(v.map((e) => [JSON.stringify(e), e])).values()] : [];
    if (spec === undefined) {
      if (Array.isArray(v)) for (const e of distinct) total += entry(p, valueSize(e));
      else total += 2 * entry(p, valueSize(v));
      return;
    }
    for (const s of spec) {
      if (s.arrayConfig !== undefined) {
        if (Array.isArray(v)) for (const e of distinct) total += entry(p, valueSize(e));
      } else total += entry(p, valueSize(v));
    }
  };
  walk(data, '');
  for (const fields of model.composites.get(collection) ?? []) {
    let size = nameSize + 32;
    let ok = true;
    for (const f of fields) {
      const got = getPath(data, f);
      if (!got.present) { ok = false; break; }
      size += strSize(f) + valueSize(got.value);
    }
    if (ok) total += size;
  }
  return total;
}

// ─── storage ledger across simulated days ─────────────────────────────────────────
interface DocRecord {
  coll: string;
  id: string;
  logicalId: string;
  firstDay: number;
  createdAtMs: number;
  lastDay: number;
  deletedDay: number | null;
  docBytes: number;
  idxBytes: number;
  expireAtMs: number | null;
  bytesByDay: Map<number, number>;
}
const ledger = new Map<string, DocRecord>();
const SEED_COLLECTIONS = new Set<string>();

function expireMs(v: unknown): number | null {
  if (!isTimestamp(v)) return null;
  return (v as { toMillis(): number }).toMillis();
}

async function scanStorage(db: FirebaseFirestore.Firestore, model: IndexModel, day: number, dayStart: number): Promise<void> {
  const seen = new Set<string>();
  const colls = await db.listCollections();
  for (const c of colls) {
    const snap = await c.get();
    for (const d of snap.docs) {
      const key = d.ref.path;
      seen.add(key);
      const data = d.data() as Record<string, unknown>;
      const nameSize = docNameSize(d.ref.path);
      const docBytes = nameSize + Object.entries(data).reduce((t, [k, v]) => t + strSize(k) + valueSize(v), 0) + 32;
      const idxBytes = indexBytes(model, c.id, nameSize, data);
      const decoded = data._provian_store === 1 ? (await import('../provenance/private-store')).decodePrivateRecord(c.id, d.id, data, db) : { id: d.id, data };
      const logical = decoded.data;
      const created = typeof logical.created_at_ms === 'number' ? logical.created_at_ms
        : typeof logical.accepted_at_ms === 'number' ? logical.accepted_at_ms : dayStart + 12 * HOUR;
      const rec = ledger.get(key) ?? {
        coll: c.id, id: d.id, logicalId: decoded.id, firstDay: day, createdAtMs: created, lastDay: day, deletedDay: null,
        docBytes, idxBytes, expireAtMs: null, bytesByDay: new Map<number, number>(),
      };
      rec.lastDay = day;
      rec.docBytes = docBytes;
      rec.idxBytes = idxBytes;
      rec.expireAtMs = expireMs(data.expire_at);
      rec.bytesByDay.set(day, docBytes + idxBytes);
      ledger.set(key, rec);
    }
  }
  for (const rec of ledger.values()) {
    if (rec.deletedDay === null && !seen.has(`${rec.coll}/${rec.id}`)) rec.deletedDay = day;
  }
}

// ─── fake chain + verifier (the shape of settlement-cycle-runner.test.ts's mini-kernel) ──
type CycleRunner = typeof import('../pvt/wp4/settlement-cycle-runner');
type ChainAdapter = import('../pvt/wp4/settlement-cycle-runner').SettlementChainAdapter;
type Observation = import('../pvt/wp4/settlement-cycle-runner').CycleChainObservation;
type Receipt = import('../pvt/wp4/settlement-cycle-runner').MinedReceipt;
type SignableTx = import('../pvt/wp4/settlement-cycle-runner').SignableTransaction;

const H32 = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const ADDR = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const SIGNER = ADDR(0xbeef);
const KERNEL = ADDR(0xcafe);
const EPOCH_SEC = 604_800;

class FakeKernel implements ChainAdapter {
  cursor = 0n;
  block = 0;
  canonical = new Map<number, string>();
  claimSettled = new Set<string>();
  affirmed = new Set<string>();
  receipts = new Map<string, Receipt>();
  txCount = 0;
  constructor(private readonly iface: import('ethers').Interface, private readonly nowMs: () => number, private readonly zeroSec: number) {}
  private epoch(): number { return Math.floor((Math.floor(this.nowMs() / 1000) - this.zeroSec) / EPOCH_SEC); }
  async observe(): Promise<Observation> {
    return {
      epochZeroArmed: true,
      epochZeroStartsAtSec: this.zeroSec,
      lastOpenedEpoch: this.epoch(),
      administrativeHold: false,
      operationalMinter: SIGNER,
      settlementSigner: SIGNER,
      observedAtSec: Math.floor(this.nowMs() / 1000),
      nextFinalizedCursor: this.cursor,
      openEpochPolicyHash: H32(0xfeed),
      chainId: 8453n,
      kernelAddress: KERNEL,
      mintRateAtomic: 10n ** 18n,
      agentFoundationBps: 50n,
      genesisCapAtomic: 7_500_000n * 10n ** 18n,
      combinedCapAtomic: 10_000_000n * 10n ** 18n,
      epochGenesisIssuedAtomic: 0n,
      epochTotalIssuedAtomic: 0n,
    } as Observation;
  }
  async getTransactionCount(): Promise<number> { return this.txCount; }
  async feeData(): Promise<{ maxFeePerGasWei: bigint; maxPriorityFeePerGasWei: bigint }> {
    return { maxFeePerGasWei: 1_000_000_000n, maxPriorityFeePerGasWei: 100_000_000n };
  }
  async estimateGas(): Promise<bigint> { return 1_000_000n; }
  private decode(data: string): { batchId: string; cursorStart: bigint; cursorEnd: bigint; claimIds: string[] } | null {
    try {
      const p = this.iface.parseTransaction({ data });
      if (p === null) return null;
      const claims = p.args[6] as unknown as ReadonlyArray<ReadonlyArray<unknown>>;
      return {
        batchId: String(p.args[0]).toLowerCase(),
        cursorStart: BigInt(p.args[3] as bigint),
        cursorEnd: BigInt(p.args[4] as bigint),
        claimIds: claims.map((c) => String(c[0]).toLowerCase()),
      };
    } catch {
      return null;
    }
  }
  async simulate(tx: { data: string }): Promise<{ ok: boolean; revertReason: string | null }> {
    if (tx.data === '0x') return { ok: true, revertReason: null };
    const d = this.decode(tx.data);
    if (d === null) return { ok: false, revertReason: 'undecodable' };
    if (d.cursorStart !== this.cursor) return { ok: false, revertReason: 'CursorDiscontinuity' };
    if (d.claimIds.some((id) => this.claimSettled.has(id))) return { ok: false, revertReason: 'ClaimAlreadySettled' };
    if (!this.affirmed.has(d.batchId)) return { ok: false, revertReason: 'VerificationFailed' };
    return { ok: true, revertReason: null };
  }
  async sign(tx: SignableTx): Promise<{ raw: string; hash: string }> {
    const raw = JSON.stringify(tx, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    return { raw, hash: `0x${createHash('sha256').update(raw).digest('hex')}` };
  }
  async broadcast(raw: string): Promise<void> {
    const hash = `0x${createHash('sha256').update(raw).digest('hex')}`;
    if (this.receipts.has(hash)) throw new Error('already known');
    const parsed = JSON.parse(raw) as { data: string; nonce: number };
    this.txCount = Math.max(this.txCount, parsed.nonce + 1);
    let status: 'success' | 'reverted' = 'success';
    const d = parsed.data === '0x' ? null : this.decode(parsed.data);
    if (d !== null) {
      if (d.cursorStart !== this.cursor || d.claimIds.some((id) => this.claimSettled.has(id))) status = 'reverted';
      else {
        this.cursor = d.cursorEnd;
        d.claimIds.forEach((id) => this.claimSettled.add(id));
      }
    }
    this.block += 1;
    const blockHash = H32(0xb10c_0000 + this.block);
    this.canonical.set(this.block, blockHash);
    this.receipts.set(hash, { status, blockNumber: this.block, blockHash, gasUsed: 500_000n, effectiveGasPriceWei: 5n });
  }
  async getReceipt(txHash: string): Promise<Receipt | null> { return this.receipts.get(txHash) ?? null; }
  async readSafeHead(): Promise<{ number: number; hash: string }> { return { number: this.block, hash: this.canonical.get(this.block) ?? H32(0) }; }
  async readHead(): Promise<number> { return this.block + 11; }
  async getBlockHash(n: number): Promise<string | null> { return this.canonical.get(n) ?? null; }
  async isClaimSettled(claimId: string): Promise<boolean> { return this.claimSettled.has(claimId.toLowerCase()); }
}

// ─── the suite ─────────────────────────────────────────────────────────────────────
suite('PE meter — measured Firestore cost of an Atlas-sized agent (emulator)', () => {
  let db: FirebaseFirestore.Firestore;
  let uninstall: () => void = () => {};
  let model: IndexModel;
  let simNow = START;

  // Deterministic by default (the emulator is wiped at start), so two runs of different code
  // produce comparable economic fingerprints (see `economicFingerprint`).
  const RUN = process.env.METER_COST_RUN ?? 'costfixed';
  const AGENT_ID = `agent_${RUN}`;
  const WALLET_ID = `wallet_aw_${RUN}`;
  const DEVICE_ID = `dev_${RUN}`;
  const AGENT_ADDRESS = `0x${createHash('sha256').update(`a${RUN}`).digest('hex').slice(0, 40)}`;
  const HUMAN_USER = `user_${RUN}`;
  const HUMAN_WALLET = `wallet_h_${RUN}`;
  const HUMAN_ADDRESS = `0x${createHash('sha256').update(`h${RUN}`).digest('hex').slice(0, 40)}`;
  const DEVICE_KEY = `pdk_${randomBytes(16).toString('hex')}`;
  const DEVICE_SECRET = `pds_${randomBytes(32).toString('hex')}`;
  const human = generateKeyPairSync('x25519');
  const humanPub = (human.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);

  // Wiring loaded after the mocks.
  let wire: typeof import('./meter-wire');
  let sealed: typeof import('./sealed-box');
  let app: import('express').Express;
  let runner: CycleRunner;
  let kernel: FakeKernel;
  /** relayPeId → the PE the device kept (for the old-path envelope reconstruction). */
  const pesByRelayId = new Map<string, Record<string, unknown>>();
  const receipts: import('./meter-store').MeterBatchReceipt[] = [];
  const transitOutbox: { receipt: import('./meter-store').MeterBatchReceipt; sealed: import('./meter-wire').SealedCopy[] }[] = [];

  /**
   * The ECONOMIC outcome of the whole simulation, as one digest: every batch receipt (per-act
   * disposition, reason, points, mint status), every act key's priced row, legs, unit and held
   * reason, every pending claim (key, id, leg, payee, class, points, acts, state), every ledger
   * row's claim identity and settlement, and the set of claim ids the kernel settled. A cost
   * change must leave this byte-identical (METER_COST_EXPECT_FINGERPRINT pins it).
   */
  async function economicFingerprint(): Promise<{ digest: string; acts_digest: string; settled_by_payee: Record<string, string>; counts: Record<string, number> }> {
    const pick = (o: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> =>
      Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
    const sorted = async (coll: string, keys: readonly string[] | null): Promise<unknown[]> => {
      const snap = await db.collection(coll).get();
      return snap.docs
        .map((d) => ({ id: d.id, ...(keys === null ? d.data() : pick(d.data() as Record<string, unknown>, keys)) }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    };
    const actKeys = await sorted('meter_act_keys_v1', ['relay_pe_id', 'pe_hash', 'actor_id', 'action_type', 'row', 'legs', 'unit', 'held_reason']);
    const pending = await sorted('meter_pending_claims_v1', ['claim_key', 'unit', 'batch_hash', 'actor_id', 'leg', 'contributor',
      'beneficiary_class', 'record_points_atomic', 'acts', 'claim_id', 'ready_at_ms', 'act_identity', 'state', 'integrity_sha256',
      'settled_batch_id', 'settled_tx_hash', 'settled_at_ms']);
    const ledger = await sorted('pvt9_claim_ledger_v1', ['pe_id', 'claim_key', 'leg', 'claim_id', 'lane', 'contributor',
      'beneficiary_class', 'record_points_atomic', 'settled', 'settled_batch_id', 'settled_tx_hash', 'settled_at']);
    const payload = {
      receipts,
      actKeys,
      pending,
      ledger,
      kernelSettled: [...kernel.claimSettled].sort(),
      kernelCursor: kernel.cursor.toString(),
    };
    const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    // What each payee was paid, independent of how claims are grouped (a payout claim and the
    // per-batch claims it replaces must settle the same points to the same payee).
    const settledByPayee: Record<string, string> = {};
    for (const row of ledger as Record<string, unknown>[]) {
      if (row.settled !== true) continue;
      const key = `${String(row.contributor).toLowerCase()}|${String(row.beneficiary_class)}`;
      settledByPayee[key] = (BigInt(settledByPayee[key] ?? '0') + BigInt(String(row.record_points_atomic))).toString();
    }
    // Every act's economic outcome, independent of how its earnings were grouped into claims and of
    // the claim ids (which reach the settlement calldata and so its tx hash): its status, points,
    // payee legs, hold, corroboration, takeover, and WHICH settlement minted it and when (so an act
    // registered one run early or late shows). Byte-identical across a claim-layout change.
    const actsDigest = createHash('sha256').update(JSON.stringify((actKeys as Record<string, unknown>[]).map((k) => {
      const r = (k.row ?? {}) as Record<string, unknown>;
      return [k.relay_pe_id, r.mint_status, r.mint_disposition, r.record_points_atomic, k.legs, k.held_reason,
        r.corroboration_status ?? null, r.commit_takeover_demoted_by_pe_id ?? null,
        r.settled_batch_id ?? null, r.settled_at ?? null];
    }))).digest('hex');
    // What the scenario did (so a run that silently skipped a takeover or a top-up cannot pass).
    const rows = (actKeys as Record<string, unknown>[]).map((k) => (k.row ?? {}) as Record<string, unknown>);
    const scenarioCounts = {
      taken_over: rows.filter((r) => typeof r.commit_takeover_demoted_by_pe_id === 'string').length,
      forge_acts: (actKeys as Record<string, unknown>[]).filter((k) => k.action_type === 'service:github_commit').length,
      forge_minted: (actKeys as Record<string, unknown>[]).filter((k) => k.action_type === 'service:github_commit'
        && ((k.row ?? {}) as Record<string, unknown>).mint_status === 'minted').length,
      topup_claims: (pending as Record<string, unknown>[]).filter((c) => c.unit === 'topup').length,
      topup_settled: (pending as Record<string, unknown>[]).filter((c) => c.unit === 'topup' && c.state === 'settled').length,
    };
    return { digest, acts_digest: actsDigest, settled_by_payee: settledByPayee, counts: { receipts: receipts.length, act_keys: actKeys.length, pending: pending.length, ledger: ledger.length, kernel_settled: kernel.claimSettled.size, ...(SCENARIO === '' ? {} : scenarioCounts) } };
  }

  const setNow = (ms: number): void => {
    simNow = ms;
    jest.setSystemTime(ms);
  };
  const settleIo = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

  beforeAll(async () => {
    jest.useFakeTimers({
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate',
        'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
      now: START,
    });
    process.env.GCLOUD_PROJECT = PROJECT;
    await fetch(`http://${EMULATOR}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    const admin = (await import('firebase-admin')).default;
    if (admin.apps.length === 0) admin.initializeApp({ projectId: PROJECT });
    db = admin.firestore();
    try { db.settings((await import('../../firestore-settings')).RELAY_FIRESTORE_SETTINGS); } catch { /* already set */ }
    if (PRIVATE_STORAGE) {
      const { privateFirestore } = await import('../provenance/private-store');
      await db.collection('private_retention_state_v1').doc('d554').set({ opaque_ids_ready: true, opaque_records_complete: true, array_lookup_version: 1, range_lookup_version: 1 });
      await db.collection('meter_occurrence_carry_v1').doc('live').set({ complete: true });
      db = privateFirestore(db);
    }
    const policy = await import('../pvt/policy/runtime-monetary-policy');
    const { APPROVED_MONETARY_ACTIVATION_SIGNATURE: signature } = await import('../pvt/policy/approved-monetary-activation-approval');
    const approval = await import('../pvt/policy/pvt9-approval-manifest.generated');
    const { PROPOSED_MONETARY_POLICY_TEMPLATE: template } = await import('../pvt/policy/proposed-monetary-policy');
    const { decodeOpenSshEd25519PublicKey } = await import('../pvt/policy/approval-signature');
    const signedBytes = Buffer.from(signature.armored_signature.replace(/-----[^\n]+-----/g, '').replace(/\s/g, ''), 'base64');
    const publicKey = 'ssh-ed25519 ' + signedBytes.subarray(14, 14 + signedBytes.readUInt32BE(10)).toString('base64');
    process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY = publicKey;
    process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256 = decodeOpenSshEd25519PublicKey(publicKey).sha256;
    const activation: import('../pvt/policy/runtime-monetary-policy').MonetaryPolicyActivationDocument = {
      schema_version: 'pvt-monetary-policy-activation/v1', approval_status: 'approved_by_frank',
      approval_manifest_sha256: approval.PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256, approval_signature: signature,
      policy_version: template.proposedPolicyVersion, policy_template_sha256: policy.hashProposedMonetaryPolicyTemplate(),
      effective_at_ms: 0, effective_until_ms: null, activation_scope: 'record_and_settlement',
      automation_generated: false, activated_at_ms: 0, activated_by: 'operator:cost-fixture',
    };
    expect(policy.isValidMonetaryPolicyActivation(activation)).toBe(true);
    expect(policy.isValidMonetaryPolicyActivation({ ...activation, approval_status: 'disabled' })).toBe(false);
    await db.collection(policy.MONETARY_POLICY_ACTIVATION_COLLECTION).doc(policy.MONETARY_POLICY_ACTIVATION_DOCUMENT).set(activation);
    await db.collection('meter_pending_index_coverage_v1').doc('live').set({ complete: true });
    await db.collection('meter_day_counter_cutover_v1').doc('live').set({ packed_from_day: '2026-10-04', legacy_seed_through_day: '2026-10-04' });
    TimestampCtor = (await import('firebase-admin/firestore')).Timestamp as unknown as new (s: number, n: number) => unknown;
    model = loadIndexModel();
    wire = await import('./meter-wire');
    sealed = await import('./sealed-box');
    runner = await import('../pvt/wp4/settlement-cycle-runner');
    const { Interface } = await import('ethers');
    kernel = new FakeKernel(new Interface(runner.KERNEL_SETTLEMENT_ABI as unknown as string[]), () => simNow, Math.floor(START / 1000) - 3_600);

    // ── seed (not counted): the agent (no recovery escrow), its linked human, the device, keys ──
    const salt = randomBytes(32).toString('hex');
    const hash = await new Promise<string>((resolve, reject) => scrypt(`${DEVICE_KEY}:${DEVICE_SECRET}`, salt, 64,
      { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key.toString('hex')))));
    await db.collection('agent_wallets').doc(WALLET_ID).set({
      id: WALLET_ID, agent_id: AGENT_ID, address: AGENT_ADDRESS, status: 'active', created_at: START - 30 * DAY,
      operational_reserve_bps: 2_000, parent_wallet_id: null,
      linked_human_wallet_id: HUMAN_WALLET, linked_human_user_id: HUMAN_USER, linked_human_address: HUMAN_ADDRESS,
      display_name: 'Atlas',
    });
    await db.collection('wallets').doc(HUMAN_WALLET).set({
      id: HUMAN_WALLET, type: 'human', user_id: HUMAN_USER, address: HUMAN_ADDRESS, status: 'active',
    });
    const { canonicalAgentPeHash } = await import('../agent-wallet/canonical-agent-pe-chain');
    const rel = {
      state: 'linked', human_wallet_id: HUMAN_WALLET, human_user_id: HUMAN_USER, human_address: HUMAN_ADDRESS,
      agent_share_bps: 2_000, parent_wallet_id: null, revision: 1,
    };
    const sourcePeId = `pe_rel_${WALLET_ID}`;
    const canonical = {
      id: sourcePeId, wallet_id: WALLET_ID, agent_id: AGENT_ID, user_id: AGENT_ID, actor_address: AGENT_ADDRESS,
      action_type: 'agent_linked_to_human', timestamp: 1, prev_hash: '0x0000', attestation_type: 'software',
      metadata: { beneficiary_relationship: rel },
      compute: null, geo: null, execution_env: null, cited_pe_ids: null, parent_goal_pe_id: null,
    };
    const relHash = canonicalAgentPeHash(canonical);
    await db.collection('identity_pes_legacy_v1').doc(sourcePeId).set({
      ...canonical, hash: relHash, policy_action_type: 'agent_linked', integration_source: 'agent_bank_generate_pe',
      counterparty_address: null, counterparty_type: null, session_lineage: null, self_referencing: false,
      trust_level_at_creation: null, created_at: 1, durability: 'final',
    });
    await db.collection('agent_beneficiary_relationships_v1').doc(WALLET_ID).set({
      schema_version: 'agent-beneficiary-relationship/v2', wallet_id: WALLET_ID, agent_id: AGENT_ID, ...rel,
      source_action_type: 'agent_linked_to_human', source_pe_id: sourcePeId, source_pe_hash: relHash,
      created_at_ms: 1, updated_at_ms: 1,
    });
    await db.collection('devices').doc(DEVICE_ID).set({
      device_id: DEVICE_ID, owner_type: 'agent', owner_user_id: AGENT_ID, owner_wallet_id: WALLET_ID,
      owner_address: AGENT_ADDRESS, signing_method: 'bearer', attestation_capability: 'software',
      platform: 'darwin', status: 'active', device_key_hash: hash, device_key_salt: salt,
      device_key_prefix: DEVICE_KEY.slice(0, 20),
    });
    await db.collection('device_key_index').doc(DEVICE_KEY.slice(0, 20)).set({ device_id: DEVICE_ID });
    const { NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, nativeWalletAddressIndexId } = await import('../pvt/native-wallet-registration');
    await db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).doc(nativeWalletAddressIndexId(AGENT_ADDRESS))
      .set({ owner_type: 'agent', wallet_id: WALLET_ID, address: AGENT_ADDRESS });
    await db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).doc(nativeWalletAddressIndexId(HUMAN_ADDRESS))
      .set({ owner_type: 'human', wallet_id: HUMAN_WALLET, address: HUMAN_ADDRESS });
    await db.collection('commons_message_keys').doc(HUMAN_WALLET).set({
      party_id: HUMAN_WALLET, kind: 'human', pubkey_b64u: sealed.toB64u(humanPub), key_version: 1, published_at: START - DAY,
    });
    for (const c of await db.listCollections()) SEED_COLLECTIONS.add(c.id);

    const { createMeterRouter } = await import('../../routes/meter');
    const { cache } = await import('../../cache');
    app = express();
    const capture = (req: import('http').IncomingMessage, _res: unknown, buf: Buffer): void => {
      (req as unknown as { rawBody?: string }).rawBody = buf.toString('utf8');
    };
    app.use(['/v1/meter/batch', '/v1/meter/transit'], express.json({ limit: '2mb', verify: capture }));
    app.use(express.json({ verify: capture }));
    app.use('/v1/meter', createMeterRouter({ db, cache }));

    uninstall = installCounter(db);
    const tracePhase = process.env.METER_COST_TRACE;
    if (tracePhase) await installTracer(() => phase === tracePhase && currentDay === DAYS - 1);
  });

  afterAll(() => {
    uninstall();
    jest.useRealTimers();
  });

  // ── the daemon side ──
  let chainTip = 'genesis';
  let peSeq = 0;
  let seq = 0;
  let prevBatch = 'genesis';
  let sessionOrdinal = 0;
  let proofsAfterSeq = 0;

  async function buildPe(kind: typeof MIX[number], ts: number): Promise<import('./meter-wire').PeV2> {
    const n = peSeq++;
    const fp = createHash('sha256').update(`${RUN}:s:${Math.floor(n / 8)}`).digest('hex');
    const origins = [0, 1, 2].map((i) => ({
      hash: `sha256:${createHash('sha256').update(`${RUN}:o:${n}:${i}`).digest('hex')}`,
      origin_identifier: `file:/Users/atlas/work/provian/src/module_${(n * 3 + i) % 97}.ts`,
      witnessed: false,
    }));
    const base = { schema: wire.PE_V2_SCHEMA, pe_id: `pe_${RUN}_${n}`, device_id: DEVICE_ID, prev_hash: chainTip, timestamp: ts };
    let pe: import('./meter-wire').PeV2;
    if (kind === 'agent_tool_orchestration') {
      const tools = ['Read', 'Edit', 'Bash', 'Grep'].slice(0, 1 + (n % 4));
      pe = {
        ...base, action_type: kind,
        description: `agent turn — ${tools.length + 2} tool calls (claude_code)`,
        input_origins: origins,
        metadata: {
          tool: 'provian:transcript', source: 'transcript', harness: 'claude_code', container: 'file',
          session_fingerprint: fp, turn_index: n % 40, turn_id: `tf:${fp.slice(0, 32)}:${n}`,
          supervision: { turn_opened_by: 'human', human_opened_turns: 3, total_turns: 12, human_share_bps: 2500 },
          tool_count: tools.length + 2, tool_names: tools, errored_tool_calls: 0, subagent_tool_calls: 0, activity_at_ms: ts,
        },
        compute: {
          duration_ms: 42_000, tokens_processed: null, records_processed: null, output_cardinality: null, cpu_seconds: null,
          memory_peak_mb: null, energy_joules: null, gpu_seconds: null, model_parameters: null, framework: 'claude_code', hardware_class: null,
        },
      };
    } else if (kind === 'compute_session') {
      sessionOrdinal += 1;
      const { deriveEconomicSessionLineageId, ECONOMIC_SESSION_LINEAGE_VERSION } = await import('../pvt/economic-session-lineage');
      const nonce = createHash('sha256').update(`${RUN}:nonce:${sessionOrdinal}`).digest('hex').slice(0, 32);
      const started = ts - 30 * 60_000;
      pe = {
        ...base, action_type: kind,
        description: 'observer compute session (claude_code)',
        economic_session_lineage: {
          v: ECONOMIC_SESSION_LINEAGE_VERSION, session_started_at_ms: started, session_nonce: nonce, session_ordinal: sessionOrdinal,
          id: deriveEconomicSessionLineageId({ attestedDeviceId: DEVICE_ID, sessionStartedAtMs: started, sessionNonce: nonce, sessionOrdinal }),
        },
        metadata: { tool: 'claude_code', session_fingerprint_hash: fp, active_duration_ms: 1_200_000, null_state_flags: [] },
        compute: { duration_ms: 1_800_000, tokens_processed: 180_000, framework: 'claude_code', hardware_class: 'apple_silicon' },
        execution_env: { os: 'darwin', arch: 'arm64', runtime: 'node20' },
      };
    } else {
      const sha = createHash('sha1').update(`${RUN}:commit:${n}`).digest('hex');
      pe = {
        ...base, action_type: kind,
        description: `commit ${sha.slice(0, 7)} on provian/provian-wallet (3 files)`,
        input_origins: origins,
        metadata: { commit_sha: sha, repo: 'provian/provian-wallet', branch: 'master', files_changed: 3, insertions: 41, deletions: 9, session_fingerprint_hash: fp },
      };
    }
    chainTip = wire.peHashOf(pe);
    return pe;
  }

  const authHeader = `DeviceKey ${DEVICE_KEY}:${DEVICE_SECRET}`;
  async function postBatch(t: number): Promise<import('./meter-store').MeterBatchReceipt> {
    for (let i = transitOutbox.length - 1; i >= 0; i--) {
      const prior = transitOutbox[i];
      const redelivery = JSON.stringify({ batch_hash: prior.receipt.batch_hash, sealed: prior.sealed,
        transit_receipt: prior.receipt.transit_receipt, transit_recipients: prior.receipt.transit_recipients });
      const answer = await request(app).post('/v1/meter/transit').set('Authorization', authHeader)
        .set('Content-Type', 'application/json').set('X-Provian-Body-HMAC', createHmac('sha256', DEVICE_SECRET).update(redelivery).digest('hex')).send(redelivery);
      if (answer.status !== 200) throw new Error(`transit resend failed ${answer.status}`);
      if (answer.body.complete === true) transitOutbox.splice(i, 1);
    }
    const pes: import('./meter-wire').PeV2[] = [];
    for (let i = 0; i < ACTS_PER_BATCH; i += 1) {
      const hourBack = HOURS_PER_BATCH - 1 - Math.floor(i / ACTS_PER_HOUR);
      pes.push(await buildPe(MIX[i % ACTS_PER_HOUR], t - hourBack * HOUR - 55 * 60_000 + (i % ACTS_PER_HOUR) * 6 * 60_000));
    }
    const sealedCopies = pes.map((pe) => ({
      to: 'linked_human', pe_id: pe.pe_id,
      box: sealed.toB64u(sealed.sealToKey(humanPub, Buffer.from(wire.canonicalJson({ ...pe, pe_hash: wire.peHashOf(pe) }), 'utf8'))),
    }));
    const batch = wire.buildBatch({ device_id: DEVICE_ID, seq: seq + 1, prev_batch_hash: prevBatch, created_at_ms: t, pes, sealed: sealedCopies });
    const body = JSON.stringify(batch);
    const res = await request(app).post('/v1/meter/batch')
      .set('Authorization', authHeader)
      .set('Content-Type', 'application/json')
      .set('X-Provian-Body-HMAC', createHmac('sha256', DEVICE_SECRET).update(body).digest('hex'))
      .send(body);
    if (res.status !== 201) throw new Error(`batch ${seq + 1} → ${res.status} ${JSON.stringify(res.body)}`);
    seq = batch.seq;
    prevBatch = wire.batchHashOf(batch);
    const receipt = res.body as import('./meter-store').MeterBatchReceipt;
    receipts.push(receipt);
    transitOutbox.push({ receipt, sealed: sealedCopies });
    receipt.acts.forEach((a, i) => pesByRelayId.set(a.relay_pe_id, pes[i] as Record<string, unknown>));
    return receipt;
  }

  // The SDK reads its seal targets when it builds a batch (cached an hour), so once per batch.
  async function daemonSealTargets(): Promise<void> {
    const targets = await request(app).get('/v1/meter/seal-targets').set('Authorization', authHeader);
    if (targets.status !== 200 || (targets.body as { targets: unknown[] }).targets.length !== 1) throw new Error(`seal-targets ${targets.status}`);
  }

  let daemonMailboxVersion: string | null = null;
  async function daemonHourlyReads(): Promise<void> {
    const peek = await request(app).get('/v1/meter/mailbox/peek').set('Authorization', authHeader);
    if (peek.status !== 200 || typeof peek.body.version !== 'string') throw new Error(`agent mailbox peek ${peek.status}`);
    if (peek.body.version === daemonMailboxVersion) return;
    const mail = await request(app).get('/v1/meter/mailbox?limit=100').set('Authorization', authHeader);
    if (mail.status !== 200) throw new Error(`agent mailbox ${mail.status}`);
    daemonMailboxVersion = peek.body.version;
  }

  async function phoneDrain(): Promise<number> {
    const { listMailbox, ackMailbox } = await import('./pe-mailbox');
    let after: string | null = null;
    let acked = 0;
    for (let page = 0; page < 10; page += 1) {
      const got = await listMailbox(db, `human:${HUMAN_USER}`, { limit: 100, afterId: after });
      if (got.items.length > 0) acked += await ackMailbox(db, `human:${HUMAN_USER}`, got.items.map((i) => i.id));
      if (got.next === null) break;
      after = got.next;
    }
    return acked;
  }

  async function daemonProofs(): Promise<number> {
    const selected = receipts.filter(r => r.seq > proofsAfterSeq).slice(0, 32).map(r => r.batch_hash).join(',');
    const res = await request(app).get(`/v1/meter/proofs?after_seq=${proofsAfterSeq}&batch_hashes=${selected}`).set('Authorization', authHeader);
    if (res.status !== 200) throw new Error(`proofs ${res.status}`);
    const body = res.body as { proofs: { seq: number }[] };
    if (body.proofs.length > 0) proofsAfterSeq = body.proofs[body.proofs.length - 1].seq;
    return body.proofs.length;
  }

  const anchorRoots = new Map<string, string>();
  async function anchor(): Promise<unknown> {
    const { runDailyMeterAnchor } = await import('./meter-anchor');
    const contract = {
      getBatch: async (id: string) => ({ exists: anchorRoots.has(id), merkleRoot: anchorRoots.get(id) ?? '0x' }),
      anchorBatch: async (id: string, root: string) => {
        if (anchorRoots.has(id)) throw new Error('BatchAlreadyAnchored');
        anchorRoots.set(id, root);
        return { hash: '0xfeed', wait: async () => ({ hash: `0x${createHash('sha256').update(id).digest('hex')}` }) };
      },
    } as unknown as import('ethers').Contract;
    return runDailyMeterAnchor({ db, peAnchorContract: contract, now: () => simNow });
  }

  // ── METER_COST_SCENARIO=takeover_topup: the commit's second witness ──
  // Each day the forge webhook (a relay-authored `service:github_commit`, base 3.0×) witnesses
  // two of the daemon's commits (`coding_session`, base 1.0×):
  //   - the day's FIRST commit, the next morning: the daemon act is still unregistered (inside its
  //     72 h window), so the forge act TAKES IT OVER — the daemon act's share must leave its claim;
  //   - the day's LAST commit, that morning, BEFORE the daemon reports it: the forge act owns the
  //     commit, and the daemon's later act corroborates it — an additive TOP-UP on the forge act.
  // Only the daily cadence is modelled (the commits' ordinals are known from the day number).
  const scenarioTakeover = SCENARIO === 'takeover_topup';
  const commitShaOf = (n: number): string => createHash('sha1').update(`${RUN}:commit:${n}`).digest('hex');
  async function forgeWitness(sha: string): Promise<void> {
    const { generatePE } = await import('../agent-bank/pe-utils');
    const { recordPEAccrual } = await import('../../pvt-accrual');
    const deps = { db, peBuffer: { enqueue: () => { throw new Error('a readable PE was enqueued'); } }, recordPEAccrual } as unknown as import('../agent-bank/pe-utils').PeGenerationDeps;
    const peId = `pe_forge_${sha.slice(0, 24)}`;
    await generatePE(deps, {
      walletId: WALLET_ID, agentId: AGENT_ID, actorAddress: AGENT_ADDRESS,
      actionType: 'service:github_commit', durableViaOrdinaryIntake: true, witnessClass: 'forge_witnessed',
      peIdOverride: peId,
      metadata: {
        commit_sha: sha, repo: 'provian/provian-wallet', branch: 'master', commits_in_push: 1,
        files_added: 0, files_removed: 0, files_modified: 3, files_changed: 3,
        synthesized_description: `push ${sha.slice(0, 7)} to provian/provian-wallet/master: 1 commit(s) across 3 files`,
        verified: true, delivery_id: `d_${sha.slice(0, 12)}`, installation_id: '1', witness: 'github_webhook',
      },
    } as unknown as Parameters<typeof generatePE>[1]);
    for (let i = 0; i < 200; i += 1) {
      const key = await db.collection('meter_act_keys_v1').doc(peId).get();
      const intake = await db.collection('meter_relay_acts_v1').doc(peId).get();
      if (key.exists && !intake.exists) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`forge act ${peId} was not priced`);
  }

  async function settle(): Promise<Record<string, unknown>> {
    const { runMeterClaimInlet, createMeterClaimVerifier } = await import('./meter-settlement');
    const { isMeterClaimKey } = await import('./meter-claims');
    const store = await import('../pvt/wp4/durable-settlement-store');
    const { cycleConfig } = await import('../pvt/wp4/operator-runtime');
    const { resolveEffectiveCycleId } = await import('../pvt/wp4/cycle-supersede');
    const { createFirestoreCandidateSource } = await import('../pvt/wp4/claim-inlet-source');
    const { createGenesisAnchorResolver } = await import('../pvt/wp4/genesis-inlet-source');
    const { testOnlyAdmittedStandardLaneVerdict } = await import('../pvt/wp4/standard-lane-recon-gate');
    const { computeSettlementDigest, hashStandardClaims, hashGenesisClaims, SettlementLane } = await import('../pvt/wp-ev/settlement-batch');
    type SDb = import('../pvt/wp4/durable-settlement-store').SettlementDb;
    const sdb = db as unknown as SDb;

    setPhase('settle_inlet');
    const { payeeSettlementDue } = await import('../pvt/wp4/payee-settlement-interval');
    const due = payeeSettlementDue(db, SETTLE_EVERY_DAYS, simNow);
    const inlet = await runMeterClaimInlet(db, { nowMs: simNow, payeeDue: due });
    setPhase('settle_cycle');
    const affirmedDigests = new Set<string>();
    const approver: import('../pvt/wp4/batch-approval').BatchApproverAdapter = {
      kernelAddress: KERNEL,
      chainId: 8453n,
      isAffirmed: async (digest, lane) => affirmedDigests.has(`${lane}:${digest.toLowerCase()}`),
      isClaimSettled: async (claimId) => kernel.claimSettled.has(claimId.toLowerCase()),
      approveStandardBatch: async (call) => {
        const d = computeSettlementDigest({ kernelAddress: KERNEL, chainId: 8453n, lane: SettlementLane.StandardPE, header: call.header, claimsHash: hashStandardClaims(call.recipients, call.claims) });
        affirmedDigests.add(`${SettlementLane.StandardPE}:${d.toLowerCase()}`);
        kernel.affirmed.add(String(call.header.batchId).toLowerCase());
        return d;
      },
      approveGenesisBatch: async (call) => {
        const d = computeSettlementDigest({ kernelAddress: KERNEL, chainId: 8453n, lane: SettlementLane.GenesisPE, header: call.header, claimsHash: hashGenesisClaims(call.recipients, call.claims) });
        affirmedDigests.add(`${SettlementLane.GenesisPE}:${d.toLowerCase()}`);
        kernel.affirmed.add(String(call.header.batchId).toLowerCase());
        return d;
      },
    };
    const deps: import('../pvt/wp4/settlement-cycle-runner').CycleRunnerDeps = {
      db: sdb,
      chain: kernel,
      now: () => simNow,
      sleep: async (ms: number) => { setNow(simNow + ms); },
      standardLaneAdmission: testOnlyAdmittedStandardLaneVerdict(),
      standardPayeeDue: due,
      approval: {
        approver,
        candidates: createFirestoreCandidateSource(sdb, createGenesisAnchorResolver(sdb)),
        meterClaims: { isMeterClaim: isMeterClaimKey, verify: createMeterClaimVerifier(db) },
      },
    };
    const workerId = `worker-${simNow}`;
    const base = `epoch${(await kernel.observe()).lastOpenedEpoch}-${new Date(simNow).toISOString().slice(0, 10)}`;
    const config = cycleConfig(base, SIGNER, 'both', workerId);
    const lease = await store.acquireSignerLease(sdb, { signer: SIGNER, workerId, nowMs: simNow, leaseTtlMs: config.leaseTtlMs });
    if (lease.kind !== 'acquired') throw new Error('lease');
    let report: Awaited<ReturnType<CycleRunner['runSettlementCycle']>>;
    try {
      await store.retireNeverBroadcastOrphans(sdb, { nowMs: simNow });
      await runner.reconcileStrandedSettlements(deps, config, { deadline: simNow + 60_000, kernelAddress: KERNEL, chainCursor: kernel.cursor });
      const resolved = await resolveEffectiveCycleId(sdb, base);
      if (resolved.kind === 'refused') throw new Error(`cycle refused ${resolved.reason}`);
      report = await runner.runSettlementCycle(deps, cycleConfig(resolved.cycleId, SIGNER, 'both', workerId));
    } finally {
      await store.releaseSignerLease(sdb, { signer: SIGNER, workerId, nowMs: simNow });
    }
    return {
      inlet: { scanned: inlet.scanned, registered: inlet.registered, notReady: inlet.notReady, rejected: inlet.rejected.length, tampered: inlet.tampered.length },
      cycle: { outcome: report.outcome, stop: report.stopReason, claimsSettled: report.claimsSettled, txs: report.transactionsSubmitted },
    };
  }

  it('simulates an Atlas-sized agent day by day and reports per-phase ops and storage', async () => {
    const daily: Record<string, unknown>[] = [];
    const mailboxItem = { docs: 0, items: 0, doc_bytes: 0, index_bytes: 0 };
    for (let day = 0; day < DAYS; day += 1) {
      // The emulator has no TTL worker. Execute only already-expired physical TTL rows with
      // counting off; TTL deletes are billed separately below. Never change a stored lifetime.
      setPhase(null);
      for (const collection of await rawPrivateFirestore(db).listCollections()) {
        if (!model.ttl.has(collection.id)) continue;
        const expired = (await collection.get()).docs.filter(doc => {
          const at = expireMs(doc.data().expire_at); return at !== null && at <= START + day * DAY;
        });
        for (const doc of expired) await doc.ref.delete();
      }
      currentDay = day;
      const dayStart = START + day * DAY;
      const info: Record<string, unknown> = { day };

      setNow(dayStart + 25 * 60_000);
      setPhase('anchor');
      info.anchor = await anchor();
      setPhase(null);

      let eligible = 0;
      let mailAcked = 0;
      for (let h = 0; h < 24; h += 1) {
        setNow(dayStart + h * HOUR + 5 * 60_000);
        const batchHour = (h + 1) % HOURS_PER_BATCH === 0;
        if (batchHour) {
          setPhase('ingest');
          await daemonSealTargets();
          const receipt = await postBatch(simNow);
          await settleIo();
          eligible += receipt.totals.eligible;
        }
        setPhase('daemon_hourly');
        await daemonHourlyReads();
        setPhase(null);
        setNow(dayStart + h * HOUR + 15 * 60_000);
        if (day === DAYS - 1 && batchHour && mailboxItem.items === 0) {
          // Size the waiting sealed copies (not counted): they live minutes when the phone drains
          // hourly, and until ACK when it never does. The measured scenario drains daily.
          const waiting = await db.collection('pe_mailbox_v1').where('to', '==', `human:${HUMAN_USER}`).get();
          for (const d of waiting.docs) {
            const data = d.data() as Record<string, unknown>;
            const nameSize = docNameSize(d.ref.path);
            mailboxItem.docs += 1;
            mailboxItem.items += Array.isArray(data.items) ? data.items.length : 1;
            mailboxItem.doc_bytes += nameSize + Object.entries(data).reduce((t, [k, v]) => t + strSize(k) + valueSize(v), 0) + 32;
            mailboxItem.index_bytes += indexBytes(model, 'pe_mailbox_v1', nameSize, data);
          }
        }
        if ((h + 1) % (24 / PHONE_DRAINS_PER_DAY) === 0) {
          setPhase('phone_mailbox');
          mailAcked += await phoneDrain();
          setPhase(null);
        }
        if (scenarioTakeover) {
          setPhase('scenario');
          // The forge sees yesterday's first commit (still inside its takeover window): takeover.
          if (h === 2 && day > 0) await forgeWitness(commitShaOf((day - 1) * ACTS_PER_BATCH + 7));
          // The forge sees today's last commit before the daemon's batch carries it: top-up.
          if (h === 6) await forgeWitness(commitShaOf(day * ACTS_PER_BATCH + ACTS_PER_BATCH - 1));
          setPhase(null);
        }
        if (h === 12) {
          setNow(dayStart + 12 * HOUR + 20 * 60_000);
          info.settlement = await settle();
          setPhase(null);
          setNow(dayStart + 12 * HOUR + 30 * 60_000);
          setPhase('daemon_proofs');
          info.proofs = await daemonProofs();
          setPhase(null);
        }
      }
      await settleIo();
      setPhase(null);
      info.eligible_acts = eligible;
      info.mailbox_acked = mailAcked;
      await scanStorage(rawPrivateFirestore(db), model, day, dayStart);
      daily.push(info);
      console.log('[meter-cost] day', JSON.stringify(info));
    }

    // ── per-day op table ──
    const phases = ['ingest', 'daemon_hourly', 'phone_mailbox', 'settle_inlet', 'settle_cycle', 'anchor', 'daemon_proofs'];
    const opsTable: Record<string, Record<string, Counts>> = {};
    const byCollection: Record<string, Record<string, Record<string, Counts>>> = {};
    for (let day = 0; day < DAYS; day += 1) {
      opsTable[day] = {};
      byCollection[day] = {};
      for (const p of phases) {
        const t = tallies.get(`${day}|${p}`) ?? new Map<string, Counts>();
        const sum = zero();
        byCollection[day][p] = {};
        for (const [coll, c] of t) {
          sum.reads += c.reads; sum.missing += c.missing; sum.writes += c.writes; sum.deletes += c.deletes;
          byCollection[day][p][coll] = c;
        }
        opsTable[day][p] = sum;
      }
    }

    // ── storage: one steady cohort (docs first seen on day COHORT), lifetimes and growth ──
    const COHORT = Number(process.env.METER_COST_COHORT ?? Math.max(0, DAYS - SETTLE_EVERY_DAYS - 6));
    interface StorageClass { docs: number; bytes: number; idx: number; ttl: number; deleted: number; permanent: number; residentByteDays: number; lifetimes: number[] }
    const classes = new Map<string, StorageClass>();
    for (const rec of ledger.values()) {
      if (rec.firstDay !== COHORT) continue;
      const c = classes.get(rec.coll) ?? { docs: 0, bytes: 0, idx: 0, ttl: 0, deleted: 0, permanent: 0, residentByteDays: 0, lifetimes: [] };
      c.docs += 1;
      c.bytes += rec.docBytes;
      c.idx += rec.idxBytes;
      let lifeDays: number;
      if (rec.expireAtMs !== null && model.ttl.has(rec.coll)) { c.ttl += 1; lifeDays = (rec.expireAtMs - rec.createdAtMs) / DAY; }
      else if (rec.deletedDay !== null) { c.deleted += 1; lifeDays = Math.max(1 / 24, rec.deletedDay - rec.firstDay); }
      else { c.permanent += 1; lifeDays = Number.POSITIVE_INFINITY; }
      c.lifetimes.push(lifeDays);
      if (Number.isFinite(lifeDays)) c.residentByteDays += (rec.docBytes + rec.idxBytes) * lifeDays;
      classes.set(rec.coll, c);
    }
    // Documents updated in place (tips, totals, registries): any that grew between the last two days.
    const grownInPlace: Record<string, { day_prev: number; day_last: number }> = {};
    for (const rec of ledger.values()) {
      // TTL'd per-act docs change state as they settle; only in-place docs (tips, totals) matter here.
      if (rec.deletedDay !== null || rec.firstDay >= DAYS - 2 || model.ttl.has(rec.coll)) continue;
      const prev = rec.bytesByDay.get(DAYS - 2);
      const last = rec.bytesByDay.get(DAYS - 1);
      if (prev !== undefined && last !== undefined && last !== prev) grownInPlace[`${rec.coll}/${rec.id}`] = { day_prev: prev, day_last: last };
    }
    const storage: Record<string, unknown> = {};
    for (const [k, c] of classes) {
      const finite = c.lifetimes.filter(Number.isFinite);
      storage[k] = {
        docs_per_day: c.docs, doc_bytes_per_day: c.bytes, index_bytes_per_day: c.idx,
        ttl_docs: c.ttl, deleted_docs: c.deleted, permanent_docs: c.permanent,
        lifetime_days_avg: finite.length > 0 ? finite.reduce((a, b) => a + b, 0) / finite.length : null,
        steady_resident_bytes: c.residentByteDays,
      };
    }

    // ── old path reconstruction (pe_history + provenance_envelopes per PE, forever) ──
    let oldPeHistory = 0;
    let oldEnvelopes = 0;
    let oldPeHistoryIndex = 0;
    let oldEnvelopeIndex = 0;
    let cohortActs = 0;
    for (const rec of ledger.values()) {
      if (rec.coll !== 'meter_act_keys_v1' || rec.firstDay !== COHORT) continue;
      const snap = await db.collection('meter_act_keys_v1').doc(rec.logicalId).get();
      const key = snap.data() as Record<string, unknown> | undefined;
      const pe = pesByRelayId.get(rec.logicalId);
      if (!key || !pe) continue;
      cohortActs += 1;
      const row = { ...(obj(key.row) ?? {}), inputSummary: typeof pe.description === 'string' ? pe.description : null, outputSummary: null };
      const rowName = docNameSize(`pe_history/${rec.logicalId}`);
      const rowIdx = indexBytes(model, 'pe_history', rowName, row);
      oldPeHistoryIndex += rowIdx;
      oldPeHistory += rowName + Object.entries(row).reduce((t, [k, v]) => t + strSize(k) + valueSize(v), 0) + 32 + rowIdx;
      const env: Record<string, unknown> = {
        id: rec.logicalId, wallet_id: WALLET_ID, agent_id: AGENT_ID, user_id: AGENT_ID, actor_address: AGENT_ADDRESS,
        action_type: pe.action_type, timestamp: pe.timestamp, prev_hash: key.prev_hash, hash: key.pe_hash,
        attestation_type: 'software', description: pe.description ?? null, metadata: pe.metadata ?? null,
        compute: pe.compute ?? null, geo: null, execution_env: pe.execution_env ?? null, input_origins: pe.input_origins ?? null,
        cited_pe_ids: null, parent_goal_pe_id: null, policy_action_type: pe.action_type, integration_source: 'device_pe_submit',
        counterparty_address: null, counterparty_type: null, session_lineage: null, self_referencing: false,
        trust_level_at_creation: null, created_at: pe.timestamp, durability: 'final', device_id: DEVICE_ID,
      };
      const envName = docNameSize(`provenance_envelopes/${rec.logicalId}`);
      const envIdx = indexBytes(model, 'provenance_envelopes', envName, env);
      oldEnvelopeIndex += envIdx;
      oldEnvelopes += envName + Object.entries(env).reduce((t, [k, v]) => t + strSize(k) + valueSize(v), 0) + 32 + envIdx;
    }

    // ── growth of any op count with history: the last day against every day of the steady half.
    // A count that grows with history exceeds all of them; day-to-day noise (a bounded recent
    // window catching one batch more or fewer) does not. ──
    const growth: string[] = [];
    const steadyFrom = Math.max(0, DAYS - 2 * SETTLE_EVERY_DAYS - 7);
    for (const p of phases) {
      const b = byCollection[DAYS - 1][p];
      // Like for like: with a longer settlement interval, compare days at the
      // same point of the settlement period (a settlement day only with settlement days).
      const earlier = Array.from({ length: DAYS - 1 - steadyFrom }, (_, i) => steadyFrom + i)
        .filter((d) => d % SETTLE_EVERY_DAYS === (DAYS - 1) % SETTLE_EVERY_DAYS)
        .map((d) => byCollection[d][p]);
      if (earlier.length === 0) continue;
      for (const coll of new Set([...earlier.flatMap((a) => Object.keys(a)), ...Object.keys(b)])) {
        for (const f of ['reads', 'writes', 'deletes'] as const) {
          const x = Math.max(...earlier.map((a) => a[coll]?.[f] ?? 0));
          const y = b[coll]?.[f] ?? 0;
          if (y > x) growth.push(`${p}:${coll}:${f} ${x}->${y}`);
        }
      }
    }

    // ── the annual arithmetic (us-central1 list prices, 2026-10-04) ──
    // The relay's database is the nam5 multi-region (Firestore Standard list prices there; a
    // single region such as us-central1 is half the per-op price).
    // moved the relay to us-central1. Both price sets are the Cloud Billing catalog's
    // Standard-edition SKUs (read 2026-10-04): nam5 "North America 5", us-central1 "Iowa".
    const GIB = 1024 ** 3;
    /** Ops that run once per settlement/anchor run whatever the number of agents (network-shared). */
    const SHARED = new Set(['pvt9_settlement_batches_v1', 'pvt9_settlement_cycles_v1', 'pvt9_settlement_signer_leases_v1',
      'pvt9_ledger_audit_v1', 'meter_anchor_days_v1']);
    // The steady window is one whole settlement period (one day when settlement is daily, a week
    // when it is weekly), averaged per day.
    const window = Array.from({ length: SETTLE_EVERY_DAYS }, (_, i) => byCollection[DAYS - 1 - i]);
    const agentOps = zero();
    const sharedOps = zero();
    const perPhase: Record<string, Counts> = {};
    for (const p of phases) {
      perPhase[p] = zero();
      for (const steady of window) {
        for (const [coll, c] of Object.entries(steady[p] ?? {})) {
          const into = SHARED.has(coll) ? sharedOps : agentOps;
          for (const f of ['reads', 'missing', 'writes', 'deletes'] as const) {
            const v = c[f] / SETTLE_EVERY_DAYS;
            into[f] += v;
            if (!SHARED.has(coll)) perPhase[p][f] += v;
          }
        }
      }
    }
    let ttlDeletesPerDay = 0;
    let agentResident = 0;
    let agentPermanentPerDay = 0;
    let sharedPermanentPerDay = 0;
    const SHARED_STORAGE = new Set([...SHARED, 'pvt_console_rollups', 'network_meter_hours_v1']);
    for (const [coll, c] of classes) {
      ttlDeletesPerDay += c.ttl;
      if (SHARED_STORAGE.has(coll)) { sharedPermanentPerDay += c.permanent > 0 ? c.bytes + c.idx : 0; continue; }
      agentResident += c.residentByteDays;
      if (c.permanent > 0) agentPermanentPerDay += (c.bytes + c.idx) * (c.permanent / c.docs);
    }
    const membershipBytesAt = (day: number): number => [...ledger.values()]
      .filter(r => r.coll === 'meter_occurrence_sets_v1' && (r.deletedDay === null || r.deletedDay > day))
      .reduce((sum, r) => sum + (r.bytesByDay.get(day) ?? 0), 0);
    const membershipGrowthPerDay = Math.max(0, (membershipBytesAt(DAYS - 1) - membershipBytesAt(DAYS - 1 - SETTLE_EVERY_DAYS)) / SETTLE_EVERY_DAYS);
    let otherInPlaceGrowthPerDay = 0;
    for (const r of ledger.values()) {
      if (r.coll === 'meter_occurrence_sets_v1' || r.firstDay >= DAYS - 1 - SETTLE_EVERY_DAYS || r.expireAtMs !== null || r.deletedDay !== null || SHARED_STORAGE.has(r.coll)) continue;
      const before = r.bytesByDay.get(DAYS - 1 - SETTLE_EVERY_DAYS), after = r.bytesByDay.get(DAYS - 1);
      if (before !== undefined && after !== undefined) otherInPlaceGrowthPerDay += Math.max(0, after - before) / SETTLE_EVERY_DAYS;
    }
    agentPermanentPerDay += otherInPlaceGrowthPerDay;
    agentResident += (mailboxItem.doc_bytes + mailboxItem.index_bytes) / 144; // accepted at :05, durably ACKed at :15
    const membershipCohort = classes.get('meter_occurrence_sets_v1');
    agentPermanentPerDay += membershipGrowthPerDay - (membershipCohort?.permanent ? (membershipCohort.bytes + membershipCohort.idx) * membershipCohort.permanent / membershipCohort.docs : 0);
    const actsPerDay = 24 * ACTS_PER_HOUR;
    const yr = {
      reads: agentOps.reads * 365 * PRICE.read,
      writes: agentOps.writes * 365 * PRICE.write,
      deletes: agentOps.deletes * 365 * PRICE.del,
      ttl_deletes: ttlDeletesPerDay * 365 * PRICE.del,
      ttl_storage: (agentResident / GIB) * 12 * PRICE.gibMonth,
      // A permanent class grows linearly: the year's GiB-months are the integral of the line.
      permanent_storage_year1: (agentPermanentPerDay / GIB) * (365 * 366 / 2 / 30.4375) * PRICE.gibMonth,
    };
    const agentYear = Object.values(yr).reduce((a, b) => a + b, 0);
    const sharedYearMeasuredAtWindow = sharedOps.reads * 365 * PRICE.read + sharedOps.writes * 365 * PRICE.write + sharedOps.deletes * 365 * PRICE.del
      + (sharedPermanentPerDay / GIB) * (365 * 366 / 2 / 30.4375) * PRICE.gibMonth;
    const sharedFinancialSamples = Array.from({ length: DAYS }, (_, day) => byCollection[day].settle_cycle?.pvt9_settlement_batches_v1?.reads ?? 0);
    const period = Math.max(1, SETTLE_EVERY_DAYS);
    const mean = (values: number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length;
    const earlyFinancial = mean(sharedFinancialSamples.slice(0, period));
    const lateFinancial = mean(sharedFinancialSamples.slice(-period));
    const financialReadGrowthPerDay = Math.max(0, (lateFinancial - earlyFinancial) / Math.max(1, DAYS - period));
    const sharedYear = sharedYearMeasuredAtWindow + Math.max(0, (182.5 - (DAYS - period / 2)) * financialReadGrowthPerDay) * 365 * PRICE.read;
    const oldPerAct = cohortActs > 0 ? (oldPeHistory + oldEnvelopes) / cohortActs : 0;
    const oldYear = {
      bytes_per_act: oldPerAct,
      year_end_gib: (oldPerAct * actsPerDay * 365) / GIB,
      storage_year1: ((oldPerAct * actsPerDay) / GIB) * (365 * 366 / 2 / 30.4375) * PRICE.gibMonth,
      two_doc_writes: 2 * actsPerDay * 365 * PRICE.write,
    };
    // Listed marginal rates, no free-tier deduction. Cloud Run uses measured local handler-path
    // wall time rounded to 100 ms at the deployment's CPU/memory sizing and concurrency; a runtime proxy, not
    // a Cloud Run bill. Gas requires an externally measured complete settlement fee (approval +
    // mint, incl. L1 data fee) from the deployed proof, never the fake kernel's test gas.
    const fleet = Number(process.env.METER_COST_FLEET_SIZE ?? 1000);
    const settlementFeeUsd = process.env.METER_COST_SETTLEMENT_FEE_USD === undefined ? null : Number(process.env.METER_COST_SETTLEMENT_FEE_USD);
    if (!Number.isSafeInteger(fleet) || fleet < 1 || settlementFeeUsd !== null && (!Number.isFinite(settlementFeeUsd) || settlementFeeUsd < 0)) throw new Error('cost_model_input_invalid');
    let runSecondsPerDay = 0, runInvocationsPerDay = 0, cpuSecondsPerDay = 0;
    for (let day = DAYS - SETTLE_EVERY_DAYS; day < DAYS; day++) for (const p of phases) {
      const sample = runtimeSamples.get(`${day}|${p}`); if (!sample) continue;
      const divisor = SETTLE_EVERY_DAYS * (p === 'anchor' ? fleet : 1);
      runSecondsPerDay += sample.seconds / divisor; runInvocationsPerDay += sample.invocations / divisor; cpuSecondsPerDay += sample.cpu_seconds / divisor;
    }
    const sizing = cloudRunSizing(readFileSync(path.resolve(__dirname, '../../../deploy-env.sh'), 'utf8'));
    const cloudRunYear = 365 * (runSecondsPerDay * (sizing.vcpus * 0.000024 + sizing.memoryGiB * 0.0000025) / sizing.concurrency + runInvocationsPerDay * 0.40 / 1_000_000);
    const pitrYear = yr.ttl_storage + yr.permanent_storage_year1;
    // Production: PITR on; no managed Firestore backup schedules; weekly durable exports kept
    // one year in us-central1 Archive storage. Export reads are billed once/document, incl. the
    // durable meter metadata. Retention policies are unchanged by this work.
    let exportResidentDocs = 0, permanentDocsPerDay = 0;
    for (const [coll, c] of classes) {
      if (['network_meter_hours_v1', 'pvt9_settlement_signer_leases_v1'].includes(coll) || SHARED_STORAGE.has(coll)) continue;
      exportResidentDocs += c.lifetimes.filter(Number.isFinite).reduce((sum, life) => sum + life, 0);
      if (coll !== 'meter_occurrence_sets_v1') permanentDocsPerDay += c.permanent;
    }
    const membershipNodes = [...ledger.values()].filter(r => r.coll === 'meter_occurrence_sets_v1' && r.deletedDay === null).length;
    const exportsPerYear = 365 / 7;
    const exportReadsYear = exportsPerYear * (exportResidentDocs + permanentDocsPerDay * 365 / 2 + membershipNodes) * PRICE.read;
    const exportStorageYear = ((agentResident * exportsPerYear / 2 * 12) + (agentPermanentPerDay * 365 * 365 / 42 * 12)) / GIB * 0.0012;
    const backupPitrYear = pitrYear + exportReadsYear + exportStorageYear;
    const settlementRunsPerDay = window.reduce((sum, _, i) => sum + Number(((daily[DAYS - 1 - i].settlement as {cycle?:{txs?:number}} | undefined)?.cycle?.txs) ?? 0), 0) / SETTLE_EVERY_DAYS;
    const fourLines = { firestore: agentYear + sharedYear / fleet, backups_pitr: backupPitrYear,
      settlement_gas: settlementFeeUsd === null ? null : settlementRunsPerDay * 365 * settlementFeeUsd,
      cloud_run: cloudRunYear };
    const cost = {
      four_lines_agent_year_usd: fourLines,
      four_lines_total_usd: settlementFeeUsd === null ? null : Object.values(fourLines).reduce<number>((sum, v) => sum + (v ?? 0), 0),
      cost_model_inputs: { fleet_size: fleet, settlement_fee_usd: settlementFeeUsd, settlement_runs_per_day: settlementRunsPerDay,
        cloud_run_runtime_proxy_seconds_per_day: runSecondsPerDay, measured_process_cpu_seconds_per_day: cpuSecondsPerDay,
        cloud_run_invocations_per_day: runInvocationsPerDay, cloud_run_vcpus: sizing.vcpus, cloud_run_memory_gib: sizing.memoryGiB,
        cloud_run_concurrent_requests_assumed: sizing.concurrency, pitr_year_usd: pitrYear, export_reads_year_usd: exportReadsYear,
        export_archive_storage_year_usd: exportStorageYear, pricing_sources: ['https://cloud.google.com/firestore/pricing','https://cloud.google.com/run/pricing','https://cloud.google.com/storage/pricing'] },
      steady_day: DAYS - 1,
      agent_ops_per_day: agentOps, shared_ops_per_day: sharedOps, agent_ops_by_phase: perPhase,
      ttl_deletes_per_day: ttlDeletesPerDay,
      agent_resident_ttl_bytes: agentResident, agent_permanent_bytes_per_day: agentPermanentPerDay,
      membership_growth_bytes_per_day: membershipGrowthPerDay, other_in_place_growth_bytes_per_day: otherInPlaceGrowthPerDay,
      shared_permanent_bytes_per_day: sharedPermanentPerDay,
      agent_year_usd: yr, agent_year_total_usd: agentYear, per_1000_acts_usd: agentYear / (actsPerDay * 365) * 1000,
      shared_year_usd_standalone: sharedYear, financial_audit_read_growth_per_day: financialReadGrowthPerDay,
      with_shared_usd: { n1: agentYear + sharedYear, n100: agentYear + sharedYear / 100, n10000: agentYear + sharedYear / 10_000 },
      old_path: oldYear,
    };

    setPhase(null);
    const fingerprint = await economicFingerprint();
    console.log('[meter-cost] economic fingerprint', JSON.stringify(fingerprint));
    const receiptOutcomesDigest = createHash('sha256').update(JSON.stringify(receipts.map(r => ({ acts: r.acts, totals: r.totals })))).digest('hex');
    const result = { days: DAYS, private_storage: PRIVATE_STORAGE, cohort_day: COHORT, fingerprint, receipt_outcomes_digest: receiptOutcomesDigest, daily, ops: opsTable, by_collection: byCollection, storage,
      grown_in_place: grownInPlace, op_growth: growth, cost,
      mailbox_item: mailboxItem,
      old_path: { cohort_acts: cohortActs, pe_history_bytes_incl_index: oldPeHistory, pe_history_index_bytes: oldPeHistoryIndex,
        envelope_bytes_incl_index: oldEnvelopes, envelope_index_bytes: oldEnvelopeIndex } };
    if (process.env.METER_COST_OUT) writeFileSync(process.env.METER_COST_OUT, JSON.stringify(result, null, 1));
    console.log('[meter-cost] steady-day ops by phase', JSON.stringify(perPhase));
    console.log('[meter-cost] cost', JSON.stringify(cost, null, 1));
    console.log('[meter-cost] op growth day-over-day', JSON.stringify(growth));
    console.log('[meter-cost] grown in place', JSON.stringify(grownInPlace));
    if (process.env.METER_COST_TRACE && process.env.METER_COST_TRACE_OUT) {
      const sites = [...traceSites.entries()].sort((a, b) => b[1].reads - a[1].reads).map(([site, t]) => ({ site, ...t }));
      writeFileSync(process.env.METER_COST_TRACE_OUT, JSON.stringify(sites, null, 1));
    }

    // Nothing the meter owns may read or write more as history accumulates. One known exception
    // is reported, not hidden: the network-stats counter picks a random shard (noise, ± a few
    // either way). (The applied-batch finality sweep reads an index since the cost pass.)
    const financialAuditGrowth = growth.filter(g => /^settle_cycle:pvt9_settlement_batches_v1:reads /.test(g));
    // Permanent transaction journals are batch-sized financial audit state. The encrypted
    // adapter's canonical-cursor defense reads them; expose that network-shared slope rather
    // than silently treating the fake store's empty range-query as one billed read.
    // Short pinned runs are economic controls, not a claim that TTL storage is already steady.
    const warm = DAYS >= 90;
    expect(growth.filter(g => !/pvt_network_stats\/shards/.test(g) && !financialAuditGrowth.includes(g)
      && (warm || !/^settle_cycle:pvt9_claim_ledger_v1:reads /.test(g)))).toEqual([]);
    // Nothing per act or per agent is kept forever: every document a day of this agent creates
    // expires (TTL) or is deleted, except network-shared settlement/console records and the
    // agent's own bounded state (tips, totals, pair counts), which the in-place check above covers.
    //
    // The novelty counters (`pvt_novelty_counters_v1`,) are kept on purpose. The occurrence
    // counter is the durable count of one actor's acts of one type on one UTC day, and the only
    // one: Redis's `pvt:occ` copy expires after 25 hours. A `pending_cache` act waits in
    // `meter_held_acts_v1` (never expiring) until Redis returns and is then priced at its original
    // day's ordinal, with no age bound on that recovery (every other path either records an act
    // older than 30 days without reading a counter or, for a Genesis grant exempt from that window,
    // prices a fixed grant the counter cannot move). An expired occurrence counter would reseed
    // from Redis at zero and price that act at full novelty again. The per-day counter beside it
    // seals only the daily ordinal, which moves no price since; it is kept with its sibling.
    // So they grow by one small document per action type an actor used per active day, plus one,
    // never per act: pinned below.
    const PERMANENT_OK = new Set(['meter_occurrence_due_v1','pvt9_settlement_batches_v1', 'pvt9_settlement_cycles_v1', 'pvt_console_rollups', NOVELTY_COUNTERS_COLLECTION, PACKED_DAY_COUNTERS, 'pe_mailbox_acks_v1', 'meter_occurrence_sets_v1', 'pvt9_payee_settlement_clocks_v1', 'commit_mint_claims', 'completion_mint_claims', 'x402_tx_mint_claims', 'financial_settlement_mint_claims', 'occurrence_mint_claims']);
    const permanentPerDay = [...classes.entries()].filter(([coll, c]) => c.permanent > 0 && !PERMANENT_OK.has(coll)).map(([coll]) => coll);
    // Permanent hard cross-witness ownership is counted in permanent_storage_year1 above.
    // (The takeover scenario's voided claims carry no expiry — a void claim never pays and is kept
    // for audit — so the plain mix alone pins this.)
    if (SCENARIO === '') expect(permanentPerDay).toEqual([]);
    if (SCENARIO === '') {
      // One counter per (actor, action type, day) and one per (actor, day): bounded by the day's
      // distinct action types, however many acts the day carried.
      const novelty = classes.get(PACKED_DAY_COUNTERS);
      expect(novelty?.docs ?? 0).toBeGreaterThan(0);
      expect({ docs: novelty?.docs, permanent: novelty?.permanent }).toEqual({ docs: 1, permanent: 1 });
    }
    // One page per batch and recipient (cost pass): an hour's sealed copies wait in ONE document.
    expect(mailboxItem.docs).toBeGreaterThanOrEqual(1);
    expect(mailboxItem.items).toBe(ACTS_PER_BATCH);
    // A cost change must not move a single economic outcome (receipts, act rows, legs, claims,
    // ledger, kernel settlement). Pin the digest a baseline run printed.
    if (process.env.METER_COST_EXPECT_FINGERPRINT) {
      expect(fingerprint.digest).toBe(process.env.METER_COST_EXPECT_FINGERPRINT);
    }

    if (process.env.METER_COST_EXPECT_ECONOMIC) {
      const baseline = JSON.parse(readFileSync(process.env.METER_COST_EXPECT_ECONOMIC, 'utf8')) as { fingerprint: typeof fingerprint; receipt_outcomes_digest?: string };
      expect(fingerprint.acts_digest).toBe(baseline.fingerprint.acts_digest);
      expect(JSON.stringify(fingerprint.settled_by_payee)).toBe(JSON.stringify(baseline.fingerprint.settled_by_payee));
      if (baseline.receipt_outcomes_digest) expect(receiptOutcomesDigest).toBe(baseline.receipt_outcomes_digest);
    }

    // The scenario really took acts over and really paid top-ups (a fingerprint over a scenario
    // that did neither would prove nothing).
    if (scenarioTakeover) {
      expect(fingerprint.counts.taken_over).toBeGreaterThan(0);
      expect(fingerprint.counts.topup_claims).toBeGreaterThan(0);
      expect(fingerprint.counts.topup_settled).toBeGreaterThan(0);
      expect(fingerprint.counts.forge_minted).toBeGreaterThan(0);
    }

    // Sanity (RED-able): the agent actually earned and the human actually drained its copies.
    const last = daily[DAYS - 1] as { eligible_acts: number; mailbox_acked: number };
    expect(last.eligible_acts).toBeGreaterThan(0);
    // (+ the scenario's two forge acts a day, each sealed to the linked human too.)
    expect(last.mailbox_acked).toBe(24 * ACTS_PER_HOUR + (scenarioTakeover ? 2 : 0));
  });
});
