/**
 * activation P3 — the cut-line fence at the eligibility boundary.
 *
 * PVT9 is a fresh zero-supply kernel with no historical-PE migration, so a PE
 * recorded at or before the cut line is legacy-era and must be fenced out of PVT9
 * issuance. `evaluateEligibility` enforces this so no settlement call site can
 * forget it.
 *
 * The 16 PEs below are the PRODUCTION `mint_status='eligible'` PEs, enumerated
 * live from Firestore on 2026-07-25 — all recorded on or before 2026-07-08, all
 * pre-cut-line. This test asserts the fence excludes every one (enumerated by id).
 *
 * RED control / mutation kill (recorded in): removing the fence, or changing
 * `<=` to `<`, turns these tests RED (the boundary + the 16 + the fail-closed cases).
 */
import { deriveClaimId, type SealedEnvelopeIdentity } from './claim-id';
import {
  evaluateEligibility,
  PVT9_ELIGIBILITY_CUT_LINE_MS,
  type EligibilityCandidate,
  type WorkEvidence,
} from './eligibility';

const ARTIFACT: WorkEvidence = { workProductHash: 'a'.repeat(64) };

/** The 16 production pre-cut-line `mint_status='eligible'` PEs (id + real timestamp). */
const PRE_CUT_LINE_PES: ReadonlyArray<{ readonly id: string; readonly timestamp: number }> = [
  { id: 'pe_f7314c25-b393-43ad-8f00-c7820f5a5f9b', timestamp: 1_777_896_053_828 },
  { id: '2265caf4-0006-4133-8c8b-5cc5fae49976', timestamp: 1_782_249_897_857 },
  { id: 'pe_38d3816b-a102-4e82-b277-7195c348b64c', timestamp: 1_782_261_762_275 },
  { id: 'pe_3a89dd25-8d9d-4432-9cf7-c80a15372c6f', timestamp: 1_782_657_004_217 },
  { id: 'pe_566778bf-0013-4598-81c9-a6f31cd761ea', timestamp: 1_783_464_606_295 },
  { id: 'pe_2bf85e67-77b7-4a6b-a349-16d9f79b1175', timestamp: 1_783_464_609_562 },
  { id: 'pe_b0499718-15f5-41d1-988e-7d53b38b73b7', timestamp: 1_783_465_989_886 },
  { id: 'pe_ab14f286-c0e8-4723-b219-7be885beff5c', timestamp: 1_783_465_999_964 },
  { id: 'pe_5173686e-14b4-4d56-92a9-85ba09ac8247', timestamp: 1_783_479_272_274 },
  { id: 'pe_e2b6e543-e4cc-4087-8111-8ecdab059eb7', timestamp: 1_783_479_272_409 },
  { id: 'pe_ba420445-7d03-4d98-ae5b-9272f76170f3', timestamp: 1_783_479_272_612 },
  { id: 'pe_2f0ddfe6-45ad-444f-954b-2eb45b76c24e', timestamp: 1_783_479_470_672 },
  { id: 'pe_cca1b3f9-8849-40b6-864a-0e1bf63c0b64', timestamp: 1_783_479_543_381 },
  { id: 'pe_fe6eea44-6f9c-4bd2-b2d3-30829ced6089', timestamp: 1_783_479_543_719 },
  { id: 'pe_f4ac1905-d897-4fd7-91bb-840cb1625e84', timestamp: 1_783_484_114_326 },
  { id: 'pe_7ade7381-26b9-47fc-af55-541e447b3292', timestamp: 1_783_485_339_588 },
];

/** An OTHERWISE fully-eligible candidate at `timestamp`, so pre_cut_line is isolated. */
function candidateAt(id: string, timestamp: number): EligibilityCandidate {
  const pe: SealedEnvelopeIdentity = {
    id,
    prev_hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    timestamp,
    action_type: 'work_product',
    user_id: 'user_x',
  };
  return {
    pe,
    attestationTier: 'software',
    chainVerified: true,
    submissionProvenance: 'earner_signed',
    workEvidence: ARTIFACT,
    relayMintStatus: 'eligible',
  };
}

function reasonsOf(c: EligibilityCandidate): readonly string[] {
  const verdict = evaluateEligibility(c);
  return verdict.kind === 'ineligible' ? verdict.reasons : [];
}

describe('activation P3 · cut-line fence at the eligibility boundary', () => {
  test('the fence constant is the cutover reconciliation reconciliation cut line', () => {
    expect(PVT9_ELIGIBILITY_CUT_LINE_MS).toBe(1_784_938_132_043);
  });

  test('an OTHERWISE fully-eligible candidate at these fixtures is genuinely eligible when post-cut-line (control: not vacuously ineligible)', () => {
    // Proves candidateAt() builds a real ELIGIBLE candidate, so a pre_cut_line
    // rejection below is the FENCE talking, not an unrelated defect in the fixture.
    const verdict = evaluateEligibility(candidateAt('pe_ok', PVT9_ELIGIBILITY_CUT_LINE_MS + 1_000_000));
    expect(verdict.kind).toBe('eligible');
    // and the claim id is derivable (the fixture is structurally valid)
    expect(deriveClaimId(candidateAt('pe_ok', PVT9_ELIGIBILITY_CUT_LINE_MS + 1).pe).kind).toBe('derived');
  });

  test('every one of the 16 production pre-cut-line eligible PEs is fenced out (enumerated by id)', () => {
    expect(PRE_CUT_LINE_PES).toHaveLength(16); // exact, non-empty population
    for (const { id, timestamp } of PRE_CUT_LINE_PES) {
      expect(timestamp).toBeLessThanOrEqual(PVT9_ELIGIBILITY_CUT_LINE_MS); // genuinely pre-cut-line
      expect(reasonsOf(candidateAt(id, timestamp))).toContain('pre_cut_line');
    }
  });

  test('a pre-cut-line PE that is OTHERWISE fully eligible is rejected for pre_cut_line ALONE', () => {
    expect(reasonsOf(candidateAt('pe_pre', PVT9_ELIGIBILITY_CUT_LINE_MS - 1))).toEqual(['pre_cut_line']);
  });

  test('the boundary is inclusive: exactly at the cut line is fenced, one ms after is not', () => {
    expect(reasonsOf(candidateAt('pe_at', PVT9_ELIGIBILITY_CUT_LINE_MS))).toContain('pre_cut_line');
    expect(reasonsOf(candidateAt('pe_after', PVT9_ELIGIBILITY_CUT_LINE_MS + 1))).not.toContain('pre_cut_line');
  });

  test('fail-closed: a missing timestamp is fenced (Unknown = Block)', () => {
    expect(reasonsOf(candidateAt('pe_no_ts', undefined as unknown as number))).toContain('pre_cut_line');
  });

  test('fail-closed: a non-finite timestamp (NaN) is fenced', () => {
    expect(reasonsOf(candidateAt('pe_nan', Number.NaN))).toContain('pre_cut_line');
  });
});
