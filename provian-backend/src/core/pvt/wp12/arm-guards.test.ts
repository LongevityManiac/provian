/**
 * the three arm-time guards, each with an in-suite RED negative
 * control.
 *
 * Every guard here is run TWICE: once on the real/correct input, and once on a
 * deliberately violating one that is asserted to FAIL. A guard that has only
 * ever been observed green is not evidence, and on this codebase that is not
 * hypothetical — it is the most common way a defect ships.
 *
 * Nothing here deploys, broadcasts, signs, arms, reads a key, or touches
 * Firestore or the network.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import * as path from 'path';

import {
  AMBIGUOUS_CURSOR_PHRASES,
  ARMED_READBACK_FIELDS,
  ArmGuardRefusal,
  EPOCH_POLICY_STRUCT_MEMBERS,
  INTENDED_INITIAL_FINALIZED_CURSOR,
  assertArmedEpochZeroMatches,
  bindsCursorToSharedConstant,
  findAmbiguousCursorDescriptions,
  resolveInitialFinalizedCursor,
  type ArmedEpochZeroReadback,
  type IntendedEpochZero,
} from './arm-guards';
import {
  KERNEL_NEXT_FINALIZED_CURSOR_START,
  deriveCutoverCursors,
  validateCursorNonOverlap,
  type CutoverCursors,
} from '../wp11/cutover-cursors';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const ARM_SCRIPT = path.join(REPO_ROOT, 'provian-backend', 'scripts', 'wp12-arm-pvt9.ts');
const PRE_ARM_REPORT = path.join(REPO_ROOT, 'docs', 'activation_PRE_ARM_REPORT.md');
const ARM_GUARDS_SOURCE = path.join(__dirname, 'arm-guards.ts');
const KERNEL_SOL = path.join(REPO_ROOT, 'contracts', 'src', 'ProvianPVT9.sol');

// ---------------------------------------------------------------------------
// GUARD 1 — --cursor is bound to the checked-in invariant
// ---------------------------------------------------------------------------

describe('guard 1 · --cursor is bound to the fresh-kernel invariant', () => {
  it('the arm-time constant IS the reconciliation constant, not a second copy', () => {
    // Binding, not coincidence: the value the script arms is derived from the
    // same exported symbol C9 checks. If cutover-cursors.ts ever changed, this
    // moves with it rather than silently disagreeing.
    expect(INTENDED_INITIAL_FINALIZED_CURSOR)
      .toBe(BigInt(KERNEL_NEXT_FINALIZED_CURSOR_START));
    // And that symbol is what the derivation actually emits.
    const cursors = deriveCutoverCursors({
      cut_line_ms: 1,
      legacy_pvtv8: { mint_batches: [] },
      pvt9_posture: { pvt9_deployment_status: 'not_deployed', pvt9_address: null, legacy_migration: false },
    } as never);
    expect(cursors.pvt9_start.kernel_next_finalized_cursor_start)
      .toBe(KERNEL_NEXT_FINALIZED_CURSOR_START);
  });

  it('omitting --cursor defaults to the invariant', () => {
    expect(resolveInitialFinalizedCursor(undefined)).toBe(INTENDED_INITIAL_FINALIZED_CURSOR);
  });

  it('supplying the invariant explicitly is accepted, with surrounding whitespace', () => {
    expect(resolveInitialFinalizedCursor('0')).toBe(INTENDED_INITIAL_FINALIZED_CURSOR);
    expect(resolveInitialFinalizedCursor('  0  ')).toBe(INTENDED_INITIAL_FINALIZED_CURSOR);
  });

  it('NEGATIVE CONTROL — a differing --cursor is REFUSED, naming both values', () => {
    // The exact mistake this guard exists to stop: an operator typing a
    // legacy-derived or simply wrong number into a field nothing validates.
    expect(() => resolveInitialFinalizedCursor('1')).toThrow(ArmGuardRefusal);
    try {
      resolveInitialFinalizedCursor('1784938132043');
      throw new Error('guard did not refuse');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('1784938132043');           // what was supplied
      expect(message).toContain('0');                        // what is valid
      expect(message).toContain('KERNEL_NEXT_FINALIZED_CURSOR_START');
      expect(message).toContain('successor contract');
    }
  });

  it('NEGATIVE CONTROL — a non-numeric --cursor is refused as a refusal, not a raw SyntaxError', () => {
    for (const bad of ['', 'abc', '0x0', '-1', '00', '1e3', ' ']) {
      expect(() => resolveInitialFinalizedCursor(bad)).toThrow(ArmGuardRefusal);
    }
  });

  it('the cursor constant is DERIVED from the shared symbol, not re-spelled', () => {
    // . The redeclaration detector CANNOT catch this:
    // `extractLiteralDeclarations` skips literals under two characters (`'0'` is
    // one) and only compares tests against modules, never module against module.
    // Both spellings evaluate to `0n`, so no value assertion distinguishes them
    // either — the binding is a SOURCE property and is checked as one.
    const source = readFileSync(ARM_GUARDS_SOURCE, 'utf8');
    expect(source.length).toBeGreaterThan(2000);
    expect(bindsCursorToSharedConstant(source)).toBe(true);
  });

  it('NEGATIVE CONTROL — severing the binding to a bare `0` is DETECTED', () => {
    // The reviewer`s exact mutation, which previously left the whole suite green.
    const source = readFileSync(ARM_GUARDS_SOURCE, 'utf8');
    const severed = source.replace(
      /BigInt\(\s*KERNEL_NEXT_FINALIZED_CURSOR_START,?\s*\)/,
      "BigInt('0')",
    );
    expect(severed).not.toBe(source);           // the mutation actually applied
    expect(bindsCursorToSharedConstant(severed)).toBe(false);
    // Dropping the import alone is also caught.
    expect(bindsCursorToSharedConstant(
      source.replace(/import\s*\{[^}]*KERNEL_NEXT_FINALIZED_CURSOR_START[^}]*\}[^;]*;/, ''),
    )).toBe(false);
    // And an empty source is never a silent pass.
    expect(bindsCursorToSharedConstant('')).toBe(false);
  });

  it('C9 still refuses a non-invariant cursor after the constant was extracted', () => {
    const base: CutoverCursors = {
      schema_version: 'pvt-cutover-cursors/v1',
      pvtv8_finalized: {
        finalized_batch_count: 0,
        unfinalized_batch_count: 0,
        last_finalized_batch_id: null,
        last_finalized_mint_tx_hash: null,
        max_finalized_epoch: null,
        max_settled_pe_timestamp_ms: null,
        total_finalized_points_atomic: '0',
      },
      pvt9_start: {
        kernel_next_finalized_cursor_start: KERNEL_NEXT_FINALIZED_CURSOR_START,
        starts_after_ms: 1,
        kernel_deployed: false,
        legacy_migration_configured: false,
      },
    };
    expect(validateCursorNonOverlap(base).ok).toBe(true);
    // NEGATIVE CONTROL: widen the field so the violation is constructible.
    const violating = {
      ...base,
      pvt9_start: { ...base.pvt9_start, kernel_next_finalized_cursor_start: '1' },
    } as never as CutoverCursors;
    const verdict = validateCursorNonOverlap(violating);
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join(' ')).toContain('fresh-kernel invariant');
  });
});

// ---------------------------------------------------------------------------
// GUARD 2 — the usage text no longer misdescribes the cursor
// ---------------------------------------------------------------------------

describe('guard 2 · the cursor is described as what it is', () => {
  const DOCS = [ARM_SCRIPT, PRE_ARM_REPORT];

  it('NEGATIVE CONTROL — the exact phrase that shipped before is caught', () => {
    const before = [
      ' * --cursor <uint> initialFinalizedCursor (the cutover reconciliation cut-line cursor)',
      'substitute … and the cutover reconciliation cut-line cursor',
    ].join('\n');
    const hits = findAmbiguousCursorDescriptions(before);
    expect(hits.map((h) => h.line)).toEqual([1, 2]);
    expect(hits[0].text).toContain('cut-line cursor');
  });

  it('NEGATIVE CONTROL — every ambiguous phrase is individually able to fire', () => {
    // Otherwise one dead pattern could sit in the list forever, unnoticed.
    const samples = [
      'this is the cut-line cursor value',
      'pass the cutover reconciliation cursor here',
      'the cursor at the cut line',
    ];
    expect(samples.length).toBe(AMBIGUOUS_CURSOR_PHRASES.length);
    for (const sample of samples) {
      expect(findAmbiguousCursorDescriptions(sample).length).toBeGreaterThan(0);
    }
  });

  it('NEGATIVE CONTROL — an EMPTY source is a HIT, never a silent pass', () => {
    // "Scanned nothing" must not read as "found nothing wrong".
    expect(findAmbiguousCursorDescriptions('')).toEqual([
      { line: 0, phrase: 'empty-source', text: 'nothing was scanned' },
    ]);
    expect(findAmbiguousCursorDescriptions('   \n  ')[0].phrase).toBe('empty-source');
  });
});

// ---------------------------------------------------------------------------
// GUARD 3 — post-arm readback
// ---------------------------------------------------------------------------

const VERIFIER = '0x00000000000000000000000000000000000000A1';
const CONFIG_ID = '0xe0ee2de78a611198a17183b8505ed321902ba64b6577e2f1cb04a24e37cf23cb';

const INTENDED: IntendedEpochZero = {
  epochZeroStartsAtSec: 1_786_838_400n,
  genesisStartsAtSec: 1_786_838_400n,
  genesisEndsAtSec: 1_794_096_000n,
  initialMintRate: 1_000_000_000_000_000_000n,
  provianTreasury: '0x086e0F377af1245B8888540f39e99A42a7daF1dA',
  foundationTreasury: '0x94F3D06ca027dFD1e6cCaa1117b050E08D5EA936',
  eligibilityVerifier: VERIFIER,
  configurationId: CONFIG_ID,
  configurationVersion: 1n,
  initialFinalizedCursor: INTENDED_INITIAL_FINALIZED_CURSOR,
  // Read from the deployed kernel at arm time; fixed here as the values the
  // reviewed kernel source declares.
  kernelInitialGenesisEpochCap: 7_500_000_000_000_000_000_000_000n,
  kernelInitialCombinedEpochCap: 10_000_000_000_000_000_000_000_000n,
  kernelHumanFoundationBps: 50n,
};

const MATCHING: ArmedEpochZeroReadback = {
  epochZeroArmed: true,
  epochZeroStartsAt: INTENDED.epochZeroStartsAtSec,
  genesisStartsAt: INTENDED.genesisStartsAtSec,
  genesisEndsAt: INTENDED.genesisEndsAtSec,
  nextFinalizedCursor: INTENDED.initialFinalizedCursor,
  policyOpened: true,
  policyEpoch: 0n,
  policyStartsAt: INTENDED.epochZeroStartsAtSec,
  policyCombinedCapMode: 0n,
  policyMintRate: INTENDED.initialMintRate,
  policyGenesisCap: INTENDED.kernelInitialGenesisEpochCap,
  policyCombinedCap: INTENDED.kernelInitialCombinedEpochCap,
  policyProvianTreasury: INTENDED.provianTreasury,
  policyFoundationTreasury: INTENDED.foundationTreasury,
  policyAgentFoundationBps: INTENDED.kernelHumanFoundationBps,
  policyBeneficiaryVerifier: '0x0000000000000000000000000000000000000000',
  policyEligibilityVerifier: VERIFIER,
  policyEligibilityConfigurationId: CONFIG_ID,
  policyEligibilityConfigurationVersion: 1n,
  policyHash: '0x1234567890123456789012345678901234567890123456789012345678901234',
};

/** One corruption per compared field, keyed by the field name it must report. */
const CORRUPTIONS: ReadonlyArray<[string, Partial<ArmedEpochZeroReadback>]> = [
  ['epochZeroArmed', { epochZeroArmed: false }],
  ['epochZeroStartsAt', { epochZeroStartsAt: 1_786_838_401n }],
  ['genesisStartsAt', { genesisStartsAt: 1_786_838_401n }],
  ['genesisEndsAt', { genesisEndsAt: 1_794_096_001n }],
  ['nextFinalizedCursor', { nextFinalizedCursor: 1n }],
  ['getEpochPolicy(0).opened', { policyOpened: false }],
  ['getEpochPolicy(0).epoch', { policyEpoch: 1n }],
  ['getEpochPolicy(0).startsAt', { policyStartsAt: 1_786_838_401n }],
  ['getEpochPolicy(0).combinedCapMode', { policyCombinedCapMode: 1n }],
  ['getEpochPolicy(0).mintRate', { policyMintRate: 2_000_000_000_000_000_000n }],
  ['getEpochPolicy(0).genesisCap', { policyGenesisCap: 1n }],
  ['getEpochPolicy(0).combinedCap', { policyCombinedCap: 1n }],
  ['getEpochPolicy(0).provianTreasury', {
    policyProvianTreasury: '0x94F3D06ca027dFD1e6cCaa1117b050E08D5EA936',
  }],
  ['getEpochPolicy(0).foundationTreasury', {
    policyFoundationTreasury: '0x086e0F377af1245B8888540f39e99A42a7daF1dA',
  }],
  ['getEpochPolicy(0).agentFoundationBps', { policyAgentFoundationBps: 500n }],
  ['getEpochPolicy(0).beneficiaryVerifier.verifier', {
    policyBeneficiaryVerifier: '0x00000000000000000000000000000000000000C3',
  }],
  ['getEpochPolicy(0).eligibilityVerifier.verifier', {
    policyEligibilityVerifier: '0x00000000000000000000000000000000000000B2',
  }],
  ['getEpochPolicy(0).eligibilityVerifier.configurationId', {
    policyEligibilityConfigurationId:
      '0x0000000000000000000000000000000000000000000000000000000000000001',
  }],
  ['getEpochPolicy(0).eligibilityVerifier.version', {
    policyEligibilityConfigurationVersion: 2n,
  }],
  ['getEpochPolicy(0).policyHash (non-zero)', {
    policyHash: `0x${'0'.repeat(64)}`,
  }],
];

describe('guard 3 · the armed state is read back and compared to intent', () => {
  it('a matching readback passes, and reports how many fields it compared', () => {
    const compared = assertArmedEpochZeroMatches(INTENDED, MATCHING);
    // A count, not a bare pass: "compared nothing" can never read as "matched".
    expect(compared).toBe(ARMED_READBACK_FIELDS.length);
    expect(compared).toBeGreaterThan(19);
  });

  it('EVERY member of the on-chain EpochPolicy struct is covered', () => {
    // the readback compared 8 of the struct`s 13
    // members while the report claimed "every field". Bind the claim to the
    // struct so a member added on chain, or dropped from the readback, fails
    // here instead of silently going unverified.
    for (const member of EPOCH_POLICY_STRUCT_MEMBERS) {
      expect(ARMED_READBACK_FIELDS.some((f) => f.startsWith(`getEpochPolicy(0).${member}`)))
        .toBe(true);
    }
    // And the member list must match the Solidity struct itself, not a stale copy.
    const sol = readFileSync(KERNEL_SOL, 'utf8');
    const struct = sol.slice(sol.indexOf('struct EpochPolicy {'));
    const body = struct.slice(0, struct.indexOf('}'));
    const declared = [...body.matchAll(/^\s+[A-Za-z0-9_.[\]]+\s+([A-Za-z_][A-Za-z0-9_]*);/gm)]
      .map((m) => m[1]);
    expect(declared.length).toBe(EPOCH_POLICY_STRUCT_MEMBERS.length);
    expect(declared).toEqual([...EPOCH_POLICY_STRUCT_MEMBERS]);
  });

  it('NEGATIVE CONTROL — a struct member missing from the readback is caught', () => {
    const withoutOne = ARMED_READBACK_FIELDS.filter(
      (f) => !f.startsWith('getEpochPolicy(0).genesisCap'),
    );
    expect(EPOCH_POLICY_STRUCT_MEMBERS.every(
      (member) => withoutOne.some((f) => f.startsWith(`getEpochPolicy(0).${member}`)),
    )).toBe(false);
  });

  it('address comparison is checksum-insensitive (the chain returns its own casing)', () => {
    expect(assertArmedEpochZeroMatches(INTENDED, {
      ...MATCHING,
      policyProvianTreasury: INTENDED.provianTreasury.toLowerCase(),
      policyFoundationTreasury: INTENDED.foundationTreasury.toUpperCase().replace('0X', '0x'),
    })).toBe(ARMED_READBACK_FIELDS.length);
  });

  it('configurationId comparison is case-insensitive hex', () => {
    expect(assertArmedEpochZeroMatches(INTENDED, {
      ...MATCHING,
      policyEligibilityConfigurationId: CONFIG_ID.toUpperCase().replace('0X', '0x'),
    })).toBe(ARMED_READBACK_FIELDS.length);
  });

  it('NEGATIVE CONTROL — EVERY compared field is individually able to fail', () => {
    // The defect this forecloses: a readback that looks thorough but silently
    // skips a field. Each corruption must be caught AND must name its own field.
    expect(CORRUPTIONS.length).toBe(ARMED_READBACK_FIELDS.length);
    expect(CORRUPTIONS.map(([field]) => field)).toEqual([...ARMED_READBACK_FIELDS]);
    for (const [field, corruption] of CORRUPTIONS) {
      let caught: Error | null = null;
      try {
        assertArmedEpochZeroMatches(INTENDED, { ...MATCHING, ...corruption });
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).not.toBeNull();
      expect(caught).toBeInstanceOf(ArmGuardRefusal);
      expect(caught!.message).toContain(field);
      expect(caught!.message).toContain('successor contract');
    }
  });

  it('NEGATIVE CONTROL — the FIRST mismatch is the one reported', () => {
    const err = (() => {
      try {
        assertArmedEpochZeroMatches(INTENDED, {
          ...MATCHING,
          genesisEndsAt: 1n,
          nextFinalizedCursor: 99n,
        });
        return null;
      } catch (e) { return e as Error; }
    })();
    expect(err).not.toBeNull();
    expect(err!.message).toContain('genesisEndsAt');
    expect(err!.message).not.toContain('nextFinalizedCursor');
  });

  it('NEGATIVE CONTROL — a wrongly-armed cursor is caught by the readback too', () => {
    // Guard 1 stops a bad --cursor going in; guard 3 stops a bad value having
    // landed for any other reason. Neither is the other`s substitute.
    expect(() => assertArmedEpochZeroMatches(INTENDED, {
      ...MATCHING,
      nextFinalizedCursor: 1n,
    })).toThrow(/nextFinalizedCursor: on chain 1, intended 0/);
  });
});
