/**
 * rekeyInFlight — the guard that refuses a second re-key. Each assertion ships with its
 * RED control : the "blocked while in flight" and "cooldown after completion" cases would
 * pass vacuously if `checkRekeyBlocked` always returned `{blocked:false}`, so each is paired with a
 * NOT-blocked control (a different wallet, an expired window).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { beginRekey, completeRekey, clearRekey, checkRekeyBlocked } from './rekeyInFlight';

// A fresh in-memory AsyncStorage per test (the stub is a module-level Map, reset by the setup).
describe('rekeyInFlight', () => {
    beforeEach(async () => {
        vi.useRealTimers();
        await clearRekey('w1');
        await clearRekey('w2');
    });

    it('a fresh agent is not blocked (RED control for every blocked case below)', async () => {
        expect(await checkRekeyBlocked('w1')).toEqual({ blocked: false });
    });

    it('blocks a second re-key while one is in flight; a DIFFERENT agent is not blocked (RED control)', async () => {
        await beginRekey('w1');
        expect(await checkRekeyBlocked('w1')).toEqual({ blocked: true, reason: 'in_flight' });
        // RED control: the guard is per-wallet, not global — w2 must be free.
        expect(await checkRekeyBlocked('w2')).toEqual({ blocked: false });
    });

    it('blocks a second re-key during the cooldown after a successful one', async () => {
        await completeRekey('w1');
        expect(await checkRekeyBlocked('w1')).toEqual({ blocked: true, reason: 'cooldown' });
    });

    it('clears on a failed/abandoned re-key so the human can retry immediately', async () => {
        await beginRekey('w1');
        await clearRekey('w1');
        expect(await checkRekeyBlocked('w1')).toEqual({ blocked: false });
    });

    it('fails OPEN after the staleness window so a crashed re-key never permanently blocks recovery', async () => {
        await beginRekey('w1');
        expect(await checkRekeyBlocked('w1')).toEqual({ blocked: true, reason: 'in_flight' });
        // Advance real time past the 15-min in-flight staleness window.
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 16 * 60 * 1000);
        expect(await checkRekeyBlocked('w1')).toEqual({ blocked: false });
    });
});
