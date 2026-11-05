/**
 * the `agentApprovals` notification preference was renamed to
 * `agentActivity` (notifications about the human's linked agents). A device
 * that persisted the old key must keep its choice on upgrade. Pure-function
 * test over the merge the service runs in loadPreferences().
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('expo-notifications', () => ({
    setNotificationHandler: vi.fn(),
    addNotificationReceivedListener: vi.fn(),
    addNotificationResponseReceivedListener: vi.fn(),
    addPushTokenListener: vi.fn(),
    getPermissionsAsync: vi.fn(),
    requestPermissionsAsync: vi.fn(),
    getExpoPushTokenAsync: vi.fn(),
    setNotificationChannelAsync: vi.fn(),
    scheduleNotificationAsync: vi.fn(),
    AndroidImportance: { MAX: 5, HIGH: 4, DEFAULT: 3 },
    SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: null, easConfig: null } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock('../../core/network/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../../store/walletStore', () => ({ useWalletStore: { getState: () => ({ isAuthenticated: false }) } }));
vi.mock('../../navigation/pendingProtectedNav', () => ({ stashProtectedNav: vi.fn() }));

import { mergeStoredNotificationPreferences } from '../NotificationService';

describe('agentActivity preference — legacy agentApprovals migration ', () => {
    it('seeds agentActivity from a stored legacy agentApprovals=false', () => {
        const prefs = mergeStoredNotificationPreferences({ agentApprovals: false });
        expect(prefs.agentActivity).toBe(false);
        expect(prefs).not.toHaveProperty('agentApprovals');
    });

    it('seeds agentActivity from a stored legacy agentApprovals=true', () => {
        const prefs = mergeStoredNotificationPreferences({ agentApprovals: true, priceAlerts: true });
        expect(prefs.agentActivity).toBe(true);
        expect(prefs.priceAlerts).toBe(true);
    });

    // Negative control: a device that has already stored the new key must NOT
    // have it overwritten by a stale legacy value.
    it('a stored agentActivity wins over a stale legacy agentApprovals', () => {
        const prefs = mergeStoredNotificationPreferences({ agentApprovals: false, agentActivity: true });
        expect(prefs.agentActivity).toBe(true);
        const inverse = mergeStoredNotificationPreferences({ agentApprovals: true, agentActivity: false });
        expect(inverse.agentActivity).toBe(false);
    });

    it('ignores a non-boolean legacy value and falls back to the default (on)', () => {
        const prefs = mergeStoredNotificationPreferences({ agentApprovals: 'yes' });
        expect(prefs.agentActivity).toBe(true);
    });

    it('defaults agentActivity on when nothing is stored', () => {
        expect(mergeStoredNotificationPreferences({}).agentActivity).toBe(true);
    });
});
