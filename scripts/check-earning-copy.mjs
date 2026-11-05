#!/usr/bin/env node
/**
 * earning-copy guard — INVERTED (allowlist) architecture.
 *
 * The prior guard was a denylist of exact stale phrases, so residual eligibility
 * framing that used a novel wording sailed through (the same failure mode as the
 * / doctrine sweeps that certified zero over surviving framing).
 *
 * This guard instead flags EVERY occurrence, on a guarded PROSE surface, of the
 * superseded-framing trigger families — the `eligib-` word family, "no right to
 * PVT", "earns no PVT", "policy-gated", the "record only" doctrine, and
 * conditional-mint phrasing ("work can/may mint", "PEs record participation
 * without minting", …) — and FAILS unless the occurrence matches an explicit
 * allowlist entry. The allowlist is the do-not-change set:
 * - Genesis qualifying language (real window / grant gates)
 * - arbitrator eligibility (Court panel seating)
 * - jurisdiction blocking / deferment / sanctions
 * - beneficiary-projection copy (names the relay's eligible-only API filter)
 * - "PE-type proposals grant no mint eligibility"
 * - the ToS §5.3 securities text in its mirrored copies
 * - internal status identifiers in code and named protocol machinery
 * (the `eligible`/`ineligible`/`ineligible_terminal`/`pending_cache`
 * mint_status/disposition values, the eligibility verifier contract, the
 * graduated-release `deferred → eligible` transition, the attestation-tier
 * "weight, never eligibility" distinction, the H±1 prospective fence, the
 * x402 reputation gate, and the `EligibilityVerifier` / `ELIGIBILITY_DISCLAIMER`
 * symbols)
 * - archives / generated build output
 *
 * Product-doctrine framing ("your work mints WHEN eligible", "only eligible PEs
 * are money", "eligible earnings", "minting eligibility", "otherwise eligible to
 * mint") matches none of these and fails.
 *
 * The positive locale-parity assertions (the 12 locales carry the correct
 * "your work mints … once … witness" copy) are retained: those are allowlist-shaped
 * checks that the RIGHT copy is present, and they catch line-wrapped mistranslations.
 *
 * Prose extraction keeps the guard off code: markdown/HTML/text are scanned whole
 * (fenced/inline code stripped — code tokens are allowlisted anyway); JSON is
 * scanned by string VALUE (keys, which are identifiers, are never product copy);
 * TS/JS is scanned by string/template literal and JSX text only (never identifiers,
 * type literals, or comments), which reaches backend user-facing disclaimer strings
 * without drowning in `mint_status === 'eligible'` field logic.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const rootAt = args.indexOf('--root');
const root = rootAt < 0 ? repo : path.resolve(args[rootAt + 1]);
const selfTest = args.includes('--self-test');
const verbose = args.includes('--verbose');

const extensions = new Set(['.md', '.markdown', '.txt', '.json', '.ts', '.tsx', '.js', '.mjs', '.html', '.htm']);
// Directories and files outside the product-copy surface: archives, generated
// output, dependency trees, historical run logs, and this guard itself.
const exempt = [
  /(^|\/)DECISIONS\.md$/, /(^|\/)OPEN_ITEMS\.md$/, /(^|\/)STATUS\.md$/, /(^|\/)WP_SCOPE\.md$/,
  /(^|\/)CLAUDE\.md$/, /(^|\/)AGENTS\.md$/, /(^|\/)README\.md$/,
  /(^|\/)\.git\//, /node_modules\//, /(^|\/)Pods\//, /(^|\/)dist(?:-bundle)?\//,
  /(^|\/)build\//, /\.next\//, /(^|\/)coverage\//, /(^|\/)\.expo\//, /(^|\/)out\//,
  /(^|\/)typechain-types\//, /(^|\/)artifacts\//, /(^|\/)cache\//, /(^|\/)__mocks__\//,
  /check-earning-copy\.mjs$/, /THESIS_OVERHAUL_LEDGER_2026-09-19\.md$/,
  /\.test\.[tj]sx?$/, /\.spec\.[tj]sx?$/, /(^|\/)__tests__\//, /(^|\/)__test-helpers__\//,
  /(^|\/)scripts\//, /\.d\.ts$/, /package(?:-lock)?\.json$/, /tsconfig.*\.json$/,
  /\.generated\./, /forbidden-constructs\.ts$/,
  // Internal engineering / operator surfaces (ledgers, reports, ops dashboard,
  // backend ops docs, strategy) are records/tools, not product copy — exempt like archives.
  /(^|\/)OPERATIONS\.md$/, /provian-backend\/docs\//,
  /(^|\/)GLOBAL_STRATEGY\.md$/, /(^|\/)RATE_LIMIT_AUDIT\.md$/,
  // Frozen canonical papers and their byte-identical mirrors: the thesis, founding
  // statement, exponential-currency, and governance paper are curated source
  // (byte-checked), not product UI copy.
  /(^|\/)reference\//,
  /(?:the-provian-thesis|theprovianthesis|the-exponential-currency|the_exponential_currency|governance-paper|founding-statement|provian_founding_statement)\.md$/i,
  // Generated mirrors — the SOURCE is guarded, so the byte-identical generated
  // output is not scanned (it is regenerated from source by sync-docs/sync-legal).
  /provian-website\/public\/docs-md\//, /provian-website\/src\/content\/legal\//,
  // The SDK's PE schema snapshot is generated from provian-backend/src/core/schema/pe-schema.ts
  // (`schema:check` keeps them identical); its disposition field lists the protocol's state names.
  /provian-agent-sdk\/schema\/pe-schema\.json$/,
  /provian-website\/public\/legal\//, /(^|\/)llms(?:-full)?(?:\.post-genesis)?\.txt$/,
];
// A few reference/ files ARE the published-library source (sync-docs vendors them
// into public/docs-md), so they carry product voice and stay guarded despite
// reference/ being exempt for the frozen thesis/founder papers.
const referenceGuarded = /reference\/(?:Provian_Tokenomics_PVT_v3|Provian_Agent_Wallet_v2|PE_Generation_Model_v5|CONTRACT_VERSION_STATUS|Provian_PE_Architecture_v5)\.md$/;
const skipDirs = /(^|\/)(?:\.git|\.claude|node_modules|Pods|dist|dist-bundle|build|out|\.next|coverage|\.expo|typechain-types|artifacts|cache)(?:\/|$)/;

// "current docs / library / manual / legal" scope: legal, the published website
// library mirror, and the agent/developer-facing canonical docs. Every OTHER
// docs/*.md (engineering ledgers, WP reports, plans, audits, secrets) is an
// internal record and is NOT product copy — exempt like an archive.
const guardedDocBasenames = new Set([
  'AGENT_API', 'AGENT_INTEGRATION', 'AUTH_MAP', 'BURN_TO_PRESENT', 'CAPTURE_ARCHITECTURE',
  'COMMONS', 'COMMONS_ARTIFACTS_SPEC',
  'EXTERNAL_DEVICE_INTEGRATION', 'FRAMEWORK_INTEGRATION_EXAMPLES',
  'PE_GENERATION_MODEL', 'PE_PROTOCOL_SPEC', 'PROVIAN_MANUAL',
  'QUICK_START', 'UNIVERSAL_PE_SUBMISSION_SPEC',
  'DEVELOPER_SETUP', 'AGENT_BENEFICIARY_ONBOARDING', 'ATTESTATION_ROADMAP', 'CRYPTO_GOVERNANCE',
]);
function docsExempt(rel) {
  if (!rel.startsWith('docs/')) return false;
  // Legal and outward-facing launch/marketing copy are always guarded.
  if (rel.startsWith('docs/legal/') || rel.startsWith('docs/launch')) return false;
  const base = path.basename(rel, '.md');
  return !guardedDocBasenames.has(base);
}

// ---- Trigger families (what the guard flags before allowlisting) --------------
// The eligib word family, matched as a whole word only (never as part of an
// identifier such as isEligible / eligibleClaims / eligibility_ms).
const ELIGIB = /(?<![A-Za-z0-9_$])(in)?eligib(?:le|les|ility|ilities)(?![A-Za-z0-9_$])/gi;
const phraseTriggers = [
  ['no right to PVT', /\b(?:creates?\s+)?no\s+right\s+to\s+pvt\b/gi],
  ['earns no PVT', /\bearns?\s+no\s+pvt\b/gi],
  ['policy-gated', /\bpolicy[\s-]gated\b/gi],
  ['record-only doctrine', /\brecord[\s-]only\s+(?:pe|envelope)[^.]{0,45}\b(?:not\s+money|not\s+a\s+payment|stored\s+but|is\s+not\s+pvt|no\s+pvt)/gi],
  ['record participation without minting', /\brecords?\s+participation\s+without\s+minting\b/gi],
  ['most PEs record then mint', /\bmost\s+(?:pes?|envelopes?|records?)\b[^.]{0,45}\b(?:record|mint|money)/gi],
  ['only a subset mints', /\bonly\s+(?:an?\s+)?(?:eligible\s+|verified\s+)?subset[^.]{0,45}\b(?:mint|money|earn)/gi],
  ['work can or may mint PVT', /\b(?:your|their|its|the\s+agent(?:'s|s')?|work|acts?\s+of\s+work|activity|pes?|envelopes?|records?)\s+(?:can|may|could)\s+(?:mint\b|mint\s+pvt|earn\s+pvt)\b/gi],
  ['mints only when eligible', /\bmints?\s+only\s+when\s+eligible\b/gi],
];

// ---- Allowlist: an eligib occurrence matching one of these EXPLICIT collocations
// is a do-not-change use (set). Everything else is superseded framing.
const allowedCollocations = [
  // Arbitrator eligibility (Court panel seating)
  /\beligible\s+(?:human\s+)?arbitrators?\b/i,
  /\barbitrator\s+eligibility\b/i,
  /(?:≥\s*)?\d+\s+eligible\b/i,                                  // "3 eligible", "≥15 eligible"
  /\{\{eligible\}\}\s+eligible\b/i,                              // "{{eligible}} eligible of {{total}}"
  /\beligible\s+of\s+(?:\{\{total\}\}|total)\b/i,
  /\beligible\s+human\s+members?\b/i,
  // Court/arbitrator eligibility by proximity (escrow track record, dispute panel)
  /\b(?:arbitrat|juror|panel|court|escrow|dispute)\w*[^.]{0,70}\b(?:in)?eligib\w*/i,
  /\b(?:in)?eligib\w*[^.]{0,70}\b(?:arbitrat|juror|panel|court|escrow|dispute)/i,
  // Foundation floor eligibility is personhood, independent of work minting.
  /\beligibility\s+is\s+verified\s+personhood\b/i,
  // Foundation floor gate (agent wallets permanently ineligible)
  /\bineligible\s+for\s+(?:that\s+|the\s+)?(?:human\s+)?(?:distribution|dividend|foundation)/i,
  /\bpermanently\s+ineligible\b/i,
  // Named verifier / disclaimer / module symbols
  /\beligibility\s+verifier\b/i, /\beligibilityverifier\b/i, /\beligibility_disclaimer\b/i,
  /\bwp-ev\/eligibility\b/i, /\beligibility\.ts\b/i, /\bsettlement\s+eligibility\s+module\b/i,
  // Jurisdiction blocking / deferment / sanctions / local law
  /\bjurisdiction\s+eligibility\b/i, /\bjurisdiction-aware\s+eligibility\b/i,
  /\beligibility\s+checks?\b/i, /\beligibility\s+registry\b/i,
  /\bindependent-provider\s+eligibility\b/i, /\beligibility\s+conditions?\b/i,
  /\b(?:in)?eligib\w*[^.]{0,55}\b(?:local\s+law|jurisdiction|sanction|compliance|region|deferred|blocked|permitted)/i,
  /\b(?:local\s+law|jurisdiction|sanction|compliance|reorg|deferred|blocked|permitted)[^.]{0,70}\b(?:in)?eligib\w*/i,
  /\beligibility,\s+not\s+mere\s+validity\b/i,
  // Prospective earning fence (H+1) — a genuine gate, not product doctrine
  /\beligibility\s+fence\b/i, /\bgo-forward\s+eligibility\b/i,
  // Age eligibility (legal ToS §8) and Court/arbitrator eligibility criteria
  /\beligibility\b(?=[^.]{0,45}(?:18\s+years|age\b))/i, /##\s*\d*\.?\s*Eligibility\b/i,
  /\bcourt\s+eligibility\b/i, /\beligibility\s+criteria\b/i,
  // Verifier gate: a type with no verifier is never made eligible
  /\bno\s+verifier[^.]{0,30}\beligible\b/i, /\bnever\s+made\s+eligible\b/i,
  // Named matrix disposition / status machinery (documented, not doctrine)
  /\bdisposition[^.]{0,45}\beligible\b/i, /\beligible\s+self-attested\b/i,
  /\bhardware\s+eligibility\b/i, /\bsettlement\s+eligibility\b/i,
  /\bre-runs?\s+eligibility\b/i, /\beligibility,\s+takeover\b/i,
  /\brecording,\s+sealed\s+value,\s+eligibility\b/i, /\bno\s+eligibility,\s+scoring\b/i,
  /\beligible,\s+non-farm-capped\b/i, /\b(?:reputation|x402)\b[^.]{0,55}\beligib\w*/i,
  /\beligible\s+standard\s+claims?\b/i, /\beligible-verified(?:-pe)?\b/i,
  // PE-type proposals grant no mint eligibility
  /\bmint\s+eligibility\b(?=[^.]{0,20}(?:by\s+name|\.|$))/i,
  /\bgrants?\s+no\b[^.]{0,50}\beligibility\b/i,
  /\bno\s+economic\s+authority\s+or\s+mint\s+eligibility\b/i,
  // Attestation-tier ↔ eligibility distinction (weight, never eligibility)
  /\bnever\s+eligibility\b/i, /\bweight,\s+never\b[^.]{0,15}eligib\w*/i,
  /\bnot\s+an?\s+eligibility\s+judgment\b/i,
  // Named matrix disposition of a specific action_type (human_approval etc.)
  /\beligible\b[^.]{0,45}\bwitness-class\b/i, /\bwitness-class\b[^.]{0,45}\beligible\b/i,
  // Schema disposition-label lead ("eligible — …", "record_only — …")
  /\b(?:eligible|ineligible|record_only|pending_evidence)\s+—/i,
  // Internal mint_status / disposition VALUE and its state machine
  /(?:reaches|seals?|to|→|->|becomes?|stays?|restore[sd]?|marks?|promotes?\s+it\s+to|move[sd]?\s+(?:back\s+)?to|classify|status\s*[=:]|status\s+is|says|make\s+it|makes?\s+it|leaves?\s+it|kept|left|remain[s]?|still|sat|be)\s+["'`]?(?:in)?eligible\b/i,
  /\bpending_(?:evidence|cache)\s*(?:->|→)\s*eligible\b/i,
  /\b(?:in)?eligible\s+(?:disposition|status|row|rows|act|acts|backlog|set|owner|state|standard\s+rows?|settlement|sealed\s+pe|now\b|AFTER|by\s+time|for\s+(?:abandonment|economic|at\s+most|settlement))/i,
  /\bnot-yet-eligible\b/i, /\bsettleable-eligible\b/i, /\beligible-but-dark\b/i,
  /\balready-eligible\b/i, /\bmatrix-eligible\b/i, /\bbounty-eligible\b/i, /\bhardware-eligible\b/i,
  /\bexpands?\s+with\s+every\s+eligible\b/i,
  /\d+\s+eligible\s*[\/,]/i,                                     // "64 eligible / 196 record_only"
  /\beligible[,\/]\s*\d+/i,                                      // "eligible, 31 pending_evidence"
  /\beligible\/(?:verified|neutral|lineage)/i,                   // matrix disposition slashes
  // Beneficiary projection (names the relay's eligible-only API filter; locale-tolerant)
  /\beligible[\s\S]{0,60}?project/i,
  // Genesis qualifying window
  /\bgenesis[^.]{0,70}\beligib\w*|\beligib\w*[^.]{0,70}\bgenesis/i,
];
function allowed(seg, idx, len) {
  return allowedCollocations.some(rx => {
    rx.lastIndex = 0;
    let m;
    const g = new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : rx.flags + 'g');
    while ((m = g.exec(seg))) {
      if (m.index <= idx && m.index + m[0].length >= idx + len) return true;
    }
    return false;
  });
}
// A trigger token that is itself a code token (backticked, bare-quoted status
// value, or snake/camel identifier fragment) is an internal status identifier.
function isCodeToken(text, start, end) {
  const before = text[start - 1];
  const after = text[end];
  if (before === '`' && after === '`') return true;                       // `eligible`
  if ((before === "'" || before === '"') && (after === "'" || after === '"')) return true; // 'eligible'
  if (before === '_' || after === '_') return true;                        // mint_eligible / eligible_ms
  if (before === '.') return true;                                         // .eligible
  if (before === '{' || after === '}') return true;                        // {{eligible}} i18n var
  return false;
}

const protectedTos = /^(?:docs\/legal\/terms-of-service\.md|provian-website\/src\/content\/legal\/terms\.md|provian-website\/public\/legal\/terms\.html|src\/screens\/Legal\/TermsOfServiceScreen\.tsx)$/;
// The public aggregate-record endpoints carry a §5.3-class no-claim securities
// disclaimer ("creates no right to PVT") that the check:wp2 runtime-truth audit
// REQUIRES verbatim (a record here is not a balance/claim). It is a protected
// disclaimer surface, not general product copy — so the phrase is allowed there.
const protectedDisclaimer = /^(?:provian-backend\/src\/routes\/agent-record\.ts|provian-backend\/src\/routes\/agent-profile\.ts|docs\/legal\/privacy-policy\.md)$/;
// The ToS §5.3 securities blockquote is legally protected byte-for-byte.
function stripProtectedTos(text) {
  return text
    .replace(/RECORDING A PE CREATES NO RIGHT TO PVT\./g, '')
    .replace(/cannot determine PVT eligibility/gi, 'cannot determine PVT issuance');
}

// ---- Prose extraction ---------------------------------------------------------
function extractSegments(rel, raw) {
  const ext = path.extname(rel);
  if (ext === '.json') {
    try {
      const out = [];
      const walkJson = v => {
        if (typeof v === 'string') out.push(v);
        else if (Array.isArray(v)) v.forEach(walkJson);
        else if (v && typeof v === 'object') Object.values(v).forEach(walkJson);
      };
      walkJson(JSON.parse(raw));
      return { segs: out, code: false };
    } catch { return { segs: [raw], code: false }; }
  }
  if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.mjs') {
    const segs = [];
    // string + template literals (never comments, identifiers, or type literals)
    const lit = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/gs;
    let m;
    while ((m = lit.exec(raw))) segs.push(m[0].slice(1, -1));
    if (ext === '.tsx') {
      // JSX display text only: a run of natural-language chars between > and <,
      // with no code punctuation that would betray a generic, comment, or expr.
      const jsx = />\s*([A-Za-z][^<>{};=*/]{4,})</g;
      while ((m = jsx.exec(raw))) segs.push(m[1]);
    }
    return { segs, code: true };
  }
  // markdown / html / txt: whole file, with fenced + inline code removed
  return { segs: [raw.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')], code: false };
}

function scanSegments(rel, raw) {
  const { segs, code } = extractSegments(rel, raw);
  const isTos = protectedTos.test(rel);
  const isDisclaimer = protectedDisclaimer.test(rel);
  const failures = [];
  for (const original of segs) {
    let seg = isTos ? stripProtectedTos(original) : original;
    if (isDisclaimer) seg = seg.replace(/creates no right to PVT/gi, 'states the runtime truth');
    const record = (label, idx, len) => {
      if (isCodeToken(seg, idx, idx + len)) return;
      if (allowed(seg, idx, len)) return;
      failures.push({ label, snippet: seg.slice(Math.max(0, idx - 44), idx + len + 44).replace(/\s+/g, ' ').trim() });
    };
    let mm;
    // The bare eligib word family is scanned in PROSE only. In code files a bare
    // `eligible` is an internal status identifier (allowlisted by definition);
    // there we flag only the doctrine PHRASES, which are never legitimate code.
    if (!code) {
      ELIGIB.lastIndex = 0;
      while ((mm = ELIGIB.exec(seg))) record('eligib', mm.index, mm[0].length);
    }
    for (const [label, rx] of phraseTriggers) {
      rx.lastIndex = 0;
      while ((mm = rx.exec(seg))) record(label, mm.index, mm[0].length);
    }
  }
  return failures;
}

// ---- Positive locale-parity assertions (retained) -----------------------------
// Surface copy 2026-09-30, reworded the mint headline + the no-fixed-cap pill (pvtPill2).
const localeMintCopy = {
  'src/i18n/locales/en.json': ["Your work mints PVT, a currency you can actually hold.", "No fixed cap - supply grows only as fast as work is proven"],
  'src/i18n/locales/es.json': ["Tu trabajo acuña PVT, una moneda que puedes tener de verdad.", "Sin límite fijo - la oferta crece solo tan rápido como se prueba el trabajo"],
  'src/i18n/locales/fr.json': ["Votre travail frappe du PVT, une monnaie que vous détenez vraiment.", "Aucun plafond fixe - l’offre ne croît qu’au rythme du travail prouvé"],
  'src/i18n/locales/hi.json': ["आपका काम PVT बनाता है, एक मुद्रा जो सच में आपके हाथ में होती है।", "कोई तय सीमा नहीं - आपूर्ति केवल उतनी ही तेज़ी से बढ़ती है जितनी तेज़ी से काम प्रमाणित होता है"],
  'src/i18n/locales/id.json': ["Pekerjaan Anda mencetak PVT, mata uang yang benar-benar bisa Anda pegang.", "Tanpa batas tetap - pasokan hanya tumbuh secepat pekerjaan yang dibuktikan"],
  'src/i18n/locales/ja.json': ["あなたの仕事がPVTを鋳造します。実際に手にできる通貨です。", "固定上限なし - 供給は、仕事が証明される速さでしか増えません"],
  'src/i18n/locales/ko.json': ["내 작업은 PVT를 발행합니다. 실제로 손에 쥘 수 있는 통화입니다.", "고정 상한 없음 - 공급은 작업이 증명되는 속도로만 늘어납니다"],
  'src/i18n/locales/pt.json': ["Seu trabalho cunha PVT, uma moeda que você pode de fato guardar.", "Sem limite fixo - a oferta cresce só na velocidade em que o trabalho é provado"],
  'src/i18n/locales/sw.json': ["Kazi yako huzalisha PVT, sarafu unayoweza kuishika kweli.", "Hakuna kikomo kilichowekwa - ugavi hukua kwa kasi ile ile tu ambayo kazi inathibitishwa"],
  'src/i18n/locales/tl.json': ["Ang trabaho mo ay nagmi-mint ng PVT, perang talagang mahahawakan mo.", "Walang nakapirming limitasyon - lumalaki lang ang supply kasimbilis ng pagpapatunay ng trabaho"],
  'src/i18n/locales/vi.json': ["Công việc của bạn đúc ra PVT, một đồng tiền bạn thực sự có thể nắm giữ.", "Không có giới hạn cố định - nguồn cung chỉ tăng nhanh bằng tốc độ công việc được chứng minh"],
  'src/i18n/locales/zh.json': ["你的工作铸造 PVT，一种你真正能持有的货币。", "没有固定上限 - 供应的增长速度只与工作被证明的速度同步"],
};
// The PVT step carries its mint verb in pvtHeadline; its body (pvtSubtext) states the
// created-only-when-proven-work-settles rule. The mint-once paths below carry "once".
const requiredLocaleMintPaths = [
  'onboarding.unified.hookSubtext', 'onboarding.unified.pvtHeadline',
  'agentHub.registerDevicePrompt', 'connectAgent.agentSetupControlBody',
  'connectAgent.agentSetupLinkBody', 'connectAgent.agentSetupProofBody',
  'commons.benefit6', 'commons.memberBenefitPVT', 'commonsGovernance.statusBody',
  'pvtDetail.bulletEligibleMayMint',
];
const localeMintVerbs = {
  en: /mints?/i, es: /acuñ|genera/i, fr: /génèr|produit|frappe|émet|émis/i,
  hi: /बनाता|बनता|टकसाल/i, id: /mencetak|dicetak|menghasilkan/i,
  ja: /鋳造|生み出|発行/i, ko: /발행|주조|민트합니다/i,
  pt: /gera|produz|cunha|cria/i, sw: /zalisha|hutengeneza|hutengenezwa/i,
  tl: /lumilikha|gumagawa|nililikha|nagmi/i, vi: /tạo ra|đúc/i, zh: /铸造|铸币/i,
};
const requiredLocaleOncePaths = [
  'connectAgent.agentSetupLinkBody', 'connectAgent.agentSetupProofBody',
  'commons.benefit6', 'commons.memberBenefitPVT',
  'commonsGovernance.statusBody', 'pvtDetail.bulletEligibleMayMint',
];
const localeOnceWords = {
  en: /\bonce\b/i, es: /\buna (?:sola )?vez\b/i, fr: /\bune (?:seule )?fois\b/i, hi: /एक (?:ही )?बार/,
  id: /satu kali|sekali/i, ja: /一度(?!に)|一回/, ko: /한 번/, pt: /uma (?:única )?vez/i,
  sw: /mara moja/i, tl: /(?:nang\s+)?isang beses|minsan/i, vi: /một lần/i, zh: /一次/,
};
const localeWitnessVerbs = {
  en: /witness/i, es: /atestiguar/i, fr: /attester/i, hi: /साक्ष्य/,
  id: /menyaksikan/i, ja: /検証/, ko: /증명/, pt: /testemunhar/i,
  sw: /kushuhudia/i, tl: /saksihan/i, vi: /chứng kiến/i, zh: /见证/,
};
function readPath(object, dotted) { return dotted.split('.').reduce((value, key) => value?.[key], object); }
function localeChecks(rel, raw, checkedLocales) {
  const hits = [];
  checkedLocales.add(rel);
  try {
    const parsed = JSON.parse(raw);
    const [headline, pill] = localeMintCopy[rel];
    if (parsed?.onboarding?.unified?.pvtHeadline !== headline) hits.push('locale mint headline drift');
    if (parsed?.onboarding?.unified?.pvtPill2 !== pill) hits.push('locale mint pill drift');
    const locale = path.basename(rel, '.json');
    for (const keyPath of requiredLocaleMintPaths) {
      const value = readPath(parsed, keyPath);
      if (typeof value !== 'string' || !localeMintVerbs[locale].test(value)) hits.push(`locale mint semantics drift: ${keyPath}`);
    }
    for (const keyPath of requiredLocaleOncePaths) {
      const value = readPath(parsed, keyPath);
      if (typeof value !== 'string' || !localeOnceWords[locale].test(value)) hits.push(`locale mint-once semantics drift: ${keyPath}`);
    }
    // The proof line (: the one sentence under "Its work becomes proof") carries the
    // witness-not-record semantics the retired agentPrimaryLead used to carry.
    const proofLine = readPath(parsed, 'connectAgent.agentSetupProofBody');
    if (typeof proofLine !== 'string' || !localeWitnessVerbs[locale].test(proofLine)) hits.push('locale witness-not-record semantics drift: connectAgent.agentSetupProofBody');
  } catch { hits.push('locale JSON unreadable'); }
  return hits;
}

// ---- Negative control ---------------------------------------------------------
// Each planted line is a real residual family; the guard MUST flag every one.
const negativeControls = [
  ['bare eligible framing', 'All PEs are records; only eligible verified work may mint PVT.'],
  ['when eligible', 'Your work mints PVT when eligible.'],
  ['eligible earnings', 'Contribution and economic participation: eligible earnings and presentations.'],
  ['minting eligibility', 'Public projections and minting eligibility, versioned like an RFC.'],
  ['otherwise eligible to mint', 'For a PE that is otherwise eligible to mint, the range is 0.5x-4.0x.'],
  ['creates eligibility', 'Neither factor creates eligibility or guarantees PVT.'],
  ['guarantees eligibility', 'A tier never guarantees eligibility or payment.'],
  ['eligible subsequent activity', 'Eligible subsequent USDC receives and swaps become financial PEs.'],
  ['eligible chain-verified', 'Subsequent eligible chain-verified USDC receives enter the financial PE path.'],
  ['make the PE eligible', 'Only observed on-chain settlement can make the financial PE eligible.'],
  ['link_spend eligible type', 'link_spend is an eligible type witnessed by your own submission.'],
  ['no right to PVT prose', 'A record here is not a balance and creates no right to PVT.'],
  ['earns no PVT', 'A PE can remain useful even when it earns no PVT.'],
  ['policy-gated minting', 'Minting is limited and policy-gated across the network.'],
  ['record-only doctrine', 'A record-only PE is stored but is not money.'],
  ['work can mint', 'Your agent\'s work can mint PVT once it clears policy.'],
  ['most PEs without minting', 'Most PEs record participation without minting.'],
];
// Each planted line is a real do-not-change use; the guard MUST NOT flag any.
const positiveControls = [
  'genesis_signup qualifies once per agent on creating its wallet.',
  '3 eligible arbitrators are randomly selected; parties are excluded.',
  'Jurisdiction policy may leave a PE deferred or mark it ineligible for sanctions.',
  "Your {{share}}% share of this agent's eligible work, projected at the current settlement rate.",
  'PE-type proposals are documentation signals; they grant no mint eligibility.',
  'The mint_status reaches `eligible` after graduated release from deferred.',
  'Tier affects weight, never eligibility (wp-ev/eligibility.ts).',
  'human_approval is eligible at its verified witness-class base.',
  'The eligibility verifier 0x3a27957a is armed since 2026-07-31.',
];

if (selfTest) {
  let ok = true;
  for (const [label, line] of negativeControls) {
    const f = scanSegments('docs/PLANTED.md', line);
    if (!f.length) { console.error(`negative control NOT caught: ${label} :: ${line}`); ok = false; }
  }
  for (const line of positiveControls) {
    const f = scanSegments('docs/PLANTED.md', line);
    if (f.length) { console.error(`positive control WRONGLY flagged: ${line} :: ${f.map(x => x.label + '=' + x.snippet).join(' | ')}`); ok = false; }
  }
  if (!ok) { console.error('earning-copy self-test FAILED'); process.exit(1); }
  console.log(`earning-copy self-test: ok — ${negativeControls.length} residual families caught, ${positiveControls.length} do-not-change uses preserved`);
  process.exit(0);
}

function walk(target, out) {
  const rel = path.relative(root, target);
  if (rel && skipDirs.test(rel)) return;
  let st; try { st = statSync(target); } catch { return; }
  if (st.isFile()) out.push(target);
  else if (st.isDirectory()) for (const name of readdirSync(target)) walk(path.join(target, name), out);
}

const candidates = [];
walk(root, candidates);
const failures = [];
let count = 0;
const checkedLocales = new Set();
for (const file of new Set(candidates)) {
  const rel = path.relative(root, file);
  const isExempt = (exempt.some(rx => rx.test(rel)) && !referenceGuarded.test(rel)) || docsExempt(rel);
  if (!extensions.has(path.extname(file)) || isExempt) continue;
  count++;
  const raw = readFileSync(file, 'utf8');
  const hits = scanSegments(rel, raw).map(f => `${f.label}: "${f.snippet}"`);
  if (localeMintCopy[rel]) hits.push(...localeChecks(rel, raw, checkedLocales));
  if (hits.length) failures.push({ rel, hits });
}
if (root === repo && checkedLocales.size !== Object.keys(localeMintCopy).length) {
  failures.push({ rel: 'src/i18n/locales', hits: [`locale coverage ${checkedLocales.size}/${Object.keys(localeMintCopy).length}`] });
}
if (!count) { console.error('earning-copy: SCANNED ZERO FILES'); process.exit(1); }
if (failures.length) {
  console.error(`earning-copy: STALE FRAMING in ${failures.length} file(s):`);
  for (const { rel, hits } of failures) {
    console.error(`- ${rel}`);
    for (const h of (verbose ? hits : hits.slice(0, 8))) console.error(`    ${h}`);
    if (!verbose && hits.length > 8) console.error(`    … +${hits.length - 8} more (use --verbose)`);
  }
  process.exit(1);
}
console.log(`earning-copy: ok — ${count} files scanned, current doctrine preserved`);
