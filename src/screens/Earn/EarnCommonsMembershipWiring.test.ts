import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const hubSource = readFileSync(`${process.cwd()}/src/screens/Earn/EarnHubScreen.tsx`, 'utf8');
const detailSource = readFileSync(`${process.cwd()}/src/screens/Earn/EarnSurfaceDetailScreen.tsx`, 'utf8');

describe('Earn Commons membership wiring', () => {
  it('refreshes authenticated membership on both Earn surfaces', () => {
    expect(hubSource).toContain('refreshCommonsMembership()');
    expect(detailSource).toContain('refreshCommonsMembership()');
  });

  it('keeps an unresolved membership read in a neutral state', () => {
    expect(hubSource).toContain("commonsMembershipStatus !== 'unknown'");
    expect(detailSource).toContain("commonsMembershipStatus === 'unknown'");
  });
});
