import {publicProjectionId} from './projection-privacy';
/**
 * Commons PE publication under the PE METER.
 *
 * The relay keeps no PE, so publication / consent take the PE its OWNER holds plus its two-hop
 * inclusion proof, proven against the anchored root on Base. The relay stores only the public
 * projection (and the hash-only on-chain half of the proof); verification re-checks the anchor.
 * Every gate here has a RED control, and one proves the retired collections are never a source.
 */

import {
  publishPE,
  requestConsent,
  verifyProjection,
} from './publication';
import type { CommonsDeps, PublishPERequest, RequestConsentRequest } from './types';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { presentedPeFixture, type PresentedPeFixture } from '../meter/__test-helpers__/presented-pe';
import { meterRelayPeId } from '../meter/meter-store';

// publishPE emits a `commons_pe_published` PE at the end via generatePE — mock it
// so the test exercises the publication logic, not the chain-tip machinery.
const mockGeneratePE = jest.fn().mockResolvedValue({ peId: 'pe_pub', peHash: 'h', prevHash: 'p' });
jest.mock('../agent-bank/pe-utils', () => ({
  generatePE: (...args: unknown[]) => mockGeneratePE(...args),
}));

const PUBLISHER = 'wallet_pub';
const AGENT = 'agent_pub';

function depsFor(fs: FakeFirestore): CommonsDeps {
  return {
    db: fs,
    cache: { checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }) },
  } as unknown as CommonsDeps;
}

function redaction(over: Partial<PublishPERequest['redaction_config']> = {}) {
  return {
    show_intent_text: false,
    show_counterparty: false,
    show_amount: true,
    show_currency: true,
    show_artifact_hash: true,
    ...over,
  };
}

function ownedPE(fs: FakeFirestore, fields: Record<string, unknown> = {}): PresentedPeFixture {
  fs.store.set(`commons_profiles/${PUBLISHER}`, { wallet_id: PUBLISHER, published_pe_count: 0 });
  return presentedPeFixture({
    actorId: AGENT,
    fields: { metadata: { amount: '5', currency: 'usdc' }, ...fields },
  });
}

function publishBody(fx: PresentedPeFixture, over: Partial<PublishPERequest> = {}): PublishPERequest {
  return { pe_id: fx.pe.pe_id, institution: 'commons', redaction_config: redaction(), pe: fx.pe, inclusion: fx.inclusion, ...over };
}

beforeEach(() => mockGeneratePE.mockClear());

describe('publishPE (PE meter)', () => {
  it('publishes a presented, proven PE keyed by the relay id, with content from the PE itself', async () => {
    const fs = createFakeFirestore();
    const fx = ownedPE(fs);
    const relayId = meterRelayPeId(fx.peHash);
    const projection = await publishPE(depsFor(fs), PUBLISHER, AGENT, '0xpub', publishBody(fx), { anchorContract: fx.anchorContract });

    expect(projection.pe_id).toBe(publicProjectionId(relayId));
    expect(projection.pe_hash).not.toBe(fx.peHash);
    expect(projection.action_type).toBe('coding_session');
    expect(projection.amount).toBe('5');
    // No act key → the relay cannot vouch for a higher tier: the lowest.
    expect(projection.attestation_tier).toBe('software');
    expect(projection.anchor_proof).toMatchObject({ kind: 'meter_day', day: '2026-08-01' });
    // Stored: the public projection only — never the PE body or its pricing inputs.
    const stored = fs.store.get(`commons_published_pes/${relayId}`)!;
    expect(stored).toMatchObject({ pe_id: relayId, pe_hash: fx.peHash });
    expect(JSON.stringify(stored)).not.toContain('"pricing"');
    expect(stored).not.toHaveProperty('pe');
    expect(mockGeneratePE).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actionType: 'commons_pe_published', metadata: expect.objectContaining({ published_pe_id: relayId }) }),
    );
  });

  it('takes the relay-assigned tier from the live act key, never from the PE', async () => {
    const fs = createFakeFirestore();
    const fx = ownedPE(fs, { attestation_type: 'hardware_full' });
    fs.store.set(`meter_act_keys_v1/${meterRelayPeId(fx.peHash)}`, { row: { attestationDepth: 'corroborated' } });
    const projection = await publishPE(depsFor(fs), PUBLISHER, AGENT, '0xpub', publishBody(fx), { anchorContract: fx.anchorContract });
    expect(projection.attestation_tier).toBe('corroborated');
  });

  it('RED: without the PE + proof there is nothing to publish (a legacy pe_history row is NOT a source)', async () => {
    const fs = createFakeFirestore();
    const fx = ownedPE(fs);
    fs.store.set(`pe_history/${fx.pe.pe_id}`, { peId: fx.pe.pe_id, userId: AGENT, peHash: fx.peHash });
    fs.store.set(`provenance_envelopes/${fx.pe.pe_id}`, { user_id: AGENT, hash: fx.peHash });
    await expect(publishPE(depsFor(fs), PUBLISHER, AGENT, '0xpub', { pe_id: fx.pe.pe_id, institution: 'commons', redaction_config: redaction() }))
      .rejects.toThrow(/supply the PE/);
  });

  it('RED: a non-owner cannot publish someone else\'s proven PE', async () => {
    const fs = createFakeFirestore();
    const fx = ownedPE(fs);
    fs.store.set('commons_profiles/wallet_intruder', { wallet_id: 'wallet_intruder', published_pe_count: 0 });
    await expect(
      publishPE(depsFor(fs), 'wallet_intruder', 'agent_intruder', '0xx', publishBody(fx), { anchorContract: fx.anchorContract }),
    ).rejects.toThrow(/only the pe owner/i);
  });

  it('RED: an edited PE or an unanchored batch does not publish', async () => {
    const fs = createFakeFirestore();
    const fx = ownedPE(fs);
    const edited = { ...fx.pe, metadata: { amount: '5000', currency: 'usdc' } };
    await expect(publishPE(depsFor(fs), PUBLISHER, AGENT, '0xpub', publishBody(fx, { pe: edited }), { anchorContract: fx.anchorContract }))
      .rejects.toThrow(/act_not_in_batch/);
    await expect(publishPE(depsFor(fs), PUBLISHER, AGENT, '0xpub', publishBody(fx), { anchorContract: { verifyPE: async () => false } }))
      .rejects.toThrow(/pe_not_anchored/);
  });

  it('ENFORCES mutual consent (#33): a PE with a counterparty cannot show it without approved consent', async () => {
    const fs = createFakeFirestore();
    const fx = ownedPE(fs, { counterparty_address: '0xCounterparty' });
    await expect(publishPE(depsFor(fs), PUBLISHER, AGENT, '0xpub',
      publishBody(fx, { redaction_config: redaction({ show_counterparty: true }) }), { anchorContract: fx.anchorContract }))
      .rejects.toThrow(/mutual consent required/i);
  });
});

describe('requestConsent (PE meter)', () => {
  it('creates a consent request for the proven PE\'s counterparty, keyed by the relay id', async () => {
    const fs = createFakeFirestore();
    const fx = ownedPE(fs, { counterparty_address: '0xCounterParty' });
    fs.store.set('agent_wallets/wallet_cp', { address: '0xcounterparty' });
    const body: RequestConsentRequest = {
      pe_id: fx.pe.pe_id, institution: 'commons', redaction_config: redaction({ show_counterparty: true }),
      pe: fx.pe, inclusion: fx.inclusion,
    };
    const consent = await requestConsent(depsFor(fs), PUBLISHER, body, { agentId: AGENT, anchorContract: fx.anchorContract });
    expect(consent.pe_id).toBe(meterRelayPeId(fx.peHash));
    expect(consent.consenting_wallet_ids).toEqual(['wallet_cp']);
    // RED: the same request without the agent id names no owner of an agent's PE.
    await expect(requestConsent(depsFor(fs), PUBLISHER, body, { anchorContract: fx.anchorContract }))
      .rejects.toThrow(/only the pe owner/i);
  });
});

describe('verifyProjection (PE meter)', () => {
  it('verified=true while the anchor verifies on chain; false for a tampered leaf, a lost anchor, or a pre-meter projection', async () => {
    const fs = createFakeFirestore();
    const fx = ownedPE(fs);
    const relayId = meterRelayPeId(fx.peHash);
    await publishPE(depsFor(fs), PUBLISHER, AGENT, '0xpub', publishBody(fx), { anchorContract: fx.anchorContract });

    expect((await verifyProjection(depsFor(fs), publicProjectionId(relayId), { anchorContract: fx.anchorContract })).verified).toBe(true);
    expect((await verifyProjection(depsFor(fs), publicProjectionId(relayId), { anchorContract: { verifyPE: async () => false } })).verified).toBe(false);

    const pub = fs.store.get(`commons_published_pes/${relayId}`)!;
    const anchorProof = pub.anchor_proof as Record<string, unknown>;
    fs.store.set(`commons_published_pes/${relayId}`, { ...pub, anchor_proof: { ...anchorProof, batch_leaf: 'a'.repeat(64) } });
    expect((await verifyProjection(depsFor(fs), publicProjectionId(relayId), { anchorContract: fx.anchorContract })).verified).toBe(false);

    const { anchor_proof: _dropped, ...legacy } = pub;
    fs.store.set(`commons_published_pes/${relayId}`, legacy);
    expect((await verifyProjection(depsFor(fs), publicProjectionId(relayId), { anchorContract: fx.anchorContract })).verified).toBe(false);
  });
});
