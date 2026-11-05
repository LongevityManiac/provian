import { describe, it, expect } from '@jest/globals';
import { judgeReleaseFreshness, type ReleaseFreshnessFacts } from './release-freshness';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const fresh: ReleaseFreshnessFacts = {
  servedBundleSha256: A, localBundleSha256: A, releaseStatus: 200, releaseBundleSha256: A, publishedVersion: 58,
};

describe('judgeReleaseFreshness', () => {
  it('fresh: the served manifest names the served bundle', () => {
    expect(judgeReleaseFreshness(fresh)).toEqual({ state: 'fresh', version: 58 });
  });

  it('THE SHAPE: pending (409) with the disk bundle = served → stale, sign served version + 1', () => {
    const v = judgeReleaseFreshness({ ...fresh, releaseStatus: 409, releaseBundleSha256: null });
    expect(v).toMatchObject({ state: 'stale', signVersion: 59 });
  });

  it('no release at all (404) for the served bundle → stale', () => {
    expect(judgeReleaseFreshness({ ...fresh, releaseStatus: 404, releaseBundleSha256: null }).state).toBe('stale');
  });

  const blocked: Array<[string, Partial<ReleaseFreshnessFacts>]> = [
    ['served bundle unreadable', { servedBundleSha256: null }],
    ['release route unreachable', { releaseStatus: null }],
    ['release route 500', { releaseStatus: 500 }],
    ['a 200 naming another bundle', { releaseBundleSha256: B }],
    ['stale but the published version is unreadable', { releaseStatus: 409, publishedVersion: null }],
    ['stale but the disk bundle differs from the served one', { releaseStatus: 409, localBundleSha256: B }],
  ];
  it.each(blocked)('RED: %s is blocked, never fresh and never signed', (_label, patch) => {
    expect(judgeReleaseFreshness({ ...fresh, ...patch }).state).toBe('blocked');
  });
});
