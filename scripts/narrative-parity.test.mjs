import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LOCALES, validateNarrative, mergeNarrative } from './generate-app-narrative.mjs';
import { parseCharter, sourceHash, validateTranslation } from './generate-network-constitution.mjs';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(root, 'NETWORK_CONSTITUTION.md'), 'utf8');
const english = JSON.parse(readFileSync(resolve(root, 'src/i18n/narrative/en.json'), 'utf8'));
const translation = (locale) => readFileSync(resolve(root, `docs/translations/network-constitution/${locale}.md`), 'utf8');

describe('complete narrative language set', () => {
  it('covers every supported locale without English fallback', () => {
    expect(LOCALES).toEqual(['en', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt', 'sw', 'tl', 'vi', 'zh']);
    for (const locale of LOCALES) {
      const copy = JSON.parse(readFileSync(resolve(root, `src/i18n/narrative/${locale}.json`), 'utf8'));
      expect(() => validateNarrative(copy, english, locale)).not.toThrow();
    }
  });
  it('rejects missing keys, untranslated values, and lost paragraphs or placeholders', () => {
    const en = { first: 'Hello {{name}}', second: 'One\n\nTwo' };
    const valid = { first: 'Hola {{name}}', second: 'Uno\n\nDos' };
    expect(() => validateNarrative(valid, en, 'es')).not.toThrow();
    for (const bad of [{ first: valid.first }, { ...valid, first: en.first }, { ...valid, first: 'Hola' }, { ...valid, second: 'Uno Dos' }]) {
      expect(() => validateNarrative(bad, en, 'es')).toThrow();
    }
  });
  it('merges only designated keys without mutating unrelated feature copy', () => {
    const base = { feature: { title: 'old', button: 'keep' } };
    expect(mergeNarrative(base, { 'feature.title': 'new' })).toEqual({ feature: { title: 'new', button: 'keep' } });
    expect(base.feature.title).toBe('old');
    expect(() => mergeNarrative(base, { 'missing.title': 'new' })).toThrow();
  });
  it('rejects changed economic amounts and missing eligibility ranges', () => {
    const en = { split: '20% agent, 80% human; 5% to 50% prospectively', grant: '75 PVT gross, 74.25 PVT net' };
    const es = { split: '20% agente, 80% humano; 5% a 50% prospectivamente', grant: '75 PVT brutos, 74.25 PVT netos' };
    expect(() => validateNarrative(es, en, 'es')).not.toThrow();
    expect(() => validateNarrative({ ...es, split: es.split.replace('20%', '25%') }, en, 'es')).toThrow(/numeric facts/);
    expect(() => validateNarrative({ ...es, grant: '75 PVT brutos' }, en, 'es')).toThrow(/numeric facts/);
  });
});

describe('one full Constitution in every language', () => {
  it('preserves all thirteen articles and their clauses, table, and annexes', () => {
    const canonical = parseCharter(source);
    expect(canonical.sections.filter((section) => /^Article /.test(section.title))).toHaveLength(13);
    for (const locale of LOCALES.filter((code) => code !== 'en')) {
      const localized = translation(locale);
      expect(() => validateTranslation(source, localized, locale)).not.toThrow();
      expect(parseCharter(localized).sections.map((section) => section.level)).toEqual(canonical.sections.map((section) => section.level));
    }
  });
  it('rejects a stale source, omitted article, changed percentage, and missing annex reference', () => {
    const es = translation('es');
    expect(() => validateTranslation(source, es.replace(sourceHash(source), '0'.repeat(64)), 'es')).toThrow(/source hash/);
    expect(() => validateTranslation(source, es.replace(/^## .*\bXIII\b.*\n/m, ''), 'es')).toThrow(/count/);
    expect(() => validateTranslation(source, es.replace('0.5%', '1.5%'), 'es')).toThrow(/numeric facts/);
    expect(() => validateTranslation(source, es.replace('`docs/PE_PROTOCOL_SPEC.md`', '`docs/WRONG.md`'), 'es')).toThrow(/source references/);
  });
});
