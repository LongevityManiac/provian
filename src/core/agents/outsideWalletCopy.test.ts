/**
 * The flow that links a wallet an agent already runs elsewhere is labelled as an OUTSIDE wallet
 * everywhere the app names it : the Earn card "Agent's outside wallet" /
 * "Link a non-Provian wallet your agent already runs", and Agent Hub's "Link an outside wallet".
 * It must never read as the wallet Provian creates for the agent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOCALES = ['en', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt', 'sw', 'tl', 'vi', 'zh'] as const;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const locale = (l: string): Json =>
    JSON.parse(readFileSync(resolve(__dirname, `../../i18n/locales/${l}.json`), 'utf8')) as Json;

// The labels that read as the agent's own (Provian) wallet, which this ruling retired.
const RETIRED_TITLES: Record<string, string> = {
    en: "Agent's own wallet", es: 'La billetera del agente', fr: "Le portefeuille de l'agent",
    hi: 'एजेंट का अपना वॉलेट', id: 'Dompet milik agen', ja: 'エージェント自身のウォレット',
    ko: '에이전트 자체 지갑', pt: 'A carteira do agente', sw: 'Pochi ya wakala mwenyewe',
    tl: 'Sariling wallet ng ahente', vi: 'Ví của chính tác nhân', zh: '智能体自己的钱包',
};
const RETIRED_CTAS: Record<string, string> = {
    en: 'Link a wallet', es: 'Vincular billetera', fr: 'Relier un portefeuille', hi: 'वॉलेट लिंक करें',
    id: 'Tautkan dompet', ja: 'ウォレットをリンク', ko: '지갑 연결', pt: 'Vincular carteira',
    sw: 'Unganisha pochi', tl: 'Mag-link ng wallet', vi: 'Liên kết ví', zh: '关联钱包',
};

describe('outside-wallet labels', () => {
    it('English reads exactly as ruled', () => {
        const en = locale('en');
        expect(en.earn.surfaces.agent_external_wallet.title).toBe("Agent's outside wallet");
        expect(en.earn.surfaces.agent_external_wallet.tagline).toBe('Link a non-Provian wallet your agent already runs');
        expect(en.agentHub.linkWalletCta).toBe('Link an outside wallet');
        expect(en.linkExternalWallet.title).toBe('Link an outside wallet');
        expect(en.earn.surfaces.agent_external_wallet.description).toMatch(/not the wallet Provian creates for your agent/);
        expect(en.linkExternalWallet.intro).toMatch(/not the wallet Provian creates for \{\{name\}\}/);
    });

    for (const l of LOCALES) {
        it(`${l}: no retired label survives, and every reference names the same outside-wallet action`, () => {
            const j = locale(l);
            const card = j.earn.surfaces.agent_external_wallet;
            const cta: string = j.agentHub.linkWalletCta;
            expect(card.title).not.toBe(RETIRED_TITLES[l]);
            expect(cta).not.toBe(RETIRED_CTAS[l]);
            expect(card.tagline).toMatch(/Provian/);
            expect(j.linkExternalWallet.title).toBe(cta);
            // The card's directions point at the Agent Hub action by its new name.
            expect(card.description).toContain(`→ ${cta}`);
            expect(card.step2).toContain(`→ ${cta}`);
            for (const k of ['description', 'step2']) {
                expect(String(card[k]).split(`→ ${cta}`).join('')).not.toContain(`→ ${RETIRED_CTAS[l]}`);
            }
            // The card and the linking screen both say it is not the wallet Provian creates.
            expect(card.description.split('Provian').length).toBeGreaterThan(2);
            expect(j.linkExternalWallet.intro).toMatch(/Provian/);
            expect(j.linkExternalWallet.intro).toMatch(/\{\{name\}\}[^]*\{\{name\}\}[^]*\{\{name\}\}/u);
        });
    }
});
