#!/usr/bin/env node
// The app's Terms of Service and Privacy Policy screens render the canonical legal
// documents (docs/legal/*.md), the same files the website serves. This script parses
// each one into blocks the screens render; --check refuses a generated file that lags
// its source, so the in-app text a person accepts can never drift from the canonical text.
// Each generated document carries a `version`: a SHA-256 of its parsed content. The app
// stores the versions a person accepted and asks again when the current version differs.
//
//   node scripts/generate-legal-app-content.mjs          write the generated modules
//   node scripts/generate-legal-app-content.mjs --check  fail if either is stale
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const DOCS = [
  { src: 'docs/legal/terms-of-service.md', out: 'src/screens/Legal/termsContent.generated.ts', name: 'TERMS_DOCUMENT' },
  { src: 'docs/legal/privacy-policy.md', out: 'src/screens/Legal/privacyContent.generated.ts', name: 'PRIVACY_DOCUMENT' },
];

// Inline markdown -> spans. Only **bold** and `code` occur in the legal sources; any other
// markup is refused so a new construct cannot silently render as raw syntax in the app.
export function parseInline(text) {
  const spans = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) spans.push({ text: text.slice(last, m.index) });
    spans.push(m[1] !== undefined ? { text: m[1], bold: true } : { text: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  for (const span of spans) {
    if (/\*\*|\]\(|(^|\s)_\S|`/.test(span.text)) throw new Error(`unsupported inline markdown: ${span.text.slice(0, 80)}`);
  }
  return spans;
}

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function parseLegal(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let title = null;
  let lastUpdated = null;
  let footer = null;
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim() === '---') { i += 1; continue; }
    let m;
    if ((m = /^# (.+)$/.exec(line))) { title = m[1].trim(); i += 1; continue; }
    if ((m = /^\*\*Last Updated: (.+)\*\*$/.exec(line))) { lastUpdated = m[1].trim(); i += 1; continue; }
    if ((m = /^\*([^*].*[^*])\*$/.exec(line))) { footer = m[1].trim(); i += 1; continue; }
    if ((m = /^## (.+)$/.exec(line))) { blocks.push({ type: 'section', text: m[1].trim() }); i += 1; continue; }
    if ((m = /^### (.+)$/.exec(line))) { blocks.push({ type: 'subsection', text: m[1].trim() }); i += 1; continue; }
    if (/^#{4,} /.test(line)) throw new Error(`unsupported heading depth: ${line}`);
    if (line.startsWith('>')) {
      const parts = [];
      while (i < lines.length && lines[i].startsWith('>')) { parts.push(lines[i].replace(/^>\s?/, '')); i += 1; }
      blocks.push({ type: 'notice', spans: parseInline(parts.join(' ').trim()) });
      continue;
    }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) { rows.push(cells(lines[i])); i += 1; }
      if (rows.length < 3 || !rows[1].every((c) => /^:?-+:?$/.test(c))) throw new Error('malformed table');
      const header = rows[0];
      blocks.push({
        type: 'table',
        rows: rows.slice(2).map((row) => {
          if (row.length !== header.length) throw new Error('table row width differs from header');
          return row.map((c) => parseInline(c));
        }),
        header,
      });
      continue;
    }
    if (/^- /.test(line)) {
      const items = [];
      while (i < lines.length && /^- /.test(lines[i])) {
        let item = lines[i].slice(2);
        i += 1;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i])) { item += ` ${lines[i].trim()}`; i += 1; }
        items.push(parseInline(item.trim()));
      }
      blocks.push({ type: 'bullets', items });
      continue;
    }
    if (/^\s*[*+] |^\s*\d+\. /.test(line)) throw new Error(`unsupported list syntax: ${line}`);
    const parts = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#|>|\||- |---)/.test(lines[i])) { parts.push(lines[i].trim()); i += 1; }
    blocks.push({ type: 'paragraph', spans: parseInline(parts.join(' ')) });
  }
  if (!title || !lastUpdated || !footer) throw new Error('legal document is missing its title, Last Updated line, or effective-date footer');
  const content = { title, lastUpdated, footer, blocks };
  return { version: legalVersion(content), ...content };
}

// The accepted-version identity of a document: a hash of its parsed content, so any change a
// person would read (wording, dates, structure) yields a new version, and whitespace-only edits
// to the markdown do not.
export function legalVersion(content) {
  return `sha256:${createHash('sha256').update(JSON.stringify(content)).digest('hex')}`;
}

function render({ src, name }) {
  const doc = parseLegal(readFileSync(resolve(root, src), 'utf8'));
  return `// GENERATED by scripts/generate-legal-app-content.mjs from ${src}. Do not edit;\n`
    + `// edit the source and re-run the script (\`--check\` runs in \`npm run check:copy\`).\n`
    + `import type { LegalDocument } from './legalDocumentTypes';\n\n`
    + `export const ${name}: LegalDocument = ${JSON.stringify(doc, null, 2)};\n`;
}

function main() {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const doc of DOCS) {
    const next = render(doc);
    const outPath = resolve(root, doc.out);
    let current = null;
    try { current = readFileSync(outPath, 'utf8'); } catch { current = null; }
    if (check) {
      if (current !== next) { stale += 1; console.error(`legal-app-content: ${doc.out} is stale; run node scripts/generate-legal-app-content.mjs`); }
    } else if (current !== next) {
      writeFileSync(outPath, next);
      console.log(`legal-app-content: wrote ${doc.out}`);
    }
  }
  if (check) {
    if (stale) process.exit(1);
    console.log(`legal-app-content: ok — ${DOCS.length} in-app legal documents match docs/legal`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
