/**
 * pendingSpeech (§4) — "say it, open the pass, and it goes through on its own".
 *
 * When a Commons write (post, reply, vote, report…) comes back 428 `rail_handshake_required`, the
 * screen saves what the person was doing here, opens the ONE talking-pass sheet, and sends them to
 * HumanPresentment to open the pass. When the screen regains focus it calls `resumePendingSpeech`,
 * which re-executes the saved action exactly once:
 * - success → done (the pass is now known to be live);
 * - 428 again → the person backed out without opening the pass → dropped SILENTLY (no second
 * prompt, never a loop);
 * - any other error → reported to the caller.
 *
 * The saved action lives in memory (a navigation round trip, not an app restart). The draft TEXT of a
 * post or reply is also written to AsyncStorage (non-sensitive: it is about to be public) so it is
 * never lost. Nothing here burns: the pass is opened only on the HumanPresentment screen.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { speechWindowRequired } from './speechGate';
import { noteTalkingPassRefused, noteTalkingPassUsed } from './talkingPassBus';

export type PendingSpeechKind = 'post' | 'reply' | 'vote' | 'flag' | 'challenge';

/** JSON-safe payload (the exact arguments of the write that was refused). */
export type PendingPayload = Record<string, string | number | boolean | null>;

export interface PendingSpeech {
  kind: PendingSpeechKind;
  /** The screen that resumes it, e.g. `post:<rootId>`, `compose:<channel>`, `feed`. */
  owner: string;
  payload: PendingPayload;
  /** Who the pass is for ('provian:commons' for the forum). */
  audience: string;
  /** AsyncStorage key of the draft text, when there is one. */
  draftKey?: string;
  savedAt: number;
  /** True once the person chose "Start talking" (went to open the pass). Only an armed action resumes. */
  armed: boolean;
}

/** A saved action older than this is not resumed (the person has moved on). */
export const PENDING_SPEECH_TTL_MS = 30 * 60_000;

const DRAFT_PREFIX = '@provian_forum_draft_v1:';

let pending: PendingSpeech | null = null;

export function draftStorageKey(key: string): string {
  return `${DRAFT_PREFIX}${key}`;
}

export async function saveDraft(key: string, text: string): Promise<void> {
  try {
    if (text.trim()) await AsyncStorage.setItem(draftStorageKey(key), text);
    else await AsyncStorage.removeItem(draftStorageKey(key));
  } catch {
    /* best effort: a draft is a convenience */
  }
}

export async function loadDraft(key: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(draftStorageKey(key));
  } catch {
    return null;
  }
}

export async function clearDraft(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(draftStorageKey(key));
  } catch {
    /* best effort */
  }
}

/**
 * If `err` is the talking-pass refusal, save the intended action (and its draft) and return the
 * audience the pass is for; otherwise return null and save nothing.
 */
export function capturePendingSpeech(
  err: unknown,
  action: { kind: PendingSpeechKind; owner: string; payload: PendingPayload; draftKey?: string; draft?: string },
  now: number = Date.now(),
): string | null {
  const audience = speechWindowRequired(err);
  if (!audience) return null;
  noteTalkingPassRefused(now);
  pending = { kind: action.kind, owner: action.owner, payload: action.payload, audience, draftKey: action.draftKey, savedAt: now, armed: false };
  if (action.draftKey && action.draft !== undefined) void saveDraft(action.draftKey, action.draft);
  return audience;
}

/**
 * Save an action BEFORE trying it, when the pass is already known to be missing (e.g. a challenge,
 * whose stake burn should not happen before the pass exists).
 */
export function savePendingSpeech(
  action: { kind: PendingSpeechKind; owner: string; payload: PendingPayload; draftKey?: string; draft?: string },
  audience: string,
  now: number = Date.now(),
): void {
  pending = { kind: action.kind, owner: action.owner, payload: action.payload, audience, draftKey: action.draftKey, savedAt: now, armed: false };
  if (action.draftKey && action.draft !== undefined) void saveDraft(action.draftKey, action.draft);
}

/** The person chose "Start talking": the saved action will resume when its screen regains focus. */
export function armPendingSpeech(): void {
  if (pending) pending = { ...pending, armed: true };
}

/** The person closed the sheet: forget the saved action (the draft text stays in its field). */
export function cancelPendingSpeech(): void {
  pending = null;
}

export function peekPendingSpeech(): PendingSpeech | null {
  return pending;
}

export type ResumeOutcome =
  | { status: 'none' }
  | { status: 'expired'; pending: PendingSpeech }
  | { status: 'done'; pending: PendingSpeech }
  | { status: 'dropped'; pending: PendingSpeech }
  | { status: 'failed'; pending: PendingSpeech; error: unknown };

/**
 * Re-execute the saved action for `owner`, once. The action is taken out of the slot BEFORE it runs,
 * so a second focus event (or a second call racing the first) finds nothing to do.
 */
export async function resumePendingSpeech(
  owner: string,
  execute: (p: PendingSpeech) => Promise<void>,
  now: number = Date.now(),
): Promise<ResumeOutcome> {
  const p = pending;
  if (!p || p.owner !== owner || !p.armed) return { status: 'none' };
  pending = null;
  if (now - p.savedAt > PENDING_SPEECH_TTL_MS) return { status: 'expired', pending: p };
  try {
    await execute(p);
    noteTalkingPassUsed(now);
    return { status: 'done', pending: p };
  } catch (err) {
    if (speechWindowRequired(err)) {
      noteTalkingPassRefused(now);
      return { status: 'dropped', pending: p };
    }
    return { status: 'failed', pending: p, error: err };
  }
}

/** Test-only. */
export function __resetPendingSpeechForTests(): void {
  pending = null;
}
