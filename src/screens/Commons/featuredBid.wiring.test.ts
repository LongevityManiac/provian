/**
 * a person's featured bid is the amount THEY enter (floor 15 PVT, no ceiling), on every app
 * surface that bids. Source-level (the Vitest harness has no React renderer).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const SRC = resolve(__dirname, '../..');
const WANTS = readFileSync(resolve(__dirname, 'CommonsWants.tsx'), 'utf8');
const MANAGE = readFileSync(resolve(__dirname, 'CommonsHumanJobManage.tsx'), 'utf8');
const SHEET = readFileSync(resolve(SRC, 'components/commons/FeaturedBidSheet.tsx'), 'utf8');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}

describe('featured bids take the person\'s amount ', () => {
  it('both bidding screens open the shared amount sheet and burn the entered amount', () => {
    expect(WANTS).toContain('<FeaturedBidSheet');
    expect(WANTS).toContain('spendBurn(amountPvt, (burnId, action) => CommonsService.featureWant(w.want_id, burnId, action))');
    expect(MANAGE).toContain('<FeaturedBidSheet');
    expect(MANAGE).toContain('spendBurn(amountPvt, (burnId, action) => CommonsService.featureHumanJob(jobId, burnId, action))');
  });

  it('RED: the job screen re-reads the job and burns nothing for a job that is no longer open (Feature/Accept race)', () => {
    const recheck = MANAGE.indexOf("if (fresh.status !== 'open')");
    const burn = MANAGE.indexOf('spendBurn(amountPvt, (burnId, action) => CommonsService.featureHumanJob(jobId, burnId, action))');
    expect(recheck).toBeGreaterThan(-1);
    expect(burn).toBeGreaterThan(recheck); // the check precedes the burn
    expect(MANAGE.slice(recheck, burn)).toContain("t('commonsJobs.featureNotOpen')");
    expect(MANAGE.slice(recheck, burn)).toContain('return;');
  });

  it('the sheet validates through parseFeaturedBid and confirms the parsed amount only', () => {
    expect(SHEET).toContain('parseFeaturedBid(amount)');
    expect(SHEET).toContain('onConfirm(parsed.pvt)');
    expect(SHEET).toContain('disabled={!parsed.ok || busy}');
    expect(SHEET).toContain('keyboardType="decimal-pad"');
  });

  it('RED: no app source hardcodes a featured bid amount', () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(100); // not an empty population
    const offenders: string[] = [];
    for (const f of files) {
      const s = readFileSync(f, 'utf8');
      if (/FEATURED_FLOOR_PVT/.test(s)) offenders.push(f);
      for (const m of s.matchAll(/spendBurn\(([^,]+),\s*\(burnId(?:,\s*action)?\)\s*=>\s*CommonsService\.feature/g)) {
        if (m[1].trim() !== 'amountPvt') offenders.push(`${f}: spendBurn(${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
    // the detector itself: a fixed-amount bid is caught.
    const planted = "spendBurn('15', (burnId) => CommonsService.featureWant(id, burnId))";
    expect([...planted.matchAll(/spendBurn\(([^,]+),\s*\(burnId(?:,\s*action)?\)\s*=>\s*CommonsService\.feature/g)].map((m) => m[1])).toEqual(["'15'"]);
  });
});
