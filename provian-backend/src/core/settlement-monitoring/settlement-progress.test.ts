import { describe, expect, it } from '@jest/globals';
import { SETTLEMENT_CYCLE_MAX_RUN_MS } from '../pvt/wp4/operator-runtime';
import {
  NO_CYCLE_GRACE_MS,
  SETTLEMENT_WAIT_MARGIN_MS,
  formatPvt,
  initialNarratorState,
  judgeFollow,
  narrateProgress,
  settlementWaitBudgetMs,
  type BatchView,
  type CycleView,
  type ProgressSnapshot,
} from './settlement-progress';

// The 2026-09-30 manual standard-lane run: POST at 04:23:09Z, answer at ~04:29:05Z.
const OBSERVED_RUN_MS = (5 * 60 + 56) * 1000;
const CLOUD_RUN_TIMEOUT_MS = 3600 * 1000;

const cycle = (over: Partial<CycleView> = {}): CycleView => ({
  cycle_id: 'epoch0-2026-09-30-r2',
  status: 'active',
  stop_reason: null,
  batches_confirmed: 0,
  claims_settled: 0,
  lease_expires_at_ms: 2_000_000,
  ...over,
});

const batch = (over: Partial<BatchView> = {}): BatchView => ({
  batch_id: '0x6c4f92f86a6658539b897559e9508667af6bcc8ed6e97d5adefab6a795c56879',
  cycle_id: 'epoch0-2026-09-30-r2',
  lane: 'standard',
  status: 'reserved',
  claim_count: 41,
  total_minted_atomic: '25468612800000000000',
  attempt_tx_hashes: [],
  confirmed_tx_hash: null,
  confirmed_block_number: null,
  dead_reason: null,
  ...over,
});

const TX = '0xf5b7343cabfc811f514236d485c1a3abd355f72dfde918d3e97868d5d0a23501';

describe('settlementWaitBudgetMs — the wait outlasts a normal run', () => {
  it('RED: the 280 s client wait that produced the false timeout is shorter than the observed run', () => {
    expect(280_000).toBeLessThan(OBSERVED_RUN_MS);
    expect(settlementWaitBudgetMs(CLOUD_RUN_TIMEOUT_MS, SETTLEMENT_CYCLE_MAX_RUN_MS)).toBeGreaterThan(OBSERVED_RUN_MS);
  });

  it('never waits less than the service can hold the request open, nor less than the cycle budget', () => {
    expect(settlementWaitBudgetMs(CLOUD_RUN_TIMEOUT_MS, SETTLEMENT_CYCLE_MAX_RUN_MS))
      .toBe(CLOUD_RUN_TIMEOUT_MS + SETTLEMENT_WAIT_MARGIN_MS);
    // A short or unreadable service timeout never shrinks the wait below the cycle's own budget.
    for (const t of [null, 0, 60_000, Number.NaN]) {
      expect(settlementWaitBudgetMs(t, SETTLEMENT_CYCLE_MAX_RUN_MS))
        .toBe(SETTLEMENT_CYCLE_MAX_RUN_MS + SETTLEMENT_WAIT_MARGIN_MS);
    }
  });
});

describe('narrateProgress — a line at each stage', () => {
  const stages: ProgressSnapshot[] = [
    { claimsRegistered: 80, cycles: [], batches: [] },
    { claimsRegistered: 80, cycles: [cycle()], batches: [batch()] },
    { claimsRegistered: 80, cycles: [cycle()], batches: [batch({ status: 'submitted', attempt_tx_hashes: [TX] })] },
    {
      claimsRegistered: 80,
      cycles: [cycle({ status: 'completed', batches_confirmed: 4, claims_settled: 296 })],
      batches: [batch({ status: 'confirmed', attempt_tx_hashes: [TX], confirmed_tx_hash: TX, confirmed_block_number: 51976583 })],
    },
  ];

  it('tells registration, the cycle, each tx sent, its confirmation, and the cycle outcome, in order', () => {
    let state = initialNarratorState();
    const all: string[] = [];
    for (const snap of stages) {
      const out = narrateProgress(state, snap);
      all.push(...out.lines);
      state = out.state;
    }
    expect(all).toEqual([
      'claims registered: 80',
      'settlement cycle epoch0-2026-09-30-r2 running',
      'batch 0x6c4f92f8…: 41 claims, 25.4686 PVT (standard lane)',
      `batch 0x6c4f92f8…: tx sent ${TX}`,
      `batch 0x6c4f92f8…: confirmed in block 51976583 (tx ${TX})`,
      'settlement cycle epoch0-2026-09-30-r2 completed: 4 batch(es) confirmed, 296 claims settled',
    ]);
  });

  it('RED: polling the same snapshot again prints nothing new', () => {
    let state = initialNarratorState();
    for (const snap of stages) state = narrateProgress(state, snap).state;
    expect(narrateProgress(state, stages[stages.length - 1]).lines).toEqual([]);
  });

  it('a first sighting that is already finished still tells every stage', () => {
    const out = narrateProgress(initialNarratorState(), stages[3]);
    expect(out.lines).toHaveLength(5);
    expect(out.lines[out.lines.length - 1]).toContain('completed');
  });

  it('names a replacement transaction and a dead batch', () => {
    const lines = narrateProgress(initialNarratorState(), {
      claimsRegistered: 0,
      cycles: [],
      batches: [batch({ status: 'dead', attempt_tx_hashes: ['0xaaa', '0xbbb'], dead_reason: 'reverted' })],
    }).lines;
    expect(lines).toContain('batch 0x6c4f92f8…: tx sent 0xaaa');
    expect(lines).toContain('batch 0x6c4f92f8…: replacement tx sent 0xbbb');
    expect(lines).toContain('batch 0x6c4f92f8…: dead (reverted)');
  });

  it('formats atomic PVT', () => {
    expect(formatPvt('25468612800000000000')).toBe('25.4686');
    expect(formatPvt('1000000000000000000')).toBe('1');
    expect(formatPvt('not-a-number')).toBe('?');
  });
});

describe('judgeFollow — a lost answer is not a failed run', () => {
  const NOW = 1_000_000;
  const DEADLINE = NOW + 10 * 60 * 1000;

  it('RED: a 504 while the cycle is still running keeps following, it does not report failure', () => {
    const j = judgeFollow({
      http: { kind: 'answered', status: 504, atMs: NOW },
      cycles: [cycle({ lease_expires_at_ms: NOW + 60_000 })],
      nowMs: NOW,
      deadlineMs: DEADLINE,
    });
    expect(j).toEqual({ done: false, ok: false, reason: 'cycle_still_running' });
  });

  it('CONTROL: the same lost answer followed by a completed cycle is a success', () => {
    const j = judgeFollow({
      http: { kind: 'lost', reason: 'socket hang up', atMs: NOW },
      cycles: [cycle({ status: 'completed' })],
      nowMs: NOW + 1,
      deadlineMs: DEADLINE,
    });
    expect(j).toEqual({ done: true, ok: true, reason: 'cycle_completed_after_lost_answer' });
  });

  it('a stopped cycle, an expired lease, or no cycle at all is a failure', () => {
    expect(judgeFollow({ http: { kind: 'lost', reason: 'x', atMs: NOW }, cycles: [cycle({ status: 'stopped', stop_reason: 'alarm' })], nowMs: NOW, deadlineMs: DEADLINE }).reason)
      .toBe('cycle_stopped');
    expect(judgeFollow({ http: { kind: 'lost', reason: 'x', atMs: NOW }, cycles: [cycle({ lease_expires_at_ms: NOW - NO_CYCLE_GRACE_MS - 1 })], nowMs: NOW, deadlineMs: DEADLINE }).reason)
      .toBe('cycle_lease_expired');
    expect(judgeFollow({ http: { kind: 'lost', reason: 'x', atMs: NOW }, cycles: [], nowMs: NOW + 1000, deadlineMs: DEADLINE }).done).toBe(false);
    expect(judgeFollow({ http: { kind: 'lost', reason: 'x', atMs: NOW }, cycles: [], nowMs: NOW + NO_CYCLE_GRACE_MS, deadlineMs: DEADLINE }).reason)
      .toBe('no_cycle_observed');
  });

  it('a 2xx is done, a 4xx refusal is done and failed, and pending waits until the budget ends', () => {
    expect(judgeFollow({ http: { kind: 'answered', status: 200, atMs: NOW }, cycles: [], nowMs: NOW, deadlineMs: DEADLINE }))
      .toEqual({ done: true, ok: true, reason: 'relay_answered' });
    expect(judgeFollow({ http: { kind: 'answered', status: 409, atMs: NOW }, cycles: [], nowMs: NOW, deadlineMs: DEADLINE }).reason)
      .toBe('relay_refused_409');
    expect(judgeFollow({ http: { kind: 'pending' }, cycles: [cycle()], nowMs: NOW, deadlineMs: DEADLINE }).done).toBe(false);
    expect(judgeFollow({ http: { kind: 'pending' }, cycles: [cycle()], nowMs: DEADLINE, deadlineMs: DEADLINE }).reason)
      .toBe('wait_budget_exhausted');
  });
});
