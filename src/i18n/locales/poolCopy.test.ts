/**
 * Capital pools are agent-only: people cannot create, fund, or join one. The in-app help never
 * describes pool powers to a person, and the Terms keep the pool power in Section 7.4, pointing
 * there from the custody summaries instead of restating it. The privacy policy, the institutions
 * banner and the website's people-facing pages do not restate the pool power either.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const LOCALES = ['en', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt', 'sw', 'tl', 'vi', 'zh'] as const;
const POOL_WORD: Record<(typeof LOCALES)[number], RegExp> = {
  en: /\bpools?\b/i, es: /\bpools?\b|fondos? comunes?/i, fr: /\bpools?\b|fonds communs/i, hi: /पूल/,
  id: /\bpool\b/i, ja: /プール/, ko: /풀/, pt: /\bpools?\b/i, sw: /\bpool\b/i, tl: /\bpool\b/i,
  vi: /quỹ góp chung|quỹ chung/i, zh: /资金池/,
};
const FAQ_KEYS = ['canProvianAccessFundsA', 'howMoveAssetsA'] as const;
const TERMS = readFileSync(resolve(ROOT, 'docs/legal/terms-of-service.md'), 'utf8');
const POOL_POWER = /admin key can (?:also )?execute a funded pool/;
const PRIVACY = readFileSync(resolve(ROOT, 'docs/legal/privacy-policy.md'), 'utf8');
const SITE_PAGES = ['support', 'invited', 'download', 'faq'].map((page) => ({
  page,
  text: readFileSync(resolve(ROOT, `provian-website/src/app/${page}/page.tsx`), 'utf8'),
}));
// People cannot use pools, so these people-facing pages do not mention them at all.
const SITE_POOL_WORD = /\bpools?\b/i;

/** The institutions banner may say pool activity is visible (one mention), never the pool power. */
function bannerPoolMentions(banner: string, word: RegExp): number {
  return (banner.match(new RegExp(word.source, 'gi')) ?? []).length;
}

function faqPoolHits(faq: Record<string, string>, word: RegExp): string[] {
  return FAQ_KEYS.filter((k) => word.test(faq[k] ?? ''));
}

/** Paragraphs outside Section 7.4 that restate the pool power instead of pointing to it. */
function termsPoolPowerOutside74(text: string): number {
  const start = text.indexOf('### 7.4 Capital Pools');
  const end = text.indexOf('\n### ', start + 1);
  const outside = start === -1 ? text : text.slice(0, start) + text.slice(end === -1 ? text.length : end);
  return outside.split('\n').filter((line) => POOL_POWER.test(line)).length;
}

describe('pool copy speaks only to agents', () => {
  it('no locale describes pools in the funds and assets help answers', () => {
    let checked = 0;
    for (const l of LOCALES) {
      const faq = JSON.parse(readFileSync(resolve(__dirname, `${l}.json`), 'utf8')).help.faq as Record<string, string>;
      for (const k of FAQ_KEYS) expect(typeof faq[k], `${l}.${k}`).toBe('string');
      expect(faqPoolHits(faq, POOL_WORD[l]), `${l}: help answers mention pools`).toEqual([]);
      checked += FAQ_KEYS.length;
    }
    expect(checked).toBe(24);
  });

  it('the Terms state the pool power only in Section 7.4, which says pools are agent-only', () => {
    expect(TERMS).toContain('Capital pools are available only to agent wallets, through the agent API');
    expect(TERMS.match(/capital pools are for agent wallets only/gi)?.length).toBe(3);
    expect(termsPoolPowerOutside74(TERMS)).toBe(0);
    expect(POOL_POWER.test(TERMS)).toBe(true); // 7.4 still states it
  });

  it('the institutions banner mentions pools once (the activity shown), never the pool power', () => {
    for (const l of LOCALES) {
      const banner = JSON.parse(readFileSync(resolve(__dirname, `${l}.json`), 'utf8')).commonsInstitutions.observeBannerEscrow as string;
      expect(bannerPoolMentions(banner, POOL_WORD[l]), `${l}: observeBannerEscrow`).toBe(1);
    }
  });

  it('the privacy policy and the website pages do not restate the pool power', () => {
    expect(PRIVACY).not.toMatch(/pool admin powers?/i);
    expect(PRIVACY).toContain('the bounded escrow admin power is described in the Terms of Service');
    expect(SITE_PAGES).toHaveLength(4);
    for (const { page, text } of SITE_PAGES) expect(SITE_POOL_WORD.test(text), page).toBe(false);
  });

  it('RED: the banner with its pool-power sentence, and a site line restating it, are caught', () => {
    const old = 'You are seeing escrow, promise, and pool activity. Provian’s admin key can execute pools only to their creator-fixed target.';
    expect(bannerPoolMentions(old, POOL_WORD.en)).toBe(2);
    expect(bannerPoolMentions('Bạn đang xem hoạt động ký quỹ, lời hứa và quỹ chung. Khóa quản trị chỉ có thể thực thi quỹ góp chung.', POOL_WORD.vi)).toBe(2);
    expect(SITE_POOL_WORD.test('The admin key can also execute pools to their fixed target.')).toBe(true);
    expect(SITE_POOL_WORD.test('Provian’s bounded escrow and pool admin powers are disclosed in the Terms.')).toBe(true);
    expect(SITE_POOL_WORD.test('escrow and pool payments follow the bounded admin powers described above.')).toBe(true);
    expect(SITE_POOL_WORD.test('escrow payments follow the bounded admin power described above.')).toBe(false);
  });

  it('RED: a pool sentence in a help answer, or the pool power restated outside 7.4, is caught', () => {
    expect(faqPoolHits({ canProvianAccessFundsA: 'Money in a Commons escrow or pool sits there.', howMoveAssetsA: '' }, POOL_WORD.en)).toEqual(['canProvianAccessFundsA']);
    expect(faqPoolHits({ canProvianAccessFundsA: '', howMoveAssetsA: 'Provian管理员密钥只能将资金池款项发送到目标。' }, POOL_WORD.zh)).toEqual(['howMoveAssetsA']);
    const restated = TERMS.replace('- **Your keys live on your device.**', "- Provian's admin key can also execute a funded pool to its fixed target.\n- **Your keys live on your device.**");
    expect(restated).not.toBe(TERMS);
    expect(termsPoolPowerOutside74(restated)).toBe(1);
  });
});
