/**
 * The Commons Registry card shows a verification mark (the green shield-check) only for the
 * verification actually performed: a hardware-backed device tier, exactly as CommonsProfile's
 * "Hardware-backed device" badge. It used to render whenever `identity_verification_level !==
 * 'none'`, which the relay sets for EVERY profile at join (`device_attested` /
 * `biometric_enrolled`), so every card carried a mark that proved nothing.
 * Source-level (the Vitest harness has no React renderer).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REGISTRY = readFileSync(resolve(__dirname, 'CommonsRegistry.tsx'), 'utf8');
const PROFILE = readFileSync(resolve(__dirname, 'CommonsProfile.tsx'), 'utf8');

/** The JSX guard (`{cond && (`) in front of each shield-checkmark render site. */
function shieldGuards(src: string): string[] {
  const guards: string[] = [];
  let at = src.indexOf('name="shield-checkmark"');
  while (at >= 0) {
    const before = src.slice(Math.max(0, at - 300), at);
    const m = [...before.matchAll(/\{([^{}]*?)\s*&&\s*\(\s*(?:<View[^>]*>\s*)?<Ionicons\s*$/g)].pop();
    guards.push(m ? m[1].trim() : '');
    at = src.indexOf('name="shield-checkmark"', at + 1);
  }
  return guards;
}

/** Violations: a shield mark not gated on the hardware-backed tier check. */
function violations(src: string): string[] {
  const g = shieldGuards(src);
  if (g.length === 0) return ['no shield-checkmark found (detector population empty)'];
  return g.filter((cond) => cond !== 'isHardwareBackedTier(profile)').map((cond) => `shield mark gated on {${cond}}`);
}

/** The tier list a source names for its hardware-backed check. */
function hardwareTiers(src: string): string[] {
  return [...src.matchAll(/'(hardware(?:_partial|_tpm|_full)?)'/g)].map((m) => m[1]).sort();
}

describe('Commons Registry verification mark', () => {
  it('every shield mark on a registry card is gated on the hardware-backed tier', () => {
    expect(violations(REGISTRY)).toEqual([]);
    expect(REGISTRY).not.toMatch(/identity_verification_level\s*!==\s*'none'/);
  });

  it('RED control: the old always-true guard is reported', () => {
    const old = `{profile.identity_verification_level !== 'none' && (\n                <Ionicons name="shield-checkmark" size={12} />\n              )}`;
    expect(violations(old)).toEqual(["shield mark gated on {profile.identity_verification_level !== 'none'}"]);
    expect(violations('<View />')).toEqual(['no shield-checkmark found (detector population empty)']);
  });

  it('names the same hardware tiers as the profile badge', () => {
    const start = REGISTRY.indexOf('const HARDWARE_BACKED_TIERS');
    const end = REGISTRY.indexOf('function isHardwareBackedTier');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const profileLine = PROFILE.split('\n').find((line) => line.includes("'hardware_partial'")) ?? '';
    expect(hardwareTiers(profileLine)).toEqual(['hardware', 'hardware_full', 'hardware_partial', 'hardware_tpm']);
    expect(hardwareTiers(REGISTRY.slice(start, end))).toEqual(hardwareTiers(profileLine));
  });
});
