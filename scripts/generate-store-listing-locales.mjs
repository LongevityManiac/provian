#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LOCALES } from './generate-app-narrative.mjs';

// Translation sources are authored locally; this generator never contacts a
// translation provider or a store. It only renders held listing artifacts.
const directory = resolve(import.meta.dirname, '../docs/store-listing');
const source = readFileSync(resolve(directory, 'en-US.md'));
const translated = JSON.parse(readFileSync(resolve(directory, 'localized-copy.json'), 'utf8'));
if (translated.source !== 'en-US.md' || translated.sourceSha256 !== createHash('sha256').update(source).digest('hex')) {
  throw Error('Store translations do not match the English source');
}
const locales = LOCALES.filter(locale => locale !== 'en');
if (JSON.stringify(Object.keys(translated.locales).sort()) !== JSON.stringify([...locales].sort())) {
  throw Error('Store translation locale set differs from the app');
}
const sections = [
  ['subtitle', 'App Store subtitle', 30],
  ['promotional', 'App Store promotional text', 170],
  ['title', 'Google Play title', 30],
  ['short', 'Google Play short description', 80],
  ['description', 'Description (both stores)', 4000],
  ['review', 'Review notes (both stores)', 4000],
];
const check = process.argv.includes('--check');
for (const locale of locales) {
  const copy = translated.locales[locale];
  if (JSON.stringify(Object.keys(copy).sort()) !== JSON.stringify(sections.map(([key]) => key).sort())) {
    throw Error(`${locale}: unexpected store fields`);
  }
  for (const [key, , maximum] of sections) {
    if (typeof copy[key] !== 'string' || !copy[key].trim() || [...copy[key]].length > maximum) {
      throw Error(`${locale}: invalid or overlength ${key}`);
    }
  }
  const content = `# Provian store listing (${locale})\n\n<!-- source-sha256: ${translated.sourceSha256} -->\n\n`
    + sections.map(([key, heading]) => `## ${heading}\n\n${key === 'description' ? '```text\n' + copy[key] + '\n```' : copy[key]}\n`).join('\n');
  const path = resolve(directory, `${locale}.md`);
  if (check) {
    if (readFileSync(path, 'utf8') !== content) throw Error(`${locale}: stale store listing`);
  } else writeFileSync(path, content);
}
console.log(`Store listing locales ${check ? 'verified' : 'generated'}: ${locales.length}; no store connection.`);
