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

/** Whether a WebView navigation may tell the session the chat is on screen. */
export function navigationMayRevive(appState: string | null | undefined): boolean {
    return appState === 'active';
}
