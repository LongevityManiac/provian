/**
 * Turn markers: how the chat screen sees a conversation move without reading it.
 *
 * A turn the person speaks in the provider's own voice mode lands on the page as a new
 * conversation turn, exactly like a typed one. The turn watcher injected into the chat WebView
 * watches for a NEW turn at the end of the conversation and posts `turns_added`; the chat screen
 * feeds that to the session state machine as an input event, the same event a keyboard open
 * feeds. Voice or typed, one chat is one `ai_conversation` record.
 *
 * The watcher reads element identity (a turn's key attribute, or the element itself) and counts.
 * It never reads text, audio, or the microphone.
 *
 * It also reports two page facts the chat screen needs:
 *  - `auth_page`: a sign-in form (password, one-time code, email or username field) is on screen.
 *    Typing into a provider's sign-in form is not a chat, so the keyboard does not count there.
 *  - `marker_health`: on a conversation page, whether any of the provider's markers matched. A
 *    provider that changes its page stops matching; the chat screen reports that so the operator
 *    is told, instead of voice chats silently going uncounted.
 *
 * Rules, so that loading or scrolling an old thread is never counted as engagement:
 *  - The turns present when a thread first renders (opened from history) are the baseline, not
 *    new turns. A fresh chat's empty page is an empty baseline.
 *  - Opening an existing thread re-baselines, including from a fresh chat page (the screen opens
 *    on one, and its history list sits there). Going from a fresh chat to its own new thread
 *    does not: the conversation is being created. The page shows which it is: a turn already
 *    appeared on the fresh page, or the page renamed its own history entry (replaceState) to
 *    the new thread. A path change without either is treated as opening an existing thread.
 *  - For a few seconds after arriving at an existing thread, turns that render are absorbed into
 *    the baseline: a provider may still be swapping the old thread's turns for the new one's.
 *  - Only a new LAST turn counts. Older turns appearing above it (virtualized lists render them on
 *    scroll) are added to the seen set silently.
 *
 * Markers were checked against each provider's live page; candidates are tried in order and the
 * first that matches anything is used. Keep the older shapes as later candidates: providers serve
 * different pages to signed-in and signed-out visitors (ChatGPT's signed-in page uses
 * `data-turn-key`, its signed-out mobile page `conversation-turn-N`).
 */

import type { SupportedProvider } from './injectedScript';

export interface TurnMarkerCandidate {
    /** Selector for turn elements. */
    sel: string;
    /** Attribute holding a stable per-turn key; null uses element identity. */
    key: string | null;
}

export interface TurnMarkerSpec {
    candidates: readonly TurnMarkerCandidate[];
    /** Path of a fresh chat that has no thread id yet. */
    freshPath: string;
    /** Path of an existing conversation, where turns must be on the page. */
    threadPath: string;
}

export const TURN_MARKERS: Record<SupportedProvider, TurnMarkerSpec> = {
    chatgpt: {
        candidates: [
            { sel: '[data-turn-key]', key: 'data-turn-key' },
            { sel: '[data-testid^="conversation-turn-"]:not([data-testid$="-footer"])', key: 'data-testid' },
            { sel: '[data-message-author-role]', key: 'data-message-id' },
        ],
        freshPath: '^/$|^/g/[^/]+(/project)?/?$',
        threadPath: '^/(g/[^/]+/)?c/[0-9a-f-]{8,}',
    },
    claude: {
        candidates: [
            { sel: '[data-turn-key]', key: 'data-turn-key' },
            { sel: '[data-testid="user-message"], [data-testid="assistant-message"]', key: null },
        ],
        freshPath: '^/$|^/new/?$|^/project/',
        threadPath: '^/chat/[0-9a-f-]{8,}',
    },
    gemini: {
        candidates: [
            { sel: '.conversation-container[id]', key: 'id' },
            { sel: 'user-query, model-response', key: null },
        ],
        freshPath: '^/$|^/app/?$|^/gem/',
        threadPath: '^/app/[0-9a-f]{8,}',
    },
    perplexity: {
        candidates: [
            { sel: '[data-message-bubble="right"], [data-workflow-final-text]', key: null },
            { sel: '[data-testid="thread-question"], [data-testid="thread-answer"]', key: null },
        ],
        freshPath: '^/$',
        threadPath: '^/(search|session)/[A-Za-z0-9._-]{8,}',
    },
    grok: {
        candidates: [
            { sel: '[id^="response-"]', key: 'id' },
            { sel: '.message-bubble', key: null },
        ],
        freshPath: '^/$|^/chat/?$|^/i/grok/?$',
        threadPath: '^/(c|chat)/[0-9a-f-]{8,}',
    },
    venice: {
        candidates: [
            { sel: '[data-chat-turn-anchor]', key: null },
            { sel: '[data-testid="message-user"], [data-testid="message-assistant"]', key: null },
        ],
        freshPath: '^/$|^/chat/?$|^/chat/(agent|classic)/?$',
        threadPath: '^/chat/(agent|classic)/[A-Za-z0-9_-]{5,}|^/c/[A-Za-z0-9_-]{5,}',
    },
};

/** A visible field that only a sign-in form has. */
export const AUTH_FIELD_SELECTOR = [
    'input[type="password"]',
    'input[autocomplete="one-time-code"]',
    'input[autocomplete="current-password"]',
    'input[type="email"]',
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
    'input[name="email"]',
    'input[name="username"]',
].join(', ');

/** A sign-in control in the page: a visitor who sees one is signed out. */
export const SIGNED_OUT_HINT_SELECTOR = [
    '[data-testid="login-button"]',
    'a[href*="/login"]',
    'a[href*="/log-in"]',
    'a[href*="/sign-in"]',
    'a[href*="/auth/login"]',
].join(', ');

/** How long turns rendering on arrival at an existing thread are treated as already there. */
export const THREAD_ARRIVAL_ABSORB_MS = 3_000;
/** How recent a replaceState must be to mean "the fresh chat was renamed to its thread". */
export const RENAME_WINDOW_MS = 2_000;

/** Seconds after a conversation page settles before its markers are judged. */
export const MARKER_HEALTH_FIRST_CHECK_MS = 8_000;
export const MARKER_HEALTH_FINAL_CHECK_MS = 20_000;

export function buildTurnWatcherScript(provider: SupportedProvider): string {
    const spec = TURN_MARKERS[provider];
    return `
(function () {
  try {
    if (window.__provianTurnWatch) { return true; }
    window.__provianTurnWatch = true;
    var PROVIDER = ${JSON.stringify(provider)};
    var CANDIDATES = ${JSON.stringify(spec.candidates)};
    var FRESH = new RegExp(${JSON.stringify(spec.freshPath)});
    var THREAD = new RegExp(${JSON.stringify(spec.threadPath)});
    var AUTH_FIELDS = ${JSON.stringify(AUTH_FIELD_SELECTOR)};
    var SIGNED_OUT = ${JSON.stringify(SIGNED_OUT_HINT_SELECTOR)};
    var FIRST_CHECK = ${MARKER_HEALTH_FIRST_CHECK_MS};
    var ABSORB_MS = ${THREAD_ARRIVAL_ABSORB_MS};
    var RENAME_MS = ${RENAME_WINDOW_MS};
    var absorbUntil = 0;
    var sawTurnOnFresh = false;
    var lastRenameAt = -1;
    try {
      var origReplace = history.replaceState;
      history.replaceState = function () {
        lastRenameAt = Date.now();
        return origReplace.apply(history, arguments);
      };
    } catch (e) {}
    var FINAL_CHECK = ${MARKER_HEALTH_FINAL_CHECK_MS};
    var seen = {};
    var lastPath = null;
    var baselined = false;
    var lastTail = null;
    var nodeSeq = 0;
    var authShown = null;
    var healthPath = null;
    var healthSince = 0;
    var healthDone = {};

    function post(o) {
      try { window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {}
    }
    function countOf(sel) {
      try { return document.querySelectorAll(sel).length; } catch (e) { return 0; }
    }
    function counts() {
      var out = [];
      for (var i = 0; i < CANDIDATES.length; i++) out.push(countOf(CANDIDATES[i].sel));
      return out;
    }
    function pick() {
      for (var i = 0; i < CANDIDATES.length; i++) {
        if (countOf(CANDIDATES[i].sel) > 0) return i;
      }
      return -1;
    }
    function idOf(el, c) {
      if (c.key) {
        var v = el.getAttribute(c.key);
        if (v) return 'k:' + v;
      }
      if (!el.__pvTurnId) { nodeSeq += 1; el.__pvTurnId = 'n:' + nodeSeq; }
      return el.__pvTurnId;
    }
    function visibleAuthField() {
      try {
        var els = document.querySelectorAll(AUTH_FIELDS);
        for (var i = 0; i < els.length; i++) {
          var r = els[i].getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
      } catch (e) {}
      return false;
    }
    function checkAuth() {
      var a = visibleAuthField();
      if (a !== authShown) {
        authShown = a;
        post({ v: 1, t: 'auth_page', provider: PROVIDER, visible: a });
      }
    }
    function checkHealth(path) {
      if (!THREAD.test(path)) { healthPath = null; return; }
      if (healthPath !== path) { healthPath = path; healthSince = Date.now(); return; }
      if (healthDone[path]) return;
      var age = Date.now() - healthSince;
      if (age < FIRST_CHECK) return;
      var cand = pick();
      if (cand < 0 && age < FINAL_CHECK) return;
      healthDone[path] = true;
      post({
        v: 1, t: 'marker_health', provider: PROVIDER,
        matched: cand >= 0, candidate: cand, counts: counts(),
        account: (function () { try { return document.querySelector(SIGNED_OUT) ? 'signed_out' : 'signed_in'; } catch (e) { return 'signed_in'; } })()
      });
    }
    function run() {
      try {
        var path = location.pathname || '/';
        checkAuth();
        checkHealth(path);
        if (lastPath !== null && path !== lastPath) {
          var created = FRESH.test(lastPath) && !FRESH.test(path)
            && (sawTurnOnFresh || (lastRenameAt >= 0 && Date.now() - lastRenameAt <= RENAME_MS));
          if (!created) {
            baselined = false;
            if (!FRESH.test(path)) absorbUntil = Date.now() + ABSORB_MS;
          }
          sawTurnOnFresh = false;
        } else if (lastPath === null && !FRESH.test(path)) {
          absorbUntil = Date.now() + ABSORB_MS;
        }
        lastPath = path;
        var p = pick();
        var c = p >= 0 ? CANDIDATES[p] : null;
        var els = c ? document.querySelectorAll(c.sel) : [];
        var ids = [];
        for (var i = 0; i < els.length; i++) ids.push(idOf(els[i], c));
        var tail = ids.length ? ids[ids.length - 1] : null;
        if (!baselined) {
          // A thread page whose turns have not rendered yet is not a baseline: wait for them.
          if (!FRESH.test(path) && ids.length === 0) { return; }
          for (var j = 0; j < ids.length; j++) seen[ids[j]] = 1;
          baselined = true;
          lastTail = tail;
          return;
        }
        if (Date.now() < absorbUntil) {
          for (var a = 0; a < ids.length; a++) seen[ids[a]] = 1;
          lastTail = tail;
          return;
        }
        var added = 0;
        var tailIsNew = tail !== null && !seen[tail];
        for (var k = 0; k < ids.length; k++) {
          if (!seen[ids[k]]) { seen[ids[k]] = 1; added += 1; }
        }
        if (tailIsNew && tail !== lastTail) {
          lastTail = tail;
          if (FRESH.test(path)) sawTurnOnFresh = true;
          post({ v: 1, t: 'turns_added', provider: PROVIDER, n: added });
        }
      } catch (e) {}
    }
    var pending = false;
    function schedule() {
      if (pending) return;
      pending = true;
      setTimeout(function () { pending = false; run(); }, 400);
    }
    new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['type', 'style', 'class', 'hidden'] });
    setTimeout(run, 400);
    setInterval(run, 4000);
    return true;
  } catch (e) { return false; }
})();
true;
`;
}

/**
 * A stable key for the conversation a URL shows, or null on a fresh chat page. The catalog's
 * session-id patterns do not cover every conversation URL providers serve today (ChatGPT
 * `/g/<gpt>/c/<id>`, Perplexity `/session/<id>`, Venice `/chat/agent/<id>`); the session machine
 * reads a null id as "a fresh chat that has no thread yet", so every conversation URL needs one.
 */
export function threadKeyFromUrl(provider: string, url: string): string | null {
    const spec = (TURN_MARKERS as Record<string, TurnMarkerSpec | undefined>)[provider];
    if (!spec) return null;
    const m = /^https?:\/\/[^/?#]+([^?#]*)/i.exec(url);
    const path = m ? (m[1] || '/') : null;
    if (!path) return null;
    return new RegExp(spec.threadPath).test(path) ? path.replace(/\/+$/, '') : null;
}

// --- messages the watcher posts, as the chat screen reads them ---------------------------------

export type TurnWatcherMessage =
    | { t: 'turns_added'; provider: string; n: number }
    | { t: 'auth_page'; provider: string; visible: boolean }
    | {
        t: 'marker_health';
        provider: string;
        matched: boolean;
        candidate: number;
        counts: number[];
        account: 'signed_in' | 'signed_out';
    };

function isSmallInt(n: unknown, max: number): n is number {
    return typeof n === 'number' && Number.isInteger(n) && n >= -1 && n <= max;
}

/**
 * Strict parse of a watcher message. Anything else is not ours (the existing capture-metrics
 * handler gets it) or is malformed (dropped).
 */
export function parseTurnWatcherMessage(raw: string, provider: string): TurnWatcherMessage | null {
    if (raw.length > 2_000) return null;
    let o: unknown;
    try {
        o = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!o || typeof o !== 'object') return null;
    const m = o as Record<string, unknown>;
    if (m.v !== 1 || m.provider !== provider) return null;
    if (m.t === 'turns_added' && isSmallInt(m.n, 10_000) && m.n > 0) {
        return { t: 'turns_added', provider, n: m.n };
    }
    if (m.t === 'auth_page' && typeof m.visible === 'boolean') {
        return { t: 'auth_page', provider, visible: m.visible };
    }
    if (
        m.t === 'marker_health'
        && typeof m.matched === 'boolean'
        && isSmallInt(m.candidate, 16)
        && Array.isArray(m.counts)
        && m.counts.length <= 16
        && m.counts.every(c => isSmallInt(c, 100_000))
        && (m.account === 'signed_in' || m.account === 'signed_out')
    ) {
        return {
            t: 'marker_health',
            provider,
            matched: m.matched,
            candidate: m.candidate,
            counts: m.counts as number[],
            account: m.account,
        };
    }
    return null;
}
