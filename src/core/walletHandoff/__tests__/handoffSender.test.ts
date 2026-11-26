/**
 * Dismissing the unlock on the sending device returns to the confirm step on the phone and the web;
 * any other failure is reported (RED: a failed match and a relay error are not a cancel).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const unlock = vi.hoisted(() => ({ error: null as unknown }));

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('../../security/biometricAction', () => ({
    withBiometricAction: async () => { throw unlock.error; },
    assertBiometricAction: () => undefined,
}));
vi.mock('../../wallet/SeedManager', () => ({ default: { getMnemonic: async () => null } }));
vi.mock('../../../i18n/translate', () => ({
    translate: (_key: string, english: string, values: Record<string, string> = {}) =>
        english.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => values[name] ?? ''),
}));

import { BiometricAuthError } from '../../security/requireBiometric';
import { takePinForAction } from '../../../platform/web/unlockRequests';
import { HandoffUnlockCancelledError, confirmAndSendWallet, isUnlockCancel } from '../handoffSender';

const session = { id: 'session0000000000000001', token: 't', role: 'creator', mode: 'send', secret: new Uint8Array(32) } as never;
const peer = { device: { label: 'iPhone 15 Pro', platform: 'ios' }, matchCode: '123 456', receiverKey: new Uint8Array(32) } as never;
const relay = { handoffCall: async () => { throw new Error('relay_should_not_be_called'); } } as never;
const send = () => confirmAndSendWallet(relay, session, peer, '0x58a57ed9d8d624cbd12e2c467d34787555bb1b25');

describe('cancelling the unlock on the sending device', () => {
    beforeEach(() => { unlock.error = null; });

    it('every dismissal (web passkey/PIN Cancel, Face ID cancel, system and app dismissals) is a cancel', () => {
        for (const code of ['user_cancel', 'system_cancel', 'app_cancel']) expect(isUnlockCancel(new BiometricAuthError(code))).toBe(true);
        expect(isUnlockCancel(Object.assign(new Error('x'), { code: 'ERR_SEED_AUTH_CANCELLED' }))).toBe(true);
    });

    it('RED: a failed match, an unknown failure and a relay error are not a cancel', () => {
        expect(isUnlockCancel(new BiometricAuthError('authentication_failed'))).toBe(false);
        expect(isUnlockCancel(new BiometricAuthError(undefined))).toBe(false);
        expect(isUnlockCancel(new Error('handoff_expired'))).toBe(false);
        expect(isUnlockCancel(null)).toBe(false);
    });

    it('a cancel comes back as HandoffUnlockCancelledError, and the web asks under the "move" title', async () => {
        unlock.error = new BiometricAuthError('user_cancel');
        await expect(send()).rejects.toBeInstanceOf(HandoffUnlockCancelledError);
        expect(takePinForAction('Confirm to move your wallet to iPhone 15 Pro')).toBe('move');
    });

    it('RED: a failed match shows the app\'s words, not the raw code, and is not a cancel', async () => {
        unlock.error = new BiometricAuthError('authentication_failed');
        const err = await send().then(() => new Error("handoff_sent"), (e: unknown) => e as Error);
        expect(err).not.toBeInstanceOf(HandoffUnlockCancelledError);
        expect(err.message).toBe('Biometric authentication failed.');
    });
});
