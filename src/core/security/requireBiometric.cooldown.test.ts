/**
 * [Audit Pass-3 #24] Biometric CANCEL must not arm the failure cooldown.
 *
 * Bug: requireBiometric counted ANY non-success (including a deliberate
 * `user_cancel`) toward a module-GLOBAL cooldown. Three cancels of a low-stakes
 * dApp signature therefore armed a cooldown that then blocked a DIFFERENT gate
 * (wallet unlock) — a cross-gate DoS. The fix treats user/system/app cancel as
 * neutral: it still throws BiometricAuthError (aborting the operation) but never
 * increments the failure counter. Genuine failed matches still arm the cooldown.
 *
 * Each test loads a fresh module copy so the module-global counter starts clean.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockAuthenticate = vi.fn();
const mockHasHardware = vi.fn(async () => true);
const mockIsEnrolled = vi.fn(async () => true);

vi.mock('expo-local-authentication', () => ({
    hasHardwareAsync: () => mockHasHardware(),
    isEnrolledAsync: () => mockIsEnrolled(),
    authenticateAsync: (opts: unknown) => mockAuthenticate(opts),
}));

// Force the strict hardware path (not the passcode-fallback wallet mode).
vi.mock('./hmacAsyncStorage', () => ({
    getItemHmac: vi.fn(async () => false),
    setItemHmac: vi.fn(async () => {}),
    removeItemHmac: vi.fn(async () => {}),
}));

async function loadFresh() {
    vi.resetModules();
    return import('./requireBiometric');
}

beforeEach(() => {
    vi.clearAllMocks();
    mockHasHardware.mockResolvedValue(true);
    mockIsEnrolled.mockResolvedValue(true);
});

describe('requireBiometric cooldown — cancel vs failure (#24)', () => {
    it('three user_cancel dismissals do NOT arm the cooldown; the next unlock still prompts', async () => {
        const { requireBiometric, BiometricAuthError } = await loadFresh();

        mockAuthenticate.mockResolvedValue({ success: false, error: 'user_cancel' });
        for (let i = 0; i < 3; i++) {
            await expect(requireBiometric('dApp signature')).rejects.toBeInstanceOf(BiometricAuthError);
        }

        // 4th call (e.g. wallet unlock) must still reach the OS prompt — no cooldown.
        mockAuthenticate.mockResolvedValueOnce({ success: true });
        await expect(requireBiometric('Unlock Provian Wallet')).resolves.toBe(true);
        expect(mockAuthenticate).toHaveBeenCalledTimes(4);
    });

    it('three genuine failed matches DO arm the cooldown; the next attempt is rate-limited without prompting', async () => {
        const { requireBiometric, BiometricAuthError, BiometricRateLimitError } = await loadFresh();

        mockAuthenticate.mockResolvedValue({ success: false, error: 'authentication_failed' });
        for (let i = 0; i < 3; i++) {
            await expect(requireBiometric('Unlock Provian Wallet')).rejects.toBeInstanceOf(BiometricAuthError);
        }

        mockAuthenticate.mockClear();
        await expect(requireBiometric('Unlock Provian Wallet')).rejects.toBeInstanceOf(BiometricRateLimitError);
        // Rate-limited BEFORE prompting — the OS is never invoked.
        expect(mockAuthenticate).not.toHaveBeenCalled();
    });

    it('cancels interleaved with failures never contribute to the threshold', async () => {
        const { requireBiometric, BiometricAuthError, BiometricRateLimitError } = await loadFresh();

        // 2 genuine failures + many cancels: cancels add nothing, so no cooldown yet.
        mockAuthenticate.mockResolvedValueOnce({ success: false, error: 'authentication_failed' });
        await expect(requireBiometric('x')).rejects.toBeInstanceOf(BiometricAuthError);
        mockAuthenticate.mockResolvedValueOnce({ success: false, error: 'authentication_failed' });
        await expect(requireBiometric('x')).rejects.toBeInstanceOf(BiometricAuthError);
        for (let i = 0; i < 5; i++) {
            mockAuthenticate.mockResolvedValueOnce({ success: false, error: 'user_cancel' });
            await expect(requireBiometric('x')).rejects.toBeInstanceOf(BiometricAuthError);
        }
        // Still only 2 real failures on record — a success still works (would be
        // rate-limited if the cancels had counted).
        mockAuthenticate.mockResolvedValueOnce({ success: true });
        await expect(requireBiometric('Unlock')).resolves.toBe(true);

        // Now prove the 3rd genuine failure (after the success reset it takes 3
        // again) arms the cooldown as designed.
        mockAuthenticate.mockResolvedValue({ success: false, error: 'authentication_failed' });
        for (let i = 0; i < 3; i++) {
            await expect(requireBiometric('x')).rejects.toBeInstanceOf(BiometricAuthError);
        }
        await expect(requireBiometric('x')).rejects.toBeInstanceOf(BiometricRateLimitError);
    });
});
