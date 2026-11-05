import {
  allocateCursorRanges,
  validateCursorChain,
  verifyClaimIdentity,
  type AllocatedCursorRange,
  type ClaimIdentityVerdict,
  type ProposedClaim,
  type RecordedClaim,
} from './claim-identity';

function hash(seed: number): string {
  return `0x${seed.toString(16).padStart(64, '0')}`;
}

const CLAIM_A = hash(0xaaa);
const CLAIM_B = hash(0xbbb);
const ANCHOR_A = hash(0xa11);
const ANCHOR_B = hash(0xb22);

/**
 * M9 — keyed by the CLAIM (`peId#leg`), the way `selectLaneWork` keys it. Keying this fixture by
 * PE, as it did pre-M9, silently collapsed the two legs of a split act onto one entry, which is
 * precisely the defect that made a split act unsettleable and wedged the whole cycle.
 */
function ledgerOf(...records: RecordedClaim[]): ReadonlyMap<string, RecordedClaim> {
  return new Map(records.map((record) => [`${record.peId}#${record.leg}`, record]));
}

import { PAYOUT_LEG_ROLES } from '../wp-ev/payout-legs';

function kinds(verdict: ClaimIdentityVerdict): string[] {
  return verdict.kind === 'stable' ? [] : verdict.violations.map((violation) => violation.kind);
}

describe('verifyClaimIdentity', () => {
  it('M9 — a PE id containing the key separator is refused, so the join stays unambiguous', () => {
    // The whole `${peId}#${leg}` scheme rests on `#` being impossible inside a PE id. Asserted
    // here rather than assumed from the registration path, because this module must not depend
    // on a caller having validated — the separator argument would then be a claim about someone
    // else's code. The violating case IS constructible: the field is a plain string.
    expect(kinds(verifyClaimIdentity(
      [{ peId: 'pe-1#beneficiary', leg: 'sole', claimId: CLAIM_A, lane: 'standard' }],
      ledgerOf(),
    ))).toEqual(['invalid_claim']);

    // GREEN CONTROL: the same proposal with a legal id is accepted, so the refusal is about the
    // separator and not about the fixture being malformed some other way.
    expect(verifyClaimIdentity(
      [{ peId: 'pe-1', leg: 'sole', claimId: CLAIM_A, lane: 'standard' }],
      ledgerOf(),
    )).toEqual({ kind: 'stable' });
  });

  it('M9r2 — a ledger record with an unrecognized leg FAILS CLOSED, it is not skipped', () => {
    // Skipping it dropped the record from both indexes, so every drift check was silently
    // unenforced for that claim and the verdict came back `stable`. `leg` is half the document
    // id and was validated nowhere at the write boundary, so the state is reachable.
    const malformed = {
      peId: 'pe-1', leg: 'not-a-leg', claimId: CLAIM_A, lane: 'standard', settled: true,
    } as unknown as RecordedClaim;
    const verdict = verifyClaimIdentity(
      [{ peId: 'pe-1', leg: 'sole', claimId: CLAIM_B, lane: 'standard' }],
      new Map([['pe-1#not-a-leg', malformed]]),
    );
    expect(kinds(verdict)).toContain('invalid_claim');

    // RED CONTROL: the SAME record with a real leg is indexed and its identity IS enforced —
    // so the refusal above is about the malformed leg, and the checker is otherwise live.
    expect(kinds(verifyClaimIdentity(
      [{ peId: 'pe-1', leg: 'sole', claimId: CLAIM_B, lane: 'standard' }],
      ledgerOf({ peId: 'pe-1', leg: 'sole', claimId: CLAIM_A, lane: 'standard', settled: true }),
    ))).toEqual(expect.arrayContaining(['pe_already_settled', 'claim_id_drift']));
  });

  it('M9r2 — the leg vocabulary is the ONE source, not a third copy', () => {
    // A fourth role added in `payout-legs.ts` must be accepted here automatically. When this
    // module declared its own list, such a role made `isValidLeg` reject every ledger record
    // carrying it — disabling the drift checker wholesale, with no test failure.
    for (const leg of PAYOUT_LEG_ROLES) {
      expect(verifyClaimIdentity(
        [{ peId: 'pe-1', leg, claimId: CLAIM_A, lane: 'standard' }],
        ledgerOf({ peId: 'pe-1', leg, claimId: CLAIM_A, lane: 'standard', settled: false }),
      )).toEqual({ kind: 'stable' });
    }
    expect(PAYOUT_LEG_ROLES.length).toBeGreaterThan(1);
  });

  it('M9 — two legs of one act are NOT a duplicate, but the same leg twice is', () => {
    const legs: ProposedClaim[] = [
      { peId: 'pe-1', leg: 'agent', claimId: CLAIM_A, lane: 'standard' },
      { peId: 'pe-1', leg: 'beneficiary', claimId: CLAIM_B, lane: 'standard' },
    ];
    expect(verifyClaimIdentity(legs, ledgerOf())).toEqual({ kind: 'stable' });

    // RED CONTROL: the SAME leg proposed twice is still a duplicate. Without this the check
    // above could pass simply because the duplicate detector had been removed.
    expect(kinds(verifyClaimIdentity([legs[0], legs[0]], ledgerOf())))
      .toContain('duplicate_claim_in_proposal');

    // And two legs that somehow derived the SAME claim id is a collision — a case the pre-M9
    // PE-keyed comparison would have waved through, because both sightings shared a peId.
    expect(kinds(verifyClaimIdentity([
      { peId: 'pe-1', leg: 'agent', claimId: CLAIM_A, lane: 'standard' },
      { peId: 'pe-1', leg: 'beneficiary', claimId: CLAIM_A, lane: 'standard' },
    ], ledgerOf()))).toContain('claim_id_collision');
  });

  it('accepts a proposal that keeps every PE its recorded identity', () => {
    const proposed: ProposedClaim[] = [
      { peId: 'pe-1', leg: 'sole', claimId: CLAIM_A, lane: 'standard' },
      { peId: 'pe-2', leg: 'sole', claimId: CLAIM_B, lane: 'genesis', genesisAnchorKey: ANCHOR_A },
    ];
    const ledger = ledgerOf(
      { peId: 'pe-1', leg: 'sole', claimId: CLAIM_A, lane: 'standard', settled: false },
      { peId: 'pe-2', leg: 'sole', claimId: CLAIM_B, lane: 'genesis', settled: false, genesisAnchorKey: ANCHOR_A },
    );
    expect(verifyClaimIdentity(proposed, ledger)).toEqual({ kind: 'stable' });
  });

  it('accepts a PE seen for the first time, and an empty proposal', () => {
    expect(verifyClaimIdentity([{ peId: 'new', leg: 'sole', claimId: CLAIM_A, lane: 'standard' }], ledgerOf()))
      .toEqual({ kind: 'stable' });
    expect(verifyClaimIdentity([], ledgerOf())).toEqual({ kind: 'stable' });
  });

  it('catches a re-derived claim id for a known PE — the standard-lane double mint', () => {
    // The kernel dedupes on claimId alone and holds no PE identity, so this
    // would settle a second time and mint again, undetected on-chain.
    const verdict = verifyClaimIdentity(
      [{ peId: 'pe-1', leg: 'sole', claimId: CLAIM_B, lane: 'standard' }],
      ledgerOf({ peId: 'pe-1', leg: 'sole', claimId: CLAIM_A, lane: 'standard', settled: false }),
    );
    expect(verdict).toEqual({
      kind: 'violations',
      violations: [{ kind: 'claim_id_drift', peId: 'pe-1', claimId: CLAIM_B, recorded: CLAIM_A }],
    });
  });

  it('catches an already-settled PE, and reports drift alongside it', () => {
    const settledLedger = ledgerOf({
      peId: 'pe-1', leg: 'sole', claimId: CLAIM_A, lane: 'standard', settled: true,
    });

    expect(kinds(verifyClaimIdentity([{ peId: 'pe-1', leg: 'sole', claimId: CLAIM_A, lane: 'standard' }], settledLedger)))
      .toEqual(['pe_already_settled']);

    // The dangerous shape: settled PE re-proposed under a fresh claim id.
    expect(kinds(verifyClaimIdentity([{ peId: 'pe-1', leg: 'sole', claimId: CLAIM_B, lane: 'standard' }], settledLedger)))
      .toEqual(['pe_already_settled', 'claim_id_drift']);
  });

  it('catches a claim id shared by two PEs, in-proposal and against the ledger', () => {
    // The kernel would settle the first and revert on the second, so one PE's
    // work would silently never mint.
    expect(
      kinds(verifyClaimIdentity(
        [
          { peId: 'pe-1', leg: 'sole', claimId: CLAIM_A, lane: 'standard' },
          { peId: 'pe-2', leg: 'sole', claimId: CLAIM_A, lane: 'standard' },
        ],
        ledgerOf(),
      )),
    ).toEqual(['claim_id_collision']);

    expect(
      kinds(verifyClaimIdentity(
        [{ peId: 'pe-2', leg: 'sole', claimId: CLAIM_A, lane: 'standard' }],
        ledgerOf({ peId: 'pe-1', leg: 'sole', claimId: CLAIM_A, lane: 'standard', settled: false }),
      )),
    ).toEqual(['claim_id_owned_by_other_pe']);
  });

  it('catches a duplicated PE, a lane change, and an anchor change', () => {
    expect(
      kinds(verifyClaimIdentity(
        [
          { peId: 'pe-1', leg: 'sole', claimId: CLAIM_A, lane: 'standard' },
          { peId: 'pe-1', leg: 'sole', claimId: CLAIM_A, lane: 'standard' },
        ],
        ledgerOf(),
      )),
    ).toEqual(['duplicate_claim_in_proposal']);

    expect(
      kinds(verifyClaimIdentity(
        [{ peId: 'pe-1', leg: 'sole', claimId: CLAIM_A, lane: 'genesis', genesisAnchorKey: ANCHOR_A }],
        ledgerOf({ peId: 'pe-1', leg: 'sole', claimId: CLAIM_A, lane: 'standard', settled: false }),
      )),
    ).toEqual(['lane_drift']);

    expect(
      kinds(verifyClaimIdentity(
        [{ peId: 'pe-1', leg: 'sole', claimId: CLAIM_A, lane: 'genesis', genesisAnchorKey: ANCHOR_B }],
        ledgerOf({
          peId: 'pe-1', leg: 'sole', claimId: CLAIM_A, lane: 'genesis', settled: false, genesisAnchorKey: ANCHOR_A,
        }),
      )),
    ).toEqual(['genesis_anchor_drift']);
  });

  it('treats claim ids case-insensitively, so casing alone is not drift', () => {
    expect(
      verifyClaimIdentity(
        [{ peId: 'pe-1', leg: 'sole', claimId: CLAIM_A.toUpperCase().replace('0X', '0x'), lane: 'standard' }],
        ledgerOf({ peId: 'pe-1', leg: 'sole', claimId: CLAIM_A, lane: 'standard', settled: false }),
      ),
    ).toEqual({ kind: 'stable' });
  });

  it('rejects malformed proposals without letting them mask other checks', () => {
    const bad: ProposedClaim[] = [
      { peId: '', leg: 'sole', claimId: CLAIM_A, lane: 'standard' },
      { peId: 'pe-2', leg: 'sole', claimId: '0xdeadbeef', lane: 'standard' },
      { peId: 'pe-3', leg: 'sole', claimId: CLAIM_A, lane: 'nope' as ProposedClaim['lane'] },
      // Genesis without its anchor, and standard carrying one.
      { peId: 'pe-4', leg: 'sole', claimId: CLAIM_A, lane: 'genesis' },
      { peId: 'pe-5', leg: 'sole', claimId: CLAIM_A, lane: 'standard', genesisAnchorKey: ANCHOR_A },
      // Zero is the kernel's unset sentinel, rejected outright on chain.
      { peId: 'pe-6', leg: 'sole', claimId: `0x${'0'.repeat(64)}`, lane: 'standard' },
      { peId: 'pe-7', leg: 'sole', claimId: CLAIM_A, lane: 'genesis', genesisAnchorKey: `0x${'0'.repeat(64)}` },
    ];
    expect(kinds(verifyClaimIdentity(bad, ledgerOf())))
      .toEqual(Array(7).fill('invalid_claim'));
  });

  it('reports every violation in one pass, not just the first', () => {
    const verdict = verifyClaimIdentity(
      [
        { peId: 'pe-1', leg: 'sole', claimId: CLAIM_B, lane: 'standard' },
        { peId: 'pe-2', leg: 'sole', claimId: CLAIM_B, lane: 'standard' },
      ],
      ledgerOf(
        { peId: 'pe-1', leg: 'sole', claimId: CLAIM_A, lane: 'standard', settled: true },
        { peId: 'pe-2', leg: 'sole', claimId: hash(0xccc), lane: 'standard', settled: false },
      ),
    );
    expect(kinds(verdict))
      .toEqual(['pe_already_settled', 'claim_id_drift', 'claim_id_collision', 'claim_id_drift']);
  });
});

describe('verifyClaimIdentity — identity normalization', () => {
  it('catches drift when the PE id differs only by case or padding', () => {
    // The relay's envelope-id validator is case-insensitive, so these are one
    // PE. Missing that would bypass BOTH nets at once on the standard lane.
    const ledger = ledgerOf({
      peId: 'PE-Abc', leg: 'sole', claimId: CLAIM_A, lane: 'standard', settled: true,
    });
    expect(kinds(verifyClaimIdentity([{ peId: 'pe-abc', leg: 'sole', claimId: CLAIM_B, lane: 'standard' }], ledger)))
      .toEqual(['pe_already_settled', 'claim_id_drift']);
    expect(kinds(verifyClaimIdentity([{ peId: '  PE-ABC  ', leg: 'sole', claimId: CLAIM_B, lane: 'standard' }], ledger)))
      .toEqual(['pe_already_settled', 'claim_id_drift']);
  });

  it('catches a duplicated PE that differs only by case', () => {
    expect(
      kinds(verifyClaimIdentity(
        [
          { peId: 'PE-1', leg: 'sole', claimId: CLAIM_A, lane: 'standard' },
          { peId: 'pe-1', leg: 'sole', claimId: CLAIM_A, lane: 'standard' },
        ],
        ledgerOf(),
      )),
    ).toEqual(['duplicate_claim_in_proposal']);
  });

  it('indexes the ledger by each record\'s own PE id, not by the map key', () => {
    // A caller keying the map differently must not silently defeat every check.
    const oddlyKeyed = new Map<string, RecordedClaim>([
      ['row-42', { peId: 'pe-1', leg: 'sole', claimId: CLAIM_A, lane: 'standard', settled: true }],
    ]);
    expect(kinds(verifyClaimIdentity([{ peId: 'pe-1', leg: 'sole', claimId: CLAIM_B, lane: 'standard' }], oddlyKeyed)))
      .toEqual(['pe_already_settled', 'claim_id_drift']);
  });

  it('will not read an incomplete genesis record as evidence of no drift', () => {
    // Unknown = block: no anchor on file cannot witness that the proposed
    // anchor is unchanged.
    const noAnchor = ledgerOf({ peId: 'pe-g', leg: 'sole', claimId: CLAIM_A, lane: 'genesis', settled: false });
    expect(
      kinds(verifyClaimIdentity(
        [{ peId: 'pe-g', leg: 'sole', claimId: CLAIM_A, lane: 'genesis', genesisAnchorKey: ANCHOR_A }],
        noAnchor,
      )),
    ).toEqual(['genesis_anchor_drift']);
  });

  it('treats anchor keys case-insensitively', () => {
    const ledger = ledgerOf({
      peId: 'pe-g', leg: 'sole', claimId: CLAIM_A, lane: 'genesis', settled: false, genesisAnchorKey: ANCHOR_A,
    });
    expect(
      verifyClaimIdentity(
        [{
          peId: 'pe-g',
          leg: 'sole',
          claimId: CLAIM_A,
          lane: 'genesis',
          genesisAnchorKey: ANCHOR_A.toUpperCase().replace('0X', '0x'),
        }],
        ledger,
      ),
    ).toEqual({ kind: 'stable' });
  });
});

describe('allocateCursorRanges', () => {
  it('draws both lanes from one counter, never a per-lane sequence', () => {
    const result = allocateCursorRanges(1_000n, [
      { lane: 'standard', claimCount: 3 },
      { lane: 'genesis', claimCount: 2 },
      { lane: 'standard', claimCount: 4 },
    ]);

    expect(result).toEqual({
      kind: 'allocated',
      ranges: [
        { lane: 'standard', claimCount: 3, cursorStart: 1_000n, cursorEnd: 1_003n },
        // Genesis continues from where standard stopped — it does not restart.
        { lane: 'genesis', claimCount: 2, cursorStart: 1_003n, cursorEnd: 1_005n },
        { lane: 'standard', claimCount: 4, cursorStart: 1_005n, cursorEnd: 1_009n },
      ],
    });
  });

  it('allocates nothing for an empty sequence and rejects bad inputs', () => {
    expect(allocateCursorRanges(0n, [])).toEqual({ kind: 'allocated', ranges: [] });
    expect(allocateCursorRanges(-1n, [])).toEqual({ kind: 'rejected', reason: 'invalid_start_cursor' });
    expect(allocateCursorRanges(0n, [{ lane: 'standard', claimCount: 0 }]))
      .toEqual({ kind: 'rejected', reason: 'invalid_segment', index: 0 });
    expect(
      allocateCursorRanges(0n, [
        { lane: 'standard', claimCount: 1 },
        { lane: 'genesis', claimCount: 1.5 },
      ]),
    ).toEqual({ kind: 'rejected', reason: 'invalid_segment', index: 1 });
  });
});

describe('validateCursorChain', () => {
  const chain: AllocatedCursorRange[] = [
    { lane: 'standard', claimCount: 3, cursorStart: 10n, cursorEnd: 13n },
    { lane: 'genesis', claimCount: 2, cursorStart: 13n, cursorEnd: 15n },
  ];

  it('accepts one unbroken chain and an empty chain', () => {
    expect(validateCursorChain(10n, chain)).toEqual({ kind: 'valid' });
    expect(validateCursorChain(10n, [])).toEqual({ kind: 'valid' });
  });

  it('catches a fork — the two lanes allocated from separate counters', () => {
    // Genesis restarting at the standard lane's start is exactly what a
    // per-lane counter would produce; the kernel would revert
    // CursorDiscontinuity on whichever batch landed second.
    const forked: AllocatedCursorRange[] = [
      { lane: 'standard', claimCount: 3, cursorStart: 10n, cursorEnd: 13n },
      { lane: 'genesis', claimCount: 2, cursorStart: 10n, cursorEnd: 12n },
    ];
    expect(validateCursorChain(10n, forked))
      .toEqual({ kind: 'rejected', reason: 'cursor_not_contiguous', index: 1 });
  });

  it('catches a gap, an overlap, and a wrong start', () => {
    const gapped: AllocatedCursorRange[] = [
      chain[0],
      { lane: 'genesis', claimCount: 2, cursorStart: 14n, cursorEnd: 16n },
    ];
    expect(validateCursorChain(10n, gapped))
      .toEqual({ kind: 'rejected', reason: 'cursor_not_contiguous', index: 1 });

    const overlapping: AllocatedCursorRange[] = [
      chain[0],
      { lane: 'genesis', claimCount: 2, cursorStart: 12n, cursorEnd: 14n },
    ];
    expect(validateCursorChain(10n, overlapping))
      .toEqual({ kind: 'rejected', reason: 'cursor_not_contiguous', index: 1 });

    expect(validateCursorChain(9n, chain))
      .toEqual({ kind: 'rejected', reason: 'cursor_not_contiguous', index: 0 });
  });

  it('catches a range whose length does not equal its claim count', () => {
    // The kernel enforces cursorEnd - cursorStart == claimCount exactly.
    const mismatched: AllocatedCursorRange[] = [
      { lane: 'standard', claimCount: 4, cursorStart: 10n, cursorEnd: 13n },
    ];
    expect(validateCursorChain(10n, mismatched))
      .toEqual({ kind: 'rejected', reason: 'cursor_range_mismatch', index: 0 });
  });

  it('catches a non-advancing range and malformed entries', () => {
    expect(
      validateCursorChain(10n, [{ lane: 'standard', claimCount: 1, cursorStart: 10n, cursorEnd: 10n }]),
    ).toEqual({ kind: 'rejected', reason: 'cursor_not_monotonic', index: 0 });

    expect(
      validateCursorChain(10n, [{ lane: 'standard', claimCount: 0, cursorStart: 10n, cursorEnd: 11n }]),
    ).toEqual({ kind: 'rejected', reason: 'invalid_segment', index: 0 });

    expect(validateCursorChain(-1n, chain))
      .toEqual({ kind: 'rejected', reason: 'invalid_start_cursor', index: 0 });
  });
});
