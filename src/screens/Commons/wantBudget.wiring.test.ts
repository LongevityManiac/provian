/**
 * The wants "Post" form sends the budget in PVT atomic units (parsed from what the person typed) and
 * never shows a raw relay error code. Source-level (the Vitest harness has no React renderer).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WANTS = readFileSync(resolve(__dirname, 'CommonsWants.tsx'), 'utf8');

/** The body of `submitWant` (the post form's submit handler). */
function submitWantBody(src: string): string {
  const start = src.indexOf('const submitWant = async () => {');
  const end = src.indexOf('const feature = ', start);
  return start >= 0 && end > start ? src.slice(start, end) : '';
}

/** Violations: the typed text sent raw, or a raw error message shown. */
function violations(body: string): string[] {
  const v: string[] = [];
  if (/budget_max_pvt:\s*budget\b/.test(body)) v.push('sends the typed budget raw');
  if (/err\.message|\(err as Error\)\.message/.test(body)) v.push('shows a raw error message');
  return v;
}

describe('wants post form — budget unit + error copy', () => {
  it('RED: submitWant sends the parsed atomic budget and shows only translated errors', () => {
    const body = submitWantBody(WANTS);
    expect(body.length).toBeGreaterThan(100); // the handler was found — not an empty population
    expect(violations(body)).toEqual([]);
    expect(body).toContain('parseWantBudget(budget)');
    expect(body).toContain('budget_max_pvt: parsed.atomic');
    expect(body).toContain('t(wantPostErrorKey(err))');
    // validation runs before the biometric prompt
    expect(body.indexOf('parseWantBudget(budget)')).toBeLessThan(body.indexOf("gate(t('commons.biometricPromptWant'),"));
  });

  it('the detector catches the pre-fix handler (in-suite control)', () => {
    const old = `const submitWant = async () => {
      await CommonsService.postWant({ outcome: outcome.trim(), capabilities, ...(budget.trim() ? { budget_max_pvt: budget.trim() } : {}) });
    } catch (err) {
      Alert.alert(t('common.errorTitle'), err instanceof Error ? err.message : t('commons.wantPostFailed'));
    }
    const feature = (w) => w;`;
    expect(violations(submitWantBody(old))).toEqual(['sends the typed budget raw', 'shows a raw error message']);
  });

  it('the budget field is a decimal PVT field that blocks submit while invalid', () => {
    expect(WANTS).toContain('value={budget} onChangeText={setBudget} keyboardType="decimal-pad"');
    expect(WANTS).toContain("{!budgetParse.ok && <Text style={styles.fieldError}>{t('commons.wantBudgetInvalid')}</Text>}");
    expect(WANTS).toMatch(/disabled=\{busy \|\| !outcome\.trim\(\) \|\| !caps\.trim\(\) \|\| !budgetParse\.ok\}/);
  });

  it('the list shows the budget in PVT, not the atomic string', () => {
    expect(WANTS).toContain('formatWantBudget(w.budget_max_pvt)');
    expect(WANTS).not.toContain('${w.budget_max_pvt} PVT');
  });
});
