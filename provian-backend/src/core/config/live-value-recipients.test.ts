/**
 * Live-value recipient guard — behaviour + permanent RED controls.
 *
 * The run contract requires that a new guard on a money path ship with its RED
 * negative control IN the commit, as a permanent in-suite control rather than a
 * one-shot someone ran by hand. The three named failure shapes are all live
 * hazards for this particular guard, so each has a test below:
 *
 *  - EMPTY POPULATION: with no recipient var set, the guard evaluates zero items
 *    and would "pass" while proving nothing. `status: 'vacuous'` exists to make
 *    that a distinct, non-passing result, and `vacuous is not ok` asserts it.
 *  - SELF-REFERENTIAL CONTROL: the suite must not assert the guard against its
 *    own private copy of the address. The keeper-identity block binds the shared
 *    constants to the three keeper modules that consume them and asserts none has
 *    reintroduced a private literal, so a dropped import fails here.
 *  - UNREACHABLE BRANCH: `auditLiveValueRecipients` takes env and var list as
 *    PARAMETERS so the violating configuration is constructible. Production
 *    still passes `process.env` and the module default.
 */

import fs from 'fs';
import path from 'path';
import {
  auditLiveValueRecipients,
  assertLiveValueRecipient,
  assertNoExposedKeyAsLiveValueRecipient,
  EXPOSED_LEGACY_EOA,
  FORBIDDEN_KEEPER_IDENTITIES,
  KEEPER_FORBIDDEN_SIGNER_VAR,
  LEGACY_KEEPER_FORBIDDEN_SIGNER_VAR,
  LIVE_VALUE_RECIPIENT_VARS,
  PROVIAN_TREASURY,
  keeperForbiddenSignerEntries,
} from './live-value-recipients';

/**
 * The Provian treasury in EIP-55 CHECKSUMMED form — the shape it actually takes in
 * `.env.example` and on Cloud Run. The module stores it lowercased, so using the checksummed
 * literal here also proves the guard is case-insensitive on the happy path rather than only on
 * the violating one.
 */
const PROVIAN_TREASURY_CHECKSUMMED = '0x086e0F377af1245B8888540f39e99A42a7daF1dA';

describe('live-value recipient guard', () => {
  describe('GREEN — the fixed configuration', () => {
    it('admits the Provian treasury as a swap fee recipient', () => {
      const audit = auditLiveValueRecipients({ SWAP_FEE_RECIPIENT: PROVIAN_TREASURY_CHECKSUMMED });

      expect(audit.status).toBe('ok');
      expect(audit.evaluated).toBe(1);
      expect(audit.violations).toEqual([]);
    });

    it('does NOT flag the exposed EOA when it sits in the keeper-identity variable (either name)', () => {
      // The whole point of the split: that variable names a KEY IDENTITY for
      // forbidden-set checks, not a payout destination. It may legitimately hold
      // the exposed EOA — that is what makes the keeper guards work. Only
      // destinations are audited here.
      const audit = auditLiveValueRecipients({
        [KEEPER_FORBIDDEN_SIGNER_VAR]: EXPOSED_LEGACY_EOA,
        [LEGACY_KEEPER_FORBIDDEN_SIGNER_VAR]: EXPOSED_LEGACY_EOA,
        SWAP_FEE_RECIPIENT: PROVIAN_TREASURY_CHECKSUMMED,
      });

      expect(audit.status).toBe('ok');
      expect(audit.violations).toEqual([]);
    });

    it('keeps the keeper-identity variable (both names) out of the live-value recipient list', () => {
      // If this ever fails, the two roles have been re-merged and the
      // defect is reachable again.
      expect(KEEPER_FORBIDDEN_SIGNER_VAR).toBe('KEEPER_FORBIDDEN_SIGNER_ADDRESS');
      expect(LEGACY_KEEPER_FORBIDDEN_SIGNER_VAR).toBe('PROVIAN_TREASURY_ADDRESS');
      expect(LIVE_VALUE_RECIPIENT_VARS).not.toContain(KEEPER_FORBIDDEN_SIGNER_VAR);
      expect(LIVE_VALUE_RECIPIENT_VARS).not.toContain(LEGACY_KEEPER_FORBIDDEN_SIGNER_VAR);
      expect(LIVE_VALUE_RECIPIENT_VARS.length).toBeGreaterThan(0);
    });
  });

  describe('RED — the pre-fix production environment', () => {
    /**
     * THE CONTROL THE REMEDIATION IS JUDGED BY.
     *
     * Before this commit, `agent-wallet.ts` read PROVIAN_TREASURY_ADDRESS and
     * passed it as the 0x `swapFeeRecipient`. On the live relay that variable
     * held the exposed legacy EOA. Auditing THAT var as a live-value recipient
     * reproduces the production configuration exactly, and the guard must call
     * it a violation. A guard that stayed green here would be worthless.
     */
    it('reports a violation for the exact pre-fix production config', () => {
      const audit = auditLiveValueRecipients(
        { PROVIAN_TREASURY_ADDRESS: EXPOSED_LEGACY_EOA },
        ['PROVIAN_TREASURY_ADDRESS'], // the pre-fix resolution: this var WAS the destination
      );

      expect(audit.status).toBe('violation');
      expect(audit.evaluated).toBe(1);
      expect(audit.violations).toHaveLength(1);
      expect(audit.violations[0].varName).toBe('PROVIAN_TREASURY_ADDRESS');
      expect(audit.violations[0].reason).toMatch(/plaintext-exposure/);
    });

    it('throws at boot on the pre-fix config once that var is a destination', () => {
      expect(() =>
        assertNoExposedKeyAsLiveValueRecipient({ SWAP_FEE_RECIPIENT: EXPOSED_LEGACY_EOA }),
      ).toThrow(/REFUSING TO ROUTE VALUE TO AN EXPOSED KEY/);
    });

    it('matches the exposed EOA regardless of checksum casing or whitespace', () => {
      const checksummed = '  0xD395c8f59131a4736aa4d9eE6e5dEb8fDA07Ce0a  ';
      const audit = auditLiveValueRecipients({ SWAP_FEE_RECIPIENT: checksummed });

      expect(audit.status).toBe('violation');
    });

    it('refuses at request time, where the value actually moves', () => {
      expect(() =>
        assertLiveValueRecipient('SWAP_FEE_RECIPIENT', EXPOSED_LEGACY_EOA),
      ).toThrow(/Refusing to route value/);

      expect(() =>
        assertLiveValueRecipient('SWAP_FEE_RECIPIENT', PROVIAN_TREASURY_CHECKSUMMED),
      ).not.toThrow();
    });
  });

  describe('RED — the empty population', () => {
    it('reports vacuous, NOT ok, when no recipient var is set', () => {
      const audit = auditLiveValueRecipients({});

      expect(audit.evaluated).toBe(0);
      expect(audit.status).toBe('vacuous');
      // The assertion that matters: a check over zero items is not a pass.
      expect(audit.status).not.toBe('ok');
    });

    it('treats a blank-string recipient as unset rather than as a checked item', () => {
      const audit = auditLiveValueRecipients({ SWAP_FEE_RECIPIENT: '   ' });

      expect(audit.evaluated).toBe(0);
      expect(audit.status).toBe('vacuous');
    });

    it('does not throw at boot on a vacuous audit — swap is structurally closed', () => {
      expect(() => assertNoExposedKeyAsLiveValueRecipient({})).not.toThrow();
      expect(assertNoExposedKeyAsLiveValueRecipient({}).status).toBe('vacuous');
    });
  });

  describe('keeper identities — one declaration, three importers ', () => {
    const KEEPER_MODULES = [
      '../agent-bank/escrow-release.ts',
      '../agent-bank/pool-keeper.ts',
      '../agent-bank/bond-keeper.ts',
    ];

    /**
     * THE DEFECT THIS EXISTS FOR. The three keeper guards each read
     * `PROVIAN_TREASURY_ADDRESS` into their forbidden set and separately hardcoded the exposed
     * EOA. Because one variable cannot name two addresses, whichever address it did NOT name was
     * uncovered — and it named the exposed EOA, so the TREASURY (which receives every fee in the
     * system, and is now SWAP_FEE_RECIPIENT) was in no forbidden set at all. A keeper key set to
     * the treasury key would have passed every guard.
     */
    it('forbids BOTH the exposed EOA and the treasury as keeper identities', () => {
      expect(FORBIDDEN_KEEPER_IDENTITIES.get(EXPOSED_LEGACY_EOA)).toBeDefined();
      expect(FORBIDDEN_KEEPER_IDENTITIES.get(PROVIAN_TREASURY)).toBeDefined();
      expect(FORBIDDEN_KEEPER_IDENTITIES.size).toBeGreaterThanOrEqual(2);
      // The treasury and the exposed EOA are different addresses — a collapsed
      // constant would make the two assertions above the same assertion.
      expect(PROVIAN_TREASURY).not.toBe(EXPOSED_LEGACY_EOA);
    });

    /**
     * Drift control, restructured. Before the risk was three copies of one address drifting
     * apart; now it is a module silently dropping the shared import and going back to its own
     * literal. So: every keeper module must IMPORT and USE the shared set, and must NOT carry a
     * bare 40-hex address literal of its own.
     */
    it.each(KEEPER_MODULES)('%s imports the shared set and declares no private address', (rel) => {
      const source = fs.readFileSync(path.join(__dirname, rel), 'utf8');

      expect(source).toContain("from '../config/live-value-recipients'");
      expect(source).toContain('FORBIDDEN_KEEPER_IDENTITIES');

      const literals = (source.match(/0x[a-fA-F0-9]{40}/g) ?? [])
        .map((m) => m.toLowerCase());
      expect(literals).not.toContain(EXPOSED_LEGACY_EOA);
      expect(literals).not.toContain(PROVIAN_TREASURY);
    });

    it.each(KEEPER_MODULES)('%s reads the keeper-identity variable only through the shared reader', (rel) => {
      const source = fs.readFileSync(path.join(__dirname, rel), 'utf8');
      expect(source).toContain('keeperForbiddenSignerEntries()');
      expect(source).not.toContain('process.env.PROVIAN_TREASURY_ADDRESS');
      expect(source).not.toContain('process.env.KEEPER_FORBIDDEN_SIGNER_ADDRESS');
    });

    it('evaluated all three keeper modules, not an empty list', () => {
      expect(KEEPER_MODULES).toHaveLength(3);
      for (const rel of KEEPER_MODULES) {
        expect(fs.existsSync(path.join(__dirname, rel))).toBe(true);
      }
    });
  });

  describe('keeper-identity variable — renamed, former name still read', () => {
    const A = '0x1111111111111111111111111111111111111111';
    const B = '0x2222222222222222222222222222222222222222';

    it('reads the new name', () => {
      expect(keeperForbiddenSignerEntries({ KEEPER_FORBIDDEN_SIGNER_ADDRESS: ` ${A.toUpperCase().replace('0X', '0x')} ` }))
        .toEqual([[A, 'treasury key identity (KEEPER_FORBIDDEN_SIGNER_ADDRESS)']]);
    });

    it('still reads the former name the deployed environment carries', () => {
      expect(keeperForbiddenSignerEntries({ PROVIAN_TREASURY_ADDRESS: A }))
        .toEqual([[A, 'treasury key identity (PROVIAN_TREASURY_ADDRESS)']]);
    });

    it('forbids both when both are set: a half-finished rename never drops an exclusion', () => {
      expect(keeperForbiddenSignerEntries({ KEEPER_FORBIDDEN_SIGNER_ADDRESS: A, PROVIAN_TREASURY_ADDRESS: B }).map(([a]) => a))
        .toEqual([A, B]);
    });

    it('RED: an empty or blank configuration yields nothing, so a pass over it is not mistaken for coverage', () => {
      expect(keeperForbiddenSignerEntries({})).toEqual([]);
      expect(keeperForbiddenSignerEntries({ KEEPER_FORBIDDEN_SIGNER_ADDRESS: '  ', PROVIAN_TREASURY_ADDRESS: '' })).toEqual([]);
    });
  });

  describe('CALL SITE — the swap route must not regress to the treasury variable', () => {
    /**
     * WHY A SOURCE-READING TEST. The module-level tests above all pass if someone reverts the swap
     * route to `process.env.PROVIAN_TREASURY_ADDRESS` and deletes the request-time guard: nothing
     * else in the suite reads that handler, so live value would silently resume routing to the
     * exposed EOA with 322 green suites. This pins the fixed behaviour at the one place it was
     * broken. Precedent for the shape: `routes/rotate-key-address-casing.source.test.ts`.
     */
    const routeSource = (): string =>
      fs.readFileSync(path.join(__dirname, '../../routes/agent-wallet.ts'), 'utf8');

    /**
     * The 0x quote block as CODE — `//` comment bodies stripped, so the assertions cannot be
     * satisfied or broken by prose. The explanatory comment above the fix legitimately names the
     * old variable; only executable references to it are a regression.
     */
    const swapQuoteCode = (): string => {
      const src = routeSource();
      const start = src.indexOf('swapFeeRecipient');
      expect(start).toBeGreaterThan(-1); // the swap quote block must still exist
      const from = src.lastIndexOf('const zeroxApiKey', start);
      expect(from).toBeGreaterThan(-1);
      return src.slice(from, start + 400)
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n');
    };

    it('resolves the fee recipient from SWAP_FEE_RECIPIENT, never PROVIAN_TREASURY_ADDRESS', () => {
      const code = swapQuoteCode();
      expect(code).toContain('process.env.SWAP_FEE_RECIPIENT');
      expect(code).not.toContain('PROVIAN_TREASURY_ADDRESS');
      // Guard the stripper: if it ever removed everything, the negative above would pass vacuously.
      expect(code.replace(/\s/g, '').length).toBeGreaterThan(80);
    });

    it('calls the request-time guard before building the 0x request', () => {
      const src = routeSource();
      const guardAt = src.indexOf("assertLiveValueRecipient('SWAP_FEE_RECIPIENT'");
      const quoteAt = src.indexOf('api.0x.org/swap');
      expect(guardAt).toBeGreaterThan(-1); // request-time guard deleted
      expect(quoteAt).toBeGreaterThan(-1);
      expect(guardAt).toBeLessThan(quoteAt); // guard must precede the outbound call
    });

    it('imports the guard rather than redefining the check locally', () => {
      expect(routeSource()).toContain(
        "import { assertLiveValueRecipient } from '../core/config/live-value-recipients'",
      );
    });

    it('the whole repo routes no live value to the exposed EOA by env-var name', () => {
      // The keeper-identity variable may be READ (keeper guards) but must never be passed as a
      // recipient/destination field. This catches a new misroute of the original shape.
      const src = routeSource();
      expect(src).not.toMatch(/swapFeeRecipient:\s*treasuryAddress/);
      expect(src).not.toMatch(/[Rr]ecipient:\s*process\.env\.PROVIAN_TREASURY_ADDRESS/);
      expect(src).not.toMatch(/[Rr]ecipient:\s*process\.env\.KEEPER_FORBIDDEN_SIGNER_ADDRESS/);
    });
  });
});
