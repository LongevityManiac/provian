import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import i18next from 'i18next';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { badgeDisplayCopy, enumDisplayCopy, errorDisplayCopy } from './displayCopy';
import { LEGAL_TRANSLATIONS, localizedLegalDocument } from '../screens/Legal/localizedLegalDocument';
import { TERMS_DOCUMENT } from '../screens/Legal/termsContent.generated';
import { PRIVACY_DOCUMENT } from '../screens/Legal/privacyContent.generated';

const languages = Object.keys(LEGAL_TRANSLATIONS);
beforeAll(async () => {
    const resources = Object.fromEntries(languages.map(language => [language, { translation: JSON.parse(readFileSync(resolve(import.meta.dirname, `locales/${language}.json`), 'utf8')) }]));
    await i18next.init({ resources, lng: 'en', fallbackLng: false, interpolation: { escapeValue: false } });
});
afterAll(async () => { await i18next.changeLanguage('en'); });

it('localizes actual service errors, enum labels and badges in every app language', async () => {
    for (const language of languages) {
        await i18next.changeLanguage(language);
        const original = 'No mnemonic found. This wallet may have been created without storing a seed phrase, or it is a legacy wallet.';
        const translated = errorDisplayCopy(original);
        expect(translated).not.toContain('uiErrors.');
        if (language !== 'en') expect(translated).not.toBe(original);
        if (language !== 'en') expect(errorDisplayCopy('unmapped provider error with sensitive details')).toBe(i18next.t('uiErrors.unknown'));
        expect(errorDisplayCopy(i18next.t('common.error'))).toBe(i18next.t('common.error'));
        if (language !== 'en') {
            expect(errorDisplayCopy(i18next.t('seedErrors.writeUnverified', { reason: 'An unmapped English provider error' }))).not.toContain('An unmapped English provider error');
            expect(errorDisplayCopy('Request failed: Network request failed')).not.toContain('Network request failed');
        }
        const dynamic = errorDisplayCopy('[ChainConstants] Missing canonical address for USDC on chain 8453');
        expect(dynamic).toContain('USDC');
        expect(dynamic).toContain('8453');
        expect(dynamic).not.toContain('{{');
        expect(enumDisplayCopy('confirmed')).toBe(i18next.t('uiEnums.confirmed'));
        expect(enumDisplayCopy('future_secret_value')).toBe(i18next.t('uiEnums.unknown'));
        expect(badgeDisplayCopy('genesis_agent')).toBe(i18next.t('uiBadges.genesis_agent'));
        expect(badgeDisplayCopy('future_badge')).toBe(i18next.t('uiBadges.unknown'));
    }
});

it('renders complete localized legal bodies while retaining canonical acceptance identities', () => {
    expect(languages).toHaveLength(12);
    for (const language of languages) {
        for (const [kind, original] of [['terms', TERMS_DOCUMENT], ['privacy', PRIVACY_DOCUMENT]] as const) {
            const localized = localizedLegalDocument(original, kind, language);
            expect(localized.version).toBe(original.version);
            expect(localized.blocks.map(block => block.type)).toEqual(original.blocks.map(block => block.type));
            if (language !== 'en') expect(JSON.stringify(localized.blocks)).not.toBe(JSON.stringify(original.blocks));
        }
    }
});

it('RED: refuses stale legal sources and missing translations instead of falling back to English', () => {
    expect(() => localizedLegalDocument({ ...TERMS_DOCUMENT, version: 'changed-source' }, 'terms', 'es')).toThrow('legal_translation_source_changed');
    const text: Record<string, string> = LEGAL_TRANSLATIONS.es.text;
    const saved = text['terms.title'];
    delete text['terms.title'];
    try { expect(() => localizedLegalDocument(TERMS_DOCUMENT, 'terms', 'es')).toThrow('legal_translation_missing'); }
    finally { text['terms.title'] = saved; }
});
