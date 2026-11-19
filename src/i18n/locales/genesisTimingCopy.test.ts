import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every locale tells a new person when the Genesis grant arrives: at the next daily Genesis
 * settlement, 00:00 UTC, so up to about 24 hours after joining — on the onboarding Genesis step and
 * on the Vision screen's Genesis card.
 */
const LOCALES = ['en', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt', 'sw', 'tl', 'vi', 'zh'];
const KEYS = [['onboarding', 'unified', 'genesisSubtext'], ['visionScreen', 'genesisBody']];

function at(tree: unknown, path: string[]): string {
  let node = tree as Record<string, unknown>;
  for (const part of path) node = node[part] as Record<string, unknown>;
  return node as unknown as string;
}

/** The timing sentence: 00:00 UTC, then the 24-hour bound. */
export function tellsGenesisTiming(text: string): boolean {
  return /00:00/.test(text) && /UTC/.test(text) && /00:00[^]*24/.test(text);
}

describe('the Genesis grant timing is stated in all 12 locales', () => {
  it('RED control: the copy before this sentence was added does not pass the check', () => {
    expect(tellsGenesisTiming('Genesis is the launch period of the network, open through December 31, 2026. The last day pays exactly what the first day paid.')).toBe(false);
  });

  let checked = 0;
  for (const locale of LOCALES) {
    it(`${locale}: both Genesis texts say 00:00 UTC and up to about 24 hours`, () => {
      const tree = JSON.parse(readFileSync(resolve(__dirname, `${locale}.json`), 'utf8')) as unknown;
      for (const key of KEYS) {
        expect(tellsGenesisTiming(at(tree, key))).toBe(true);
        checked += 1;
      }
    });
  }
  it('checked 24 texts (12 locales × 2 keys), never an empty population', () => {
    expect(checked).toBe(LOCALES.length * KEYS.length);
  });
});
