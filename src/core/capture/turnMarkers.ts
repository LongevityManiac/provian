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
 *    does not: the conversation is being created, and its first turns are new turns. The page
 *    shows which it is. An existing thread is opened by the person: a tap on a link to exactly
 *    that thread (history lists are links), a tap on a history or search row that is not a link
 *    when that was their last tap before the move, or going back. A thread being created gets
 *    there with none of these: the page itself moves its history entry (pushState or
 *    replaceState) from this fresh path to exactly this thread path, or a turn appeared on the
 *    fresh page moments before. A just-created thread's id never had a link, so a tap on a link
 *    to that exact path, however long the page then takes to move, always means opening. A
 *    voice chat's first question and answer may render only after the move (Claude does this),
 *    so the move alone is enough. A temporary or incognito chat never gets a thread of its own:
 *    a move off one is always opening a thread. The watcher posts its verdict (`path_change`)
 *    so the session machine adopts a thread id only for a chat being created.
 *  - A "created" thread's new last turn counts as soon as it appears (a voice chat has no other
 *    signal, and the person may leave moments later). During the arrival window, if more turns
 *    arrive than a just-created chat can have, it was an existing thread opened some other way:
 *    they are taken as already there and nothing is posted for them.
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
/** How recent the page's own history move must be to mean "the fresh chat moved to its thread". */
export const RENAME_WINDOW_MS = 2_000;
/** A tap on a link to exactly the thread the page then moves to, this recent, means it was opened. */
export const LINK_TAP_WINDOW_MS = 60_000;
/** A last tap on a history or search row (not a link) this recent before the move means opened. */
export const ROW_TAP_WINDOW_MS = 10_000;
/** More new turns than this while a created thread arrives means it was an existing thread. */
export const ARRIVAL_MAX_NEW_TURNS = 4;
/**
 * A history or search row that opens a thread without being a link: anything tappable in the
 * page's navigation (sidebar), or a result row in a dialog (a search box). The composer, its
 * suggestions and the voice controls are outside both and never match.
 */
const ROW_CONTAINERS = ['nav', 'aside', '[role="navigation"]', '[role="dialog"]'];
const ROW_ITEMS = ['li', '[role="listitem"]', '[role="option"]', '[role="menuitem"]', '[role="treeitem"]', '[role="link"]', '[cmdk-item]', '[role="button"]', 'button'];
export const HISTORY_ROW_SELECTOR = ROW_CONTAINERS
    .flatMap(c => ROW_ITEMS.filter(i => c !== '[role="dialog"]' || (i !== 'button' && i !== '[role="button"]')).map(i => `${c} ${i}`))
    .join(', ');
/** How recent a turn on the fresh page must be to mean "this fresh chat just got its thread". */
export const FRESH_TURN_WINDOW_MS = 10_000;
/** A fresh-path chat that never gets a thread of its own. */
export const TEMPORARY_CHAT_QUERY = 'temporary-chat=true|incognito';

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
    var LINK_TAP_MS = ${LINK_TAP_WINDOW_MS};
    var ROW_TAP_MS = ${ROW_TAP_WINDOW_MS};
    var ARRIVAL_MAX = ${ARRIVAL_MAX_NEW_TURNS};
    var HISTORY_ROW = ${JSON.stringify(HISTORY_ROW_SELECTOR)};
    var FRESH_TURN_MS = ${FRESH_TURN_WINDOW_MS};
    var TEMPORARY = new RegExp(${JSON.stringify(TEMPORARY_CHAT_QUERY)}, 'i');
    var absorbUntil = 0;
    var lastFreshTurnAt = -1;
    var lastSearch = '';
    var moves = [];
    var linkTaps = [];
    var lastTap = null;
    var arrival = null;
    function trimPath(p) { return p.length > 1 ? p.replace(/[/]+$/, '') : p; }
    function hookHistory(name) {
      try {
        var orig = history[name];
        history[name] = function (state, title, url) {
          try {
            var from = location.pathname || '/';
            var to = from;
            if (url !== undefined && url !== null) to = new URL(String(url), location.href).pathname || '/';
            moves.push({ from: from, to: to, at: Date.now() });
            if (moves.length > 8) moves.shift();
            schedule();
          } catch (e) {}
          return orig.apply(history, arguments);
        };
      } catch (e) {}
    }
    hookHistory('pushState');
    hookHistory('replaceState');
    // Which thread the person reached for. Read on press as well as click: some routers move on
    // pointerdown. Only the tapped element's link path and role are read.
    function onTap(ev) {
      try {
        var t = ev.target;
        if (t && t.nodeType === 3) t = t.parentElement;
        if (!t || !t.closest) return;
        var now = Date.now();
        var a = t.closest('a[href]');
        if (a) {
          var lp = trimPath(new URL(a.getAttribute('href'), location.href).pathname || '/');
          var isThread = THREAD.test(lp);
          if (isThread) {
            linkTaps.push({ path: lp, at: now });
            if (linkTaps.length > 16) linkTaps.shift();
          }
          lastTap = { row: false, at: now };
          return;
        }
        lastTap = { row: !!t.closest(HISTORY_ROW), at: now };
      } catch (e) {}
    }
    // Typing in the composer is the person's latest act: a row tap before it no longer counts.
    // Only the key's target is looked at, never the key.
    function onKey(ev) {
      try {
        var t = ev.target;
        if (!t || !t.closest || t.closest('[role="dialog"]')) return;
        if (t.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) lastTap = { row: false, at: Date.now() };
      } catch (e) {}
    }
    try {
      var tapEvents = ['pointerdown', 'touchstart', 'mousedown', 'click'];
      for (var te = 0; te < tapEvents.length; te++) document.addEventListener(tapEvents[te], onTap, true);
      document.addEventListener('keydown', onKey, true);
    } catch (e) {}
    function tappedLinkTo(p, now) {
      for (var i = linkTaps.length - 1; i >= 0; i--) {
        if (linkTaps[i].path === p && now - linkTaps[i].at <= LINK_TAP_MS) return true;
      }
      return false;
    }
    function pageMoved(from, to, now) {
      for (var i = moves.length - 1; i >= 0; i--) {
        var m = moves[i];
        if (m.from === from && m.to === to && now - m.at <= RENAME_MS) return m.at;
      }
      return -1;
    }
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
        var search = location.search || '';
        if (lastPath !== null && path !== lastPath) {
          var now = Date.now();
          var movedAt = pageMoved(lastPath, path, now);
          var turnedOnFresh = lastFreshTurnAt >= 0 && now - lastFreshTurnAt <= FRESH_TURN_MS;
          var refAt = movedAt >= 0 ? movedAt : now;
          // A tap on a link to exactly this thread, before or just after the page moved.
          var linkOpened = tappedLinkTo(trimPath(path), now);
          // The last tap before the move (or since) was on a history or search row.
          var rowOpened = lastTap !== null && lastTap.row && refAt - lastTap.at <= ROW_TAP_MS;
          var created = FRESH.test(lastPath) && !FRESH.test(path) && !TEMPORARY.test(lastSearch)
            && !linkOpened && !rowOpened && (movedAt >= 0 || turnedOnFresh);
          arrival = created ? { path: path, until: now + ABSORB_MS } : null;
          if (!created) {
            baselined = false;
            if (!FRESH.test(path)) absorbUntil = now + ABSORB_MS;
          }
          lastFreshTurnAt = -1;
          post({ v: 1, t: 'path_change', provider: PROVIDER, path: path, created: created });
        } else if (lastPath === null && !FRESH.test(path)) {
          absorbUntil = Date.now() + ABSORB_MS;
        }
        lastPath = path;
        lastSearch = search;
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
        if (arrival !== null) {
          if (arrival.path !== path || Date.now() >= arrival.until) {
            arrival = null;
          } else {
            var arriving = 0;
            for (var q = 0; q < ids.length; q++) if (!seen[ids[q]]) arriving += 1;
            if (arriving > ARRIVAL_MAX) {
              // More than a just-created chat can have: an existing thread, opened some other way.
              for (var r = 0; r < ids.length; r++) seen[ids[r]] = 1;
              lastTail = tail;
              return;
            }
          }
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
          if (FRESH.test(path)) lastFreshTurnAt = Date.now();
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
    | { t: 'path_change'; provider: string; path: string; created: boolean }
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
    if (m.t === 'path_change' && typeof m.path === 'string' && m.path.length <= 512 && m.path.startsWith('/') && typeof m.created === 'boolean') {
        return { t: 'path_change', provider, path: m.path, created: m.created };
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
