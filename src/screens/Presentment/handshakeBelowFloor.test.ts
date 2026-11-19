import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The relay reads a live handshake whose burn is under the 15 PVT floor as `below_floor`. The
 * requester screen names that state and its burn instead of falling through to "could not read".
 */
const SCREEN = readFileSync(resolve(__dirname, 'PresentationRequesterScreen.tsx'), 'utf8');
const LOCALES = ['en', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt', 'sw', 'tl', 'vi', 'zh'];

describe('the requester screen names a below-floor handshake', () => {
    it('maps below_floor to its own title and body, with the burn and the floor', () => {
        expect(SCREEN).toContain("hsState.state === 'below_floor' ? t('trustLayer.requester.hsBelowFloor')");
        expect(SCREEN).toContain("t('trustLayer.requester.hsBelowFloorBody', { pvt: hsState.belowPvt ?? '?', floor: hsState.floorPvt ?? '15' })");
        expect(SCREEN).toContain('belowPvt: st.below_floor_burn_pvt, floorPvt: st.min_burn_pvt');
    });

    it('every locale carries both strings with the {{pvt}} and {{floor}} slots', () => {
        let checked = 0;
        for (const l of LOCALES) {
            const r = (JSON.parse(readFileSync(resolve(__dirname, `../../i18n/locales/${l}.json`), 'utf8')) as { trustLayer: { requester: Record<string, string> } }).trustLayer.requester;
            expect(r.hsBelowFloor?.trim()).toBeTruthy();
            expect(r.hsBelowFloorBody).toContain('{{pvt}}');
            expect(r.hsBelowFloorBody).toContain('{{floor}}');
            checked += 1;
        }
        expect(checked).toBe(12);
    });

    it('RED control: a screen without the case would fall through to the read-failed text', () => {
        const old = SCREEN.replace(/: hsState\.state === 'below_floor' \? t\('trustLayer\.requester\.hsBelowFloor(Body)?'[^\n]*\n/g, '');
        expect(old).not.toContain("'below_floor'");
    });
});
