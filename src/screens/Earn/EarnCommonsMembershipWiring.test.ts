import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const hubSource = readFileSync(`${process.cwd()}/src/screens/Earn/EarnHubScreen.tsx`, 'utf8');
const connections = readFileSync(`${process.cwd()}/src/core/earn/earningConnections.ts`, 'utf8');
const detailSource = readFileSync(`${process.cwd()}/src/screens/Earn/EarnSurfaceDetailScreen.tsx`, 'utf8');

describe('Earn Commons membership wiring', () => {
  it('refreshes authenticated membership on both Earn surfaces', () => {
    expect(hubSource).toContain('refreshEarningConnections(address)');
    expect(connections).toContain('useCommonsStore.getState().refreshMembership()');
    expect(detailSource).toContain('refreshCommonsMembership()');
  });

  it('keeps an unresolved membership read in a neutral state', () => {
    expect(connections).toContain("if (joined === null) throw new Error('Could not check Commons membership');");
    expect(detailSource).toContain("commonsMembershipStatus === 'unknown'");
  });
});
