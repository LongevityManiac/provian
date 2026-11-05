import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EN, MODULE, SOURCE, expected, faqCopy, parseFaq, plainAnswer, renderEnglish } from './generate-help-faq.mjs';

// docs/help/faq.md is the single English source of the in-app FAQ; --check refuses drift.

const root = resolve(import.meta.dirname, '..');

const DOC = [
  '# FAQ',
  '',
  'Intro mentions `<!-- app:key -->` in code.',
  '',
  '## Basics <!-- app:basics -->',
  '',
  '### What is it? <!-- app:whatIsIt -->',
  '',
  'It is **a thing** with `code` and a [link](https://example.com).',
  'Second line of the same paragraph.',
  '',
  '- one',
  '- two',
  '',
  '### Doc only',
  '',
  'Not in the app.',
  '',
  '### How do I earn? <!-- app:howEarn -->',
  '',
  'Base answer.',
  '',
  '<!-- app-variant:genesis -->',
  '',
  'Genesis paragraph.',
  '',
  '---',
  '',
  '## Troubleshooting',
  '',
  '### Doc only too',
  '',
  '1. Step',
].join('\n');

describe('parsing the FAQ source', () => {
  it('takes marked sections and questions in order, flattens markdown, appends a variant', () => {
    const sections = parseFaq(DOC);
    expect(sections).toEqual([{
      key: 'basics',
      title: 'Basics',
      items: [
        { key: 'whatIsIt', question: 'What is it?', answer: 'It is a thing with code and a link. Second line of the same paragraph.\n\n• one\n• two', variants: {} },
        { key: 'howEarn', question: 'How do I earn?', answer: 'Base answer.', variants: { genesis: 'Base answer.\n\nGenesis paragraph.' } },
      ],
    }]);
    expect(faqCopy(sections)).toEqual({
      basics: 'Basics',
      whatIsIt: 'What is it?',
      whatIsItA: 'It is a thing with code and a link. Second line of the same paragraph.\n\n• one\n• two',
      howEarn: 'How do I earn?',
      howEarnA: 'Base answer.',
      howEarnGenesisA: 'Base answer.\n\nGenesis paragraph.',
    });
    expect(plainAnswer(['1. First', '2. Second'])).toBe('1. First\n2. Second');
  });

  it('RED: refuses markup that would show raw in the app, and malformed or colliding markers', () => {
    const q = (body) => `## S <!-- app:s -->\n\n### Q <!-- app:q -->\n\n${body}\n`;
    expect(() => parseFaq(q('Has *emphasis* _here_ fine? no: _x'))).toThrow(/unsupported inline/);
    expect(() => parseFaq(q('| a | b |\n|---|---|'))).toThrow(/unsupported block/);
    expect(() => parseFaq(q('> quoted'))).toThrow(/unsupported block/);
    expect(() => parseFaq(q(''))).toThrow(/empty answer/);
    expect(() => parseFaq(`${q('A.')}\n### Q again <!-- app:q -->\n\nB.\n`)).toThrow(/duplicate app key q/);
    expect(() => parseFaq('## S <!-- app:s -->\n\n### Q <!-- app:qA -->\n\nA.\n')).toThrow(/may not end in A/);
    expect(() => parseFaq('## S <!-- app:s -->\n\n### Q <!-- app:q -->\n\nA.\n\n### R <!-- app:qA2 -->\n\nB.\n')).not.toThrow();
    expect(() => parseFaq('## S\n\n### Q <!-- app:q -->\n\nA.\n')).toThrow(/outside an app section/);
    expect(() => parseFaq('## S <!-- app:s -->\n\n<!-- app-variant:genesis -->\n\nA.\n')).toThrow(/variant marker outside/);
    expect(() => parseFaq('## S <!-- ap:s -->\n\n### Q\n\nA.\n')).toThrow(/malformed app marker/);
    expect(() => parseFaq('## S <!-- app:s -->\n\n### Q\n\nA.\n')).toThrow(/no app questions/);
    expect(() => parseFaq('# Only a title\n')).toThrow(/marks no app sections/);
  });
});

describe('the committed app copy', () => {
  it('en.json help.faq and the generated module match docs/help/faq.md', () => {
    const { sections, en, module, enRaw } = expected(root);
    expect(sections.length).toBeGreaterThanOrEqual(8);
    expect(sections.reduce((n, s) => n + s.items.length, 0)).toBeGreaterThanOrEqual(30);
    expect(en).toBe(enRaw);
    expect(readFileSync(resolve(root, MODULE), 'utf8')).toBe(module);
  });

  it('RED: an edit to an app answer in the source is reported as drift', () => {
    const source = readFileSync(resolve(root, SOURCE), 'utf8');
    const edited = source.replace(/(### Is Provian free\? <!-- app:isProvianFree -->\n\n)/, '$1Edited. ');
    expect(edited).not.toBe(source);
    const enRaw = readFileSync(resolve(root, EN), 'utf8');
    expect(renderEnglish(enRaw, faqCopy(parseFaq(edited)))).not.toBe(enRaw);
    // A doc-only question can change without touching the app.
    const docOnly = source.replace('### How do I sign up?\n\n', '### How do I sign up?\n\nEdited. ');
    expect(docOnly).not.toBe(source);
    expect(renderEnglish(enRaw, faqCopy(parseFaq(docOnly)))).toBe(enRaw);
  });
});
