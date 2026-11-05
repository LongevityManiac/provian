/**
 * settlement runtime — the ADDITIVE ATTESTATION TOP-UP inlet source.
 *
 * ── WHY THIS LANE EXISTS ─────────────────────────────────────────────────────
 * Settlement was DAILY on both lanes under (the standard lane is weekly again since
 * , plus the on-demand payout), so a corroborating attestation now
 * routinely lands AFTER a PE's act has registered or minted — but inside the PE's own
 * 30-day corroboration horizon (`attestationEnhancementWindowMsFor`). Before the
 * only place a verified attestation upgrade could raise value was the inline lift at
 * claim REGISTRATION (`claim-inlet-source.ts` → `corroborationLiftedRecordPointsAtomic`):
 * once the act's ledger row existed, its `record_points_atomic` was frozen and a later
 * corroboration was a record worth nothing. a weekly cadence and a 72h window that
 * was mostly invisible; under a daily cadence it would violate FC-003 — holding work and
 * evidence constant and moving only WHEN the witness lands must never lower total payout.
 *
 * This source makes FC-003 hold across the mint boundary with a FORWARD, ADDITIVE mint:
 * a separate, idempotent, distinctly claim-keyed standard-lane claim for exactly the
 * delta between the upgraded tier and the tier the act settled at. The same shape as
 * lineage attribution — never a rewind, never a re-derivation of the sealed row.
 *
 * ── THE INVARIANTS, AND WHERE EACH ONE IS ENFORCED ───────────────────────────
 * · SEALED-SNAPSHOT: this module READS `economic_snapshot` (through the same
 * `corroborationLiftedRecordPointsAtomic` the inline lift uses, which verifies the
 * snapshot hash before pricing) and the act's ledger row; it writes NOTHING to either.
 * The only write is a NEW ledger row, made by `registerClaim`.
 * · MINT-ONCE: the top-up's claim id is `deriveTopupClaimId` a domain-separated
 * content hash over the sealed identity, so it can never equal the act's id and never
 * drift; its ledger key is `claimKeyOf(pe, leg, 'attestation_topup')`. A corroboration
 * seen twice derives the same id (the id folds only pe+leg, never the amount), hits the
 * same document, and `registerClaim` answers identical — the first amount stands; a
 * second row is impossible: one top-up per leg, ever.
 * On chain the kernel dedupes on `claimSettled[claimId]` independently of all of this.
 * · ANTI-FARM: the delta is non-zero ONLY when `corroborationLiftedRecordPointsAtomic`
 * lifts — the SAME verification gate as the inline upgrade (a recognized third-party
 * `corroboration_status`, the sealed policy's `allowVerifiedAttestationUpgrade` or the
 * external-proof carve-out, no downgrade, observation inside the horizon). A row
 * that does not lift offers no candidate. Nothing here can be induced to mint twice.
 * · HORIZON: the lift itself refuses an observation past `recordedAt + window`; this
 * source additionally skips PEs recorded before `ATTESTATION_HORIZON_CUT_LINE_MS`
 * (pre-ship PEs are out of scope by ruling) and reads only rows whose corroboration
 * landed within the last two horizons (a bounded sweep; anything older would already
 * have been registered by an earlier daily run, and the lift refuses it anyway).
 * · FC-003 across the boundary: original (act row) + top-up (delta) == the value the act
 * would have settled at had the witness landed before registration. Pinned by
 * `attestation-topup.test.ts` ("witness BEFORE" vs "witness AFTER" registration/mint).
 *
 * ── WHAT IS DELIBERATELY OUT OF SCOPE ────────────────────────────────────────
 * Lineage attribution is a separate forward mechanism and is not
 * read here. Genesis rows (`is_genesis_grant`) have no upgrade path (`fixedGrantSource`
 * disables the settlement adjustment) and are skipped by construction; forced-neutral and
 * chain-final rows never lift, so they never produce a candidate.
 *
 * ── PAGING ───────────────────────────────────────────────────────────────────
 * Ordered by `corroboration_received_at` ascending with a single-value cursor (the last
 * value read). A same-millisecond tie at a page boundary can be skipped by Firestore's
 * single-value `startAfter`; the run exhausts and wraps to the top on every ordinary day,
 * so such a row is offered on the next daily run. Bounded and self-healing, never wedged.
 */

import type { PEHistoryDocument } from '../../../pe-history';
import {
  ATTESTATION_HORIZON_CUT_LINE_MS,
  ATTESTATION_ENHANCEMENT_HORIZON_MS,
} from '../policy/monetary-accounting';
import {
  corroborationLiftedRecordPointsAtomic,
  currentAttestationTier,
} from '../policy/economic-projection';
import { BeneficiaryClass } from '../wp-ev/settlement-batch';
import { PAYOUT_LEG_ROLES, type PayoutLegRole } from '../wp-ev/payout-legs';
import type { InletPage, InletPeSource, StandardInletCandidate } from './claim-inlet';
import {
  ENVELOPES_COLLECTION,
  PE_HISTORY_COLLECTION,
  isChainStartSentinel,
  projectEligibility,
  sealedIdentityOf,
} from './claim-inlet-source';
import { CLAIM_LEDGER_COLLECTION, claimKeyOf, normalizePeId, type SettlementDb } from './durable-settlement-store';
import { PE_SPLIT_COLLECTION, parseFrozenSplit } from './pe-split';

export interface AttestationTopupInletSourceDeps {
  readonly db: SettlementDb;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
}

/** The `mint_status` values an act may hold while a top-up may still be owed on it. */
const TOPUP_ELIGIBLE_ACT_STATUSES: ReadonlySet<string> = new Set(['eligible', 'minted']);

const ATOMIC = /^(0|[1-9][0-9]*)$/;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The lower bound of the corroboration sweep: two horizons back, never before the cut
 * line (a corroboration on a pre-cut-line PE cannot land before the PE, and pre-cut-line
 * PEs are out of scope regardless).
 */
export function topupSweepFloorMs(nowMs: number): number {
  return Math.max(ATTESTATION_HORIZON_CUT_LINE_MS, nowMs - 2 * ATTESTATION_ENHANCEMENT_HORIZON_MS);
}

/** One act-kind ledger row of the PE, as the delta split reads it. */
export interface ActLegRow {
  readonly leg: PayoutLegRole;
  readonly pointsAtomic: bigint;
}


export function topupDeltasFor(
  liftedTotalAtomic: bigint,
  actRows: readonly ActLegRow[],
): Array<{ leg: PayoutLegRole; deltaAtomic: bigint }> {
  const rows = [...actRows]
    .filter((r) => r.pointsAtomic >= 0n)
    .sort((a, b) => PAYOUT_LEG_ROLES.indexOf(a.leg) - PAYOUT_LEG_ROLES.indexOf(b.leg));
  if (rows.length === 0) return [];
  const settled = rows.reduce((sum, r) => sum + r.pointsAtomic, 0n);
  const deltaTotal = liftedTotalAtomic - settled;
  if (deltaTotal <= 0n || settled <= 0n) return [];
  const out: Array<{ leg: PayoutLegRole; deltaAtomic: bigint }> = [];
  let assigned = 0n;
  rows.forEach((r, i) => {
    const share = i === rows.length - 1
      ? deltaTotal - assigned
      : (deltaTotal * r.pointsAtomic) / settled;
    assigned += share;
    if (share > 0n) out.push({ leg: r.leg, deltaAtomic: share });
  });
  return out;
}

export function createAttestationTopupInletSource(
  deps: AttestationTopupInletSourceDeps,
): InletPeSource {
  const { db } = deps;
  const nowMs = deps.now ?? Date.now;
  const linkageMemo = new Map<string, boolean>();

  async function isChainLinked(prevHash: string): Promise<boolean> {
    if (isChainStartSentinel(prevHash)) return true;
    const memoized = linkageMemo.get(prevHash);
    if (memoized !== undefined) return memoized;
    const snap = await db.collection(ENVELOPES_COLLECTION)
      .where('hash', '==', prevHash)
      .limit(1)
      .get();
    const linked = snap.docs.length > 0;
    linkageMemo.set(prevHash, linked);
    return linked;
  }

  return {
    async loadPage({ pageSize, startAfterKey }): Promise<InletPage> {
      const floor = topupSweepFloorMs(nowMs());
      let query = db.collection(PE_HISTORY_COLLECTION)
        .where('corroboration_received_at', '>=', floor)
        .orderBy('corroboration_received_at', 'asc')
        .limit(pageSize);
      // The cursor is the last `corroboration_received_at` read, as a decimal string.
      if (startAfterKey !== undefined && /^\d+$/.test(startAfterKey)) {
        query = query.startAfter(Number(startAfterKey));
      }
      const page = await query.get();

      const candidates: StandardInletCandidate[] = [];
      let lastKey: string | undefined;
      let considered = 0;
      // Act sets whose rows sum to neither the sealed base nor the lifted total — the
      // partial/mixed shapes the exact-split rule refuses. Logged so an operator can see a
      // stranded (under-paid) PE rather than have it vanish silently; never paid by guess.
      let nonUniformActSets = 0;

      for (const doc of page.docs) {
        const history = doc.data() ?? {};
        const peId = str(history.peId) ?? doc.id;
        const observedAt = history.corroboration_received_at;
        // Advanced for EVERY row read, before any filtering (the same cursor rule as the
        // standard source: a cursor that only advanced past offered rows would rewind).
        if (typeof observedAt === 'number' && Number.isFinite(observedAt)) {
          lastKey = String(Math.trunc(observedAt));
        }

        // Scope fences, cheapest first. Each is a skip, never a drop: the row is re-read
        // on the next sweep like every other filtered row.
        const recordedAt = history.timestamp;
        if (typeof recordedAt !== 'number' || !Number.isFinite(recordedAt)) continue;
        if (recordedAt < ATTESTATION_HORIZON_CUT_LINE_MS) continue; // pre-ship PE: out of scope
        if (history.is_genesis_grant === true) continue; // no upgrade path by construction
        const mintStatus = history.mint_status;
        if (typeof mintStatus !== 'string' || !TOPUP_ELIGIBLE_ACT_STATUSES.has(mintStatus)) continue;
        const base = history.record_points_atomic;
        if (typeof base !== 'string' || !ATOMIC.test(base)) continue;

        // THE GATE. The same function the inline lift uses: recognized corroboration,
        // sealed-policy authorization (or the carve-out), no downgrade, observation
        // inside the PE's own horizon. Verbatim base ⇒ no upgrade ⇒ nothing owed.
        const lifted = corroborationLiftedRecordPointsAtomic(history as unknown as PEHistoryDocument);
        if (lifted === base || !ATOMIC.test(lifted) || BigInt(lifted) <= BigInt(base)) continue;
        const tier = currentAttestationTier(history as unknown as PEHistoryDocument);
        if (tier === null) continue;
        considered += 1;

        // THE ACT'S OWN ROWS — every claim-ledger row of this PE, read once. The act legs
        // (kind `act`) carry the frozen split the delta is distributed over; any top-up rows
        // already present tell us which legs are done. No payee is re-resolved here.
        const ledgerSnap = await db.collection(CLAIM_LEDGER_COLLECTION)
          .where('pe_key', '==', normalizePeId(peId))
          .get();
        const actRows = new Map<PayoutLegRole, Record<string, unknown>>();
        const toppedUp = new Set<PayoutLegRole>();
        for (const legDoc of ledgerSnap.docs) {
          const row = legDoc.data() ?? {};
          if (row.lane !== 'standard') continue;
          const leg = row.leg;
          if (typeof leg !== 'string' || !(PAYOUT_LEG_ROLES as readonly string[]).includes(leg)) continue;
          if (row.claim_kind === 'attestation_topup') toppedUp.add(leg as PayoutLegRole);
          else actRows.set(leg as PayoutLegRole, row);
        }
        if (actRows.size === 0) continue; // act not registered yet: the inline lift will carry it
        // Legs already topped up are skipped PER LEG below, never the PE whole (round-3
        // reviewer): a run that died between two legs' registrations must repair the missing
        // leg on the next run, or the stranded leg (typically the human beneficiary's share)
        // would never mint. Mint-once does not depend on this check — `deriveTopupClaimId`
        // folds only (pe, leg), so a re-offer hits the same doc id and `registerClaim`
        // answers identical — and the split is computed from the act rows, which are frozen,
        // so a leg registered later carries exactly the share it would have carried earlier.

        // a FROZEN split is the authority on the act's legs. The delta is distributed
        // over the frozen legs, paid to the frozen payees, and computed against the total the
        // split was cut from — never over "whatever rows exist". Every frozen leg's act row must
        // be present and agree with the split (the act inlet writes them in one transaction, so
        // anything else is a split being corrected: skipped and counted, never guessed).
        const peKey = normalizePeId(peId);
        const splitSnap = await db.collection(PE_SPLIT_COLLECTION).doc(peKey).get();
        const actLegs: ActLegRow[] = [];
        // round 2 — with a frozen split the delta is cut over ALL frozen legs at their
        // FROZEN points (so every leg's share is fixed by the split, not by which rows happen to
        // exist), and offered PER LEG only where that leg's act row exists and matches. A frozen
        // leg with no row yet (one a per-claim check withheld, or a leg-sum correction left to
        // fill) must not withhold its siblings' lift; it receives its own delta in the same transaction that
        // registers it late (`registerFrozenSplitClaims` → `lateLiftTopupInputs`).
        let payableLegs: ReadonlySet<PayoutLegRole> | null = null;
        let malformed = false;
        if (splitSnap.exists) {
          const parsed = parseFrozenSplit(splitSnap.data(), peKey);
          if (parsed.kind !== 'valid') { nonUniformActSets += 1; continue; }
          // A row outside the frozen split is never a leg the delta may be spread over.
          if ([...actRows.keys()].some((leg) => !parsed.split.legs.some((frozen) => frozen.leg === leg))) {
            nonUniformActSets += 1;
            continue;
          }
          const payable = new Set<PayoutLegRole>();
          for (const frozenLeg of parsed.split.legs) {
            actLegs.push({ leg: frozenLeg.leg, pointsAtomic: BigInt(frozenLeg.record_points_atomic) });
            const row = actRows.get(frozenLeg.leg);
            if (row !== undefined && row.claim_id === frozenLeg.claim_id
              && row.contributor === frozenLeg.contributor
              && row.record_points_atomic === frozenLeg.record_points_atomic
              && row.beneficiary_class === frozenLeg.beneficiary_class) {
              payable.add(frozenLeg.leg);
            } else if (row !== undefined) {
              nonUniformActSets += 1; // a row disagreeing with its frozen leg: that leg is never paid a delta
            }
          }
          payableLegs = payable;
        } else {
          for (const [leg, row] of actRows) {
            const pts = row.record_points_atomic;
            if (typeof pts !== 'string' || !ATOMIC.test(pts)) { malformed = true; break; }
            actLegs.push({ leg, pointsAtomic: BigInt(pts) });
          }
          if (malformed) continue;
        }
        // ONE UNIFORM SPLIT (round-4 + round-5 reviewers): the act rows must sum to EXACTLY
        // the PE's sealed base. Two failure shapes hide behind anything looser. (a) PARTIAL:
        // the standard inlet registers one leg per transaction, so a run that died between two
        // legs leaves rows that sum to LESS than base; `lifted − Σ` would then include the
        // missing leg's whole base share and hand it to the present leg. (b) MIXED: if the
        // corroboration lands in that gap, the act inlet re-prices the late leg from the
        // LIFTED total while its sibling still carries the BASE split; the rows then sum to
        // something strictly between base and lifted, and a proportional split over them
        // moves value between legs against the sealed routing snapshot. A mixed set can sum
        // to exactly `base` only when the late leg's lift delta is zero, in which case there
        // is nothing to misallocate. `Σ == lifted` is a set registered wholly post-lift and
        // owes nothing; any other value is unknown ⇒ block (skipped, counted, never guessed).
        // Residual, stated: a genuinely mixed set is left UNDER-paid by the stale leg's delta
        // (never over, never misdirected) — the act rows carry no record of the total they
        // were split from, so the stale leg cannot be told from the re-priced one.
        const settledBase = actLegs.reduce((sum, r) => sum + r.pointsAtomic, 0n);
        if (settledBase !== BigInt(base)) {
          if (settledBase !== BigInt(lifted)) nonUniformActSets += 1;
          continue;
        }
        const deltas = topupDeltasFor(BigInt(lifted), actLegs);
        if (deltas.length === 0) continue;

        // Identity + eligibility are projected from the SEALED envelope exactly as the act's
        // were; `runClaimInlet` re-evaluates eligibility and derives the top-up id from it.
        const envelopeSnap = await db.collection(ENVELOPES_COLLECTION).doc(peId).get();
        const envelope = envelopeSnap.exists ? (envelopeSnap.data() ?? {}) : null;
        const identity = envelope === null ? null : sealedIdentityOf(peId, envelope);
        const chainVerified = identity === null ? false : await isChainLinked(identity.prev_hash);
        const projected = projectEligibility({ peId, history, envelope, identity, chainVerified });
        // `evaluateEligibility` allowlists `relayMintStatus === 'eligible'` because a `minted`
        // ACT settled again is a double mint the kernel cannot detect. A top-up is not the
        // act settled again: it is a DISTINCT claim on the same sealed evidence, guarded by
        // its own kind-keyed identity, the act-row requirement inside `registerClaim`, and
        // the kernel's per-claim dedupe. The question the evaluator must answer for it is
        // "was this act eligible on its sealed evidence?", so a minted act is presented as
        // `eligible` HERE ONLY; every other check (chain linkage, signature, seal, tier)
        // runs unchanged on the real record.
        const eligibility = mintStatus === 'minted'
          ? { ...projected, relayMintStatus: 'eligible' }
          : projected;

        for (const { leg, deltaAtomic } of deltas) {
          if (toppedUp.has(leg)) continue;
          if (payableLegs !== null && !payableLegs.has(leg)) continue; // per leg, never per PE
          const act = actRows.get(leg)!;
          const contributor = str(act.contributor);
          const beneficiaryClass = act.beneficiary_class;
          if (contributor === null || typeof beneficiaryClass !== 'number') continue;
          candidates.push({
            peId,
            leg,
            lane: 'standard',
            eligibility,
            // Pays whoever the ACT paid — the act row's own contributor — never a re-resolved
            // address. The delta is owed on that settlement, to that payee.
            contributor,
            recordPointsAtomic: deltaAtomic.toString(),
            beneficiaryClass: beneficiaryClass as BeneficiaryClass,
            topup: {
              ofClaimKey: claimKeyOf(peId, leg),
              attestationTier: tier,
              observedAtMs: Math.trunc(observedAt as number),
            },
          });
        }
      }

      deps.log?.(
        `topup-inlet-source: page read=${page.docs.length} lifted=${considered} offered=${candidates.length} non_uniform_act_sets=${nonUniformActSets}`,
      );
      return { candidates, readCount: page.docs.length, lastKey };
    },
  };
}
