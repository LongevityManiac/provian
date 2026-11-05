import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import i18next from 'i18next';
import { Children, isValidElement } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DispositionChip } from '../components/DispositionChip';
import { COLORS } from '../constants/theme';
import { buildEarningChip, normalizeMintStatus } from './peDisposition';

vi.mock('react-native', () => ({ View: 'View', Text: 'Text', StyleSheet: { create: <T>(styles: T): T => styles } }));

const localeDir = join(import.meta.dirname, '../i18n/locales');
const locales = readdirSync(localeDir).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
const resources = Object.fromEntries(locales.map(locale => [locale, {
    translation: JSON.parse(readFileSync(join(localeDir, `${locale}.json`), 'utf8')),
}]));
const previousLanguage = i18next.language;

beforeAll(async () => { await i18next.init({ lng: 'en', fallbackLng: false, resources }); });
afterAll(async () => { if (previousLanguage) await i18next.changeLanguage(previousLanguage); });

describe('held mint display', () => {
    it('recognizes the relay hold without treating unknown or terminal statuses as held', () => {
        expect(normalizeMintStatus('pending_compliance')).toBe('pending');
        expect(normalizeMintStatus('ineligible')).toBe('record_only');
        expect(normalizeMintStatus('unrecognized_status')).toBe('unknown');
        expect(buildEarningChip({ mintStatus: 'unrecognized_status' })).toBeNull();
    });

    it.each(locales)('renders the translated chip and detail explanation in %s, without a payable amount', async locale => {
        await i18next.changeLanguage(locale);
        const copy = resources[locale].translation.pe.disposition.complianceHold;
        const chip = buildEarningChip({ mintStatus: 'pending_compliance', currentSettlementProjectionPVT: '999.99' });
        expect(chip).toMatchObject({ disposition: 'pending', label: copy.label, explainer: copy.explainer, color: COLORS.warning });
        expect(chip?.label).not.toContain('999.99');
        expect(chip?.explainer).not.toContain('999.99');
        expect(copy.label.length).toBeGreaterThan(0);
        expect(copy.explainer.length).toBeGreaterThan(40);
        const detail = DispositionChip({ chip, size: 'detail' });
        const texts = Children.toArray(detail?.props.children).flatMap(child =>
            isValidElement<{ children?: string }>(child) && child.type === 'Text' ? [child.props.children] : []);
        expect(texts).toContain(copy.label);
        expect(texts).toContain(copy.explainer);
    });

    it('does not newly expose the generic record-only explanation on terminal SDN denials', () => {
        const chip = buildEarningChip({ mintStatus: 'ineligible' });
        const detail = DispositionChip({ chip, size: 'detail' });
        expect(detail?.props.accessibilityHint).toBeUndefined();
        const texts = Children.toArray(detail?.props.children).flatMap(child =>
            isValidElement<{ children?: string }>(child) && child.type === 'Text' ? [child.props.children] : []);
        expect(texts).not.toContain(chip?.explainer);
    });
});
