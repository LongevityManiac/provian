/**
 * Unit tests for the settlement per-batch claim-ceiling override
 * (`resolveMaxClaimsPerBatch`). The safety property under test: an override can
 * only ever make batches SMALLER than the reviewed default, never larger, and any
 * bad input fails back to the default — batch grouping never touches a mint amount,
 * payee, or mint-once, so the only risk this guards is a batch that models over the
 * block gas limit, which a LARGER cap could cause and this bound forbids.
 */
import {
  MAX_CLAIMS_OVERRIDE_ENV,
  SETTLEMENT_MAX_CLAIMS_DEFAULT,
  resolveMaxClaimsPerBatch,
} from './operator-runtime';

const withEnv = (value: string | undefined): NodeJS.ProcessEnv =>
  value === undefined ? {} : { [MAX_CLAIMS_OVERRIDE_ENV]: value };

describe('resolveMaxClaimsPerBatch', () => {
  it('defaults to the plan value when unset', () => {
    expect(resolveMaxClaimsPerBatch({})).toBe(SETTLEMENT_MAX_CLAIMS_DEFAULT);
    expect(resolveMaxClaimsPerBatch(withEnv(''))).toBe(SETTLEMENT_MAX_CLAIMS_DEFAULT);
    expect(resolveMaxClaimsPerBatch(withEnv('   '))).toBe(SETTLEMENT_MAX_CLAIMS_DEFAULT);
  });

  it('honors a valid override strictly below the default (batches get SMALLER)', () => {
    expect(resolveMaxClaimsPerBatch(withEnv('2'))).toBe(2);
    expect(resolveMaxClaimsPerBatch(withEnv('1'))).toBe(1);
    expect(resolveMaxClaimsPerBatch(withEnv('500'))).toBe(500);
    expect(resolveMaxClaimsPerBatch(withEnv(String(SETTLEMENT_MAX_CLAIMS_DEFAULT))))
      .toBe(SETTLEMENT_MAX_CLAIMS_DEFAULT);
  });

  it('RED — an override ABOVE the default is refused, never applied (can only shrink)', () => {
    // The load-bearing safety property: a larger cap could push a batch over the block
    // gas limit. The override must clamp to the default, NOT pass 5000 through.
    expect(resolveMaxClaimsPerBatch(withEnv('1001'))).toBe(SETTLEMENT_MAX_CLAIMS_DEFAULT);
    expect(resolveMaxClaimsPerBatch(withEnv('5000'))).toBe(SETTLEMENT_MAX_CLAIMS_DEFAULT);
    expect(resolveMaxClaimsPerBatch(withEnv('999999999'))).toBe(SETTLEMENT_MAX_CLAIMS_DEFAULT);
    // And a positive override that IS honored proves the test is not vacuously passing
    // (5000 clamps to 1000 for the SAME reason 2 stays 2: the bound, not a no-op).
    expect(resolveMaxClaimsPerBatch(withEnv('2'))).not.toBe(SETTLEMENT_MAX_CLAIMS_DEFAULT);
  });

  it('RED — non-positive and unparseable inputs fall back to the default', () => {
    expect(resolveMaxClaimsPerBatch(withEnv('0'))).toBe(SETTLEMENT_MAX_CLAIMS_DEFAULT);
    expect(resolveMaxClaimsPerBatch(withEnv('-5'))).toBe(SETTLEMENT_MAX_CLAIMS_DEFAULT);
    expect(resolveMaxClaimsPerBatch(withEnv('abc'))).toBe(SETTLEMENT_MAX_CLAIMS_DEFAULT);
    expect(resolveMaxClaimsPerBatch(withEnv('2.7'))).toBe(2); // parseInt floors to 2 (valid)
    expect(resolveMaxClaimsPerBatch(withEnv('NaN'))).toBe(SETTLEMENT_MAX_CLAIMS_DEFAULT);
  });
});
