/**
 * §4 — the talking-pass resume: a saved action runs once when its screen regains focus, a
 * second 428 drops it silently (no loop), and nothing resumes unless the person chose to start.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommonsError } from './CommonsService';
import {
  __resetPendingSpeechForTests,
  armPendingSpeech,
  cancelPendingSpeech,
  capturePendingSpeech,
  peekPendingSpeech,
  PENDING_SPEECH_TTL_MS,
  resumePendingSpeech,
} from './pendingSpeech';
import { __resetTalkingPassBusForTests, peekTalkingPass, presentTalkingPass, readTalkingPass, registerTalkingPassPresenter } from './talkingPassBus';
import { offerSpeechWindow } from './speechGate';

const refusal = () => new CommonsError('talking pass required', 428, 'rail_handshake_required', 'provian:commons');
const action = { kind: 'vote' as const, owner: 'feed', payload: { postId: 'p1', vote: 'upvote' } };

beforeEach(() => {
  __resetPendingSpeechForTests();
  __resetTalkingPassBusForTests();
});

describe('capturePendingSpeech', () => {
  it('saves the action for a 428 and returns the audience', () => {
    expect(capturePendingSpeech(refusal(), action, 1000)).toBe('provian:commons');
    expect(peekPendingSpeech()).toMatchObject({ kind: 'vote', owner: 'feed', armed: false });
    expect(peekTalkingPass()).toEqual({ state: 'none' });
  });
  it('RED: any other error saves nothing', () => {
    expect(capturePendingSpeech(new CommonsError('nope', 400), action)).toBeNull();
    expect(capturePendingSpeech(new CommonsError('gone', 428, 'other_reason'), action)).toBeNull();
    expect(capturePendingSpeech(new Error('boom'), action)).toBeNull();
    expect(peekPendingSpeech()).toBeNull();
  });
});

describe('resumePendingSpeech', () => {
  it('runs the armed action exactly once for its owner', async () => {
    capturePendingSpeech(refusal(), action, 1000);
    armPendingSpeech();
    const exec = vi.fn(async () => undefined);
    const [a, b] = await Promise.all([resumePendingSpeech('feed', exec, 2000), resumePendingSpeech('feed', exec, 2000)]);
    expect(exec).toHaveBeenCalledTimes(1);
    expect([a.status, b.status].sort()).toEqual(['done', 'none']);
    expect(peekTalkingPass()).toEqual({ state: 'live', expiresAt: null });
  });
  it('RED: a second 428 drops the action silently (never loops the prompt)', async () => {
    capturePendingSpeech(refusal(), action, 1000);
    armPendingSpeech();
    const exec = vi.fn(async () => { throw refusal(); });
    const out = await resumePendingSpeech('feed', exec, 2000);
    expect(out.status).toBe('dropped');
    expect(peekPendingSpeech()).toBeNull();
    expect((await resumePendingSpeech('feed', exec, 3000)).status).toBe('none');
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it('RED: an un-armed action (sheet dismissed / unrelated focus) does not run', async () => {
    capturePendingSpeech(refusal(), action, 1000);
    const exec = vi.fn(async () => undefined);
    expect((await resumePendingSpeech('feed', exec, 2000)).status).toBe('none');
    expect(exec).not.toHaveBeenCalled();
    cancelPendingSpeech();
    armPendingSpeech();
    expect((await resumePendingSpeech('feed', exec, 2000)).status).toBe('none');
    expect(exec).not.toHaveBeenCalled();
  });
  it('RED: another screen cannot resume it', async () => {
    capturePendingSpeech(refusal(), action, 1000);
    armPendingSpeech();
    const exec = vi.fn(async () => undefined);
    expect((await resumePendingSpeech('post:xyz', exec, 2000)).status).toBe('none');
    expect(exec).not.toHaveBeenCalled();
    expect(peekPendingSpeech()).not.toBeNull();
  });
  it('an expired action is not run', async () => {
    capturePendingSpeech(refusal(), action, 1000);
    armPendingSpeech();
    const exec = vi.fn(async () => undefined);
    expect((await resumePendingSpeech('feed', exec, 1000 + PENDING_SPEECH_TTL_MS + 1)).status).toBe('expired');
    expect(exec).not.toHaveBeenCalled();
  });
  it('reports a non-428 failure to the caller', async () => {
    capturePendingSpeech(refusal(), action, 1000);
    armPendingSpeech();
    const out = await resumePendingSpeech('feed', async () => { throw new Error('Rate limited'); }, 2000);
    expect(out.status).toBe('failed');
  });
});

describe('talking-pass bus', () => {
  it('presentTalkingPass is false with no host, true with one', () => {
    const req = { audience: 'provian:commons', onStart: () => undefined };
    expect(presentTalkingPass(req)).toBe(false);
    const seen: string[] = [];
    const off = registerTalkingPassPresenter((r) => seen.push(r.audience));
    expect(presentTalkingPass(req)).toBe(true);
    off();
    expect(presentTalkingPass(req)).toBe(false);
    expect(seen).toEqual(['provian:commons']);
  });
  it('offerSpeechWindow uses the sheet when no caller Modal is open, else falls back', () => {
    const shown: string[] = [];
    registerTalkingPassPresenter((r) => shown.push(r.audience));
    const nav = { navigate: vi.fn() };
    const t = ((k: string) => k) as unknown as Parameters<typeof offerSpeechWindow>[2];
    expect(offerSpeechWindow(refusal(), nav, t)).toBe(true);
    expect(shown).toEqual(['provian:commons']);
    expect(offerSpeechWindow(refusal(), nav, t, () => undefined)).toBe(true); // Alert fallback
    expect(shown).toHaveLength(1);
    expect(offerSpeechWindow(new Error('x'), nav, t)).toBe(false);
  });
  it('reads the status once within the cache window; a 404 keeps what a 428 taught', async () => {
    const fetcher = vi.fn(async () => ({ live: true, expires_at: 10_000 }));
    expect(await readTalkingPass(fetcher, { now: 1000 })).toEqual({ state: 'live', expiresAt: 10_000 });
    expect(await readTalkingPass(fetcher, { now: 2000 })).toEqual({ state: 'live', expiresAt: 10_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    // past expiry → none, without a fetch
    expect(await readTalkingPass(fetcher, { now: 10_001 })).toEqual({ state: 'none' });
    __resetTalkingPassBusForTests();
    expect(await readTalkingPass(async () => null, { now: 1 })).toEqual({ state: 'unknown' });
  });
});
