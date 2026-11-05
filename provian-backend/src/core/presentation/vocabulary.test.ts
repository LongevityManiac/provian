/** Trust Layer build §2.5 / the vocabulary: live, identical shape, Standing always present,
 * fail closed, windows, shares, measurements, predicate-only volume, never-seen pattern keys. */
import {
  assembleVocabulary, computeActorVocabulary, isStandingField, STANDING_FIELD_PREFIX, VocabularyUnavailableError,
  DYNAMIC_FIELD_PATTERNS, isKnownVocabularyField, PREDICATE_ONLY_FIELDS, PAYMENT_VOLUME_FIELD, VOCABULARY_WINDOWS,
  WINDOWED_FACT_BASES, windowSuffix, shareBps, atomicUsdcToUsdNumber, selfViewOfVocabulary, VOCABULARY_FIELD_MAX_LENGTH,
} from './vocabulary';
import { applyReputationDisclosure, canonicalReputationDirective, normalizePredicateRequests, predicateMatchesRequest } from './disclosure';
import { missingStandingFields, STANDING_ALWAYS_PRESENT_FIELDS } from './vocabulary-fields';
import { buildPeSchema } from '../schema/pe-schema';
import {
  emptyActorStats, applyActorStatsBump, serializeActorStats, ACTOR_STATS_COLLECTION, ACTOR_STATS_SCHEMA_V1,
  ACTOR_STATS_MAX_TYPE_KEYS, VOCABULARY_NAMED_TYPES, ADVERSE_STANDING_TYPES, CHAIN_WITNESSED_ADVERSE_TYPES, withInboundPayer,
  type ActorStatsBump, type CompositionSignals,
} from '../pvt/actor-stats';
import { matchesDynamicFieldPattern } from './vocabulary-fields';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { ORIGIN_REFERENCE_GRAPH_COLLECTION, type OriginEdge } from '../pvt/origin-reference-graph';
import { COMMONS_PRESENTATIONS_COLLECTION } from './service';
import { RAIL_HANDSHAKE_INVALIDATIONS_COLLECTION } from '../rail/invalidation';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 16, 12);
const SHA = `sha384:${'ab'.repeat(48)}`;

function b(over: Partial<ActorStatsBump>): ActorStatsBump {
  return {
    actorId: 'alice', actionType: 'coding_session', family: 'agent', witnessClass: 'device_tier', timestampMs: T0,
    attestationTier: 'software', witnessObservedTokens: null, bodyDeclaredTokens: null,
    independentOriginCount: 1, approvalsCited: 0, composition: null, ...over,
  };
}
function comp(over: Partial<CompositionSignals>): CompositionSignals {
  return { modelFamilies: [], environmentClass: null, hardwareRegion: null, hardwareMeasurement: null, witnessedPaymentAtomic: null, supervisionHumanTurns: null, supervisionTotalTurns: null, ...over };
}

/** A chain-witnessed adverse type counts only on the Standing watcher's row — give it that row's facts. */
function chainFacts(type: string): CompositionSignals | null {
  if (type === 'escrow_resolved') return comp({ standingHireDisputeLost: true });
  if (type === 'commons_challenge_resolved') return comp({ standingChallengeUpheldAgainst: true });
  return CHAIN_WITNESSED_ADVERSE_TYPES.has(type) ? comp({ standingChainAdverse: true }) : null;
}

function statsWith(rows: Array<{ type: string; family: string; cls: string; tokens?: number }>) {
  let s = emptyActorStats('alice');
  for (const r of rows) {
    s = applyActorStatsBump(s, b({ actionType: r.type, family: r.family, witnessClass: r.cls, witnessObservedTokens: r.tokens ?? null, composition: chainFacts(r.type) }), T0);
  }
  return s;
}

const inEdge = (over: Partial<OriginEdge>): OriginEdge => ({
  // A SIGNED citation : the only kind that is Consumption.
  schema_version: 'origin-reference-graph/v1', signer: 'bob', owner: 'signer:alice', origin_identifier: `out:0x${'a'.repeat(40)}`,
  hash: 'sha256:x', witnessed: true, counted: false, pe_id: 'pe_B', recorded_at_ms: 1, scheme: 'out',
  reason: 'consumption_edge', ...over,
} as OriginEdge);

const base = {
  principal: { kind: 'agent' as const, walletId: 'w_a', peOwnerUserId: 'alice', address: '0xabc' },
  nowMs: T0,
  inEdges: [] as OriginEdge[],
  outEdges: { signer: 'alice', owners: new Map<string, boolean>(), totalEdges: 0 },
  registeredDevices: 0, bondActive: 0, openBondClaimsAgainst: 0, invalidationActive: 0,
  humanBeneficiary: 0, linkedAgents: 0, presentationsProduced: 0, presentationsRecent: 0,
  presentationsWindowed: { 30: 0, 90: 0, 365: 0 },
};

describe('assembleVocabulary', () => {
  it('RED (nonce-gap control): permissionless type spam past the by_type cap cannot hide a named fact', () => {
    let s = emptyActorStats('alice');
    for (let i = 0; i < ACTOR_STATS_MAX_TYPE_KEYS; i++) {
      s = applyActorStatsBump(s, b({ actionType: `spam_type_${i}`, family: 'agent', witnessClass: 'actor_declared' }), T0);
    }
    expect(Object.keys(s.by_type)).toHaveLength(ACTOR_STATS_MAX_TYPE_KEYS);
    // Every name the vocabulary reads is still counted, one bump each.
    for (const t of VOCABULARY_NAMED_TYPES) {
      s = applyActorStatsBump(s, b({ actionType: t, family: 'agent', witnessClass: 'relay_verified', composition: chainFacts(t) }), T0);
    }
    for (const t of VOCABULARY_NAMED_TYPES) expect(s.by_type[t]).toBe(1);
    // A further never-named type is still dropped (the cap keeps bounding spam).
    s = applyActorStatsBump(s, b({ actionType: 'spam_type_extra', family: 'agent', witnessClass: 'actor_declared' }), T0);
    expect(s.by_type.spam_type_extra).toBeUndefined();
    const v = assembleVocabulary({ ...base, stats: s });
    expect(v['standing.promises_defaulted']).toBe(1);
    expect(v['standing.court_verdicts_against']).toBe(1);
    expect(v['standing.adverse_events']).toBe(ADVERSE_STANDING_TYPES.size);
    expect(v['standing.adverse_events_30d']).toBe(ADVERSE_STANDING_TYPES.size);
    expect(v['money.escrows_completed_as_provider']).toBe(1);
    expect(v['accountability.human_approvals_given']).toBe(1);
  });

  it('identical shape for agents and humans; every value a number; standing.* always present even for an empty actor', () => {
    const agent = assembleVocabulary({ ...base, stats: emptyActorStats('alice') });
    const human = assembleVocabulary({ ...base, principal: { ...base.principal, kind: 'human' }, stats: emptyActorStats('alice') });
    expect(Object.keys(agent).sort()).toEqual(Object.keys(human).sort());
    for (const v of Object.values(agent)) expect(typeof v).toBe('number');
    const standing = Object.keys(agent).filter(isStandingField);
    expect(standing.length).toBeGreaterThanOrEqual(10);
    expect(agent['standing.adverse_events']).toBe(0);
    expect(agent['actor.is_agent']).toBe(1);
    expect(human['actor.is_agent']).toBe(0);
    // governance_score is GONE.
    expect(Object.keys(agent).some((k) => k.includes('governance'))).toBe(false);
    // close-out: every always-present Standing fact the verifier requires is materialized for
    // every actor (so a real presentation is never refused standing_withheld).
    expect(STANDING_ALWAYS_PRESENT_FIELDS.length).toBeGreaterThanOrEqual(7);
    expect(missingStandingFields(agent)).toEqual([]);
    expect(missingStandingFields(human)).toEqual([]);
    // The list IS the served schema's fixed Standing fields (the SDK mirror binds to the same snapshot).
    const standingGroup = (buildPeSchema() as unknown as { presentation: { vocabulary: { groups: { group: string; fields: string[] }[] } } })
      .presentation.vocabulary.groups.find((g) => g.group === 'standing');
    expect([...STANDING_ALWAYS_PRESENT_FIELDS].sort()).toEqual((standingGroup?.fields ?? []).filter((f) => !f.includes('<')).sort());
    // RED: the check is live — drop one and it is reported.
    const { ['standing.bond_active']: _dropped, ...withoutBond } = agent;
    expect(missingStandingFields(withoutBond)).toEqual(['standing.bond_active']);
  });

  it('Work splits by family × witness class (every class key present per family); witnessed compute sums only witnessed rows', () => {
    const stats = statsWith([
      { type: 'coding_session', family: 'agent', cls: 'device_tier', tokens: 50 },
      { type: 'coding_session', family: 'agent', cls: 'actor_declared', tokens: 999 },
      { type: 'human_approval', family: 'other', cls: 'hardware_rooted' },
      { type: 'send', family: 'wallet', cls: 'hardware_rooted' },
      { type: 'x402_payment', family: 'x402', cls: 'chain_witnessed' },
    ]);
    const v = assembleVocabulary({ ...base, stats });
    expect(v['work.agent.device_tier']).toBe(1);
    expect(v['work.agent.actor_declared']).toBe(1);
    expect(v['work.agent.hardware_rooted']).toBe(0);
    expect(v['work.x402.chain_witnessed']).toBe(1);
    expect(v['work.total']).toBe(5);
    expect(v['work.witnessed']).toBe(4);
    // Headline hardware-rooted aggregate across families.
    expect(v['work.hardware_rooted']).toBe(2);
    expect(v['work.witnessed_compute_tokens']).toBe(50);
    expect(v['money.witnessed_financial']).toBe(2);
  });

  it('money.witnessed_inbound counts receive rows only (RED: a send, a swap and an x402 payment add nothing; an unpaid actor reads an observed 0)', () => {
    const paid = statsWith([
      { type: 'receive', family: 'financial', cls: 'chain_witnessed' },
      { type: 'receive', family: 'financial', cls: 'chain_witnessed' },
      { type: 'send', family: 'financial', cls: 'chain_witnessed' },
      { type: 'swap', family: 'financial', cls: 'chain_witnessed' },
      { type: 'x402_payment', family: 'x402', cls: 'chain_witnessed' },
    ]);
    const v = assembleVocabulary({ ...base, stats: paid });
    expect(v['money.witnessed_inbound']).toBe(2);
    expect(v['money.witnessed_financial']).toBe(5);
    // RED control: the field is live — the same rows without the receives read 0, and so does an empty actor.
    const spentOnly = statsWith([
      { type: 'send', family: 'financial', cls: 'chain_witnessed' },
      { type: 'x402_payment', family: 'x402', cls: 'chain_witnessed' },
    ]);
    expect(assembleVocabulary({ ...base, stats: spentOnly })['money.witnessed_inbound']).toBe(0);
    expect(assembleVocabulary({ ...base, stats: emptyActorStats('alice') })['money.witnessed_inbound']).toBe(0);
    // The served schema names it beside the other money facts, so a gate can find it.
    const money = (buildPeSchema() as unknown as { presentation: { vocabulary: { groups: { group: string; fields: string[] }[] } } })
      .presentation.vocabulary.groups.find((g) => g.group === 'money');
    expect(money?.fields).toContain('money.witnessed_inbound');
    // And it is a named type: by_type spam past the cap cannot hide a receive.
    expect(VOCABULARY_NAMED_TYPES.has('receive')).toBe(true);
  });

  it('Standing counts adverse rows by type (chain-witnessed + relay), bond status, invalidation', () => {
    const stats = statsWith([
      { type: 'bond_slashed', family: 'other', cls: 'chain_witnessed' },
      { type: 'court_verdict', family: 'other', cls: 'chain_witnessed' },
      { type: 'promise_defaulted', family: 'promises', cls: 'relay_verified' },
      { type: 'bond_posted', family: 'other', cls: 'chain_witnessed' }, // NOT adverse
    ]);
    const v = assembleVocabulary({ ...base, stats, bondActive: 1, invalidationActive: 1, openBondClaimsAgainst: 2 });
    expect(v['standing.bond_slashed']).toBe(1);
    expect(v['standing.court_verdicts_against']).toBe(1);
    expect(v['standing.promises_defaulted']).toBe(1);
    expect(v['standing.adverse_events']).toBe(3);
    expect(v['standing.adverse_events_30d']).toBe(3); // the same set, windowed
    expect(v['standing.bond_active']).toBe(1);
    expect(v['standing.invalidation_active']).toBe(1);
    expect(v['standing.open_bond_claims_against']).toBe(2);
  });

  it('Standing and money.promises_defaulted read the rows that count AGAINST the actor, not every row of the type', () => {
    let s = emptyActorStats('alice');
    // alice WON a Court dispute (relay row, role), LENT on a promise that defaulted (role lender),
    // and has one real adverse event of her own (a default she made).
    s = applyActorStatsBump(s, b({ actionType: 'court_verdict', family: 'court', witnessClass: 'relay_verified', composition: comp({ standingRole: 'recipient' }) }), T0);
    s = applyActorStatsBump(s, b({ actionType: 'promise_defaulted', family: 'promises', witnessClass: 'relay_verified', composition: comp({ standingRole: 'lender' }) }), T0);
    s = applyActorStatsBump(s, b({ actionType: 'promise_defaulted', family: 'promises', witnessClass: 'relay_verified', composition: comp({ standingRole: 'borrower' }) }), T0);
    // RED: by_type — what Standing read before says 1 verdict and 2 defaults.
    expect(s.by_type.court_verdict).toBe(1);
    expect(s.by_type.promise_defaulted).toBe(2);
    const v = assembleVocabulary({ ...base, stats: s });
    expect(v['standing.court_verdicts_against']).toBe(0);
    expect(v['standing.promises_defaulted']).toBe(1);
    expect(v['money.promises_defaulted']).toBe(1);
    expect(v['standing.adverse_events']).toBe(1);
    expect(v['standing.adverse_events_30d']).toBe(1);
  });

  it('the two new Standing facts are served, add to the total, and a broken-promise record adds nothing', () => {
    let s = emptyActorStats('alice');
    s = applyActorStatsBump(s, b({ actionType: 'escrow_resolved', family: 'escrow', witnessClass: 'relay_verified', composition: comp({ standingHireDisputeLost: true }) }), T0);
    s = applyActorStatsBump(s, b({ actionType: 'escrow_resolved', family: 'escrow', witnessClass: 'chain_witnessed' }), T0); // a dispute she WON
    s = applyActorStatsBump(s, b({ actionType: 'commons_challenge_resolved', family: 'commons', witnessClass: 'relay_verified', composition: comp({ standingChallengeUpheldAgainst: true }) }), T0);
    s = applyActorStatsBump(s, b({ actionType: 'promise_broken', family: 'promises', witnessClass: 'device_tier' }), T0);
    const v = assembleVocabulary({ ...base, stats: s });
    expect(v['standing.hire_disputes_lost']).toBe(1);
    expect(v['standing.challenges_upheld_against']).toBe(1);
    expect(v['standing.promises_defaulted']).toBe(0);
    expect(v['money.promises_defaulted']).toBe(0);
    expect(v['standing.adverse_events']).toBe(2);
    expect(v['standing.adverse_events_30d']).toBe(2);
    // An actor with none of them still carries the facts, as observed zeros.
    const clean = assembleVocabulary({ ...base, stats: emptyActorStats('bob') });
    expect(clean['standing.hire_disputes_lost']).toBe(0);
    expect(clean['standing.challenges_upheld_against']).toBe(0);
  });

  it('Consumption from the reverse index (ring-flagged excluded); Accountability approvals: cited (agent) vs own approvals cited (human)', () => {
    const inEdges = [inEdge({ signer: 'bob' }), inEdge({ signer: 'carol', pe_id: 'pe_C' }), inEdge({ signer: 'mallory', closed_loop: true, reason: 'closed_loop' }),
      // A declared pe: citation of alice's approval: Accountability, but UNSIGNED — never Consumption.
      inEdge({ signer: 'dan', cited_action_type: 'human_approval', pe_id: 'pe_D', scheme: 'pe', origin_identifier: 'pe:pe_A' })];
    const stats = { ...emptyActorStats('alice'), approvals_cited: 4, by_type: { human_approval: 2 } };
    const agent = assembleVocabulary({ ...base, stats, inEdges });
    // RED: counting dan's unsigned pe: citation would make these 3.
    expect(agent['consumption.independent_parties']).toBe(2);
    expect(agent['consumption.edges']).toBe(2);
    expect(agent['consumption.ring_excluded']).toBe(1);
    expect(agent['accountability.human_approvals_cited']).toBe(4);
    expect(agent['accountability.human_approvals_given']).toBe(2);
    const human = assembleVocabulary({ ...base, principal: { ...base.principal, kind: 'human' }, stats, inEdges });
    expect(human['accountability.human_approvals_cited']).toBe(1);
  });

  it('Composition facets flatten with distinct counts; presentations produced only (no verified counter, §2.7)', () => {
    const stats = { ...emptyActorStats('alice'), pe_count: 4, models: { claude: 3, gpt: 1 }, environments: { container: 4 }, regions: { 'us-east': 1 }, measurements: { [SHA]: 2 } };
    const v = assembleVocabulary({ ...base, stats, presentationsProduced: 7, presentationsRecent: 2, presentationsWindowed: { 30: 2, 90: 5, 365: 7 } });
    expect(v['composition.model_families']).toBe(2);
    expect(v['composition.model.claude']).toBe(3);
    expect(v['composition.environment_classes']).toBe(1);
    expect(v['composition.attested_regions']).toBe(1);
    expect(v['composition.measurements']).toBe(1);
    expect(v[`composition.measurement.${SHA}`]).toBe(2);
    expect(`composition.measurement.${SHA}`.length).toBeLessThanOrEqual(VOCABULARY_FIELD_MAX_LENGTH);
    expect(v['presentations.produced']).toBe(7);
    expect(v['presentations.produced_recent']).toBe(2);
    expect(v['presentations.produced_90d']).toBe(5);
    expect(Object.keys(v).some((k) => k.includes('verified'))).toBe(false);
  });
});

describe(' windows (UTC-day granular, from the day buckets)', () => {
  // 3 PEs today, 1 at 29 days back (inside 30d), 1 at 30 days back (outside 30d, inside 90d),
  // 1 at 200 days back (inside 365d only).
  function windowedStats() {
    let s = emptyActorStats('alice');
    const add = (ageDays: number, over: Partial<ActorStatsBump> = {}) => {
      s = applyActorStatsBump(s, b({ timestampMs: T0 - ageDays * DAY, ...over }), T0);
    };
    add(0, { witnessClass: 'hardware_rooted', witnessObservedTokens: 10, composition: comp({ modelFamilies: ['claude'], hardwareRegion: 'us-east-1', hardwareMeasurement: SHA }) });
    add(0, { witnessClass: 'actor_declared', composition: comp({ modelFamilies: ['claude'] }) });
    add(0, { actionType: 'promise_defaulted', family: 'promises', witnessClass: 'relay_verified' });
    add(29, { actionType: 'receive', family: 'wallet', witnessClass: 'chain_witnessed', composition: comp({ witnessedPaymentAtomic: '1500000' }) });
    add(30, { actionType: 'court_verdict', family: 'other', witnessClass: 'chain_witnessed', composition: chainFacts('court_verdict') });
    add(200, { actionType: 'promise_fulfilled', family: 'promises', witnessClass: 'relay_verified', composition: comp({ modelFamilies: ['gpt'] }) });
    return s;
  }

  it('each windowed fact counts exactly the days inside its window (RED: the 30-day boundary excludes day 30)', () => {
    const v = assembleVocabulary({ ...base, stats: windowedStats() });
    expect(v['work.total']).toBe(6);
    expect(v['work.total_30d']).toBe(4);
    expect(v['work.total_90d']).toBe(5);
    expect(v['work.total_365d']).toBe(6);
    expect(v['work.witnessed_30d']).toBe(3);
    expect(v['work.hardware_rooted_30d']).toBe(1);
    expect(v['work.witnessed_compute_tokens_30d']).toBe(10);
    expect(v['continuity.active_days_30d']).toBe(2);
    expect(v['continuity.active_days_365d']).toBe(4);
    expect(v['money.witnessed_financial_30d']).toBe(1);
    expect(v['money.promises_defaulted_30d']).toBe(1);
    expect(v['money.promises_fulfilled_30d']).toBe(0);
    expect(v['money.promises_fulfilled_365d']).toBe(1);
    expect(v['money.promise_fulfillment_rate_bps_365d']).toBe(5000);
    expect(v['standing.adverse_events_30d']).toBe(1); // promise_defaulted today; court_verdict is day 30
    expect(v['standing.adverse_events_90d']).toBe(2);
    expect(v[`${PAYMENT_VOLUME_FIELD}_30d`]).toBe(1.5);
    expect(v[PAYMENT_VOLUME_FIELD]).toBe(1.5);
  });

  it('every window-suffixed base in the ONE list is materialized for every window (bound to WINDOWED_FACT_BASES)', () => {
    const v = assembleVocabulary({ ...base, stats: windowedStats() });
    let checked = 0;
    for (const baseField of WINDOWED_FACT_BASES) {
      for (const w of VOCABULARY_WINDOWS) {
        expect(Object.prototype.hasOwnProperty.call(v, `${baseField}${windowSuffix(w)}`)).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBe(WINDOWED_FACT_BASES.length * 3);
    expect(checked).toBeGreaterThanOrEqual(30);
  });

  it('share bps = floor(count×10000/total) per window; only occurred keys materialize; 0 total → 0', () => {
    const v = assembleVocabulary({ ...base, stats: windowedStats() });
    // lifetime: claude on 2 of 6 PEs → floor(3333.33) = 3333; gpt 1 of 6 → 1666.
    expect(v['share.model.claude']).toBe(3333);
    expect(v['share.model.gpt']).toBe(1666);
    // 30d: claude on 2 of 4 → 5000; gpt did not occur in 30d → not materialized.
    expect(v['share.model_30d.claude']).toBe(5000);
    expect(v['share.model_30d.gpt']).toBeUndefined();
    expect(v['share.witness_30d.hardware_rooted']).toBe(2500);
    expect(v['share.region.us-east-1']).toBe(1666);
    expect(v[`share.measurement_30d.${SHA}`]).toBe(2500);
    expect(`share.measurement_365d.${SHA}`.length).toBeLessThanOrEqual(VOCABULARY_FIELD_MAX_LENGTH);
    expect(shareBps(1, 3)).toBe(3333);
    expect(shareBps(2, 3)).toBe(6666); // floor, not round (RED: Math.round gives 6667)
    expect(shareBps(5, 0)).toBe(0);
    expect(shareBps(0, 5)).toBe(0);
  });

  it('USD from atomic USDC is exact (BigInt split), never a rounded float of the whole', () => {
    expect(atomicUsdcToUsdNumber('0')).toBe(0);
    expect(atomicUsdcToUsdNumber('1500000')).toBe(1.5);
    expect(atomicUsdcToUsdNumber('9007199254740993000000')).toBe(9007199254740993);
  });
});

describe(' item 5 — dynamic patterns: never-seen keys read 0; non-pattern fields refused', () => {
  const facts = assembleVocabulary({ ...base, stats: statsWith([{ type: 'coding_session', family: 'agent', cls: 'device_tier' }]) });

  it('the ONE pattern table recognizes every family of dynamic key the assembly materializes', () => {
    const s = applyActorStatsBump(emptyActorStats('alice'), b({ witnessClass: 'hardware_rooted', composition: comp({ modelFamilies: ['claude'], environmentClass: 'container', hardwareRegion: 'us-east-1', hardwareMeasurement: SHA }) }), T0);
    const v = assembleVocabulary({ ...base, stats: s });
    const dynamic = Object.keys(v).filter((k) => /^(work\.[^.]+\.|composition\.(model|env|region|measurement)\.|share\.)/.test(k));
    expect(dynamic.length).toBeGreaterThanOrEqual(15);
    for (const k of dynamic) expect(DYNAMIC_FIELD_PATTERNS.some((p) => p.regex.test(k))).toBe(true);
  });

  it('a pattern-valid never-seen key reads 0 and evaluates cleanly (work.git.hardware_rooted eq 0 → true)', () => {
    expect(facts['work.git.hardware_rooted']).toBeUndefined();
    expect(isKnownVocabularyField('work.git.hardware_rooted', facts)).toBe(true);
    const r = applyReputationDisclosure(facts, { redact: ['composition.model.mistral'], predicates: [
      { field: 'work.git.hardware_rooted', op: 'eq', threshold: 0 },
      { field: 'share.region_90d.eu-west-1', op: 'gte', threshold: 1 },
      { field: `composition.measurement.${SHA}`, op: 'in', set: [0] },
    ] });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.disclosure.predicates.map((p) => p.result)).toEqual([true, false, true]);
  });

  it('RED: a field matching no fixed name and no pattern is still refused (predicate and redact)', () => {
    for (const bad of ['work.git.hardware', 'work.git', 'share.planet.x', 'composition.model.', 'standing.never_heard_of', 'share.model_7d.claude', 'composition.measurement.sha384_has_underscore']) {
      expect(isKnownVocabularyField(bad, facts)).toBe(false);
      expect(applyReputationDisclosure(facts, { redact: [], predicates: [{ field: bad, op: 'gte', threshold: 0 }] })).toMatchObject({ ok: false });
      expect(applyReputationDisclosure(facts, { redact: [bad], predicates: [] })).toMatchObject({ ok: false });
    }
  });
});

describe(' predicate-only witnessed payment volume', () => {
  const stats = applyActorStatsBump(emptyActorStats('alice'), b({ actionType: 'receive', family: 'wallet', witnessClass: 'chain_witnessed', composition: comp({ witnessedPaymentAtomic: '2500000000' }) }), T0);
  const facts = assembleVocabulary({ ...base, stats });

  it('never emitted as a raw fact (default disclosure, with or without a predicate) and never in the owner self-view', () => {
    expect(facts[PAYMENT_VOLUME_FIELD]).toBe(2500);
    const full = applyReputationDisclosure(facts, { redact: [], predicates: [] });
    expect(full.ok).toBe(true);
    if (!full.ok) throw new Error('unreachable');
    for (const f of PREDICATE_ONLY_FIELDS) expect(full.disclosure.facts[f]).toBeUndefined();
    expect(PREDICATE_ONLY_FIELDS.size).toBe(4);
    const withPred = applyReputationDisclosure(facts, { redact: [], predicates: [{ field: PAYMENT_VOLUME_FIELD, op: 'gte', threshold: 1000 }] });
    expect(withPred.ok && withPred.disclosure.predicates[0].result).toBe(true);
    expect(withPred.ok && withPred.disclosure.facts[PAYMENT_VOLUME_FIELD]).toBeUndefined();
    const self = selfViewOfVocabulary(facts);
    expect(self.facts[PAYMENT_VOLUME_FIELD]).toBeUndefined();
    expect(self.predicate_only_fields).toContain(PAYMENT_VOLUME_FIELD);
  });

  it('RED: eq / in refused (an exact-match probe discloses); a second predicate on the same field refused (a ladder discloses)', () => {
    expect(applyReputationDisclosure(facts, { redact: [], predicates: [{ field: PAYMENT_VOLUME_FIELD, op: 'eq', threshold: 2500 }] })).toMatchObject({ ok: false, error: expect.stringMatching(/predicate-only/) });
    expect(applyReputationDisclosure(facts, { redact: [], predicates: [{ field: `${PAYMENT_VOLUME_FIELD}_30d`, op: 'in', set: [2500] }] })).toMatchObject({ ok: false, error: expect.stringMatching(/predicate-only/) });
    expect(applyReputationDisclosure(facts, { redact: [], predicates: [
      { field: PAYMENT_VOLUME_FIELD, op: 'gte', threshold: 1000 },
      { field: PAYMENT_VOLUME_FIELD, op: 'lt', threshold: 3000 },
    ] })).toMatchObject({ ok: false, error: expect.stringMatching(/at most one predicate/) });
    // One predicate per DIFFERENT volume field is fine.
    expect(applyReputationDisclosure(facts, { redact: [], predicates: [
      { field: PAYMENT_VOLUME_FIELD, op: 'gte', threshold: 1000 },
      { field: `${PAYMENT_VOLUME_FIELD}_30d`, op: 'gte', threshold: 1000 },
    ] }).ok).toBe(true);
  });
});

// =============================================================================
// Live computation — fail closed
// =============================================================================

function seededDb(): FakeFirestore {
  const db = createFakeFirestore();
  db.store.set(`${ACTOR_STATS_COLLECTION}/alice`, serializeActorStats(statsWith([{ type: 'coding_session', family: 'agent', cls: 'device_tier' }])));
  db.store.set(`${COMMONS_PRESENTATIONS_COLLECTION}/p1`, { wallet_id: 'w_a', recorded_at: T0 - 40 * DAY });
  db.store.set(`${COMMONS_PRESENTATIONS_COLLECTION}/p2`, { wallet_id: 'w_a', recorded_at: T0 - DAY });
  db.store.set('bonds/b1', { agent_wallet_id: 'w_a', status: 'active' });
  return db;
}

/** A Firestore whose reads of ONE collection fail (every other read goes to the fake). */
function failingOn(db: FakeFirestore, collection: string): FakeFirestore {
  const boom = () => { throw new Error(`${collection}_unavailable`); };
  const failingQuery: Record<string, unknown> = {};
  for (const m of ['where', 'orderBy', 'limit', 'select', 'startAfter']) failingQuery[m] = () => failingQuery;
  failingQuery.get = async () => boom();
  failingQuery.count = () => ({ get: async () => boom() });
  failingQuery.doc = () => ({ get: async () => boom() });
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'collection') return (name: string) => (name === collection ? failingQuery : target.collection(name));
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe('computeActorVocabulary (live; fail closed — item 2)', () => {
  it('reads actor_stats_v1 + the graph + counts through a Firestore', async () => {
    const v = await computeActorVocabulary({ db: seededDb() as never, nowMs: T0 }, base.principal);
    expect(v['continuity.chain_depth']).toBe(1);
    expect(v['work.agent.device_tier']).toBe(1);
    expect(v['standing.adverse_events']).toBe(0);
    expect(v['standing.bond_active']).toBe(1);
    expect(v['presentations.produced']).toBe(2);
    expect(v['presentations.produced_30d']).toBe(1);
    expect(v['presentations.produced_90d']).toBe(2);
  });

  it('a MISSING document is an observed zero, not an error', async () => {
    const empty = await computeActorVocabulary({ db: createFakeFirestore() as never, nowMs: T0 }, base.principal);
    expect(empty['continuity.chain_depth']).toBe(0);
    expect(empty['standing.adverse_events']).toBe(0);
    expect(empty['standing.bond_active']).toBe(0);
    expect(missingStandingFields(empty)).toEqual([]);
  });

  const sources: Array<[string, string]> = [
    [ACTOR_STATS_COLLECTION, 'actor_stats'],
    [ORIGIN_REFERENCE_GRAPH_COLLECTION, 'reference_graph'],
    [COMMONS_PRESENTATIONS_COLLECTION, 'presentations_produced'],
    [RAIL_HANDSHAKE_INVALIDATIONS_COLLECTION, 'invalidation_floor'],
    ['devices', 'registered_devices'],
    ['bonds', 'bonds'],
    ['bond_claims', 'bond_claims'],
    ['agent_wallets', 'agent_wallet'],
  ];
  it.each(sources)('RED: a failing read of %s throws VocabularyUnavailableError (never a zero)', async (collection, source) => {
    let caught: unknown = null;
    try {
      await computeActorVocabulary({ db: failingOn(seededDb(), collection) as never, nowMs: T0 }, base.principal);
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(VocabularyUnavailableError);
    expect((caught as VocabularyUnavailableError).source.startsWith(source)).toBe(true);
  });

  it('RED: the human principal\'s linked-agents count fails closed too', async () => {
    const human = { kind: 'human' as const, walletId: 'w_h', peOwnerUserId: 'alice', address: '0xh' };
    await expect(computeActorVocabulary({ db: failingOn(seededDb(), 'agent_wallets') as never, nowMs: T0 }, human)).rejects.toBeInstanceOf(VocabularyUnavailableError);
  });

  it('RED: a v1 stats document (history not yet backfilled) is unavailable — never read as zero history', async () => {
    const db = seededDb();
    db.store.set(`${ACTOR_STATS_COLLECTION}/alice`, { schema_version: ACTOR_STATS_SCHEMA_V1, actor_id: 'alice', pe_count: 9 });
    await expect(computeActorVocabulary({ db: db as never, nowMs: T0 }, base.principal)).rejects.toMatchObject({ source: 'actor_stats_history' });
  });

  it('RED : a pre-split document holding an adverse type is unavailable — its Standing is never served as a guess', async () => {
    const legacy = { schema_version: 'actor-stats/v2', actor_id: 'alice', history_complete: true, pe_count: 2 };
    const db = seededDb();
    db.store.set(`${ACTOR_STATS_COLLECTION}/alice`, { ...legacy, by_type: { court_verdict: 1, coding_session: 1 } });
    await expect(computeActorVocabulary({ db: db as never, nowMs: T0 }, base.principal)).rejects.toMatchObject({ source: 'actor_stats_standing' });
    // Positive twin: the same pre-split document with no adverse type is an observed zero and serves.
    db.store.set(`${ACTOR_STATS_COLLECTION}/alice`, { ...legacy, by_type: { coding_session: 2 } });
    const v = await computeActorVocabulary({ db: db as never, nowMs: T0 }, base.principal);
    expect(v['standing.adverse_events']).toBe(0);
  });
});

describe('disclosure over the vocabulary (§2.5/§2.6)', () => {
  const facts = { 'continuity.chain_depth': 120, 'standing.adverse_events': 1, 'standing.bond_active': 0, 'work.total': 120 };

  it('standing.* can be neither redacted nor withheld behind a predicate; other fields can', () => {
    expect(applyReputationDisclosure(facts, { redact: ['standing.adverse_events'], predicates: [] })).toMatchObject({ ok: false });
    const r = applyReputationDisclosure(facts, { redact: ['work.total'], predicates: [{ field: 'standing.adverse_events', op: 'eq', threshold: 0 }, { field: 'continuity.chain_depth', op: 'gte', threshold: 100 }] });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.disclosure.facts['standing.adverse_events']).toBe(1); // still disclosed
    expect(r.disclosure.facts['continuity.chain_depth']).toBeUndefined(); // withheld behind the predicate
    expect(r.disclosure.facts['work.total']).toBeUndefined(); // redacted
    expect(r.disclosure.predicates).toEqual([
      { field: 'standing.adverse_events', op: 'eq', threshold: 0, result: false },
      { field: 'continuity.chain_depth', op: 'gte', threshold: 100, result: true },
    ]);
  });

  it('set membership: `in` over a numeric set; canonical form sorts + dedupes; the parser fails closed', () => {
    const r = applyReputationDisclosure(facts, { redact: [], predicates: [{ field: 'standing.bond_active', op: 'in', set: [1, 0, 1] }] });
    expect(r.ok && r.disclosure.predicates[0]).toEqual({ field: 'standing.bond_active', op: 'in', set: [0, 1], result: true });
    const c = canonicalReputationDirective({ redact: ['b', 'a'], predicates: [{ field: 'z', op: 'in', set: [3, 1, 1] }, { field: 'a', op: 'lt', threshold: 2 }] });
    expect(c).toEqual({ redact: ['a', 'b'], predicates: [{ field: 'a', op: 'lt', threshold: 2 }, { field: 'z', op: 'in', set: [1, 3] }] });
    expect(normalizePredicateRequests([{ field: 'x', op: 'in', set: [1, 'a'] }])).toBeNull();
    expect(normalizePredicateRequests([{ field: 'x', op: 'between', threshold: 1 }])).toBeNull();
    expect(normalizePredicateRequests([{ field: 'x', op: 'gte' }])).toBeNull();
    expect(normalizePredicateRequests([{ field: 'x', op: 'gte', threshold: 1 }])).toEqual([{ field: 'x', op: 'gte', threshold: 1 }]);
    expect(predicateMatchesRequest({ field: 'x', op: 'in', set: [2, 1] }, { field: 'x', op: 'in', set: [1, 2, 2] })).toBe(true);
    expect(predicateMatchesRequest({ field: 'x', op: 'gte', threshold: 1 }, { field: 'x', op: 'gt', threshold: 1 })).toBe(false);
  });

  it('the standing prefix is the one the vocabulary uses', () => {
    expect(STANDING_FIELD_PREFIX).toBe('standing.');
    expect(isStandingField('standing.bond_active')).toBe(true);
    expect(isStandingField('work.total')).toBe(false);
  });
});

// =============================================================================
// Trust layer extension (2026-10-10): independent payers (windowed), inbound windows, issuer roots
// =============================================================================
describe('2026-10-10 money.independent_payers + money.witnessed_inbound windows', () => {
  const PAYER_A = '0x' + 'a1'.repeat(20);
  const PAYER_B = '0x' + 'b2'.repeat(20);
  function railStats() {
    let s = emptyActorStats('alice');
    const receive = (ageDays: number, payer: string | null) => {
      s = applyActorStatsBump(s, b({ actionType: 'receive', family: 'financial', witnessClass: 'chain_witnessed', timestampMs: T0 - ageDays * DAY, composition: withInboundPayer(null, payer) }), T0);
    };
    receive(0, PAYER_A);
    receive(1, PAYER_A);      // the same payer twice: still one party
    receive(40, PAYER_B);     // inside 90d, outside 30d
    receive(200, null);       // a receive the same-owner fence caught: inbound, no payer
    return s;
  }

  it('counts DISTINCT payers lifetime and per window; a repeat payer and a same-owner receive add no party', () => {
    const v = assembleVocabulary({ ...base, stats: railStats() });
    expect(v['money.witnessed_inbound']).toBe(4);
    expect(v['money.witnessed_inbound_30d']).toBe(2);
    expect(v['money.witnessed_inbound_90d']).toBe(3);
    expect(v['money.witnessed_inbound_365d']).toBe(4);
    expect(v['money.independent_payers']).toBe(2);
    expect(v['money.independent_payers_30d']).toBe(1);
    expect(v['money.independent_payers_90d']).toBe(2);
    expect(v['money.independent_payers_365d']).toBe(2);
    // RED (the single-operator case): three receives all from the operator's own wallets — every one
    // caught by the fence — read inbound 3, independent payers 0, in every window.
    let own = emptyActorStats('op');
    for (let i = 0; i < 3; i++) own = applyActorStatsBump(own, b({ actionType: 'receive', family: 'financial', witnessClass: 'chain_witnessed', composition: withInboundPayer(null, null) }), T0);
    const o = assembleVocabulary({ ...base, stats: own });
    expect(o['money.witnessed_inbound']).toBe(3);
    expect(o['money.independent_payers']).toBe(0);
    expect(o['money.independent_payers_90d']).toBe(0);
    // RED: a payer on a non-chain lane counts nothing.
    const relay = applyActorStatsBump(emptyActorStats('r'), b({ actionType: 'receive', family: 'financial', witnessClass: 'relay_verified', composition: withInboundPayer(null, PAYER_A) }), T0);
    expect(assembleVocabulary({ ...base, stats: relay })['money.independent_payers']).toBe(0);
    expect(assembleVocabulary({ ...base, stats: emptyActorStats('z') })['money.independent_payers']).toBe(0);
  });

  it('the served schema names both facts with their windows, and both are in the ONE windowed list', () => {
    const money = (buildPeSchema() as unknown as { presentation: { vocabulary: { groups: { group: string; fields: string[] }[] } } })
      .presentation.vocabulary.groups.find((g) => g.group === 'money')!;
    expect(money.fields).toContain('money.independent_payers');
    expect(money.fields).toContain('money.independent_payers_90d');
    expect(money.fields).toContain('money.witnessed_inbound_90d');
    expect(WINDOWED_FACT_BASES).toContain('money.independent_payers');
    expect(WINDOWED_FACT_BASES).toContain('money.witnessed_inbound');
  });
});

describe('2026-10-10 composition.issuer.<fingerprint> + share.issuer', () => {
  const GCE_ROOT = '594759594b9b61524f6c8ef668f7177f7b9066bc0674f2f49fe9e052be78beb2';
  const NITRO_ROOT = '641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b';

  it('counts attested issuers distinct + per root, shares lifetime and windowed; a never-seen root reads 0', () => {
    let s = emptyActorStats('alice');
    s = applyActorStatsBump(s, b({ witnessClass: 'hardware_rooted', composition: comp({ hardwareIssuer: GCE_ROOT, hardwareMeasurement: SHA }) }), T0);
    s = applyActorStatsBump(s, b({ witnessClass: 'device_tier', composition: comp({ hardwareIssuer: GCE_ROOT }) }), T0);
    s = applyActorStatsBump(s, b({ witnessClass: 'device_tier', timestampMs: T0 - 60 * DAY, composition: comp({ hardwareIssuer: NITRO_ROOT }) }), T0);
    s = applyActorStatsBump(s, b({ witnessClass: 'device_tier' }), T0);
    const v = assembleVocabulary({ ...base, stats: s });
    expect(v['composition.attested_issuers']).toBe(2);
    expect(v[`composition.issuer.${GCE_ROOT}`]).toBe(2);
    expect(v[`composition.issuer.${NITRO_ROOT}`]).toBe(1);
    expect(v[`share.issuer.${GCE_ROOT}`]).toBe(5000);
    expect(v[`share.issuer_30d.${GCE_ROOT}`]).toBe(6666);
    expect(v[`share.issuer_30d.${NITRO_ROOT}`]).toBeUndefined();
    expect(v[`share.issuer_90d.${NITRO_ROOT}`]).toBe(2500);
    // Pattern-valid, never seen → readable as 0; a malformed fingerprint is not a field.
    expect(matchesDynamicFieldPattern(`composition.issuer.${'0'.repeat(64)}`)).toBe(true);
    expect(matchesDynamicFieldPattern(`share.issuer_90d.${'0'.repeat(64)}`)).toBe(true);
    expect(isKnownVocabularyField(`composition.issuer.${'0'.repeat(64)}`, v)).toBe(true);
    expect(matchesDynamicFieldPattern('composition.issuer.not-a-root')).toBe(false);
    expect(matchesDynamicFieldPattern(`composition.issuer.${'0'.repeat(63)}`)).toBe(false);
    // The served schema lists the facet and the two patterns.
    const comp_ = (buildPeSchema() as unknown as { presentation: { vocabulary: { groups: { group: string; fields: string[] }[]; dynamic_patterns: { pattern: string }[] } } }).presentation.vocabulary;
    expect(comp_.groups.find((g) => g.group === 'composition')!.fields).toContain('composition.attested_issuers');
    expect(comp_.dynamic_patterns.map((p) => p.pattern)).toEqual(expect.arrayContaining(['composition.issuer.<fingerprint>', 'share.issuer[_<window>].<fingerprint>']));
    // RED: an empty actor has no issuer facts at all (only the distinct count, 0).
    const e = assembleVocabulary({ ...base, stats: emptyActorStats('e') });
    expect(e['composition.attested_issuers']).toBe(0);
    expect(Object.keys(e).filter((k) => k.startsWith('composition.issuer.'))).toEqual([]);
  });
});
