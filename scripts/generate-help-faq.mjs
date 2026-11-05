#!/usr/bin/env node
// docs/help/faq.md is the single English source of the in-app Help & Support FAQ. A section or
// question whose heading ends in `<!-- app:key -->` appears in the app; this script writes those
// into the `help.faq` object of src/i18n/locales/en.json (sections, questions, answers, in
// document order) and the screen's structure into src/screens/Settings/helpFaq.generated.ts.
// A paragraph after a `<!-- app-variant:genesis -->` line is appended to the answer only while
// the Genesis window is open (key `<question>GenesisA`). --check refuses drift, so the app FAQ and
// docs/help can no longer disagree. Other locales keep their own `help.faq` translations; the key
// set is the same in every locale (the locale coverage test enforces that).
//
//   node scripts/generate-help-faq.mjs          write en.json help.faq and the generated module
//   node scripts/generate-help-faq.mjs --check  fail if either lags docs/help/faq.md
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
export const SOURCE = 'docs/help/faq.md';
export const EN = 'src/i18n/locales/en.json';
export const MODULE = 'src/screens/Settings/helpFaq.generated.ts';

const APP = /^(#{2,3}) (.+?)\s*<!--\s*app:([A-Za-z][A-Za-z0-9]*)\s*-->\s*$/;
const VARIANT = /^<!--\s*app-variant:([a-z][A-Za-z0-9]*)\s*-->\s*$/;
const KEY_RESERVED = /A$/;

// Inline markdown -> plain app text. Bold, code and links are flattened; anything else that
// would show as raw syntax in the app is refused.
export function plainInline(text) {
  const out = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1');
  if (/\*\*|`|\]\(|<!--|<\/?[a-z][^>]*>|(^|\s)_[^\s_]/i.test(out)) throw new Error(`unsupported inline markdown in an app answer: ${text.slice(0, 80)}`);
  return out;
}

// Answer blocks -> app text: paragraphs and lists separated by a blank line; list items one per
// line, bullets as "•", numbered items keep their numbers.
export function plainAnswer(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i += 1; continue; }
    if (/^(#|>|\||```|<)/.test(line) || /^\s*[*+] /.test(line)) throw new Error(`unsupported block in an app answer: ${line.slice(0, 80)}`);
    if (/^- |^\d+\. /.test(line)) {
      const items = [];
      while (i < lines.length && /^- |^\d+\. /.test(lines[i])) {
        let item = lines[i];
        i += 1;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i])) { item += ` ${lines[i].trim()}`; i += 1; }
        items.push(item.startsWith('- ') ? `• ${plainInline(item.slice(2).trim())}` : plainInline(item.trim()));
      }
      blocks.push(items.join('\n'));
      continue;
    }
    const parts = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^- |^\d+\. /.test(lines[i])) { parts.push(lines[i].trim()); i += 1; }
    blocks.push(plainInline(parts.join(' ')));
  }
  if (blocks.length === 0) throw new Error('an app question has an empty answer');
  return blocks.join('\n\n');
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Parse the FAQ source into the app's sections; unmarked sections and questions are skipped. */
export function parseFaq(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  const keys = new Set();
  const claim = (key) => {
    if (keys.has(key)) throw new Error(`duplicate app key ${key}`);
    keys.add(key);
  };
  let section = null; // current app section, or null inside an unmarked one
  let question = null; // { key, question, base: [], variants: Map }
  let target = null; // the line array the next answer lines go to
  const close = () => {
    if (question) {
      const answer = plainAnswer(question.base);
      const variants = {};
      for (const [name, extra] of question.variants) variants[name] = `${answer}\n\n${plainAnswer(extra)}`;
      section.items.push({ key: question.key, question: question.question, answer, variants });
    }
    question = null;
    target = null;
  };
  for (const line of lines) {
    const heading = /^(#{1,6}) /.exec(line);
    if (heading || line.trim() === '---') {
      close();
      if (line.trim() === '---' || heading[1].length === 1) continue;
      const m = APP.exec(line);
      if (heading[1].length === 2) {
        if (m) {
          if (m[1] !== '##') throw new Error(`malformed section heading: ${line}`);
          claim(m[3]);
          section = { key: m[3], title: plainInline(m[2]), items: [] };
          sections.push(section);
        } else {
          if (/<!--/.test(line)) throw new Error(`malformed app marker: ${line}`);
          section = null;
        }
      } else if (heading[1].length === 3) {
        if (m) {
          if (!section) throw new Error(`app question outside an app section: ${line}`);
          if (KEY_RESERVED.test(m[3])) throw new Error(`question key ${m[3]} may not end in A (answers do)`);
          claim(m[3]);
          claim(`${m[3]}A`);
          question = { key: m[3], question: plainInline(m[2]), base: [], variants: new Map() };
          target = question.base;
        } else if (/<!--/.test(line)) throw new Error(`malformed app marker: ${line}`);
      } else if (section && /<!--\s*app/.test(line)) throw new Error(`app markers belong on ## or ### headings: ${line}`);
      continue;
    }
    const variant = VARIANT.exec(line);
    if (variant) {
      if (!question) throw new Error(`variant marker outside an app question: ${line}`);
      if (question.variants.has(variant[1])) throw new Error(`duplicate variant ${variant[1]} on ${question.key}`);
      claim(`${question.key}${cap(variant[1])}A`);
      target = [];
      question.variants.set(variant[1], target);
      continue;
    }
    if (/<!--\s*app/.test(line) && !/`[^`]*<!--/.test(line)) throw new Error(`malformed app marker: ${line}`);
    if (target) target.push(line);
  }
  close();
  for (const s of sections) if (s.items.length === 0) throw new Error(`app section ${s.key} has no app questions`);
  if (sections.length === 0) throw new Error('docs/help/faq.md marks no app sections');
  return sections;
}

/** The `help.faq` object for en.json, in document order. */
export function faqCopy(sections) {
  const copy = {};
  for (const s of sections) {
    copy[s.key] = s.title;
    for (const q of s.items) {
      copy[q.key] = q.question;
      copy[`${q.key}A`] = q.answer;
      for (const [name, text] of Object.entries(q.variants)) copy[`${q.key}${cap(name)}A`] = text;
    }
  }
  return copy;
}

export function renderModule(sections) {
  const data = sections.map((s) => ({
    key: s.key,
    titleKey: `help.faq.${s.key}`,
    items: s.items.map((q) => ({
      questionKey: `help.faq.${q.key}`,
      answerKey: `help.faq.${q.key}A`,
      ...(q.variants.genesis !== undefined ? { genesisAnswerKey: `help.faq.${q.key}GenesisA` } : {}),
    })),
  }));
  for (const q of sections.flatMap((s) => s.items)) {
    for (const name of Object.keys(q.variants)) {
      if (name !== 'genesis') throw new Error(`unknown answer variant ${name} on ${q.key}; the app shows only the genesis variant`);
    }
  }
  return `// GENERATED by scripts/generate-help-faq.mjs from ${SOURCE}. Do not edit; edit the source\n`
    + '// and re-run the script (`--check` runs in `npm run check:copy`).\n'
    + "import type { HelpFaqSection } from './helpFaqTypes';\n\n"
    + `export const HELP_FAQ: readonly HelpFaqSection[] = ${JSON.stringify(data, null, 2)};\n`;
}

/** en.json with its `help.faq` object replaced, in the canonical JSON format the locale files use. */
export function renderEnglish(enRaw, copy) {
  const en = JSON.parse(enRaw);
  if (!en.help || typeof en.help !== 'object') throw new Error('en.json has no help object');
  en.help.faq = copy;
  return `${JSON.stringify(en, null, 2)}\n`;
}

export function expected(checkoutRoot = root) {
  const sections = parseFaq(readFileSync(resolve(checkoutRoot, SOURCE), 'utf8'));
  const enRaw = readFileSync(resolve(checkoutRoot, EN), 'utf8');
  return { sections, en: renderEnglish(enRaw, faqCopy(sections)), module: renderModule(sections), enRaw };
}

function main() {
  const check = process.argv.includes('--check');
  const { sections, en, module, enRaw } = expected();
  const modulePath = resolve(root, MODULE);
  let currentModule = null;
  try { currentModule = readFileSync(modulePath, 'utf8'); } catch { currentModule = null; }
  const questions = sections.reduce((n, s) => n + s.items.length, 0);
  if (check) {
    let stale = 0;
    if (enRaw !== en) { stale += 1; console.error(`help-faq: ${EN} help.faq differs from ${SOURCE}; run node scripts/generate-help-faq.mjs`); }
    if (currentModule !== module) { stale += 1; console.error(`help-faq: ${MODULE} is stale; run node scripts/generate-help-faq.mjs`); }
    if (stale) process.exit(1);
    console.log(`help-faq: ok — ${sections.length} sections, ${questions} questions in the app match ${SOURCE}`);
    return;
  }
  if (enRaw !== en) { writeFileSync(resolve(root, EN), en); console.log(`help-faq: wrote ${EN}`); }
  if (currentModule !== module) { writeFileSync(modulePath, module); console.log(`help-faq: wrote ${MODULE}`); }
  console.log(`help-faq: ${sections.length} sections, ${questions} questions`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
