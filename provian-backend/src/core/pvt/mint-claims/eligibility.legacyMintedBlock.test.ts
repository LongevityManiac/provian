/**
 * the double-mint exercise, made REPRODUCIBLE.
 *
 * exercised the double-mint block against real data once:
 * all 31 production `mint_status='minted'` PEs projected verbatim and refused.
 * recorded the soft spot: that 31/31 figure was a one-off live
 * measurement being cited as Leg B discharge evidence. This suite pins the
 * SAME population — the 31 legacy-minted PEs, captured read-only from
 * production `pe_history` (`where mint_status == 'minted'`) on 2026-07-28,
 * enumerated by id with their real timestamps — and re-proves the block on
 * every CI run.
 *
 * Two independent fences stop each of these PEs, and both are asserted:
 * - `already_minted` (the double-mint block: `relayMintStatus` is 'minted'
 * verbatim), proven the SOLE discriminator by evaluating the identical
 * candidate at a post-cut-line timestamp;
 * - `pre_cut_line` every one of the 31 predates the cut line.
 *
 * These 31 can never un-mint (legacy contracts are retired, sealed history),
 * so this population is stable. A PVT9-era settlement writing a NEW minted
 * status would be a different era, not drift in this set.
 */
import { deriveClaimId, type SealedEnvelopeIdentity } from './claim-id';
import {
  evaluateEligibility,
  PVT9_ELIGIBILITY_CUT_LINE_MS,
  type EligibilityCandidate,
  type WorkEvidence,
} from './eligibility';

const ARTIFACT: WorkEvidence = { workProductHash: 'a'.repeat(64) };

/**
 * The 31 production `mint_status='minted'` PEs (id + real timestamp), captured
 * live 2026-07-28. The count and ids match 's exercise exactly.
 */
const LEGACY_MINTED_PES: ReadonlyArray<{ readonly id: string; readonly timestamp: number }> = [
  { id: '62f69ea4-ad83-48e9-b2f1-b372f0549123', timestamp: 1_776_209_777_277 },
  { id: '81f9dd6f-0f24-4989-944b-4495e9a1450f', timestamp: 1_776_209_791_665 },
  { id: 'pe_02a7652e-f1f2-496d-ae27-65cffb9369d2', timestamp: 1_776_614_481_226 },
  { id: 'pe_037e8923-794d-4f2d-b15c-cf97fd3fd18c', timestamp: 1_776_201_016_206 },
  { id: 'pe_03b76fca-bb43-4c41-9f34-6242a0c362d7', timestamp: 1_776_212_255_388 },
  { id: 'pe_08cce535-3214-46b7-90c9-2d76e7e0bd44', timestamp: 1_776_193_154_228 },
  { id: 'pe_21820e14-b5e5-4c58-bd58-f30b0bd2c861', timestamp: 1_776_227_522_780 },
  { id: 'pe_243ed57d-d5a9-4339-8183-a0e225b6b40b', timestamp: 1_776_200_493_988 },
  { id: 'pe_257c1994-eb6e-4772-93b7-6570afccdb0e', timestamp: 1_776_230_177_247 },
  { id: 'pe_40c8f3d5-2588-42d8-a5be-06b1227bb396', timestamp: 1_777_137_968_401 },
  { id: 'pe_425e6b97-047c-4a27-99ea-c2701bce00f7', timestamp: 1_776_792_501_006 },
  { id: 'pe_43c7e4af-61f0-4b17-91b3-87f1bdb3131f', timestamp: 1_776_203_839_357 },
  { id: 'pe_4dd7da76-cfa3-4ec8-8d4b-7b0af396fd32', timestamp: 1_776_231_541_432 },
  { id: 'pe_4f8b20fe-e9b4-4151-a104-9063d7ba92d0', timestamp: 1_776_191_838_806 },
  { id: 'pe_60563315-8201-4541-b063-a034531cbeee', timestamp: 1_776_219_919_719 },
  { id: 'pe_612d3b29-877b-4f7c-b63a-48e57a779e49', timestamp: 1_776_212_928_767 },
  { id: 'pe_74b2da11-7245-4e85-8573-ce5e3a8d96d7', timestamp: 1_776_996_760_841 },
  { id: 'pe_92230c9e-b542-47ce-b1f5-833404240325', timestamp: 1_777_223_463_014 },
  { id: 'pe_92d670bf-25f0-4d46-bc8e-e146612a4e80', timestamp: 1_776_201_016_185 },
  { id: 'pe_a9997284-1e65-4ca9-b658-2cb3ed31fb25', timestamp: 1_781_105_370_308 },
  { id: 'pe_b0302b4d-01ff-428e-ac74-317e446306c4', timestamp: 1_776_219_927_404 },
  { id: 'pe_b74b3fd0-75e8-4f37-bcb5-c41c4585b1c2', timestamp: 1_776_204_116_873 },
  { id: 'pe_c0eb0489-a900-46a4-901f-f5a860a233b9', timestamp: 1_776_304_933_094 },
  { id: 'pe_c53f76ee-0476-43f3-9af4-63f54f1ebfe3', timestamp: 1_776_200_984_347 },
  { id: 'pe_ce22dfa4-5b50-42ec-8d4c-365a2aa6909f', timestamp: 1_776_198_290_305 },
  { id: 'pe_d4bfe920-3cf3-42a2-9b78-1a550a06fe8b', timestamp: 1_776_997_308_576 },
  { id: 'pe_d98d6e55-e5ee-4cb3-ab5c-e56edc96c2b8', timestamp: 1_776_795_491_209 },
  { id: 'pe_dafaa98f-735c-4f01-852b-6eafc79e53a3', timestamp: 1_776_228_483_009 },
  { id: 'pe_ddfe9fad-047b-4cdf-9cd7-1c8e0057fa0e', timestamp: 1_776_197_596_766 },
  { id: 'pe_e245e4d4-fc16-46a2-aec2-0904da4123d0', timestamp: 1_776_203_360_411 },
  { id: 'pe_fa74c413-5694-4e53-9332-ba787b3c840e', timestamp: 1_776_201_205_236 },
];

/** An OTHERWISE fully-eligible candidate, with only status + timestamp varied. */
function candidate(
  id: string,
  timestamp: number,
  relayMintStatus: string,
): EligibilityCandidate {
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
    relayMintStatus,
  };
}

const POST_CUT_LINE = PVT9_ELIGIBILITY_CUT_LINE_MS + 1_000_000;

function reasonsOf(c: EligibilityCandidate): readonly string[] {
  const verdict = evaluateEligibility(c);
  return verdict.kind === 'ineligible' ? verdict.reasons : [];
}

describe(' · the 31 legacy-minted PEs are blocked, reproducibly (was: one-off)', () => {
  test('the population is the real one: 31 PEs, every timestamp pre-cut-line, ids unique', () => {
    expect(LEGACY_MINTED_PES.length).toBe(31);
    expect(new Set(LEGACY_MINTED_PES.map((p) => p.id)).size).toBe(31);
    for (const pe of LEGACY_MINTED_PES) {
      expect(pe.timestamp).toBeLessThanOrEqual(PVT9_ELIGIBILITY_CUT_LINE_MS);
    }
  });

  test('31/31 refused at their REAL timestamps with BOTH fences firing', () => {
    let blocked = 0;
    for (const pe of LEGACY_MINTED_PES) {
      const reasons = reasonsOf(candidate(pe.id, pe.timestamp, 'minted'));
      expect(reasons).toContain('already_minted');
      expect(reasons).toContain('pre_cut_line');
      blocked += 1;
    }
    // The claim is a count, so the count is asserted — never inferred from a
    // loop that might have iterated zero times (the empty population).
    expect(blocked).toBe(31);
  });

  test('the double-mint block is the SOLE discriminator: identical candidates post-cut-line differ only by status', () => {
    for (const pe of LEGACY_MINTED_PES) {
      // Post-cut-line + minted: already_minted fires ALONE among status fences.
      const minted = evaluateEligibility(candidate(pe.id, POST_CUT_LINE, 'minted'));
      expect(minted.kind).toBe('ineligible');
      if (minted.kind === 'ineligible') {
        expect(minted.reasons).toContain('already_minted');
        expect(minted.reasons).not.toContain('pre_cut_line');
      }
      // POSITIVE CONTROL — the same shape with status 'eligible' is admitted,
      // so the refusal above is the block talking, not a broken fixture.
      const eligible = evaluateEligibility(candidate(pe.id, POST_CUT_LINE, 'eligible'));
      expect(eligible.kind).toBe('eligible');
    }
  });

  test('a blocked candidate still derives a stable claim id (the block is policy, not identity failure)', () => {
    const pe = LEGACY_MINTED_PES[0];
    const identity: SealedEnvelopeIdentity = {
      id: pe.id,
      prev_hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      timestamp: pe.timestamp,
      action_type: 'work_product',
      user_id: 'user_x',
    };
    const derived = deriveClaimId(identity);
    expect(derived.kind).toBe('derived');
  });
});
