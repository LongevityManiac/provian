/**
 * The keep-both alert names a known owner by short address and gives an unknown owner its own
 * sentence, in every locale. Rendered through i18next with the real locale files.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import i18next, { type i18n as I18n } from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import { otherWalletBackupMessage, renderOtherWalletBackupMessage } from './otherWalletBackupCopy';

type Copy = { [key: string]: string | Copy };
const localeDir = resolve(__dirname, '../../i18n/locales');
const LOCALES = readdirSync(localeDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
const resources = Object.fromEntries(LOCALES.map((l) => [l, { translation: JSON.parse(readFileSync(join(localeDir, `${l}.json`), 'utf8')) as Copy }]));
const SCREEN = readFileSync(resolve(__dirname, 'CloudBackupConfirmScreen.tsx'), 'utf8');

const ADDRESS = '0x1234567890abcdef1234567890abcdef1234abcd';
const SHORT = '0x1234…abcd';

let i18n: I18n;
beforeAll(async () => {
    i18n = i18next.createInstance();
    await i18n.init({ resources, lng: 'en', fallbackLng: 'en', interpolation: { escapeValue: false } });
});

const tIn = (lng: string) => (key: string, values?: Record<string, string>) => i18n.t(key, { lng, ...(values ?? {}) });

/** What is wrong with the rendered pair (known, unknown) in one locale. */
function copyProblems(lng: string, known: string, unknown: string): string[] {
    const out: string[] = [];
    const unknownSentence = i18n.t('cloudBackupConfirm.otherWalletMessageUnknown', { lng });
    if (!known.includes(SHORT)) out.push('known owner is not named by its short address');
    if (/\{\{|\}\}/.test(known) || /\{\{|\}\}/.test(unknown)) out.push('an unfilled placeholder is shown');
    if (unknown !== unknownSentence) out.push('unknown owner does not get its own sentence');
    return out;
}

describe('keep-both backup alert copy', () => {
    it('selects the address sentence for a known owner and the dedicated sentence for an unknown one', () => {
        expect(otherWalletBackupMessage(ADDRESS)).toEqual({ key: 'cloudBackupConfirm.otherWalletMessage', values: { address: SHORT } });
        for (const none of [null, undefined, '', '   ']) {
            expect(otherWalletBackupMessage(none)).toEqual({ key: 'cloudBackupConfirm.otherWalletMessageUnknown' });
        }
    });

    it('renders both cases correctly in all 12 locales', () => {
        expect(LOCALES).toHaveLength(12);
        for (const lng of LOCALES) {
            const t = tIn(lng);
            const known = renderOtherWalletBackupMessage(t, ADDRESS);
            const unknown = renderOtherWalletBackupMessage(t, null);
            expect(copyProblems(lng, known, unknown), lng).toEqual([]);
            if (lng !== 'en') expect(unknown, `${lng} is untranslated`).not.toBe(i18n.t('cloudBackupConfirm.otherWalletMessageUnknown', { lng: 'en' }));
        }
    });

    it('the unknown-owner sentence carries no address slot, and the old stand-in key is gone', () => {
        for (const lng of LOCALES) {
            const flat = JSON.stringify(resources[lng].translation);
            expect(flat, lng).not.toContain('"otherWalletUnknown"');
            expect(i18n.t('cloudBackupConfirm.otherWalletMessageUnknown', { lng, address: 'SHOULD_NOT_APPEAR' })).not.toContain('SHOULD_NOT_APPEAR');
        }
    });

    it('the screen renders the alert message through the selector', () => {
        const alert = SCREEN.slice(SCREEN.indexOf('Alert.alert('), SCREEN.indexOf('{ cancelable: false }'));
        expect(alert).toContain('renderOtherWalletBackupMessage(t, err.existingWalletAddress)');
        expect(alert).not.toMatch(/otherWalletMessage', \{ address: /);
    });

    it('RED: the old behaviour, a stand-in noun in the address slot, is caught in every locale', () => {
        for (const lng of LOCALES) {
            const t = tIn(lng);
            const standIn = lng === 'en' ? 'another wallet' : 'X';
            const buggyUnknown = t('cloudBackupConfirm.otherWalletMessage', { address: standIn });
            const known = renderOtherWalletBackupMessage(t, ADDRESS);
            expect(copyProblems(lng, known, buggyUnknown), lng).toContain('unknown owner does not get its own sentence');
        }
        const en = tIn('en');
        // The defect this replaces, verbatim: the stand-in noun read as a wallet name.
        expect(en('cloudBackupConfirm.otherWalletMessage', { address: 'another wallet' })).toContain('for wallet another wallet');
        expect(renderOtherWalletBackupMessage(en, null)).not.toContain('for wallet another wallet');
        // A known owner rendered without its address is caught too.
        expect(copyProblems('en', en('cloudBackupConfirm.otherWalletMessageUnknown'), en('cloudBackupConfirm.otherWalletMessageUnknown')))
            .toContain('known owner is not named by its short address');
    });
});
