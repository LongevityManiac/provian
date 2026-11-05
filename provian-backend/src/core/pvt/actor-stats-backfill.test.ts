/** Trust Layer build §2.5 — the actor_stats_v1 backfill folds pe_history with the accrual's own fold. */
import { describe, it, expect } from '@jest/globals';
import { backfillActorStats, bumpFromHistoryRow, compositionFromEnvelope, foldActorStats, witnessClassOfHistoryRow } from './actor-stats-backfill';
import { ACTOR_STATS_APPLIED_COLLECTION, ACTOR_STATS_COLLECTION, ACTOR_STATS_SCHEMA_V1, bumpActorStats, readActorStats, utcDayKey } from './actor-stats';
import { baseEconomicEvidence, testTxHash } from './__test-helpers__/base-economic-evidence';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1, 12);

function row(over: Record<string, unknown>): Record<string, unknown> {
  return { peId: `pe_${Math.random().toString(36).slice(2, 10)}`, userId: 'alice', timestamp: T0, actionType: 'coding_session', category: 'agent', attestationDepth: 'software', ...over };
}

describe('witnessClassOfHistoryRow / bumpFromHistoryRow (legacy rows)', () => {
  it('uses the sealed witness_class; a legacy verified row is relay_verified; unknown is actor_declared', () => {
    expect(witnessClassOfHistoryRow({ witness_class: 'chain_witnessed' })).toBe('chain_witnessed');
    expect(witnessClassOfHistoryRow({ attestation_verified: true })).toBe('relay_verified');
    expect(witnessClassOfHistoryRow({ witness_class: 'bogus', attestation_verified: false })).toBe('actor_declared');
    expect(witnessClassOfHistoryRow({})).toBe('actor_declared');
  });
  it('reads witnessed compute + independent origins from the sealed snapshot; null actor → null (skipped)', () => {
    const b = bumpFromHistoryRow(row({ economic_snapshot: { recordTimeFactors: { observedComputeTokens: 1234, independentOriginCount: 2 } } }), null)!;
    expect(b.witnessObservedTokens).toBe(1234);
    expect(b.independentOriginCount).toBe(2);
    expect(b.family).toBe('agent');
    expect(b.approvalsCited).toBe(0);
    expect(bumpFromHistoryRow({ actionType: 'x' }, null)).toBeNull();
    expect(bumpFromHistoryRow({ userId: 'a' }, null)).toBeNull();
  });
});

describe('foldActorStats ≡ the live bump path', () => {
  it('folding rows in ANY order equals bumping them live in timestamp order (same pure fold)', async () => {
    const rows = [
      row({ timestamp: T0 + 2 * DAY, witness_class: 'device_tier' }),
      row({ timestamp: T0, witness_class: 'chain_witnessed', actionType: 'x402_payment', category: 'x402' }),
      row({ timestamp: T0 + DAY, attestation_verified: true }),
    ];
    const folded = foldActorStats('alice', rows.map((r) => ({ row: r, composition: null })), T0 + 3 * DAY);
    const db = createFakeFirestore();
    const fs = db as unknown as Parameters<typeof bumpActorStats>[0];
    for (const r of [...rows].sort((a, b) => (a.timestamp as number) - (b.timestamp as number))) {
      const b = bumpFromHistoryRow(r, null)!;
      await bumpActorStats(fs, b, T0 + 3 * DAY);
    }
    const live = await readActorStats(fs, 'alice');
    const strip = (s: Record<string, unknown>) => { const { updated_at_ms: _u, ...rest } = s; return rest; };
    expect(strip(folded as unknown as Record<string, unknown>)).toEqual(strip(live as unknown as Record<string, unknown>));
    expect(folded.pe_count).toBe(3);
    expect(folded.streak_days).toBe(3);
    expect(folded.by_family_class.x402__chain_witnessed).toBe(1);
    expect(folded.by_family_class.agent__relay_verified).toBe(1);
  });
});

describe('backfillActorStats (dry run / apply / idempotent / composition join)', () => {
  function seed() {
    const db = createFakeFirestore();
    const fs = db as unknown as Parameters<typeof backfillActorStats>[0];
    const rows = [
      row({ peId: 'pe_a1', timestamp: T0 }),
      row({ peId: 'pe_a2', timestamp: T0 + DAY, witness_class: 'device_tier' }),
      row({ peId: 'pe_b1', userId: 'bob', timestamp: T0 + DAY, actionType: 'wallet_created', category: 'setup' }),
      row({ peId: 'pe_none', userId: null, timestamp: T0 }),
    ];
    for (const r of rows) db.store.set(`pe_history/${r.peId as string}`, r);
    db.store.set('provenance_envelopes/pe_a1', { id: 'pe_a1', metadata: { model: 'claude-sonnet-4', supervision: { human_opened_turns: 1, total_turns: 4 } }, execution_env: { environment_class: 'container' } });
    db.store.set('provenance_envelopes/pe_a2', { id: 'pe_a2', metadata: {}, execution_env: null });
    return { db, fs };
  }

  it('dry run writes nothing and reports per-actor counts; apply writes every actor; a re-run is byte-identical', async () => {
    const { db, fs } = seed();
    const dry = await backfillActorStats(fs, { apply: false, nowMs: () => T0 + 5 * DAY });
    expect(dry.mode).toBe('dry_run');
    expect(dry.actors_scanned).toBe(2);
    expect(dry.pes_folded).toBe(3);
    expect(dry.pes_skipped_no_actor).toBe(1);
    expect(dry.envelopes_missing).toBe(1); // pe_b1 has no envelope doc
    expect(db.store.has(`${ACTOR_STATS_COLLECTION}/alice`)).toBe(false);

    const applied = await backfillActorStats(fs, { apply: true, nowMs: () => T0 + 5 * DAY });
    expect(applied.actors_written).toBe(2);
    const alice = await readActorStats(fs, 'alice');
    expect(alice.pe_count).toBe(2);
    expect(alice.active_days).toBe(2);
    expect(alice.models).toEqual({ claude: 1 });
    expect(alice.environments).toEqual({ container: 1 });
    expect(alice.supervision_human_turns).toBe(1);
    expect(alice.supervision_total_turns).toBe(4);
    const bob = await readActorStats(fs, 'bob');
    expect(bob.by_type.wallet_created).toBe(1);

    const first = JSON.stringify(db.store.get(`${ACTOR_STATS_COLLECTION}/alice`));
    await backfillActorStats(fs, { apply: true, nowMs: () => T0 + 5 * DAY });
    expect(JSON.stringify(db.store.get(`${ACTOR_STATS_COLLECTION}/alice`))).toBe(first);
  });

  it('--actor restricts to one actor; a live bump (ledger row + bump) that lands DURING the fold is never lost', async () => {
    const { db, fs } = seed();
    const now = T0 + 5 * DAY;
    // The live doc is BEHIND the ledger (bumps started late) — the case the old updated_at/pe_count>
    // heuristic lost: live pe_count 1 < folded 2, so a mid-fold bump looked like "nothing new".
    await bumpActorStats(fs, bumpFromHistoryRow(row({ peId: 'pe_a2', timestamp: T0 + DAY }), null)!, now);
    let raced = false;
    const out = await backfillActorStats(fs, {
      apply: true, actorId: 'alice', nowMs: () => now,
      afterFold: async () => {
        if (raced) return;
        raced = true;
        // A PE seals mid-run in production order: pe_history FIRST, then the live bump.
        const r = row({ peId: 'pe_a3', timestamp: T0 + 2 * DAY });
        db.store.set('pe_history/pe_a3', r);
        await bumpActorStats(fs, bumpFromHistoryRow(r, null)!, now);
      },
    });
    expect(out.actors_scanned).toBe(1);
    expect(out.actors_refolded_after_live_bump).toBe(1);
    expect(out.actors_written).toBe(1);
    const alice = await readActorStats(fs, 'alice');
    expect(alice.pe_count).toBe(3); // RED: the old heuristic wrote 2 here (pe_a3 lost)
    expect(alice.history_complete).toBe(true);
    expect(db.store.has(`${ACTOR_STATS_COLLECTION}/bob`)).toBe(false);
  });

  it('RED (negative control): a row the fold READ whose live bump lands AFTER the write is counted once, not twice', async () => {
    const { db, fs } = seed();
    const now = T0 + 5 * DAY;
    // Production order: the seal writes pe_history, then (after its output-digest write) bumps. Here
    // the row is in the ledger before the fold, and its bump arrives only after the backfill wrote.
    const pending = row({ peId: 'pe_late', timestamp: T0 + 2 * DAY });
    db.store.set('pe_history/pe_late', pending);
    const out = await backfillActorStats(fs, { apply: true, actorId: 'alice', nowMs: () => now });
    expect(out.actors_written).toBe(1);
    expect((await readActorStats(fs, 'alice')).pe_count).toBe(3); // pe_a1, pe_a2, pe_late
    expect((await readActorStats(fs, 'alice')).fold_recent_pe_ids).toContain('pe_late'); // the fold's coverage rides the document
    // The late bump for the row the fold already counted skips.
    await bumpActorStats(fs, bumpFromHistoryRow(pending, null)!, now);
    expect((await readActorStats(fs, 'alice')).pe_count).toBe(3);
    // positive twin: a genuinely new PE's bump still counts, exactly once, even if repeated.
    const fresh = row({ peId: 'pe_new', timestamp: T0 + 3 * DAY });
    db.store.set('pe_history/pe_new', fresh);
    await bumpActorStats(fs, bumpFromHistoryRow(fresh, null)!, now);
    await bumpActorStats(fs, bumpFromHistoryRow(fresh, null)!, now);
    expect((await readActorStats(fs, 'alice')).pe_count).toBe(4);
  });

  it('an actor that keeps moving is reported busy and left untouched (bounded retries)', async () => {
    const { db, fs } = seed();
    const now = T0 + 5 * DAY;
    let n = 0;
    const out = await backfillActorStats(fs, {
      apply: true, actorId: 'alice', nowMs: () => now, maxAttemptsPerActor: 2,
      afterFold: async () => {
        n += 1;
        const r = row({ peId: `pe_busy${n}`, timestamp: T0 + 3 * DAY });
        db.store.set(`pe_history/pe_busy${n}`, r);
        await bumpActorStats(fs, bumpFromHistoryRow(r, null)!, now);
      },
    });
    expect(out.actors_skipped_busy).toEqual(['alice']);
    expect(out.actors_written).toBe(0);
    // Untouched: the live doc is exactly the two live bumps (never overwritten by a stale fold).
    expect((await readActorStats(fs, 'alice')).pe_count).toBe(2);
  });

  it('upgrades a v1 document: history_complete true, v2 fields rebuilt from sealed evidence only', async () => {
    const { db, fs } = seed();
    const now = T0 + 5 * DAY;
    db.store.set(`${ACTOR_STATS_COLLECTION}/alice`, { schema_version: ACTOR_STATS_SCHEMA_V1, actor_id: 'alice', pe_count: 2, regions: { forged: 2 } });
    const sha = `sha384:${'ab'.repeat(48)}`;
    const evidence = baseEconomicEvidence({ transactionHash: testTxHash('in'), logIndex: 0, blockNumber: 9, fromAddress: '0x1111111111111111111111111111111111111111', toAddress: '0x2222222222222222222222222222222222222222', amountAtomic: '2500000' });
    db.store.set('pe_history/pe_hw', row({ peId: 'pe_hw', timestamp: T0 + DAY, witness_class: 'hardware_rooted' }));
    db.store.set('provenance_envelopes/pe_hw', { id: 'pe_hw', type: 'action_report', action_report: { metadata: { hardware_witness: { admitted: true, scheme: 'aws_nitro', region: 'forged-region' } } }, hardware_witness: { admitted: true, scheme: 'aws_nitro', region: 'us-east-1', launch_measurement: sha } });
    db.store.set('pe_history/pe_rx', row({ peId: 'pe_rx', timestamp: T0 + DAY, actionType: 'receive', category: 'wallet', witness_class: 'chain_witnessed' }));
    db.store.set('provenance_envelopes/pe_rx', { id: 'pe_rx', metadata: { verified: true, economic_evidence: evidence } });
    // RED: a device-lane PE whose raw metadata claims a region but whose sealed class is device_tier.
    db.store.set('pe_history/pe_dev', row({ peId: 'pe_dev', timestamp: T0 + DAY, witness_class: 'device_tier' }));
    db.store.set('provenance_envelopes/pe_dev', { id: 'pe_dev', metadata: { hardware_witness: { admitted: true, scheme: 'aws_nitro', region: 'eu-west-1', launch_measurement: sha }, attested_region: 'eu-west-1' } });
    await backfillActorStats(fs, { apply: true, actorId: 'alice', nowMs: () => now });
    const alice = await readActorStats(fs, 'alice');
    expect(alice.history_complete).toBe(true);
    expect(alice.pe_count).toBe(5);
    expect(alice.regions).toEqual({ 'us-east-1': 1 });
    expect(alice.measurements).toEqual({ [sha]: 1 });
    expect(alice.payment_volume_atomic).toBe('2500000');
    expect(alice.days[utcDayKey(T0 + DAY)].n).toBe(4);
  });

  it('compositionFromEnvelope reads the TOP-LEVEL sealed witness first (the action lane\'s metadata slot is the client\'s raw one)', () => {
    const env = { action_report: { metadata: { model: 'claude-3', hardware_witness: { admitted: true, scheme: 'aws_nitro', region: 'forged' } } }, hardware_witness: { admitted: true, scheme: 'aws_nitro', region: 'us-west-2' } };
    const c = compositionFromEnvelope(env, 'hardware_rooted')!;
    expect(c.hardwareRegion).toBe('us-west-2');
    expect(c.modelFamilies).toEqual(['claude']);
    expect(compositionFromEnvelope(env, 'actor_declared')!.hardwareRegion).toBeNull();
  });
});


describe('the two closed limits', () => {
  const WATCHER_MD = { standing: 'adverse', canonical_event_id: 'base:0xabc:1', institution: 'bond_pool' };

  it('the backfill re-folds an actor of ANY size in one write (RED: 401+ adverse rows used to be reported busy forever)', async () => {
    const db = createFakeFirestore();
    const fs = db as unknown as Parameters<typeof backfillActorStats>[0];
    const N = 1200; // three times the old one-transaction marker cap
    for (let i = 0; i < N; i += 1) {
      const peId = `pe_big_${i}`;
      db.store.set(`pe_history/${peId}`, row({ peId, userId: 'big', actionType: 'bond_slashed', category: 'bonds', timestamp: T0 + i, witness_class: 'chain_witnessed' }));
      db.store.set(`provenance_envelopes/${peId}`, { metadata: WATCHER_MD });
    }
    const out = await backfillActorStats(fs, { apply: true, actorId: 'big', nowMs: () => T0 + DAY });
    expect(out).toMatchObject({ actors_written: 1, actors_skipped_busy: [], actors_undecidable: [] });
    const stats = await readActorStats(fs, 'big');
    expect(stats.pe_count).toBe(N);
    expect(stats.adverse_by_type).toEqual({ bond_slashed: N });
    // No marker document per row: the fold's coverage is in the document.
    expect([...db.store.keys()].filter((k) => k.startsWith(`${ACTOR_STATS_APPLIED_COLLECTION}/`))).toHaveLength(0);
    expect(stats.fold_floor_ms).toBe(T0 + DAY - 2 * 60 * 60 * 1000);
    // …and a late seal-time bump never counts a folded row again.
    await bumpActorStats(fs, bumpFromHistoryRow(db.store.get('pe_history/pe_big_7') as never, null)!, T0 + DAY);
    expect((await readActorStats(fs, 'big')).pe_count).toBe(N);
  });

  it('a row OLDER than the fold floor is covered by its creation time, not by a list of ids', async () => {
    const { countedByFold } = require('./actor-stats') as typeof import('./actor-stats');
    const folded = { ...(await readActorStats(createFakeFirestore() as never, 'x')), fold_floor_ms: 5_000, fold_recent_pe_ids: [] };
    expect(countedByFold(folded, { peId: 'pe_any', rowCreateTimeMs: 4_999 })).toBe(true);
    expect(countedByFold(folded, { peId: 'pe_any', rowCreateTimeMs: 5_000 })).toBe(false);
  });

});
