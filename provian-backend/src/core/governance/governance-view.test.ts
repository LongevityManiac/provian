/**
 * Pass-2 WS-Commons #7 + #33 — backend shapes the Commons governance reads.
 *
 * #7: toGovernanceProposalView maps the stored GovernanceProposalDocument
 *     (contract vocabulary: voting_end, votes_for as a BigInt weight string,
 *     execution_start/end) into the shape the mobile cards actually read —
 *     title, voting_ends_at, quorum_reached, numeric votes + raw weight strings.
 *
 * #33: listDocumentedPETypeProposals reads the LIVE pe_type_catalog and surfaces
 *      only community-DOCUMENTED entries (first_doc_at present), keyed by
 *      action_type so the client upvote endorses the right catalog entry.
 */
import { describe, it, expect } from '@jest/globals';
import {
  toGovernanceProposalView,
  isQuorumReached,
  computeEffectiveStatus,
  type QuorumContext,
} from './effective-status';
import type { GovernanceProposalDocument } from '../agent-bank/types';
import { listDocumentedPETypeProposals } from '../agent-bank/pe-proposals';
import type { AgentBankDeps } from '../agent-bank/types';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';

const PVT = (whole: bigint): string => (whole * 1_000_000_000_000_000_000n).toString();

function baseProposal(overrides: Partial<GovernanceProposalDocument> = {}): GovernanceProposalDocument {
  const now = 1_000_000;
  return {
    proposal_id: 42,
    proposer_wallet_id: 'wal_proposer',
    proposer_address: '0xabc',
    target: '0xtarget',
    action: 'updateMintRate',
    parameters: { rate: 15000 },
    description: 'Raise the mint rate to 1.5x',
    call_data: '0xdead',
    votes_for: PVT(150n),
    votes_against: PVT(50n),
    voting_end: now + 10_000, // future ⇒ effective status 'active'
    execution_start: now + 20_000,
    execution_end: now + 30_000,
    status: 'active',
    pe_ids: [],
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('Pass-2 #7 — toGovernanceProposalView', () => {
  // 1000 PVT total supply, 10% quorum ⇒ a 100-PVT threshold.
  const quorum: QuorumContext = { totalSupply: 1000n * 1_000_000_000_000_000_000n, quorumBps: 1000 };

  it('emits title / voting_ends_at / numeric votes / raw weights the card reads', () => {
    const view = toGovernanceProposalView(baseProposal(), 1_000_000, quorum);

    // title (backend has no `title` column — derived from the human-readable action)
    expect(view.title).toBe('updateMintRate');
    expect(view.description).toBe('Raise the mint rate to 1.5x');

    // countdown field the card reads (was `voting_end` on the raw doc → undefined)
    expect(view.voting_ends_at).toBe(1_000_000 + 10_000);

    // numeric votes for the ratio bar (no more string concatenation)
    expect(view.votes_for).toBe(150);
    expect(view.votes_against).toBe(50);
    expect(typeof view.votes_for).toBe('number');

    // raw weight strings preserved as the source of truth
    expect(view.total_weight_for).toBe(PVT(150n));
    expect(view.total_weight_against).toBe(PVT(50n));

    // execution window remapped to the card's field names
    expect(view.execution_window_start).toBe(1_000_000 + 20_000);
    expect(view.execution_window_end).toBe(1_000_000 + 30_000);

    // proposal_id stringified, status computed
    expect(view.proposal_id).toBe('42');
    expect(view.status).toBe('active');
  });

  it('quorum_reached reflects the contract threshold', () => {
    // 200 PVT cast vs a 10% threshold of 100 PVT ⇒ met.
    expect(isQuorumReached(baseProposal(), quorum)).toBe(true);
    expect(toGovernanceProposalView(baseProposal(), 1_000_000, quorum).quorum_reached).toBe(true);

    // Same votes but a 50% threshold (500 PVT) ⇒ not met.
    const strict: QuorumContext = { totalSupply: 1000n * 1_000_000_000_000_000_000n, quorumBps: 5000 };
    expect(isQuorumReached(baseProposal(), strict)).toBe(false);
    expect(toGovernanceProposalView(baseProposal(), 1_000_000, strict).quorum_reached).toBe(false);

    // No quorum context ⇒ contract treats every proposal as quorum-met.
    expect(isQuorumReached(baseProposal())).toBe(true);
  });

  it('falls back to a generic title when action is empty, and tolerates malformed weights', () => {
    const view = toGovernanceProposalView(
      baseProposal({ action: '', votes_for: 'not-a-number', votes_against: '' }),
      1_000_000,
      quorum,
    );
    expect(view.title).toBe('Governance Proposal');
    expect(view.votes_for).toBe(0);
    expect(view.votes_against).toBe(0);
  });

  it('does NOT throw on a malformed weight for a VOTING-CLOSED proposal (degrades to a status)', () => {
    // voting_end in the PAST (0 < nowMs) so computeEffectiveStatus reaches the
    // BigInt parse instead of short-circuiting to 'active'. A bad weight must
    // degrade to a benign status, never throw and 500 the whole listing.
    const closed = baseProposal({
      voting_end: 0,
      votes_for: 'not-a-number',
      votes_against: '0',
    });
    expect(() => computeEffectiveStatus(closed, 1_000_000, quorum)).not.toThrow();
    expect(computeEffectiveStatus(closed, 1_000_000, quorum)).toBe('failed');
    // And the full view is produced without throwing.
    expect(() => toGovernanceProposalView(closed, 1_000_000, quorum)).not.toThrow();
    expect(toGovernanceProposalView(closed, 1_000_000, quorum).status).toBe('failed');
  });
});

describe('Pass-2 #33 — listDocumentedPETypeProposals reads the live catalog', () => {
  function deps(db: FakeFirestore): AgentBankDeps {
    return { db } as unknown as AgentBankDeps;
  }

  function seedCatalog(db: FakeFirestore): void {
    // Documented community proposal (has first_doc_at) — SHOULD appear.
    db.store.set('pe_type_catalog/custom_signal', {
      action_type: 'custom_signal',
      first_observed_at: 100,
      first_observed_by_wallet: 'wal_observer',
      category: 'social',
      observation_count: 3,
      status: 'active',
      source: 'auto_registered',
      description: 'A custom corroboration signal',
      use_case: 'Third-party attestation of a delivery',
      upvotes: 5,
      voters: ['a', 'b', 'c', 'd', 'e'],
      first_doc_at: 200,
      first_doc_by_wallet: 'wal_author',
    });
    // Another documented proposal, fewer upvotes — appears, but sorted below.
    db.store.set('pe_type_catalog/agent_handshake', {
      action_type: 'agent_handshake',
      first_observed_at: 110,
      first_observed_by_wallet: 'wal_observer2',
      category: 'institutional',
      observation_count: 1,
      status: 'active',
      source: 'namespace',
      description: 'Agent-to-agent handshake',
      use_case: 'Establishing a session',
      upvotes: 2,
      first_doc_at: 210,
      first_doc_by_wallet: 'wal_author2',
    });
    // Observed-only seed entry (NO first_doc_at) — must NOT appear.
    db.store.set('pe_type_catalog/send', {
      action_type: 'send',
      first_observed_at: 50,
      first_observed_by_wallet: 'system:seed',
      category: 'financial',
      observation_count: 999,
      status: 'active',
      source: 'seed',
    });
  }

  it('returns only documented entries, keyed by action_type, sorted by upvotes', async () => {
    const db = createFakeFirestore();
    seedCatalog(db);

    const proposals = await listDocumentedPETypeProposals(deps(db));
    const ids = proposals.map((p) => p.proposal_id);

    // Observed-only 'send' excluded; documented ones included.
    expect(ids).not.toContain('send');
    expect(ids).toEqual(['custom_signal', 'agent_handshake']); // upvotes desc

    const first = proposals[0];
    // proposal_id == action_type so the upvote endpoint endorses the right entry.
    expect(first.proposal_id).toBe(first.action_type);
    expect(first.action_type).toBe('custom_signal');
    expect(first.description).toBe('A custom corroboration signal');
    expect(first.use_case).toBe('Third-party attestation of a delivery');
    expect(first.upvotes).toBe(5);
    expect(first.proposer_wallet_id).toBe('wal_author'); // first_doc_by_wallet
    expect(first.created_at).toBe(200); // first_doc_at
    expect(first.status).toBe('active');
  });

  it('returns an empty list when no types have been documented', async () => {
    const db = createFakeFirestore();
    db.store.set('pe_type_catalog/send', {
      action_type: 'send',
      first_observed_at: 50,
      first_observed_by_wallet: 'system:seed',
      category: 'financial',
      observation_count: 999,
      status: 'active',
      source: 'seed',
    });
    await expect(listDocumentedPETypeProposals(deps(db))).resolves.toEqual([]);
  });
});
