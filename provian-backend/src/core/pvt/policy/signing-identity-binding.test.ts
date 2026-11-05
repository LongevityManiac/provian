/**
 * The signing script's IDENTITY BINDING.
 *
 * This is the only thing standing between the tool and a "SIGNED and VERIFIED"
 * artifact produced from a throwaway key: verifying an SSHSIG against its own
 * public key is circular and succeeds for ANY key, so the signature check
 * proves integrity and says nothing about who signed.
 *
 * It previously had no automated test — deleting both refusals left the suite
 * fully green — so the refusals are asserted here, each paired with the input
 * that admits, and the opt-out is asserted NOT to waive a mismatch.
 */

import {
  decideSigningIdentityBinding,
  type SigningIdentityVerdict,
} from './signing-identity-binding';

/** The digest the live relay verifies against. Public. */
const RELAY_KEY = 'sha256:200b11f0842bdf578eeb2ebb4859c9fcd3ba870159e53d6747ffaff893462974';
const OTHER_KEY = 'sha256:b37e52552c530ec1dc0f51f7bad052ca69c9914d282a69e8f1fe5c82dce49429';

function decide(over: Partial<Parameters<typeof decideSigningIdentityBinding>[0]> = {}) {
  return decideSigningIdentityBinding({
    expectedFromFlag: null,
    expectedFromEnv: undefined,
    actualKeySha256: RELAY_KEY,
    allowUnbound: false,
    ...over,
  });
}

describe('decideSigningIdentityBinding', () => {
  it('BINDS when the flag names the key actually in hand', () => {
    expect(decide({ expectedFromFlag: RELAY_KEY })).toEqual({
      verdict: 'bound_to_expected_key', bound: true, expected: RELAY_KEY,
    });
  });

  it('BINDS when the expectation comes from the environment instead', () => {
    expect(decide({ expectedFromEnv: RELAY_KEY }).bound).toBe(true);
  });

  it('the FLAG wins over the environment', () => {
    expect(decide({ expectedFromFlag: OTHER_KEY, expectedFromEnv: RELAY_KEY }).verdict)
      .toBe('refused_key_mismatch');
  });

  // ---- RED controls -------------------------------------------------------

  it('RED: no expectation at all is REFUSED — it cannot tell a real key from a throwaway', () => {
    const d = decide();
    expect(d.verdict).toBe('refused_no_expected_key');
    expect(d.bound).toBe(false);
  });

  it('RED: an empty environment value is not an expectation', () => {
    expect(decide({ expectedFromEnv: undefined }).verdict).toBe('refused_no_expected_key');
  });

  it('RED: a THROWAWAY key against the real relay digest is REFUSED', () => {
    const d = decide({ expectedFromFlag: RELAY_KEY, actualKeySha256: OTHER_KEY });
    expect(d.verdict).toBe('refused_key_mismatch');
    expect(d.bound).toBe(false);
    expect(d.expected).toBe(RELAY_KEY);
  });

  it('RED: --allow-unbound-key CANNOT waive a MISMATCH, only a missing expectation', () => {
    // The dangerous shape: an escape hatch that also swallows a wrong key.
    expect(decide({
      expectedFromFlag: RELAY_KEY, actualKeySha256: OTHER_KEY, allowUnbound: true,
    }).verdict).toBe('refused_key_mismatch');
  });

  it('--allow-unbound-key waives ONLY the missing expectation, and never reports bound', () => {
    const d = decide({ allowUnbound: true });
    expect(d.verdict).toBe('unbound_by_explicit_opt_in');
    expect(d.bound).toBe(false); // stamped into the artifact as `signing_identity_bound`
  });

  it('every verdict is reachable, and exactly one of the four means "bound"', () => {
    const seen: SigningIdentityVerdict[] = [
      decide({ expectedFromFlag: RELAY_KEY }).verdict,
      decide({ allowUnbound: true }).verdict,
      decide().verdict,
      decide({ expectedFromFlag: OTHER_KEY }).verdict,
    ];
    expect(new Set(seen).size).toBe(4);
    const bound = [
      decide({ expectedFromFlag: RELAY_KEY }),
      decide({ allowUnbound: true }),
      decide(),
      decide({ expectedFromFlag: OTHER_KEY }),
    ].filter((d) => d.bound);
    expect(bound).toHaveLength(1);
  });

  it('`bound` is true only for the one admitting verdict — no other path can set it', () => {
    for (const over of [
      {}, { allowUnbound: true }, { expectedFromFlag: OTHER_KEY },
      { expectedFromFlag: OTHER_KEY, allowUnbound: true },
      { expectedFromEnv: OTHER_KEY },
    ]) {
      expect(decide(over).bound).toBe(false);
    }
  });
});
