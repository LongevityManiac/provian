/**
 * Tests for computeEffectiveStatus - the read-time governance-status
 * computer. Table-driven across all seven cases specified in the finding
 * + boundary timestamps + quorum-context presence / absence.
 */

import {
  computeEffectiveStatus,
  withEffectiveStatus,
  type EffectiveProposalStatus,
  type QuorumContext,
} from './effective-status';
import type { GovernanceProposalDocument } from '../agent-bank/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_PROPOSAL: GovernanceProposalDocument = {
  proposal_id: 1,
  proposer_wallet_id: 'w_test',
  proposer_address: '0xABCD',
  target: '0xPVT',
  action: 'updateMintRate',
  parameters: { newRate: '1100000000000000000' },
  description: 'bump',
  call_data: '0xdeadbeef',
  votes_for: '0',
  votes_against: '0',
  voting_end: 7_000, // 7s in the fake timeline
  execution_start: 10_000,
  execution_end: 17_000,
  status: 'active',
  tx_hash: '0xtx',
  pe_ids: [],
  created_at: 0,
  updated_at: 0,
};

function propWith(overrides: Partial<GovernanceProposalDocument>): GovernanceProposalDocument {
  return { ...BASE_PROPOSAL, ...overrides };
}

// quorumBps=1000 (10%), totalSupply=100 → threshold=10
const QUORUM: QuorumContext = {
  totalSupply: 100n,
  quorumBps: 1000,
};

// ---------------------------------------------------------------------------
// Case 1: Before voting_end → 'active'
// ---------------------------------------------------------------------------

describe('computeEffectiveStatus - active', () => {
  test('just-created proposal is active', () => {
    expect(computeEffectiveStatus(propWith({}), 0)).toBe('active');
  });

  test('at exact voting_end is still active (contract uses strict >)', () => {
    expect(computeEffectiveStatus(propWith({}), 7_000)).toBe('active');
  });

  test('one millisecond past voting_end is NOT active', () => {
    const status = computeEffectiveStatus(propWith({}), 7_001);
    expect(status).not.toBe('active');
  });
});

// ---------------------------------------------------------------------------
// Case 2: After voting_end, failed
// ---------------------------------------------------------------------------

describe('computeEffectiveStatus - failed', () => {
  test('votes_for == votes_against is failed', () => {
    const p = propWith({ votes_for: '5', votes_against: '5' });
    expect(computeEffectiveStatus(p, 8_000, QUORUM)).toBe('failed');
  });

  test('votes_for < votes_against is failed', () => {
    const p = propWith({ votes_for: '1', votes_against: '99' });
    expect(computeEffectiveStatus(p, 8_000, QUORUM)).toBe('failed');
  });

  test('quorum not met is failed even when votes_for > votes_against', () => {
    // threshold = 100 * 1000 / 10000 = 10. Total votes = 5+3 = 8 < 10.
    const p = propWith({ votes_for: '5', votes_against: '3' });
    expect(computeEffectiveStatus(p, 8_000, QUORUM)).toBe('failed');
  });

  test('without quorum context, quorum check is skipped (optimistic passed)', () => {
    const p = propWith({ votes_for: '5', votes_against: '3' });
    // No QUORUM → cannot detect quorum miss → passes, enters passed state.
    expect(computeEffectiveStatus(p, 8_000)).toBe('passed');
  });

  test('quorumBps=0 means no quorum requirement (any vote passes)', () => {
    const p = propWith({ votes_for: '1', votes_against: '0' });
    const zeroQuorum: QuorumContext = { totalSupply: 10_000n, quorumBps: 0 };
    expect(computeEffectiveStatus(p, 8_000, zeroQuorum)).toBe('passed');
  });
});

// ---------------------------------------------------------------------------
// Case 3: After voting_end, passed, before execution_start
// ---------------------------------------------------------------------------

describe('computeEffectiveStatus - passed', () => {
  test('passed proposal between voting_end and execution_start', () => {
    // votes_for=50, votes_against=10 → 60 >= 10 threshold ✓; 50 > 10 ✓
    const p = propWith({ votes_for: '50', votes_against: '10' });
    expect(computeEffectiveStatus(p, 8_000, QUORUM)).toBe('passed');
  });

  test('at exact execution_start is executable (not passed)', () => {
    const p = propWith({ votes_for: '50', votes_against: '10' });
    expect(computeEffectiveStatus(p, 10_000, QUORUM)).toBe('executable');
  });

  test('one ms before execution_start is still passed', () => {
    const p = propWith({ votes_for: '50', votes_against: '10' });
    expect(computeEffectiveStatus(p, 9_999, QUORUM)).toBe('passed');
  });
});

// ---------------------------------------------------------------------------
// Case 4: After execution_start, before execution_end → 'executable'
// ---------------------------------------------------------------------------

describe('computeEffectiveStatus - executable', () => {
  test('at execution_start is executable', () => {
    const p = propWith({ votes_for: '50', votes_against: '10' });
    expect(computeEffectiveStatus(p, 10_000, QUORUM)).toBe('executable');
  });

  test('middle of execution window is executable', () => {
    const p = propWith({ votes_for: '50', votes_against: '10' });
    expect(computeEffectiveStatus(p, 13_000, QUORUM)).toBe('executable');
  });

  test('at exact execution_end is executable', () => {
    const p = propWith({ votes_for: '50', votes_against: '10' });
    expect(computeEffectiveStatus(p, 17_000, QUORUM)).toBe('executable');
  });
});

// ---------------------------------------------------------------------------
// Case 5: After execution_end, passed but never executed → 'expired'
// ---------------------------------------------------------------------------

describe('computeEffectiveStatus - expired', () => {
  test('one ms past execution_end is expired', () => {
    const p = propWith({ votes_for: '50', votes_against: '10' });
    expect(computeEffectiveStatus(p, 17_001, QUORUM)).toBe('expired');
  });

  test('far future is expired', () => {
    const p = propWith({ votes_for: '50', votes_against: '10' });
    expect(computeEffectiveStatus(p, 100_000_000, QUORUM)).toBe('expired');
  });

  test('stored "expired" (dormant - never actually written) is passed through', () => {
    const p = propWith({ status: 'expired' });
    expect(computeEffectiveStatus(p, 0)).toBe('expired');
  });
});

// ---------------------------------------------------------------------------
// Case 6: Explicitly executed
// ---------------------------------------------------------------------------

describe('computeEffectiveStatus - terminal stored statuses', () => {
  test('executed is terminal', () => {
    const p = propWith({ status: 'executed' });
    expect(computeEffectiveStatus(p, 100_000, QUORUM)).toBe('executed');
  });

  test('executed_pending_review is terminal', () => {
    const p = propWith({ status: 'executed_pending_review' });
    expect(computeEffectiveStatus(p, 100_000, QUORUM)).toBe('executed_pending_review');
  });

  test('vetoed is terminal', () => {
    const p = propWith({ status: 'vetoed' });
    expect(computeEffectiveStatus(p, 100_000, QUORUM)).toBe('vetoed');
  });
});

// ---------------------------------------------------------------------------
// Case 7: Cancelled / withdrawn - distinguished by cancelled_by
// ---------------------------------------------------------------------------

describe('computeEffectiveStatus - cancelled vs withdrawn', () => {
  test('cancelled with cancelled_by=proposer is "withdrawn"', () => {
    const p = propWith({ status: 'cancelled' });
    (p as unknown as { cancelled_by: string }).cancelled_by = 'proposer';
    expect(computeEffectiveStatus(p, 8_000, QUORUM)).toBe('withdrawn');
  });

  test('cancelled with cancelled_by=admin is "cancelled"', () => {
    const p = propWith({ status: 'cancelled' });
    (p as unknown as { cancelled_by: string }).cancelled_by = 'admin';
    expect(computeEffectiveStatus(p, 8_000, QUORUM)).toBe('cancelled');
  });

  test('cancelled with no cancelled_by field defaults to "cancelled"', () => {
    const p = propWith({ status: 'cancelled' });
    expect(computeEffectiveStatus(p, 8_000, QUORUM)).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// withEffectiveStatus wrapper - preserves other fields
// ---------------------------------------------------------------------------

describe('withEffectiveStatus', () => {
  test('replaces status, preserves every other field', () => {
    const p = propWith({ votes_for: '50', votes_against: '10' });
    const enriched = withEffectiveStatus(p, 13_000, QUORUM);
    expect(enriched.status).toBe<EffectiveProposalStatus>('executable');
    expect(enriched.proposal_id).toBe(p.proposal_id);
    expect(enriched.votes_for).toBe(p.votes_for);
    expect(enriched.voting_end).toBe(p.voting_end);
    expect(enriched.tx_hash).toBe(p.tx_hash);
  });

  test('does not mutate the input', () => {
    const p = propWith({ votes_for: '50', votes_against: '10' });
    const original = { ...p };
    withEffectiveStatus(p, 13_000, QUORUM);
    expect(p).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// Sanity: no emitted status is outside the EffectiveProposalStatus union
// ---------------------------------------------------------------------------

describe('computeEffectiveStatus - no unexpected emissions', () => {
  const ALLOWED: EffectiveProposalStatus[] = [
    'active', 'passed', 'failed', 'executable', 'expired',
    'executed', 'executed_pending_review', 'cancelled', 'withdrawn', 'vetoed',
  ];

  test.each([
    { voting_end: 7_000, now: 0, label: 'pre-vote' },
    { voting_end: 7_000, now: 7_000, label: 'at voting_end' },
    { voting_end: 7_000, now: 8_000, label: 'just after voting_end' },
    { voting_end: 7_000, now: 10_000, label: 'at execution_start' },
    { voting_end: 7_000, now: 13_000, label: 'mid-execution-window' },
    { voting_end: 7_000, now: 17_000, label: 'at execution_end' },
    { voting_end: 7_000, now: 17_001, label: 'just after execution_end' },
    { voting_end: 7_000, now: 100_000_000, label: 'far future' },
  ])('emits allowed status at boundary: $label', ({ now }) => {
    const p = propWith({ votes_for: '50', votes_against: '10' });
    const s = computeEffectiveStatus(p, now, QUORUM);
    expect(ALLOWED).toContain(s);
  });
});
