/**
 * Wave J Step 4.7 - Tier 3 strip-pass enforcement.
 *
 * Verifies stripTier3Fields:
 *  - removes every TIER_3_FIELDS key at any nesting depth
 *  - leaves non-TIER 3 keys untouched
 *  - traverses arrays
 *  - returns the input unchanged for non-object values
 */

import { describe, it, expect } from '@jest/globals';
import { stripTier3Fields, TIER_3_FIELDS } from './publication';

describe('stripTier3Fields', () => {
  it('removes top-level Tier 3 fields', () => {
    const out = stripTier3Fields({
      private_key: 'leaked',
      session_token: 'leaked',
      api_key: 'leaked',
      kill_switch: false,
      wallet_balance: '100',
      display_name: 'Atlas',
      pe_count: 42,
    });
    expect(out).toEqual({ display_name: 'Atlas', pe_count: 42 });
  });

  it('removes nested Tier 3 fields', () => {
    const out: any = stripTier3Fields({
      profile: {
        name: 'Atlas',
        secret: 'should-not-appear',
        meta: { telemetry: { foo: 'bar' }, public: true },
      },
    });
    expect(out.profile.secret).toBeUndefined();
    expect(out.profile.meta.telemetry).toBeUndefined();
    expect(out.profile.meta.public).toBe(true);
    expect(out.profile.name).toBe('Atlas');
  });

  it('traverses arrays', () => {
    const out: any = stripTier3Fields({
      items: [
        { id: '1', credential: 'leaked', label: 'a' },
        { id: '2', api_key: 'leaked', label: 'b' },
      ],
    });
    expect(out.items[0].credential).toBeUndefined();
    expect(out.items[0].label).toBe('a');
    expect(out.items[1].api_key).toBeUndefined();
    expect(out.items[1].label).toBe('b');
  });

  it('passes scalar values through unchanged', () => {
    expect(stripTier3Fields(null)).toBeNull();
    expect(stripTier3Fields(42)).toBe(42);
    expect(stripTier3Fields('hello')).toBe('hello');
    expect(stripTier3Fields(true)).toBe(true);
  });

  it('removes every key in TIER_3_FIELDS from the same payload', () => {
    const payload: Record<string, unknown> = { harmless: 'ok' };
    for (const key of TIER_3_FIELDS) {
      payload[key] = 'sensitive';
    }
    const out = stripTier3Fields(payload) as Record<string, unknown>;
    expect(out.harmless).toBe('ok');
    for (const key of TIER_3_FIELDS) {
      expect(out[key]).toBeUndefined();
    }
  });

  it('does not mutate the input', () => {
    const input = { policy_config: { foo: 1 }, name: 'Atlas' };
    const out = stripTier3Fields(input) as Record<string, unknown>;
    expect(input.policy_config).toEqual({ foo: 1 });
    expect(out.policy_config).toBeUndefined();
  });
});
