/**
 * THE DURABILITY MARKER IS WATCHER-ONLY. This is the fence that keeps it there.
 *
 * Only the independent funding watcher may set durableViaOrdinaryIntake.
 * The three relay funding emitters must not pass that marker.
 *
 * WHY IT IS A MONEY-PATH RULE AND NOT A STYLE PREFERENCE
 * -----------------------------------------------------
 * The marker is one of the three conditions proved seal a row `eligible`
 * (durable inlet + `evidenceState: 'verified'` + a canonical event id). The
 * relay emitters — `escrow.ts::escrow_funded`, `promises.ts::promise_funded`
 * (borrower AND lender), `pools.ts::pool_contributed` fire on what an API
 * CALLER told the relay, about the SAME canonical on-chain events the
 * institution funding watcher independently observes and earns on.
 *
 * Marking them durable would therefore put policy-eligible mode-(b) rows on
 * canonical events the watcher already carries a row for — two payable rows for
 * one log identity. That is exactly what ** forbids** one
 * canonical log identity → ONE eligible row. Exactly-once keys on the canonical
 * event ALONE, so a later generalised promoter could not tell the pair apart and
 * would mint both.
 *
 * The relay emitters keep recording and keep paying 0. That is the design.
 *
 * WHAT THIS FILE ASSERTS, AND WHAT IT CANNOT
 * ------------------------------------------
 * A source fence over the three real production modules: the marker's name must
 * not appear in any of them, anywhere — not only at today's call sites, so a new
 * emission path added to one of these files trips it too.
 *
 * It watches BOTH doors into the durable economic path — `durableViaOrdinaryIntake`
 * and `awaitAccrual` (which becomes `throwOnError`, which sets
 * `durableEconomicPath` in `pvt-accrual.ts`). Watching only the first was the
 * gap the 1d reviewer leg found; see `DURABILITY_MARKERS`.
 *
 * DECLARED LIMIT (the lesson, stated rather than discovered later): a
 * source scan cannot see a key assembled at runtime — a spread of an object
 * built in another module would pass this file. That hole is closed at the other
 * end, by RUNTIME assertions on the captured `generatePE` params inside the
 * three flows' own harnesses (`escrow.verifyFunding.test.ts`,
 * `promises.fund.test.ts`, `pools.contribute.test.ts`), which see what is
 * actually passed rather than what is written. Neither half is sufficient alone.
 *
 * Both RED controls below are PERMANENT and in-suite : the scanner is
 * shown FAILING on real production source with the marker injected, so a pass
 * over the real files means the scanner works, not that it was hard-wired green.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import type { GeneratePEParams } from './pe-utils';

/**
 * Bound to production's OWN field name, not a copy of it: `Extract` resolves to
 * the literal only while `GeneratePEParams` actually declares it, and to `never`
 * an assignment error — the moment it is renamed or removed. So this fence
 * cannot quietly start scanning for a string production no longer uses, which is
 * the self-referential-control shape names.
 */
const DURABLE_MARKER: Extract<keyof GeneratePEParams, 'durableViaOrdinaryIntake'> =
  'durableViaOrdinaryIntake';

/**
 * THE SECOND DOOR, found by the 1d reviewer leg.
 *
 * Durability has two producers, not one. `pvt-accrual.ts` sets
 * `durableEconomicPath = params.throwOnError === true`, and `pe-utils.ts` sets
 * `throwOnError` from `awaitAccrual`. So a relay emitter that gained
 * `awaitAccrual: true` plus a `verified` metadata key would produce exactly the
 * durable, policy-eligible relay row on the watcher's own canonical event that
 * forbids — and a fence watching only the first marker would not see it.
 *
 * No live trigger exists (none of the three emitters passes `awaitAccrual`, and
 * none of their metadata carries `verified`), so this closes a latent door
 * rather than an open one.
 */
const AWAIT_MARKER: Extract<keyof GeneratePEParams, 'awaitAccrual'> = 'awaitAccrual';

/** Both doors into the durable economic path. Neither may be opened here. */
const DURABILITY_MARKERS = Object.freeze([DURABLE_MARKER, AWAIT_MARKER]);

/**
 * The three relay emitters of the funding trio. Paths, not contents — the fence
 * reads the real modules the server imports.
 */
const RELAY_EMITTER_SOURCES = Object.freeze([
  'escrow.ts',
  'promises.ts',
  'pools.ts',
]);

/** 1-indexed lines on which EITHER durability marker appears. Empty is required. */
function findDurableMarker(source: string): number[] {
  return source
    .split('\n')
    .map((line, index) => (
      DURABILITY_MARKERS.some((marker) => line.includes(marker)) ? index + 1 : 0
    ))
    .filter((lineNumber) => lineNumber > 0);
}

function readRelayEmitterSource(file: string): string {
  return readFileSync(`${__dirname}/${file}`, 'utf8');
}

describe('relay emitters never claim the durable inlet (, ratified)', () => {
  it('none of the three production modules names the marker', () => {
    let filesEvaluated = 0;

    for (const file of RELAY_EMITTER_SOURCES) {
      const source = readRelayEmitterSource(file);

      // The empty-population guard: a scan over a file that failed to load, or
      // that no longer emits, would pass this suite vacuously. Bind to the fact
      // that each module is real and still emits through generatePE.
      expect(source.length).toBeGreaterThan(1000);
      expect(source).toContain('generatePE(');
      filesEvaluated += 1;

      expect({ file, markerLines: findDurableMarker(source) }).toEqual({
        file,
        markerLines: [],
      });
    }

    // A universally-quantified claim over zero items is not a pass.
    expect(filesEvaluated).toBe(RELAY_EMITTER_SOURCES.length);
    expect(filesEvaluated).toBe(3);
  });

  it('RED CONTROL — the scanner reports EITHER marker when it is present', () => {
    // Both doors, asserted separately: a scanner that only saw the first would
    // pass the first case and silently miss the second.
    for (const marker of DURABILITY_MARKERS) {
      const violating = [
        '    const res = await generatePE(deps, {',
        "      actionType: 'escrow_funded',",
        `      ${marker}: true,`,
        '    });',
      ].join('\n');

      expect({ marker, hits: findDurableMarker(violating) }).toEqual({ marker, hits: [3] });
    }
    expect(DURABILITY_MARKERS).toHaveLength(2);
  });

  it('RED CONTROL — the scanner fires on REAL production source, marker injected', () => {
    for (const file of RELAY_EMITTER_SOURCES) {
      const pristine = readRelayEmitterSource(file);
      expect(findDurableMarker(pristine)).toEqual([]);

      // Inject at the real call site rather than appending: this is the exact
      // edit the fence exists to refuse, and it proves the scanner sees it in
      // the shape it would actually arrive in.
      for (const marker of DURABILITY_MARKERS) {
        const injected = pristine.replace(
          'await generatePE(deps, {',
          `await generatePE(deps, {\n      ${marker}: true,`,
        );
        expect(injected).not.toBe(pristine);
        expect(findDurableMarker(injected).length).toBeGreaterThan(0);
      }
    }
  });
});
