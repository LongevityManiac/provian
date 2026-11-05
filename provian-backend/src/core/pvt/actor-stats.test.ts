/** Trust Layer build §2.5 / actor stats: the vocabulary's incrementally-maintained counters. */
import {
  applyActorStatsBump, emptyActorStats, deriveCompositionSignals, modelFamilyOf, attestationRank, statsKey,
  bumpActorStats, readActorStats, coerceActorStats, serializeActorStats, measurementKey, hardwareMeasurementOf,
  ACTOR_STATS_MAX_FACET_KEYS, ACTOR_STATS_MAX_DAY_FACET_KEYS, ACTOR_STATS_COLLECTION, ACTOR_STATS_DAY_WINDOW_DAYS,
  ACTOR_STATS_SCHEMA_V1, utcDayKey, issuerKey, inboundPayerKey, withInboundPayer, encodeDayBucket, decodeDayBucket,
  ACTOR_STATS_MAX_PAYER_KEYS, ACTOR_STATS_MAX_DAY_PAYER_KEYS,
  type ActorStatsBump, type CompositionSignals,
} from './actor-stats';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import { baseEconomicEvidence, testTxHash } from './__test-helpers__/base-economic-evidence';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 16, 12);
const SHA384 = `sha384:${'ab'.repeat(48)}`;

function bump(over: Partial<ActorStatsBump> = {}): ActorStatsBump {
  return {
    actorId: 'alice', actionType: 'coding_session', family: 'agent', witnessClass: 'device_tier',
    timestampMs: T0, attestationTier: 'software', witnessObservedTokens: 100, bodyDeclaredTokens: 120,
    independentOriginCount: 2, approvalsCited: 0, composition: null, ...over,
  };
}

function comp(over: Partial<CompositionSignals> = {}): CompositionSignals {
  return {
    modelFamilies: [], environmentClass: null, hardwareRegion: null, hardwareMeasurement: null,
    witnessedPaymentAtomic: null, supervisionHumanTurns: null, supervisionTotalTurns: null, ...over,
  };
}

const admittedNitro = { admitted: true, scheme: 'aws_nitro', reason: 'verified', region: 'us-east-1', launch_measurement: SHA384.toUpperCase() };

function usdcEvidence(amountAtomic: string) {
  return baseEconomicEvidence({
    transactionHash: testTxHash('pay'), logIndex: 0, blockNumber: 100,
    fromAddress: '0x1111111111111111111111111111111111111111', toAddress: '0x2222222222222222222222222222222222222222', amountAtomic,
  });
}

describe('applyActorStatsBump', () => {
  it('counts by type and family×class, sums witnessed compute only for a witnessed class, tracks first/last', () => {
    let s = applyActorStatsBump(emptyActorStats('alice'), bump(), T0);
    s = applyActorStatsBump(s, bump({ timestampMs: T0 + 1000, witnessClass: 'actor_declared', witnessObservedTokens: 999 }), T0 + 1000);
    expect(s.pe_count).toBe(2);
    expect(s.by_type.coding_session).toBe(2);
    expect(s.by_family_class.agent__device_tier).toBe(1);
    expect(s.by_family_class.agent__actor_declared).toBe(1);
    // RED: the actor-declared row's 999 observed tokens must NOT be summed (no witness).
    expect(s.witnessed_compute_tokens).toBe(100);
    expect(s.declared_compute_tokens).toBe(240);
    expect(s.first_pe_at_ms).toBe(T0);
    expect(s.last_pe_at_ms).toBe(T0 + 1000);
    expect(s.independent_origins_cited).toBe(4);
  });

  it('active days + streak: consecutive UTC days extend the streak, a gap resets it, a same-day row changes nothing', () => {
    let s = applyActorStatsBump(emptyActorStats('a'), bump({ timestampMs: T0 }), T0);
    s = applyActorStatsBump(s, bump({ timestampMs: T0 + 3600_000 }), T0);
    expect(s.active_days).toBe(1); expect(s.streak_days).toBe(1);
    s = applyActorStatsBump(s, bump({ timestampMs: T0 + DAY }), T0);
    expect(s.active_days).toBe(2); expect(s.streak_days).toBe(2);
    s = applyActorStatsBump(s, bump({ timestampMs: T0 + 5 * DAY }), T0);
    expect(s.active_days).toBe(3); expect(s.streak_days).toBe(1);
    // RED: a late/backfilled row from an EARLIER day never rewinds the anchor or the streak.
    const before = s;
    s = applyActorStatsBump(s, bump({ timestampMs: T0 - 3 * DAY }), T0);
    expect(s.last_active_day).toBe(before.last_active_day);
    expect(s.streak_days).toBe(before.streak_days);
  });

  it('highest attestation rank is monotone; composition facets are counted and bounded', () => {
    let s = applyActorStatsBump(emptyActorStats('a'), bump({ attestationTier: 'hardware_full' }), T0);
    s = applyActorStatsBump(s, bump({ attestationTier: 'software' }), T0);
    expect(s.highest_attestation_rank).toBe(attestationRank('hardware_full'));
    s = applyActorStatsBump(s, bump({ composition: comp({ modelFamilies: ['claude', 'gpt'], environmentClass: 'container', supervisionHumanTurns: 3, supervisionTotalTurns: 10 }) }), T0);
    expect(s.models).toEqual({ claude: 1, gpt: 1 });
    expect(s.environments).toEqual({ container: 1 });
    expect(s.supervision_human_turns).toBe(3);
    expect(s.supervision_total_turns).toBe(10);
    for (let i = 0; i < ACTOR_STATS_MAX_FACET_KEYS + 10; i += 1) {
      s = applyActorStatsBump(s, bump({ composition: comp({ modelFamilies: [`fam${i}`] }) }), T0);
    }
    expect(Object.keys(s.models).length).toBe(ACTOR_STATS_MAX_FACET_KEYS);
    // Per-day facet maps are bounded tighter (the 366-bucket document stays under 1 MiB).
    expect(Object.keys(s.days[utcDayKey(T0)].m).length).toBe(ACTOR_STATS_MAX_DAY_FACET_KEYS);
  });
});

describe(' day buckets — live history, pruned, clamped', () => {
  it('buckets per UTC day with the same rules as the lifetime facts (witness class, tokens, financial, adverse, promises)', () => {
    let s = emptyActorStats('a');
    s = applyActorStatsBump(s, bump({ timestampMs: T0 }), T0);
    s = applyActorStatsBump(s, bump({ timestampMs: T0 + 60_000, witnessClass: 'actor_declared', witnessObservedTokens: 999 }), T0);
    s = applyActorStatsBump(s, bump({ timestampMs: T0 - DAY, actionType: 'send', family: 'wallet', witnessClass: 'chain_witnessed' }), T0);
    s = applyActorStatsBump(s, bump({ timestampMs: T0 - DAY, actionType: 'send', family: 'wallet', witnessClass: 'actor_declared' }), T0);
    s = applyActorStatsBump(s, bump({ timestampMs: T0, actionType: 'court_verdict', family: 'other', witnessClass: 'chain_witnessed', composition: comp({ standingChainAdverse: true }) }), T0);
    s = applyActorStatsBump(s, bump({ timestampMs: T0, actionType: 'promise_fulfilled', family: 'promises', witnessClass: 'relay_verified' }), T0);
    s = applyActorStatsBump(s, bump({ timestampMs: T0, actionType: 'promise_defaulted', family: 'promises', witnessClass: 'relay_verified' }), T0);
    const today = s.days[utcDayKey(T0)];
    const yesterday = s.days[utcDayKey(T0 - DAY)];
    expect(today.n).toBe(5);
    expect(today.wc).toEqual({ device_tier: 1, actor_declared: 1, chain_witnessed: 1, relay_verified: 2 });
    // RED: the declared row's 999 tokens are not in the bucket either.
    expect(today.tok).toBe(100 + 100 + 100 + 100);
    expect(today.adv).toBe(2); // court_verdict + promise_defaulted (both in the standing set)
    expect(today.pf).toBe(1);
    expect(today.pd).toBe(1);
    expect(yesterday.n).toBe(2);
    expect(yesterday.fin).toBe(1); // RED: the actor_declared send is not witnessed financial
  });

  it('prunes buckets older than the retained window on every bump; an out-of-window row counts lifetime only', () => {
    let s = applyActorStatsBump(emptyActorStats('a'), bump({ timestampMs: T0 }), T0);
    expect(Object.keys(s.days)).toEqual([utcDayKey(T0)]);
    // A row older than the window: lifetime yes, no bucket.
    s = applyActorStatsBump(s, bump({ timestampMs: T0 - ACTOR_STATS_DAY_WINDOW_DAYS * DAY }), T0);
    expect(s.pe_count).toBe(2);
    expect(Object.keys(s.days)).toEqual([utcDayKey(T0)]);
    // The oldest retained day is exactly window-1 days back.
    s = applyActorStatsBump(s, bump({ timestampMs: T0 - (ACTOR_STATS_DAY_WINDOW_DAYS - 1) * DAY }), T0);
    expect(Object.keys(s.days).sort()).toEqual([utcDayKey(T0 - (ACTOR_STATS_DAY_WINDOW_DAYS - 1) * DAY), utcDayKey(T0)]);
    // RED: a bump 400 days later prunes BOTH old buckets (pruning is not only on insert of the same day).
    const later = T0 + 400 * DAY;
    s = applyActorStatsBump(s, bump({ timestampMs: later }), later);
    expect(Object.keys(s.days)).toEqual([utcDayKey(later)]);
  });

  it('a forward-dated body is clamped to the seal day (never counts toward a future window)', () => {
    const s = applyActorStatsBump(emptyActorStats('a'), bump({ timestampMs: T0 + 10 * DAY }), T0);
    expect(Object.keys(s.days)).toEqual([utcDayKey(T0)]);
  });

  it('persists buckets as compact strings and round-trips them; a v1 document is read as history-incomplete with regions dropped', () => {
    const s = applyActorStatsBump(emptyActorStats('a'), bump({ witnessClass: 'hardware_rooted', composition: comp({ hardwareRegion: 'us-east-1', hardwareMeasurement: SHA384 }) }), T0);
    const stored = serializeActorStats(s);
    expect(typeof (stored.days as Record<string, unknown>)[utcDayKey(T0)]).toBe('string');
    expect(coerceActorStats('a', stored)).toEqual(s);
    const v1 = { ...stored, schema_version: ACTOR_STATS_SCHEMA_V1, regions: { forged: 3 } };
    const up = coerceActorStats('a', v1);
    expect(up.history_complete).toBe(false);
    expect(up.regions).toEqual({});
    expect(up.days).toEqual({});
    expect(emptyActorStats('x').history_complete).toBe(true);
  });
});

describe(' attested region / measurement — SEALED + ADMITTED + any lane class', () => {
  it('derives region + measurement from the sealed admitted witness under hardware_rooted', () => {
    const c = deriveCompositionSignals({}, null, { witnessClass: 'hardware_rooted', sealedHardwareWitness: admittedNitro })!;
    expect(c.hardwareRegion).toBe('us-east-1');
    expect(c.hardwareMeasurement).toBe(SHA384); // lowercased
  });

  it('RED: a raw request-metadata region, an unadmitted sealed witness, yields nothing; a verified device-tier report retains facts', () => {
    // The client puts a region (and a fake "admitted" summary) in its own metadata — never read.
    expect(deriveCompositionSignals({ hardware_witness: admittedNitro, attested_region: 'eu-west-1' }, null, { witnessClass: 'hardware_rooted' })).toBeNull();
    // Present-but-unverifiable report (admitted:false) even under a (wrongly) hardware class.
    expect(deriveCompositionSignals({}, null, { witnessClass: 'hardware_rooted', sealedHardwareWitness: { ...admittedNitro, admitted: false } })).toBeNull();
    // Admitted sealed witness but the relay class is device_tier.
    expect(deriveCompositionSignals({}, null, { witnessClass: 'device_tier', sealedHardwareWitness: admittedNitro })?.hardwareRegion).toBe('us-east-1');
    // Truthy-but-not-true `admitted` is not admitted.
    expect(deriveCompositionSignals({}, null, { witnessClass: 'hardware_rooted', sealedHardwareWitness: { ...admittedNitro, admitted: 'true' } })).toBeNull();
  });

  it('RED: the bump counts a region / measurement under its ordinary lane class as well as App Attest', () => {
    const signals = comp({ hardwareRegion: 'us-east-1', hardwareMeasurement: SHA384 });
    const dropped = applyActorStatsBump(emptyActorStats('a'), bump({ witnessClass: 'device_tier', composition: signals }), T0);
    expect(dropped.regions).toEqual({'us-east-1':1});
    expect(dropped.measurements).toEqual({[SHA384]:1});
    expect(dropped.days[utcDayKey(T0)].r).toEqual({'us-east-1':1});
    const counted = applyActorStatsBump(emptyActorStats('a'), bump({ witnessClass: 'hardware_rooted', composition: signals }), T0);
    expect(counted.regions).toEqual({ 'us-east-1': 1 });
    expect(counted.measurements).toEqual({ [SHA384]: 1 });
    expect(counted.days[utcDayKey(T0)].ms).toEqual({ [SHA384]: 1 });
  });

  it('measurement per scheme; the measurement key is its own charset (never the 64-char statsKey)', () => {
    expect(hardwareMeasurementOf({ scheme: 'tpm2_quote', pcr_digest: 'sha256:' + 'cd'.repeat(32) })).toBe('sha256:' + 'cd'.repeat(32));
    expect(hardwareMeasurementOf({ scheme: 'gcp_confidential_space', image_digest: 'sha256:' + 'ef'.repeat(32) })).toBe('sha256:' + 'ef'.repeat(32));
    expect(hardwareMeasurementOf({ scheme: 'nvidia_cc', measurement_digest: SHA384 })).toBe(SHA384);
    expect(hardwareMeasurementOf({ scheme: 'azure_attestation', launch_measurement: SHA384 })).toBe(SHA384);
    expect(hardwareMeasurementOf({ scheme: 'apple_app_attest', launch_measurement: SHA384 })).toBeNull();
    expect(SHA384.length).toBeGreaterThan(64);
    expect(measurementKey(SHA384)).toBe(SHA384); // 103 chars — kept whole
    expect(measurementKey('sha256:has space')).toBeNull(); // never rewritten
    expect(measurementKey('x'.repeat(111))).toBeNull();
  });
});

describe(' witnessed payment volume — chain-witnessed Base USDC evidence only', () => {
  it('reads the verified evidence amount under chain_witnessed and sums it with BigInt (no 2^53 rounding)', () => {
    const md = { verified: true, economic_evidence: usdcEvidence('9007199254740993') };
    const c = deriveCompositionSignals(md, null, { witnessClass: 'chain_witnessed' })!;
    expect(c.witnessedPaymentAtomic).toBe('9007199254740993');
    let s = applyActorStatsBump(emptyActorStats('a'), bump({ actionType: 'receive', family: 'wallet', witnessClass: 'chain_witnessed', composition: c }), T0);
    s = applyActorStatsBump(s, bump({ actionType: 'receive', family: 'wallet', witnessClass: 'chain_witnessed', composition: c }), T0);
    expect(s.payment_volume_atomic).toBe('18014398509481986');
    expect(s.days[utcDayKey(T0)].pay).toBe('18014398509481986');
  });

  it('RED: a self-reported amount, unverified metadata, a non-USDC token, a tampered amount, or a non-chain class counts nothing', () => {
    // Sovereign x402 self-report: client amountAtomic, no evidence.
    expect(deriveCompositionSignals({ amountAtomic: '5000000', settlementTxHash: testTxHash('x') }, null, { witnessClass: 'chain_witnessed' })).toBeNull();
    const good = usdcEvidence('5000000');
    expect(deriveCompositionSignals({ verified: false, economic_evidence: good }, null, { witnessClass: 'chain_witnessed' })).toBeNull();
    expect(deriveCompositionSignals({ verified: true, economic_evidence: { ...good, tokenAddress: '0x0000000000000000000000000000000000000001' } }, null, { witnessClass: 'chain_witnessed' })).toBeNull();
    // An inflated amount breaks the evidence hash.
    expect(deriveCompositionSignals({ verified: true, economic_evidence: { ...good, amountAtomic: '5000000000' } }, null, { witnessClass: 'chain_witnessed' })).toBeNull();
    expect(deriveCompositionSignals({ verified: true, economic_evidence: good }, null, { witnessClass: 'device_tier' })).toBeNull();
    // And the bump drops a payment signal under any non-chain class.
    const s = applyActorStatsBump(emptyActorStats('a'), bump({ witnessClass: 'device_tier', composition: comp({ witnessedPaymentAtomic: '5000000' }) }), T0);
    expect(s.payment_volume_atomic).toBe('0');
  });
});

describe('deriveCompositionSignals / modelFamilyOf (metadata-only)', () => {
  it('model FAMILY only — never the full id; provider prefixes dropped', () => {
    expect(modelFamilyOf('claude-sonnet-4-5')).toBe('claude');
    expect(modelFamilyOf('anthropic/claude-3-opus')).toBe('claude');
    expect(modelFamilyOf('gpt-4o-mini')).toBe('gpt');
    expect(modelFamilyOf('gemini-2.5-pro')).toBe('gemini');
    expect(modelFamilyOf('meta-llama/Llama-3.1-70B')).toBe('llama');
    expect(modelFamilyOf('my-private-deployment-xyz')).toBe('my');
    expect(modelFamilyOf('')).toBeNull();
    expect(modelFamilyOf(42)).toBeNull();
  });
  it('reads model / inference.models / execution_env.environment_class / supervision; null when nothing present', () => {
    const c = deriveCompositionSignals(
      { model: 'claude-sonnet-4', inference: { models: ['gpt-4o', { model: 'gemini-2' }] }, supervision: { human_opened_turns: 2, total_turns: 5 } },
      { environment_class: 'Container' },
    )!;
    expect(c.modelFamilies).toEqual(['claude', 'gemini', 'gpt']);
    expect(c.environmentClass).toBe('container');
    expect(c.hardwareRegion).toBeNull();
    expect(c.supervisionHumanTurns).toBe(2);
    expect(c.supervisionTotalTurns).toBe(5);
    expect(deriveCompositionSignals({}, null)).toBeNull();
    // RED: free text never becomes a key.
    expect(statsKey('Some Prompt Text with $secret$')).toBe('some_prompt_text_with__secret_');
    expect(statsKey('x'.repeat(200))?.length).toBe(64);
  });
});

describe('bumpActorStats (transactional) + readActorStats', () => {
  it('creates, then increments in place; the reader returns an empty (complete) doc for an unknown actor', async () => {
    const db = createFakeFirestore();
    const fs = db as unknown as Parameters<typeof bumpActorStats>[0];
    await bumpActorStats(fs, bump(), T0);
    await bumpActorStats(fs, bump({ actionType: 'x402_payment', family: 'x402', witnessClass: 'chain_witnessed' }), T0);
    const s = await readActorStats(fs, 'alice');
    expect(s.pe_count).toBe(2);
    expect(s.by_family_class.x402__chain_witnessed).toBe(1);
    expect(s.history_complete).toBe(true);
    expect(s.days[utcDayKey(T0)].n).toBe(2);
    expect((db.store.get(`${ACTOR_STATS_COLLECTION}/alice`) as { pe_count: number }).pe_count).toBe(2);
    const nobody = await readActorStats(fs, 'nobody');
    expect(nobody.pe_count).toBe(0);
    expect(nobody.history_complete).toBe(true);
    await expect(bumpActorStats(fs, bump({ actorId: '' }), T0)).rejects.toThrow('actor_stats_bump_missing_actor');
  });

  it('a live bump on a v1 document upgrades it to v2 but leaves history_complete false (until the backfill)', async () => {
    const db = createFakeFirestore();
    const fs = db as unknown as Parameters<typeof bumpActorStats>[0];
    db.store.set(`${ACTOR_STATS_COLLECTION}/alice`, { schema_version: ACTOR_STATS_SCHEMA_V1, actor_id: 'alice', pe_count: 7, regions: { forged: 1 } });
    await bumpActorStats(fs, bump(), T0);
    const s = await readActorStats(fs, 'alice');
    expect(s.pe_count).toBe(8);
    expect(s.history_complete).toBe(false);
    expect(s.regions).toEqual({});
  });

  it('a read failure throws (never an empty doc)', async () => {
    const failing = { collection: () => ({ doc: () => ({ get: async () => { throw new Error('unavailable'); } }) }) } as unknown as Parameters<typeof readActorStats>[0];
    await expect(readActorStats(failing, 'alice')).rejects.toThrow('unavailable');
  });
});


describe('one adverse event, once, on the party at fault', () => {
  const { deriveCompositionSignals, countsAsAdverse, ADVERSE_STANDING_TYPES, CHAIN_WITNESSED_ADVERSE_TYPES, coerceActorStats, hasAdverseTypeKey } =
    require('./actor-stats') as typeof import('./actor-stats');
  // The pre- rule, kept here as the RED control: adverse by action type alone.
  const typeOnly = (t: string) => ADVERSE_STANDING_TYPES.has(t);
  const watcherRow = { standing: 'adverse', canonical_event_id: 'base:0xabc:3', institution: 'court' };

  it('a Court verdict counts on the watcher row only: the relay rows on BOTH escrow parties add nothing', () => {
    const relayWinner = deriveCompositionSignals({ role: 'recipient', verdict: 'release_to_recipient', verified: true, tx_hash: '0xabc' }, null);
    const relayLoser = deriveCompositionSignals({ role: 'depositor', verdict: 'release_to_recipient', verified: true, tx_hash: '0xabc' }, null);
    const chainLoser = deriveCompositionSignals(watcherRow, null);
    // RED: the old rule counted every one of these rows.
    expect(typeOnly('court_verdict')).toBe(true);
    expect(countsAsAdverse('court_verdict', relayWinner)).toBe(false);
    expect(countsAsAdverse('court_verdict', relayLoser)).toBe(false);
    expect(countsAsAdverse('court_verdict', chainLoser)).toBe(true);

    let winner = emptyActorStats('winner');
    winner = applyActorStatsBump(winner, bump({ actorId: 'winner', actionType: 'court_verdict', family: 'court', witnessClass: 'relay_verified', composition: relayWinner }), T0);
    expect(winner.by_type.court_verdict).toBe(1); // the row is still a record
    expect(winner.adverse_by_type).toEqual({});
    expect(winner.days[utcDayKey(T0)].adv).toBe(0);

    let loser = emptyActorStats('loser');
    loser = applyActorStatsBump(loser, bump({ actorId: 'loser', actionType: 'court_verdict', family: 'court', witnessClass: 'relay_verified', composition: relayLoser }), T0);
    loser = applyActorStatsBump(loser, bump({ actorId: 'loser', actionType: 'court_verdict', family: 'court', witnessClass: 'chain_witnessed', composition: chainLoser }), T0);
    expect(loser.by_type.court_verdict).toBe(2);
    expect(loser.adverse_by_type).toEqual({ court_verdict: 1 }); // once, not twice
    expect(loser.days[utcDayKey(T0)].adv).toBe(1);
  });

  it('a verdict settled on a chain the watcher does not read counts on the relay row of the LOSER only', () => {
    const md = (role: string, verdict: string, chain_id: unknown) => deriveCompositionSignals({ role, verdict, chain_id, verified: true }, null);
    // Arbitrum (42161): no watcher row will ever exist, so the loser's relay row is the count.
    expect(countsAsAdverse('court_verdict', md('depositor', 'release_to_recipient', 42161))).toBe(true);
    expect(countsAsAdverse('court_verdict', md('recipient', 'refund_to_depositor', 42161))).toBe(true);
    expect(countsAsAdverse('court_verdict', md('recipient', 'release_to_recipient', 42161))).toBe(false); // the winner
    expect(countsAsAdverse('court_verdict', md('depositor', 'refund_to_depositor', 42161))).toBe(false); // the winner
    // RED: on Base the watcher's row is the count — the same loser row must NOT also count.
    expect(countsAsAdverse('court_verdict', md('depositor', 'release_to_recipient', 8453))).toBe(false);
    // Unknown chain = not counted from the relay row.
    expect(countsAsAdverse('court_verdict', md('depositor', 'release_to_recipient', undefined))).toBe(false);
    expect(countsAsAdverse('court_verdict', md('depositor', 'release_to_recipient', '42161'))).toBe(false);
  });

  it('a promise default counts on the borrower, never on the lender', () => {
    const lender = deriveCompositionSignals({ role: 'lender', sentiment: 'negative' }, null);
    const borrower = deriveCompositionSignals({ role: 'borrower', sentiment: 'negative' }, null);
    expect(typeOnly('promise_defaulted')).toBe(true); // RED: the old rule marked the lender
    expect(countsAsAdverse('promise_defaulted', lender)).toBe(false);
    expect(countsAsAdverse('promise_defaulted', borrower)).toBe(true);
    expect(countsAsAdverse('promise_defaulted', null)).toBe(true); // a row naming no side is the defaulter's

    let l = emptyActorStats('l');
    l = applyActorStatsBump(l, bump({ actorId: 'l', actionType: 'promise_defaulted', family: 'promises', witnessClass: 'relay_verified', composition: lender }), T0);
    expect(l.adverse_by_type).toEqual({});
    expect(l.days[utcDayKey(T0)].adv).toBe(0);
    expect(l.days[utcDayKey(T0)].pd).toBe(0);
    let bo = emptyActorStats('b');
    bo = applyActorStatsBump(bo, bump({ actorId: 'b', actionType: 'promise_defaulted', family: 'promises', witnessClass: 'relay_verified', composition: borrower }), T0);
    expect(bo.adverse_by_type).toEqual({ promise_defaulted: 1 });
    expect(bo.days[utcDayKey(T0)].pd).toBe(1);
  });

  it('a bond abandonment is ONE event: the chain row counts, the relay mirror of the same burn does not', () => {
    let s = emptyActorStats('a');
    s = applyActorStatsBump(s, bump({ actionType: 'bond_abandonment_processed', family: 'bonds', witnessClass: 'relay_verified', composition: deriveCompositionSignals({ onchain_burn_confirmed: true }, null) }), T0);
    s = applyActorStatsBump(s, bump({ actionType: 'bond_abandoned', family: 'bonds', witnessClass: 'chain_witnessed', composition: deriveCompositionSignals({ ...watcherRow, institution: 'bond_pool' }, null) }), T0);
    expect(s.adverse_by_type).toEqual({ bond_abandoned: 1 });
    expect(s.days[utcDayKey(T0)].adv).toBe(1);
    expect(ADVERSE_STANDING_TYPES.has('bond_abandonment_processed')).toBe(false);
  });

  it('a chain-witnessed adverse type with no watcher evidence never counts (a relay or client row cannot stand in)', () => {
    for (const t of CHAIN_WITNESSED_ADVERSE_TYPES) {
      expect(countsAsAdverse(t, null)).toBe(false);
      expect(countsAsAdverse(t, deriveCompositionSignals({ standing: 'adverse' }, null))).toBe(false); // no canonical event id
      expect(countsAsAdverse(t, deriveCompositionSignals({ standing: 'positive', canonical_event_id: 'x' }, null))).toBe(false);
      expect(countsAsAdverse(t, deriveCompositionSignals(watcherRow, null))).toBe(true);
    }
  });

  it('the chain-witnessed set IS the Standing watcher\'s adverse set (one list, bound)', () => {
    const { STANDING_ADVERSE_ACTION_TYPES } = require('./institution-standing-watcher') as typeof import('./institution-standing-watcher');
    expect([...CHAIN_WITNESSED_ADVERSE_TYPES].sort()).toEqual([...STANDING_ADVERSE_ACTION_TYPES].sort());
    for (const t of CHAIN_WITNESSED_ADVERSE_TYPES) expect(ADVERSE_STANDING_TYPES.has(t)).toBe(true);
  });

  it('a pre- document: clean → an observed zero; holding an adverse type → unknown (null) and it stays null', () => {
    const clean = coerceActorStats('a', { schema_version: 'actor-stats/v2', history_complete: true, pe_count: 3, by_type: { coding_session: 3 } });
    expect(clean.adverse_by_type).toEqual({});
    const dirty = coerceActorStats('a', { schema_version: 'actor-stats/v2', history_complete: true, pe_count: 1, by_type: { court_verdict: 1 } });
    expect(hasAdverseTypeKey(dirty.by_type)).toBe(true);
    expect(dirty.adverse_by_type).toBeNull();
    const after = applyActorStatsBump(dirty, bump({ actionType: 'promise_defaulted', family: 'promises', witnessClass: 'relay_verified' }), T0);
    expect(after.adverse_by_type).toBeNull(); // never silently restarted from zero
    const written = coerceActorStats('a', { schema_version: 'actor-stats/v2', history_complete: true, by_type: { court_verdict: 2 }, adverse_by_type: { court_verdict: 1 } });
    expect(written.adverse_by_type).toEqual({ court_verdict: 1 });
  });
});


describe('protocol invariants', () => {
  const m = require('./actor-stats') as typeof import('./actor-stats');
  const { deriveCompositionSignals: derive, countsAsAdverse, ADVERSE_STANDING_TYPES, PRE_SPLIT_ADVERSE_TYPES } = m;
  const WATCHER = { standing: 'adverse', canonical_event_id: 'base:0xabc:1', institution: 'bond_pool' };
  const adverseOf = (type: string, md: Record<string, unknown> | null) => countsAsAdverse(type, md === null ? null : derive(md, null));

  it('a one-sided "broken" marks nobody (RED: before the ruling promise_broken was a Standing type)', () => {
    expect(PRE_SPLIT_ADVERSE_TYPES.has('promise_broken')).toBe(true); // what the old rule counted
    expect(ADVERSE_STANDING_TYPES.has('promise_broken')).toBe(false);
    expect(m.PROMISE_DEFAULTED_TYPES).toEqual(['promise_defaulted']);
    let s = emptyActorStats('tapper');
    s = applyActorStatsBump(s, bump({ actorId: 'tapper', actionType: 'promise_broken', family: 'promises', witnessClass: 'device_tier' }), T0);
    expect(s.by_type.promise_broken).toBe(1); // the PE is still a record on the tapper's chain
    expect(s.adverse_by_type).toEqual({});
    expect(s.days[utcDayKey(T0)].adv).toBe(0);
    expect(s.days[utcDayKey(T0)].pd).toBe(0);
  });

  it('a slash and the downgrade it causes are ONE adverse event; a downgrade on its own still counts', () => {
    const paired = { ...WATCHER, paired_bond_slash: true };
    expect(adverseOf('bond_slashed', WATCHER)).toBe(true);
    expect(adverseOf('bond_autonomy_downgraded', paired)).toBe(false);
    expect(adverseOf('bond_autonomy_downgraded', WATCHER)).toBe(true); // RED: the pair counted twice before
    // `paired_bond_slash` only ever removes the DOWNGRADE row of a watcher pair — never a slash.
    expect(adverseOf('bond_slashed', paired)).toBe(true);
    expect(adverseOf('bond_autonomy_downgraded', { paired_bond_slash: true })).toBe(false); // not a watcher row at all
    let s = emptyActorStats('a');
    s = applyActorStatsBump(s, bump({ actionType: 'bond_slashed', family: 'bonds', witnessClass: 'chain_witnessed', composition: derive(WATCHER, null) }), T0);
    s = applyActorStatsBump(s, bump({ actionType: 'bond_autonomy_downgraded', family: 'bonds', witnessClass: 'chain_witnessed', composition: derive(paired, null) }), T0);
    expect(s.adverse_by_type).toEqual({ bond_slashed: 1 });
    expect(s.days[utcDayKey(T0)].adv).toBe(1);
  });

  it('a: a hire dispute counts once, on the party the chain did not pay', () => {
    const row = (role: string, resolution: string, hire: boolean) => ({ escrow_id: 'e1', role, resolution, resolution_reason: 'dispute_timeout_refund', ...(hire ? { hire_job_id: 'hjob1' } : {}) });
    expect(adverseOf('escrow_resolved', row('recipient', 'refund_to_depositor', true))).toBe(true); // the hired party lost
    expect(adverseOf('escrow_resolved', row('depositor', 'refund_to_depositor', true))).toBe(false); // the payer won
    expect(adverseOf('escrow_resolved', row('depositor', 'release_to_recipient', true))).toBe(true); // admin paid the worker: the payer lost
    expect(adverseOf('escrow_resolved', row('recipient', 'release_to_recipient', true))).toBe(false);
    // RED: not a hire (no job id) → an ordinary record on both sides, as before the ruling.
    expect(adverseOf('escrow_resolved', row('recipient', 'refund_to_depositor', false))).toBe(false);
    expect(adverseOf('escrow_resolved', null)).toBe(false); // the chain watcher's row for the value receiver
  });

  it('b: an upheld Commons challenge counts once, on the challenged party', () => {
    const row = (role: string, status: string) => ({ challenge_id: 'c1', post_id: 'p1', role, status });
    expect(adverseOf('commons_challenge_resolved', row('challenged', 'upheld'))).toBe(true);
    expect(adverseOf('commons_challenge_resolved', row('challenger', 'upheld'))).toBe(false);
    expect(adverseOf('commons_challenge_resolved', row('challenged', 'answered'))).toBe(false);
    expect(adverseOf('commons_challenge_resolved', { challenge_id: 'c1', status: 'upheld' })).toBe(false); // a pre-ruling challenger row (no role)
  });

  it('the two new types are decided by the envelope, and a pre-split document holding them is NOT "unknown"', () => {
    expect(m.adverseDecisionNeedsEnvelope('escrow_resolved')).toBe(true);
    expect(m.adverseDecisionNeedsEnvelope('commons_challenge_resolved')).toBe(true);
    const doc = m.coerceActorStats('a', { schema_version: 'actor-stats/v2', history_complete: true, pe_count: 2, by_type: { escrow_resolved: 1, commons_challenge_resolved: 1 } });
    expect(doc.adverse_by_type).toEqual({}); // RED: null here would make every past dispute winner's vocabulary unavailable
    expect(m.coerceActorStats('a', { schema_version: 'actor-stats/v2', history_complete: true, by_type: { promise_broken: 1 } }).adverse_by_type).toBeNull();
  });

  it('a bump for a row the backfill fold already counted skips (by id, or by creation time below the floor)', () => {
    const folded = { ...emptyActorStats('a'), fold_floor_ms: 1000, fold_recent_pe_ids: ['pe_recent'] };
    expect(m.countedByFold(folded, { peId: 'pe_recent' })).toBe(true);
    expect(m.countedByFold(folded, { peId: 'pe_old', rowCreateTimeMs: 999 })).toBe(true);
    expect(m.countedByFold(folded, { peId: 'pe_new', rowCreateTimeMs: 1000 })).toBe(false);
    expect(m.countedByFold(folded, { peId: 'pe_live' })).toBe(false); // a seal-time bump of a new row
    expect(m.countedByFold(emptyActorStats('a'), { peId: 'pe_old', rowCreateTimeMs: 1 })).toBe(false); // never folded
    // The coverage survives a later live bump and a round-trip through storage.
    const after = applyActorStatsBump(folded, bump({ peId: 'pe_live' }), T0);
    const stored = m.coerceActorStats('a', m.serializeActorStats(after));
    expect(stored.fold_floor_ms).toBe(1000);
    expect(stored.fold_recent_pe_ids).toEqual(['pe_recent']);
  });
});

// =============================================================================
// Trust layer extension (2026-10-10) — attested ISSUER roots and distinct INBOUND PAYERS
// =============================================================================
describe('2026-10-10 attested issuer root — SEALED + ADMITTED, the pinned root fingerprint only', () => {
  const GCE_ROOT = '594759594b9b61524f6c8ef668f7177f7b9066bc0674f2f49fe9e052be78beb2';
  const admittedTpm = { admitted: true, scheme: 'tpm2_quote', reason: 'verified', region: 'us-central1', pcr_digest: 'sha256:' + 'cd'.repeat(32), issuer_root_fingerprint: GCE_ROOT.toUpperCase() };

  it('derives the issuer (lowercased) from the sealed admitted witness; a report without a root yields no issuer', () => {
    const c = deriveCompositionSignals({}, null, { witnessClass: 'device_tier', sealedHardwareWitness: admittedTpm })!;
    expect(c.hardwareIssuer).toBe(GCE_ROOT);
    expect(c.hardwareMeasurement).toBe('sha256:' + 'cd'.repeat(32));
    const { issuer_root_fingerprint: _drop, ...noRoot } = admittedTpm;
    expect(deriveCompositionSignals({}, null, { witnessClass: 'device_tier', sealedHardwareWitness: noRoot })!.hardwareIssuer).toBeNull();
    // RED: an unadmitted report, a client-declared fingerprint in metadata, a malformed fingerprint — nothing.
    expect(deriveCompositionSignals({}, null, { witnessClass: 'device_tier', sealedHardwareWitness: { ...admittedTpm, admitted: false } })).toBeNull();
    expect(deriveCompositionSignals({ hardware_witness: admittedTpm }, null, { witnessClass: 'device_tier' })).toBeNull();
    expect(issuerKey('not-a-fingerprint')).toBeNull();
    expect(issuerKey('zz'.repeat(32))).toBeNull();
  });

  it('the bump counts the issuer lifetime and per day under any witnessed lane class (RED: none without a root)', () => {
    const s = applyActorStatsBump(emptyActorStats('a'), bump({ witnessClass: 'device_tier', composition: comp({ hardwareIssuer: GCE_ROOT }) }), T0);
    expect(s.issuers).toEqual({ [GCE_ROOT]: 1 });
    expect(s.days[utcDayKey(T0)].is).toEqual({ [GCE_ROOT]: 1 });
    const none = applyActorStatsBump(emptyActorStats('a'), bump({ witnessClass: 'hardware_rooted', composition: comp({ hardwareMeasurement: SHA384 }) }), T0);
    expect(none.issuers).toEqual({});
    expect(none.days[utcDayKey(T0)].is).toEqual({});
  });
});

describe('2026-10-10 inbound payers — chain-witnessed receives the same-owner fence PASSED', () => {
  const PAYER_A = '0x' + 'a1'.repeat(20);
  const PAYER_B = '0x' + 'B2'.repeat(20);

  it('inboundPayerKey: a receive from an independent counterparty keys it (lowercased); same-owner, a send, or no address keys nothing', () => {
    expect(inboundPayerKey('receive', PAYER_B, true)).toBe(PAYER_B.toLowerCase());
    expect(inboundPayerKey('receive', PAYER_A, false)).toBeNull(); // the fence caught it (self / shared owner / unresolvable)
    expect(inboundPayerKey('send', PAYER_A, true)).toBeNull();
    expect(inboundPayerKey('x402_payment', PAYER_A, true)).toBeNull();
    expect(inboundPayerKey('receive', null, true)).toBeNull();
    expect(inboundPayerKey('receive', 'not an address', true)).toBeNull();
    expect(withInboundPayer(null, null)).toBeNull();
    expect(withInboundPayer(null, PAYER_A)!.inboundPayer).toBe(PAYER_A);
    expect(withInboundPayer(comp({ modelFamilies: ['claude'] }), PAYER_A)).toMatchObject({ modelFamilies: ['claude'], inboundPayer: PAYER_A });
  });

  it('the bump counts a payer under chain_witnessed only, distinct per address, lifetime and per day; inbound count per day', () => {
    let s = emptyActorStats('a');
    const receive = (payer: string | null, cls = 'chain_witnessed', ts = T0) =>
      bump({ actionType: 'receive', family: 'financial', witnessClass: cls, timestampMs: ts, composition: withInboundPayer(null, payer) });
    s = applyActorStatsBump(s, receive(PAYER_A), T0);
    s = applyActorStatsBump(s, receive(PAYER_A), T0);           // the same payer again: one distinct payer
    s = applyActorStatsBump(s, receive(PAYER_B.toLowerCase(), 'chain_witnessed', T0 - DAY), T0);
    s = applyActorStatsBump(s, receive(null), T0);               // the fence caught this one: inbound counts, no payer
    expect(s.payers).toEqual({ [PAYER_A]: 2, [PAYER_B.toLowerCase()]: 1 });
    expect(s.days[utcDayKey(T0)].py).toEqual({ [PAYER_A]: 2 });
    expect(s.days[utcDayKey(T0)].inb).toBe(3);
    expect(s.days[utcDayKey(T0 - DAY)].py).toEqual({ [PAYER_B.toLowerCase()]: 1 });
    // RED: a relay-verified row carrying a payer (a lane that is not the chain) counts no payer.
    const relay = applyActorStatsBump(emptyActorStats('a'), receive(PAYER_A, 'relay_verified'), T0);
    expect(relay.payers).toEqual({});
    expect(relay.days[utcDayKey(T0)].py).toEqual({});
    expect(relay.days[utcDayKey(T0)].inb).toBe(1); // still an inbound row (same rule as money.witnessed_inbound)
  });

  it('payer maps are bounded (lifetime wider than per day) and the day bucket round-trips its new members', () => {
    let s = emptyActorStats('a');
    for (let i = 0; i < ACTOR_STATS_MAX_PAYER_KEYS + 5; i++) {
      const payer = '0x' + i.toString(16).padStart(40, '0');
      s = applyActorStatsBump(s, bump({ actionType: 'receive', family: 'financial', witnessClass: 'chain_witnessed', composition: withInboundPayer(null, payer) }), T0);
    }
    expect(Object.keys(s.payers).length).toBe(ACTOR_STATS_MAX_PAYER_KEYS);
    expect(Object.keys(s.days[utcDayKey(T0)].py).length).toBe(ACTOR_STATS_MAX_DAY_PAYER_KEYS);
    const b = s.days[utcDayKey(T0)];
    const decoded = decodeDayBucket(encodeDayBucket(b))!;
    expect(decoded.inb).toBe(b.inb);
    expect(decoded.py).toEqual(b.py);
    expect(decoded.is).toEqual(b.is);
    // An encoded pre-extension bucket (no inb / is / py members) decodes to zeros, never fails.
    expect(decodeDayBucket('{"n":2,"fin":1}')).toMatchObject({ n: 2, fin: 1, inb: 0, is: {}, py: {} });
    const reread = coerceActorStats('a', serializeActorStats(s));
    expect(reread.payers).toEqual(s.payers);
    expect(reread.days[utcDayKey(T0)].py).toEqual(b.py);
  });
});
