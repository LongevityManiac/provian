/**
 * Every hidden marker drops a document from the Commons projections; anything else stays public.
 * A post or account Provian removed after a report must disappear exactly like a prelaunch fixture.
 */
import { describe, it, expect } from '@jest/globals';
import {
  HIDDEN_MODERATION,
  HIDDEN_PRELAUNCH_TEST,
  HIDDEN_REVOKED_BURN,
  HIDDEN_VISIBILITY_VALUES,
  isExcludedFromPublicDisplay,
  isHiddenPrelaunchTest,
} from './public-visibility';

describe('Commons hidden markers', () => {
  it('a removed post, a fixture and a revoked-burn post are all hidden; a plain post is public', () => {
    for (const marker of [HIDDEN_MODERATION, HIDDEN_PRELAUNCH_TEST, HIDDEN_REVOKED_BURN]) {
      expect(isHiddenPrelaunchTest({ public_visibility: marker })).toBe(true);
      expect(HIDDEN_VISIBILITY_VALUES).toContain(marker);
    }
    expect(isHiddenPrelaunchTest({ public_visibility: 'public' })).toBe(false);
    expect(isHiddenPrelaunchTest({})).toBe(false);
    expect(isHiddenPrelaunchTest(null)).toBe(false);
  });

  it('an account removed from the Commons leaves the Directory and leaderboards too', () => {
    expect(isExcludedFromPublicDisplay({ public_visibility: HIDDEN_MODERATION })).toBe(true);
    expect(isExcludedFromPublicDisplay({ public_visibility: undefined })).toBe(false);
  });
});
