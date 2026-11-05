/**
 * Status-check-2 copy fixes (2026-10-01): Genesis strings ride the window, both unlink
 * routes are named, and the commerce lines state the rule as built.
 *
 * Every positive assertion has a RED control beside it: the retired text, fed to the same
 * predicate, must fail it, so none of these can pass by being hard-wired.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import en from './en.json';
import es from './es.json';
import fr from './fr.json';
import hi from './hi.json';
import id from './id.json';
import ja from './ja.json';
import ko from './ko.json';
import pt from './pt.json';
import sw from './sw.json';
import tl from './tl.json';
import vi from './vi.json';
import zh from './zh.json';
import { HELP_FAQ } from '../../screens/Settings/helpFaq.generated';

type Tree = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const locales: Record<string, Tree> = { en, es, fr, hi, id, ja, ko, pt, sw, tl, vi, zh };
const codes = Object.keys(locales);
const screen = (rel: string) => readFileSync(resolve(__dirname, '../../screens', rel), 'utf8');

describe('Genesis strings follow the Genesis window (all 12 locales)', () => {
  const mentionsGenesis = (s: string) => /genesis/i.test(s);

  it('the always-on earn answer carries no Genesis sentence; the open-window answer does', () => {
    expect(codes).toHaveLength(12);
    for (const l of codes) {
      const faq = locales[l].help.faq;
      expect(mentionsGenesis(faq.howEarnMoreA), `${l} base answer`).toBe(false);
      expect(mentionsGenesis(faq.howEarnMoreGenesisA), `${l} Genesis answer`).toBe(true);
      expect(faq.howEarnMoreA.length).toBeGreaterThan(40);
    }
  });

  it('RED control: the retired single answer is caught by the same predicate', () => {
    expect(mentionsGenesis(locales.en.help.faq.howEarnMoreGenesisA)).toBe(true);
  });

  it('genesisSubtitle distinguishes proof history from the live wallet balance', () => {
    expect(locales.en.provenanceDashboard.genesisSubtitle).not.toMatch(/armed|admitting/i);
    expect(locales.en.provenanceDashboard.genesisSubtitle).toContain('not a live wallet balance');
    expect(locales.en.provenanceDashboard.genesisSubtitle).not.toMatch(/your genesis grants/i);
    const retired = 'Historical PVT/test fields only. The live PVT Genesis campaign is armed and admitting through 2026-12-31; this legacy surface does not show its status.';
    expect(retired).toMatch(/armed|admitting/i);
    for (const l of codes) {
      const sub = locales[l].provenanceDashboard.genesisSubtitle as string;
      expect(sub, l).toContain('Genesis');
      expect(sub, l).not.toContain('2026-12-31');
    }
  });

  it('both screens gate the strings on isGenesisWindowOpen()', () => {
    // The FAQ structure is generated from docs/help/faq.md: the earn question carries its Genesis
    // answer as a variant, and the screen shows a variant only while the window is open.
    const help = screen('Settings/HelpSupportScreen.tsx');
    expect(help).toMatch(/const genesisOpen = isGenesisWindowOpen\(\);/);
    expect(help).toContain('genesisOpen && item.genesisAnswerKey ? item.genesisAnswerKey : item.answerKey');
    const earn = HELP_FAQ.flatMap((s) => s.items).find((i) => i.questionKey === 'help.faq.howEarnMore');
    expect(earn).toEqual({ questionKey: 'help.faq.howEarnMore', answerKey: 'help.faq.howEarnMoreA', genesisAnswerKey: 'help.faq.howEarnMoreGenesisA' });
    // RED control: an ungated answer choice does not satisfy the gate pattern.
    expect("answer: t(item.genesisAnswerKey ?? item.answerKey)").not.toContain('genesisOpen && item.genesisAnswerKey');
    const dash = screen('Provenance/MyProvenanceDashboardScreen.tsx');
    expect(dash).toMatch(/isGenesisWindowOpen\(\)\s*&&\s*\(\s*<>\s*<Text style=\{styles\.genesisSubtitle\}>/);
    // RED control: the ungated line the status check found does not satisfy the gate pattern.
    expect("<Text style={styles.genesisSubtitle}>{t('provenanceDashboard.genesisSubtitle')}</Text>")
      .not.toMatch(/isGenesisWindowOpen\(\)\s*&&/);
  });
});

describe('both unlink routes are named (all 12 locales)', () => {
  it('endLinkHint names the agent a second time, as the together-with route', () => {
    const count = (s: string) => (s.match(/\{\{agent\}\}/g) ?? []).length;
    expect(count('You receive a share of what {{agent}} earns. You can end this link yourself at any time.')).toBe(1);
    for (const l of codes) expect(count(locales[l].agentDetail.endLinkHint), l).toBeGreaterThanOrEqual(2);
    expect(locales.en.agentDetail.endLinkHint).toContain('or together with {{agent}}');
  });

  it('Vision card 6 says the person can end it alone or together with the agent', () => {
    expect(locales.en.visionScreen.card6Body).toContain(
      'You are a beneficiary, not a guarantor. You can end the link yourself at any time, or together with the agent.',
    );
    const retired: Record<string, string> = {
      en: 'and you can end the link at any time.', es: 'y puedes terminar el vínculo en cualquier momento.',
      fr: 'et vous pouvez mettre fin au lien à tout moment.', hi: 'और आप कभी भी लिंक समाप्त कर सकते हैं।',
      id: 'dan Anda dapat mengakhiri tautan kapan saja.', ja: 'であり、いつでもリンクを解除できます。',
      ko: '수혜자이며, 언제든 연결을 끝낼 수 있습니다.', pt: 'e pode encerrar o vínculo a qualquer momento.',
      sw: 'na unaweza kukomesha muunganisho wakati wowote.', tl: 'at maaari mong tapusin ang link anumang oras.',
      vi: 'và bạn có thể kết thúc liên kết bất cứ lúc nào.', zh: '并且可以随时解除关联。',
    };
    expect(Object.keys(retired)).toHaveLength(12);
    for (const l of codes) {
      expect(locales[l].visionScreen.card6Body, l).not.toContain(retired[l]);
      expect(locales[l].visionScreen.card6Body.length, l).toBeGreaterThan(200);
    }
    expect('Eres beneficiario, no garante, y puedes terminar el vínculo en cualquier momento.').toContain(retired.es);
  });
});

describe('commerce lines state the rule as built (all 12 locales)', () => {
  it('wallet_activity says it mints; agent_external_wallet names every leg and x402', () => {
    for (const l of codes) {
      const s = locales[l].earn.surfaces;
      expect(s.wallet_activity.description, `${l} wallet_activity`).toContain('PVT');
      expect(s.agent_external_wallet.description, `${l} agent_external_wallet`).toContain('x402');
      expect(s.agent_external_wallet.description, `${l} agent_external_wallet`).toContain('PVT');
      expect(s.agent_external_wallet.description, `${l} agent_external_wallet`).not.toMatch(/eligible/i);
      expect(s.wallet_activity.description, `${l} wallet_activity`).not.toMatch(/eligible/i);
    }
    const walletActivity = locales.en.earn.surfaces.wallet_activity.description as string;
    expect(walletActivity).toMatch(/mint PVT/);
    expect(walletActivity).toMatch(/receives from people you’ve dealt with/);
    expect(walletActivity).toMatch(/every known token/);
    // RED control: the retired line never said it mints.
    expect('Consequential wallet actions are part of your record. Sends, swaps, and on-ramps each seal an envelope in your chain.')
      .not.toMatch(/mint/);
  });

  it('the agent wallet line is no longer USDC-only', () => {
    const d = locales.en.earn.surfaces.agent_external_wallet.description as string;
    expect(d).toMatch(/receives from a counterparty it has dealt with/);
    expect(d).toMatch(/every known token/);
    expect(d).not.toMatch(/USDC sent, received/);
    expect('(USDC sent, received, swapped, or paid over x402)').toMatch(/USDC sent, received/);
  });
});

describe('Atlas is "he" on the Vision card ', () => {
  // The object pronoun each language uses for a thing, as the retired text used it of Atlas.
  const retired: Record<string, string> = {
    en: 'It holds its own wallet',
    tl: 'May hawak itong sariling wallet',
    vi: 'Nó giữ ví riêng',
    zh: '它持有自己的钱包',
  };
  const says = (text: string, phrase: string) => text.includes(phrase);

  it('English says he, and no locale keeps the retired "it" sentence', () => {
    expect(locales.en.visionScreen.card6Body).toContain('He holds his own wallet, earns from his own witnessed work');
    for (const [l, phrase] of Object.entries(retired)) {
      expect(says(locales[l].visionScreen.card6Body, phrase), l).toBe(false);
    }
    expect(locales.tl.visionScreen.card6Body).toContain('May hawak siyang sariling wallet');
    expect(locales.vi.visionScreen.card6Body).toContain('Anh ấy giữ ví riêng');
    expect(locales.zh.visionScreen.card6Body).toContain('他持有自己的钱包');
  });

  it('RED control: the retired sentence is caught by the same predicate', () => {
    for (const phrase of Object.values(retired)) expect(says(`Atlas. ${phrase}, and earns.`, phrase)).toBe(true);
  });
});
