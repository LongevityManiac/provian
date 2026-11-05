/**
 * screenshot fixes on the Connect-an-agent screen.
 *
 * Fix 4: "PROV-QMJN-ZM6K" wrapped on a 320dp Android phone, leaving a lone "K" on the second line.
 * The code renders on ONE line and shrinks to fit.
 * Fix 8: the "already connected" banner said "connect another agent below" while the command it
 * points at sits ABOVE it. Every locale now points up.
 *
 * RED baseline: against the pre-change tree the token Text carried no numberOfLines /
 * adjustsFontSizeToFit, and every locale's alreadyConnectedBody carried its "below" wording
 * (pinned in PRE_FIX_BELOW so a revert of any single locale goes red).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const screenSrc = readFileSync(resolve(__dirname, 'ConnectAgentScreen.tsx'), 'utf8');
const localesDir = resolve(__dirname, '../../i18n/locales');
const localeFiles = readdirSync(localesDir).filter((f) => f.endsWith('.json'));

/** The pre- "below" fragment of each locale's alreadyConnectedBody. */
const PRE_FIX_BELOW: Record<string, string> = {
    en: 'connect another agent below',
    es: 'conectar otro agente abajo',
    fr: 'un autre agent ci-dessous',
    hi: 'इसलिए आप नीचे एक और एजेंट',
    id: 'agen lain di bawah',
    ja: '下から別のエージェント',
    ko: '아래에서 다른 에이전트',
    pt: 'outro agente abaixo',
    sw: 'wakala mwingine hapa chini',
    tl: 'ibang ahente sa ibaba',
    vi: 'tác nhân khác bên dưới',
    zh: '在下方连接',
};

describe('connection code stays on one line (fix 4)', () => {
    it('the token Text is single-line and shrinks to fit', () => {
        const i = screenSrc.indexOf('{token.token}');
        expect(i).toBeGreaterThan(0);
        const textOpen = screenSrc.lastIndexOf('<Text', i);
        const tag = screenSrc.slice(textOpen, i);
        expect(tag).toContain('style={styles.tokenText}');
        expect(tag).toContain('numberOfLines={1}');
        expect(tag).toContain('adjustsFontSizeToFit');
        expect(tag).toMatch(/minimumFontScale=\{0\.\d+\}/);
    });
});

describe('"already connected" copy points at the command ABOVE it (fix 8)', () => {
    it('the banner renders after the one-command card (so "above" is the true direction)', () => {
        const cmd = screenSrc.indexOf("t('connectAgent.oneCommandLabel')");
        const banner = screenSrc.indexOf("t('connectAgent.alreadyConnectedBody')");
        expect(cmd).toBeGreaterThan(0);
        expect(banner).toBeGreaterThan(cmd);
    });

    it('every locale (12 of 12) drops its "below" wording; English says "the command above"', () => {
        let checked = 0;
        for (const f of localeFiles) {
            const loc = f.replace(/\.json$/, '');
            const body = (JSON.parse(readFileSync(resolve(localesDir, f), 'utf8')) as {
                connectAgent: { alreadyConnectedBody: string };
            }).connectAgent.alreadyConnectedBody;
            expect(PRE_FIX_BELOW[loc], `no pre-fix pin for ${loc}`).toBeDefined();
            expect(body, loc).not.toContain(PRE_FIX_BELOW[loc]);
            if (loc === 'en') {
                expect(body).toContain('with the command above');
                expect(body).not.toMatch(/\bbelow\b/);
            }
            checked++;
        }
        // Not vacuous: all 12 locale files evaluated.
        expect(checked).toBe(12);
    });
});
