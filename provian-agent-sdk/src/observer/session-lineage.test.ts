/**
 * the SDK half of the lineage derivation.
 *
 * The vector below is the SAME one pinned in
 * `provian-backend/src/core/pvt/economic-session-lineage.test.ts`. Two
 * implementations of one protocol: if they drift, every observed PE fails
 * verification at the relay and the fence silently stays up. Pinning the same
 * literal on both sides is what makes that drift a test failure instead of a
 * production mystery.
 */
import { describe, it, expect } from 'vitest';
import {
  ECONOMIC_SESSION_LINEAGE_PREFIX,
  deriveEconomicSessionLineageId,
  mintSessionLineageClaim,
} from './session-lineage';
import { SessionManager } from './SessionManager';
import { SUBMIT_OBSERVED_PE } from '../observed-submit';

const DEVICE = 'dev_vector';
const START = 1785715200000;
const NONCE = '00112233445566778899aabbccddeeff';

/** In-memory stand-in for the durable ordinal store. */
function mkOrdinals(): () => number { let n = 0; return () => { n += 1; return n; }; }

describe('the derivation mirrors the relay byte for byte', () => {
  /**
   * THE CROSS-PACKAGE VECTOR, pinned as a LITERAL on both sides.
   *
   * The first cut recomputed this from an inline `JSON.stringify` here and again
   * in the relay suite, so each side only ever compared itself against itself.
   * The reviewer proved it with a negative control: renaming
   * `attested_device_id` in BOTH this module and this literal left both suites
   * green while the two implementations diverged. Production would then have
   * been worse than a re-raised fence — the relay 400s before the chain-tip
   * advance, so every observer PE would stop being RECORDED, silently.
   *
   * This string is the binding, and it is the SAME string asserted in
   * `provian-backend/src/core/pvt/economic-session-lineage.test.ts`.
   */
  it('THE CROSS-PACKAGE VECTOR — pinned literal, mirrored in the relay suite', () => {
    expect(deriveEconomicSessionLineageId({
      attestedDeviceId: DEVICE, sessionStartedAtMs: START, sessionNonce: NONCE, sessionOrdinal: 1,
    })).toBe('pesl2_0065b35cc24445e9d233d9bdde368b8c7e423c42');
  });
});

describe('minting a claim', () => {
  it('produces a self-consistent claim whose id is the derivation of its own fields', () => {
    const claim = mintSessionLineageClaim({
      attestedDeviceId: DEVICE, sessionStartedAtMs: START, nonce: NONCE, sessionOrdinal: 1,
    });
    expect(claim).not.toBeNull();
    expect(claim!.id).toBe(deriveEconomicSessionLineageId({
      attestedDeviceId: DEVICE,
      sessionStartedAtMs: claim!.session_started_at_ms,
      sessionNonce: claim!.session_nonce,
      sessionOrdinal: claim!.session_ordinal,
    }));
  });

  it('RED: no attested device -> null, so the PE ships without lineage and the fence holds', () => {
    // Fabricating a capture context for an unattested runtime is exactly what
    // the rule forbids. Null is the honest answer, not a degraded one.
    expect(mintSessionLineageClaim({ attestedDeviceId: null, sessionStartedAtMs: START, sessionOrdinal: 1 })).toBeNull();
    expect(mintSessionLineageClaim({ attestedDeviceId: '  ', sessionStartedAtMs: START, sessionOrdinal: 1 })).toBeNull();
    expect(mintSessionLineageClaim({ attestedDeviceId: undefined, sessionStartedAtMs: START, sessionOrdinal: 1 })).toBeNull();
  });

  it('RED: a nonsensical session start -> null', () => {
    expect(mintSessionLineageClaim({ attestedDeviceId: DEVICE, sessionStartedAtMs: 0, sessionOrdinal: 1 })).toBeNull();
    expect(mintSessionLineageClaim({ attestedDeviceId: DEVICE, sessionStartedAtMs: -1, sessionOrdinal: 1 })).toBeNull();
    expect(mintSessionLineageClaim({ attestedDeviceId: DEVICE, sessionStartedAtMs: 1.5, sessionOrdinal: 1 })).toBeNull();
  });

  it('generates a fresh 128-bit nonce when none is injected', () => {
    const a = mintSessionLineageClaim({ attestedDeviceId: DEVICE, sessionStartedAtMs: START, sessionOrdinal: 1 })!;
    const b = mintSessionLineageClaim({ attestedDeviceId: DEVICE, sessionStartedAtMs: START, sessionOrdinal: 2 })!;
    expect(a.session_nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(a.session_nonce).not.toBe(b.session_nonce);
    expect(a.id).not.toBe(b.id);
  });
});

describe('ONE attested runtime session, ONE lineage id', () => {
  it('the id is fixed for the life of the session, not re-derived per PE', () => {
    // The causal-session rule, asserted on the manager that owns the boundary.
    // A per-PE derivation would satisfy the relay's fence by construction while
    // meaning nothing, which is why the mint lives at session open.
    const mgr = new SessionManager(60_000, 3_600_000, 0.05, DEVICE, mkOrdinals());
    const started = mgr.tick({ cpuLoad: 0.9, now: START });
    expect(started.type).toBe('session_started');
    const first = mgr.current()!.lineage;
    expect(first).not.toBeNull();

    mgr.tick({ cpuLoad: 0.9, now: START + 1_000 });
    mgr.tick({ cpuLoad: 0.9, now: START + 5_000 });
    expect(mgr.current()!.lineage).toBe(first);
    expect(mgr.current()!.lineage!.id).toBe(first!.id);
  });

  it('a NEW session gets a NEW lineage', () => {
    const mgr = new SessionManager(1_000, 3_600_000, 0.05, DEVICE, mkOrdinals());
    mgr.tick({ cpuLoad: 0.9, now: START });
    const first = mgr.current()!.lineage!.id;
    // Go idle past the threshold to close the session, then reopen.
    mgr.tick({ cpuLoad: 0, now: START + 2_000 });
    expect(mgr.current()).toBeNull();
    mgr.tick({ cpuLoad: 0.9, now: START + 3_000 });
    expect(mgr.current()!.lineage!.id).not.toBe(first);
  });

  it('RED: an observer with no device credential opens sessions with NO lineage', () => {
    const mgr = new SessionManager(60_000, 3_600_000, 0.05, null, mkOrdinals());
    mgr.tick({ cpuLoad: 0.9, now: START });
    expect(mgr.current()!.lineage).toBeNull();
  });
});

/**
 * the two defects the reviewer found in the FIRST cut of, pinned
 * so neither can return. Both were silent: green suites, correct-looking code.
 */
describe('a PE is stamped with the session it was CAPTURED in, or with nothing', () => {
  it('a plugin PE whose window predates the open session gets NO lineage', async () => {
    // THE DEFECT: the drain read `sessions.current()` at SUBMIT time, which is a
    // different instant from CAPTURE time. GitPlugin queues PEs from its own
    // poll while no session is open; ProcessPlugin can then open session B
    // inside the same tick, BEFORE the drain. The PE was stamped with B — a
    // valid claim for the device, so the relay accepts it — asserting a
    // witnessed capture context that did not exist when the evidence was
    // captured. That is fabricated provenance.
    const { ProvianObserver } = await import('./ProvianObserver.js');
    // PE meter: the observed PE is recorded in this device's PE store (read back here).
    const { CapturingPeStore } = await import('../meter/capturing-store.test-support.js');
    const store = new CapturingPeStore(DEVICE);
    const observer = new ProvianObserver({
      idleThresholdMs: 30_000, maxSessionMs: 900_000, tickIntervalMs: 1000,
      plugins: [], relayUrl: 'https://relay.test', logLevel: 'error',
      credentials: { deviceKey: 'pdk', deviceSecret: 'pds', deviceId: DEVICE, relayUrl: 'https://relay.test' },
      sessionOrdinalPath: `${require('os').tmpdir()}/provian-test-ordinal-${Date.now()}-${Math.random()}.json`,
      peStore: store,
    } as never);

    const bodies = store.bodies;
    const { vi } = await import('vitest');

    // Open a session NOW; the PE's window is entirely BEFORE it.
    const mgr = observer.sessionManager;
    mgr.tick({ cpuLoad: 0.9, now: START });
    expect(mgr.current()!.lineage).not.toBeNull();

    const submit = (observer as never as {
      submitPluginPE: (p: { name: string }, pe: unknown, cs: unknown) => Promise<void>;
    }).submitPluginPE.bind(observer);
    const capture = { startedAt: START, lineage: mgr.current()!.lineage };

    await submit({ name: 'GitPlugin' }, {
      actionType: 'coding_session', windowStart: START - 60_000, windowEnd: START - 1_000,
      skipDedupClaim: true,
    }, capture);
    expect(bodies).toHaveLength(1);
    // No lineage: the evidence predates the session, so the fence holds.
    expect(bodies[0].economic_session_lineage).toBeUndefined();

    // Positive control: a PE captured INSIDE the session does carry it, so the
    // absence above is about the window and not about the plumbing.
    await submit({ name: 'GitPlugin' }, {
      actionType: 'coding_session', windowStart: START + 10, windowEnd: START + 20,
      skipDedupClaim: true,
    }, capture);
    expect(bodies).toHaveLength(2);
    expect((bodies[1].economic_session_lineage as { id: string }).id)
      .toBe(mgr.current()!.lineage!.id);
    vi.unstubAllGlobals();
  });
});

describe('every device-mode report path that DECLARES the claim FORWARDS it', () => {
  it('the observed-PE submitter forwards the lineage it was given (reportWorkProduct was removed)', async () => {
    // THE DEFECT this guarded : a report path declared the field and
    // dropped it, returned 201, and the PE sealed terminal `record_only` with no
    // signal. The one remaining device-mode path is the observer's internal
    // submitter; it must forward the claim.
    const { ProvianClient } = await import('../ProvianClient.js');
    const { vi } = await import('vitest');
    const { CapturingPeStore } = await import('../meter/capturing-store.test-support.js');
    const store = new CapturingPeStore(DEVICE);
    const bodies = store.bodies;
    const client = new ProvianClient({
      relayUrl: 'https://relay.test', deviceKey: 'pdk', deviceSecret: 'pds', deviceId: DEVICE, peStore: store,
    } as never);
    const claim = mintSessionLineageClaim({
      attestedDeviceId: DEVICE, sessionStartedAtMs: START, nonce: NONCE, sessionOrdinal: 1,
    })!;
    await client[SUBMIT_OBSERVED_PE]({
      actionType: 'compute_session',
      description: 'A compute session captured under an attested observer session',
      success: true,
      economic_session_lineage: claim,
    } as never);
    expect(bodies).toHaveLength(1);
    expect((bodies[0].economic_session_lineage as { id: string }).id).toBe(claim.id);
    vi.unstubAllGlobals();
  });
});

describe('the ordinal survives a restart, or the relay refuses every later session', () => {
  it('reserve-before-use: the file is written BEFORE the ordinal is handed out', async () => {
    const { createSessionOrdinalStore } = await import('./session-ordinal-store.js');
    const fs = await import('fs');
    const os = await import('os');
    const p = `${os.tmpdir()}/provian-ordinal-${Date.now()}-${Math.random()}.json`;

    const store = createSessionOrdinalStore(p, DEVICE);
    expect(store.peek()).toBe(1);
    expect(store.reserveNext()).toBe(1);
    // Persisted immediately, so a crash here SKIPS an ordinal rather than
    // reusing one. A skip the relay refuses loudly; a reuse would be a silent
    // fork, which is the failure the registry exists to prevent.
    expect(JSON.parse(fs.readFileSync(p, 'utf8')).next_ordinal).toBe(2);
    expect(store.reserveNext()).toBe(2);

    // A FRESH store over the same file continues the sequence — the restart case.
    const afterRestart = createSessionOrdinalStore(p, DEVICE);
    expect(afterRestart.reserveNext()).toBe(3);
    fs.unlinkSync(p);
  });

  it('a file belonging to ANOTHER device is REFUSED, not silently reset', async () => {
    // PIN CHANGED, with the reason recorded so it is not "restored" as a fix.
    // This used to assert `peek() === 1` — treating a stranger's file as absent.
    // But `reserveNext` then OVERWROTE it, so two devices sharing one
    // `sessionOrdinalPath` clobbered each other back to 1 forever and BOTH were
    // locked out of lineage-bearing submission, with nothing naming the cause.
    // A misconfiguration must fail loudly and by name.
    const { createSessionOrdinalStore, ForeignDeviceOrdinalFileError } =
      await import('./session-ordinal-store.js');
    const fs = await import('fs');
    const os = await import('os');
    const p = `${os.tmpdir()}/provian-ordinal-${Date.now()}-${Math.random()}.json`;
    createSessionOrdinalStore(p, DEVICE).reserveNext();
    const other = createSessionOrdinalStore(p, 'dev_other');
    expect(() => other.peek()).toThrow(ForeignDeviceOrdinalFileError);
    expect(() => other.reserveNext()).toThrow(ForeignDeviceOrdinalFileError);
    // And the owner's count is INTACT — the stranger did not clobber it.
    expect(createSessionOrdinalStore(p, DEVICE).peek()).toBe(2);
    fs.unlinkSync(p);
  });

  it('the relay-directed resync adopts the relay ordinal and unblocks the device', async () => {
    // The HIGH defect the reviewer leg found: reserve-before-use burns an
    // ordinal at session open, the relay only advances on an ADMITTED PE, so a
    // session that never landed one left the counter permanently ahead and every
    // later claim was refused `session_ordinal_gap` — with those PEs no longer
    // recorded at all. called the skip "recoverable"; nothing recovered it.
    const { createSessionOrdinalStore } = await import('./session-ordinal-store.js');
    const fs = await import('fs');
    const os = await import('os');
    const p = `${os.tmpdir()}/provian-ordinal-${Date.now()}-${Math.random()}.json`;
    const store = createSessionOrdinalStore(p, DEVICE);
    expect(store.reserveNext()).toBe(1);
    expect(store.reserveNext()).toBe(2); // session 2 opened; its PE never landed
    expect(store.reserveNext()).toBe(3); // drifted: the relay is still at 1
    // The relay refuses and reports the ordinal IT expects next.
    store.adoptRelayOrdinal(2);
    expect(store.reserveNext()).toBe(2);
    // A nonsense value from a hostile/garbled response is ignored, not adopted.
    store.adoptRelayOrdinal(0);
    store.adoptRelayOrdinal(-5);
    expect(store.peek()).toBe(3);
    fs.unlinkSync(p);
  });

  it('RED: a corrupt file restarts at 1 — which the relay refuses LOUDLY rather than accepting', async () => {
    const { createSessionOrdinalStore } = await import('./session-ordinal-store.js');
    const fs = await import('fs');
    const os = await import('os');
    const p = `${os.tmpdir()}/provian-ordinal-${Date.now()}-${Math.random()}.json`;
    fs.writeFileSync(p, 'not json at all');
    // Treated as absent. The client then presents ordinal 1, the relay's
    // registry is ahead, and admission fails `session_superseded` — a visible
    // failure, never a silently reset counter.
    expect(createSessionOrdinalStore(p, DEVICE).peek()).toBe(1);
    fs.unlinkSync(p);
  });

  it('no ordinal reserver -> no lineage at all, so the fence holds', () => {
    // The honest outcome for a runtime that cannot maintain the sequence.
    const mgr = new SessionManager(60_000, 3_600_000, 0.05, DEVICE, null);
    mgr.tick({ cpuLoad: 0.9, now: START });
    expect(mgr.current()!.lineage).toBeNull();
  });
});
