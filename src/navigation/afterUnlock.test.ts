import { afterEach, describe, expect, it } from 'vitest';
import { landAfterUnlock, type UnlockNavigation } from './afterUnlock';
import { consumeProtectedNav, peekProtectedNav, stashProtectedNav } from './pendingProtectedNav';

type Step = { op: 'auth' } | { op: 'reset'; routes: string[] } | { op: 'navigate'; screen: string; params?: Record<string, unknown> };

function harness() {
    const steps: Step[] = [];
    let stashAtAuth: unknown = 'unset';
    const navigation: UnlockNavigation = {
        reset: (state) => { steps.push({ op: 'reset', routes: state.routes.map((r) => r.name) }); },
        navigate: (screen, params) => { steps.push({ op: 'navigate', screen, params }); },
    };
    const authenticate = () => {
        // What AppNavigator's replay effect would find the moment isAuthenticated flips.
        stashAtAuth = peekProtectedNav();
        steps.push({ op: 'auth' });
    };
    return { steps, navigation, authenticate, stashAtAuth: () => stashAtAuth };
}

afterEach(() => { consumeProtectedNav(); });

describe('landAfterUnlock — a notification tapped while locked survives the unlock', () => {
    it('takes the stash before isAuthenticated flips, resets to the app, then opens the thread on top', () => {
        stashProtectedNav({ screen: 'CommonsThread', params: { threadId: 'thr_1' } });
        const h = harness();
        landAfterUnlock(h.navigation, 'app', h.authenticate);
        // Nothing left for the replay effect to race the reset with.
        expect(h.stashAtAuth()).toBeNull();
        expect(h.steps).toEqual([
            { op: 'auth' },
            { op: 'reset', routes: ['MainTabs'] },
            { op: 'navigate', screen: 'CommonsThread', params: { threadId: 'thr_1' } },
        ]);
        expect(peekProtectedNav()).toBeNull();
    });

    it('a plain unlock with nothing stashed only resets to the app', () => {
        const h = harness();
        landAfterUnlock(h.navigation, 'app', h.authenticate);
        expect(h.steps).toEqual([{ op: 'auth' }, { op: 'reset', routes: ['MainTabs'] }]);
    });

    it('a required backup, seed restore or terms review comes first: the tapped screen never opens over it or races it', () => {
        for (const [gate, routes] of [['backup', ['CloudBackupConfirm']], ['restore', ['MainTabs', 'RecoveryStart']], ['terms', ['Consent']]] as const) {
            stashProtectedNav({ screen: 'CommonsThread', params: { threadId: 'thr_2' } });
            const h = harness();
            landAfterUnlock(h.navigation, gate, h.authenticate);
            // Nothing for the replay effect to open when isAuthenticated flips…
            expect(h.stashAtAuth()).toBeNull();
            // …and nothing opened by the unlock itself: only the required screen.
            expect(h.steps).toEqual([{ op: 'auth' }, { op: 'reset', routes: [...routes] }]);
            expect(peekProtectedNav()).toBeNull();
        }
    });
});
