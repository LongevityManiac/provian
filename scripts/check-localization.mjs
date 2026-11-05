import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseLegal } from './generate-legal-app-content.mjs';
const root = resolve(import.meta.dirname, '..');
const locales = ['en','es','fr','hi','id','ja','ko','pt','sw','tl','vi','zh'];
const read = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
export function legalText(value, prefix, out = {}) {
  if (Array.isArray(value) && value.every(item => item && typeof item === 'object' && typeof item.text === 'string')) {
    out[prefix] = value.map(item => item.text).join('');
    return out;
  }
  if (typeof value === 'string') {
    if (!prefix.endsWith('.type') && !prefix.endsWith('.version')) out[prefix] = value;
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) legalText(item, prefix + '.' + key, out);
  }
  return out;
}
const digits = text => {
  const normalized = text.replace(/milioni\s+([0-9]+(?:[.,][0-9]+)?)/gi, '$1 million').replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, value => '^' + '⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(value));
  const units = 'millions?|millones|milhões|milyon|milioni|juta|triệu|मिलियन|लाख|करोड़|万|萬|만';
  return [...normalized.matchAll(new RegExp('\\d+(?:[.,]\\d+)*(?:\\s*(?:' + units + '))?', 'gi'))].map(([value]) => {
    const unit = new RegExp(units, 'i').exec(value)?.[0];
    let number = value.replace(new RegExp('\\s*(' + units + ')', 'gi'), '');
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(number)) number = number.replace(/[.,]/g, '');
    else number = number.replace(',', '.');
    const factor = !unit ? 1 : /万|萬|만/.test(unit) ? 10000 : unit === 'लाख' ? 100000 : unit === 'करोड़' ? 10000000 : 1000000;
    return String(Number(number) * factor);
  }).sort();
};
export function numericFactsMatch(source, translated) {
  const left = digits(source), right = digits(translated);
  for (const number of left) {
    const at = right.indexOf(number);
    if (at < 0) return false;
    right.splice(at, 1);
  }
  // Translation can spell a written cardinal as a digit, or a written month as its number.
  const words = { '0': /\bzero\b/i, '1': /\b(one|once|single|first|each|per|a|an)\b/i, '2': /\b(two|second)\b/i, '3': /\b(three|third)\b/i, '4': /\bfour\b/i, '7': /\bseven\b/i, '10': /\bten\b/i, '12': /\btwelve\b/i, '30': /\bthirty\b/i };
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return right.every(number => words[number]?.test(source) || months.some((month, index) => String(index + 1) === number && source.includes(month)));
}
const variables = text => (text.match(/\{\{[^}]+\}\}/g) ?? []).sort();
export function copyProblems(english, translated) {
  const problems = [];
  if (JSON.stringify(Object.keys(english).sort()) !== JSON.stringify(Object.keys(translated).sort())) problems.push('key-set');
  for (const [key, value] of Object.entries(english)) {
    if (typeof translated[key] !== 'string' || !translated[key].trim()) { problems.push('empty:' + key); continue; }
    if (JSON.stringify(variables(value)) !== JSON.stringify(variables(translated[key]))) problems.push('variables:' + key);

  }
  const groups = {};
  for (const [key, value] of Object.entries(english)) {
    const group = /(?:spans|items|rows)\./.test(key) ? key.replace(/\.\d+\.text$/, '') : key;
    const pair = groups[group] ??= ['', ''];
    pair[0] += value;
    pair[1] += translated[key] ?? '';
  }
  for (const [key, [source, target]] of Object.entries(groups)) if (!numericFactsMatch(source, target)) problems.push('numbers:' + key);
  return problems;
}
export function checkLocalization() {
  const documents = Object.fromEntries([['terms','terms-of-service'],['privacy','privacy-policy']].map(([kind, name]) => [kind, parseLegal(readFileSync(resolve(root, `docs/legal/${name}.md`), 'utf8'))]));
  const english = Object.assign({}, ...Object.entries(documents).map(([kind, doc]) => legalText(doc, kind)));
  const push = read('provian-backend/src/core/notifications/locales/en.json');
  const native = read('config/locales/en.json').ios;
  for (const locale of locales) {
    const legal = read(`src/i18n/legal/${locale === 'en' ? 'en.generated' : locale}.json`);
    for (const [kind, doc] of Object.entries(documents)) if (legal.sourceVersions[kind] !== doc.version) throw new Error(`${locale}: stale ${kind} translation`);
    const problems = copyProblems(english, legal.text);
    if (locale === 'en' && JSON.stringify(legal.text) !== JSON.stringify(english)) problems.push('canonical-legal-text');
    const pushProblems = copyProblems(push, read(`provian-backend/src/core/notifications/locales/${locale}.json`));
    const nativeCopy = read(`config/locales/${locale}.json`).ios;
    const nativeProblems = copyProblems(native, nativeCopy);
    const nativeFile = readFileSync(resolve(root, `ios/Provian/Supporting/${locale}.lproj/InfoPlist.strings`), 'utf8');
    for (const [key, value] of Object.entries(nativeCopy)) if (!nativeFile.includes(`${key} = "${value}";`)) nativeProblems.push('native-mirror:' + key);
    if (problems.length || pushProblems.length || nativeProblems.length) throw new Error(`${locale}: ${JSON.stringify({ legal: problems, push: pushProblems, native: nativeProblems })}`);
  }
  console.log(`localization: ${locales.length} locales; ${Object.keys(english).length} legal text leaves, ${Object.keys(push).length} push templates and ${Object.keys(native).length} native prompts each`);
}
if (process.argv.includes('--self-test')) {
  const corrupt = copyProblems({ a: 'Hold 10 years for {{name}}', b: 'Present' }, { a: 'Hold 27 years for {{other}}', extra: '' });
  if (!['key-set','variables:a','numbers:a','empty:b'].every(value => corrupt.includes(value))) throw new Error('localization negative control survived');
  console.log('localization: missing keys, changed variables and changed policy numbers rejected by negative controls');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) checkLocalization();
