/**
 * Bug demotion of a single-lane metered act (its row on its batch's act page) — the
 * `transcript_rewitnessed_turn` detector and the page-home demotion.
 *
 * The proof rests only on records the relay sealed: the duplicate's sealed PE and turn id, and an
 * earlier witness that minted — a pre-meter PE whose stored content re-hashes and whose claim-ledger
 * row is bound to its identity, or an earlier metered act sealed eligible.
 *
 * RED controls in-suite (each refuses and nothing moves): a PE that does not hash to the sealed act,
 * call ids that are not the act's turn, no witness, a witness covering only part of the turn, an
 * edited legacy envelope, a legacy PE never claimed, a ledger row bound to another identity, a
 * witness from another device, a witness that is not earlier, a record-only (supplement) witness, a
 * witness that covers none of the calls, a repeated witness, a proxy-lane act, a wrong snapshot hash,
 * an unshipped detector, and a claim that has left `pending` (both before and inside the transaction).
 */
import { describe, it, expect } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import type { PEHistoryDocument } from '../../../pe-history';
import { createFakeFirestore, type FakeFirestore } from '../__test-helpers__/fake-firestore';
import { seedMeteredRows } from '../../meter/__test-helpers__/seed-act-keys';
import { computeRecordSnapshot, hashRecordEconomicSnapshot } from '../policy/monetary-accounting';
import { materializeProposedMonetaryPolicy } from '../policy/runtime-monetary-policy';
import { ECONOMIC_AGGREGATE_COLLECTION } from '../policy/economic-aggregate';
import { aggregateBatchClaims, pendingClaimIntact, type MeterActLeg } from '../../meter/meter-claims';
import { METER_BATCHES_COLLECTION, METER_PENDING_CLAIMS_COLLECTION, type MeterPendingClaim } from '../../meter/meter-store';
import { METER_BATCH_ACTS_COLLECTION, meterActPageId } from '../../meter/meter-act-pages';
import { peHashOf, type PeV2 } from '../../meter/meter-wire';
import { deviceSubmitPeContentFromStored, deviceSubmitPeHash } from '../../agent-wallet/device-submit-pe-hash';
import { deriveLegClaimId } from '../wp-ev/claim-id';
import { BUG_DEMOTION_COLLECTION, CLAIM_LEDGER_COLLECTION } from './durable-settlement-store';
import { DEMOTION_HOLD_FIELD, isDemotionHeld, openDemotionHold, renewDemotionHold } from '../../meter/meter-demotion-hold';
import { runMeterClaimInlet } from '../../meter/meter-settlement';
import { advancePayout, PAYOUT_REQUESTS_COLLECTION, readReadyWork, type PayoutDeps } from '../../payout/on-demand-payout';
import {
  demoteBugProducedMeterAct,
  demoteBugProducedMeterActs,
  responseIdOfCallId,
  transcriptRewitnessedTurnDetector,
  transcriptTurnIdOfCallIds,
} from './meter-act-bug-demotion';

const DAY = 86_400_000;
const T_SEAL = Date.UTC(2026, 9, 7, 18, 31, 17);
const BATCH = 'd'.repeat(64);
const BATCH0 = 'c'.repeat(64);
const DEVICE = 'dev_atlas_test';
const AGENT = '0x00000000000000000000000000000000000000aa';
const HUMAN = '0x00000000000000000000000000000000000000bb';
const POLICY = materializeProposedMonetaryPolicy(0);
const RESP_A = '5001080c-4981-9bb9-8858-48c0440ffac8';
const RESP_B = '52ad5cba-82a7-92e9-b934-d1795950241d';
/** The duplicate turn: one call from each of two model responses. */
const CALLS = [`call-1111-0|fc_${RESP_A}_0`, `call-2222-0|fc_${RESP_B}_0`];

function db(fake: FakeFirestore): Firestore {
  return fake as unknown as Firestore;
}

function transcriptPe(index: number, calls: readonly string[], at: number, source = 'transcript'): PeV2 {
  return {
    schema: 'provian.pe.v2',
    pe_id: `pe_client_${index}`,
    device_id: DEVICE,
    prev_hash: String(index).padStart(64, '0'),
    timestamp: at,
    action_type: 'agent_tool_orchestration',
    description: `agent turn — ${calls.length} tool calls (openclaw)`,
    metadata: {
      tool: 'provian-observer-transcript', source, harness: 'openclaw', container: 'sqlite',
      session_fingerprint: '0f4a385ac711386b', turn_index: index,
      turn_id: transcriptTurnIdOfCallIds(calls), tool_count: calls.length,
    },
  };
}

function rowFor(peId: string, at: number, status: 'eligible' | 'record_only' = 'eligible'): PEHistoryDocument {
  const s = computeRecordSnapshot(POLICY, {
    peId, economicActorId: 'atlas', actionType: 'agent_tool_orchestration', recordedAtMs: at,
    occurrenceOrdinal: 1, dailyOrdinal: 1, exactDuplicate: false, uniqueArtifact: true,
    attestationTier: 'software', linkageState: 'unlinked', evidenceState: 'verified',
    canonicalEventId: `agent_tool_orchestration:${peId}`, selfReferencing: false, sharedBeneficialOwnership: false,
    pairChurnDetected: false, sessionLineageId: null, genesisReservation: null,
  });
  return {
    peId, userId: 'atlas', actionType: s.actionType, timestamp: s.recordedAtMs, category: 'agent',
    mint_status: status, mint_disposition: status === 'eligible' ? s.mintDisposition : 'record_only', attestationDepth: 'software',
    corroboration_status: 'none', corroboration_received_at: null,
    economic_snapshot: s, economic_snapshot_hash: hashRecordEconomicSnapshot(s),
    record_points_atomic: s.recordPointsAtomic, beneficiary_wallet_id: null,
  } as unknown as PEHistoryDocument;
}

function legsOf(r: PEHistoryDocument): MeterActLeg[] {
  const total = BigInt(String(r.record_points_atomic));
  const agent = (total * 2_000n) / 10_000n;
  return [
    { leg: 'agent', contributor: AGENT, beneficiary_class: 1, bps: 2_000, points_atomic: agent.toString() },
    { leg: 'beneficiary', contributor: HUMAN, beneficiary_class: 1, bps: 8_000, points_atomic: (total - agent).toString() },
  ];
}

interface SeedPe { readonly pe: PeV2; readonly batch: string; readonly status?: 'eligible' | 'record_only' }
interface Seeded {
  readonly pes: PeV2[]; readonly ids: string[]; readonly rows: PEHistoryDocument[]; readonly claims: MeterPendingClaim[];
}

const relayIdOf = (pe: PeV2): string => `pe_m_${peHashOf(pe).slice(0, 48)}`;

/**
 * Committed single-lane acts on their batches' pages, as `meter-commit.ts` leaves them:
 *   0 — the duplicate (BATCH), 1 — another turn in the same batch (BATCH),
 *   2 — an earlier eligible act whose turn is the duplicate's second call (BATCH0),
 *   3 — an earlier record-only supplement of the same call (BATCH0).
 */
const HOLD_ID = 'hold_test';

async function seed(fake: FakeFirestore, options: { readonly hold?: boolean } = {}): Promise<Seeded> {
  const spec: SeedPe[] = [
    { pe: transcriptPe(1, CALLS, T_SEAL), batch: BATCH },
    { pe: transcriptPe(2, ['call-3333-0|fc_other_0'], T_SEAL + 1), batch: BATCH },
    { pe: transcriptPe(3, [CALLS[1]], T_SEAL - 5 * DAY), batch: BATCH0 },
    { pe: transcriptPe(4, [CALLS[1]], T_SEAL - 4 * DAY), batch: BATCH0, status: 'record_only' },
  ];
  const pes = spec.map((x) => x.pe);
  const ids = pes.map(relayIdOf);
  const rows = await seedMeteredRows(fake, spec.map((x, i) => rowFor(ids[i], x.pe.timestamp, x.status)), T_SEAL, { withActKeys: false });
  const claims: MeterPendingClaim[] = [];
  for (const batch of [BATCH, BATCH0]) {
    const acts: Record<string, unknown> = {};
    const members: number[] = [];
    spec.forEach((x, i) => {
      if (x.batch !== batch) return;
      members.push(i);
      acts[ids[i]] = {
        schema: 'provian.meter-act-key.v1', relay_pe_id: ids[i], client_pe_id: pes[i].pe_id, pe_hash: peHashOf(pes[i]),
        prev_hash: pes[i].prev_hash, device_id: DEVICE, batch_hash: batch, actor_id: 'atlas', timestamp: pes[i].timestamp,
        action_type: 'agent_tool_orchestration', row: rows[i], legs: legsOf(rows[i]), unit: 'batch', held_reason: null,
        created_at_ms: T_SEAL, beneficiary_id: null,
      };
    });
    fake.store.set(`${METER_BATCHES_COLLECTION}/${batch}`, { batch_hash: batch, act_pages: 1, device_id: DEVICE });
    fake.store.set(`${METER_BATCH_ACTS_COLLECTION}/${meterActPageId(batch, 0)}`, {
      schema: 'provian.meter-batch-acts.v1', batch_hash: batch, page: 0, actor_id: 'atlas', device_id: DEVICE, acts, act_count: members.length,
    });
    if (batch !== BATCH) continue;
    for (const c of aggregateBatchClaims({
      batch_hash: batch, device_id: DEVICE, actor_id: 'atlas', created_at_ms: T_SEAL,
      acts: members.map((i) => ({ relay_pe_id: ids[i], legs: legsOf(rows[i]) })),
    })) {
      // The run's demotion hold, as `demoteBugProducedMeterActs` opens it before the first demotion.
      const hold = options.hold === false ? {} : { [DEMOTION_HOLD_FIELD]: { hold_id: HOLD_ID, opened_at_ms: T_SEAL, expires_at_ms: T_SEAL + 1000 * DAY, reason: 'test' } };
      fake.store.set(`${METER_PENDING_CLAIMS_COLLECTION}/${c.claim_key}`, { ...c, ...hold });
      claims.push(c);
    }
  }
  return { pes, ids, rows, claims };
}

/** A pre-meter device PE (as the owner holds it after the hand-back), hashed by the writer's function. */
function legacyEnvelope(id: string, metadata: Record<string, unknown>, at = T_SEAL - 20 * DAY): Record<string, unknown> {
  const env: Record<string, unknown> = {
    id, wallet_id: 'wallet_aw_atlas', action_type: 'agent_tool_orchestration', actor_address: AGENT, timestamp: at,
    prev_hash: 'e'.repeat(64), attestation_type: 'software', description: 'openai grok-4.6 turn', intent_text: 'openai grok-4.6 turn',
    metadata: { source_device_id: DEVICE, ...metadata }, compute: null, geo: null, execution_env: null, cited_pe_ids: null,
    parent_goal_pe_id: null, user_id: 'atlas',
  };
  env.hash = deviceSubmitPeHash(deviceSubmitPeContentFromStored(env));
  return env;
}

/** The claim-ledger rows the pre-meter settlement wrote for it. */
function claimLegacy(fake: FakeFirestore, env: Record<string, unknown>, settled = true, extra: Record<string, unknown> = {}): void {
  for (const leg of ['agent', 'beneficiary'] as const) {
    const d = deriveLegClaimId(env as never, leg);
    if (d.kind !== 'derived') throw new Error('fixture');
    fake.store.set(`${CLAIM_LEDGER_COLLECTION}/${String(env.id)}#${leg}`, {
      pe_id: env.id, pe_key: env.id, claim_key: `${String(env.id)}#${leg}`, leg, claim_id: d.claimId, settled,
      ...(settled ? { settled_tx_hash: `0x${'5'.repeat(64)}`, settled_at: T_SEAL - 19 * DAY } : {}),
      ...extra,
    });
  }
}

const proxyLegacy = (fake: FakeFirestore, id: string, responseId: string, at?: number) => {
  const env = legacyEnvelope(id, { source: 'model_proxy', response_id: responseId, turn_id: transcriptTurnIdOfCallIds([`fc_${responseId}_0`]) }, at);
  claimLegacy(fake, env);
  return env;
};

const claimsIn = (fake: FakeFirestore): MeterPendingClaim[] => [...fake.store.entries()]
  .filter(([k]) => k.startsWith(`${METER_PENDING_CLAIMS_COLLECTION}/`)).map(([, v]) => v as unknown as MeterPendingClaim);
const pageAct = (fake: FakeFirestore, id: string, batch = BATCH) =>
  ((fake.store.get(`${METER_BATCH_ACTS_COLLECTION}/${meterActPageId(batch, 0)}`) as { acts: Record<string, { row: Record<string, unknown> }> }).acts[id]);
const aggregates = (fake: FakeFirestore): string => JSON.stringify([...fake.store.entries()]
  .filter(([k]) => k.startsWith(`${ECONOMIC_AGGREGATE_COLLECTION}/`)).map(([k, v]) => [k, (v as Record<string, unknown>).totals ?? v]));
const storeJson = (fake: FakeFirestore): string => JSON.stringify([...fake.store.entries()]);

function demote(fake: FakeFirestore, s: Seeded, evidence: unknown, overrides: Partial<Parameters<typeof demoteBugProducedMeterAct>[0]> = {}) {
  return demoteBugProducedMeterAct({
    db: db(fake),
    relayPeId: s.ids[0],
    batchHash: BATCH,
    detectorId: 'transcript_rewitnessed_turn',
    expectedSnapshotHash: String(s.rows[0].economic_snapshot_hash),
    evidence,
    execute: true,
    nowMs: T_SEAL + DAY,
    holdId: HOLD_ID,
    ...overrides,
  });
}

/** Both calls covered by two settled legacy proxy PEs, one per model response. */
function legacyEvidence(fake: FakeFirestore, s: Seeded): Record<string, unknown> {
  return {
    pe: s.pes[0], calls: CALLS,
    witnesses: [
      { kind: 'legacy_pe', envelope: proxyLegacy(fake, 'pe_legacy_a', RESP_A) },
      { kind: 'legacy_pe', envelope: proxyLegacy(fake, 'pe_legacy_b', RESP_B) },
    ],
  };
}

describe('transcript_rewitnessed_turn: the ids are the SDK\'s and the harness\'s', () => {
  it('matches the SDK\'s computeTurnId on a pinned vector (sorted, deduplicated, blanks dropped)', () => {
    expect(transcriptTurnIdOfCallIds(['call-b|fc_2', 'call-a|fc_1', 'call-a|fc_1', ' ']))
      .toBe('tc:2a777611834f4c42ba9bfbe330afc31583e2feb8906f95fa1fc3d87a2380988f');
    expect(transcriptTurnIdOfCallIds([' '])).toBeNull();
  });

  it('reads the model response an OpenClaw call id names, and nothing from any other shape', () => {
    expect(responseIdOfCallId(`call-9f-3|fc_${RESP_A}_12`)).toBe(RESP_A);
    expect(responseIdOfCallId(`fc_${RESP_A}_0`)).toBeNull();
    expect(responseIdOfCallId('call-1|toolu_01')).toBeNull();
    expect(responseIdOfCallId(`call-1|fc_${RESP_A}`)).toBeNull();
  });
});

describe('demoting a re-witnessed transcript turn sealed on a batch page', () => {
  it('proves by settled legacy witnesses, moves the act to record_only and takes its share out of every pending claim', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake);
    const ev = legacyEvidence(fake, s);
    const aggBefore = aggregates(fake);
    const out = await demote(fake, s, ev);
    expect(out.kind).toBe('demoted');
    expect(pageAct(fake, s.ids[0]).row.mint_status).toBe('record_only');
    expect(pageAct(fake, s.ids[0]).row.bug_detector_id).toBe('transcript_rewitnessed_turn');
    expect(pageAct(fake, s.ids[1]).row.mint_status).toBe('eligible');
    for (const c of claimsIn(fake)) {
      expect(c.state).toBe('pending');
      expect(c.acts.map((a) => a.relay_pe_id)).toEqual([s.ids[1]]);
      expect(pendingClaimIntact(c)).toBe(true);
    }
    expect(aggregates(fake)).not.toBe(aggBefore);
    const audit = fake.store.get(`${BUG_DEMOTION_COLLECTION}/${s.ids[0]}`) as Record<string, unknown>;
    expect(audit.state).toBe('complete');
    expect(audit.evidence).toMatchObject({
      witnesses: 'legacy:pe_legacy_a,legacy:pe_legacy_b', witness_count: 2, settled_legacy_witnesses: 2, call_count: 2,
    });
    // Idempotent: a second run reports the demotion it finds.
    expect((await demote(fake, s, ev)).kind).toBe('already_demoted');
  });

  it('proves by a legacy transcript witness whose sealed turn id binds a call window containing the turn', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake);
    const window = ['call-0000-0|fc_x_0', ...CALLS, 'call-4444-0|fc_y_0'];
    const env = legacyEnvelope('pe_legacy_t', { source: 'transcript', turn_id: transcriptTurnIdOfCallIds(window) });
    claimLegacy(fake, env);
    const out = await demote(fake, s, { pe: s.pes[0], calls: CALLS, witnesses: [{ kind: 'legacy_pe', envelope: env, calls: window }] });
    expect(out.kind).toBe('demoted');
    expect(out.kind === 'demoted' && out.proof.evidence.settled_legacy_witnesses).toBe(1);
  });

  it('proves through an earlier act this detector demoted (its own calls covered earlier still), and then that act cannot be demoted', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake);
    const page0 = fake.store.get(`${METER_BATCH_ACTS_COLLECTION}/${meterActPageId(BATCH0, 0)}`) as { acts: Record<string, { row: Record<string, unknown> }> };
    Object.assign(page0.acts[s.ids[2]].row, {
      mint_status: 'record_only', mint_disposition: 'record_only', bug_demotion_id: 'bug_demotion_x', bug_detector_id: 'transcript_rewitnessed_turn',
    });
    const out = await demote(fake, s, {
      pe: s.pes[0], calls: CALLS,
      witnesses: [
        { kind: 'legacy_pe', envelope: proxyLegacy(fake, 'pe_legacy_a', RESP_A) },
        { kind: 'meter_act', batch_hash: BATCH0, relay_pe_id: s.ids[2], pe: s.pes[2], calls: [CALLS[1]] },
      ],
    });
    expect(out.kind).toBe('demoted');
    const audit = fake.store.get(`${BUG_DEMOTION_COLLECTION}/${s.ids[0]}`) as Record<string, unknown>;
    expect(audit.witness_ids).toEqual(['legacy:pe_legacy_a', `meter:${s.ids[2]}`]);
  });

  it('RED: an act another demotion rests on is never demoted itself, and nothing moves', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake);
    const ev = legacyEvidence(fake, s);
    fake.store.set(`${BUG_DEMOTION_COLLECTION}/pe_m_other`, { demotion_id: 'bug_demotion_y', state: 'complete', witness_ids: [`meter:${s.ids[0]}`] });
    const before = storeJson(fake);
    expect(await demote(fake, s, ev)).toEqual({ kind: 'refused', reason: 'act_is_witness_of_a_demotion' });
    expect(storeJson(fake)).toBe(before);
  });

  it('proves by a legacy witness for one call and an earlier eligible metered act for the other', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake);
    const out = await demote(fake, s, {
      pe: s.pes[0], calls: CALLS,
      witnesses: [
        { kind: 'legacy_pe', envelope: proxyLegacy(fake, 'pe_legacy_a', RESP_A) },
        { kind: 'meter_act', batch_hash: BATCH0, relay_pe_id: s.ids[2], pe: s.pes[2], calls: [CALLS[1]] },
      ],
    });
    expect(out.kind).toBe('demoted');
    expect(pageAct(fake, s.ids[2], BATCH0).row.mint_status).toBe('eligible');
  });

  it('a dry run proves and writes nothing', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake);
    const ev = legacyEvidence(fake, s);
    const before = storeJson(fake);
    expect((await demote(fake, s, ev, { execute: false })).kind).toBe('dry_run_proved');
    expect(storeJson(fake)).toBe(before);
  });

  type Change = (fake: FakeFirestore, s: Seeded, ev: Record<string, unknown>) => { evidence?: unknown; overrides?: Partial<Parameters<typeof demoteBugProducedMeterAct>[0]> };
  const w = (ev: Record<string, unknown>) => ev.witnesses as Array<Record<string, unknown>>;
  const refusals: Array<[string, Change, string]> = [
    ['a PE that does not hash to the sealed act', (_f, s, ev) => ({ evidence: { ...ev, pe: { ...s.pes[0], description: 'edited' } } }), 'bug_not_proved'],
    ['call ids that are not the act\'s turn', (_f, _s, ev) => ({ evidence: { ...ev, calls: [CALLS[0]] } }), 'bug_not_proved'],
    ['no witness (a first witness, e.g. a resumed catch-up)', (_f, _s, ev) => ({ evidence: { ...ev, witnesses: [] } }), 'bug_not_proved'],
    ['a witness covering only part of the turn', (_f, _s, ev) => ({ evidence: { ...ev, witnesses: [w(ev)[0]] } }), 'bug_not_proved'],
    ['an edited legacy envelope', (_f, _s, ev) => ({
      evidence: { ...ev, witnesses: [{ kind: 'legacy_pe', envelope: { ...(w(ev)[0].envelope as object), description: 'x' } }, w(ev)[1]] },
    }), 'bug_not_proved'],
    ['a legacy witness whose claim never settled', (f, _s, ev) => {
      const env = legacyEnvelope('pe_unsettled', { source: 'model_proxy', response_id: RESP_B });
      claimLegacy(f, env, false);
      return { evidence: { ...ev, witnesses: [w(ev)[0], { kind: 'legacy_pe', envelope: env }] } };
    }, 'bug_not_proved'],
    ['a legacy witness whose claim a bug demotion stamped', (f, _s, ev) => {
      const env = legacyEnvelope('pe_demoted', { source: 'model_proxy', response_id: RESP_B });
      claimLegacy(f, env, true, { bug_demoted_at_ms: 1, bug_demotion_id: 'bug_demotion_z' });
      return { evidence: { ...ev, witnesses: [w(ev)[0], { kind: 'legacy_pe', envelope: env }] } };
    }, 'bug_not_proved'],
    ['a legacy witness of another owner', (f, _s, ev) => {
      const env = { ...legacyEnvelope('pe_other_owner', { source: 'model_proxy', response_id: RESP_B }), user_id: 'someone_else' };
      claimLegacy(f, env);
      return { evidence: { ...ev, witnesses: [w(ev)[0], { kind: 'legacy_pe', envelope: env }] } };
    }, 'bug_not_proved'],
    ['a metered witness of another actor', (f, s, ev) => {
      const page0 = f.store.get(`${METER_BATCH_ACTS_COLLECTION}/${meterActPageId(BATCH0, 0)}`) as { acts: Record<string, Record<string, unknown>> };
      page0.acts[s.ids[2]].actor_id = 'someone_else';
      return { evidence: { ...ev, witnesses: [w(ev)[0], { kind: 'meter_act', batch_hash: BATCH0, relay_pe_id: s.ids[2], pe: s.pes[2], calls: [CALLS[1]] }] } };
    }, 'bug_not_proved'],
    ['a metered witness another detector demoted', (f, s, ev) => {
      const page0 = f.store.get(`${METER_BATCH_ACTS_COLLECTION}/${meterActPageId(BATCH0, 0)}`) as { acts: Record<string, { row: Record<string, unknown> }> };
      Object.assign(page0.acts[s.ids[2]].row, { mint_status: 'record_only', mint_disposition: 'record_only', bug_demotion_id: 'bug_demotion_q', bug_detector_id: 'some_other_detector' });
      return { evidence: { ...ev, witnesses: [w(ev)[0], { kind: 'meter_act', batch_hash: BATCH0, relay_pe_id: s.ids[2], pe: s.pes[2], calls: [CALLS[1]] }] } };
    }, 'bug_not_proved'],
    ['a legacy PE the relay never claimed', (_f, _s, ev) => ({
      evidence: { ...ev, witnesses: [w(ev)[0], { kind: 'legacy_pe', envelope: legacyEnvelope('pe_unclaimed', { source: 'model_proxy', response_id: RESP_B }) }] },
    }), 'bug_not_proved'],
    ['a ledger row bound to another identity', (f, _s, ev) => {
      f.store.set(`${CLAIM_LEDGER_COLLECTION}/pe_legacy_b#agent`, { ...(f.store.get(`${CLAIM_LEDGER_COLLECTION}/pe_legacy_b#agent`) as object), claim_id: `0x${'1'.repeat(64)}` });
      f.store.set(`${CLAIM_LEDGER_COLLECTION}/pe_legacy_b#beneficiary`, { ...(f.store.get(`${CLAIM_LEDGER_COLLECTION}/pe_legacy_b#beneficiary`) as object), claim_id: `0x${'2'.repeat(64)}` });
      return { evidence: ev };
    }, 'bug_not_proved'],
    ['a legacy witness from another device', (f, _s, ev) => {
      const env = legacyEnvelope('pe_other_dev', { source: 'model_proxy', response_id: RESP_B, source_device_id: 'dev_other' });
      claimLegacy(f, env);
      return { evidence: { ...ev, witnesses: [w(ev)[0], { kind: 'legacy_pe', envelope: env }] } };
    }, 'bug_not_proved'],
    ['a legacy witness that is not earlier', (f, _s, ev) => ({
      evidence: { ...ev, witnesses: [w(ev)[0], { kind: 'legacy_pe', envelope: proxyLegacy(f, 'pe_late', RESP_B, T_SEAL) }] },
    }), 'bug_not_proved'],
    ['a record-only (supplement) metered witness', (_f, s, ev) => ({
      evidence: { ...ev, witnesses: [w(ev)[0], { kind: 'meter_act', batch_hash: BATCH0, relay_pe_id: s.ids[3], pe: s.pes[3], calls: [CALLS[1]] }] },
    }), 'bug_not_proved'],
    ['the act witnessing itself (a metered witness that is not earlier)', (_f, s, ev) => ({
      evidence: { ...ev, witnesses: [{ kind: 'meter_act', batch_hash: BATCH, relay_pe_id: s.ids[0], pe: s.pes[0], calls: CALLS }] },
    }), 'bug_not_proved'],
    ['a witness that covers none of the calls', (f, _s, ev) => ({
      evidence: { ...ev, witnesses: [...w(ev), { kind: 'legacy_pe', envelope: proxyLegacy(f, 'pe_unrelated', 'ffffffff-0000-0000-0000-000000000000') }] },
    }), 'bug_not_proved'],
    ['a repeated witness', (_f, _s, ev) => ({ evidence: { ...ev, witnesses: [...w(ev), w(ev)[0]] } }), 'bug_not_proved'],
    ['a wrong snapshot hash', (_f, _s, ev) => ({ evidence: ev, overrides: { expectedSnapshotHash: 'sha256:wrong' } }), 'snapshot_hash_mismatch'],
    ['an unshipped detector', (_f, _s, ev) => ({ evidence: ev, overrides: { detectorId: 'transcript_reread_turn' } }), 'unknown_or_unshipped_bug_detector'],
  ];
  for (const [name, change, reason] of refusals) {
    it(`RED: ${name} is refused and nothing moves`, async () => {
      const fake = createFakeFirestore();
      const s = await seed(fake);
      const ev = legacyEvidence(fake, s);
      const c = change(fake, s, ev);
      const before = storeJson(fake);
      const out = await demote(fake, s, c.evidence ?? ev, c.overrides ?? {});
      expect(out).toEqual({ kind: 'refused', reason });
      expect(storeJson(fake)).toBe(before);
    });
  }

  it('RED: a proxy-lane act is not this bug (the detector proves nothing)', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake);
    const ev = legacyEvidence(fake, s);
    const ctx = {
      readMeterAct: async () => null,
      readClaimLedger: async (k: string) => (fake.store.get(`${CLAIM_LEDGER_COLLECTION}/${k}`) as Record<string, unknown> | undefined) ?? null,
    };
    const proxyPe = transcriptPe(1, CALLS, T_SEAL, 'model_proxy');
    const act = (pe: PeV2) => ({ action_type: 'agent_tool_orchestration', pe_hash: peHashOf(pe), device_id: DEVICE, actor_id: 'atlas', timestamp: pe.timestamp }) as never;
    expect(await transcriptRewitnessedTurnDetector.prove({ act: act(proxyPe), evidence: { ...ev, pe: proxyPe }, ctx })).toBeNull();
    expect(await transcriptRewitnessedTurnDetector.prove({ act: act(s.pes[0]), evidence: ev, ctx })).not.toBeNull();
  });

  it('RED: once a claim carrying the act has left pending, the demotion is refused and nothing moves', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake);
    const ev = legacyEvidence(fake, s);
    const key = `${METER_PENDING_CLAIMS_COLLECTION}/${s.claims[0].claim_key}`;
    fake.store.set(key, { ...(fake.store.get(key) as Record<string, unknown>), state: 'registered' });
    const before = storeJson(fake);
    expect(await demote(fake, s, ev)).toEqual({ kind: 'refused', reason: 'claim_not_pending:registered' });
    expect(storeJson(fake)).toBe(before);
  });

  it('RED: a claim that leaves pending after the pre-check is caught inside the transaction, and no audit is left applying', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake);
    const ev = legacyEvidence(fake, s);
    const key = `${METER_PENDING_CLAIMS_COLLECTION}/${s.claims[0].claim_key}`;
    const run = fake.runTransaction.bind(fake);
    let calls = 0;
    fake.runTransaction = (async (fn: never) => {
      const out = await run(fn);
      calls += 1;
      if (calls === 1) fake.store.set(key, { ...(fake.store.get(key) as Record<string, unknown>), state: 'registered' });
      return out;
    }) as typeof fake.runTransaction;
    const before = storeJson(fake);
    expect(await demote(fake, s, ev)).toEqual({ kind: 'refused', reason: 'act_mutation_precondition_failed' });
    expect(fake.store.has(`${BUG_DEMOTION_COLLECTION}/${s.ids[0]}`)).toBe(false);
    fake.store.set(key, { ...(fake.store.get(key) as Record<string, unknown>), state: 'pending' });
    expect(storeJson(fake)).toBe(before);
    // With the claim pending again, the same proof demotes (no stale audit refuses it).
    fake.runTransaction = run;
    expect((await demote(fake, s, ev)).kind).toBe('demoted');
  });

  it('a concurrent run of the same proof that applied first keeps its audit (the loser neither deletes it nor strips it)', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake);
    const ev = legacyEvidence(fake, s);
    const ref = `${BUG_DEMOTION_COLLECTION}/${s.ids[0]}`;
    const run = fake.runTransaction.bind(fake);
    let calls = 0;
    fake.runTransaction = (async (fn: never) => {
      const out = await run(fn);
      calls += 1;
      if (calls === 1) {
        // The other run's mutation lands between this run's audit open and its own mutation.
        const id = (fake.store.get(ref) as Record<string, unknown>).demotion_id;
        Object.assign(pageAct(fake, s.ids[0]).row, { mint_status: 'record_only', mint_disposition: 'record_only', bug_demotion_id: id });
      }
      return out;
    }) as typeof fake.runTransaction;
    const out = await demote(fake, s, ev);
    expect(out.kind).toBe('already_demoted');
    const audit = fake.store.get(ref) as Record<string, unknown>;
    expect(audit.state).toBe('complete');
    expect(audit.detector_id).toBe('transcript_rewitnessed_turn');
    expect(audit.proof_digest).toEqual(expect.any(String));
    expect(audit.witness_ids).toEqual(['legacy:pe_legacy_a', 'legacy:pe_legacy_b']);
  });

  it('a run that died between the demotion and the audit\'s completion is completed by the next run', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake);
    const ev = legacyEvidence(fake, s);
    expect((await demote(fake, s, ev)).kind).toBe('demoted');
    const ref = `${BUG_DEMOTION_COLLECTION}/${s.ids[0]}`;
    fake.store.set(ref, { ...(fake.store.get(ref) as Record<string, unknown>), state: 'applying', completed_at_ms: null });
    expect((await demote(fake, s, ev)).kind).toBe('already_demoted');
    expect((fake.store.get(ref) as Record<string, unknown>).state).toBe('complete');
  });
});

describe('the demotion hold: a batch with demotions in flight cannot settle', () => {
  const claimKeysOf = (s: Seeded) => s.claims.map((c) => c.claim_key);
  const claimAt = (fake: FakeFirestore, key: string) => fake.store.get(`${METER_PENDING_CLAIMS_COLLECTION}/${key}`) as Record<string, unknown>;
  const AFTER_READY = T_SEAL + 400 * DAY;

  it('RED: a demotion with no live hold of its own run is refused and nothing moves (no hold, another run\'s, expired)', async () => {
    for (const overrides of [{ holdId: undefined }, { holdId: 'hold_other' }, { nowMs: T_SEAL + 1001 * DAY }]) {
      const fake = createFakeFirestore();
      const s = await seed(fake);
      const ev = legacyEvidence(fake, s);
      const before = storeJson(fake);
      expect(await demote(fake, s, ev, overrides)).toEqual({ kind: 'refused', reason: 'no_live_demotion_hold' });
      expect(storeJson(fake)).toBe(before);
    }
  });

  it('settlement leaves held claims pending — and, the control, takes them once the hold is gone', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake);
    const held = await runMeterClaimInlet(db(fake), { nowMs: AFTER_READY });
    expect(held.held).toBe(s.claims.length);
    expect(held.aggregated).toBe(0);
    for (const k of claimKeysOf(s)) expect(claimAt(fake, k).state).toBe('pending');
    for (const k of claimKeysOf(s)) claimAt(fake, k)[DEMOTION_HOLD_FIELD] = null;
    const free = await runMeterClaimInlet(db(fake), { nowMs: AFTER_READY });
    expect(free.held).toBe(0);
    expect(free.aggregated).toBe(s.claims.length);
    for (const k of claimKeysOf(s)) expect(claimAt(fake, k).state).not.toBe('pending');
  });

  it('a hold opened after settlement scanned the claims fails the take: the claims stay pending', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake, { hold: false });
    const realBatch = fake.batch.bind(fake);
    let opened = false;
    fake.batch = (() => {
      const b = realBatch();
      const commit = b.commit.bind(b);
      b.commit = (async () => {
        if (!opened) {
          opened = true;
          const r = await openDemotionHold(db(fake), { claimKeys: claimKeysOf(s), holdId: HOLD_ID, reason: 'test', nowMs: AFTER_READY });
          expect(r.kind).toBe('opened');
        }
        return commit();
      }) as typeof b.commit;
      return b;
    }) as typeof fake.batch;
    const report = await runMeterClaimInlet(db(fake), { nowMs: AFTER_READY });
    expect(report.aggregated).toBe(0);
    expect(report.rejected.map((r) => r.reason)).toContain('payout_members_changed');
    for (const k of claimKeysOf(s)) expect(claimAt(fake, k).state).toBe('pending');
  });

  it('an on-demand payout does not count held claims as ready work', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake);
    const heldWork = await readReadyWork(db(fake), HUMAN, AFTER_READY);
    for (const k of claimKeysOf(s)) claimAt(fake, k)[DEMOTION_HOLD_FIELD] = null;
    const freeWork = await readReadyWork(db(fake), HUMAN, AFTER_READY);
    expect(heldWork.pointsAtomic).toBe(0n);
    expect(freeWork.pointsAtomic).toBeGreaterThan(0n);
  });

  it('a malformed hold field holds the claim (unknown = block); null, absent and expired do not', () => {
    expect(isDemotionHeld({ [DEMOTION_HOLD_FIELD]: { hold_id: 'x' } }, 0)).toBe(true);
    expect(isDemotionHeld({ [DEMOTION_HOLD_FIELD]: 'yes' }, 0)).toBe(true);
    expect(isDemotionHeld({ [DEMOTION_HOLD_FIELD]: null }, 0)).toBe(false);
    expect(isDemotionHeld({}, 0)).toBe(false);
    expect(isDemotionHeld({ [DEMOTION_HOLD_FIELD]: { hold_id: 'x', opened_at_ms: 0, expires_at_ms: 10, reason: 'r' } }, 10)).toBe(false);
    expect(isDemotionHeld({ [DEMOTION_HOLD_FIELD]: { hold_id: 'x', opened_at_ms: 0, expires_at_ms: 10, reason: 'r' } }, 9)).toBe(true);
  });

  it('a manifest run holds every claim for the whole run, demotes, then releases its hold', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake, { hold: false });
    const ev = legacyEvidence(fake, s);
    const seen: Array<boolean> = [];
    const out = await demoteBugProducedMeterActs({
      db: db(fake), execute: true, holdId: 'hold_run', nowMs: () => T_SEAL + DAY,
      entries: [{ relay_pe_id: s.ids[0], batch_hash: BATCH, detector: 'transcript_rewitnessed_turn', expected_snapshot_hash: String(s.rows[0].economic_snapshot_hash), evidence: ev }],
      onResult: () => { seen.push(claimKeysOf(s).every((k) => isDemotionHeld(claimAt(fake, k), T_SEAL + DAY))); },
    });
    expect(out.kind).toBe('ran');
    expect(out.kind === 'ran' && out.results[0].kind).toBe('demoted');
    expect(seen).toEqual([true]);
    for (const k of claimKeysOf(s)) expect(isDemotionHeld(claimAt(fake, k), T_SEAL + DAY)).toBe(false);
  });

  it('RED: a hold lost after the pre-check is caught where the act\'s share is withdrawn: nothing moves, no audit is left', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake);
    const ev = legacyEvidence(fake, s);
    const realTxn = fake.runTransaction.bind(fake);
    let first = true;
    fake.runTransaction = (async (fn: Parameters<typeof realTxn>[0]) => {
      if (first) {
        first = false;
        // Between the pre-check and the mutation, the run's hold gives way to another run's.
        for (const k of claimKeysOf(s)) claimAt(fake, k)[DEMOTION_HOLD_FIELD] = { hold_id: 'hold_other', opened_at_ms: T_SEAL, expires_at_ms: T_SEAL + 1000 * DAY, reason: 'r' };
      }
      return realTxn(fn);
    }) as typeof fake.runTransaction;
    const out = await demote(fake, s, ev);
    expect(out).toEqual({ kind: 'refused', reason: 'act_mutation_precondition_failed' });
    expect((pageAct(fake, s.ids[0]) as { row: { mint_status: string } }).row.mint_status).toBe('eligible');
    for (const c of s.claims) expect(claimAt(fake, c.claim_key).members).toEqual(c.members);
    expect([...fake.store.keys()].filter((k) => k.startsWith(`${BUG_DEMOTION_COLLECTION}/`))).toEqual([]);
  });

  it('a run longer than its hold\'s term keeps the hold: renewed before it lapses, so the act is still demoted under it', async () => {
    const fake = createFakeFirestore();
    const s = await seed(fake, { hold: false });
    const ev = legacyEvidence(fake, s);
    let t = T_SEAL + DAY;
    const MIN = 60_000;
    // The clock reads 10 minutes later each time (once to open, once per entry): six refused entries
    // first, so the provable act is reached 70 minutes in — past the 1-hour hold's first term.
    const clock = () => { const v = t; t += 10 * MIN; return v; };
    const entry = (i: number) => ({ relay_pe_id: s.ids[i], batch_hash: BATCH, detector: 'transcript_rewitnessed_turn', expected_snapshot_hash: String(s.rows[i].economic_snapshot_hash), evidence: ev });
    const out = await demoteBugProducedMeterActs({
      db: db(fake), execute: true, holdId: 'hold_run', nowMs: clock, holdTtlMs: 60 * MIN,
      entries: [1, 1, 1, 1, 1, 1, 0].map(entry),
    });
    expect(out.kind === 'ran' && out.results.slice(0, 6).every((r) => r.kind === 'refused')).toBe(true);
    expect(out.kind === 'ran' && out.results[6].kind).toBe('demoted');
  });

  it('RED: renewal extends only claims still carrying this run\'s live hold — never one another run now holds, or one it lost', async () => {
    const fake = createFakeFirestore();
    const mine = { hold_id: 'hold_a', opened_at_ms: T_SEAL, expires_at_ms: T_SEAL + 100, reason: 'r' };
    const other = { hold_id: 'hold_b', opened_at_ms: T_SEAL + 60, expires_at_ms: T_SEAL + 10_000, reason: 'r' };
    fake.store.set(`${METER_PENDING_CLAIMS_COLLECTION}/k_mine`, { claim_key: 'k_mine', state: 'pending', [DEMOTION_HOLD_FIELD]: mine });
    fake.store.set(`${METER_PENDING_CLAIMS_COLLECTION}/k_other`, { claim_key: 'k_other', state: 'pending', [DEMOTION_HOLD_FIELD]: other });
    fake.store.set(`${METER_PENDING_CLAIMS_COLLECTION}/k_expired`, { claim_key: 'k_expired', state: 'pending', [DEMOTION_HOLD_FIELD]: { ...mine, expires_at_ms: T_SEAL + 10 } });
    fake.store.set(`${METER_PENDING_CLAIMS_COLLECTION}/k_taken`, { claim_key: 'k_taken', state: 'aggregated', [DEMOTION_HOLD_FIELD]: mine });
    const out = await renewDemotionHold(db(fake), { claimKeys: ['k_mine', 'k_other', 'k_expired', 'k_taken'], holdId: 'hold_a', nowMs: T_SEAL + 50, ttlMs: 1000 });
    expect(out.renewed).toBe(1);
    expect([...out.lost].sort()).toEqual(['k_expired', 'k_other', 'k_taken']);
    expect((claimAt(fake, 'k_mine')[DEMOTION_HOLD_FIELD] as { expires_at_ms: number }).expires_at_ms).toBe(T_SEAL + 1050);
    expect(claimAt(fake, 'k_other')[DEMOTION_HOLD_FIELD]).toEqual(other);
    expect((claimAt(fake, 'k_expired')[DEMOTION_HOLD_FIELD] as { expires_at_ms: number }).expires_at_ms).toBe(T_SEAL + 10);
  });

  it('RED: a hold refused in a later chunk releases every claim the earlier chunks held', async () => {
    const fake = createFakeFirestore();
    const keys = Array.from({ length: 401 }, (_, i) => `mc_hold_${String(i).padStart(4, '0')}`);
    for (const k of keys) fake.store.set(`${METER_PENDING_CLAIMS_COLLECTION}/${k}`, { claim_key: k, state: 'pending' });
    fake.store.set(`${METER_PENDING_CLAIMS_COLLECTION}/${keys[400]}`, { claim_key: keys[400], state: 'aggregated' });
    const out = await openDemotionHold(db(fake), { claimKeys: keys, holdId: 'hold_run', reason: 'test', nowMs: T_SEAL });
    expect(out.kind).toBe('refused');
    expect(out.kind === 'refused' && out.held_before_refusal.length).toBe(400);
    for (const k of keys) expect(isDemotionHeld(claimAt(fake, k), T_SEAL)).toBe(false);
  });

  it('RED: a charged payout whose work a demotion holds waits for the hold (never settles around it and closes)', async () => {
    const fake = createFakeFirestore();
    await seed(fake);
    const requestId = 'payout_req_held';
    fake.store.set(`${PAYOUT_REQUESTS_COLLECTION}/${requestId}`, {
      schema: 'provian.pvt-payout-request.v1', request_id: requestId, payee: HUMAN, state: 'charged',
      created_at_ms: AFTER_READY - 1000, updated_at_ms: AFTER_READY - 1000, waiting_reason: null, settle_attempts: 0,
    });
    let settles = 0;
    const deps = {
      db: db(fake),
      chain: { gasPriceWei: async () => 1n, l1FeeUpperBoundWei: async () => 1n },
      ethUsd: async () => 3000,
      settle: async () => { settles += 1; return { kind: 'nothing', cycleId: 'c' }; },
      withGasKeyLease: async (fn: () => Promise<unknown>) => fn(),
      now: () => AFTER_READY,
      sleep: async () => undefined,
      log: () => undefined,
    } as unknown as PayoutDeps;
    const after = await advancePayout(deps, requestId);
    expect(settles).toBe(0);
    expect(after.state).toBe('charged');
    expect(after.waiting_reason).toBe('demotion_hold');
  });

  it('RED: a hold that cannot be opened (a claim already left pending, or another run holds it) refuses the run and nothing moves', async () => {
    for (const block of [
      (fake: FakeFirestore, k: string) => { claimAt(fake, k).state = 'aggregated'; },
      (fake: FakeFirestore, k: string) => { claimAt(fake, k)[DEMOTION_HOLD_FIELD] = { hold_id: 'hold_other', opened_at_ms: T_SEAL, expires_at_ms: T_SEAL + 30 * DAY, reason: 'r' }; },
    ]) {
      const fake = createFakeFirestore();
      const s = await seed(fake, { hold: false });
      const ev = legacyEvidence(fake, s);
      block(fake, claimKeysOf(s)[claimKeysOf(s).length - 1]);
      const before = storeJson(fake);
      const out = await demoteBugProducedMeterActs({
        db: db(fake), execute: true, holdId: 'hold_run', nowMs: () => T_SEAL + DAY,
        entries: [{ relay_pe_id: s.ids[0], batch_hash: BATCH, detector: 'transcript_rewitnessed_turn', expected_snapshot_hash: String(s.rows[0].economic_snapshot_hash), evidence: ev }],
      });
      expect(out.kind).toBe('hold_refused');
      expect(storeJson(fake)).toBe(before);
    }
  });
});
