/**
 * CONTROL FOR THE WIRED GENESIS BREAK-GLASS.
 *
 * `GENESIS_CAMPAIGN_FORCE_OFF` was cited in CLAUDE.md, STATUS.md, the admin readout and this
 * module's own docstring as the Genesis kill switch, and it gated nothing that could originate a
 * grant: its only refusal lived in `reserveGenesisIssuance`, a function with ZERO production
 * callers. Production ran with it set to `'true'` and the three armed fixed-grant legs never
 * read it.
 *
 * The claim under test is therefore not "the predicate parses the variable" it always did —
 * but "the ORIGINATION path refuses when it is engaged". That is
 * `shouldPersistGenesisQualification`, the one predicate every Genesis leg passes through.
 *
 * WHERE THE BINDING EVIDENCE ACTUALLY LIVES — corrected by institution deployment.
 *
 * This docstring used to claim a historical negative control "Registered in
 * `scripts/historical-negative-control.mjs`". That registration DID NOT EXIST — the
 * manifest there carries two unrelated controls — and, more importantly, it could not
 * honestly be added. Splicing the pre- `shouldPersistGenesisQualification`
 * (4877d16d, which has no force-off check at all) and running this file was measured
 * during institution deployment and reports:
 *
 * NOT A TEST refuses when engaged 4877d16d:GREEN
 * NOT A TEST is read PER CALL, not captured at module load 4877d16d:GREEN
 * 0 survive · 2 refuted
 *
 * The reason is stated openly in the pair below: the activation this file passes is not
 * a valid one, so BOTH branches refuse and neither branch distinguishes the versions.
 * Registering that entry would have added a control the tool itself classifies as
 * refuted — precisely the "guard that cannot fail" this codebase exists to reject.
 *
 * The genuinely discriminating control is
 * `genesis-activation-rail-open.test.ts` ("M10 · GENESIS_CAMPAIGN_FORCE_OFF now gates
 * the persist decision"), where nothing is faked, the flag-absent case really ADMITS
 * (`expect(withoutFlag).toBe(true)`), and the SAME call flips to refused on the
 * environment variable alone — across every leg derived from the production policy,
 * plus a mangled-value fail-SAFE battery. That file is the evidence for the
 * break-glass; this file covers the predicate's parsing and its single-source property.
 */

import { GENESIS_FORCE_OFF_ENV, isGenesisForcedOff } from './genesis-force-off';
import { shouldPersistGenesisQualification } from './genesis-award-state-machine';

describe('genesis deploy-level break-glass', () => {
  const OLD = process.env[GENESIS_FORCE_OFF_ENV];
  afterEach(() => {
    if (OLD === undefined) delete process.env[GENESIS_FORCE_OFF_ENV];
    else process.env[GENESIS_FORCE_OFF_ENV] = OLD;
  });

  describe('the predicate', () => {
    it.each(['true', '1'])('engages on %p', (v) => {
      expect(isGenesisForcedOff({ [GENESIS_FORCE_OFF_ENV]: v })).toBe(true);
    });

    // FAIL SAFE, not fail closed: this is a kill switch, not an arming key. A deploy that loses
    // the variable must not silently stop a live campaign.
    it.each([undefined, '', 'TRUE', 'yes', 'false', '0', ' true '])(
      'does NOT engage on %p — an absent or mangled kill switch leaves Genesis running',
      (v) => {
        expect(isGenesisForcedOff({ [GENESIS_FORCE_OFF_ENV]: v })).toBe(false);
      },
    );
  });

  describe('the ORIGINATION path honours it — the property that was missing', () => {
    /**
     * A fully-valid activation is not needed: the break-glass is checked FIRST, so if it works,
     * every input short-circuits to false regardless of what follows. The paired assertion below
     * is what makes that meaningful — with the switch off, this same call reaches the later gates
     * and refuses for a DIFFERENT reason, proving the switch is what produced the first refusal.
     */
    const call = (): boolean => shouldPersistGenesisQualification(
      'genesis_human_signup',
      Date.UTC(2026, 7, 1),
      { grants_enabled: true },
    );

    it('refuses when engaged', () => {
      process.env[GENESIS_FORCE_OFF_ENV] = 'true';
      expect(call()).toBe(false);
    });

    it('also refuses when NOT engaged, for an unrelated reason — so the test above is not vacuous', () => {
      // If this returned true, the assertion above would prove the break-glass works. It
      // returns FALSE, so both paths agree and the pair proves nothing on its own — which
      // is exactly why `genesis-activation-rail-open.test.ts` is the binding evidence, not
      // this pair. (institution deployment measured the alternative: a historical control spliced against
      // 4877d16d stays GREEN here and is reported "NOT A TEST". See the file docstring.)
      delete process.env[GENESIS_FORCE_OFF_ENV];
      expect(call()).toBe(false);
    });

    it('is read PER CALL, not captured at module load', () => {
      delete process.env[GENESIS_FORCE_OFF_ENV];
      expect(isGenesisForcedOff()).toBe(false);
      process.env[GENESIS_FORCE_OFF_ENV] = 'true';
      expect(isGenesisForcedOff()).toBe(true);
      delete process.env[GENESIS_FORCE_OFF_ENV];
      expect(isGenesisForcedOff()).toBe(false);
    });
  });

  describe('single source', () => {
    it('genesis-campaign.ts no longer declares its own copy of the predicate', () => {
      // The duplication is how the switch came to gate one module and not the armed path. If a
      // second local `process.env.GENESIS_CAMPAIGN_FORCE_OFF` read reappears, that divergence is
      // back and this fails.
      // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
      const src = require('node:fs').readFileSync(
        require('node:path').join(__dirname, 'genesis-campaign.ts'), 'utf8',
      ) as string;
      expect(src).not.toMatch(/process\.env\.GENESIS_CAMPAIGN_FORCE_OFF/);
      expect(src).toMatch(/isGenesisForcedOff/);
    });
  });
});
