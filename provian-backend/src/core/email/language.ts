import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import hi from './locales/hi.json';
import id from './locales/id.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import pt from './locales/pt.json';
import sw from './locales/sw.json';
import tl from './locales/tl.json';
import vi from './locales/vi.json';
import zh from './locales/zh.json';

export const EMAIL_LOCALES = { en, es, fr, hi, id, ja, ko, pt, sw, tl, vi, zh };
export type EmailLanguage = keyof typeof EMAIL_LOCALES;
export type EmailCopyKey = keyof typeof en;

export function emailLanguage(value: unknown): EmailLanguage {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(EMAIL_LOCALES, value)
    ? value as EmailLanguage : 'en';
}

export function emailCopy(language: unknown, key: EmailCopyKey, values: Record<string, string | number> = {}): string {
  return EMAIL_LOCALES[emailLanguage(language)][key].replace(/\{\{(\w+)\}\}/g,
    (_, name: string) => String(values[name] ?? ''));
}
