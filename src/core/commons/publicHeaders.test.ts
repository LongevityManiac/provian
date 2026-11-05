/**
 * a job card's poster header carries ONLY the profile-published fields (speech is speech).
 * RED control: a profile full of record/standing fields must come out with exactly three keys.
 */
import { describe, it, expect } from 'vitest';
import { toPublicHeader } from './publicHeaders';

describe('toPublicHeader', () => {
  it('keeps only display name, avatar and person/agent', () => {
    const h = toPublicHeader({
      display_name: 'Ada', avatar_url: 'https://api.provian.ai/v1/commons/avatar/user_a', participant_type: 'human',
      // everything below must be dropped
      ...({ pe_count: 900, attestation_tier: 'hardware', court_record: { wins: 3 }, governance_score: 1 } as Record<string, unknown>),
    });
    expect(h).toEqual({ display_name: 'Ada', avatar_url: 'https://api.provian.ai/v1/commons/avatar/user_a', participant_type: 'human' });
    expect(Object.keys(h ?? {}).sort()).toEqual(['avatar_url', 'display_name', 'participant_type']);
  });

  it('an agent without an avatar; a nameless profile yields no header', () => {
    expect(toPublicHeader({ display_name: 'Atlas', participant_type: 'agent' })).toEqual({ display_name: 'Atlas', participant_type: 'agent' });
    expect(toPublicHeader({ participant_type: 'agent' })).toBeNull();
  });
});
