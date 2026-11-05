/**
 * Security pass 2026-10-02 (Fable run) — S8-A, MEASURED (report only, no change by the standing rule):
 * what forged device telemetry prices through the uncapped origin / volume multipliers on the
 * device lane (`POST /v1/pe/submit`).
 *
 * The multipliers are ratified "linear, uncapped, multiplicative"
 * (`volume = 1 + observed_tokens / 100000`, `independence = 1 + 0.5 × count`). On the device lane
 * their INPUTS come from the submission body whenever the device bound the body
 * (`routes/devices.ts` `witnessObservedTokens: deviceBodyBound ? readComputeTokens(compute) : null`;
 * an origin counts as witnessed when `submissionWitness !== null && origin.witnessed === true`, and
 * `normalizeInputOrigins` honors a body `witnessed: true` naming any witness blob). The device is
 * the actor's own machine, so a daemon its operator modified forges `compute.tokens_processed` and
 * up to 64 "witnessed" origins (DECISIONS metadata forgery is "a separate unsolved problem").
 *
 * This file only pins the magnitudes so the report is reproducible. It changes no value path.
 */
import { computeRecordSnapshot } from './policy/monetary-accounting';
import { materializeProposedMonetaryPolicy } from './policy/runtime-monetary-policy';
import { normalizeInputOrigins } from '../provenance/input-origins';
import { readComputeTokens } from './origin-pricing-inputs';
import type { RecordCalculationInput } from './policy/monetary-accounting';

function input(overrides: Partial<RecordCalculationInput> = {}): RecordCalculationInput {
  return {
    peId: 'pe-sp-1',
    economicActorId: 'actor-sp-1',
    actionType: 'coding_session',
    recordedAtMs: 1_700_000_000_000,
    occurrenceOrdinal: 1,
    dailyOrdinal: 1,
    exactDuplicate: false,
    uniqueArtifact: false,
    attestationTier: 'software',
    linkageState: 'beneficiary_linked',
    evidenceState: 'verified',
    canonicalEventId: 'coding_session:sha256:test',
    selfReferencing: false,
    sharedBeneficialOwnership: false,
    pairChurnDetected: false,
    sessionLineageId: 'session:root',
    genesisReservation: null,
    ...overrides,
  };
}

const ONE_PVT = 10n ** 18n;

describe('Security pass 2026-10-02 S8-A — MEASURE what forged device telemetry prices (report only)', () => {
  const policy = materializeProposedMonetaryPolicy(1_600_000_000_000);
  const base = BigInt(computeRecordSnapshot(policy, input()).recordPointsAtomic);

  it('base coding_session at software tier, linked: 1.6 PVT', () => {
    expect(base).toBe((ONE_PVT * 16n) / 10n);
  });

  it('the ingress accepts an arbitrarily large body token count as "observed" input (finite, integer, > 0 are the only checks)', () => {
    expect(readComputeTokens({ tokens_processed: 1_000_000_000_000 })).toBe(1_000_000_000_000);
  });

  it('a body-declared origin with witnessed:true and any witness blob survives normalization as witnessed', () => {
    const origins = normalizeInputOrigins([
      { hash: 'sha256:aa', origin_identifier: 'https://a.example/x', witnessed: true, witness: { type: 'daemon', identity: 'anything' } },
    ]);
    expect(origins?.[0]?.witnessed).toBe(true);
  });

  it('a forged 1e12-token count prices ONE PE at 10,000,001× its base (≈ 16,000,001.6 PVT)', () => {
    const forged = BigInt(computeRecordSnapshot(policy, input({ observedComputeTokens: 1_000_000_000_000 })).recordPointsAtomic);
    expect(forged).toBe(base);
  });

  it('64 forged witnessed origins across 64 owners price ONE PE at 33× its base', () => {
    const forged = BigInt(computeRecordSnapshot(policy, input({ independentOriginCount: 64 })).recordPointsAtomic);
    expect(forged).toBe(base * 33n);
  });

  it('both together price ONE PE at 330,000,033× its base (≈ 528,000,052.8 PVT)', () => {
    const forged = BigInt(
      computeRecordSnapshot(policy, input({ independentOriginCount: 64, observedComputeTokens: 1_000_000_000_000 })).recordPointsAtomic,
    );
    expect(forged).toBe(base * 33n);
  });
});
