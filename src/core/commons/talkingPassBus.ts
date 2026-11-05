/**
 * talkingPassBus (§4) — the app-wide wiring for the ONE talking-pass sheet.
 *
 * The "talking pass" is the speech window: one burn opens seven days of Commons speech. The
 * sheet that explains it is a single host mounted once at the navigator root (`TalkingPassHost`);
 * any screen asks it to open through `presentTalkingPass`. When no host is mounted (tests, or a
 * screen rendered outside the navigator) the call reports false and the caller falls back.
 *
 * This module also caches the caller's pass status (`GET /v1/commons/speech-window`) for the header
 * pill, and lets a 428 or a successful resumed write update that cache without a round trip.
 * No React and no network here — the fetcher is injected.
 */

export interface TalkingPassRequest {
  /** 'provian:commons' or a wallet id (a pass to reach one person). */
  audience: string;
  /** Called after the sheet has fully closed, when the person chose to start talking. */
  onStart: () => void;
  /** Called when the person closed the sheet without starting. */
  onCancel?: () => void;
}

type Presenter = (req: TalkingPassRequest) => void;
let presenter: Presenter | null = null;

/** The host registers itself on mount; the returned function unregisters (only if still current). */
export function registerTalkingPassPresenter(fn: Presenter): () => void {
  presenter = fn;
  return () => {
    if (presenter === fn) presenter = null;
  };
}

/** Open the talking-pass sheet. False when no host is mounted — the caller must fall back. */
export function presentTalkingPass(req: TalkingPassRequest): boolean {
  if (!presenter) return false;
  presenter(req);
  return true;
}

// ─── Status cache ────────────────────────────────────────────────────────────

export type TalkingPassState =
  | { state: 'live'; expiresAt: number | null }
  | { state: 'none' }
  /** The relay has no status route or the read failed and nothing was learned yet. */
  | { state: 'unknown' };

interface Cached {
  value: TalkingPassState;
  at: number;
}

let cached: Cached | null = null;
let inflight: Promise<TalkingPassState> | null = null;
const listeners = new Set<(s: TalkingPassState) => void>();

/** How long a fetched status is trusted before the pill reads it again. */
export const TALKING_PASS_CACHE_MS = 60_000;

function publish(value: TalkingPassState, now: number): void {
  cached = { value, at: now };
  for (const l of listeners) l(value);
}

export function subscribeTalkingPass(listener: (s: TalkingPassState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function peekTalkingPass(): TalkingPassState {
  return cached?.value ?? { state: 'unknown' };
}

/**
 * Read the pass status, from cache when fresh. `fetcher` resolves the relay read, or null when the
 * relay has no such route (a 404 on a pre- relay) — which keeps whatever a 428 taught us.
 * A pass whose expiry has passed reads as 'none' without a fetch.
 */
export async function readTalkingPass(
  fetcher: () => Promise<{ live: boolean; expires_at: number | null } | null>,
  opts: { force?: boolean; now?: number } = {},
): Promise<TalkingPassState> {
  const now = opts.now ?? Date.now();
  if (cached && !opts.force && now - cached.at < TALKING_PASS_CACHE_MS) {
    const v = cached.value;
    if (v.state === 'live' && v.expiresAt !== null && v.expiresAt <= now) {
      publish({ state: 'none' }, now);
      return { state: 'none' };
    }
    return v;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetcher();
      if (r === null) {
        const keep = cached?.value ?? { state: 'unknown' as const };
        publish(keep, now);
        return keep;
      }
      const live = r.live === true && (r.expires_at === null || r.expires_at > now);
      const value: TalkingPassState = live ? { state: 'live', expiresAt: r.expires_at } : { state: 'none' };
      publish(value, now);
      return value;
    } catch {
      return cached?.value ?? { state: 'unknown' };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** A write came back 428: there is no live pass. */
export function noteTalkingPassRefused(now: number = Date.now()): void {
  publish({ state: 'none' }, now);
}

/** A write went through: a pass is live (expiry unknown until the next read). */
export function noteTalkingPassUsed(now: number = Date.now()): void {
  const v = cached?.value;
  if (v?.state === 'live') return;
  publish({ state: 'live', expiresAt: null }, now);
}

/** Test-only: forget everything. */
export function __resetTalkingPassBusForTests(): void {
  presenter = null;
  cached = null;
  inflight = null;
  listeners.clear();
}
