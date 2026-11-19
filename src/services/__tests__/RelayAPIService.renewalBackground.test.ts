vi.mock('../../core/protocol/runtime', async () => (await import('../../core/protocol/__test-helpers__/runtime')).protocolRuntimeFixture);
import { describe, expect, it, vi } from 'vitest';

const { listeners } = vi.hoisted(() => ({ listeners: [] as Array<(state: string) => void> }));
vi.mock('react-native', async (original) => ({
    ...(await original<object>()),
    AppState: {
        currentState: 'active',
        addEventListener: (_event: string, fn: (state: string) => void) => { listeners.push(fn); return { remove: () => undefined }; },
    },
}));
vi.mock('../NotificationService', () => ({ default: {} }));

import relayService from '../RelayAPIService';

describe('a pre-signed renewal never outlives its foreground', () => {
    it('is discarded when the app goes to the background, kept on inactive (Face ID)', () => {
        const service = relayService as any;
        expect(listeners.length).toBeGreaterThan(0);
        service.presignedRenewal = { address: '0xaa', body: '{}', usableUntilMs: Date.now() + 60_000 };
        for (const fn of listeners) fn('inactive');
        expect(relayService.hasSessionRenewal()).toBe(true);
        for (const fn of listeners) fn('background');
        expect(relayService.hasSessionRenewal()).toBe(false);
    });
});
