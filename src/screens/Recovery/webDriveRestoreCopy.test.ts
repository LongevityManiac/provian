/**
 * On the web the Drive restore card speaks of Google only: the web app backs up to Google Drive,
 * never to iCloud, so "the same Apple or Google account" was wrong there. Every one of the 12
 * locales carries the web line, and none of them names Apple or iCloud.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const LOCALES_DIR = resolve(__dirname, '../../i18n/locales');
const SCREEN = readFileSync(resolve(__dirname, 'RecoveryStartScreen.tsx'), 'utf8');
const locales = readdirSync(LOCALES_DIR).filter(f => /^[a-z]{2}\.json$/.test(f));

export function driveCopyProblems(locale: string, value: unknown): string[] {
    if (typeof value !== 'string' || !value.trim()) return [`${locale}: missing`];
    const problems: string[] = [];
    if (/apple|icloud|アップル/i.test(value)) problems.push(`${locale}: names Apple or iCloud`);
    if (!/google/i.test(value)) problems.push(`${locale}: does not name Google`);
    return problems;
}

describe('web Drive restore card', () => {
    it('the screen shows the web line on the web and the phone line elsewhere', () => {
        expect(SCREEN).toContain("Platform.OS === 'web' ? t('webApp.restore.driveDesc') : t('recoveryStart.cloudDesc')");
    });

    it('all 12 locales say Google only', () => {
        expect(locales).toHaveLength(12);
        const problems = locales.flatMap(file => {
            const d = JSON.parse(readFileSync(resolve(LOCALES_DIR, file), 'utf8')) as { webApp?: { restore?: { driveDesc?: unknown } } };
            return driveCopyProblems(file, d.webApp?.restore?.driveDesc);
        });
        expect(problems).toEqual([]);
    });

    it('RED: the phone line, which names Apple, is caught', () => {
        const en = JSON.parse(readFileSync(resolve(LOCALES_DIR, 'en.json'), 'utf8')) as { recoveryStart: { cloudDesc: string } };
        expect(driveCopyProblems('en.json', en.recoveryStart.cloudDesc)).toContain('en.json: names Apple or iCloud');
        expect(driveCopyProblems('xx.json', undefined)).toEqual(['xx.json: missing']);
    });
});
