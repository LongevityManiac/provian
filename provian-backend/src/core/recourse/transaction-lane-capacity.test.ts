import { Interface } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { acquireSignerLease, SETTLEMENT_SIGNER_LEASES_COLLECTION, type SettlementDb } from '../pvt/settlement/durable-settlement-store';
import { simulatedBase, laneTestWallet, type SimulatedBase } from './__test-helpers__/lane-chain-fixture';
import { laneQueueKey, runRecourseLane, type LaneKind, type LaneReport } from './transaction-lane';
import { BINDING_SEND_MARGIN_MS } from './transaction-lane-kinds';
import { runAutomaticMembershipSweep, type AutomaticMembershipResult } from './automatic-membership';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C } from './private-membership-reservation';
import { runRecourseMinute } from './transaction-lane-schedule';

/**
 * Capacity of the Recourse lane, end to end on the real engine, sweep and minute
 * schedule, against a simulated Base (two-second blocks, receipts, the twelve-
 * confirmation rule) under a virtual clock. Latencies are deliberately slower
 * than production measurements:
 *   - a binding or debit check: 2 s of RPC, eight checked at once;
 *   - signing, persisting and broadcasting one transaction: 250 ms, one at a time;
 *   - collecting one member's monthly debit: 2 s, eight at once.
 * Request handlers kick the lane with a 5 s budget; the scheduler runs every minute.
 */
const CHECK_MS = 2_000, SEND_MS = 250, COLLECT_MS = 2_000, BLOCK_MS = 2_000, KICK_MS = 5_000, DAY = 86_400_000;
const START = Date.UTC(2026, 11, 1);
const wallet = laneTestWallet(), LANE = wallet.address.toLowerCase(), MINTER = `0x${'f0'.repeat(20)}`;
const call = new Interface(['function bind(bytes32)', 'function debit(bytes32)']);
const BINDINGS = 'sim_bindings', DEBITS = 'sim_debits';
const id = (prefix: number, n: number) => `0x${prefix.toString(16).padStart(2, '0')}${n.toString(16).padStart(62, '0')}`;

class Simulation {
  readonly fake: FakeFirestore = createFakeFirestore();
  readonly db = this.fake as unknown as Firestore;
  readonly base: SimulatedBase = simulatedBase(wallet.address);
  clock = START;
  private nextBlock = START + BLOCK_MS;
  laneFreeAt = START;
  readonly settlementChecks: { atMs: number; kind: string }[] = [];
  readonly reports: LaneReport[] = [];
  /** Terminal rows leave the fake store so its full-scan queries stay small; the lane never reads them again. */
  readonly archive = new Map<string, Record<string, unknown>>();
  /** Wallet → time its binding was included on chain, and → time the lane saw twelve confirmations. */
  readonly bound = new Map<number, number>();
  readonly confirmedAt = new Map<number, number>();
  /** Block numbers start at the fixture's head 1,000 at START, one every two seconds. */
  blockTime(block: number) { return START + (block - 1_000) * BLOCK_MS; }
  readonly paid = new Map<string, number>();
  archiveTerminal() {
    for (const [key, row] of [...this.fake.store.entries()]) {
      if ((key.startsWith(`${BINDINGS}/`) || key.startsWith(`${DEBITS}/`)) && (row.status === 'confirmed' || row.status === 'failed')) {
        this.archive.set(key, row); this.fake.store.delete(key);
      }
    }
  }
  signer = { address: LANE, signTransaction: async (tx: Parameters<typeof wallet.signTransaction>[0]) => {
    this.advance(SEND_MS); return wallet.signTransaction(tx);
  } };
  advance(ms: number) {
    this.clock += ms;
    while (this.clock >= this.nextBlock) { this.base.mine(); this.nextBlock += BLOCK_MS; }
  }
  until(t: number) { if (t > this.clock) this.advance(t - this.clock); }
  now = () => this.clock;
  async lane(kinds: LaneKind[], budgetMs: number) {
    const report = await runRecourseLane({ db: this.db, signer: this.signer, chain: this.base, kinds, workerId: `w${this.clock}`,
      now: this.now, sleep: async ms => this.advance(ms) }, this.clock + budgetMs);
    this.reports.push(report); this.laneFreeAt = this.clock;
    return report;
  }
  rows(prefix: string) {
    return [...this.archive.entries(), ...this.fake.store.entries()].filter(([k]) => k.startsWith(`${prefix}/`)).map(([, v]) => v);
  }
  /** Settlement uses the minter's own lease. Recourse traffic must never hold it. */
  async settlementOnTime(kind: string) {
    const lease = await acquireSignerLease(this.db as unknown as SettlementDb,
      { signer: MINTER, workerId: `settlement-${this.clock}`, nowMs: this.clock, leaseTtlMs: 1 });
    this.settlementChecks.push({ atMs: this.clock, kind: lease.kind });
  }
}
/** Each binding's calldata commits to its id; a row is live until its signature window less the send margin. */
function bindingKind(sim: Simulation): LaneKind {
  return { name: 'binding', collection: BINDINGS,
    async prepare(row) {
      if (Number(row.data.expiresAtMs) <= sim.now() + BINDING_SEND_MARGIN_MS) return { kind: 'finish', status: 'failed', reason: 'binding_expired' };
      sim.advance(CHECK_MS / 8);
      return { kind: 'sign', plan: { executor: `0x${'b1'.repeat(20)}`, calldata: call.encodeFunctionData('bind', [row.id]), fields: {} } };
    },
    expected: row => ({ executor: `0x${'b1'.repeat(20)}`, calldata: call.encodeFunctionData('bind', [row.id]) }),
    async settle(row, receipt) {
      if (receipt.status !== 1) return { status: 'failed', reason: 'transaction_reverted' };
      const wallet = Number(row.data.wallet);
      if (!sim.bound.has(wallet)) { sim.bound.set(wallet, sim.blockTime(receipt.block)); sim.confirmedAt.set(wallet, sim.now()); }
      return { status: 'confirmed', reason: 'binding_finalized' };
    } };
}
function debitKind(sim: Simulation): LaneKind {
  return { name: 'debit', collection: DEBITS,
    async prepare(row) {
      if (Number(row.data.expiresAtMs) <= sim.now()) return { kind: 'finish', status: 'failed', reason: 'recourse_membership_debit_stale' };
      sim.advance(CHECK_MS / 8);
      return { kind: 'sign', plan: { executor: `0x${'d1'.repeat(20)}`, calldata: call.encodeFunctionData('debit', [row.id]), fields: {} } };
    },
    expected: row => ({ executor: `0x${'d1'.repeat(20)}`, calldata: call.encodeFunctionData('debit', [row.id]) }),
    async settle(row, receipt) {
      if (receipt.status !== 1) return { status: 'failed', reason: 'transaction_reverted' };
      if (!sim.paid.has(String(row.data.owner))) sim.paid.set(String(row.data.owner), sim.now());
      return { status: 'confirmed', reason: 'transaction_confirmed' };
    } };
}

/** 10,000 wallets in one UTC day: a quiet base load, a 2,000-wallet peak hour and a
 * 1,000-wallet launch spike inside ten minutes. Each wallet's signature is valid five
 * minutes. An expired signature is re-signed by the agent a minute later (its daemon). */
test('10,000 new wallets in one day are all bound that day, settlement acquires its own signer on time throughout', async () => {
  const sim = new Simulation(), kind = bindingKind(sim);
  const arrivals: number[] = [];
  for (let i = 0; i < 7_000; i++) arrivals.push(START + Math.floor((i + 0.5) * DAY / 7_000));
  for (let i = 0; i < 2_000; i++) arrivals.push(START + 14 * 3_600_000 + Math.floor(i * 3_600_000 / 2_000));
  for (let i = 0; i < 1_000; i++) arrivals.push(START + 18 * 3_600_000 + Math.floor(i * 600_000 / 1_000));
  arrivals.sort((a, b) => a - b);
  expect(arrivals).toHaveLength(10_000);
  const events: { at: number; wallet: number; attempt: number }[] = arrivals.map((at, wallet) => ({ at, wallet, attempt: 0 }));
  let resigned = 0, nextMinute = START + 60_000, n = 0;
  const settlementTimes = [START + 12 * 3_600_000, START + 18 * 3_600_000 + 300_000, START + DAY];
  const enqueue = (e: { at: number; wallet: number; attempt: number }) => {
    const rowId = id(1, n++);
    sim.fake.store.set(`${BINDINGS}/${rowId}`, { status: 'queued', wallet: e.wallet, attempt: e.attempt, createdAtMs: e.at,
      expiresAtMs: e.at + 300_000, laneQueueKey: laneQueueKey(e.at, rowId) });
  };
  const minute = async () => {
    // The scheduler minute; re-signs come from agents whose signature expired.
    for (const row of sim.rows(BINDINGS)) {
      if (row.status === 'failed' && row.terminalReason === 'binding_expired' && !row.resigned) {
        row.resigned = true; resigned++;
        events.push({ at: sim.clock + 60_000, wallet: Number(row.wallet), attempt: Number(row.attempt) + 1 });
      }
    }
    events.sort((a, b) => a.at - b.at);
    await sim.lane([kind], 52_000);
    sim.archiveTerminal();
  };
  // Run past midnight only to observe confirmations of the day's last inclusions.
  while (events.length > 0 || sim.clock < START + DAY || sim.bound.size < 10_000) {
    const next = events[0]?.at ?? Infinity;
    if (nextMinute <= next) {
      sim.until(nextMinute);
      while (settlementTimes.length && settlementTimes[0] <= sim.clock) { settlementTimes.shift(); await sim.settlementOnTime('settlement'); }
      await minute(); nextMinute += 60_000;
      if (nextMinute > START + DAY + 30 * 60_000) break;
      continue;
    }
    const e = events.shift()!;
    sim.until(e.at);
    enqueue(e);
    // The request's inline kick runs only if no other handler holds the lane.
    if (sim.laneFreeAt <= e.at) await sim.lane([kind], KICK_MS);
  }
  const unbound = [...Array(10_000).keys()].filter(w => !sim.bound.has(w));
  if (unbound.length) process.stdout.write(`unbound ${JSON.stringify(unbound.slice(0, 5).map(w => sim.rows(BINDINGS).filter(r => r.wallet === w)
    .map(r => ({ status: r.status, reason: r.terminalReason, at: Number(r.createdAtMs) - START, nonce: r.laneNonce }))))} clock ${sim.clock - START}\n`);
  while (settlementTimes.length) { settlementTimes.shift(); await sim.settlementOnTime('settlement'); }
  const bound = sim.bound.size;
  const lastBound = Math.max(...sim.bound.values());
  const slowestConfirm = Math.max(...[...sim.confirmedAt].map(([w, at]) => at - sim.bound.get(w)!));
  const expired = sim.rows(BINDINGS).filter(v => v.terminalReason === 'binding_expired').length;
  const sends = sim.reports.reduce((t, r) => t + r.signed, 0);
  // Every wallet is bound on chain the same UTC day, and the lane records it twelve confirmations later.
  expect(bound).toBe(10_000);
  expect(lastBound).toBeLessThan(START + DAY);
  expect(slowestConfirm).toBeLessThan(2 * 60_000);
  // Each transaction was sent once: one per binding row signed, none for an expired row.
  expect(sends).toBe(10_000 + resigned - expired);
  expect(sim.base.state.mined.size).toBe(sends);
  expect(sim.base.state.maxPending).toBeLessThanOrEqual(16);
  // Settlement takes its own signer lease at every scheduled time, mid-spike included.
  expect(sim.settlementChecks.map(c => c.kind)).toEqual(['acquired', 'acquired', 'acquired']);
  expect([...sim.fake.store.keys()].filter(k => k.startsWith(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/`) && !k.endsWith(MINTER))).toEqual([]);
  process.stdout.write(`binding capacity: ${bound} bound, ${expired} expired and re-signed, last included ${new Date(lastBound).toISOString()}, slowest confirmation ${slowestConfirm / 1000} s after inclusion\n`);
}, 600_000);

/** 50,000 members all due on the first of the month. Each debit authorization
 * is valid five minutes. The window to pay a month runs to the end of the next. */
test('monthly debits for 50,000 members are all collected inside their window', async () => {
  const sim = new Simulation(), kind = debitKind(sim);
  // 50,000 member accounts, served by an indexed stand-in for the one collection the sweep pages through.
  const owners = [...Array(50_000).keys()].map(i => id(2, i));
  const ownerPage = (after: string | null, limit: number) => {
    let lo = 0, hi = owners.length;
    if (after) { while (lo < hi) { const mid = (lo + hi) >> 1; if (owners[mid] <= after) lo = mid + 1; else hi = mid; } } else lo = 0;
    const docs = owners.slice(lo, lo + limit).map(owner => ({ id: owner, get: (field: string) => field === 'ownerIdentity' ? owner : undefined }));
    return { docs, size: docs.length, empty: docs.length === 0 };
  };
  const ownersQuery = (after: string | null = null, limit = 0): unknown => ({ orderBy: () => ownersQuery(after, limit),
    limit: (n: number) => ownersQuery(after, n), startAfter: (value: string | { id: string }) => ownersQuery(typeof value === 'string' ? value : value.id, limit),
    get: async () => { ownerReads += limit; return ownerPage(after, limit); } });
  const fakeCollection = sim.fake.collection.bind(sim.fake);
  (sim.fake as unknown as { collection: (name: string) => unknown }).collection = (name: string) => name === C.owners ? ownersQuery() : fakeCollection(name);
  let ownerReads = 0;
  const inflight = new Map<string, string>();
  let n = 0;
  /** A member with no paid debit and none in flight gets one prepared and queued. */
  const collect = async (_db: Firestore, owner: string): Promise<AutomaticMembershipResult> => {
    if (sim.paid.has(owner)) { sim.advance(20 / 8); return 'settled'; }
    const prior = inflight.get(owner);
    if (prior) {
      const row = sim.fake.store.get(`${DEBITS}/${prior}`) ?? sim.archive.get(`${DEBITS}/${prior}`)!;
      if (row.status !== 'failed') { sim.advance(20 / 8); return 'pending'; }
    }
    sim.advance(COLLECT_MS / 8);
    const rowId = id(3, n++);
    sim.fake.store.set(`${DEBITS}/${rowId}`, { status: 'queued', owner, createdAtMs: sim.clock, expiresAtMs: sim.clock + 300_000,
      laneQueueKey: laneQueueKey(sim.clock, rowId) });
    inflight.set(owner, rowId);
    return 'queued';
  };
  const backlog = async () => sim.rows(DEBITS).filter(v => v.status === 'queued').length;
  const windowEnd = Date.UTC(2027, 1, 1);
  let minutes = 0;
  while (sim.clock < windowEnd) {
    await runRecourseMinute({ now: sim.now, lane: budget => sim.lane([kind], budget),
      sweep: options => runAutomaticMembershipSweep(sim.db, { ...options, concurrency: 8, collect }), debitBacklog: backlog });
    sim.archiveTerminal();
    minutes++;
    sim.until(START + minutes * 60_000);
    if (minutes % 60 === 0 && sim.paid.size === 50_000) break;
  }
  const lastPaid = Math.max(...sim.paid.values());
  const stale = sim.rows(DEBITS).filter(v => v.terminalReason === 'recourse_membership_debit_stale').length;
  expect(sim.paid.size).toBe(50_000);
  expect(lastPaid).toBeLessThan(windowEnd);
  // Collected well inside the window, not just before its edge.
  expect(lastPaid - START).toBeLessThan(3 * DAY);
  // Member accounts are read once per daily pass, never once per page.
  const passes = Math.ceil((lastPaid - START) / DAY) + 1;
  expect(ownerReads).toBeLessThanOrEqual(passes * (50_000 + 500));
  // One transaction per debit sent; an authorization that expired unsent cost nothing and was prepared again.
  expect(sim.base.state.mined.size).toBe(sim.rows(DEBITS).filter(v => v.laneNonce !== undefined).length);
  process.stdout.write(`debit capacity: 50000 collected by ${new Date(lastPaid).toISOString()} (${((lastPaid - START) / 3_600_000).toFixed(1)} h), ${stale} expired before sending, ${ownerReads} account reads\n`);
}, 1_800_000);
