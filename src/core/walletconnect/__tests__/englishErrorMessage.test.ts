import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../i18n/translate', () => ({
    translate: (key: string) => `localized:${key}`,
}));

import { englishErrorMessage } from '../englishErrorMessage';
import { ProvianReservedMessageError, PROVIAN_RESERVED_USER_MESSAGE } from '../provianReserved';
import { StrongConfirmationRequiredError } from '../strongConfirmation';
import { BiometricSessionRequiredError } from '../../security/biometricAction';
import {
    BiometricAuthError,
    BiometricNotAvailableError,
    BiometricRateLimitError,
} from '../../security/requireBiometric';
import { SeedUnreadableError } from '../../wallet/secureSeedStore';

describe('a failure sent to a dApp or written into a PE stays English', () => {
    const cases: Array<[string, Error, string]> = [
        ['reserved message', new ProvianReservedMessageError('provian_text', 'x'), PROVIAN_RESERVED_USER_MESSAGE],
        ['strong confirmation', new StrongConfirmationRequiredError(), 'This request needs you to type I UNDERSTAND and wait for the cooling-off before approving.'],
        ['biometric session', new BiometricSessionRequiredError(), 'A live biometric action is required to access wallet secrets.'],
        ['biometric auth', new BiometricAuthError(undefined), 'Biometric authentication failed.'],
        ['biometric not enrolled', new BiometricNotAvailableError(true, false), 'No biometric is enrolled on this device. Enable Face ID or fingerprint in your device settings.'],
        ['biometric unsupported', new BiometricNotAvailableError(false, false), 'This device does not support biometric authentication.'],
        ['biometric rate limit', new BiometricRateLimitError(12_400), 'Too many failed attempts. Try again in 13 seconds.'],
        ['seed unreadable', new SeedUnreadableError(), 'Your wallet key on this device cannot be read. Restore it from your cloud backup or recovery phrase.'],
    ];

    it.each(cases)('%s: the screen copy is localized, the wire text is English', (_name, error, english) => {
        expect(error.message.startsWith('localized:')).toBe(true);
        expect(englishErrorMessage(error, 'fallback')).toBe(english);
    });

    it('a plain error passes its own message through, and a non-error uses the fallback', () => {
        expect(englishErrorMessage(new Error('RPC timeout'), 'fallback')).toBe('RPC timeout');
        expect(englishErrorMessage('nope', 'Request failed')).toBe('Request failed');
    });

    it('control: a localized message without englishMessage would reach the wire', () => {
        const localizedOnly = new Error('localized:walletConnect.provianReservedBlocked');
        expect(englishErrorMessage(localizedOnly, 'fallback')).not.toBe(PROVIAN_RESERVED_USER_MESSAGE);
    });
});
