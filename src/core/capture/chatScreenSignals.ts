/**
 * The chat screen's rules for which signals count, kept pure so they can be tested.
 *
 * - Signing in to a provider is not a chat. A sign-in page (its own host, or a sign-in path on
 *   the provider's host) is not the provider's chat surface, and the keyboard does not count
 *   while a sign-in form is on screen.
 * - Only the app coming back to the foreground revives a session. A page navigation that fires
 *   while the app is in the background (Android delivers them) records the URL but does not
 *   tell the session the chat is on screen.
 */

import type { MachineInput, ProviderContext } from './MobileSessionStateMachine';
import type { TurnWatcherMessage } from './turnMarkers';

const AUTH_HOSTS: readonly RegExp[] = [
    /^auth\.openai\.com$/,
    /^auth0\.openai\.com$/,
    /^accounts\.x\.ai$/,
    /^accounts\.google\.com$/,
    /^appleid\.apple\.com$/,
    /^login\.[a-z0-9.-]+$/,
    /^auth\.[a-z0-9.-]+$/,
];

const AUTH_PATH = /^\/(?:auth|login|log-in|signin|sign-in|signup|sign-up|oauth|oauth2|magic-link|verify|i\/flow\/login|i\/oauth2|i\/jf\/onboarding)(?:[/?#]|$)/i;

/** True for a provider sign-in page: never the provider's chat surface. */
export function isAuthUrl(url: string): boolean {
    const m = /^https?:\/\/([^/?#:]+)(?::\d+)?([^?#]*)/i.exec(url);
    if (!m) return false;
    const host = m[1].toLowerCase();
    const path = m[2] || '/';
    if (AUTH_HOSTS.some(re => re.test(host))) return true;
    return AUTH_PATH.test(path);
}

/** Whether a keyboard open is engagement: not on a sign-in page or over a sign-in form. */
export function keyboardCounts(input: { url: string | null; authFormVisible: boolean }): boolean {
    if (input.authFormVisible) return false;
    if (input.url && isAuthUrl(input.url)) return false;
    return true;
}

/** The path part of a URL, as the page's `location.pathname` reports it. */
export function pathOfUrl(url: string): string {
    const m = /^https?:\/\/[^/?#]+([^?#]*)/i.exec(url);
    return m && m[1] ? m[1] : '/';
}

/** Whether a WebView navigation may tell the session the chat is on screen. */
export function navigationMayRevive(appState: string | null | undefined): boolean {
    return appState === 'active';
}

// --- what each screen event does to the session, as pure decisions -----------------------------


export interface WatcherMessageEffect {
    /** Feed the session machine. */
    step: MachineInput | null;
    /** New value of "a sign-in form is on screen", if the message says. */
    authFormVisible?: boolean;
    /** A marker verdict to forward to the relay. */
    markerVerdict?: Extract<TurnWatcherMessage, { t: 'marker_health' }>;
    /** The page's verdict on a path change: did it create that thread or open an existing one. */
    pathVerdict?: { path: string; created: boolean };
    /** Engagement on screen: the "turn the microphone back on" offer is no longer needed. */
    hideRestoreVoice: boolean;
}

/** A new turn is engagement only while the app is on screen. */
export function effectOfWatcherMessage(
    msg: TurnWatcherMessage,
    appState: string | null | undefined,
    now: number,
): WatcherMessageEffect {
    if (msg.t === 'turns_added') {
        if (appState !== 'active') return { step: null, hideRestoreVoice: false };
        return { step: { t: 'input_event', ts: now }, hideRestoreVoice: true };
    }
    if (msg.t === 'auth_page') return { step: null, authFormVisible: msg.visible, hideRestoreVoice: false };
    if (msg.t === 'path_change') return { step: null, pathVerdict: { path: msg.path, created: msg.created }, hideRestoreVoice: false };
    return { step: null, markerVerdict: msg, hideRestoreVoice: false };
}

/** A keyboard open is engagement only on a chat page with no sign-in form, app on screen. */
export function stepForKeyboard(
    input: { url: string | null; authFormVisible: boolean; appState: string | null | undefined },
    now: number,
): MachineInput | null {
    if (input.appState !== 'active') return null;
    if (!keyboardCounts({ url: input.url, authFormVisible: input.authFormVisible })) return null;
    return { t: 'input_event', ts: now };
}

/** A WebView navigation tells the session what is on screen only while the app is on screen. */
export function stepForNavigation(
    providerContext: ProviderContext | null,
    appState: string | null | undefined,
    now: number,
): MachineInput | null {
    if (!navigationMayRevive(appState)) return null;
    return { t: 'foreground_changed', ts: now, providerContext };
}

/** How long a move off a fresh chat waits for the page's verdict before it counts as "opened". */
export const PATH_VERDICT_WAIT_MS = 1_500;

export interface NavigationGateDeps {
    step: (input: MachineInput) => void;
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (handle: unknown) => void;
}

/**
 * Feeds navigations to the session machine. A move from a fresh chat (no thread id) to a thread
 * on the same provider is held until the page says whether it created that thread or opened an
 * existing one, so the machine adopts the id only for a chat being created. With no verdict in
 * time, it is treated as opening an existing thread (the machine starts a new conversation).
 *
 * - Repeats of the held move (the WebView reports every history call, often several for one
 *   URL) are ignored; anything else that happens while a move is held queues behind it, so the
 *   machine always sees events in order.
 * - A null context (app in the background, or a page that is not the provider's chat) never
 *   erases the last chat page seen, so the replay when the app comes back is judged against the
 *   page the person left, and a verdict that arrived meanwhile still applies.
 */
export class NavigationGate {
    private lastOnScreen: ProviderContext | null = null;
    private pending: { ctx: ProviderContext; ts: number; path: string; timer: unknown } | null = null;
    private queue: Array<{ ctx: ProviderContext | null; path: string; ts: number }> = [];
    private readonly verdicts = new Map<string, boolean>();

    constructor(private readonly deps: NavigationGateDeps) {}

    navigate(ctx: ProviderContext | null, path: string, ts: number): void {
        if (this.pending) {
            if (ctx && sameConversation(ctx, this.pending.ctx)) return;
            this.queue.push({ ctx, path, ts });
            return;
        }
        this.process(ctx, path, ts);
    }

    /** The page's verdict on a path change. */
    verdict(path: string, created: boolean): void {
        if (this.pending && this.pending.path === path) {
            this.resolve(created);
            return;
        }
        // The verdict can arrive before the navigation event; keep it for that path.
        this.verdicts.clear();
        this.verdicts.set(path, created);
    }

    /** Anything held is released now as "not created" (screen closing). */
    release(): void {
        while (this.pending) this.resolve(false);
    }

    private process(ctx: ProviderContext | null, path: string, ts: number): void {
        const prev = this.lastOnScreen;
        const freshToThread = ctx !== null && prev !== null
            && ctx.boundaryMode === 'url_session_id'
            && prev.provider === ctx.provider
            && prev.sessionId === null && ctx.sessionId !== null;
        if (!freshToThread || ctx === null) {
            this.forward(ctx, ts);
            return;
        }
        const known = this.verdicts.get(path);
        if (known !== undefined) {
            this.verdicts.delete(path);
            this.forward({ ...ctx, continuesFreshChat: known }, ts);
            return;
        }
        const timer = this.deps.setTimer(() => this.resolve(false), PATH_VERDICT_WAIT_MS);
        this.pending = { ctx, ts, path, timer };
    }

    private resolve(created: boolean): void {
        const p = this.pending;
        if (!p) return;
        this.pending = null;
        this.deps.clearTimer(p.timer);
        this.forward({ ...p.ctx, continuesFreshChat: created }, p.ts);
        while (!this.pending && this.queue.length > 0) {
            const next = this.queue.shift()!;
            this.process(next.ctx, next.path, next.ts);
        }
    }

    private forward(ctx: ProviderContext | null, ts: number): void {
        if (ctx) this.lastOnScreen = ctx;
        this.deps.step({ t: 'foreground_changed', ts, providerContext: ctx });
    }
}

function sameConversation(a: ProviderContext, b: ProviderContext): boolean {
    return a.provider === b.provider && a.sessionId === b.sessionId;
}
