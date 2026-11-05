/**
 * Inside the Commons tabs (the `embedded` boards) "Post a job" / "Post a request" sit INLINE at the top
 * of the list. They used to float just above the floating tab bar, covering whichever card scrolled under
 * them. The floating button stays only on the standalone screens (no tab bar there).
 * Source-level (the Vitest harness has no React renderer).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const JOBS = readFileSync(resolve(__dirname, 'CommonsHumanJobs.tsx'), 'utf8');
const WANTS = readFileSync(resolve(__dirname, 'CommonsWants.tsx'), 'utf8');

/** Each `style={...styles.fab...}` site, with the condition that renders it (the JSX `{cond && (` just before). */
function fabGuards(src: string): string[] {
  const guards: string[] = [];
  let at = src.indexOf('styles.fab');
  while (at >= 0) {
    if (!src.slice(at, at + 12).startsWith('styles.fabT')) {
      const before = src.slice(Math.max(0, at - 400), at);
      const m = [...before.matchAll(/\{([^{}]*?)\s*&&\s*\(\s*<TouchableOpacity/g)].pop();
      guards.push(m ? m[1].trim() : '');
    }
    at = src.indexOf('styles.fab', at + 1);
  }
  return guards;
}

/** Violations: a floating button a tab (embedded) board can render. */
function violations(src: string): string[] {
  const g = fabGuards(src);
  if (g.length === 0) return ['no floating button found (detector population empty)'];
  return g.filter((cond) => !/!embedded\b/.test(cond)).map((cond) => `floating button renders in a tab: {${cond} && …}`);
}

describe('Commons post buttons never float over a tab list', () => {
  it('RED: the floating button renders only when NOT embedded, on both boards', () => {
    expect(violations(JOBS)).toEqual([]);
    expect(violations(WANTS)).toEqual([]);
  });

  it('the tab boards render the inline button instead', () => {
    expect(JOBS).toContain("<InlinePostButton label={t('commonsHome.postJob')} onPress={() => navigation.navigate('CommonsHumanJobsPost')}");
    expect(WANTS).toMatch(/\{profile && embedded && \(\s*<InlinePostButton label=\{t\('commonsHome\.postRequest'\)\} onPress=\{\(\) => setShowPost\(true\)\}/);
  });

  it('the detector catches the pre-fix floating button (in-suite control)', () => {
    const old = `{profile?.participant_type === 'human' && (
        <TouchableOpacity
          style={[styles.fab, embedded && { bottom: 112 }]}`;
    expect(violations(old)).toEqual(["floating button renders in a tab: {profile?.participant_type === 'human' && …}"]);
    expect(violations('no button here')).toEqual(['no floating button found (detector population empty)']);
  });
});
