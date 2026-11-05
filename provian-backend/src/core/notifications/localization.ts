import { createHash } from 'node:crypto';
import type { PushMessage } from './pushDispatcher';
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

export const PUSH_LOCALES = { en, es, fr, hi, id, ja, ko, pt, sw, tl, vi, zh };
export type PushLanguage = keyof typeof PUSH_LOCALES;
export function pushLanguage(value: unknown): PushLanguage {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PUSH_LOCALES, value) ? value as PushLanguage : 'en';
}
export const pushTokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');
export function pushTokenLanguage(preferences: unknown, token: string): PushLanguage {
  if (!preferences || typeof preferences !== 'object') return 'en';
  const key = pushTokenHash(token);
  return pushLanguage(Object.prototype.hasOwnProperty.call(preferences, key) ? (preferences as Record<string, unknown>)[key] : undefined);
}
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = Object.entries(en).map(([key, value]) => {
  const names: string[] = [];
  const parts = value.split(/(\{\{\w+\}\})/g);
  const pattern = parts.map(part => {
    if (/^\{\{\w+\}\}$/.test(part)) { names.push(part.slice(2, -2)); return '([\\s\\S]*?)'; }
    return escapeRegex(part);
  }).join('');
  return { key, names, pattern: new RegExp('^' + pattern + '$') };
});
export function localizePushText(value: string, language: unknown): string {
  const locale = pushLanguage(language);
  if (locale === 'en') return value;
  for (const entry of patterns) {
    const match = entry.pattern.exec(value);
    if (!match) continue;
    const copy: Record<string, string> = PUSH_LOCALES[locale];
    return copy[entry.key].replace(/\{\{(\w+)\}\}/g, (_, name: string) => match[entry.names.indexOf(name) + 1]);
  }
  // Unmatched content is authored by the sender (announcements or an admin test), not app chrome.
  return value;
}
export function localizePushMessage(message: PushMessage, language: unknown): PushMessage {
  return { ...message, title: localizePushText(message.title, language), body: localizePushText(message.body, language) };
}
