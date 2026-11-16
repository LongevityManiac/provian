/**
 * linking a third-party wallet to a linked agent: the error mapping,
 * input normalization, and the Stripe Link setup message the Agent Hub hands the agent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    externalLinkErrorKey,
    isWalletRejection,
    normalizeExternalAddress,
    normalizePastedSignature,
    shortAddress,
} from './externalWalletLink';
import { LINK_CARD_SETUP_MESSAGE } from './linkCardSetup';

const LOCALES = ['en', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt', 'sw', 'tl', 'vi', 'zh'] as const;
const locale = (l: string): Record<string, Record<string, string>> =>
    JSON.parse(readFileSync(resolve(__dirname, `../../i18n/locales/${l}.json`), 'utf8'));

describe('externalLinkErrorKey', () => {
    it('maps every relay refusal the routes return to its own sentence', () => {
        expect(externalLinkErrorKey('not_your_linked_agent')).toBe('errorNotYourAgent');
        expect(externalLinkErrorKey('agent_not_active')).toBe('errorAgentInactive');
        expect(externalLinkErrorKey('address_is_your_provian_wallet')).toBe('errorOwnProvian');
        expect(externalLinkErrorKey('address_is_agent_native_wallet')).toBe('errorAgentNative');
        expect(externalLinkErrorKey('address_bound_to_other_agent')).toBe('errorBoundOther');
        expect(externalLinkErrorKey('signature_invalid')).toBe('errorSignature');
        expect(externalLinkErrorKey('challenge_expired')).toBe('errorExpired');
        expect(externalLinkErrorKey('Rate limit exceeded.')).toBe('errorRateLimited');
        expect(externalLinkErrorKey('head_block_unavailable')).toBe('errorUnavailable');
    });

    it('RED: an unknown code falls to the generic sentence, never a raw code', () => {
        expect(externalLinkErrorKey('something_new')).toBe('errorGeneric');
        expect(externalLinkErrorKey(undefined)).toBe('errorGeneric');
    });

    it('every key the mapper can return exists in all 12 locales', () => {
        const keys = new Set([
            'not_your_linked_agent', 'agent_not_active', 'address_is_your_provian_wallet',
            'address_is_agent_native_wallet', 'address_bound_to_other_agent', 'signature_invalid',
            'challenge_expired', 'http_429', 'invalid_address', 'wallet_rejected', 'wallet_no_account',
            'http_503', 'unknown', 'address_is_provian_wallet', 'address_bound_to_other_owner',
        ].map(externalLinkErrorKey));
        expect(keys.size).toBeGreaterThan(10);
        for (const l of LOCALES) {
            const ns = locale(l).linkExternalWallet;
            for (const k of keys) expect(typeof ns[k], `${l}.linkExternalWallet.${k}`).toBe('string');
        }
    });
});

describe('externalLinkErrorKey: person mode (POST /v1/wallet/external-address/*)', () => {
    it('maps the person-route refusals to their own sentences', () => {
        expect(externalLinkErrorKey('address_is_provian_wallet')).toBe('errorProvianWallet');
        expect(externalLinkErrorKey('address_bound_to_other_owner')).toBe('errorBoundOtherOwner');
        expect(externalLinkErrorKey('address must be a valid EVM address')).toBe('errorInvalidAddress');
        for (const code of ['no_human_wallet', 'human_wallet_not_active', 'human_wallet_ambiguous']) {
            expect(externalLinkErrorKey(code), code).toBe('errorGeneric');
        }
        for (const code of ['signature_invalid', 'address_mismatch']) expect(externalLinkErrorKey(code)).toBe('errorSignature');
        for (const code of ['challenge_expired', 'challenge_not_found', 'challenge_consume_failed']) {
            expect(externalLinkErrorKey(code)).toBe('errorExpired');
        }
        for (const code of ['head_block_unavailable', 'baseline_nonce_unavailable', 'proof_evidence_changed',
            'cache_unavailable', 'pe_emission_failed', 'temporarily_unavailable']) {
            expect(externalLinkErrorKey(code)).toBe('errorUnavailable');
        }
    });

    it('the agent-mode keys are unchanged (RED: person codes do not borrow them)', () => {
        expect(externalLinkErrorKey('address_is_your_provian_wallet')).toBe('errorOwnProvian');
        expect(externalLinkErrorKey('address_bound_to_other_agent')).toBe('errorBoundOther');
        expect(externalLinkErrorKey('address_is_provian_wallet')).not.toBe('errorOwnProvian');
        expect(externalLinkErrorKey('address_bound_to_other_owner')).not.toBe('errorBoundOther');
    });
});

describe('input normalization', () => {
    it('addresses: valid → lowercased; RED: invalid or a mistyped checksum → null', () => {
        const checksummed = '0xAbC0000000000000000000000000000000000001'.toLowerCase();
        expect(normalizeExternalAddress(` ${checksummed} `)).toBe(checksummed);
        // A mixed-case address must carry a valid EIP-55 checksum (catches a typo).
        expect(normalizeExternalAddress('0xAbC0000000000000000000000000000000000001')).toBeNull();
        expect(normalizeExternalAddress('0x123')).toBeNull();
        expect(normalizeExternalAddress('not an address')).toBeNull();
    });

    it('signatures: trims, joins wrapped lines, adds 0x; RED: short or non-hex → null', () => {
        const sig = 'ab'.repeat(65);
        expect(normalizePastedSignature(` ${sig.slice(0, 60)}\n${sig.slice(60)} `)).toBe(`0x${sig}`);
        expect(normalizePastedSignature(`0x${sig}`)).toBe(`0x${sig}`);
        expect(normalizePastedSignature('0xabcd')).toBeNull();
        expect(normalizePastedSignature(`0x${'zz'.repeat(65)}`)).toBeNull();
    });

    it('wallet rejections are recognized; RED: an ordinary error is not', () => {
        expect(isWalletRejection({ code: 5000, message: 'User rejected.' })).toBe(true);
        expect(isWalletRejection(new Error('User rejected the request'))).toBe(true);
        expect(isWalletRejection(new Error('network down'))).toBe(false);
    });

    it('shortAddress', () => {
        expect(shortAddress('0xabc0000000000000000000000000000000000001')).toBe('0xabc0…0001');
    });
});

// A card-number-shaped run of digits (13–19, optionally grouped).
const CARD_SHAPED = /\b(?:\d[ -]?){13,19}\b/;
const SELF_REPORT = /recordLinkSpend|record_link_spend|report[-_ ]?(?:pe|action|work)|submit_pe|\/v1\/pe\/submit|\/v1\/witness/i;

describe('LINK_CARD_SETUP_MESSAGE (the paste-ready Stripe Link setup for the agent)', () => {
    it('carries the documented Link CLI setup and the human-approval flag', () => {
        expect(LINK_CARD_SETUP_MESSAGE).toContain('npm i -g @stripe/link-cli');
        expect(LINK_CARD_SETUP_MESSAGE).toContain('link-cli auth login --interval 5');
        expect(LINK_CARD_SETUP_MESSAGE).toContain('link-cli auth status --format json');
        expect(LINK_CARD_SETUP_MESSAGE).toContain('--request-approval');
        expect(LINK_CARD_SETUP_MESSAGE).toContain('--format json');
        expect(LINK_CARD_SETUP_MESSAGE).toContain('--output-file');
    });

    it('never tells the agent to report its own spend and never carries card data', () => {
        expect(SELF_REPORT.test(LINK_CARD_SETUP_MESSAGE)).toBe(false);
        expect(CARD_SHAPED.test(LINK_CARD_SETUP_MESSAGE)).toBe(false);
        expect(LINK_CARD_SETUP_MESSAGE).not.toMatch(/LINK_ACCESS_TOKEN/);
    });

    it('RED: the guards catch a self-report instruction and a card number', () => {
        expect(SELF_REPORT.test(`${LINK_CARD_SETUP_MESSAGE}\nThen call recordLinkSpend.`)).toBe(true);
        expect(CARD_SHAPED.test('card 4000 0099 9000 1984')).toBe(true);
    });
});

describe(' copy in all 12 locales', () => {
    it('the self-reporting keys are gone and the hosted-bot / link-wallet / card keys exist', () => {
        const en = locale('en');
        for (const l of LOCALES) {
            const d = locale(l);
            for (const k of ['selfReportLabel', 'selfReportLead', 'selfReportCopy', 'selfReportCaptured']) {
                expect(d.connectAgent[k], `${l}.connectAgent.${k}`).toBeUndefined();
            }
            // Fleet shelved on the Connect screen : no promise without a door.
            expect(d.connectAgent.agentFleetLine, `${l}.connectAgent.agentFleetLine`).toBeUndefined();
            for (const ns of ['linkExternalWallet', 'agentCardSpending'] as const) {
                expect(Object.keys(d[ns]).sort(), `${l}.${ns}`).toEqual(Object.keys(en[ns]).sort());
            }
            for (const k of Object.keys(en.connectAgent).filter((x) => x.startsWith('whatEarns') || x.startsWith('codeHost'))) {
                expect(typeof d.connectAgent[k], `${l}.connectAgent.${k}`).toBe('string');
            }
        }
    });

    it('interpolation placeholders survive translation', () => {
        const en = locale('en');
        for (const l of LOCALES) {
            const d = locale(l);
            for (const ns of ['linkExternalWallet', 'agentCardSpending'] as const) {
                for (const [k, v] of Object.entries(en[ns])) {
                    const vars = (v.match(/\{\{\w+\}\}/g) ?? []).sort();
                    expect((d[ns][k].match(/\{\{\w+\}\}/g) ?? []).sort(), `${l}.${ns}.${k}`).toEqual(vars);
                }
            }
        }
    });

    it('2026-10-20: "What earns" names every witness, including the process lane, and points at capture health', () => {
        const ca = locale('en').connectAgent;
        expect(ca.whatEarns1).toMatch(/^Tool-calling model responses\b.*one record per response.*errored calls.*session files.*model proxy.*OpenTelemetry/);
        expect(ca.whatEarns2).toMatch(/^Commands it runs\b.*own cloud computer.*machine itself witnesses each command.*one record per command/);
        expect(ca.whatEarns3).toMatch(/^Commits\b.*code host.*GitHub, GitLab or Bitbucket/);
        expect(ca.whatEarns4).toMatch(/^Commons acts\b.*own key/);
        expect(ca.whatEarns5).toMatch(/^On-chain acts\b.*same key/);
        expect(ca.whatEarnsHealth).toMatch(/capture health/);
        expect(ca.whatEarnsGas).toMatch(/ETH on Base/);
        // 2026-10-22: the proof line is ONE plain sentence that still says the work is witnessed by
        // something other than the agent (the lane-by-lane walkthrough lives in whatEarns1/2 above).
        expect(ca.agentSetupProofBody).toMatch(/something other than the agent witnesses/);
        expect(ca.agentSetupProofBody.trim().split(/(?<=[.!?])\s+/)).toHaveLength(1);
    });

    it('2026-10-20: the stale "a Grok Bot\'s tool calls are not witnessed" line is gone in every locale', () => {
        // 's process lane witnesses a hosted bot's commands on its own box, so the line
        // telling people its work there is unwitnessed is retired with the hosted-bot card.
        for (const l of LOCALES) {
            const ca = locale(l).connectAgent;
            expect(ca.hostedBotGrokToday, `${l}.connectAgent.hostedBotGrokToday`).toBeUndefined();
            expect(Object.keys(ca).filter((k) => k.startsWith('hostedBot') || k.startsWith('cloudAgent')), l).toEqual([]);
        }
    });

    it('2026-on the person path: commits and chat sessions count, coding-tool calls do not', () => {
        // 2026-10-22: the chooser card is one line; the coding-tool exception sits under the device
        // path's Details (deviceToolCallsBody), never in the card body.
        const ca = locale('en').connectAgent;
        expect(ca.devicePathBody).toMatch(/commits and AI chat sessions/);
        expect(ca.devicePathBody).not.toMatch(/Claude Code|aren't counted|choose An AI agent/i);
        expect(ca.deviceToolCallsBody).toMatch(/Claude Code, Codex or Cursor, aren't counted/);
        expect(ca.deviceToolCallsBody).toMatch(/The commits they help you make are\./);
    });

    it(' §5: the superseded 09-28 "hosted bots earn from Commons/on-chain only" copy is gone in every locale', () => {
        // The retired keys told users a hosted bot's work was invisible to the daemon and that
        // watching its chats earns nothing; §2's transcript descriptor supersedes that.
        const superseded = /can't watch its work|can't see those results|Watching its chats/i;
        for (const l of LOCALES) {
            const d = locale(l);
            for (const k of ['hostedBotNotLabel', 'hostedBotNot1']) {
                expect(d.connectAgent[k], `${l}.connectAgent.${k}`).toBeUndefined();
            }
            for (const k of ['whatEarns4', 'whatEarns5', 'whatEarnsHealth']) {
                expect(typeof d.connectAgent[k], `${l}.connectAgent.${k}`).toBe('string');
            }
        }
        const en = locale('en');
        const hostedCopy = [
            ...Object.entries(en.connectAgent).filter(([k]) => k.startsWith('whatEarns')).map(([, v]) => v),
            en.agentCardSpending.witnessHosted,
        ];
        expect(hostedCopy.length).toBeGreaterThanOrEqual(10);
        expect(hostedCopy.filter((v) => superseded.test(v))).toEqual([]);
    });

    it('RED control: the superseded-copy detector catches the 09-28 strings', () => {
        const superseded = /can't watch its work|can't see those results|Watching its chats/i;
        expect(superseded.test("Watching its chats — Provian doesn't see a hosted bot's conversations, and they don't earn")).toBe(true);
        expect(superseded.test("A hosted bot whose tools run on the provider's side isn't witnessed this way — Provian can't see those results.")).toBe(true);
    });
});

describe('Connect-an-agent screen source', () => {
    const src = readFileSync(resolve(__dirname, '../../screens/Agent/ConnectAgentScreen.tsx'), 'utf8');
    it('renders the What earns row (under Details since 2026-10-22) with the help command, and no self-reporting block', () => {
        expect(src).toMatch(/<WhatEarnsBody /);
        expect(src).toContain('const HOSTED_BOT_HELP_CMD = AGENT_HELP_CMD;');
        expect(src).not.toMatch(/SelfReport|SELF_REPORT|selfReport/);
    });

    it('the card renders every witness and the capture-health line; no hosted-bot or cloud block remains', () => {
        for (const k of ['whatEarns1', 'whatEarns2', 'whatEarns3', 'whatEarns4', 'whatEarns5', 'whatEarnsHealth']) {
            expect(src).toContain(`t('connectAgent.${k}')`);
        }
        expect(src).not.toMatch(/HostedBotCard|connectAgent\.hostedBot|connectAgent\.cloudAgent/);
    });

    it('the chooser has three options (agent, you, code host); a second computer is not one of them', () => {
        const chooser = src.slice(src.indexOf("{mode === 'choose' && ("), src.indexOf("{mode === 'codeHost' && ("));
        expect(chooser).toContain("openMode('agent')");
        expect(chooser).toContain("openMode('device')");
        expect(chooser).toContain("openMode('codeHost')");
        expect(chooser).not.toContain("openMode('agentDevice')");
        expect(chooser.match(/<PathCard/g)?.length).toBe(3);
        const picker = src.slice(src.indexOf("{mode === 'codeHost' && ("), src.indexOf("{mode === 'device' && ("));
        for (const provider of ['github', 'gitlab', 'bitbucket']) expect(picker).toContain(`provider: '${provider}'`);
    });
});

type Json = Record<string, Record<string, unknown>>;
const j = (l: string): Json => locale(l) as unknown as Json;

describe('person mode: prove a wallet you already hold (Earn)', () => {
    const flowSrc = readFileSync(resolve(__dirname, '../../screens/Agent/LinkExternalWalletScreen.tsx'), 'utf8');
    const proveSrc = readFileSync(resolve(__dirname, '../../screens/Earn/ProveOwnWalletScreen.tsx'), 'utf8');
    const navSrc = readFileSync(resolve(__dirname, '../../navigation/AppNavigator.tsx'), 'utf8');

    it('the person screen renders the shared flow in person mode, registered as ProveOwnWallet', () => {
        expect(proveSrc).toContain('<ExternalWalletProofFlow mode={PERSON_MODE} />');
        expect(proveSrc).toContain("{ kind: 'person' }");
        expect(navSrc).toContain('<Stack.Screen name="ProveOwnWallet" component={ProveOwnWalletScreen} />');
    });

    it('person mode calls only the person routes; agent mode keeps the agent routes', () => {
        const start = flowSrc.indexOf("if (mode.kind === 'person')");
        const split = flowSrc.indexOf('const { walletId } = mode;');
        expect(start).toBeGreaterThan(0);
        expect(split).toBeGreaterThan(start);
        const person = flowSrc.slice(start, split);
        expect(person).toContain('listOwnExternalAddresses()');
        expect(person).toContain('requestOwnExternalAddressChallenge(address)');
        expect(person).toContain('verifyOwnExternalAddress(input)');
        expect(person).not.toMatch(/Agent/);
        expect(flowSrc.slice(split)).toContain('listAgentExternalAddresses(walletId)');
    });

    it('person mode shows the earning and own-money notes', () => {
        expect(flowSrc).toContain("t('proveOwnWallet.earns')");
        expect(flowSrc).toContain("t('proveOwnWallet.ownMoney')");
    });

    it('the person namespace and the Earn surface exist in all 12 locales, translated, placeholders intact', () => {
        const en = j('en');
        const enProve = en.proveOwnWallet as Record<string, string>;
        const enSurface = (en.earn.surfaces as Record<string, Record<string, string>>).own_external_wallet;
        expect(Object.keys(enProve).length).toBe(11);
        expect(Object.keys(enSurface).length).toBe(14);
        const vars = (v: string): string[] => (v.match(/\{\{\w+\}\}/g) ?? []).sort();
        let checked = 0;
        for (const l of LOCALES) {
            const d = j(l);
            const pairs: Array<[string, Record<string, string>, Record<string, string>]> = [
                ['proveOwnWallet', enProve, d.proveOwnWallet as Record<string, string>],
                ['own_external_wallet', enSurface, (d.earn.surfaces as Record<string, Record<string, string>>).own_external_wallet],
            ];
            for (const [ns, enNs, got] of pairs) {
                expect(Object.keys(got).sort(), `${l}.${ns}`).toEqual(Object.keys(enNs).sort());
                for (const [k, v] of Object.entries(enNs)) {
                    expect(typeof got[k], `${l}.${ns}.${k}`).toBe('string');
                    expect(vars(got[k]), `${l}.${ns}.${k}`).toEqual(vars(v));
                    if (l !== 'en') expect(got[k], `${l}.${ns}.${k} untranslated`).not.toBe(v);
                    checked++;
                }
            }
            expect(typeof (d.earn.groups as Record<string, string>).services).toBe('string');
            expect(typeof (d.earn.groupHints as Record<string, string>).services).toBe('string');
        }
        expect(checked).toBe(12 * 25);
    });

    it('the new copy keeps protected names and carries no em/en dash (RED: the detector catches one)', () => {
        const DASH = /[–—]/;
        expect(DASH.test('a — b')).toBe(true);
        for (const l of LOCALES) {
            const d = j(l);
            const lew = d.linkExternalWallet as Record<string, string>;
            const strings = [
                ...Object.values(d.proveOwnWallet as Record<string, string>),
                ...Object.values((d.earn.surfaces as Record<string, Record<string, string>>).own_external_wallet),
                lew.errorProvianWallet,
                lew.errorBoundOtherOwner,
                (d.earn.groups as Record<string, string>).services,
                (d.earn.groupHints as Record<string, string>).services,
            ];
            expect(strings.length).toBe(29);
            for (const v of strings) expect(DASH.test(v), `${l}: ${v}`).toBe(false);
            const prove = d.proveOwnWallet as Record<string, string>;
            expect(prove.intro, l).toMatch(/MetaMask/);
            expect(prove.intro, l).toMatch(/Coinbase Wallet/);
            expect(prove.earns, l).toMatch(/Base/);
            expect(prove.ownMoney, l).toMatch(/Provian/);
        }
    });
});

describe('Genesis for agents: every agent with its own wallet and key (all 12 locales)', () => {
    it('English says it the run-contract way', () => {
        const en = j('en');
        const unified = (en.onboarding as Record<string, Record<string, string>>).unified;
        expect(unified.genesisPill3).toBe('Every AI agent with its own wallet and key - its own 75 PVT, however it joined');
        const vision = en.visionScreen as Record<string, string>;
        expect(vision.genesisBody).toContain(
            "Every agent with its own wallet and its own key gets its own 75 PVT, however it was onboarded, including through another agent's fleet code.",
        );
        expect(vision.card11Body).toContain("Provian's reference implementations: source-visible, and not the only possible ones.");
        const faq = (en.help as Record<string, Record<string, string>>).faq.howEarnMoreGenesisA;
        expect(faq).toContain('fifty fleet agents means fifty grants');
        expect(faq).toContain('with no wallet of its own, gets none');
    });

    it('RED: no locale still says "every agent you create" or that spawned children get no grant', () => {
        const retired = /agent you create|parent-spawned|spawned children/i;
        expect(retired.test('Every agent you create gets its own wallet')).toBe(true);
        expect(retired.test(readFileSync(resolve(__dirname, '../../i18n/locales/en.json'), 'utf8'))).toBe(false);
        const retiredByLocale: Record<string, string> = {
            es: 'Cada agente que crees', fr: 'Chaque agent que vous créez', pt: 'Cada agente que você criar',
            id: 'Setiap agen yang Anda buat', ja: 'あなたが作成するエージェント', ko: '당신이 만드는 모든 에이전트',
            zh: '你创建的每个智能体', vi: 'Mỗi tác nhân bạn tạo', hi: 'आपके बनाए हर एजेंट',
            sw: 'Kila wakala unayemuunda', tl: 'Bawat agent na gagawin mo',
        };
        expect(Object.keys(retiredByLocale)).toHaveLength(11);
        for (const [l, phrase] of Object.entries(retiredByLocale)) {
            const text = readFileSync(resolve(__dirname, `../../i18n/locales/${l}.json`), 'utf8');
            expect(text.includes(phrase), `${l} still carries "${phrase}"`).toBe(false);
        }
    });

    it('the Connect screen carries no fleet Genesis line while fleet is shelved ', () => {
        const src = readFileSync(resolve(__dirname, '../../screens/Agent/ConnectAgentScreen.tsx'), 'utf8');
        expect(src).not.toContain('agentFleetGenesisLine');
        for (const l of LOCALES) {
            expect((j(l).connectAgent as Record<string, string>).agentFleetGenesisLine, l).toBeUndefined();
        }
    });
});
