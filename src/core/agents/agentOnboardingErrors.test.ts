import { describe, it, expect } from 'vitest';
import {
    mapAgentOnboardingError,
    formatAgentOnboardingError,
} from './agentOnboardingErrors';

/**
 * the operator’s requirement #3: no raw errors in the onboarding flow. Every mapping
 * must yield a plain-English sentence + a next action, and NEVER echo the raw
 * machine code. The RED controls below feed the mapper the exact resolver
 * strings the flow must never surface and assert they are humanised, plus an
 * unknown code that must fall back (not leak).
 */

const RAW_CODES = [
    'no_recovery_escrow',
    'not_your_linked_agent',
    'anchor_secret_not_found',
    'cloud_backup_unavailable',
    'anchor_backup_not_synced',
    'connection_token_issuer_unresolved',
    'missing wallet auth token',
];

describe('mapAgentOnboardingError — no raw errors (requirement #3)', () => {
    it('maps every known code to a sentence + action and NEVER echoes the raw code', () => {
        for (const code of RAW_CODES) {
            const { message, action } = mapAgentOnboardingError(code);
            expect(message.length).toBeGreaterThan(0);
            expect(action.length).toBeGreaterThan(0);
            // The humanised text must not contain the machine token.
            expect(`${message} ${action}`.toLowerCase()).not.toContain(code.toLowerCase());
        }
    });

    it('gives distinct, specific messages for the recovery-flow codes', () => {
        expect(mapAgentOnboardingError('no_recovery_escrow').message)
            .not.toBe(mapAgentOnboardingError('not_your_linked_agent').message);
        expect(mapAgentOnboardingError('cloud_backup_unavailable').message)
            .not.toBe(mapAgentOnboardingError('anchor_secret_not_found').message);
    });

    it('resolves a code even when wrapped in an HTTP-shaped string', () => {
        const wrapped = mapAgentOnboardingError('HTTP 404: no_recovery_escrow');
        expect(wrapped).toEqual(mapAgentOnboardingError('no_recovery_escrow'));
    });

    it('reads the code off an Error and off an { error } object', () => {
        const fromError = mapAgentOnboardingError(new Error('not_your_linked_agent'));
        expect(fromError).toEqual(mapAgentOnboardingError('not_your_linked_agent'));
        const fromObj = mapAgentOnboardingError({ error: 'cloud_backup_unavailable' });
        expect(fromObj).toEqual(mapAgentOnboardingError('cloud_backup_unavailable'));
    });

    it('surfaces the xchacha AEAD failure as a wrong-key message, not a stack', () => {
        const { message } = mapAgentOnboardingError(new Error('invalid tag'));
        expect(message.toLowerCase()).toContain("doesn't match");
        expect(message).not.toContain('invalid tag');
    });

    it('RED CONTROL: an unknown code falls back to a safe generic sentence (never leaks)', () => {
        const unknown = mapAgentOnboardingError('kaboom_internal_9f2a');
        expect(unknown.message).toContain("Something went wrong");
        expect(`${unknown.message} ${unknown.action}`).not.toContain('kaboom_internal_9f2a');
    });

    it('RED CONTROL: empty / null / undefined inputs still yield the generic fallback', () => {
        const generic = mapAgentOnboardingError('kaboom_internal_9f2a');
        expect(mapAgentOnboardingError('')).toEqual(generic);
        expect(mapAgentOnboardingError(null)).toEqual(generic);
        expect(mapAgentOnboardingError(undefined)).toEqual(generic);
        expect(mapAgentOnboardingError({})).toEqual(generic);
    });

    it('formatAgentOnboardingError joins message + action into one display string', () => {
        const { message, action } = mapAgentOnboardingError('no_recovery_escrow');
        expect(formatAgentOnboardingError('no_recovery_escrow')).toBe(`${message} ${action}`);
    });
});
