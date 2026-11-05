vi.mock('../../security/requireBiometric', () => ({ requireBiometric: seed.requireBiometric }));
vi.mock('../../provenance/PECloudSync', () => ({ default: { getArchiveKeyForBackup: async () => ({saltHex:'00',keyHex:'00'}) } }));
vi.mock('../../commons/threadCrypto', () => ({ getMessageKeyPair: async () => ({}) }));
/**
 * restoreActivityHistory — human-promise restore wiring.
 *
 * The bug this guards (found in the simulator E2E, flow #4): the recovery
 * flow restored PE history but NEVER restored human promises — `restoreFromRelay`
 * was defined and correct (the per-party terms are stored seed-derived on the
 * relay) yet had ZERO callers, so a recovered wallet silently lost its promises
 * and their E2E terms. This suite pins that `restoreActivityHistory('with_session', meter)`
 * now invokes `PromiseService.restoreFromRelay` and that 'skip'/'session_declined'
 * do NOT (no biometric session ⇒ the seed-gated terms cannot be decrypted).
 *
 * RED control : remove the `await safeRestorePromises()` call in
 * restoreActivityHistory.ts and the first test flips to red (restoreFromRelay
 * called 0 times) — verified by hand during authoring. The "best-effort" test is
 * the negative control for the throw path (a promise-restore failure must not
 * change the PE-restore outcome or block wallet access).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { seed, pe, promises, meter } = vi.hoisted(() => ({
    // PE METER: the encrypted file backup's restore (devices' chains + received PEs + activity records).
    meter: vi.fn(async () => ({ found: true, activityRestored: 2, received: 1, devices: [{ imported: 4 }] })),
    seed: { requireBiometric: vi.fn(async () => {}) },
    pe: { restorePEsAfterRecovery: vi.fn(async () => ({ restoredCount: 3, source: 'cloud' as const })) },
    promises: { restoreFromRelay: vi.fn(async () => 2) },
}));

vi.mock('../../wallet/SeedManager', () => ({ default: seed }));
vi.mock('../../provenance/PELifecycleManager', () => ({ default: pe }));
vi.mock('../../promises/PromiseService', () => ({ default: promises }));

import { restoreActivityHistory } from '../restoreActivityHistory';

beforeEach(() => {
    vi.clearAllMocks();
    seed.requireBiometric.mockImplementation(async () => {});
    pe.restorePEsAfterRecovery.mockImplementation(async () => ({ restoredCount: 3, source: 'cloud' as const }));
    promises.restoreFromRelay.mockImplementation(async () => 2);
    meter.mockImplementation(async () => ({ found: true, activityRestored: 2, received: 1, devices: [{ imported: 4 }] }));
});

describe('restoreActivityHistory — promise restore wiring ', () => {
    it('with_session: restores PE history AND human promises (in that order, one session)', async () => {
        const out = await restoreActivityHistory('with_session', meter);

        // PE history restore still happens and drives the returned outcome: the meter's backup
        // (4 chained PEs + 1 received + 2 activity records) plus the pre-meter archives (3).
        expect(out).toEqual({ status: 'restored', restoredCount: 10, source: 'cloud' });
        expect(meter).toHaveBeenCalledTimes(1);
        expect(pe.restorePEsAfterRecovery).toHaveBeenCalledTimes(1);

        // The fix: human promises + their seed-derived terms are restored too.
        expect(promises.restoreFromRelay).toHaveBeenCalledTimes(1);

        // A single biometric session covers both (no second prompt).
        expect(seed.requireBiometric).toHaveBeenCalledTimes(1);
    });

    it('session_declined: does NOT restore promises (no session ⇒ terms undecryptable)', async () => {
        seed.requireBiometric.mockRejectedValueOnce(new Error('declined'));

        const out = await restoreActivityHistory('with_session', meter);

        expect(out).toEqual({ status: 'session_declined' });
        expect(meter).not.toHaveBeenCalled();
        expect(pe.restorePEsAfterRecovery).not.toHaveBeenCalled();
        expect(promises.restoreFromRelay).not.toHaveBeenCalled();
    });

    it('skip: restores nothing (the relay keeps no PEs) and does NOT attempt the seed-gated promise-terms restore', async () => {
        const out = await restoreActivityHistory('skip', meter);

        expect(out).toEqual({ status: 'skipped', restoredCount: 0, source: 'none' });
        expect(meter).not.toHaveBeenCalled();
        expect(pe.restorePEsAfterRecovery).not.toHaveBeenCalled();
        expect(promises.restoreFromRelay).not.toHaveBeenCalled();
    });

    it('best-effort: a meter-backup restore failure still restores the pre-meter archives and never blocks', async () => {
        meter.mockRejectedValueOnce(new Error('icloud offline'));
        const out = await restoreActivityHistory('with_session', meter);
        expect(out).toEqual({ status: 'restored', restoredCount: 3, source: 'cloud' });
    });

    it('best-effort: a promise-restore failure never blocks wallet access or changes the PE outcome', async () => {
        promises.restoreFromRelay.mockRejectedValueOnce(new Error('relay offline'));

        const out = await restoreActivityHistory('with_session', meter);

        // PE restore outcome is unchanged; the throw is swallowed (non-blocking).
        expect(out).toEqual({ status: 'restored', restoredCount: 10, source: 'cloud' });
        expect(promises.restoreFromRelay).toHaveBeenCalledTimes(1);
    });
});
