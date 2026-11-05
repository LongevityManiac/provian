/**
 * item 4 — the owner's reply policy as the agent reads it. RED: a malformed policy is the
 * restrictive one, and "ask me first" never tells the agent to reply to a stranger directly.
 */
import { describe, it, expect } from 'vitest';
import { readReplyPolicy, replyPolicyInstruction, strangerNextStep } from './reply-policy';

describe('readReplyPolicy', () => {
  it('a relay without the field → null; the two modes read as sent', () => {
    expect(readReplyPolicy(undefined)).toBeNull();
    expect(readReplyPolicy(null)).toBeNull();
    expect(readReplyPolicy({ mode: 'answer_anyone', linked_human: 'user_frank' })).toEqual({ mode: 'answer_anyone', linked_human: 'user_frank' });
    expect(readReplyPolicy({ mode: 'ask_me_first', linked_human: 'user_frank' })).toEqual({ mode: 'ask_me_first', linked_human: 'user_frank' });
  });

  it('RED: anything else reads as ask_me_first (unknown = block)', () => {
    for (const raw of ['answer_anyone', 7, [], { mode: 'whatever' }, {}]) expect(readReplyPolicy(raw)?.mode).toBe('ask_me_first');
  });
});

describe('replyPolicyInstruction', () => {
  it('answer anyone: act on every message and reply with thread-send', () => {
    const text = replyPolicyInstruction({ mode: 'answer_anyone', linked_human: 'user_frank' }, false);
    expect(text).toContain('answer anyone');
    expect(text).toContain('thread-send');
    expect(replyPolicyInstruction(null, false)).toBe(text.replace(' (user_frank)', ''));
  });

  it('ask me first: reply only to the linked human, ask with request-approval (never the text), reply once approved', () => {
    const text = replyPolicyInstruction({ mode: 'ask_me_first', linked_human: 'user_frank' }, false);
    expect(text).toContain('Reply directly only to your linked human (user_frank)');
    expect(text).toContain('request-approval --for <ask_for> --description');
    expect(text).toContain('never the message text');
    for (const step of ['ask_first', 'waiting_for_approval', 'approved_reply_now', 'do_not_reply']) expect(text).toContain(step);
    expect(text).toContain('stays unread until you reply or it is declined');
    expect(text).not.toContain('Act on every message and reply');
  });
});

describe('strangerNextStep', () => {
  const at = 1_000;
  const a = (o: Partial<{ status: string; decision: 'approved' | 'rejected' | null; expires_at_ms: number }>) => ({ request_id: 'r', subject_pe_id: 'p', status: 'pending', decision: null, expires_at_ms: at + 1, ...o });
  it('maps each request state to one step; anything unreadable or lapsed is do_not_reply', () => {
    expect(strangerNextStep(null, at)).toBe('ask_first');
    expect(strangerNextStep(a({}), at)).toBe('waiting_for_approval');
    expect(strangerNextStep(a({ status: 'satisfied', decision: 'approved' }), at)).toBe('approved_reply_now');
    expect(strangerNextStep(a({ status: 'satisfied', decision: 'rejected' }), at)).toBe('do_not_reply');
    expect(strangerNextStep(a({ expires_at_ms: at }), at)).toBe('do_not_reply');
    expect(strangerNextStep(a({ status: 'expired' }), at)).toBe('do_not_reply');
    expect(strangerNextStep(a({ status: 'weird' }), at)).toBe('do_not_reply');
  });
});
