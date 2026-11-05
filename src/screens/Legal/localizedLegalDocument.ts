import en from '../../i18n/legal/en.generated.json';
import es from '../../i18n/legal/es.json';
import fr from '../../i18n/legal/fr.json';
import hi from '../../i18n/legal/hi.json';
import id from '../../i18n/legal/id.json';
import ja from '../../i18n/legal/ja.json';
import ko from '../../i18n/legal/ko.json';
import pt from '../../i18n/legal/pt.json';
import sw from '../../i18n/legal/sw.json';
import tl from '../../i18n/legal/tl.json';
import vi from '../../i18n/legal/vi.json';
import zh from '../../i18n/legal/zh.json';
import type { LegalDocument } from './legalDocumentTypes';

export const LEGAL_TRANSLATIONS = { en, es, fr, hi, id, ja, ko, pt, sw, tl, vi, zh };
type Language = keyof typeof LEGAL_TRANSLATIONS;

/** Translations retain the canonical document's acceptance identity and structure. */
export function localizedLegalDocument(document: LegalDocument, kind: 'terms' | 'privacy', language: string): LegalDocument {
    const locale = language.split('-')[0];
    const selected = Object.prototype.hasOwnProperty.call(LEGAL_TRANSLATIONS, locale) ? locale as Language : 'en';
    const catalog = LEGAL_TRANSLATIONS[selected];
    if (catalog.sourceVersions[kind] !== document.version) throw new Error('legal_translation_source_changed');
    const text: Record<string, string> = catalog.text;
    const copy = (path: string): string => {
        if (!Object.prototype.hasOwnProperty.call(text, path)) throw new Error('legal_translation_missing');
        return text[path];
    };
    // Each paragraph/list item/cell is translated as a complete thought. Splitting
    // sentences around bold spans can change their meaning in other word orders.
    return {
        ...document,
        title: copy(`${kind}.title`),
        lastUpdated: copy(`${kind}.lastUpdated`),
        footer: copy(`${kind}.footer`),
        blocks: document.blocks.map((block, index) => {
            const prefix = `${kind}.blocks.${index}`;
            switch (block.type) {
                case 'section':
                case 'subsection': return { ...block, text: copy(`${prefix}.text`) };
                case 'paragraph':
                case 'notice': return { ...block, spans: [{ text: copy(`${prefix}.spans`) }] };
                case 'bullets': return { ...block, items: block.items.map((_, item) => [{ text: copy(`${prefix}.items.${item}`) }]) };
                case 'table': return { ...block,
                    header: block.header.map((_, cell) => copy(`${prefix}.header.${cell}`)),
                    rows: block.rows.map((row, rowIndex) => row.map((_, cell) => [{ text: copy(`${prefix}.rows.${rowIndex}.${cell}`) }])),
                };
            }
        }),
    };
}
