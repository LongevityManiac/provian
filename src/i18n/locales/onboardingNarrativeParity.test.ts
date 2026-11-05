import { describe, expect, it } from 'vitest';

import en from './en.json';
import enOnboardingNarrative from './enOnboardingNarrative';
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

const locales = { en, es, fr, hi, id, ja, ko, pt, sw, tl, vi, zh } as const;

/**
 * The six-step onboarding reads exactly these keys. Binding
 * the list here — rather than re-deriving it from the screen — is deliberate:
 * a key the screen stops reading should be DELETED from every locale, and a key
 * it starts reading must be ADDED to every locale, and either change should
 * have to come through this list.
 */
const UNIFIED_KEYS = [
  'stepOf',
  'hookHeadline', 'hookSubtext', 'hookCta',
  'envelopeHeadline', 'envelopeSubtext',
  'envelopePill1', 'envelopePill2', 'envelopePill3', 'envelopePill4', 'envelopeCta',
  'pvtHeadline', 'pvtSubtext',
  'pvtPill1', 'pvtPill2', 'pvtPill3', 'pvtCta', 'pvtCtaAfterGenesis',
  'genesisHeadline', 'genesisSubtext',
  'genesisPill1', 'genesisPill2', 'genesisPill3',
  'genesisFinePrint', 'genesisFilmLink', 'genesisCta',
  'walletFeaturesHeadline', 'walletFeaturesSubtext',
  'walletFeaturesPill1', 'walletFeaturesPill2', 'walletFeaturesPill3', 'walletFeaturesPill4', 'walletFeaturesCta',
  'walletHeadline', 'walletSubtext', 'walletLegalNote', 'termsLink', 'walletCta',
] as const;

describe('English onboarding narrative parity', () => {
  it('keeps every overlay key identical in en.json (the overlay wins at runtime, en.json is the fallback)', () => {
    const overlayKeys = Object.keys(enOnboardingNarrative);
    expect(overlayKeys.length).toBeGreaterThan(0);
    for (const key of overlayKeys) {
      expect(
        (en.onboarding.unified as Record<string, string>)[key],
        `en.json onboarding.unified.${key} must equal the overlay`,
      ).toBe(enOnboardingNarrative[key]);
    }
  });

  it('overlay + stepOf is exactly the key set the screen reads', () => {
    const expected = [...UNIFIED_KEYS].sort();
    expect([...Object.keys(enOnboardingNarrative), 'stepOf'].sort()).toEqual(expected);
  });

  // RED control for the two guards above: a deliberately drifted copy must be caught.
  it('RED - a drifted en.json value would fail the parity guard', () => {
    const drifted = { ...en.onboarding.unified, pvtHeadline: 'Every PE mints PVT.' };
    expect(drifted.pvtHeadline).not.toBe(enOnboardingNarrative.pvtHeadline);
  });
});

describe('Localized onboarding key parity', () => {
  it('every locale carries exactly the unified keys the screen reads - no missing, no dead', () => {
    const expected = [...UNIFIED_KEYS].sort();
    for (const [locale, copy] of Object.entries(locales)) {
      expect(Object.keys(copy.onboarding.unified).sort(), `${locale}: onboarding.unified key set`).toEqual(expected);
    }
  });

  it('every locale preserves the runtime placeholder and the paragraph breaks', () => {
    for (const [locale, copy] of Object.entries(locales)) {
      const u = copy.onboarding.unified as Record<string, string>;
      expect(u.walletSubtext, `${locale}: walletSubtext placeholder`).toContain('{{biometric}}');
      // The PVT card keeps two paragraphs; the envelope, Genesis and wallet cards are one each.
      expect(u.pvtSubtext.split('\n\n'), `${locale}: pvtSubtext paragraphs`).toHaveLength(2);
      for (const key of ['envelopeSubtext', 'genesisSubtext', 'walletFeaturesSubtext']) {
        expect(u[key], `${locale}: ${key} is one paragraph`).not.toContain('\n\n');
      }
      for (const [key, value] of Object.entries(u)) {
        // A PVT kernel version token is internal lineage, never user copy (/ check:wp2).
        expect(value, `${locale}: ${key} leaks a PVT version token`).not.toMatch(/PVT\d|PVT\s*v\d/i);
      }
    }
  });
});

/**
 * Full-file key-set parity (2026-08-25). The scoped guards above only watch
 * onboarding.unified plus a handful of pinned keys, which is how an en.json
 * batch of 113 new keys shipped with zero translations and stayed invisible:
 * i18next's fallbackLng silently serves English for a missing key, so nothing
 * breaks at runtime and nothing failed in CI. This block closes that hole —
 * every locale must carry exactly en.json's deep key set.
 */
type Tree = Record<string, unknown>;
const flattenKeys = (node: Tree, prefix = ''): string[] =>
  Object.entries(node).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? flattenKeys(value as Tree, path)
      : [path];
  });

/** Top-level keys a locale may carry beyond en.json's set. */
const LOCALE_ONLY_KEYS = new Set(['_translator_note']);

const keySetDiff = (locale: Tree, english: Tree) => {
  const enKeys = new Set(flattenKeys(english));
  const locKeys = flattenKeys(locale);
  return {
    missing: [...enKeys].filter((k) => !locKeys.includes(k)),
    extra: locKeys.filter((k) => !enKeys.has(k) && !LOCALE_ONLY_KEYS.has(k.split('.')[0])),
  };
};

describe('Full locale key-set parity with en.json', () => {
  const enKeyCount = flattenKeys(en as Tree).length;

  it('evaluates a non-trivial population (empty-population control)', () => {
    expect(enKeyCount).toBeGreaterThan(2000);
  });

  it('every locale carries exactly the en.json key set - no missing, no stale extras', () => {
    for (const [locale, copy] of Object.entries(locales)) {
      const { missing, extra } = keySetDiff(copy as Tree, en as Tree);
      expect(missing, `${locale}: keys missing vs en.json (fallbackLng would silently serve English)`).toEqual([]);
      expect(extra, `${locale}: stale keys en.json no longer has`).toEqual([]);
    }
  });

  // RED control: the comparator must actually catch both failure directions.
  it('RED - a locale missing a key and carrying a stale extra is caught', () => {
    const broken = JSON.parse(JSON.stringify(es)) as Tree;
    delete (broken.send as Tree).fullAddress;
    (broken as Tree).zombieKey = 'stale';
    const { missing, extra } = keySetDiff(broken, en as Tree);
    expect(missing).toContain('send.fullAddress');
    expect(extra).toContain('zombieKey');
  });
});

describe('Localized economic copy parity', () => {
  it('attributes the 4.0x evidence class to App Attest in every locale', () => {
    for(const [locale,copy] of Object.entries(locales))expect(copy.provenanceDashboard.hardwareMintRate,locale).toBe('App Attest · 4.0×');
  });

  it('keeps every corrected security and economic key on the evidence-derived model', () => {
    for (const [locale, copy] of Object.entries(locales)) {
      // The key-backup copy lives on the Secure Your Wallet step (walletSubtext) and the
      // graded-evidence pill on the PE step (envelopePill3).
      const security = copy.onboarding.unified.walletSubtext;
      const pill = copy.onboarding.unified.envelopePill3;
      const walletFaq = copy.help.faq.howWalletSecuredA;
      // walletCheck1 was removed with the dead former-steps keys (A10,);
      // its two-keys guard is preserved on the live secureEnclave key below.
      const secureStorage = copy.onboarding.secureEnclave;
      const sovereignty = copy.abundanceDashboard.sovereigntyNote;

      // The 2026-08 copy pass removed tier mechanics (App Attest / StrongBox) and the
      // numeric multiplier range from onboarding. A locale still carrying either one
      // missed re-translation — that stale text is exactly what these two catch.
      expect(security, `${locale}: walletSubtext`).not.toMatch(/App Attest|StrongBox/);
      expect(pill, `${locale}: envelopePill3`).not.toMatch(/0[,.]5[×x]|2[,.]5[×x]/);
      expect(copy.help.faq.whatIsAttestationTierA, `${locale}: hardware pricing witness`).toMatch(/App Attest/);
      expect(copy.help.faq.whatIsAttestationTierA, `${locale}: attestation range`).toMatch(/4[,.]0×/);
      expect(walletFaq, `${locale}: howWalletSecuredA`).toMatch(/BIP-39/);
      // French and Portuguese use their own rendering of the term; every other locale keeps the English name.
      expect(walletFaq, `${locale}: howWalletSecuredA`).toMatch(/Provenance Envelope|Enveloppes? de provenance|Envelopes? de Proveniência/);
      expect(secureStorage, `${locale}: secureEnclave`).not.toMatch(/Secure Enclave|StrongBox|P-256/i);
      expect(sovereignty, `${locale}: sovereigntyNote`).not.toMatch(
        /signed by your hardware|firmados por su hardware|signées par votre matériel|हार्डवेयर द्वारा हस्ताक्षरित|ditandatangani oleh perangkat keras|ハードウェアによって署名|하드웨어로 서명|assinados pelo seu hardware|zimesainiwa na maunzi|pinirmahan ng iyong hardware|ký bởi phần cứng|由你的硬件签名/i,
      );
    }
  });

  it('keeps the corrected PVT-capability and Human Jobs FAQ aligned with the live runtime', () => {
    // Pre-D332-tail, whatCanDoWithPVTA denied PVT transfer and whatIsHumanJobsA said Human Jobs
    // was "unavailable because ... dependencies are not configured". PVT is now a sendable ERC-20
    // (SendScreen) and the Human Jobs board shipped with on-chain escrow funded in PVT —
    // `human-jobs.ts` REJECTS USDC compensation and requires `budget_pvt`, and the app's
    // `HumanJobEscrowFunder` runs createEscrow(..., Currency.PVT) → PVT.approve → fundEscrow.
    // (An earlier version of this pin demanded the word "USDC"; that was the wrong currency.)
    // The English source must not regress, and every locale must name PVT as the escrow currency,
    // so a missed re-translation that reverts to the stale copy fails here.
    expect(en.help.faq.whatCanDoWithPVTA, 'en: whatCanDoWithPVTA').not.toMatch(/No PVT transfer/i);
    expect(en.help.faq.whatIsHumanJobsA, 'en: whatIsHumanJobsA').not.toMatch(/not configured/i);
    expect(en.help.faq.whatIsHumanJobsA, 'en: whatIsHumanJobsA').toMatch(/PVT/);
    expect(en.help.faq.whatIsHumanJobsA, 'en: whatIsHumanJobsA').not.toMatch(/USDC escrow|escrow[^.]{0,40}USDC/i);
    for (const [locale, copy] of Object.entries(locales)) {
      expect(copy.help.faq.whatIsHumanJobsA, `${locale}: whatIsHumanJobsA`).toMatch(/PVT/);
    }
  });

  it('keeps the runtime English overlay on the graded-evidence, two-keys model without tier mechanics', () => {
    // Two keys, never conflated: the wallet key is "encrypted on device, backed up only as
    // ciphertext"; only the device/PE key may be described as hardware-held.
    // The key-backup facts are stated once, on the Secure Your Wallet step.
    expect(enOnboardingNarrative.walletSubtext).toMatch(/keys are encrypted here/);
    expect(enOnboardingNarrative.walletSubtext).toMatch(/only as ciphertext/);
    expect(enOnboardingNarrative.walletSubtext).toMatch(/backup password/);
    expect(enOnboardingNarrative.walletSubtext).not.toMatch(/hardware[- ]protected|secure hardware protects/i);
    expect(enOnboardingNarrative.envelopePill3).toMatch(/Graded by its witness|Stronger witness, higher value/);
    for (const [key, value] of Object.entries(enOnboardingNarrative)) {
      expect(value, `overlay ${key}`).not.toMatch(/App Attest|StrongBox|0\.5x|2\.5x/);
    }
  });

  it('keeps the overlay on the every-act-mints rule and rejects superseded eligibility framing', () => {
    // the headline leads with the mint and names what PVT is to a stranger.
    expect(enOnboardingNarrative.pvtHeadline).toMatch(/^(?:Your work|Every proof) mints PVT/);
    // An actor's own claim never mints: minting comes only from settled, proven work.
    expect(enOnboardingNarrative.pvtSubtext).toMatch(/created only when proven work settles/);
    const stalePhrases = new RegExp([
      ['when', 'eligible'].join('\\s+'),
      ['eligible', 'verified'].join('\\s+'),
      'only (?:an? )?eligible',
      ['policy', 'gated'].join('[ -]'),
      'most (?:PEs|records).*mint',
    ].join('|'), 'i');
    for (const [key, value] of Object.entries(enOnboardingNarrative)) {
      expect(value, `overlay ${key}`).not.toMatch(stalePhrases);
    }
  });

  it('RED - superseded eligibility framing is detectable', () => {
    const stale = ['Eligible', 'verified', 'work', 'can', 'mint PVT under limited, policy-gated settlement.'].join(' ');
    expect(stale).toMatch(new RegExp([['eligible', 'verified'].join('\\s+'), ['policy', 'gated'].join('[ -]')].join('|'), 'i'));
  });
});

describe('Onboarding states Genesis grants gross, leaves settlement terms out, and keeps the Court out', () => {
  const GENESIS_KEYS = ['genesisSubtext', 'genesisPill1', 'genesisPill2', 'genesisPill3'] as const;
  const NET_AMOUNT = /\d[.,]\d/;
  const COURT_TERMS = /court|escrow|pool|admin key/i;

  it('English states the gross grants and the three acknowledgements exactly', () => {
    const u = en.onboarding.unified as Record<string, string>;
    expect(u.genesisPill1).toBe('Create your wallet - 75 PVT');
    expect(u.genesisPill2).toBe('Connect a computer or device - 25 PVT each');
    expect(u.genesisPill3).toBe('Every AI agent with its own wallet and key - its own 75 PVT, however it joined');
    expect(u.genesisFinePrint).toBe('Amounts are before the 1% that goes to Provian and the Foundation.');
    expect(u.walletFeaturesHeadline).toBe('A real wallet, with your proofs and PVT in it.');
    const c = en.consentScreen as Record<string, string>;
    expect([c.itemNonCustodial, c.itemAsIs, c.itemAgreeTerms]).toEqual([
      'I understand Provian is non-custodial. Only I control my wallet and its keys, and Provian cannot recover them.',
      'I understand this software is provided as-is, transactions are irreversible, and Provian Technologies is not liable for any loss of funds.',
      'I have read and agree to the Terms of Service and Privacy Policy.',
    ]);
  });

  it('no locale states a net grant on the Genesis step or a settlement fee on the PVT step', () => {
    let checked = 0;
    for (const [locale, copy] of Object.entries(locales)) {
      const u = copy.onboarding.unified as Record<string, string>;
      for (const key of GENESIS_KEYS) {
        expect(u[key], `${locale}: ${key} carries a net amount`).not.toMatch(NET_AMOUNT);
        checked++;
      }
      expect(u.pvtSubtext, `${locale}: pvtSubtext still describes the settlement fee`).not.toMatch(/USDC/);
    }
    expect(checked).toBe(12 * GENESIS_KEYS.length);
  });

  it('English onboarding and acknowledgements never mention the Court, escrows, pools, or the admin key', () => {
    const strings = [
      ...Object.values(en.onboarding.unified as Record<string, string>),
      ...Object.values(en.consentScreen as Record<string, string>),
    ];
    expect(strings.length).toBeGreaterThan(40);
    for (const value of strings) expect(value).not.toMatch(COURT_TERMS);
  });

  it('RED - a net-plus-gross amount and a Court mention are both caught', () => {
    expect('Create your wallet - 74.25 PVT net (75 PVT gross grant)').toMatch(NET_AMOUNT);
    expect('Until the Commons Court opens, the admin key resolves disputed escrows.').toMatch(COURT_TERMS);
  });
});
