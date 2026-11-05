/**
 * every Commons speech row is priced at the ONE evidence-class base the relay admits
 * unnamed types at (`relay_verified`, 10,000 bps), read from the same table the accrual reads —
 * never a social-category 5,000 the plain `entry()` would derive, never a literal of the test's
 * own. Bound to the single sources (`COMMONS_SPEECH_ACTION_TYPES`, `PROPOSED_EVIDENCE_CLASS_BASES_BPS`)
 * so a drift in either side goes RED here.
 */
import { describe, it, expect } from '@jest/globals';
import { PROPOSED_ACTION_POLICY_ENTRIES, COMMONS_SPEECH_ACTION_TYPES } from './proposed-action-policy';
import { PROPOSED_EVIDENCE_CLASS_BASES_BPS } from './evidence-class';

const rowFor = (t: string) => PROPOSED_ACTION_POLICY_ENTRIES.find((e) => e.action_type === t);

describe(' Commons speech rows price at the relay_verified class base', () => {
  it('every speech row is eligible / verified_witness_class / optional lineage at the class base (population > 0)', () => {
    expect(COMMONS_SPEECH_ACTION_TYPES.length).toBeGreaterThan(0);
    let evaluated = 0;
    for (const t of COMMONS_SPEECH_ACTION_TYPES) {
      const row = rowFor(t);
      expect(row).toBeDefined();
      expect(row).toMatchObject({
        mint_disposition: 'eligible',
        evidence_requirement: 'verified_witness_class',
        session_lineage_policy: 'optional',
        base_action_weight_bps: PROPOSED_EVIDENCE_CLASS_BASES_BPS.relay_verified,
      });
      evaluated += 1;
    }
    expect(evaluated).toBe(COMMONS_SPEECH_ACTION_TYPES.length);
  });

  it('RED control: a row priced at the social-category default would be caught', () => {
    const row = rowFor(COMMONS_SPEECH_ACTION_TYPES[0]);
    expect(row).toBeDefined();
    const mutated = { ...row!, base_action_weight_bps: 5_000 };
    expect(mutated.base_action_weight_bps).not.toBe(PROPOSED_EVIDENCE_CLASS_BASES_BPS.relay_verified);
  });
});
