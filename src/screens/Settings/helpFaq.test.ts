/**
 * The Help & Support FAQ renders the generated structure: every key it reads exists in every
 * locale, every help.faq key is shown, and the screen holds no hand-written FAQ list.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELP_FAQ } from './helpFaq.generated';
import type { HelpFaqSection } from './helpFaqTypes';

type Copy = { [key: string]: string | Copy };
const localeDir = resolve(__dirname, '../../i18n/locales');
const locales = Object.fromEntries(readdirSync(localeDir).filter((f) => f.endsWith('.json')).map((f) =>
    [f.slice(0, -5), JSON.parse(readFileSync(join(localeDir, f), 'utf8')) as Copy]));
const SCREEN = readFileSync(resolve(__dirname, 'HelpSupportScreen.tsx'), 'utf8');

const lookup = (copy: Copy, key: string): unknown => key.split('.').reduce<unknown>((node, part) =>
    (node && typeof node === 'object' ? (node as Copy)[part] : undefined), copy);

function referencedKeys(faq: readonly HelpFaqSection[]): string[] {
    return faq.flatMap((s) => [s.titleKey, ...s.items.flatMap((i) => [i.questionKey, i.answerKey, ...(i.genesisAnswerKey ? [i.genesisAnswerKey] : [])])]);
}

function faqProblems(faq: readonly HelpFaqSection[]): string[] {
    const out: string[] = [];
    const keys = referencedKeys(faq);
    for (const [locale, copy] of Object.entries(locales)) {
        for (const key of keys) {
            const value = lookup(copy, key);
            if (typeof value !== 'string' || !value.trim()) out.push(`${locale}: missing ${key}`);
        }
    }
    const shown = new Set(keys.map((k) => k.replace(/^help\.faq\./, '')));
    for (const key of Object.keys(lookup(locales.en, 'help.faq') as Copy)) if (!shown.has(key)) out.push(`en: help.faq.${key} is never shown`);
    return out;
}

describe('in-app FAQ', () => {
    it('every key the screen reads exists in all 12 locales, and every help.faq key is shown', () => {
        expect(Object.keys(locales)).toHaveLength(12);
        expect(HELP_FAQ.length).toBeGreaterThanOrEqual(8);
        expect(faqProblems(HELP_FAQ)).toEqual([]);
        expect(HELP_FAQ.flatMap((s) => s.items).some((i) => i.genesisAnswerKey)).toBe(true);
    });

    it('RED: a key missing from the locales, or an orphaned answer, is caught', () => {
        const planted = [{ ...HELP_FAQ[0], items: [...HELP_FAQ[0].items, { questionKey: 'help.faq.notWritten', answerKey: 'help.faq.notWrittenA' }] }, ...HELP_FAQ.slice(1)];
        expect(faqProblems(planted)).toContain('es: missing help.faq.notWritten');
        const dropped = [{ ...HELP_FAQ[0], items: HELP_FAQ[0].items.slice(1) }, ...HELP_FAQ.slice(1)];
        expect(faqProblems(dropped)).toContain(`en: ${HELP_FAQ[0].items[0].answerKey} is never shown`);
    });

    it('the screen renders the generated structure, with no hand-written FAQ keys', () => {
        expect(SCREEN).toContain("import { HELP_FAQ } from './helpFaq.generated';");
        expect(SCREEN).toContain('HELP_FAQ.map(');
        expect(SCREEN).toContain('genesisOpen && item.genesisAnswerKey ? item.genesisAnswerKey : item.answerKey');
        expect(SCREEN.match(/['"]help\.faq\./g) ?? []).toEqual([]);
    });
});
