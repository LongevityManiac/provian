/**
 * WS F — settlement LANE SCOPE.
 *
 * the invariant: the Genesis lane settles DAILY, the standard lane stays
 * WEEKLY at; made BOTH lanes daily, and returned the standard lane
 * to weekly. The scheduler runs a genesis-scoped cycle at 00:00 UTC every day and an unscoped
 * ('both') cycle at 16:30 UTC every Saturday (`30 16 * * 6`). The whole cadence rests on ONE property of `applyLaneScope` a
 * `'genesis'`-scoped run drains genesis and leaves standard's selected rows as
 * untouched backlog; a `'standard'`-scoped run does the mirror; `'both'` (the
 * default and the both-lanes run) touches neither.
 *
 * If a daily genesis run also drained the standard lane, standard work would settle
 * a lane against the invariant: the exact defect this guards.
 *
 * The RED control is in-suite and non-vacuous: the SAME populated lanes that a
 * scoped run empties on one side are shown FULLY RETAINED under `'both'`, so
 * "genesis scope drops standard" cannot pass because the fixture was empty or
 * because the helper drops everything — it passes because scope selects the lane.
 */

import { applyLaneScope, applyPayeeScope, type LaneWork } from './settlement-cycle-runner';

/** A populated lane fixture — non-empty `items` so "emptied" is observable. */
function laneWork(lane: 'standard' | 'genesis'): LaneWork {
  return {
    lane,
    items: [{ contributor: `0x${lane === 'standard' ? '1' : '2'}`.padEnd(42, '0'), claimIds: [`${lane}_claim`] }],
    rowsByClaimId: new Map([[`${lane}_claim`, { claim_id: `${lane}_claim` } as never]]),
  };
}

const populated = (): { standard: LaneWork; genesis: LaneWork } => ({
  standard: laneWork('standard'),
  genesis: laneWork('genesis'),
});

describe('settlement lane scope (WS F)', () => {
  it("'genesis' scope settles genesis and holds standard as backlog", () => {
    const { standard: s0, genesis: g0 } = populated();
    const { standard, genesis } = applyLaneScope('genesis', s0, g0);
    // Genesis retained intact (the daily lane)...
    expect(genesis.items).toHaveLength(1);
    expect(genesis).toBe(g0); // same object — untouched, not a rebuild
    // ...standard emptied for THIS cycle (held as backlog, still labeled standard).
    expect(standard.items).toHaveLength(0);
    expect(standard.lane).toBe('standard');
  });

  it("'standard' scope settles standard and holds genesis as backlog (mirror)", () => {
    const { standard: s0, genesis: g0 } = populated();
    const { standard, genesis } = applyLaneScope('standard', s0, g0);
    expect(standard.items).toHaveLength(1);
    expect(standard).toBe(s0);
    expect(genesis.items).toHaveLength(0);
    expect(genesis.lane).toBe('genesis');
  });

  it("RED control — 'both' settles BOTH lanes (scoped emptying is scope-driven, not unconditional)", () => {
    const { standard: s0, genesis: g0 } = populated();
    const { standard, genesis } = applyLaneScope('both', s0, g0);
    // The very lanes a scoped run emptied above are here BOTH retained. A helper
    // that always dropped a lane, or a fixture that was empty to begin with, would
    // fail this — so the scoped-emptying tests cannot be passing vacuously.
    expect({ standard: standard.items.length, genesis: genesis.items.length }).toEqual({ standard: 1, genesis: 1 });
    expect(standard).toBe(s0);
    expect(genesis).toBe(g0);
  });

  it('does not mutate its inputs (the held lane survives for its own cadence)', () => {
    const { standard: s0, genesis: g0 } = populated();
    applyLaneScope('genesis', s0, g0);
    // The standard input the caller still holds is unchanged — the drop is a fresh
    // empty LaneWork, never an in-place clear of the caller's backlog.
    expect(s0.items).toHaveLength(1);
  });
});

/**
 * — the on-demand payout settles ONE payee's standard earnings and nobody else's.
 * The RED control is the unscoped call over the same two-payee fixture: both payees survive, so the
 * scoped run's single survivor is the payee filter, not an empty fixture.
 */
describe('settlement payee scope ( on-demand payout)', () => {
  const alice = '0x' + 'a'.repeat(40);
  const bob = '0x' + 'b'.repeat(40);
  const twoPayees = (): LaneWork => ({
    lane: 'standard',
    items: [
      { contributor: alice, claimIds: ['a1', 'a2'] },
      { contributor: bob, claimIds: ['b1'] },
    ],
    rowsByClaimId: new Map([
      ['a1', { claim_id: 'a1' } as never],
      ['a2', { claim_id: 'a2' } as never],
      ['b1', { claim_id: 'b1' } as never],
    ]),
  });

  it('keeps only the named payee (case-insensitive) and only its rows', () => {
    const scoped = applyPayeeScope(alice.toUpperCase().replace('0X', '0x'), twoPayees());
    expect(scoped.items.map((i) => i.contributor)).toEqual([alice]);
    expect([...scoped.rowsByClaimId.keys()].sort()).toEqual(['a1', 'a2']);
  });

  it('a payee with no unsettled claims settles nothing', () => {
    const scoped = applyPayeeScope('0x' + 'c'.repeat(40), twoPayees());
    expect(scoped.items).toHaveLength(0);
    expect(scoped.rowsByClaimId.size).toBe(0);
  });

  it('RED control — no payee keeps every payee (the filter is what narrows)', () => {
    const input = twoPayees();
    const scoped = applyPayeeScope(undefined, input);
    expect(scoped.items).toHaveLength(2);
    expect(scoped).toBe(input);
  });
});
