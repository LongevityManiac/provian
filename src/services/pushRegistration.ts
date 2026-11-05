/**
 * Pure push-registration decision logic (no native/Expo imports).
 *
 * The relay -> phone push chain only works if the app (a) asks the OS for
 * notification permission and (b) registers the resulting Expo token with the
 * backend. Historically neither happened - `requestPermission()` had no caller -
 * so no token was ever minted or registered and every push silently failed.
 *
 * This module owns the *decision*: given the current permission status and
 * whether the caller is allowed to prompt, decide whether to request
 * permission, mint the token, and register it. It is dependency-injected so it
 * can be unit-tested without a device or the expo-notifications native module.
 * `NotificationService.ensurePushRegistration` wires the real Expo functions in.
 *
 * Invariants:
 *  - Never prompt when permission is already `denied` (no nag loop). Only prompt
 *    on `undetermined` AND when the caller opted in (`prompt: true`).
 *  - When already `granted`, silently (re-)mint + register - this is what makes
 *    "user enabled notifications in system settings later" self-heal, and what
 *    re-registers a rotated token.
 *  - Never throw. Denial / errors degrade gracefully; the app stays functional
 *    without push.
 */

export type PushPermissionStatus = 'granted' | 'denied' | 'undetermined';

export type PushRegistrationOutcome =
  | 'registered'               // token minted + handed to the registrar
  | 'permission_denied'        // user declined (or previously declined)
  | 'permission_undetermined'  // not asked yet and caller chose not to prompt
  | 'unavailable'              // not a physical device (simulator/web)
  | 'no_token'                 // permission granted but no token could be minted
  | 'error';                   // an unexpected failure (swallowed)

export interface PushRegistrationDeps {
  /** True only on a physical device - push tokens don't exist on simulators. */
  isDevice: boolean;
  /** Current OS notification permission status. */
  getPermissionStatus: () => Promise<PushPermissionStatus>;
  /** Prompt the user for permission (shows the OS dialog). Returns the result. */
  requestPermission: () => Promise<PushPermissionStatus>;
  /** Mint + persist the Expo push token. Returns the token, or null on failure. */
  mintToken: () => Promise<string | null>;
  /** Hand the token to the backend registrar. May be a no-op if unset. */
  register: (token: string) => Promise<void>;
}

export interface EnsurePushRegistrationOptions {
  /**
   * When true, prompt for permission if the OS status is `undetermined`.
   * When false (default), never show a prompt - only (re-)register if already
   * granted. Use `true` right after a wallet becomes active (in-context ask);
   * use `false` for app-start / foreground re-checks so there is no nag.
   */
  prompt?: boolean;
}

export async function ensurePushRegistration(
  deps: PushRegistrationDeps,
  options: EnsurePushRegistrationOptions = {},
): Promise<PushRegistrationOutcome> {
  const shouldPrompt = options.prompt ?? false;
  try {
    if (!deps.isDevice) return 'unavailable';

    let status = await deps.getPermissionStatus();

    // Only ever prompt when the OS has never asked (undetermined) AND the caller
    // opted in. Never re-prompt on 'denied' - that is the nag-loop guard.
    if (status === 'undetermined' && shouldPrompt) {
      status = await deps.requestPermission();
    }

    if (status !== 'granted') {
      return status === 'denied' ? 'permission_denied' : 'permission_undetermined';
    }

    const token = await deps.mintToken();
    if (!token) return 'no_token';

    await deps.register(token);
    return 'registered';
  } catch {
    // Push is best-effort; a failure here must never crash or block the app.
    return 'error';
  }
}
