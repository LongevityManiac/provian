/**
 * Two-sim proof against the deployed relay (2026-10-17): the detail screen synced its promise to
 * `countered` and then kept showing "Waiting for Bob". A relay sync updates the stored record in
 * place; `loadPromise` handed React that same object again, so nothing re-rendered.
 *
 * The Vitest harness has no React renderer, so this pins the fix at the source level (the same
 * strategy as PromiseSettlementGating.source.test.ts): every `setPromise` in the screen receives a
 * copy, never the stored record.
 *
 * RED control: restore `setPromise(data);` in loadPromise and the first case fails.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DETAIL = readFileSync(resolve(__dirname, 'PromiseDetailScreen.tsx'), 'utf8');

describe('PromiseDetailScreen re-renders after a relay sync', () => {
    it('loadPromise hands React a copy of the stored record', () => {
        const start = DETAIL.indexOf('const loadPromise = async');
        const end = DETAIL.indexOf('};', start);
        expect(start).toBeGreaterThanOrEqual(0);
        const body = DETAIL.slice(start, end);
        expect(body).toContain('setPromise(data ? { ...data } : null)');
        expect(body).not.toMatch(/setPromise\(data\)/);
    });

    it('no setPromise call passes a record through uncopied', () => {
        const calls = DETAIL.match(/setPromise\([^)]*\)/g) ?? [];
        expect(calls.length).toBeGreaterThan(0); // a pass over zero calls proves nothing
        for (const call of calls) expect(call).toMatch(/\{ \.\.\.|null|prev/);
    });
});

// Two-sim proof (2026-10-17): opening the counter's link while the promise was already on screen
// adopted its terms, but navigating to the screen already showing it does not remount it, so the
// screen kept "waiting for the terms". Every open from a link or notification now carries a fresh
// `openedAt`, and the screen reloads when it changes.
// RED control: drop `openedAt: Date.now()` from AppNavigator's promise-link navigate, or the
// `[openedAt]` effect from the screen, and the matching case fails.
const NAVIGATOR = readFileSync(resolve(__dirname, '../../navigation/AppNavigator.tsx'), 'utf8');
const NOTIFICATIONS = readFileSync(resolve(__dirname, '../../services/NotificationService.ts'), 'utf8');

describe('a link or notification for the promise already on screen reloads it', () => {
    it('every app-level open of PromiseDetail carries a fresh openedAt', () => {
        const opens = [
            ...(NAVIGATOR.match(/navigate\('PromiseDetail',[^)]*\)/g) ?? []),
            ...(NOTIFICATIONS.match(/navigateProtected\('PromiseDetail',[^)]*\)/g) ?? []),
        ];
        expect(opens.length).toBe(3); // the link import, its pre-onboarding replay, the notification tap
        for (const open of opens) expect(open).toContain('openedAt: Date.now()');
    });

    it('the screen reloads (after a relay sync) when openedAt changes', () => {
        const start = DETAIL.indexOf('const firstOpen = useRef(openedAt);');
        expect(start).toBeGreaterThanOrEqual(0);
        const effect = DETAIL.slice(start, DETAIL.indexOf('}, [openedAt]);', start) + 15);
        expect(effect).toContain('}, [openedAt]);');
        expect(effect).toContain('syncPendingPromises');
        expect(effect).toContain('await loadPromise()');
    });
});

// Two-sim proof (2026-10-17): a declined counter's timeline row read "Negotiation_rejected".
// RED control: remove the negotiation_rejected branch in renderEvent and this fails.
describe('the timeline never shows a raw event type for a decline', () => {
    it('negotiation_rejected renders the translated "Declined"', () => {
        const start = DETAIL.indexOf('const renderEvent =');
        expect(start).toBeGreaterThanOrEqual(0);
        const body = DETAIL.slice(start, DETAIL.indexOf('styles.eventDate', start));
        expect(body).toMatch(/event\.type === 'negotiation_rejected'\s*\?\s*t\('promise\.declined'\)/);
    });
});
