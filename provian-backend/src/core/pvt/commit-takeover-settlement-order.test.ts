/**
 * AS AMENDED BY the corroboration lift is WINDOWED, and this suite
 * is the pin for the amended decision of record.
 *
 * ── THE RULE ──────────────────────────────────────
 * The cross-witness lift applies ONLY within the 72h deferral window. A forge
 * witness arriving after it is REFUSED and the incumbent's SEALED VALUE STANDS.
 * That is now the design, not a shortfall against it: 's original
 * "arrival-independent" wording is scoped to the window, and the settlement-
 * registers-first case is the rule operating correctly rather than a deviation
 * from it.
 *
 * `constructsTheDeviation` KEEPS ITS NAME on purpose — it is the control cited in
 * the amendment, and renaming it would break that citation. Read the name as
 * historical: what it constructs was a tracked deviation when it was written and
 * is ratified behaviour now. What it asserts did not change; what the assertion
 * MEANS did.
 *
 * ── THE DISPUTE THIS SUITE ORIGINALLY SETTLED ────────────────────────────────
 * Two records disagreed, so one of them was wrong:
 *
 * · a 2026-08-31 drift record (since deleted) asserted a
 * deviating interleaving EXISTS — settlement registers the daemon incumbent
 * (`coding_session`, base 1.0x) before the higher-base forge webhook
 * (base 3.0x) arrives, so `evaluateCommitWitness` sees a registered
 * incumbent, returns 'none', and the one mint settles at the daemon's own
 * value instead of proof-tier.
 *
 * · asserted the fix made that interleaving "UNCONSTRUCTIBLE", on the
 * grounds that the inlet now defers a commit-bearing PE while the
 * cross-witness window is open.
 *
 * **The disclosure was right and was overstated.** The behaviour is
 * NARROWED, not eliminated: deferral is bounded by
 * `ATTESTATION_ENHANCEMENT_WINDOW_MS` (72h), so a cross-witness arriving AFTER
 * that window still finds a registered incumbent. `constructsTheDeviation`
 * below builds exactly that and asserts it. 's claim was corrected in
 * rather than quietly softened, and then RATIFIED the outcome as
 * the rule.
 *
 * ── WHY THE WINDOWED RULE IS THE RIGHT ONE ───────────────────────────────────
 * Once an incumbent holds any `claim_ledger` leg it is committed to mint on
 * chain, and a takeover that demoted it would STRAND A SETTLEABLE CLAIM — which
 * `inspectPreparedCommitTakeoverInTransaction` refuses by design. Past 72h the
 * corroboration lift has lapsed anyway, so the only thing a late takeover could
 * still buy is base weight, and it cannot be bought without breaking the
 * never-strand rule. Correctness is never violated in either case: mint-once
 * holds throughout. This is a bounded, stated VALUE tradeoff, not a defect.
 *
 * ── AND IT IS REACHABLE IN PRODUCTION, WHICH IS WHY IT IS STATED PLAINLY ──────
 * "Commit now, push later" is ordinary developer behaviour, and the forge
 * webhook fires on PUSH. A commit whose push lands more than 72h later — after
 * the weekly cron has already registered the daemon's session — takes the
 * deviating branch. The disclosure's own timing argument (webhooks land within
 * seconds) covers the push-immediately case, not this one.
 *
 * ── WHAT THIS SUITE DOES AND DOES NOT EXERCISE, STATED UP FRONT ──────────────
 * It drives the three REAL decision points in their real order —
 * `commitTakeoverWindowOpen` (the inlet's gate), `registerClaim` (the durable
 * store), `evaluateCommitWitness` (the takeover pre-check). It does NOT drive
 * `createFirestoreInletSource` itself; that the inlet actually CALLS the gate is
 * pinned separately by the "the commit cross-witness deferral" block in
 * `wp4/claim-inlet-source.test.ts`. The two together cover the path; neither
 * alone does, and saying so is cheaper than implying this one covers both.
 */

import { describe, it, expect } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';

import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import { ATTESTATION_ENHANCEMENT_WINDOW_MS } from './policy/monetary-accounting';
import {
  commitTakeoverWindowOpen,
  evaluateCommitWitness,
  inspectPreparedCommitTakeoverInTransaction,
  prepareCommitTakeoverPlan,
} from './commit-takeover';
import { prepareCommitMintClaim } from './commit-mint-claim';
import { MintOnceClaimRaceError } from './mint-once-claim';
import {
  PE_HISTORY_COLLECTION,
  registerClaim,
  type NewClaimInput,
  type SettlementDb,
} from './wp4/durable-settlement-store';

const COMMIT_SHA = 'abcdef01'.repeat(5); // 40 hex
const USER = 'user-1';
const DAEMON_PE = 'pe-daemon-session';
/** `coding_session` — the local observer's witness. */
const DAEMON_BASE_BPS = 10_000;
/** `service:github_commit` — the forge's witness, 3x the daemon's base. */
const FORGE_BASE_BPS = 30_000;
/** The instant the daemon recorded the coding session. */
const RECORDED_AT = 1_800_000_000_000;

/** The pe_history row the inlet reads and the takeover pre-check re-reads. */
function daemonHistory(): Record<string, unknown> {
  return {
    peId: DAEMON_PE,
    userId: USER,
    commit_sha: COMMIT_SHA,
    timestamp: RECORDED_AT,
    mint_status: 'eligible',
    economic_snapshot: {
      recordTimeFactors: { baseActionWeightBps: DAEMON_BASE_BPS },
    },
  };
}

function daemonLeg(): NewClaimInput {
  return {
    leg: 'sole',
    pe_id: DAEMON_PE,
    claim_id: `0x${'1'.padStart(64, '0')}`,
    lane: 'standard',
    contributor: `0x${'a1'.padStart(40, '0')}`,
    beneficiary_class: 1,
    record_points_atomic: '1000000000000000000',
  };
}

async function seedDaemon(db: Firestore): Promise<void> {
  await db.collection(PE_HISTORY_COLLECTION).doc(DAEMON_PE)
    .set(daemonHistory() as FirebaseFirestore.DocumentData);
}

/**
 * Run one interleaving end to end and report what the forge witness gets.
 *
 * `settlementRunsAtMs` is when the weekly cron evaluates the row; `forgeArrivesAtMs`
 * is when the webhook lands. The inlet registers ONLY if its gate says the
 * cross-witness window has closed — which is the whole of the change.
 */
async function runInterleaving(input: {
  settlementRunsAtMs: number;
  forgeArrivesAtMs: number;
}): Promise<{
  registered: boolean;
  forgeAction: string;
  /** The incumbent's pe_history AFTER the forge was evaluated. */
  incumbentAfter: Record<string, unknown>;
}> {
  const db = createFakeFirestore() as unknown as Firestore;
  await seedDaemon(db);

  // 1. The settlement cron reaches this row.
  const deferred = commitTakeoverWindowOpen(daemonHistory(), input.settlementRunsAtMs);
  if (!deferred) {
    await registerClaim(db as unknown as SettlementDb, daemonLeg(), input.settlementRunsAtMs);
  }

  // 2. The forge webhook arrives and asks whether it may take the slot.
  const forgeAction = await evaluateCommitWitness(db, {
    incumbentPeId: DAEMON_PE,
    newBaseWeightBps: FORGE_BASE_BPS,
  });

  // 3. Read the incumbent back. 's rule is not only "the forge is refused"
  //    but "the SEALED VALUE STANDS", and the second half is a fact about this
  //    document, so it is read rather than assumed.
  const after = await db.collection(PE_HISTORY_COLLECTION).doc(DAEMON_PE).get();

  return {
    registered: !deferred,
    forgeAction,
    incumbentAfter: (after.data() ?? {}) as Record<string, unknown>,
  };
}

describe(' reconciliation — the settlement-interleaved orders, post-', () => {
  it('holdsTheInvariant: a forge arriving INSIDE the window finds an unregistered incumbent and takes over', async () => {
    // The cron fires one hour after the session — inside the 72h window, so the
    // gate defers the row rather than committing it to mint.
    const result = await runInterleaving({
      settlementRunsAtMs: RECORDED_AT + 60 * 60 * 1000,
      forgeArrivesAtMs: RECORDED_AT + 61 * 60 * 1000,
    });

    expect(result.registered).toBe(false);
    // 'takeover' = the forge becomes the settling winner at its own 3.0x base,
    // and carries the cross-witness corroboration. Best value, preserved.
    expect(result.forgeAction).toBe('takeover');
  });

  it('constructsTheDeviation: a forge arriving AFTER the window finds a REGISTERED incumbent and is refused', async () => {
    // THE NAMED CONTROL. This is the interleaving 99-not-at-head §1.a describes,
    // built post-fix. Commit-now/push-later: the cron registers the session once
    // the 72h window lapses, and the push (and therefore the webhook) lands after.
    const settlementRunsAtMs = RECORDED_AT + ATTESTATION_ENHANCEMENT_WINDOW_MS + 1;
    const result = await runInterleaving({
      settlementRunsAtMs,
      forgeArrivesAtMs: settlementRunsAtMs + 60 * 60 * 1000,
    });

    expect(result.registered).toBe(true);
    // no takeover — the commit mints ONCE (correct) at the daemon's own base,
    // not the forge's 3.0x; the sealed value stands. then ADDED the forward
    // half: the too-late forge is still a second real witness, so it CORROBORATES the
    // registered incumbent ('corroborate_incumbent', never 'takeover'); the
    // software→corroborated lift is carried by the additive attestation top-up once
    // the incumbent has registered/minted. Ownership never moves.
    expect(result.forgeAction).toBe('corroborate_incumbent');

    // ── THE SEALED VALUE STANDS (weak half — see the next test) ─────
    // A REGRESSION GUARD, NOT PROOF OF ENFORCEMENT, and the difference is worth
    // stating: `evaluateCommitWitness` is a pure READ, so nothing in this path
    // could write to `pe_history` even if the rule were broken. These three
    // assertions would therefore pass vacuously today; they exist to fail if a
    // future version of the pre-check starts writing. The ENFORCEMENT — that an
    // actually-attempted late takeover is refused — is `sealedValueStands`
    // below, which drives the in-transaction guard.
    expect(result.incumbentAfter.mint_status).toBe('eligible');
    expect(result.incumbentAfter.economic_snapshot)
      .toEqual(daemonHistory().economic_snapshot);
    expect(result.incumbentAfter.corroboration_status).toBeUndefined();
  });

  it('sealedValueStands: an ATTEMPTED late takeover is REFUSED at the transaction', async () => {
    // The load-bearing half of. The previous test shows the pre-check says
    // 'none'; this shows that even if a caller ignored that and drove the takeover
    // anyway, the in-transaction guard refuses — so the incumbent's sealed value
    // stands by ENFORCEMENT, not by nobody having tried.
    const db = createFakeFirestore() as unknown as Firestore;
    await seedDaemon(db);
    const prepared = await prepareCommitMintClaim(db, USER, COMMIT_SHA, DAEMON_PE, RECORDED_AT);
    const incumbentClaim = prepared.evidence.claim;
    await db.collection('commit_mint_claims').doc(incumbentClaim.claim_id)
      .set({ ...incumbentClaim } as unknown as FirebaseFirestore.DocumentData);

    // The window has lapsed, so the cron registers the incumbent for settlement.
    const lateInstant = RECORDED_AT + ATTESTATION_ENHANCEMENT_WINDOW_MS + 1;
    expect(commitTakeoverWindowOpen(daemonHistory(), lateInstant)).toBe(false);
    await registerClaim(db as unknown as SettlementDb, daemonLeg(), lateInstant);

    // Now force the takeover the pre-check would have declined.
    const plan = prepareCommitTakeoverPlan({
      incumbentClaim, newOwnerPeId: 'pe-forge-late', newOwnerUserId: USER, nowMs: lateInstant + 1,
    });
    await expect(
      db.runTransaction((txn) => inspectPreparedCommitTakeoverInTransaction(db, txn, plan)),
    ).rejects.toBeInstanceOf(MintOnceClaimRaceError);

    // …and the incumbent is untouched in both dimensions.
    const after = await db.collection(PE_HISTORY_COLLECTION).doc(DAEMON_PE).get();
    const data = (after.data() ?? {}) as Record<string, unknown>;
    expect(data.mint_status).toBe('eligible');
    expect(data.economic_snapshot).toEqual(daemonHistory().economic_snapshot);
  });

  it('RED — the SAME forced takeover SUCCEEDS when the incumbent is unregistered', async () => {
    // Without this, the refusal above could be caused by a malformed plan, a bad
    // fixture, or a guard that refuses everything — and would read as enforcement.
    // Identical setup minus the registration: the takeover is permitted.
    const db = createFakeFirestore() as unknown as Firestore;
    await seedDaemon(db);
    const prepared = await prepareCommitMintClaim(db, USER, COMMIT_SHA, DAEMON_PE, RECORDED_AT);
    const incumbentClaim = prepared.evidence.claim;
    await db.collection('commit_mint_claims').doc(incumbentClaim.claim_id)
      .set({ ...incumbentClaim } as unknown as FirebaseFirestore.DocumentData);

    const plan = prepareCommitTakeoverPlan({
      incumbentClaim, newOwnerPeId: 'pe-forge-early', newOwnerUserId: USER, nowMs: RECORDED_AT + 1,
    });
    const decision = await db.runTransaction(
      (txn) => inspectPreparedCommitTakeoverInTransaction(db, txn, plan),
    );
    expect(decision.incumbentPeId).toBe(DAEMON_PE);
    expect(decision.newOwnerClaim.owner_pe_id).toBe('pe-forge-early');
  });

  it('the two outcomes differ ONLY because of when settlement ran', async () => {
    // Without this, the pair above could both be passing for unrelated reasons —
    // a broken fixture, an unreadable base weight, a missing history row — and
    // read as a clean before/after. Same seed, same forge, same everything except
    // the cron's clock.
    const inside = await runInterleaving({
      settlementRunsAtMs: RECORDED_AT + 1,
      forgeArrivesAtMs: RECORDED_AT + 2,
    });
    const outside = await runInterleaving({
      settlementRunsAtMs: RECORDED_AT + ATTESTATION_ENHANCEMENT_WINDOW_MS,
      forgeArrivesAtMs: RECORDED_AT + ATTESTATION_ENHANCEMENT_WINDOW_MS + 1,
    });
    expect(inside.forgeAction).toBe('takeover');
    // outside the takeover window the forge corroborates instead of taking over.
    expect(outside.forgeAction).toBe('corroborate_incumbent');
    expect(inside.registered).toBe(false);
    expect(outside.registered).toBe(true);
  });

  it('RED — the deviation is caused by REGISTRATION, not by the clock itself', async () => {
    // The same late instant, but the cron never registers (simulating the row
    // being filtered for some other reason). The forge takes over. This isolates
    // the cause: a registered leg, not elapsed time — which matters, because a
    // reader could otherwise conclude the 72h boundary itself demotes the forge.
    const db = createFakeFirestore() as unknown as Firestore;
    await seedDaemon(db);
    const lateInstant = RECORDED_AT + ATTESTATION_ENHANCEMENT_WINDOW_MS + 1;
    expect(commitTakeoverWindowOpen(daemonHistory(), lateInstant)).toBe(false);
    // …and deliberately DO NOT register.
    expect(await evaluateCommitWitness(db, {
      incumbentPeId: DAEMON_PE, newBaseWeightBps: FORGE_BASE_BPS,
    })).toBe('takeover');
  });

  it('RED — mint-once holds in BOTH orders: exactly one witness is ever the winner', async () => {
    // The value dimension is what deviates; correctness must not. In the
    // deviating order the forge is refused the slot outright ('none'), and in the
    // holding order it takes the slot FROM the incumbent — never both owning it.
    const deviating = await runInterleaving({
      settlementRunsAtMs: RECORDED_AT + ATTESTATION_ENHANCEMENT_WINDOW_MS + 1,
      forgeArrivesAtMs: RECORDED_AT + ATTESTATION_ENHANCEMENT_WINDOW_MS + 2,
    });
    const holding = await runInterleaving({
      settlementRunsAtMs: RECORDED_AT + 1,
      forgeArrivesAtMs: RECORDED_AT + 2,
    });
    for (const r of [deviating, holding]) {
      // 'corroborate_incumbent' is the too-late outcome — a status stamp on the
      // incumbent, never a change of ownership.
      expect(['takeover', 'corroborate_incumbent']).toContain(r.forgeAction);
      // 'takeover' is only ever reachable while the incumbent is UNregistered,
      // which is exactly the no-strand rule stated as an assertion.
      if (r.forgeAction === 'takeover') expect(r.registered).toBe(false);
    }
  });
});
