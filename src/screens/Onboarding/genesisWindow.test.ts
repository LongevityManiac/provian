/**
 * The Genesis step must retire ITSELF. These assertions exist because the
 * alternative — a comment asking a human to delete the step later — is a defect
 * with no deadline attached.
 *
 * Both sides of the boundary are exercised: the "still open" case would pass
 * even if the clock were ignored entirely, so the closed case is the one that
 * carries the evidence.
 *
 * Step geometry : five steps, six while Genesis is open, Genesis at index 3.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { GENESIS_WINDOW_END_MS, isGenesisWindowOpen } from './genesisWindow';
import genesisPolicy from '../../../provian-backend/src/core/pvt/policy/__artifacts__/genesis-campaign-policy.json';

const DAY = 86_400_000;

describe('Genesis window clock', () => {
  it('pins the close to the approved policy value, not a guess', () => {
    // window.end_ms in the activation-bound canonical Genesis policy data.
    expect(GENESIS_WINDOW_END_MS).toBe(1_798_761_600_000);
    expect(new Date(GENESIS_WINDOW_END_MS).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('does not drift from the approved policy record', () => {
    expect(genesisPolicy.window.end_ms).toBe(GENESIS_WINDOW_END_MS);
  });

  it('is OPEN inside the approved window - Genesis is armed and admitting', () => {
    expect(isGenesisWindowOpen(GENESIS_WINDOW_END_MS - DAY)).toBe(true);
    expect(isGenesisWindowOpen(GENESIS_WINDOW_END_MS - 1)).toBe(true);
  });

  it('renders TODAY, so the live campaign cannot be hidden by this gate', () => {
    // Regression guard: on 2026-08-04 a second "armed" flag was added here on a
    // false premise and silently hid a live campaign. Genesis runs
    // 2026-08-03 -> 2026-12-31; any date in it must render, including the
    // stretch after the predecessor's 2026-10-26 close and the last day of the year.
    expect(isGenesisWindowOpen(Date.parse('2026-08-04T00:00:00Z'))).toBe(true);
    expect(isGenesisWindowOpen(Date.parse('2026-08-03T00:00:01Z'))).toBe(true);
    expect(isGenesisWindowOpen(Date.parse('2026-10-27T00:00:00Z'))).toBe(true);
    expect(isGenesisWindowOpen(Date.parse('2026-12-31T23:59:59Z'))).toBe(true);
    expect(isGenesisWindowOpen(Date.parse('2027-01-01T00:00:00Z'))).toBe(false);
  });

  // THE NEGATIVE CONTROL: without this the whole gate could be hard-wired true.
  it('is CLOSED at and after the close', () => {
    expect(isGenesisWindowOpen(GENESIS_WINDOW_END_MS)).toBe(false);
    expect(isGenesisWindowOpen(GENESIS_WINDOW_END_MS + 1)).toBe(false);
    expect(isGenesisWindowOpen(GENESIS_WINDOW_END_MS + 365 * DAY)).toBe(false);
  });

  it('fails closed on an unusable clock', () => {
    expect(isGenesisWindowOpen(Number.NaN)).toBe(false);
    expect(isGenesisWindowOpen(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('Genesis step retirement is wired to that clock', () => {
  const SCREEN = readFileSync(resolve(__dirname, 'UnifiedOnboardingScreen.tsx'), 'utf8');

  it('derives the step count instead of hard-coding 6', () => {
    expect(SCREEN).toContain('const GENESIS_ACTIVE = isGenesisWindowOpen();');
    expect(SCREEN).toContain('const TOTAL_STEPS = 5 + G;');
    expect(SCREEN).not.toMatch(/const TOTAL_STEPS = [56];/);
  });

  it('renders the Genesis step, its hero, and its accent only while open', () => {
    expect(SCREEN).toContain('{GENESIS_ACTIVE && (');
    expect(SCREEN).toContain("...(GENESIS_ACTIVE ? ['#E8A838'] : [])");
    expect(SCREEN).toContain(
      "...(GENESIS_ACTIVE ? [require('../../../assets/images/onboarding-genesis.png')] : [])",
    );
  });

  it('offsets every step after Genesis so the flow closes up when it retires', () => {
    // If any later step kept a fixed index, retiring Genesis would leave a gap
    // or land two steps on the same slot.
    for (const later of ['walletFeatures', 'wallet']) {
      expect(SCREEN, `${later} step must not sit on a fixed index`).toMatch(
        new RegExp(`unified\\.${later}(Headline|Cta)`),
      );
    }
    const fixedAfterGenesis = SCREEN.match(/<StepShell index=\{(4|5|6)\}>/g);
    expect(fixedAfterGenesis, 'a step after Genesis still has a hard-coded index').toBeNull();
  });

  it('leaves no manual-removal instruction behind', () => {
    expect(SCREEN).not.toMatch(/set TOTAL_STEPS back to (5|12)/i);
    expect(SCREEN).not.toMatch(/TEMPORARY, campaign window/);
  });

  it('has no second liveness flag that could hide the live campaign', () => {
    const GATE = readFileSync(resolve(__dirname, 'genesisWindow.ts'), 'utf8');
    expect(GATE).not.toMatch(/GENESIS_CAMPAIGN_ARMED/);
  });

  /**
   * The load-bearing control: evaluate the screen's ACTUAL step arrays under both
   * clock states. Source-level greps above can only show the wiring looks right;
   * this shows the flow really does close up to five aligned steps when the
   * window shuts, with the Genesis accent gone from slot 3.
   */
  it.each([
    { open: true, steps: 6, slot3: '#E8A838' },
    { open: false, steps: 5, slot3: '#4A8EE8' },
  ])('collapses correctly with GENESIS_ACTIVE=$open', ({ open, steps, slot3 }) => {
    const bracketed = (decl: string): string => {
      const i = SCREEN.indexOf(decl);
      const a = SCREEN.indexOf('= [', i) + 2; // assignment bracket, not the `string[]` type
      let depth = 0;
      let j = a;
      for (; j < SCREEN.length; j++) {
        if (SCREEN[j] === '[') depth++;
        else if (SCREEN[j] === ']' && --depth === 0) break;
      }
      return SCREEN.slice(a, j + 1);
    };
    const evaluate = (expr: string): unknown[] =>
      // eslint-disable-next-line no-new-func
      new Function('GENESIS_ACTIVE', 'require', `return ${expr}`)(open, () => 'IMG') as unknown[];

    const accents = evaluate(bracketed('const STEP_ACCENTS'));
    const heroes = evaluate(bracketed('const HERO_IMAGES'));

    expect(accents.length, 'accents must equal TOTAL_STEPS').toBe(steps);
    expect(heroes.length, 'heroes must equal TOTAL_STEPS').toBe(steps);
    expect(accents[3], 'slot 3 is Genesis while open, wallet-features once retired').toBe(slot3);
  });
});
