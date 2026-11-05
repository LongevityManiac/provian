/**
 * biometricGate - Platform-aware biometric gate for signing operations.
 *
 * The two mobile platforms have fundamentally different KeyStore binding
 * models and it is unsafe to treat them as interchangeable:
 *
 * - iOS: LAContext and Secure Enclave share session state. A successful
 *   LocalAuthentication.authenticateAsync() call unlocks Secure Enclave
 *   keys for the duration of the LAContext session, so subsequent
 *   signDigest calls succeed without a fresh prompt.
 *
 * - Android: expo-local-authentication and the KeyStore's user-authentication
 *   binding are INDEPENDENT auth systems. LocalAuthentication.authenticateAsync()
 *   does not unlock KeyStore keys. You must either (a) use BiometricPrompt
 *   with a CryptoObject bound to the key at prompt time (hard_confirm path),
 *   or (b) open the key's duration-based validity window by triggering a
 *   strong-biometric BiometricPrompt through the native module.
 *
 * This module centralises the platform branching so callers do not have to
 * know about either system. Call authenticateForSigning() once before a
 * batch of signing operations; it will do the right thing per platform.
 */

import { Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import KeyManager from './KeyManager';

/**
 * Open a biometric authentication session for a batch of signing operations.
 *
 * After this resolves true, the caller may perform auto_approve or
 * soft_confirm signDigest calls without further biometric prompts within
 * the platform's validity window (60 seconds on Android, LAContext lifetime
 * on iOS).
 *
 * hard_confirm signing is independent of this - it always triggers its own
 * dedicated prompt at sign time and does not rely on the window opened here.
 *
 * @param reason - Human-readable reason shown in the biometric prompt.
 * @returns true if authentication succeeded, false if the user cancelled or
 *          auth failed. Callers should abort the signing batch on false.
 */
export async function authenticateForSigning(reason: string): Promise<boolean> {
  if (Platform.OS === 'ios') {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      fallbackLabel: 'Use passcode',
    });
    return result.success;
  }

  if (Platform.OS === 'android') {
    // Delegate to the native module, which triggers BiometricPrompt with
    // BIOMETRIC_STRONG and opens the KeyStore's duration-based validity
    // window. See ProvianSecureEnclaveP256Module.authenticateForSigning.
    return KeyManager.authenticateForSigning(reason);
  }

  // Web or other platforms: no hardware gate, allow the batch to proceed.
  return true;
}
