/**
 * Builder for the per-provider MutationObserver JavaScript injected into
 * each Chat WebView.
 *
 * The returned string is a self-contained ES5-ish program that:
 *   1. Selects the provider-specific conversation scope.
 *   2. Computes the four ObserverMetrics from the DOM using provider-
 *      specific selectors. Logic mirrors `src/core/capture/observers/*`
 *      but cannot import from there because this code runs inside the
 *      WebView, not in React Native.
 *   3. Applies conservative rounding before posting: charCount rounded
 *      to nearest 100, other counts left as integers.
 *   4. Posts the result via `window.ReactNativeWebView.postMessage` as
 *      JSON string with schema {v:1, t:"capture_metrics", provider, ...}.
 *   5. Installs a MutationObserver on the scope, debounces mutations at
 *      150 ms, and re-runs the pipeline on each debounced tick.
 *
 * The script is defensive: every DOM access is wrapped in try/catch.
 * Zero matches return zero metrics, never throw. A postMessage failure
 * is swallowed; the next mutation's post attempt will retry.
 *
 * Selector sets below must stay in lockstep with the per-provider
 * observer modules in `src/core/capture/observers/`. Any change to
 * observer selectors must be mirrored here, and vice versa. The parity
 * test at `observers/__tests__/observer-injection-parity.test.ts`
 * cross-checks the two code paths: it imports this file's
 * `SELECTORS_BY_PROVIDER` and each observer module's exported selector
 * set, and fails if they diverge.
 */

export type SupportedProvider = 'claude' | 'chatgpt' | 'gemini' | 'perplexity' | 'grok' | 'venice';

export const DEBOUNCE_MS_DEFAULT = 150;

export interface BuildInjectedScriptOptions {
    debounceMs?: number;
}

/**
 * Return the injected JavaScript string for a given provider. The
 * resulting string is suitable for react-native-webview's
 * `injectedJavaScript` or `injectedJavaScriptBeforeContentLoaded`.
 */
export function buildInjectedScript(
    provider: SupportedProvider,
    opts: BuildInjectedScriptOptions = {},
): string {
    const debounceMs = opts.debounceMs ?? DEBOUNCE_MS_DEFAULT;
    const selectors = SELECTORS_BY_PROVIDER[provider];
    if (!selectors) {
        throw new Error(`buildInjectedScript: unknown provider "${provider}"`);
    }

    // JSON.stringify is safe here; the selectors are literals we own.
    const selectorsJson = JSON.stringify(selectors);
    const providerJson = JSON.stringify(provider);

    return `
(function () {
  try {
    if (window.__provianCaptureInstalled) { return true; }
    window.__provianCaptureInstalled = true;

    var PROVIDER = ${providerJson};
    var SELECTORS = ${selectorsJson};
    var DEBOUNCE_MS = ${debounceMs};

    function nonNegInt(n) {
      return typeof n === 'number' && isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    }

    function roundHundred(n) {
      var v = nonNegInt(n);
      return Math.round(v / 100) * 100;
    }

    function sumVideoSeconds(scope) {
      var total = 0;
      try {
        var videos = scope.querySelectorAll('video');
        for (var i = 0; i < videos.length; i++) {
          var d = videos[i].duration;
          if (typeof d === 'number' && isFinite(d) && d > 0) {
            total += d;
          }
        }
      } catch (e) {}
      return Math.round(total);
    }

    function resolveScope() {
      try {
        if (SELECTORS.scope) {
          var s = document.querySelector(SELECTORS.scope);
          if (s) return s;
        }
      } catch (e) {}
      return document.body || document.documentElement || null;
    }

    function sumTextLength(scope, selector) {
      if (!selector) return 0;
      var total = 0;
      try {
        var nodes = scope.querySelectorAll(selector);
        for (var i = 0; i < nodes.length; i++) {
          var t = nodes[i].textContent || '';
          total += t.length;
        }
      } catch (e) {}
      return total;
    }

    function countMatches(scope, selector) {
      if (!selector) return 0;
      try {
        return scope.querySelectorAll(selector).length;
      } catch (e) {
        return 0;
      }
    }

    function computeMetrics() {
      var scope = resolveScope();
      if (!scope) {
        return { turnCount: 0, charCount: 0, imageCount: 0, videoSeconds: 0 };
      }
      var turnCount = SELECTORS.countTurns ? countMatches(scope, SELECTORS.turn) : 0;
      var charCount = sumTextLength(scope, SELECTORS.userCharSource);
      var imageCount = SELECTORS.image ? countMatches(scope, SELECTORS.image) : 0;
      var videoSeconds = SELECTORS.countVideo ? sumVideoSeconds(scope) : 0;
      return { turnCount: turnCount, charCount: charCount, imageCount: imageCount, videoSeconds: videoSeconds };
    }

    function postMetrics() {
      try {
        var m = computeMetrics();
        var payload = {
          v: 1,
          t: 'capture_metrics',
          provider: PROVIDER,
          turnCount: nonNegInt(m.turnCount),
          charCount: roundHundred(m.charCount),
          imageCount: nonNegInt(m.imageCount),
          videoSeconds: nonNegInt(m.videoSeconds)
        };
        if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
          window.ReactNativeWebView.postMessage(JSON.stringify(payload));
        }
      } catch (e) {}
    }

    var pending = false;
    var timer = null;
    function schedule() {
      if (pending) return;
      pending = true;
      timer = setTimeout(function () {
        pending = false;
        postMetrics();
      }, DEBOUNCE_MS);
    }

    try {
      var observer = new MutationObserver(schedule);
      var target = resolveScope() || document.body || document.documentElement;
      if (target) {
        observer.observe(target, { subtree: true, childList: true, characterData: true });
      }
      window.__provianCaptureObserver = observer;
    } catch (e) {}

    // Post an initial metric shortly after install so the native side
    // gets a signal even on a static page.
    setTimeout(postMetrics, DEBOUNCE_MS);

    return true;
  } catch (e) {
    return false;
  }
})();
true;
`;
}

/**
 * Selector definitions per provider. Must stay in lockstep with the
 * TypeScript observer modules. Each field is optional; an undefined
 * selector makes the corresponding metric return zero.
 */
export interface ProviderSelectors {
    /** Conversation scope. Falls back to document.body when omitted. */
    scope?: string;
    /** Selector for turn containers (combined user + assistant). */
    turn?: string;
    /** Whether to count turns. Grok sets this false. */
    countTurns: boolean;
    /** Selector whose textContent feeds charCount. User-authored only. */
    userCharSource?: string;
    /** Selector for images. Matched elements count toward imageCount. */
    image?: string;
    /** Whether to sum <video>.duration inside the scope. Grok sets this false. */
    countVideo: boolean;
}

export const SELECTORS_BY_PROVIDER: Record<SupportedProvider, ProviderSelectors> = {
    claude: {
        scope: '[data-testid="conversation"]',
        turn: '[data-testid="user-message"], [data-testid="assistant-message"]',
        countTurns: true,
        userCharSource: '[data-testid="user-message"]',
        image: 'img',
        countVideo: false,
    },
    chatgpt: {
        turn: '[data-testid^="conversation-turn-"]',
        countTurns: true,
        userCharSource: '[data-message-author-role="user"]',
        image: '[data-testid^="conversation-turn-"] img',
        countVideo: true,
    },
    gemini: {
        turn: 'user-query, model-response',
        countTurns: true,
        userCharSource: 'user-query',
        image: 'user-query img, model-response img',
        countVideo: true,
    },
    perplexity: {
        turn: '[data-testid="thread-question"], [data-testid="thread-answer"]',
        countTurns: true,
        userCharSource: '[data-testid="thread-question"]',
        image: '[data-testid="thread-question"] img, [data-testid="thread-answer"] img',
        countVideo: true,
    },
    grok: {
        countTurns: false,
        userCharSource: '[data-testid="message"][data-role="user"]',
        image: '[data-testid="message"][data-role="user"] img',
        countVideo: false,
    },
    venice: {
        scope: '[data-testid="chat-messages"]',
        turn: '[data-testid="message-user"], [data-testid="message-assistant"]',
        countTurns: true,
        userCharSource: '[data-testid="message-user"]',
        image: 'img',
        countVideo: false,
    },
};
