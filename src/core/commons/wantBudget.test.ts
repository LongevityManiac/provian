/**
 * A want's max budget is typed in PVT and sent in PVT ATOMIC units (18 decimals) — the relay's unit for
 * `budget_max_pvt`, compared against a fulfiller's atomic `hourly_rate_pvt`. the operator typed "20.5" on
 * 2026-09-24 and the app sent it raw; the relay refused it and the form showed `budget_max_pvt_invalid`.
 * RED controls: the old behavior (send the typed text; show err.message) fails these.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseWantBudget, formatWantBudget, wantPostErrorKey } from './wantBudget';

const PVT = 10n ** 18n;
const RELAY_BUDGET_RE = /^[0-9]+$/; // provian-backend/src/core/commons/wants.ts::normalizeBudgetPvt

describe('parseWantBudget — PVT typed, atomic units sent', () => {
  it('converts decimal PVT to the exact atomic-unit string the relay accepts', () => {
    expect(parseWantBudget('20.5')).toEqual({ ok: true, atomic: (205n * PVT / 10n).toString() });
    expect(parseWantBudget('20')).toEqual({ ok: true, atomic: (20n * PVT).toString() });
    expect(parseWantBudget(' 0.000000000000000001 ')).toEqual({ ok: true, atomic: '1' });
    expect(parseWantBudget('20,5')).toEqual({ ok: true, atomic: (205n * PVT / 10n).toString() }); // decimal comma
  });

  it('RED: what the operator typed ("20.5") is NOT sent as typed — the old path sent the raw text, which the relay refuses', () => {
    const typed = '20.5';
    expect(RELAY_BUDGET_RE.test(typed)).toBe(false); // the old app sent budget.trim() → budget_max_pvt_invalid
    const parsed = parseWantBudget(typed);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.atomic).not.toBe(typed);
      expect(RELAY_BUDGET_RE.test(parsed.atomic ?? '')).toBe(true);
    }
  });

  it('RED: a whole number is scaled to atomic units, never sent as wei (the old path sent "20" = 20 wei)', () => {
    const parsed = parseWantBudget('20');
    expect(parsed.ok && parsed.atomic).toBe('20000000000000000000');
    expect(parsed.ok && parsed.atomic).not.toBe('20');
  });

  it('empty means no budget', () => {
    expect(parseWantBudget('')).toEqual({ ok: true, atomic: null });
    expect(parseWantBudget('   ')).toEqual({ ok: true, atomic: null });
  });

  it("RED : an absurdly long number is refused, never thrown (the screen parses on every render)", () => {
    const long = '9'.repeat(200);
    expect(() => parseWantBudget(long)).not.toThrow();
    expect(parseWantBudget(long)).toEqual({ ok: false });
  });

  it("RED : a thousands separator is refused, never read as a decimal comma", () => {
    expect(parseWantBudget('1,000')).toEqual({ ok: false }); // not 1 PVT
    expect(parseWantBudget('20,500')).toEqual({ ok: false });
    expect(parseWantBudget('1,5')).toEqual({ ok: true, atomic: (15n * PVT / 10n).toString() });
  });

  it('refuses anything that is not a positive PVT amount with at most 18 decimals', () => {
    for (const bad of ['0', '0.0', '-5', '+5', '1e3', 'abc', '20.', '.5', '1.2.3', '1.0000000000000000001', '20 PVT', '1,000.5']) {
      expect(parseWantBudget(bad)).toEqual({ ok: false });
    }
  });
});

describe('formatWantBudget — atomic units shown as PVT', () => {
  it('shows PVT, not the atomic string', () => {
    expect(formatWantBudget('20500000000000000000')).toBe('20.5');
    expect(formatWantBudget('20000000000000000000')).toBe('20');
  });
  it("RED : a budget below 0.01 PVT is shown exactly, never as \"0\"", () => {
    expect(formatWantBudget('1000000000000000')).toBe('0.001');
    expect(formatWantBudget('1')).toBe('0.000000000000000001');
  });
  it('shows nothing for no / malformed budgets', () => {
    expect(formatWantBudget(null)).toBeNull();
    expect(formatWantBudget(undefined)).toBeNull();
    expect(formatWantBudget('20.5')).toBeNull();
    expect(formatWantBudget('0')).toBeNull();
  });
});

describe('wantPostErrorKey — never a raw relay code', () => {
  const en = JSON.parse(readFileSync(resolve(__dirname, '../../i18n/locales/en.json'), 'utf8')) as Record<string, Record<string, string>>;
  const exists = (key: string) => {
    const [ns, k] = key.split('.');
    return typeof en[ns]?.[k] === 'string';
  };
  const err = (message: string, status = 400) => Object.assign(new Error(message), { status });

  it('maps each code the post form can receive to a translated message', () => {
    expect(wantPostErrorKey(err('budget_max_pvt_invalid'))).toBe('commons.wantBudgetInvalid');
    expect(wantPostErrorKey(err('outcome_required'))).toBe('commons.wantOutcomeInvalid');
    expect(wantPostErrorKey(err('outcome_too_long'))).toBe('commons.wantOutcomeInvalid');
    expect(wantPostErrorKey(err('capabilities_required'))).toBe('commons.wantCapabilitiesInvalid');
    expect(wantPostErrorKey(err('capabilities_invalid'))).toBe('commons.wantCapabilitiesInvalid');
    expect(wantPostErrorKey(err('capabilities_too_many'))).toBe('commons.wantCapabilitiesInvalid');
    expect(wantPostErrorKey(err('Rate limit exceeded', 429))).toBe('commons.wantRateLimited');
  });

  it('RED: an unknown code, a network error, or a non-Error falls back to the generic message — never the raw text', () => {
    for (const e of [err('some_new_relay_code'), err('Internal server error', 500), new TypeError('Network request failed'), 'boom', null, undefined]) {
      const key = wantPostErrorKey(e);
      expect(key).toBe('commons.wantPostFailed');
    }
  });

  it('every key it can return exists in en.json (parity carries it to all 12 locales)', () => {
    const keys = ['budget_max_pvt_invalid', 'outcome_required', 'capabilities_invalid', 'unknown']
      .map((c) => wantPostErrorKey(err(c)))
      .concat(wantPostErrorKey(err('x', 429)));
    expect(keys.length).toBe(5);
    for (const k of keys) expect(exists(k)).toBe(true);
  });
});
