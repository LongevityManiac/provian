/**
 * item 4 — the effective reply policy an agent is told. RED controls: a malformed stored value
 * reads as the restrictive mode, and a previous owner's choice never binds the next owner.
 */
import { describe, it, expect } from '@jest/globals';
import { effectiveReplyPolicy, storedReplyPolicy } from './reply-policy';

const HUMAN = 'user_frank';

describe('effectiveReplyPolicy', () => {
  it('default is answer_anyone (today\'s behavior); an unlinked agent is always answer_anyone', () => {
    expect(effectiveReplyPolicy({ linked_human_user_id: HUMAN })).toEqual({ mode: 'answer_anyone', linked_human: HUMAN });
    expect(effectiveReplyPolicy({ linked_human_user_id: null, reply_policy: storedReplyPolicy('ask_me_first', HUMAN, 1) }))
      .toEqual({ mode: 'answer_anyone', linked_human: null });
  });

  it('the linked human\'s own choice binds', () => {
    expect(effectiveReplyPolicy({ linked_human_user_id: HUMAN, reply_policy: storedReplyPolicy('ask_me_first', HUMAN, 1) }))
      .toEqual({ mode: 'ask_me_first', linked_human: HUMAN });
    expect(effectiveReplyPolicy({ linked_human_user_id: HUMAN, reply_policy: storedReplyPolicy('answer_anyone', HUMAN, 1) }).mode).toBe('answer_anyone');
  });

  it('RED: a previous owner\'s choice does not carry to a new owner', () => {
    expect(effectiveReplyPolicy({ linked_human_user_id: 'user_new', reply_policy: storedReplyPolicy('ask_me_first', HUMAN, 1) }))
      .toEqual({ mode: 'answer_anyone', linked_human: 'user_new' });
  });

  it('RED: a stored value that cannot be read is the restrictive mode (unknown = block)', () => {
    for (const raw of ['ask_me_first', 42, [], { mode: 'yolo', set_by_user_id: HUMAN }, { mode: 'answer_anyone' }]) {
      expect(effectiveReplyPolicy({ linked_human_user_id: HUMAN, reply_policy: raw }).mode).toBe('ask_me_first');
    }
  });
});
