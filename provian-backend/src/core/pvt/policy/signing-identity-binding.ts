/**
 * The identity binding for an approval signature.
 *
 * Lives in `src/` rather than beside the script that uses it for one reason:
 * `jest.config.js` roots at `<rootDir>/src`, so a predicate in `scripts/` has no
 * test. This one is the only thing standing between the signing tool and a
 * "SIGNED and VERIFIED" artifact produced from a throwaway key, so it gets one.
 */

/**
 * The identity binding, as a pure total function so it has a test rather than a
 * one-shot manual run.
 *
 * WHY IT EXISTS AT ALL: verifying an SSHSIG against ITS OWN public key is
 * circular — it succeeds for any key, including a throwaway. Identity is this
 * comparison and nothing else, so this is the only thing standing between the
 * tool and a "SIGNED and VERIFIED" artifact from an ephemeral key.
 */
export type SigningIdentityVerdict =
  | 'bound_to_expected_key'
  | 'unbound_by_explicit_opt_in'
  | 'refused_no_expected_key'
  | 'refused_key_mismatch';

export interface SigningIdentityDecision {
  readonly verdict: SigningIdentityVerdict;
  readonly bound: boolean;
  readonly expected: string | null;
}

export function decideSigningIdentityBinding(input: {
  expectedFromFlag: string | null | undefined;
  expectedFromEnv: string | null | undefined;
  actualKeySha256: string;
  allowUnbound: boolean;
}): SigningIdentityDecision {
  const expected = input.expectedFromFlag ?? input.expectedFromEnv ?? null;
  if (expected === null) {
    // The opt-out is checked ONLY here: it can waive a MISSING expectation, and
    // it can never waive a MISMATCH. An explicit wrong key stays a refusal.
    return input.allowUnbound
      ? { verdict: 'unbound_by_explicit_opt_in', bound: false, expected: null }
      : { verdict: 'refused_no_expected_key', bound: false, expected: null };
  }
  if (expected !== input.actualKeySha256) {
    return { verdict: 'refused_key_mismatch', bound: false, expected };
  }
  return { verdict: 'bound_to_expected_key', bound: true, expected };
}
