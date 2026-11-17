/**
 * A counterparty is shown only under the consent the parties actually gave:
 * the published terms may not exceed the agreed redaction terms, an expired
 * consent authorizes nothing, and one approval authorizes one publication.
 * Runs the real publishPE / requestConsent / respondToConsent / unpublishPE.
 */
import { publicProjectionId } from './projection-privacy';
import { publishPE, requestConsent, respondToConsent, unpublishPE, consentRefusal } from './publication';
import { COMMONS_SAFETY_LIMITS } from './types';
import type { CommonsDeps, PublicationConsent, PublishPERequest } from './types';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { presentedPeFixture, type PresentedPeFixture } from '../meter/__test-helpers__/presented-pe';
import { meterRelayPeId } from '../meter/meter-store';

const mockGeneratePE = jest.fn().mockResolvedValue({ peId: 'pe_pub', peHash: 'h', prevHash: 'p' });
jest.mock('../agent-bank/pe-utils', () => ({
  generatePE: (...args: unknown[]) => mockGeneratePE(...args),
}));

const PUBLISHER = 'wallet_pub';
const AGENT = 'agent_pub';
const COUNTERPARTY = 'wallet_cp';
const DAY_MS = 24 * 60 * 60 * 1000;

function depsFor(fs: FakeFirestore): CommonsDeps {
  return { db: fs, cache: { checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }) } } as unknown as CommonsDeps;
}

type Redaction = PublishPERequest['redaction_config'];
/** The terms the parties agree to in these tests: counterparty shown, amount hidden. */
const AGREED: Redaction = {
  show_intent_text: false,
  show_counterparty: true,
  show_amount: false,
  show_currency: true,
  show_artifact_hash: false,
};

function setup(): { fs: FakeFirestore; fx: PresentedPeFixture; relayId: string } {
  const fs = createFakeFirestore();
  fs.store.set(`commons_profiles/${PUBLISHER}`, { wallet_id: PUBLISHER, published_pe_count: 0 });
  fs.store.set(`agent_wallets/${COUNTERPARTY}`, { address: '0xcounterparty' });
  const fx = presentedPeFixture({
    actorId: AGENT,
    fields: { metadata: { amount: '5', currency: 'usdc' }, counterparty_address: '0xCounterParty' },
  });
  return { fs, fx, relayId: meterRelayPeId(fx.peHash) };
}

async function approvedConsent(fs: FakeFirestore, fx: PresentedPeFixture, agreed: Redaction = AGREED): Promise<PublicationConsent> {
  const consent = await requestConsent(depsFor(fs), PUBLISHER, {
    pe_id: fx.pe.pe_id, institution: 'commons', redaction_config: agreed, pe: fx.pe, inclusion: fx.inclusion,
  }, { agentId: AGENT, anchorContract: fx.anchorContract });
  return respondToConsent(depsFor(fs), COUNTERPARTY, consent.consent_id, 'approved');
}

const publish = (fs: FakeFirestore, fx: PresentedPeFixture, redaction: Redaction = AGREED, institution = 'commons') =>
  publishPE(depsFor(fs), PUBLISHER, AGENT, '0xpub',
    { pe_id: fx.pe.pe_id, institution, redaction_config: redaction, pe: fx.pe, inclusion: fx.inclusion },
    { anchorContract: fx.anchorContract });

const consentDoc = (fs: FakeFirestore, id: string) => fs.store.get(`commons_publication_consents/${id}`) as Record<string, unknown>;

beforeEach(() => mockGeneratePE.mockClear());

describe('publishPE honours the consent the parties gave', () => {
  it('publishes on the agreed terms and spends the consent', async () => {
    const { fs, fx, relayId } = setup();
    const consent = await approvedConsent(fs, fx);
    const projection = await publish(fs, fx);
    expect(projection.amount).toBeNull();
    expect(fs.store.has(`commons_published_pes/${relayId}`)).toBe(true);
    expect(consentDoc(fs, consent.consent_id)).toMatchObject({ consumed_by_publication: relayId });
    expect(typeof consentDoc(fs, consent.consent_id).consumed_at).toBe('number');
  });

  it('may publish LESS than was agreed', async () => {
    const { fs, fx } = setup();
    await approvedConsent(fs, fx);
    const projection = await publish(fs, fx, { ...AGREED, show_currency: false });
    expect(projection.currency).toBeNull();
  });

  it('RED: showing a field the counterparty did not agree to show is refused, and nothing is published', async () => {
    const { fs, fx, relayId } = setup();
    const consent = await approvedConsent(fs, fx);
    await expect(publish(fs, fx, { ...AGREED, show_amount: true })).rejects.toThrow(/show_amount was not agreed/);
    expect(fs.store.has(`commons_published_pes/${relayId}`)).toBe(false);
    expect(consentDoc(fs, consent.consent_id).consumed_at).toBeUndefined();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('RED: an intent summary other than the agreed one is refused', async () => {
    const { fs, fx } = setup();
    await approvedConsent(fs, fx, { ...AGREED, show_intent_text: true, intent_text_summary: 'agreed words' });
    await expect(publish(fs, fx, { ...AGREED, show_intent_text: true, intent_text_summary: 'other words' }))
      .rejects.toThrow(/intent_text_summary differs/);
  });

  it('RED: a different institution than the one agreed is refused', async () => {
    const { fs, fx } = setup();
    await approvedConsent(fs, fx);
    await expect(publish(fs, fx, AGREED, 'market')).rejects.toThrow(/institution differs/);
  });

  it('RED: an approved consent past its expiry is refused', async () => {
    const { fs, fx, relayId } = setup();
    const consent = await approvedConsent(fs, fx);
    const key = `commons_publication_consents/${consent.consent_id}`;
    fs.store.set(key, { ...consentDoc(fs, consent.consent_id), expires_at: Date.now() - 1 });
    await expect(publish(fs, fx)).rejects.toThrow(/expired/);
    expect(fs.store.has(`commons_published_pes/${relayId}`)).toBe(false);
  });

  it('RED: one approval authorizes one publication — unpublish then republish needs a new consent', async () => {
    const { fs, fx, relayId } = setup();
    await approvedConsent(fs, fx);
    await publish(fs, fx);
    await unpublishPE(depsFor(fs), PUBLISHER, publicProjectionId(relayId));
    await expect(publish(fs, fx)).rejects.toThrow(/already used/);
    expect(fs.store.has(`commons_published_pes/${relayId}`)).toBe(false);
    // A fresh approval authorizes the next publication.
    await approvedConsent(fs, fx);
    await publish(fs, fx);
    expect(fs.store.has(`commons_published_pes/${relayId}`)).toBe(true);
  });

  it('a pending or denied consent still authorizes nothing', async () => {
    const { fs, fx } = setup();
    const consent = await requestConsent(depsFor(fs), PUBLISHER, {
      pe_id: fx.pe.pe_id, institution: 'commons', redaction_config: AGREED, pe: fx.pe, inclusion: fx.inclusion,
    }, { agentId: AGENT, anchorContract: fx.anchorContract });
    await expect(publish(fs, fx)).rejects.toThrow(/not all parties/i);
    await respondToConsent(depsFor(fs), COUNTERPARTY, consent.consent_id, 'denied');
    await expect(publish(fs, fx)).rejects.toThrow(/not all parties/i);
  });
});

describe('consentRefusal', () => {
  const base: PublicationConsent = {
    consent_id: 'c1', pe_id: 'p1', requesting_wallet_id: PUBLISHER, consenting_wallet_ids: [COUNTERPARTY],
    consent_status: { [COUNTERPARTY]: 'approved' }, redaction_config: AGREED, institution: 'commons',
    requested_at: 1_000, expires_at: 1_000 + COMMONS_SAFETY_LIMITS.CONSENT_EXPIRY_DAYS * DAY_MS,
  };
  const request = { redaction_config: AGREED, institution: 'commons' };

  it('accepts up to the expiry instant and refuses after it', () => {
    expect(consentRefusal(base, request, base.expires_at)).toBeNull();
    expect(consentRefusal(base, request, base.expires_at + 1)).toMatch(/expired/);
  });

  it('refuses a consent with no consenting party, a missing expiry, or a used mark', () => {
    expect(consentRefusal({ ...base, consenting_wallet_ids: [], consent_status: {} }, request, 2_000)).toMatch(/not all parties/i);
    expect(consentRefusal({ ...base, expires_at: undefined as unknown as number }, request, 2_000)).toMatch(/expired/);
    expect(consentRefusal({ ...base, consumed_at: 1_500 }, request, 2_000)).toMatch(/already used/);
  });
});
