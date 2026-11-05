import i18next from 'i18next';
import en from './locales/en.json';
import { ERROR_DETAIL_SLOTS } from './errorDetailSlots';

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const errorPatterns = Object.entries(en.uiErrors).filter(([key, value]) => key !== 'unknown' && /[\p{L}]/u.test(value.replace(/\{\{[^}]+\}\}/g, ''))).map(([key, value]) => {
    const names: string[] = [];
    const pattern = value.split(/(\{\{\w+\}\})/g).map(part => {
        if (/^\{\{\w+\}\}$/.test(part)) { names.push(part.slice(2, -2)); return '([\\s\\S]*?)'; }
        return escapeRegex(part);
    }).join('');
    return { key, names, pattern: new RegExp('^' + pattern + '$') };
});
type LocalizedPattern = { pattern: RegExp; names: string[]; value: string };
const localizedPatterns = new Map<string, LocalizedPattern[]>();
function selectedLanguagePatterns(): LocalizedPattern[] {
    const language = i18next.resolvedLanguage ?? i18next.language;
    const saved = localizedPatterns.get(language);
    if (saved) return saved;
    const patterns: LocalizedPattern[] = [];
    const walk = (value: unknown): void => {
        if (typeof value === 'string' && /[\p{L}]/u.test(value.replace(/\{\{[^}]+\}\}/g, ''))) {
            const names = [...value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map(match => match[1]);
            // Short formatting templates such as "N{{level}}" are not evidence
            // that an arbitrary diagnostic is already translated.
            if (names.length && value.replace(/\{\{[^}]+\}\}/g, '').trim().length < 8
                && !names.some(name => /^(base|message|reason|error)$/i.test(name))) return;
            patterns.push({ value, names, pattern: new RegExp('^' + value.split(/\{\{[^}]+\}\}/g).map(escapeRegex).join('([\\s\\S]*?)') + '$') });
        }
        else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(i18next.getResourceBundle(language, 'translation'));
    patterns.sort((a, b) => b.value.replace(/\{\{[^}]+\}\}/g, '').length - a.value.replace(/\{\{[^}]+\}\}/g, '').length);
    localizedPatterns.set(language, patterns);
    return patterns;
}

/** Translate app-authored errors at display time, leaving protocol errors unchanged internally. */
export function errorDisplayCopy(value: string | null | undefined): string {
    return displayError(value, 0);
}

function displayError(value: string | null | undefined, depth: number): string {
    if (!value) return '';
    if (!i18next.isInitialized || (i18next.resolvedLanguage ?? i18next.language)?.split('-')[0] === 'en') return value;
    for (const entry of errorPatterns) {
        const match = entry.pattern.exec(value);
        if (!match) continue;
        return i18next.t(`uiErrors.${entry.key}`, Object.fromEntries(entry.names.map((name, index) => [name,
            ERROR_DETAIL_SLOTS[entry.key]?.includes(index)
                ? depth < 3 ? displayError(match[index + 1], depth + 1) : i18next.t('uiErrors.unknown')
                : match[index + 1],
        ])));
    }
    // Domain services can already return localized copy. Provider diagnostics and
    // unmapped internal errors must not become English app UI or expose raw payloads.
    for (const entry of selectedLanguagePatterns()) {
        const match = entry.pattern.exec(value);
        if (!match) continue;
        let index = 0;
        return entry.value.replace(/\{\{[^}]+\}\}/g, () => {
            const at = index++;
            return /^(base|message|reason|error)$/i.test(entry.names[at])
                ? depth < 3 ? displayError(match[at + 1], depth + 1) : i18next.t('uiErrors.unknown')
                : match[at + 1];
        });
    }
    return i18next.t('uiErrors.unknown');
}

/** Never expose an English protocol enum as a display label. */
export function enumDisplayCopy(value: string): string {
    const key = value.toLowerCase().replace(/[ -]/g, '_');
    return Object.prototype.hasOwnProperty.call(en.uiEnums, key) ? i18next.t(`uiEnums.${key}`) : i18next.t('uiEnums.unknown');
}

export function badgeDisplayCopy(id: string): string {
    return Object.prototype.hasOwnProperty.call(en.uiBadges, id) ? i18next.t(`uiBadges.${id}`) : i18next.t('uiBadges.unknown');
}
