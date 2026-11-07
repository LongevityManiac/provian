#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const selfTest = argv.includes('--self-test');
const listOnly = argv.includes('--list');
const rootFlag = argv.indexOf('--root');
const ROOT = rootFlag === -1 ? REPO_ROOT : path.resolve(argv[rootFlag + 1]);
/** --artifact: ROOT is the extracted contents of a packed artifact (an npm tarball, a wheel, an
 *  sdist). Every text file under it is scanned, whatever its path or extension (a wheel's METADATA
 *  carries the README; a tarball ships bin/, hooks/, schema/ beside dist/), not only SURFACES. */
const artifactMode = argv.includes('--artifact');
if (artifactMode && rootFlag === -1) {
  console.error('armed-state-copy: --artifact needs --root <extracted artifact dir>');
  process.exit(2);
}

/** Surfaces that carry armed-state copy. Missing dirs are skipped, not errors —
 *  the same scanner runs over the repo and over a packed npm tarball. */
const SURFACES = [
  'src/i18n/locales',                       // app copy, all 12 locales
  'src/i18n/narrative',                     // Vision/thesis narrative copy, all 12 locales
  'src/screens',                            // app screens
  'src/components',                         // shared app components
  'src/services',                           // client-facing service comments/strings
  'provian-backend/src/routes',             // live API response strings
  'provian-backend/src/mcp',                // hosted MCP tool descriptions
  'provian-mcp/src',                        // npm MCP tool descriptions
  'provian-mcp/README.md',
  'provian-mcp/listings',                   // published directory listings
  'provian-agent-sdk/README.md',
  'provian-agent-sdk/docs',
  'provian-cli/README.md',
  'skills/provian/SKILL.md',
  'scripts/launch-smoke',
  'docs',
  'reference',
  'provian-website/src/app',
  'provian-website/public/docs-md',
  'provian-website/public/llms.txt',        // the agent-facing index
  'provian-website/public/llms-full.txt',   // the same index with every doc inlined
  'provian-website/public/llms.post-genesis.txt',      // the 2027+ variant without the Genesis line
  'provian-website/public/llms-full.post-genesis.txt', // (served by nginx from 2027-01-01 UTC)
  'CLAUDE.md',
  // npm-tarball layouts (--root over a packed package)
  'package/README.md',
  'package/dist',
  'package/src',
  'README.md',
  'dist',
];

const EXT = new Set([
  '.md', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.txt', '.html',
  '.py', '.yaml', '.yml', '.toml',
]);

/** Each exemption names WHY. An unreasoned exemption is a silent cap. */
const EXEMPT = [
  [/(^|\/)DECISIONS\.md$/, 'append-only ruling ledger — records the stale copy as history'],
  [/(^|\/)OPEN_ITEMS\.md$/, 'append-only tracker'],
  [/(^|\/)CLAUDE\.md$/, 'states the supersession and the abandoned kernel reference explicitly'],
  [/docs\/archive\//, 'the designated historical record — files are moved here precisely because their claims are dated (sweep)'],
  [/activation_PRE_ARM_REPORT/, 'historical pre-arm report'],
  [/PVT_BASE_MAINNET_WP0_PREFLIGHT/, 'historical policy inventory preflight'],
  [/PVT_MONETARY_ACCOUNTING_SPEC\.md$/, 'carries a dated supersession banner'],
  [/PVT_BASE_MAINNET_CLOSED_LOOP_PLAN\.md$/, 'carries a dated supersession banner'],
  [/PVT_WP0_WP1_HANDOFF\.md$/, 'FROZEN Gate 1 evidence — check:wp2 blocks edits'],
  [/pvt-wp0-wp1\/APPROVAL_PROCESS\.md$/, 'FROZEN Gate 1 evidence — check:wp2 blocks edits'],
  [/pvt9-base-config\.generated/, 'generated; chain_observed_reference_only, authority:none'],
  [/config\/pvt9-base\.json$/,
    'generated runtime config: armed:false / null window are this runtime\'s fail-closed invariants, and'
    + ' chain_observed_reference_only (authority:none) observes the successor kernel'],
  // (PROVIAN_MANUAL.md, its docs-md mirror and llms-full.txt are NOT whole-file exempt any more
  // review: a whole-file pass hid every OTHER claim in them, a stale Genesis close
  //  included. Each is exempt from exactly the one claim it quotes; see CLAIM_EXEMPT below.)
  [/onboardingNarrativeParity\.test\.ts$/,
    'the parity guard ASSERTS the onboarding copy does NOT match /secure hardware protects/'],
  // (genesisWindow.ts is NO LONGER exempt, its NOTE now states only the close, so
  //  the file is scanned like every other app surface.)
  [/GENESIS_EXTENSION_DISCOVERY_2026-09-24\.md$/,
    'pre- discovery record of the kernel (10-26 close) and the abandoned kernel (10-19);'
    + ' carries a dated SUPERSEDED banner'],
  [/THESIS_V21_FACT_BASE_2026-09-22\.md$/,
    'dated 2026-09-22 fact base whose body is kept as written; carries a note naming the'
    + ' 2026-12-31 close and the successor set'],
  [/proposed-genesis-policy\.ts$/, ' dates marked HISTORICAL inline; window object is live'],
  [/cap-clock\.test\.ts$/, 'cap-clock arithmetic off epoch zero —, not the Genesis window'],
  [/wp4-fork-e2e\.ts$/, 'fork fixture pinning the abandoned kernel on-chain constants'],
  [/genesis-campaign\.(ts|test\.ts)$/, 'RETIRED PVTv8 surface; docblock carries a pointer'],
  [/ProvianPVT9Surface\.test\.ts$/, 'asserts fresh-deploy invariants where unarmed is correct'],
  [/WP_SCOPE\.md$/, 'describes currentEpoch() reverting EpochZeroNotArmed'],
  [/check-armed-state-copy\.mjs$/, 'this scanner declares the patterns it hunts'],
  [/node_modules|\.git\/|\/out\/|\.next\//, 'build output / vendored'],
];

/**
 * CLAIM-SCOPED exemptions: [path, claim name, reason]. The file stays scanned for every other
 * claim. Use this, not EXEMPT, whenever a file carries one legitimate string among live copy —
 * a whole-file pass would also hide the next stale sentence someone adds to it.
 */
const QUOTED_TO_FORBID = 'wallet keys claimed protected by secure hardware';
const CLAIM_EXEMPT = [
  // The surfaces that QUOTE "secure hardware protects your wallet keys" in order to FORBID it:
  // the string is present because it is being called out, not asserted. By exact path, so a
  // new file does not inherit the pass.
  [/(^|\/)docs\/PROVIAN_MANUAL\.md$/, QUOTED_TO_FORBID,
    'quotes the false claim to state it was never true at any version (two-key section)'],
  [/(^|\/)public\/docs-md\/manual\.md$/, QUOTED_TO_FORBID,
    'published mirror of PROVIAN_MANUAL.md — same quoted-to-forbid sentence'],
  [/(^|\/)public\/llms-full(?:\.post-genesis)?\.txt$/, QUOTED_TO_FORBID,
    'generated concatenation that inlines the manual — same quoted-to-forbid sentence'],
];

/** The claims. Blunt on purpose — see the header. */
const CLAIMS = [
  ['create-and-prove agent act (superseded)', /create[\s\-]+and[\s\-]+prove/i],
  ['agent qualifies by proving an address ', /creates?\s+an?\s+(?:Provian\s+)?wallet\s+and\s+prov(?:es|ing)/i],
  ['Genesis asserted unarmed', /(?:currently|is|are|remains?|still)\s+unarmed/i],
  ['Genesis asserted to have no approved dates', /no\s+approved\s+(?:launch\s+)?dates/i],
  ['pre-succession window 2026-10-19', /2026-10-19/],
  // Genesis runs through 2026-12-31. A surface that still CLOSES it on 2026-10-26
  // (the predecessor kernel's window) tells a reader the campaign ends two months early.
  // Assertive close forms and window ranges only — a historical sentence that names the old
  // date as the OLD close ("moved from 2026-10-26") is not a close claim.
  ['Genesis close stated as 2026-10-26 (open through 2026-12-31)',
    /(?:through|until|till|closes?|closing|ends?|ending|admitting|open)\s+(?:on\s+)?(?:2026-10-26|oct(?:ober)?\.?\s+26,?\s+2026)/i],
  ['Genesis window range ending 2026-10-26 (open through 2026-12-31)',
    /2026-08-03(?:T00:00:00(?:\.000)?Z)?\s*(?:\.\.|→|->|–|—|-|to)\s*2026-10-26/i],
  ['PVT9 asserted to have no address or mint', /no\s+address\s+or\s+active\s+mint/i],
  ['PEs asserted never to mint', /do\s+not\s+mint\s+or\s+settle/i],

  // ── SECURITY AND CUSTODY REPRESENTATIONS ─────────────────────────
  //
  // CLAUDE.md calls the two-key conflation "the single most-repeated copy defect
  // in the repo", and it kept resurfacing because nothing mechanical looked for
  // it. What is actually true:
  //   · the WALLET key is secp256k1, BIP-39-derived, PIN-encrypted at rest and
  //     biometric-gated — and it DOES leave the device, as AES-256-GCM ciphertext
  //     synced to iCloud Keychain / Google Drive. That backup is what makes
  //     recovery work, so "never leaves your device" is not a stricter promise,
  //     it is a false one.
  //   · the PE ATTESTATION key is P-256, lives in the Secure Enclave / StrongBox,
  //     genuinely never leaves — and identifies the DEVICE, not the wallet.
  //   · the SE only does P-256, so it CANNOT hold a secp256k1 wallet key. The
  //     claim was false at every version, never merely aspirational.
  //   · the CARD VAULT key is a CSPRNG value in the OS keychain, NOT SE-derived
  //     (that approach was removed for non-determinism); the SE key survives
  //     there only as a precondition check.
  //   · the AGENT key is generated locally and escrowed as ciphertext sealed to
  //     the inviting phone's recovery anchor — so it, too, is not "never leaves".
  //
  // Assertive forms only. The corrective texts QUOTE the false phrasing in order
  // to forbid it, and are exempted by exact path below rather than dodged with a
  // narrower pattern — same rule as every other exemption here.
  ['wallet keys claimed protected by secure hardware', /secure\s+hardware\s+protects/i],
  ['hardware-backed keys claimed to protect encryption', /hardware[\s\-]back(?:ed)?\s+keys?\s+protect/i],
  ['wallet key claimed to live in secure hardware',
    /(?:wallet|seed|private|spending)\s+keys?[^.]{0,40}(?:lives?|held|stored|kept|sits?|resides?)[^.]{0,25}(?:in|inside)\s+(?:the\s+)?(?:secure\s+enclave|strongbox|secure\s+element)/i],
  // The POSSESSIVE form only — "your device", "your phone", "your machine". That is a
  // custody promise about the reader's key, and it is false: the wallet seed syncs as
  // ciphertext, and an agent key is escrowed sealed to the inviting phone's anchor.
  //
  // The bare form ("the key never leaves the machine") is deliberately NOT matched. The
  // MCP tool descriptions use it to say something TRUE and narrow — that stdio mode signs
  // in-process instead of transmitting the key — and a regex cannot separate that from a
  // lifetime claim. Blanket-exempting the MCP tool files to silence it would blind this
  // class in the one place a false custody claim reaches agents directly, which is worse
  // than not matching the ambiguous form at all. Lifetime claims get their own pattern
  // below instead.
  ['absolute custody claim: your keys never leave your device',
    /keys?\s+never\s+leaves?\s+your\s+(?:device|phone|machine)/i],
  ['key lifetime claim that ignores encrypted backup/escrow',
    /generated\s+locally\s+and\s+never\s+leaves/i],
  ['card vault key claimed hardware-derived',
    /derived\s+from\s+the\s+device\s+hardware[\s\-]back(?:ed)?\s+key/i],
];

// ── STALE GENESIS CLOSE, IN ANY LANGUAGE ──────────────────────────
//
// The two English close patterns above only fire on an English lead word ("through",
// "closes", "ends"…) or an ISO range. The app ships in twelve locales, the Vision
// narrative in twelve more files, and a stale close in Japanese or Swahili reads to
// that user exactly as the English one does — so it has to be caught the same way.
//
// Rule: any STALE CLOSE LITERAL — the close or the abandoned
// kernel's close (2026-10-19), in ISO, epoch-second/ms, "07-27→10-19" shorthand,
// numeric, or a localized month form for every shipped locale — that sits in the same
// sentence as Genesis / window / close / until wording (any shipped language) is a
// stale close claim, UNLESS that same sentence marks it as history (superseded,
// predecessor, abandoned, retired, historical, "moved … from", "extended",,
//) or asserts its absence (a test's not.toContain). Sentence-bounded, not
// file-bounded, so a banner at the top of a file never whitewashes a line below it.
const NOT_OTHER_YEAR = String.raw`(?!,?\s*(?:de\s+|năm\s+)?(?!2026)\d{4})`;
const STALE_CLOSE_LITERALS = [
  /2026-10-(?:26|19)/,                                                  // ISO
  /\b1_?792_?(?:972_?800|368_?000)(?:_?000)?\b/,                         // epoch s / ms (1792972800 / 1792368000)
  /\b0?(?:7-27|8-0?3)\s*(?:→|->|\.\.|–|—|to)\s*10-(?:19|26)\b/i,          // "07-27→10-19" / "08-03→10-26" shorthand
  new RegExp(String.raw`\boct(?:ober)?\.?\s+(?:26|19)(?:st|th)?\b` + NOT_OTHER_YEAR, 'i'),          // en: October 26
  new RegExp(String.raw`\b(?:26|19)(?:st|th)?\s+(?:of\s+)?oct(?:ober)?\b` + NOT_OTHER_YEAR, 'i'),   // en: 26 October
  new RegExp(String.raw`\b(?:26|19)\s+de\s+(?:octubre|outubro)\b` + NOT_OTHER_YEAR, 'i'),            // es / pt
  new RegExp(String.raw`\b(?:26|19)\s+octobre\b` + NOT_OTHER_YEAR, 'i'),                              // fr
  new RegExp(String.raw`\b(?:26|19)\.?\s+(?:oktober|oktoba|oktubre)\b` + NOT_OTHER_YEAR, 'i'),        // id / sw / tl / de
  new RegExp(String.raw`\b(?:oktober|oktoba|oktubre)\s+(?:26|19)\b` + NOT_OTHER_YEAR, 'i'),            // tl / sw month-first
  new RegExp(String.raw`\b(?:26|19)\s+tháng\s+(?:10|mười)(?![\d/])` + NOT_OTHER_YEAR, 'i'),          // vi: 26 tháng 10
  /(?<!(?!2026)\d{4}\s*年\s*)10\s*月\s*(?:26|19)\s*日/,                   // ja / zh: 10月26日
  /(?<!(?!2026)\d{4}\s*년\s*)10\s*월\s*(?:26|19)\s*일/,                   // ko: 10월 26일
  /(?:26|19)\s+अक्टूबर|अक्टूबर\s+(?:26|19)/,                                // hi
  /\b(?:26|19)[./]10[./]2026\b|\b10\/(?:26|19)\/2026\b/,                  // numeric day-first / month-first
];
/** Genesis / window / close / until wording, in every shipped language (en es pt fr id sw tl vi ja zh ko hi). */
const CLOSE_CONTEXT = new RegExp([
  String.raw`genes[ie]s|g[ée]nesis|gênesis|genèse|ジェネシス|创世|創世|제네시스|जेनेसिस`,
  String.raw`window|ventana|fen[eê]tre|janela|jendela|dirisha|ウィンドウ|窗口|기간|विंडो`,
  String.raw`\bclos(?:e|es|ed|ing)\b|\bends?\b|\bending\b|\buntil\b|\bthrough\b|end_ms|endsAt|END_MS|admission`,
  String.raw`cierra|cierre|termina|finaliza|hasta|ferme|jusqu|encerra|\baté\b|berakhir|ditutup|hingga|sampai`,
  String.raw`inafungwa|itafungwa|mwisho|\bhadi\b|magsasara|hanggang|matatapos|kết thúc|đóng|締め切|終了|まで|结束|截止|关闭|關閉|종료|마감|까지|समाप्त|बंद`,
].join('|'), 'i');
/** A sentence that marks the stale date as history, or asserts its absence, is not a close claim. */
const HISTORY_MARKER = /supersed|predecessor|abandon|retired|historical|previously|formerly|moved\b[^.]{0,60}\bfrom\b|\bextended\b|not\.to(?:Contain|Match)|assertNotIn|doesNotMatch/i;
/** "a grant dated after 2026-10-26 settles" names the old close as a boundary PASSED, not as the close. */
const AFTER_THE_DATE = /\b(?:after|beyond|past|later\s+than)\s+(?:the\s+)?$/i;
const SENTENCE_END = /[.!?](?=\s|$)|[。！？।]/g;

function sentenceAround(flat, index, length) {
  let start = Math.max(0, index - 240);
  let end = Math.min(flat.length, index + length + 240);
  SENTENCE_END.lastIndex = start;
  let m;
  while ((m = SENTENCE_END.exec(flat)) && m.index < index) start = m.index + m[0].length;
  SENTENCE_END.lastIndex = index + length;
  if ((m = SENTENCE_END.exec(flat)) && m.index < end) end = m.index + m[0].length;
  return flat.slice(start, end);
}

/** Every stale-close sentence in `flat` (already whitespace-normalised). */
function staleCloseSentences(flat) {
  const out = [];
  for (const literal of STALE_CLOSE_LITERALS) {
    const rx = new RegExp(literal.source, literal.flags.includes('g') ? literal.flags : literal.flags + 'g');
    let m;
    while ((m = rx.exec(flat))) {
      const sentence = sentenceAround(flat, m.index, m[0].length);
      const lead = flat.slice(Math.max(0, m.index - 24), m.index);
      if (CLOSE_CONTEXT.test(sentence) && !HISTORY_MARKER.test(sentence) && !AFTER_THE_DATE.test(lead)) {
        out.push(sentence.trim());
      }
      if (m[0].length === 0) rx.lastIndex += 1;
    }
  }
  return out;
}
const STALE_CLOSE_CLAIM = 'Genesis close stated as a stale date in any language (open through 2026-12-31)';

function exemptionFor(rel) {
  for (const [rx, why] of EXEMPT) if (rx.test(rel)) return why;
  return null;
}

/** The claim names this one file may carry (and only those). */
function claimExemptionsFor(rel) {
  return new Set(CLAIM_EXEMPT.filter(([rx]) => rx.test(rel)).map(([, claim]) => claim));
}

function walk(abs, out) {
  let st;
  try { st = statSync(abs); } catch { return; }
  if (st.isFile()) { out.push(abs); return; }
  if (!st.isDirectory()) return;
  for (const entry of readdirSync(abs)) walk(path.join(abs, entry), out);
}

const files = [];
if (artifactMode) walk(ROOT, files);
else for (const surface of SURFACES) walk(path.join(ROOT, surface), files);

/** A file is text when its first 8 KiB hold no NUL byte (artifact mode reads every such file). */
function isText(abs) {
  const head = readFileSync(abs).subarray(0, 8192);
  return !head.includes(0);
}

const scanned = [];
for (const abs of files) {
  const rel = path.relative(ROOT, abs);
  if (artifactMode ? !isText(abs) : !EXT.has(path.extname(abs))) continue;
  if (exemptionFor(rel)) continue;
  scanned.push({ abs, rel });
}

if (listOnly) {
  scanned.forEach((f) => console.log(f.rel));
  console.log(`--- ${scanned.length} files`);
  process.exit(0);
}

// THE EMPTY POPULATION IS NOT A PASS. Scanning zero files would report
// "clean" forever — e.g. if --root pointed somewhere wrong, or a rename emptied
// every surface. Treat it as a distinct failure with its own exit path.
if (scanned.length === 0) {
  console.error(`armed-state-copy: SCANNED ZERO FILES under ${ROOT}`);
  console.error('A clean result over an empty population asserts nothing. Check --root.');
  process.exit(2);
}

function hits(text) {
  const flat = text.replace(/\s+/g, ' ');
  const found = CLAIMS.filter(([, rx]) => rx.test(flat)).map(([name]) => name);
  if (staleCloseSentences(flat).length) found.push(STALE_CLOSE_CLAIM);
  return found;
}

let planted = null;
if (selfTest) {
  // NEGATIVE CONTROL: a scanner that has only ever run over clean input is
  // indistinguishable from one hard-wired to print ok. Plant the exact claim this
  // exists to catch, in memory, and require detection.
  planted = 'The PVT9 Genesis campaign is currently unarmed and has no approved dates.';
  const detected = hits(planted);
  if (detected.length < 2) {
    console.error('armed-state-copy SELF-TEST FAILED: planted claim not detected');
    console.error(`  planted : ${planted}`);
    console.error(`  detected: ${JSON.stringify(detected)}`);
    process.exit(1);
  }
  // And prove the wrap-awareness specifically: the same claim broken across lines.
  const wrapped = 'The PVT9 Genesis campaign is\n  currently\n  unarmed and has no\n  approved dates.';
  if (hits(wrapped).length < 2) {
    console.error('armed-state-copy SELF-TEST FAILED: wrapped claim escaped detection');
    console.error('  the whitespace normalisation is not working — this is the exact');
    console.error(' defect that shipped on 2026-07-28 and again in.');
    process.exit(1);
  }
  // the stale close, flat and wrapped, and the historical form that must stay sayable.
  for (const stale of ['Genesis is armed and admitting through 2026-10-26.', 'Genesis runs 2026-08-03 → 2026-10-26.', 'The Genesis window ends\n  October 26, 2026.']) {
    if (!hits(stale).some((n) => n.includes('2026-10-26'))) {
      console.error('armed-state-copy SELF-TEST FAILED: stale Genesis close not detected');
      console.error(`  planted : ${stale}`);
      process.exit(1);
    }
  }
  if (hits(' moved the Genesis close from 2026-10-26 to 2027-01-01; it is open through December 31, 2026.').length) {
    console.error('armed-state-copy SELF-TEST FAILED: the close pattern fired on a true historical sentence');
    process.exit(1);
  }
  // the stale close in EVERY shipped locale, plus the machine forms. Each of these
  // passed the pre- scanner (its close patterns were English-lead-word only).
  const localizedStaleCloses = [
    ['en', 'Genesis wraps up on Oct 26.'],
    ['es', 'La campaña Génesis cierra el 26 de octubre de 2026.'],
    ['pt', 'A campanha Gênesis termina em 26 de outubro de 2026.'],
    ['fr', 'La campagne Genesis se termine le 26 octobre 2026.'],
    ['id', 'Kampanye Genesis berakhir pada 26 Oktober 2026.'],
    ['sw', 'Kampeni ya Genesis inafungwa tarehe 26 Oktoba 2026.'],
    ['tl', 'Magsasara ang Genesis sa Oktubre 26, 2026.'],
    ['vi', 'Chiến dịch Genesis kết thúc vào ngày 26 tháng 10 năm 2026.'],
    ['ja', 'ジェネシスは2026年10月26日に終了します。'],
    ['zh', '创世活动于2026年10月26日结束。'],
    ['ko', '제네시스는 2026년 10월 26일에 종료됩니다.'],
    ['hi', 'जेनेसिस 26 अक्टूबर 2026 को समाप्त होता है।'],
    ['en (abandoned 10-19)', 'The Genesis window closes October 19, 2026.'],
    ['ja (abandoned 10-19)', 'ジェネシス期間は10月19日まで。'],
    ['epoch ms', 'export const GENESIS_WINDOW_END_MS = 1_792_972_800_000;'],
    ['epoch s', 'genesisEndsAt = 1792368000'],
    ['shorthand', 'the .genesis block (window 07-27→10-19) is the live window'],
    ['numeric', 'Genesis: hasta el 26/10/2026.'],
  ];
  for (const [lang, stale] of localizedStaleCloses) {
    for (const form of [stale, stale.replace(/ /g, '\n  ')]) {
      if (!hits(form).includes(STALE_CLOSE_CLAIM)) {
        console.error(`armed-state-copy SELF-TEST FAILED: stale Genesis close not detected (${lang})`);
        console.error(`  planted : ${form}`);
        process.exit(1);
      }
    }
  }
  // review: the manual, its mirror and llms-full.txt are exempt from ONE claim each, never
  // whole-file. A stale close planted in any of them must still be reported.
  for (const rel of ['docs/PROVIAN_MANUAL.md', 'provian-website/public/docs-md/manual.md', 'provian-website/public/llms-full.txt']) {
    const allowed = claimExemptionsFor(rel);
    const reported = hits('Genesis closes October 26, 2026. La campaña Génesis cierra el 26 de octubre de 2026.')
      .filter((claim) => !allowed.has(claim));
    if (exemptionFor(rel) || !reported.includes(STALE_CLOSE_CLAIM) || allowed.size !== 1 || !allowed.has(QUOTED_TO_FORBID)) {
      console.error(`armed-state-copy SELF-TEST FAILED: ${rel} hides claims beyond the one it quotes`);
      console.error(`  whole-file exemption: ${exemptionFor(rel)}; claim exemptions: ${JSON.stringify([...allowed])}`);
      process.exit(1);
    }
  }
  // …and the true sentences around it must stay sayable, in more than one language.
  const closeMustNotFire = [
    'Genesis is open through December 31, 2026 (the window closes 2027-01-01T00:00:00Z).',
    'ジェネシスは2026年12月31日まで開いています。',
    'La campaña Génesis está abierta hasta el 31 de diciembre de 2026.',
    'A Genesis grant settles on the successor with a date after 2026-10-26.',
    'The predecessor kernel closed Genesis on 2026-10-26; extended it.',
    'Epoch 12 opens 2026-10-26T00:00:00Z.',
    'The 2025 conference ended October 26, 2025.',
    "expect(desc).not.toContain('2026-10-26'); // the genesis close must not be the old one",
  ];
  for (const sentence of closeMustNotFire) {
    if (hits(sentence).includes(STALE_CLOSE_CLAIM)) {
      console.error('armed-state-copy SELF-TEST FAILED: the stale-close detector fired on a TRUE sentence');
      console.error(`  sentence: ${sentence}`);
      console.error(`  matched : ${JSON.stringify(staleCloseSentences(sentence.replace(/\s+/g, ' ')))}`);
      process.exit(1);
    }
  }
  // The SECURITY/CUSTODY class gets its own controls. Without them these patterns
  // would have been observed only over a tree they had just been used to clean —
  // green forever, and indistinguishable from patterns that match nothing at all.
  // Each planted string is a claim that WAS in the tree before.
  const securityClaims = [
    ['secure hardware protects your wallet keys',
      'wallet keys claimed protected by secure hardware'],
    ['Hardware-backed keys protect credential encryption, while encrypted secrets live in secure storage.',
      'hardware-backed keys claimed to protect encryption'],
    ['Non-custodial by architecture: your keys never leave your device.',
      'absolute custody claim: your keys never leave your device'],
    ['the key is generated locally and never leaves the machine',
      'key lifetime claim that ignores encrypted backup/escrow'],
    ['A per-credential key is derived from the device hardware-backed key (Secure Enclave / StrongBox).',
      'card vault key claimed hardware-derived'],
    ['The wallet private key lives in the Secure Enclave.',
      'wallet key claimed to live in secure hardware'],
  ];
  for (const [planted, expected] of securityClaims) {
    if (!hits(planted).includes(expected)) {
      console.error('armed-state-copy SELF-TEST FAILED: security claim not detected');
      console.error(`  planted : ${planted}`);
      console.error(`  expected: ${expected}`);
      console.error(`  detected: ${JSON.stringify(hits(planted))}`);
      process.exit(1);
    }
    // …and wrapped, since that is how it actually appears in JSX and long prose.
    const wrapped = planted.replace(/ /g, '\n  ');
    if (!hits(wrapped).includes(expected)) {
      console.error('armed-state-copy SELF-TEST FAILED: wrapped security claim escaped');
      console.error(`  planted : ${expected}`);
      process.exit(1);
    }
  }

  // OVER-DETECTION CONTROL. A pattern that fires on everything is as useless as one
  // that fires on nothing, and these two sentences are TRUE and must stay sayable:
  // the MCP stdio description, and the accurate two-key statement.
  const mustNotFire = [
    'stdio mode: pass agent_private_key and the tool signs in-process (the key never leaves the machine).',
    'The PE attestation key is P-256, lives in the Secure Enclave, and never leaves the chip; it identifies the device, not the wallet.',
    'Your card details never leave your phone.',
  ];
  for (const sentence of mustNotFire) {
    const fired = hits(sentence);
    if (fired.length) {
      console.error('armed-state-copy SELF-TEST FAILED: pattern fired on a TRUE sentence');
      console.error(`  sentence: ${sentence}`);
      console.error(`  fired   : ${JSON.stringify(fired)}`);
      process.exit(1);
    }
  }

  console.log('armed-state-copy self-test: ok — flat AND line-wrapped claims both detected');
  console.log(`  stale Genesis close: ${localizedStaleCloses.length} planted closes (12 locales + machine forms)`
    + ` detected flat and wrapped, ${closeMustNotFire.length} true sentences correctly ignored`);
  console.log(`  security/custody class: ${securityClaims.length} planted claims detected,`
    + `      ${mustNotFire.length} true sentences correctly ignored`);
  process.exit(0);
}

const failures = [];
for (const { abs, rel } of scanned) {
  let text;
  try { text = readFileSync(abs, 'utf8'); } catch { continue; }
  const allowed = claimExemptionsFor(rel);
  const found = hits(text).filter((claim) => !allowed.has(claim));
  if (found.length) {
    const sentences = found.includes(STALE_CLOSE_CLAIM) ? staleCloseSentences(text.replace(/\s+/g, ' ')) : [];
    failures.push({ rel, found, sentences });
  }
}

if (failures.length) {
  console.error(`armed-state-copy: STALE ARMED-STATE COPY in ${failures.length} file(s):\n`);
  for (const { rel, found, sentences } of failures) {
    console.error(`      ${rel}`);
    found.forEach((f) => console.error(`      ${f}`));
    sentences.slice(0, 5).forEach((t) => console.error(`        > ${t.length > 200 ? `${t.slice(0, 200)}…` : t}`));
  }
  console.error('\nARMED STATE: Genesis is ARMED and admitting 2026-08-03.. 2026-12-31; the');
  console.error('agent leg qualifies on AGENT WALLET CREATION, not external-address proof.');
  console.error('\nSECURITY/CUSTODY: the wallet key is secp256k1, PIN-encrypted at rest and');
  console.error('biometric-gated, and it DOES leave the device as ciphertext synced to iCloud');
  console.error('Keychain / Google Drive — that backup is what makes recovery work. Only the');
  console.error('P-256 PE attestation key is hardware-held, and it identifies the DEVICE, not');
  console.error('the wallet. The Secure Enclave cannot hold a secp256k1 key.');
  console.error('\nFix the copy, or — if the string is legitimately historical, or is quoted in');
  console.error('order to be forbidden — add an EXEMPT entry WITH ITS REASON in');
  console.error('scripts/check-armed-state-copy.mjs.');
  process.exit(1);
}

console.log(`armed-state-copy: ok — ${scanned.length} files scanned under ${path.relative(process.cwd(), ROOT) || '.'}, no stale armed-state claims`);
