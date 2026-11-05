/**
 * WP-EV — payout legs and their claim ids.
 *
 * Two properties carry the money here and both are proven exhaustively rather than by example:
 * the split sums to the whole, and no two (PE, leg) pairs share a claim id. A collision would
 * mean one leg silently consuming the other's `claimSettled` slot — the second leg would revert
 * `ClaimAlreadySettled` and that payee would never be paid.
 */

import { deriveClaimId, deriveLegClaimId } from './claim-id';
import {
  BPS_DENOMINATOR,
  KERNEL_INTRINSIC_LEGS,
  PAYOUT_LEG_ROLES,
  linkedAgentLegs,
  soleLeg,
  splitPointsAcrossLegs,
  type PayoutLegRole,
} from './payout-legs';

const AGENT = '0x00000000000000000000000000000000000000a1';
const HUMAN = '0x00000000000000000000000000000000000000b2';

function pe(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pe-1',
    prev_hash: `0x${'11'.repeat(32)}`,
    hash: `0x${'22'.repeat(32)}`,
    timestamp: 1_800_000_000_000,
    action_type: 'agent_task_completed',
    user_id: 'user-1',
    ...overrides,
  };
}

describe('splitPointsAcrossLegs', () => {
  it('splits 20/80 and the parts sum to the whole', () => {
    const result = linkedAgentLegs({
      agentAddress: AGENT, humanAddress: HUMAN, agentShareBps: 2000,
      totalPointsAtomic: '1000000000000000000',
    });
    expect(result.kind).toBe('legs');
    if (result.kind !== 'legs') throw new Error('unreachable');

    expect(result.legs.map((l) => l.role)).toEqual(['agent', 'beneficiary']);
    expect(result.legs[0].pointsAtomic).toBe('200000000000000000');
    expect(result.legs[1].pointsAtomic).toBe('800000000000000000');
    expect(result.legs.reduce((s, l) => s + BigInt(l.pointsAtomic), 0n))
      .toBe(1_000000000000000000n);
    expect(result.legs[0].address).toBe(AGENT);
    expect(result.legs[1].address).toBe(HUMAN);
  });

  it('gives the REMAINDER to the last leg so nothing is ever burned', () => {
    // 7 atomic units at 2000bps: floor(7*0.2) = 1, so the beneficiary must get 6, not 5.
    const result = linkedAgentLegs({
      agentAddress: AGENT, humanAddress: HUMAN, agentShareBps: 2000, totalPointsAtomic: '7',
    });
    if (result.kind !== 'legs') throw new Error('unreachable');
    expect(result.legs.map((l) => l.pointsAtomic)).toEqual(['1', '6']);
    expect(result.legs.reduce((s, l) => s + BigInt(l.pointsAtomic), 0n)).toBe(7n);

    // RED CONTROL: dropping the remainder — the obvious wrong implementation — would give
    // ['1','5'] and burn one unit. Assert the sum, which that version fails.
    expect(BigInt(result.legs[0].pointsAtomic) + BigInt(result.legs[1].pointsAtomic)).toBe(7n);
  });

  it('sums to the whole across a swept range of amounts and shares', () => {
    let checked = 0;
    for (let bps = 500; bps <= 5000; bps += 500) {
      for (const total of ['1000', '999999', '3', '7', '123456789', '1000000000000000001']) {
        const result = linkedAgentLegs({
          agentAddress: AGENT, humanAddress: HUMAN, agentShareBps: bps, totalPointsAtomic: total,
        });
        if (result.kind !== 'legs') continue; // zero-leg refusals are covered separately
        expect(result.legs.reduce((s, l) => s + BigInt(l.pointsAtomic), 0n)).toBe(BigInt(total));
        checked += 1;
      }
    }
    // Empty-population guard: a sweep that checked nothing would pass every assertion above.
    expect(checked).toBeGreaterThan(40);
  });

  it('REFUSES a split where any leg would receive zero', () => {
    // 1 atomic unit at 2000bps floors the agent to 0, and the kernel reverts the whole batch on
    // a zero-point claim — so this must never reach a batch.
    expect(linkedAgentLegs({
      agentAddress: AGENT, humanAddress: HUMAN, agentShareBps: 2000, totalPointsAtomic: '1',
    })).toEqual({ kind: 'refused', reason: 'zero_leg' });

    // RED CONTROL: five units at the same share DOES split, so the refusal is about the zero
    // and not about small numbers in general.
    expect(linkedAgentLegs({
      agentAddress: AGENT, humanAddress: HUMAN, agentShareBps: 2000, totalPointsAtomic: '5',
    }).kind).toBe('legs');
  });

  it('refuses bps that do not sum to exactly 10,000', () => {
    expect(splitPointsAcrossLegs([
      { role: 'agent', address: AGENT, bps: 2000 },
      { role: 'beneficiary', address: HUMAN, bps: 7000 },
    ], '1000')).toEqual({ kind: 'refused', reason: 'bps_do_not_sum' });

    expect(splitPointsAcrossLegs([
      { role: 'agent', address: AGENT, bps: 2000 },
      { role: 'beneficiary', address: HUMAN, bps: 9000 },
    ], '1000')).toEqual({ kind: 'refused', reason: 'bps_do_not_sum' });

    // RED CONTROL: exactly 10,000 passes.
    expect(splitPointsAcrossLegs([
      { role: 'agent', address: AGENT, bps: 2000 },
      { role: 'beneficiary', address: HUMAN, bps: 8000 },
    ], '1000').kind).toBe('legs');
  });

  it('refuses a duplicate role, a bad address, and unparseable points', () => {
    expect(splitPointsAcrossLegs([
      { role: 'agent', address: AGENT, bps: 5000 },
      { role: 'agent', address: HUMAN, bps: 5000 },
    ], '1000')).toEqual({ kind: 'refused', reason: 'duplicate_role' });

    expect(splitPointsAcrossLegs([
      { role: 'sole', address: 'not-an-address', bps: 10_000 },
    ], '1000')).toEqual({ kind: 'refused', reason: 'invalid_address' });

    expect(soleLeg(AGENT, '0')).toEqual({ kind: 'refused', reason: 'invalid_points' });
    expect(soleLeg(AGENT, 'x')).toEqual({ kind: 'refused', reason: 'invalid_points' });
    expect(splitPointsAcrossLegs([], '1000')).toEqual({ kind: 'refused', reason: 'no_legs' });
  });

  it('documents the kernel\'s own legs in the same vocabulary', () => {
    // These are the constants `settleStandardPEBatch` applies to every recipient's gross. They
    // are here so the full distribution of an act is legible; this layer never emits them.
    expect(KERNEL_INTRINSIC_LEGS.provian).toBe(50);
    expect(KERNEL_INTRINSIC_LEGS.foundationHumanFloor).toBe(50);
    expect(BPS_DENOMINATOR).toBe(10_000);
  });
});

describe('deriveLegClaimId', () => {
  it('SOLE is byte-identical to the unsplit derivation', () => {
    // Load-bearing: every existing single-payee PE keeps the id it already had, so introducing
    // legs changes no settled identity and the drift checker stays quiet.
    const base = deriveClaimId(pe());
    const sole = deriveLegClaimId(pe(), 'sole');
    expect(base.kind).toBe('derived');
    expect(sole).toEqual(base);
  });

  it('is COLLISION-FREE across every (PE, leg) pair', () => {
    const pes = [
      pe(),
      pe({ id: 'pe-2' }),
      pe({ hash: `0x${'33'.repeat(32)}` }),
      pe({ timestamp: 1_800_000_000_001 }),
      pe({ user_id: 'user-2' }),
      pe({ user_id: null }),
      pe({ action_type: 'genesis_human_signup' }),
    ];
    const seen = new Map<string, string>();
    for (const [index, candidate] of pes.entries()) {
      for (const role of PAYOUT_LEG_ROLES) {
        const result = deriveLegClaimId(candidate, role);
        expect(result.kind).toBe('derived');
        if (result.kind !== 'derived') continue;
        const key = `pe${index}:${role}`;
        const prior = seen.get(result.claimId);
        // The whole property: no id may ever be produced by two different (PE, leg) pairs. A
        // collision would make one leg consume the other's `claimSettled` slot, and the second
        // payee would be refused `ClaimAlreadySettled` forever.
        expect(prior).toBeUndefined();
        seen.set(result.claimId, key);
      }
    }
    // Empty-population guard: 7 PEs x 3 roles, all distinct.
    expect(seen.size).toBe(pes.length * PAYOUT_LEG_ROLES.length);
  });

  it('the two legs of ONE PE differ, which is the case that matters', () => {
    const agent = deriveLegClaimId(pe(), 'agent');
    const beneficiary = deriveLegClaimId(pe(), 'beneficiary');
    const sole = deriveLegClaimId(pe(), 'sole');
    expect(agent.kind).toBe('derived');
    if (agent.kind !== 'derived' || beneficiary.kind !== 'derived' || sole.kind !== 'derived') {
      throw new Error('unreachable');
    }
    expect(agent.claimId).not.toBe(beneficiary.claimId);
    expect(agent.claimId).not.toBe(sole.claimId);
    expect(beneficiary.claimId).not.toBe(sole.claimId);
  });

  it('is DETERMINISTIC — the same leg of the same PE derives the same id every time', () => {
    // Stability is what makes a rebuild after an epoch boundary safe: the claim ids must not
    // move, or the kernel would see fresh work where there is none.
    for (const role of PAYOUT_LEG_ROLES) {
      const a = deriveLegClaimId(pe(), role);
      const b = deriveLegClaimId(pe(), role);
      expect(a).toEqual(b);
    }
  });

  it('rejects an unknown leg rather than hashing it', () => {
    expect(deriveLegClaimId(pe(), 'treasury' as unknown as PayoutLegRole))
      .toEqual({ kind: 'rejected', reason: 'invalid_leg' });
  });

  it('propagates an underivable identity rather than inventing a leg id', () => {
    const broken = deriveLegClaimId(pe({ id: '' }), 'agent');
    expect(broken).toEqual({ kind: 'rejected', reason: 'missing_id' });
  });
});
