import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as LocalAuthentication from 'expo-local-authentication';
import { requireBiometric, BiometricAuthError, authenticateBiometricAction, enableBiometricFallback, clearBiometricFallback } from './requireBiometric';

describe('requireBiometric - distinct action serialization', () => {
    beforeEach(async () => {
        await clearBiometricFallback();
        vi.restoreAllMocks();
        vi.spyOn(LocalAuthentication, 'hasHardwareAsync').mockResolvedValue(true);
        vi.spyOn(LocalAuthentication, 'isEnrolledAsync').mockResolvedValue(true);
    });

    it('two concurrent actions each authenticate once, without overlapping prompts', async () => {
        const authSpy = vi
            .spyOn(LocalAuthentication, 'authenticateAsync')
            .mockResolvedValue({ success: true });

        // Fire both in the same tick - the launch race.
        const a = requireBiometric('Unlock Provian Wallet');
        const b = requireBiometric('Reconnect to Provian relay');

        await expect(a).resolves.toBe(true);
        await expect(b).resolves.toBe(true);
        expect(authSpy).toHaveBeenCalledTimes(2);
    });

    it('a later sequential call prompts again (guard resets after completion)', async () => {
        const authSpy = vi
            .spyOn(LocalAuthentication, 'authenticateAsync')
            .mockResolvedValue({ success: true });

        await expect(requireBiometric('first')).resolves.toBe(true);
        await expect(requireBiometric('second')).resolves.toBe(true);

        expect(authSpy).toHaveBeenCalledTimes(2);
    });

    it('each concurrent action receives its own cancellation', async () => {
        const authSpy = vi
            .spyOn(LocalAuthentication, 'authenticateAsync')
            .mockResolvedValue({ success: false, error: 'user_cancel' });

        const a = requireBiometric('Unlock Provian Wallet').catch((e) => e);
        const b = requireBiometric('Reconnect to Provian relay').catch((e) => e);

        const [ra, rb] = await Promise.all([a, b]);
        expect(ra).toBeInstanceOf(BiometricAuthError);
        expect(rb).toBeInstanceOf(BiometricAuthError);
        expect(authSpy).toHaveBeenCalledTimes(2);
    });
    it('wallet replacement preserves biometric-only policy even for a passcode-fallback wallet', async () => {
        await enableBiometricFallback();
        const native = vi.fn(async (allowPasscode: boolean) => allowPasscode);
        await expect(authenticateBiometricAction(native)).resolves.toBe(true);
        await expect(authenticateBiometricAction(native, true)).resolves.toBe(false);
        expect(native.mock.calls).toEqual([[true], [false]]);
        vi.spyOn(LocalAuthentication, 'hasHardwareAsync').mockResolvedValue(false);
        await expect(authenticateBiometricAction(native, true)).rejects.toMatchObject({ code: 'BIOMETRIC_NOT_AVAILABLE' });
        expect(native).toHaveBeenCalledTimes(2);
        await expect(requireBiometric('replace', true)).rejects.toMatchObject({ code: 'BIOMETRIC_NOT_AVAILABLE' });
        await clearBiometricFallback();
    });

});
