/**
 * requireBiometric - Strict biometric gate for sensitive operations.
 *
 * This is the canonical biometric helper for ALL sensitive operations:
 * wallet unlock, transaction approval, mnemonic export, key export,
 * delete-all-data, agent authorization, goal approval, etc.
 *
 * Behaviour:
 *
 * 1. If the device has no biometric hardware OR no enrolled biometric,
 *    throws BiometricNotAvailableError. The caller MUST surface this to
 *    the user - do not silently fall through.
 *
 * 2. If hardware + enrollment are present, calls
 *    LocalAuthentication.authenticateAsync({
 *      disableDeviceFallback: true,
 *      requireConfirmation: true,
 *    })
 *
 *    This is fail-closed: device passcode CANNOT be substituted for
 *    biometric. The audit (Theme 5 / C-17) found 15+ screens that allowed
 *    `disableDeviceFallback: false`, which lets a stolen-but-unlocked
 *    phone approve high-stakes wallet operations.
 *
 *    The exception is the seed-phrase onboarding fallback path (see
 *    `requireBiometricOrPasscode` below) - devices without biometrics
 *    must still be usable, but they trade the higher-trust hardware path
 *    for the standard crypto wallet UX (seed phrase + passcode signing,
 *    `attestation_depth = 'software'`).
 *
 * 3. On user cancel or auth failure, throws BiometricAuthError.
 *
 * Callers should `try { await requireBiometric(...) } catch (e) { ... }`
 * and abort the sensitive operation on any throw.
 *
 * NOTE: For the existing batch-signing path (auto_approve / soft_confirm
 * lanes that open a 60-second KeyStore validity window on Android), use
 * `authenticateForSigning` from `./biometricGate` instead - that helper
 * deals with the iOS/Android KeyStore-binding asymmetry. requireBiometric
 * is the right choice for one-shot, hard-confirm operations.
 */

import * as LocalAuthentication from 'expo-local-authentication';
// [Audit L-3] AsyncStorage import removed - biometric fallback flag now
// uses HMAC-protected storage (see hmacAsyncStorage.ts import below).

// =============================================================================
// FALLBACK MODE
// =============================================================================
//
// Stored at AsyncStorage key '@provian_biometric_fallback'. Set to 'true' for
// wallets created in the seed-phrase onboarding fallback path (devices that
// have no biometric hardware or no enrolled biometric). Wallets in fallback
// mode allow device passcode to substitute for biometric on sensitive
// operations, since hardware biometric is unavailable. Their PEs are tagged
// `attestation_depth = 'software'`.
//
// We cache the flag in module memory after the first read to avoid hitting
// AsyncStorage on every signing operation.

// [Audit L-3] Use HMAC-protected storage so an attacker with filesystem
// access cannot flip this flag to downgrade biometric to passcode-only.
import { setItemHmac, getItemHmac, removeItemHmac } from './hmacAsyncStorage';
import { translate } from '../../i18n/translate';

const FALLBACK_KEY = '@provian_biometric_fallback';
let cachedFallbackMode: boolean | null = null;

export async function isBiometricFallbackMode(): Promise<boolean> {
  if (cachedFallbackMode !== null) return cachedFallbackMode;
  try {
    const v = await getItemHmac<boolean>(FALLBACK_KEY);
    cachedFallbackMode = v === true;
  } catch {
    cachedFallbackMode = false;
  }
  return cachedFallbackMode;
}

/**
 * Mark this wallet as biometric-fallback (no hardware biometric).
 *
 * Call this once during onboarding when the user opts into the seed-phrase
 * fallback flow. After this is set, requireBiometric() routes through the
 * passcode-fallback path until the wallet is deleted.
 */
export async function enableBiometricFallback(): Promise<void> {
  cachedFallbackMode = true;
  await setItemHmac(FALLBACK_KEY, true);
}

/**
 * Clear the biometric-fallback flag. Called by DeleteAllDataScreen on
 * wallet wipe so the next wallet starts fresh.
 */
export async function clearBiometricFallback(): Promise<void> {
  cachedFallbackMode = false;
  await removeItemHmac(FALLBACK_KEY);
}

/**
 * Thrown when the device cannot perform biometric authentication because
 * the hardware is missing or no biometric is enrolled.
 *
 * The caller should prompt the user to either enable biometrics in device
 * settings or - for new wallets only - switch to the seed-phrase fallback
 * onboarding path.
 */
export class BiometricNotAvailableError extends Error {
  readonly code = 'BIOMETRIC_NOT_AVAILABLE';
  readonly hasHardware: boolean;
  readonly isEnrolled: boolean;
  /** English text for dApp replies and PE records; `message` is the on-screen copy. */
  readonly englishMessage: string;

  constructor(hasHardware: boolean, isEnrolled: boolean) {
    const english = hasHardware
      ? 'No biometric is enrolled on this device. Enable Face ID or fingerprint in your device settings.'
      : 'This device does not support biometric authentication.';
    super(translate(hasHardware ? 'biometricErrors.notEnrolled' : 'biometricErrors.notSupported', english));
    this.englishMessage = english;
    this.name = 'BiometricNotAvailableError';
    this.hasHardware = hasHardware;
    this.isEnrolled = isEnrolled;
  }
}

/**
 * Thrown when the user cancels the biometric prompt or authentication fails.
 */
export class BiometricAuthError extends Error {
  readonly code = 'BIOMETRIC_AUTH_FAILED';
  readonly authError: string | undefined;
  /** English text for dApp replies and PE records; `message` is the on-screen copy. */
  readonly englishMessage: string;

  constructor(authError: string | undefined) {
    const english = authError ?? 'Biometric authentication failed.';
    super(authError ?? translate('biometricErrors.authFailed', english));
    this.englishMessage = english;
    this.name = 'BiometricAuthError';
    this.authError = authError;
  }
}

// [Audit H-6] App-level rate limiting on biometric failures.
// The OS enforces its own lockout (typically 5 attempts), but a malicious
// script could rapidly invoke requireBiometric to trigger the OS lockout,
// denying the user biometric access across ALL apps. This cooldown prevents
// that by rate-limiting at the app layer.
let consecutiveFailures = 0;
let cooldownUntil = 0;
const BASE_COOLDOWN_MS = 30_000; // 30 seconds initial cooldown
const MAX_COOLDOWN_MS = 5 * 60_000; // 5 minutes max
const FAILURE_THRESHOLD = 3;

// [Audit #24] expo-local-authentication error strings that represent a
// DELIBERATE dismissal (the user tapped Cancel, the OS backgrounded the
// prompt, or the app dismissed it) rather than a failed biometric MATCH.
// These must NOT count toward the failure cooldown: the cooldown is module-
// GLOBAL and shared across every gate, so counting three cancels of a
// low-stakes dApp prompt would arm a cooldown that then blocks wallet
// unlock — a cross-gate DoS from cancel-vs-fail conflation. A cancel still
// throws BiometricAuthError (the operation is aborted) but leaves the
// failure counter untouched.
const CANCEL_AUTH_ERRORS = new Set(['user_cancel', 'system_cancel', 'app_cancel']);
function isCancelAuthError(authError: string | undefined): boolean {
  return authError !== undefined && CANCEL_AUTH_ERRORS.has(authError);
}

export class BiometricRateLimitError extends Error {
  readonly code = 'BIOMETRIC_RATE_LIMITED';
  readonly retryAfterMs: number;
  /** English text for dApp replies and PE records; `message` is the on-screen copy. */
  readonly englishMessage: string;

  constructor(retryAfterMs: number) {
    const seconds = Math.ceil(retryAfterMs / 1000);
    const english = `Too many failed attempts. Try again in ${seconds} seconds.`;
    super(translate('biometricErrors.rateLimited', english, { seconds }));
    this.englishMessage = english;
    this.name = 'BiometricRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

// Separate requests queue; only an explicit BiometricAction may share an approval.
let authQueue: Promise<unknown> = Promise.resolve();
export function requireBiometric(promptMessage: string, biometricOnly = false): Promise<true> {
  const run = authQueue.then(() => requireBiometricInner(promptMessage, biometricOnly), () => requireBiometricInner(promptMessage, biometricOnly));
  authQueue = run.catch(() => undefined);
  return run;
}

/** Preserve the canonical hardware check and failure cooldown for native CryptoObject/LAContext auth. */
export function authenticateBiometricAction<T>(authenticate: (allowPasscode: boolean) => Promise<T>, biometricOnly = false): Promise<T> {
  const run = authQueue.then(() => authenticateBiometricActionInner(authenticate, biometricOnly), () => authenticateBiometricActionInner(authenticate, biometricOnly));
  authQueue = run.catch(() => undefined);
  return run;
}

async function authenticateBiometricActionInner<T>(authenticate: (allowPasscode: boolean) => Promise<T>, biometricOnly: boolean): Promise<T> {
  const now = Date.now();
  if (now < cooldownUntil) throw new BiometricRateLimitError(cooldownUntil - now);
  const fallback = !biometricOnly && await isBiometricFallbackMode();
  if (!fallback) {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    if (!hasHardware || !isEnrolled) throw new BiometricNotAvailableError(hasHardware, isEnrolled);
  }
  try {
    const result = await authenticate(fallback);
    consecutiveFailures = 0;
    cooldownUntil = 0;
    return result;
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'ERR_SEED_AUTH_FAILED') {
      consecutiveFailures++;
      if (consecutiveFailures >= FAILURE_THRESHOLD) {
        cooldownUntil = Date.now() + Math.min(BASE_COOLDOWN_MS * Math.pow(2, consecutiveFailures - FAILURE_THRESHOLD), MAX_COOLDOWN_MS);
      }
      throw new BiometricAuthError(code);
    }
    if (code === 'ERR_SEED_AUTH_CANCELLED') throw new BiometricAuthError('user_cancel');
    throw err;
  }
}

async function requireBiometricInner(promptMessage: string, biometricOnly: boolean): Promise<true> {
  // [Audit H-6] Check rate limit before prompting
  const now = Date.now();
  if (now < cooldownUntil) {
    throw new BiometricRateLimitError(cooldownUntil - now);
  }

  // If this wallet was created on a non-biometric device, route through the
  // passcode-fallback gate. Operations gated this way produce PEs with
  // attestation_depth = 'software' (set elsewhere).
  if (!biometricOnly && await isBiometricFallbackMode()) {
    return requireBiometricOrPasscode(promptMessage);
  }

  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  const isEnrolled = await LocalAuthentication.isEnrolledAsync();

  if (!hasHardware || !isEnrolled) {
    throw new BiometricNotAvailableError(hasHardware, isEnrolled);
  }

  const result = await LocalAuthentication.authenticateAsync({
    promptMessage,
    disableDeviceFallback: true,
    requireConfirmation: true,
  });

  if (!result.success) {
    const authError = 'error' in result ? result.error : undefined;
    // [Audit #24] A deliberate cancel is not an authentication FAILURE.
    // Only genuine failed matches (authentication_failed, lockout, …) count
    // toward the module-global cooldown; a cancel aborts the operation but
    // never arms a cooldown that would then lock a different gate.
    if (!isCancelAuthError(authError)) {
      // [Audit H-6] Track consecutive failures and apply cooldown
      consecutiveFailures++;
      if (consecutiveFailures >= FAILURE_THRESHOLD) {
        const cooldownMs = Math.min(
          BASE_COOLDOWN_MS * Math.pow(2, consecutiveFailures - FAILURE_THRESHOLD),
          MAX_COOLDOWN_MS,
        );
        cooldownUntil = Date.now() + cooldownMs;
        console.warn(`[requireBiometric] ${consecutiveFailures} consecutive failures - cooldown ${cooldownMs}ms`);
      }
    }
    throw new BiometricAuthError(authError);
  }

  // Reset on success
  consecutiveFailures = 0;
  cooldownUntil = 0;

  return true;
}

/**
 * Detect whether the device can run the biometric-only signing path.
 *
 * Returns true when biometric hardware is present AND a biometric is
 * enrolled. Returns false otherwise (no Face ID / fingerprint, or none
 * enrolled). Use this to decide between the seedless biometric onboarding
 * flow and the seed-phrase fallback onboarding flow.
 */
export async function isBiometricAvailable(): Promise<{
  hasHardware: boolean;
  isEnrolled: boolean;
  canUseBiometric: boolean;
}> {
  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  const isEnrolled = await LocalAuthentication.isEnrolledAsync();
  return {
    hasHardware,
    isEnrolled,
    canUseBiometric: hasHardware && isEnrolled,
  };
}

/**
 * SOFTWARE-FALLBACK biometric gate.
 *
 * USE ONLY in the non-biometric onboarding fallback path. This allows
 * device passcode to substitute for biometric, which is the standard
 * crypto-wallet posture for devices with no Face ID / fingerprint.
 *
 * Operations gated by this helper MUST tag their resulting Provenance
 * Envelopes with `attestation_depth = 'software'`. Do NOT use this in
 * any path that claims hardware attestation.
 */
export async function requireBiometricOrPasscode(promptMessage: string): Promise<true> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage,
    disableDeviceFallback: false,
    requireConfirmation: true,
  });

  if (!result.success) {
    throw new BiometricAuthError('error' in result ? result.error : undefined);
  }

  return true;
}
