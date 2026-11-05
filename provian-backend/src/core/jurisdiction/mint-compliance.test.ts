/** Real offline lookup -> policy -> shared mint classifier. Controls include a nonzero allowed act. */
jest.unmock('./mint-compliance');
jest.unmock('./jurisdiction-policy');
jest.unmock('./country');
jest.unmock('./sdn');
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { INITIAL_JURISDICTION_POLICIES } from './jurisdiction-policy';
import { countryFromIp, occupiedUaRegion } from './country';
import { observeWalletSession, observeActorSession, withJurisdictionRequest, evaluateMintCompliance, SESSION_COLLECTION } from './mint-compliance';
import { buildPEHistoryRow } from '../../pe-history';
import { computeRecordSnapshot } from '../pvt/policy/monetary-accounting';
import { materializeProposedMonetaryPolicy } from '../pvt/policy/runtime-monetary-policy';
import { buildPendingClaim, buildPayoutClaim, meterActClaimId, meterActClaimKey } from '../meter/meter-claims';
import { verifyMeterClaimMembers, createMeterClaimVerifier } from '../meter/meter-settlement';
import { METER_PENDING_CLAIMS_COLLECTION } from '../meter/meter-store';
const ACTOR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HUMAN = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HIT = '0x252a8bd2319d8a555b872990601221b3a2053bce';
const now = Date.now();
let fake: ReturnType<typeof createFakeFirestore>;
let db: Firestore;
beforeEach(() => {
  jest.resetModules();
  fake = createFakeFirestore(); db = fake as unknown as Firestore;
  fake.store.set('agent_wallets/agent-wallet', { agent_id: 'actor', address: ACTOR });
  fake.store.set('wallets/human-wallet', { user_id: 'human', address: HUMAN });
  for (const [code, entry] of Object.entries(INITIAL_JURISDICTION_POLICIES)) fake.store.set(`jurisdiction_policy/${code}`, { ...entry });
  fake.store.set('jurisdiction_screening_v1/ofac_sdn', {
    checked_at_ms: now, published: '10/28/2026', sha256: 'a'.repeat(64),
    addresses: [HIT.toLowerCase(), ...Array.from({ length: 100 }, (_, i) => `test-address-${i}`)],
  });
});
async function locate(address: string, ip: string): Promise<void> { await observeWalletSession(db, { ip }, [address]); }
async function status(beneficiary = false) {
  const snapshot = computeRecordSnapshot(materializeProposedMonetaryPolicy(0), {
    peId: 'pe_jurisdiction', economicActorId: 'actor', actionType: 'wallet_created', recordedAtMs: now,
    occurrenceOrdinal: 1, dailyOrdinal: 1, exactDuplicate: false, uniqueArtifact: false,
    attestationTier: 'software', linkageState: 'unlinked', evidenceState: 'not_required',
    canonicalEventId: null, selfReferencing: false, sharedBeneficialOwnership: false,
    pairChurnDetected: false, sessionLineageId: null, genesisReservation: null,
  });
  return (await buildPEHistoryRow({
    peId: 'pe_jurisdiction', userId: 'actor', actionType: 'wallet_created', timestamp: now,
    category: 'wallet', attestationDepth: 'software', estimatedPVT: 10, peHash: 'a'.repeat(64),
    // Forged submitter country cannot authorize anything.
    jurisdiction_context: 'US', compliance_db: db, economic_snapshot: snapshot,
    mint_disposition: snapshot.mintDisposition,
    ...(beneficiary ? { beneficiary_routing_snapshot: { human_address: HUMAN } as never } : {}),
  })).doc;
}
it('allowed real IP produces a nonzero eligible row', async () => {
  await locate(ACTOR, '8.8.8.8');
  expect(countryFromIp('8.8.8.8')).toMatchObject({ country: 'US', region: 'US-California' });
  expect(await status()).toMatchObject({ mint_status: 'eligible', jurisdiction_context: 'US', estimated_pvt_atomic: '10000000000000000000' });
});
it.each(['175.45.176.1', '5.34.192.1'])('real blocked IP %s is held without minting', async ip => {
  await locate(ACTOR, ip);
  expect(await status()).toMatchObject({ mint_status: 'pending_compliance', estimated_pvt_atomic: '0' });
});
it('real CN is deferred and retains its exact snapshot', async () => {
  await locate(ACTOR, '114.114.114.114');
  expect(await status()).toMatchObject({ mint_status: 'deferred', jurisdiction_context: 'CN', estimated_pvt_atomic: '0' });
});
it('beneficiary has its own country, and blocked beats deferred at either end', async () => {
  await locate(ACTOR, '114.114.114.114'); await locate(HUMAN, '5.34.192.1');
  expect(await status(true)).toMatchObject({ mint_status: 'pending_compliance' });
  await locate(ACTOR, '8.8.8.8'); await locate(HUMAN, '114.114.114.114');
  expect(await status(true)).toMatchObject({ mint_status: 'deferred', jurisdiction_context: 'CN' });
});
// Every IP the bundled MMDB places in an embargoed region must resolve to its
// blocked UA code and never mint, whatever English name DB-IP gives it. These
// are the real names the database uses; Sevastopol as "Sebastopol City" is the
// spelling that used to slip through, proven here through the real 194.12.100.1
// lookup rather than an injected session.
it.each([
  ['5.3.41.0', 'UA-43'],      // RU | "Crimea"
  ['194.12.100.1', 'UA-40'],  // RU | "Sebastopol City"
  ['37.139.96.1', 'UA-40'],   // UA | "Sebastopol City"
  ['5.105.215.0', 'UA-14'],   // UA | "Donetsk"
  ['45.10.32.0', 'UA-09'],    // UA | "Luhansk"
  ['188.190.220.1', 'UA-09'], // RU | "Luhansk"
])('embargoed region IP %s resolves to %s and blocks minting', async (ip, region) => {
  expect(countryFromIp(ip)).toMatchObject({ country: 'UA', region });
  await locate(ACTOR, ip);
  expect(await status()).toMatchObject({ mint_status: 'pending_compliance', jurisdiction_region: region });
});
// Kherson and Zaporizhzhia are outside the embargo: they resolve to an ordinary
// UA region and mint. This also guards against over-blocking — it fails if the
// matcher ever maps a non-embargoed region to a blocked code.
it.each(['91.200.60.1', '5.248.22.1', '46.148.16.1', '5.180.128.1', '46.148.22.1'])(
  'unoccupied UA region IP %s mints', async ip => {
    const observation = countryFromIp(ip);
    expect(observation.country).toBe('UA');
    expect(['UA-43', 'UA-40', 'UA-14', 'UA-09']).not.toContain(observation.region);
    await locate(ACTOR, ip);
    expect(await status()).toMatchObject({ mint_status: 'eligible' });
  });
describe('occupiedUaRegion keeps every spelling of the embargoed regions', () => {
  it.each([
    ['Crimea', 'UA-43'], ['Republic of Crimea', 'UA-43'], ['Autonomous Republic of Crimea', 'UA-43'], ['Krym', 'UA-43'],
    ['Sevastopol', 'UA-40'], ['Sebastopol', 'UA-40'], ['Sebastopol City', 'UA-40'], ["Sevastopol'", 'UA-40'],
    ['Donetsk', 'UA-14'], ['Donetsk Oblast', 'UA-14'], ["Donets'k", 'UA-14'], ["Donetsk People's Republic", 'UA-14'],
    ['Luhansk', 'UA-09'], ['Lugansk', 'UA-09'], ['Luhansk Oblast', 'UA-09'], ["Luhansk People's Republic", 'UA-09'],
  ])('%s -> %s', (name, code) => expect(occupiedUaRegion(name)).toBe(code));
  // Non-vacuous control: regions outside the embargo, and empty input, never match,
  // so the resolver cannot be hardwired to block.
  it.each(['Kherson', 'Kherson Oblast', 'Zaporizhzhia', 'Zaporizhzhya Oblast', 'Moscow', 'Kyiv City', 'Kharkiv', 'Odesa', '', ' '])(
    'does not match %s', name => expect(occupiedUaRegion(name)).toBeNull());
});
it('unknown IP and missing beneficiary session never inherit actor US', async () => {
  await locate(ACTOR, '127.0.0.1');
  expect(await status()).toMatchObject({ mint_status: 'pending_compliance', jurisdiction_context: '' });
  await locate(ACTOR, '8.8.8.8');
  expect(await status(true)).toMatchObject({ mint_status: 'pending_compliance' });
});
it('SDN match on actor or beneficiary is terminal regardless of country', async () => {
  await locate(ACTOR, '8.8.8.8'); await locate(HUMAN, '8.8.8.8');
  // Use a real address listed in the official SDN digital currency address feed.
  fake.store.set('agent_wallets/agent-wallet', { agent_id: 'actor', address: HIT });
  await locate(HIT, '8.8.8.8');
  expect(await status()).toMatchObject({ mint_status: 'ineligible', jurisdiction_compliance_reason: 'sdn_hit' });
  fake.store.set('agent_wallets/agent-wallet', { agent_id: 'actor', address: ACTOR });
  expect(await evaluateMintCompliance('actor', HIT, db)).toMatchObject({ policy: 'blocked', reason: 'sdn_hit' });
});
it('unresolved region in UA and RU fails closed', async () => {
  for (const country of ['UA', 'RU']) {
    fake.store.set(`${SESSION_COLLECTION}/${ACTOR}`, { country, region: null, address: ACTOR, observed_at_ms: now });
    expect(await status()).toMatchObject({ mint_status: 'pending_compliance' });
  }
});
it('approval rechecks a real claim instead of trusting its earlier eligible status', async () => {
  await locate(ACTOR, '8.8.8.8');
  const identity = { id: 'pe_j', prev_hash: 'a'.repeat(64), hash: 'b'.repeat(64), timestamp: now, action_type: 'service:github_commit', user_id: 'actor' };
  const claim = buildPendingClaim({ claim_key: meterActClaimKey('pe_j', 'sole'), unit: 'act', batch_hash: 'c'.repeat(64),
    device_id: 'relay:actor', actor_id: 'actor', leg: 'sole', contributor: ACTOR, beneficiary_class: 1,
    record_points_atomic: '1000', acts: [{ relay_pe_id: 'pe_j', points_atomic: '1000' }],
    act_identity: identity, claim_id: meterActClaimId(identity, 'sole'), created_at_ms: now, ready_at_ms: 0 });
  fake.store.set(`${METER_PENDING_CLAIMS_COLLECTION}/${claim.claim_key}`, { ...claim, state: 'registered' });
  const members = [{ pe_id: claim.claim_key, leg: 'sole' as const, claim_id: claim.claim_id }];
  expect((await verifyMeterClaimMembers(db, members)).get(claim.claim_key)).toMatchObject({ ok: true });
  await locate(ACTOR, '5.34.192.1');
  expect((await verifyMeterClaimMembers(db, members)).get(claim.claim_key)).toMatchObject({ ok: false, reason: 'mint_compliance_jurisdiction_blocked' });
});

it('a blocked lookup cannot become eligible from a second lookup or client-forged evidence', async () => {
  await locate(ACTOR, '5.34.192.1');
  const evidence = await evaluateMintCompliance('actor', null, db);
  await locate(ACTOR, '8.8.8.8');
  const blocked = await buildPEHistoryRow({ peId: 'pe_frozen', userId: 'actor', actionType: 'wallet_created', timestamp: now,
    category: 'wallet', attestationDepth: 'software', estimatedPVT: 10, peHash: 'a'.repeat(64), jurisdiction_context: 'US',
    compliance_db: db, mint_compliance_evidence: evidence });
  expect(blocked.doc.mint_status).toBe('pending_compliance');
  await locate(ACTOR, '5.34.192.1');
  const forged = await buildPEHistoryRow({ peId: 'pe_forged', userId: 'actor', actionType: 'wallet_created', timestamp: now,
    category: 'wallet', attestationDepth: 'software', estimatedPVT: 10, peHash: 'a'.repeat(64), jurisdiction_context: 'US',
    compliance_db: db, mint_compliance_evidence: { ...evidence, policy: 'immediate', reason: 'clear' } });
  expect(forged.doc.mint_status).toBe('pending_compliance');
});
it('stale sanctions evidence cannot authorize minting', async () => {
  await locate(ACTOR, '8.8.8.8');
  expect(await evaluateMintCompliance('actor', null, db, now + 49 * 3600000)).toMatchObject({ policy: 'blocked', reason: 'sdn_unavailable' });
 });
it('a known country remains resolved until another authenticated observation changes it', async () => {
  fake.store.set(`${SESSION_COLLECTION}/${ACTOR}`, { country: 'US', region: 'US-CA', address: ACTOR, observed_at_ms: now - 31 * 86400000 });
  expect(await status()).toMatchObject({ mint_status: 'eligible' });
  await locate(ACTOR, '127.0.0.1');
  expect(await status()).toMatchObject({ mint_status: 'pending_compliance' });
});

it('failed authenticated observation cannot fall back to a persisted allowed country', async () => {
  await locate(ACTOR, '8.8.8.8');
  await withJurisdictionRequest(async () => {
    const original = fake.collection.bind(fake);
    fake.collection = () => { throw new Error('temporary identity failure'); };
    await observeActorSession(db, { ip: '5.34.192.1' }, 'agent-wallet');
    fake.collection = original;
    // Different alias of the same actor must also fail closed in this request.
    expect(await evaluateMintCompliance('actor', null, db)).toMatchObject({ policy: 'blocked', reason: 'jurisdiction_unknown' });
  });
});
it('cached payout integrity never caches a compliance approval', async () => {
  await locate(ACTOR, '8.8.8.8');
  const identity = { id: 'pe_j', prev_hash: 'a'.repeat(64), hash: 'b'.repeat(64), timestamp: now, action_type: 'service:github_commit', user_id: 'actor' };
  const member = buildPendingClaim({ claim_key: meterActClaimKey('pe_j', 'sole'), unit: 'act', batch_hash: 'c'.repeat(64),
    device_id: 'relay:actor', actor_id: 'actor', leg: 'sole', contributor: ACTOR, beneficiary_class: 1,
    record_points_atomic: '1000', acts: [{ relay_pe_id: 'pe_j', points_atomic: '1000' }],
    act_identity: identity, claim_id: meterActClaimId(identity, 'sole'), created_at_ms: now, ready_at_ms: 0 });
  const payout = buildPayoutClaim({ leg: 'sole', contributor: ACTOR, beneficiary_class: 1,
    members: [{ claim_key: member.claim_key, claim_id: member.claim_id, points_atomic: '1000' }], created_at_ms: now });
  fake.store.set(`${METER_PENDING_CLAIMS_COLLECTION}/${member.claim_key}`, { ...member, state: 'aggregated', payout_key: payout.claim_key });
  fake.store.set(`${METER_PENDING_CLAIMS_COLLECTION}/${payout.claim_key}`, { ...payout, state: 'registered' });
  const verify = createMeterClaimVerifier(db);
  const members = [{ pe_id: payout.claim_key, leg: 'sole' as const, claim_id: payout.claim_id }];
  expect((await verify(members)).get(payout.claim_key)).toMatchObject({ ok: true });
  await locate(ACTOR, '114.114.114.114');
  expect((await verify(members)).get(payout.claim_key)).toMatchObject({ ok: false, reason: 'mint_compliance_jurisdiction_deferred' });
});
it('a non-minting record does not copy a beneficiary location without a compliance retention event', async () => {
  await locate(ACTOR, '8.8.8.8'); await locate(HUMAN, '5.34.192.1');
  const doc = (await buildPEHistoryRow({ peId: 'pe_no_mint_foreign_location', userId: 'actor',
    actionType: 'device_register', timestamp: now, category: 'wallet', attestationDepth: 'software',
    estimatedPVT: 0, peHash: 'c'.repeat(64), jurisdiction_context: '', compliance_db: db,
    mint_disposition: 'record_only', beneficiary_routing_snapshot: { human_address: HUMAN } as never })).doc;
  expect(doc).toMatchObject({ mint_status: 'record_only', jurisdiction_mint_held: false,
    jurisdiction_context: 'US', jurisdiction_region: 'US-California' });
  // Positive control: when the same parties actually have a mint held, preserve the blocking rule.
  expect(await status(true)).toMatchObject({ mint_status: 'pending_compliance', jurisdiction_context: 'IR', jurisdiction_mint_held: true });
});
it('a concurrent evidence hold preserves the original blocking rule and starts compliance retention', async () => {
  await locate(ACTOR, '8.8.8.8'); await locate(HUMAN, '5.34.192.1');
  const doc = (await buildPEHistoryRow({ peId: 'pe_multiple_holds', userId: 'actor',
    actionType: 'coding_session', timestamp: now, category: 'agent', attestationDepth: 'software',
    estimatedPVT: 10, peHash: 'd'.repeat(64), jurisdiction_context: '', compliance_db: db,
    mint_disposition: 'pending_evidence', beneficiary_routing_snapshot: { human_address: HUMAN } as never })).doc;
  expect(doc).toMatchObject({ mint_status: 'pending_evidence', jurisdiction_mint_held: true, jurisdiction_context: 'IR' });
  const { planComplianceRetention, prepareComplianceRetention } = await import('./location-retention');
  const plans = await planComplianceRetention(db, doc.peId, doc as unknown as Record<string, unknown>, now);
  expect(plans).toHaveLength(1);
  await db.runTransaction(async txn => { const commit = await prepareComplianceRetention(db, txn, plans, now); commit(); });
  expect(fake.store.get(`${SESSION_COLLECTION}/${HUMAN}`)?.retention_until_ms).toBeGreaterThan(now);
});
