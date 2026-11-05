import { describe, expect, it } from 'vitest';
import { walletCreateFailureKey } from './walletCreateFailureText';

describe('a failed wallet creation reads in plain words', () => {
    it('an Android phone with no screen lock is told to set one (the keystore message seen on an emulator)', () => {
        expect(walletCreateFailureKey(new Error("Call to function 'ProvianSecureSeed.beginActionAsync' has been rejected. → Caused by: setItem failed: java.lang.IllegalStateException: Secure lock screen must be enabled to create keys requiring user authentication")))
            .toBe('biometricSetup.errorNoScreenLock');
    });

    it('an iPhone with no passcode fails authentication first and reads as the plain generic message', () => {
        // What requireBiometric throws when evaluatePolicy fails (ProvianSecureSeedModule.swift).
        expect(walletCreateFailureKey(new Error('ERR_SEED_AUTH_FAILED'))).toBe('biometricSetup.errorCreateFailed');
    });

    it('RED: anything else is the plain generic message, never the raw text', () => {
        expect(walletCreateFailureKey(new Error('SecItemAdd failed with OSStatus -34018'))).toBe('biometricSetup.errorCreateFailed');
        expect(walletCreateFailureKey(undefined)).toBe('biometricSetup.errorCreateFailed');
    });
});

describe('the setup screen shows the plain message', () => {
    it('RED: the screen never shows the raw error text', async () => {
        const { readFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const screen = readFileSync(resolve(__dirname, '../../screens/Onboarding/BiometricSetupScreen.tsx'), 'utf8');
        expect(screen).toContain('setError(t(walletCreateFailureKey(err)));');
        expect(screen).not.toMatch(/setError\(msg\b/);
    });
});
