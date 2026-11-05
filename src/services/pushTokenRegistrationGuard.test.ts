import { describe, it, expect } from 'vitest';
import { createDeviceTokenGate, normalizeDeviceToken } from './pushTokenRegistrationGuard';

describe('pushTokenRegistrationGuard', () => {
    it('normalizeDeviceToken extracts the token string from a DevicePushToken', () => {
        expect(normalizeDeviceToken({ type: 'ios', data: 'ExponentPushToken[abc]' })).toBe(
            'ExponentPushToken[abc]',
        );
        expect(normalizeDeviceToken('bare-string')).toBe('bare-string');
        // Distinct object shapes normalise to distinct keys; identical shapes match.
        expect(normalizeDeviceToken({ data: { foo: 1 } })).toBe(
            normalizeDeviceToken({ data: { foo: 1 } }),
        );
    });

    // NEGATIVE CONTROL (2026-08-12 incident): this is the exact loop that took the
    // app down. The gate MUST pass the first sight of a token and reject every
    // immediate re-emit of the same value. Without the gate, an emit -> re-mint ->
    // emit echo re-registers on every fire (the 429 storm). Asserting the 2nd
    // identical fire is `false` is what proves the loop is broken — revert
    // createDeviceTokenGate to `() => () => true` and this case goes red.
    it('gates a re-emitted identical device token (breaks the storm loop)', () => {
        const gate = createDeviceTokenGate();
        expect(gate({ type: 'ios', data: 'TOKEN_X' })).toBe(true); // first: register
        expect(gate({ type: 'ios', data: 'TOKEN_X' })).toBe(false); // echo: do nothing
        expect(gate({ type: 'ios', data: 'TOKEN_X' })).toBe(false); // still echoing: nothing
    });

    it('re-registers exactly once on a genuine rotation, then gates its echo', () => {
        const gate = createDeviceTokenGate();
        expect(gate({ data: 'A' })).toBe(true);
        expect(gate({ data: 'A' })).toBe(false);
        expect(gate({ data: 'B' })).toBe(true); // real rotation A -> B
        expect(gate({ data: 'B' })).toBe(false); // echo of B
    });

    it('an emit->remint->emit storm collapses to one registration per distinct token', () => {
        const gate = createDeviceTokenGate();
        let registrations = 0;
        // Model the feedback loop: on the buggy OS each "register" re-emits the SAME
        // device token. Drive 50 echoes; only the first must survive the gate.
        const emit = (t: unknown): void => {
            if (gate(t)) registrations += 1;
        };
        for (let i = 0; i < 50; i++) emit({ type: 'ios', data: 'ECHO' });
        expect(registrations).toBe(1);
    });
});
