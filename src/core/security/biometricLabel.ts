/**
 * biometricLabel - Runtime-resolved label for the user's biometric method.
 *
 * CAVEAT on expo-local-authentication.supportedAuthenticationTypesAsync():
 * it returns what the device's HARDWARE supports, not what the user has
 * actually enrolled. Most modern Android phones have face-capable front
 * cameras in hardware and will report FACIAL_RECOGNITION even when the
 * user only has fingerprint enrolled - and even when the face biometric
 * on that device is BIOMETRIC_WEAK (too weak to unlock our KeyStore keys,
 * which require BIOMETRIC_STRONG).
 *
 * Platform-specific ordering:
 * - iOS: Face ID > Touch ID. Apple devices with Face ID hardware invariably
 *   have it enrolled; the trademark is well-known; BIOMETRIC_STRONG is
 *   guaranteed. Face-first is correct.
 * - Android: Fingerprint > face. Fingerprint is more commonly enrolled and,
 *   critically, it's what BIOMETRIC_STRONG actually resolves to on the vast
 *   majority of devices. Face unlock on Android is usually WEAK and wouldn't
 *   unlock the signing key even if enrolled. Fingerprint-first matches the
 *   biometric the user will actually use to sign.
 *
 * Proper enrollment detection would require a native BiometricManager
 * .canAuthenticate(BIOMETRIC_STRONG) call. Until we ship that, the
 * platform-specific ordering above gets it right on the common case.
 */

import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { translate } from '../../i18n/translate';

export type BiometricMethod = 'face' | 'fingerprint' | 'iris' | 'none';

export interface BiometricLabel {
  method: BiometricMethod;
  /** Capitalised for start-of-sentence use: "Face ID", "Fingerprint", "Biometric". */
  label: string;
  /** Lowercased for mid-sentence use: "Face ID", "your fingerprint", "biometric unlock". */
  phrase: string;
}

const fallbackLabel = (): BiometricLabel => ({
  method: 'none',
  label: translate('biometricLabel.biometric', 'Biometric'),
  phrase: translate('biometricLabel.biometricPhrase', 'biometric unlock'),
});

/**
 * Resolve the user's current biometric method. Returns a fallback label if
 * nothing is enrolled or the platform can't report it.
 */
export async function resolveBiometricLabel(): Promise<BiometricLabel> {
  try {
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    const hasFace = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);
    const hasFinger = types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT);
    const hasIris = types.includes(LocalAuthentication.AuthenticationType.IRIS);

    // iOS: Face ID > Touch ID (hardware Face ID is always enrolled; Apple's
    // trademark ordering matches user expectation).
    if (Platform.OS === 'ios') {
      if (hasFace) {
        return { method: 'face', label: 'Face ID', phrase: 'Face ID' };
      }
      if (hasFinger) {
        return { method: 'fingerprint', label: 'Touch ID', phrase: 'Touch ID' };
      }
      if (hasIris) {
        return { method: 'iris', label: translate('biometricLabel.irisUnlock', 'Iris unlock'), phrase: translate('biometricLabel.irisUnlockPhrase', 'iris unlock') };
      }
      return fallbackLabel();
    }

    // Android: prefer fingerprint. Reasons documented at top of file - most
    // Android "face capability" is hardware-only (camera exists) or
    // BIOMETRIC_WEAK (too weak to unlock KeyStore keys bound to
    // BIOMETRIC_STRONG). Fingerprint is what actually signs.
    if (Platform.OS === 'android') {
      if (hasFinger) {
        return { method: 'fingerprint', label: translate('biometricLabel.fingerprint', 'Fingerprint'), phrase: translate('biometricLabel.fingerprintPhrase', 'your fingerprint') };
      }
      if (hasFace) {
        return { method: 'face', label: translate('biometricLabel.faceUnlock', 'Face unlock'), phrase: translate('biometricLabel.faceUnlockPhrase', 'face unlock') };
      }
      if (hasIris) {
        return { method: 'iris', label: translate('biometricLabel.irisUnlock', 'Iris unlock'), phrase: translate('biometricLabel.irisUnlockPhrase', 'iris unlock') };
      }
      return fallbackLabel();
    }

    // Web or other platforms
    return fallbackLabel();
  } catch {
    return fallbackLabel();
  }
}

/**
 * React hook returning the resolved biometric label. While resolution is in
 * flight, returns the generic Biometric fallback so UI doesn't flicker.
 */
export function useBiometricLabel(): BiometricLabel {
  const [label, setLabel] = useState<BiometricLabel>(fallbackLabel);

  useEffect(() => {
    let cancelled = false;
    resolveBiometricLabel().then(resolved => {
      if (!cancelled) setLabel(resolved);
    });
    return () => { cancelled = true; };
  }, []);

  return label;
}
