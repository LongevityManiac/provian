import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openBehindLock } from './openBehindLock';
import type { ProtectedNavTarget } from './pendingProtectedNav';

function harness() {
    const opened: Array<{ screen: string; params?: Record<string, unknown> }> = [];
    const held: ProtectedNavTarget[] = [];
    return {
        opened, held,
        navigation: { navigate: (screen: string, params?: Record<string, unknown>) => { opened.push({ screen, params }); } },
        stash: (target: ProtectedNavTarget) => { held.push(target); },
    };
}
const PROMISE: ProtectedNavTarget = { screen: 'PromiseDetail', params: { promiseId: 'p1', openedAt: 1 } };

describe('openBehindLock — a deep link never opens its screen over the lock', () => {
    it('locked: the screen is held and only the lock screen is shown', () => {
        const h = harness();
        openBehindLock(h.navigation, false, PROMISE, h.stash);
        expect(h.opened).toEqual([{ screen: 'WalletLock', params: undefined }]);
        expect(h.held).toEqual([PROMISE]);
    });

    it('unlocked: the screen opens at once and nothing is held', () => {
        const h = harness();
        openBehindLock(h.navigation, true, PROMISE, h.stash);
        expect(h.opened).toEqual([PROMISE]);
        expect(h.held).toEqual([]);
    });
});

describe('AppNavigator opens a promise link only through openBehindLock', () => {
    const src = readFileSync(resolve(__dirname, 'AppNavigator.tsx'), 'utf8');
    /** Direct opens of the promise screen: each one would land over a locked wallet. */
    const directOpens = (text: string): number => (text.match(/\.navigate\('PromiseDetail'/g) ?? []).length;

    it('no direct navigate to PromiseDetail remains', () => {
        expect(directOpens(src)).toBe(0);
    });

    it('both promise-link opens (the link, and its replay after onboarding) pass the live lock state', () => {
        const guarded = src.match(/openBehindLock\(\s*navigationRef\.current as LockAwareNavigation,\s*useWalletStore\.getState\(\)\.isAuthenticated === true,\s*\{ screen: 'PromiseDetail',/g) ?? [];
        expect(guarded.length).toBe(2);
    });

    it('control: the scan detects a direct open', () => {
        expect(directOpens("navigationRef.current.navigate('PromiseDetail', { promiseId: imported.id });")).toBe(1);
    });
});
