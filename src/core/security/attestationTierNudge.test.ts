import { describe, expect, it } from 'vitest';
import {
    ATTESTATION_TIER_NUDGE_KEY,
    dismissAttestationNudge,
    shouldShowAttestationNudge,
    type NudgeStorage,
} from './attestationTierNudge';

function makeStorage(initial: Record<string, string> = {}): NudgeStorage & {
    state: Record<string, string>;
} {
    const state: Record<string, string> = { ...initial };
    return {
        state,
        async getItem(key) {
            return key in state ? state[key] : null;
        },
        async setItem(key, value) {
            state[key] = value;
        },
    };
}

describe('shouldShowAttestationNudge', () => {
    it('never shows on iOS, regardless of flag state', async () => {
        const empty = makeStorage();
        const flagged = makeStorage({ [ATTESTATION_TIER_NUDGE_KEY]: '1' });
        expect(await shouldShowAttestationNudge('ios', empty)).toBe(false);
        expect(await shouldShowAttestationNudge('ios', flagged)).toBe(false);
    });

    it('shows on Android when the dismiss flag is absent', async () => {
        const empty = makeStorage();
        expect(await shouldShowAttestationNudge('android', empty)).toBe(true);
    });

    it('does not show on Android once the flag is set', async () => {
        const flagged = makeStorage({ [ATTESTATION_TIER_NUDGE_KEY]: '1' });
        expect(await shouldShowAttestationNudge('android', flagged)).toBe(false);
    });

    it('treats any flag value other than "1" as undismissed (defensive)', async () => {
        const odd = makeStorage({ [ATTESTATION_TIER_NUDGE_KEY]: '0' });
        expect(await shouldShowAttestationNudge('android', odd)).toBe(true);
    });
});

describe('dismissAttestationNudge', () => {
    it('writes "1" under the flag key', async () => {
        const storage = makeStorage();
        await dismissAttestationNudge(storage);
        expect(storage.state[ATTESTATION_TIER_NUDGE_KEY]).toBe('1');
    });

    it('is idempotent', async () => {
        const storage = makeStorage();
        await dismissAttestationNudge(storage);
        await dismissAttestationNudge(storage);
        expect(storage.state[ATTESTATION_TIER_NUDGE_KEY]).toBe('1');
    });

    it('flips a future shouldShow result to false', async () => {
        const storage = makeStorage();
        expect(await shouldShowAttestationNudge('android', storage)).toBe(true);
        await dismissAttestationNudge(storage);
        expect(await shouldShowAttestationNudge('android', storage)).toBe(false);
    });
});
