/**
 * the registry that closes the honest-SDK gap.
 *
 * Every refusal arm is constructible against the PURE judge (no Firestore
 * double needed), which is what keeps them from becoming the unreachable guards
 * warns about. The transactional wrapper is exercised separately, because
 * the fork refusal is only real if the transaction is.
 */
import { describe, it, expect } from '@jest/globals';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import {
  DEVICE_SESSION_REGISTRY_COLLECTION,
  admitDeviceSessionLineage,
  judgeDeviceSessionAdmission,
  nextRegistryDocument,
  type DeviceSessionRegistryDocument,
} from './device-session-registry';
import {
  deriveEconomicSessionLineageId,
  type EconomicSessionLineageClaim,
} from './economic-session-lineage';

const DEVICE = 'dev_registry_1';
const START = Date.UTC(2026, 7, 3, 9, 0);
/** Relay clock for the pure judge. Far past every claim start used below. */
const NOW = START + 10 * 60 * 60 * 1000;

/** The pure judge at the fixed relay clock. */
function judged(
  prior: DeviceSessionRegistryDocument | null,
  c: EconomicSessionLineageClaim,
  nowMs: number = NOW,
) {
  return judgeDeviceSessionAdmission(prior, c, nowMs);
}

function claim(ordinal: number, over: Partial<EconomicSessionLineageClaim> = {}): EconomicSessionLineageClaim {
  const nonce = ordinal.toString(16).padStart(32, '0');
  const startedAt = over.session_started_at_ms ?? START + ordinal * 1000;
  return {
    v: 2,
    session_started_at_ms: startedAt,
    session_nonce: nonce,
    session_ordinal: ordinal,
    id: deriveEconomicSessionLineageId({
      attestedDeviceId: DEVICE, sessionStartedAtMs: startedAt, sessionNonce: nonce, sessionOrdinal: ordinal,
    }),
    ...over,
  };
}

function priorFor(c: EconomicSessionLineageClaim, total = c.session_ordinal): DeviceSessionRegistryDocument {
  return {
    schema_version: 'device-session-lineage/v1',
    device_id: DEVICE,
    current_lineage_id: c.id,
    current_ordinal: c.session_ordinal,
    current_started_at_ms: c.session_started_at_ms,
    admitted_at_ms: START,
    sessions_opened_total: total,
    pe_count_current: 1,
  };
}

describe('the pure admission judge', () => {
  it("a device's FIRST session must be ordinal 1", () => {
    expect(judged(null, claim(1)))
      .toEqual({ ok: true, kind: 'opened', ordinal: 1 });
    // RED: starting anywhere else would let the client choose its own count.
    expect(judged(null, claim(7)))
      .toEqual({ ok: false, reason: 'first_session_must_be_ordinal_one', expectedOrdinal: 1 });
  });

  it('the SAME lineage id continues the session — the ordinary many-PEs case', () => {
    const c = claim(1);
    expect(judged(priorFor(c), c))
      .toEqual({ ok: true, kind: 'continued', ordinal: 1 });
  });

  it('a NEW session must be exactly current + 1', () => {
    const c1 = claim(1);
    expect(judged(priorFor(c1), claim(2)))
      .toEqual({ ok: true, kind: 'opened', ordinal: 2 });
  });

  it('RED: a FORK — same ordinal, different id — is refused', () => {
    // This is what "run parallel sessions to inflate the count" looks like.
    const c1 = claim(1);
    const forked = claim(1, { session_nonce: 'f'.repeat(32) });
    const rebuilt: EconomicSessionLineageClaim = {
      ...forked,
      id: deriveEconomicSessionLineageId({
        attestedDeviceId: DEVICE, sessionStartedAtMs: forked.session_started_at_ms,
        sessionNonce: forked.session_nonce, sessionOrdinal: 1,
      }),
    };
    expect(rebuilt.id).not.toBe(c1.id);
    expect(judged(priorFor(c1), rebuilt))
      .toEqual({ ok: false, reason: 'session_ordinal_conflict', expectedOrdinal: 2 });
  });

  it('RED: a SUPERSEDED session cannot be replayed or resumed', () => {
    const c5 = claim(5);
    expect(judged(priorFor(c5), claim(3)))
      .toEqual({ ok: false, reason: 'session_superseded', expectedOrdinal: 6 });
  });

  it('RED: a GAP in the sequence is refused, so the count has no holes', () => {
    const c1 = claim(1);
    expect(judged(priorFor(c1), claim(3)))
      .toEqual({ ok: false, reason: 'session_ordinal_gap', expectedOrdinal: 2 });
  });

  it('RED: a later session cannot have started EARLIER than the one it follows', () => {
    const c1 = claim(1, { session_started_at_ms: START + 50_000 });
    const backwards = claim(2, { session_started_at_ms: START + 10_000 });
    expect(judged(priorFor(c1), backwards))
      .toEqual({ ok: false, reason: 'session_start_regressed', expectedOrdinal: null });
  });

  it('RED: a continuation whose ordinal disagrees with the registry is refused', () => {
    const c1 = claim(1);
    expect(judged(priorFor(c1), { ...c1, session_ordinal: 9 }))
      .toEqual({ ok: false, reason: 'session_ordinal_conflict', expectedOrdinal: 2 });
  });

  it(' RED: a session declaring a start in the FUTURE is refused', () => {
    // claimed "retroactive session fabrication CLOSED". It was not:
    // `session_start_regressed` compared two CLIENT-chosen numbers to each other
    // and never to the relay's clock, so a session could declare itself opening
    // in 2100. The relay's own clock is now one of the operands.
    const c1 = claim(1, { session_started_at_ms: NOW - 1000 });
    const future = claim(2, { session_started_at_ms: NOW + 60 * 60 * 1000 });
    expect(judged(priorFor(c1), future))
      .toEqual({ ok: false, reason: 'session_start_in_future', expectedOrdinal: null });
    // A device's FIRST session is checked too — there is no prior to compare to,
    // so without this arm the very first claim could name any instant it liked.
    expect(judged(null, claim(1, { session_started_at_ms: NOW + 60 * 60 * 1000 })))
      .toEqual({ ok: false, reason: 'session_start_in_future', expectedOrdinal: null });
    // Ordinary clock skew is TOLERATED, so the guard is not simply "refuse".
    expect(judged(priorFor(c1), claim(2, { session_started_at_ms: NOW + 30_000 })).ok).toBe(true);
  });

});

describe('the counters are RELAY-computed, not client-asserted', () => {
  it('sessions_opened_total counts opens; pe_count_current counts PEs in the session', () => {
    const c1 = claim(1);
    const opened = nextRegistryDocument(null, DEVICE, c1, { ok: true, kind: 'opened', ordinal: 1 }, 1);
    expect(opened.sessions_opened_total).toBe(1);
    expect(opened.pe_count_current).toBe(1);

    const continued = nextRegistryDocument(opened, DEVICE, c1, { ok: true, kind: 'continued', ordinal: 1 }, 2);
    expect(continued.sessions_opened_total).toBe(1);
    expect(continued.pe_count_current).toBe(2);

    const c2 = claim(2);
    const reopened = nextRegistryDocument(continued, DEVICE, c2, { ok: true, kind: 'opened', ordinal: 2 }, 3);
    expect(reopened.sessions_opened_total).toBe(2);
    expect(reopened.pe_count_current).toBe(1);
    expect(reopened.current_lineage_id).toBe(c2.id);
  });
});

/** The transactional wrapper. */
async function admitted(
  db: unknown, deviceId: string, c: EconomicSessionLineageClaim, nowMs: number,
) {
  return admitDeviceSessionLineage(db as never, deviceId, c, nowMs);
}

describe('transactional admission', () => {
  it('walks a real sequence and refuses a replay of a superseded session', async () => {
    const db = createFakeFirestore();
    const c1 = claim(1);
    expect(await admitted(db, DEVICE, c1, NOW + 1))
      .toEqual({ ok: true, kind: 'opened', ordinal: 1 });
    // Continuation, twice: the ordinary many-PEs-per-session case.
    expect(await admitted(db, DEVICE, c1, NOW + 2))
      .toEqual({ ok: true, kind: 'continued', ordinal: 1 });
    const c2 = claim(2);
    expect(await admitted(db, DEVICE, c2, NOW + 3))
      .toEqual({ ok: true, kind: 'opened', ordinal: 2 });
    // ...and the first session can never come back.
    expect(await admitted(db, DEVICE, c1, NOW + 4))
      .toEqual({ ok: false, reason: 'session_superseded', expectedOrdinal: 3 });

    const row = db.store.get(`${DEVICE_SESSION_REGISTRY_COLLECTION}/${DEVICE}`) as unknown as DeviceSessionRegistryDocument;
    expect(row.sessions_opened_total).toBe(2);
    expect(row.current_ordinal).toBe(2);
  });

  it('RED: a malformed registry row REFUSES rather than resetting the sequence', async () => {
    // Fail-closed, and the direction matters: recreating a lost registry would
    // let a client corrupt the doc to reset its own ordinal — the one thing this
    // registry exists to prevent.
    const db = createFakeFirestore();
    db.store.set(`${DEVICE_SESSION_REGISTRY_COLLECTION}/${DEVICE}`, { junk: true });
    expect(await admitted(db, DEVICE, claim(1), NOW))
      .toEqual({ ok: false, reason: 'registry_malformed', expectedOrdinal: null });
  });

  it(' RED: the read is INSIDE the transaction — a contended retry re-reads', async () => {
    // The load-bearing claim of is that "the transaction is what makes the
    // fork refusal real". Every other test here is strictly sequential, so the
    // mutation "hoist the `get` above `runTransaction` and keep only the `set`
    // inside" passed the whole suite while destroying exactly that property.
    //
    // This drives a real commit conflict: the first attempt's writes are
    // discarded and a COMPETING WRITER advances the registry to ordinal 2 before
    // the callback re-runs. Reading inside the transaction sees the new state and
    // refuses the now-superseded claim; a hoisted read would reuse the stale
    // `prior`, see ordinal 1, and admit — a fork committed under contention.
    const c1 = claim(1);
    const c2 = claim(2);
    const db = createFakeFirestore({
      retryFirstTxn: {
        beforeRetry: (store) => {
          store.set(`${DEVICE_SESSION_REGISTRY_COLLECTION}/${DEVICE}`, {
            ...priorFor(c2, 2),
          } as unknown as Record<string, unknown>);
        },
      },
    });
    const verdict = await admitted(db, DEVICE, c1, NOW);
    expect(verdict).toEqual({
      ok: false, reason: 'session_superseded', expectedOrdinal: 3,
    });
    // And the competing writer's row survived untouched.
    const row = db.store.get(`${DEVICE_SESSION_REGISTRY_COLLECTION}/${DEVICE}`) as unknown as
      DeviceSessionRegistryDocument;
    expect(row.current_ordinal).toBe(2);
    expect(row.current_lineage_id).toBe(c2.id);
  });

  it('two concurrent opens at the same ordinal cannot both commit', async () => {
    const db = createFakeFirestore();
    await admitted(db, DEVICE, claim(1), NOW);
    const a = claim(2, { session_nonce: 'a'.repeat(32) });
    const b = claim(2, { session_nonce: 'b'.repeat(32) });
    const rebuild = (c: EconomicSessionLineageClaim): EconomicSessionLineageClaim => ({
      ...c,
      id: deriveEconomicSessionLineageId({
        attestedDeviceId: DEVICE,
        sessionStartedAtMs: c.session_started_at_ms,
        sessionNonce: c.session_nonce,
        sessionOrdinal: c.session_ordinal,
      }),
    });
    const results = await Promise.all([
      admitted(db, DEVICE, rebuild(a), NOW),
      admitted(db, DEVICE, rebuild(b), NOW),
    ]);
    // Exactly one wins; the other is refused as a fork at the same ordinal.
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    const row = db.store.get(`${DEVICE_SESSION_REGISTRY_COLLECTION}/${DEVICE}`) as unknown as
      DeviceSessionRegistryDocument;
    expect(row.current_ordinal).toBe(2);
    expect(row.sessions_opened_total).toBe(2);
  });

  it('the registry is PER DEVICE — one device cannot advance another', async () => {
    const db = createFakeFirestore();
    await admitted(db, DEVICE, claim(1), NOW);
    // A different device starts its own sequence at 1 and is unaffected.
    expect(await admitted(db, 'dev_other', claim(1), NOW))
      .toEqual({ ok: true, kind: 'opened', ordinal: 1 });
  });
});

/**
 * the exhaustiveness control's population: one real input per refusal arm, run INSIDE the
 * control and collected from what the judge / wrapper actually RETURNED. (It used to be a hand-written
 * literal, which proved only that two lists matched; then a set filled as a side effect of the tests
 * above, which went red whenever `jest --randomize` ran the control before `registry_malformed`'s
 * transactional test. Driving every arm here makes it independent of test order.)
 */
const REFUSAL_INPUTS: ReadonlyArray<() => Promise<{ ok: boolean; reason?: string }>> = [
  async () => judged(null, claim(7)),
  async () => judged(priorFor(claim(1)), claim(3)),
  async () => judged(priorFor(claim(1)), { ...claim(1), session_ordinal: 9 }),
  async () => judged(priorFor(claim(5)), claim(3)),
  async () => judged(
    priorFor(claim(1, { session_started_at_ms: START + 50_000 })),
    claim(2, { session_started_at_ms: START + 10_000 }),
  ),
  async () => judged(null, claim(1, { session_started_at_ms: NOW + 60 * 60 * 1000 })),
  async () => {
    const db = createFakeFirestore();
    db.store.set(`${DEVICE_SESSION_REGISTRY_COLLECTION}/${DEVICE}`, { junk: true });
    return admitted(db, DEVICE, claim(1), NOW);
  },
];

describe('the refusal set is exhaustive', () => {
  it('every declared refusal reason is RETURNED by a real input', async () => {
    const declared = new Set(
      require('fs').readFileSync(`${__dirname}/device-session-registry.ts`, 'utf8')
        .split('export type DeviceSessionRejection =')[1].split(';')[0]
        .match(/'([a-z_]+)'/g)!.map((s: string) => s.replace(/'/g, '')),
    );
    const observed = new Set<string>();
    for (const run of REFUSAL_INPUTS) {
      const verdict = await run();
      expect(verdict.ok).toBe(false);
      if (!verdict.ok && verdict.reason) observed.add(verdict.reason);
    }
    expect(declared.size).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...observed].sort());
  });
});
