import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, Alert: { alert: vi.fn() }, Linking: { openURL: vi.fn() } }));
vi.mock('expo-application', () => ({ nativeBuildVersion: '1', nativeApplicationVersion: '1.0.0' }));
vi.mock('../i18n/translate', () => ({ translate: (_k: string, fallback: string) => fallback }));

import AppUpdateService from './AppUpdateService';

const manifest = {
    latestVersionCode: 99,
    latestVersionName: '9.9.9',
    minimumVersionCode: 1,
    downloadUrl: 'https://provian.ai/download/android',
};

describe('the APK update check runs only in the website APK', () => {
    afterEach(() => {
        delete process.env.EXPO_PUBLIC_DISTRIBUTION;
        vi.unstubAllGlobals();
    });

    it('the website APK checks the manifest and offers the newer APK', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => manifest }));
        vi.stubGlobal('fetch', fetchMock);
        const decision = await AppUpdateService.checkForUpdate();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(decision.kind).not.toBe('up_to_date');
    });

    it('RED: the Play build never checks and is never sent to the website APK', async () => {
        process.env.EXPO_PUBLIC_DISTRIBUTION = 'play';
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => manifest }));
        vi.stubGlobal('fetch', fetchMock);
        expect(await AppUpdateService.checkForUpdate()).toEqual({ kind: 'up_to_date' });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
