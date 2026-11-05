/**
 * Agent Bank - Scheduled Jobs
 *
 * Three Cloud Scheduler-triggered functions:
 *   1. Auto-release funded escrows past autoReleaseAt
 *   2. Mark defaulted promises past deadline
 *   3. Refund expired pools that didn't reach threshold
 *
 * These run hourly via Cloud Scheduler hitting internal HTTP endpoints.
 *
 * Escrow auto-release (WS1): `processAutoReleases` performs the REAL on-chain
 * release via the dedicated gas-only EOA (`AgentBankDeps.escrowChain`, backed
 * by `ESCROW_RELEASE_KEY`) before flipping any Firestore status. Only escrows
 * whose funds actually moved on-chain (or were already released by the
 * depositor) are marked 'completed'; the rest stay 'funded' for the next tick.
 * Promise default (relay-observed leg) + pool refund transitions are
 * Firestore-only (their on-chain effects are agent- or permissionless-driven);
 * the relay-observed default seals no PE — only the lender's on-chain-proven
 * `markDefault` upgrade does (see `processDefaults`).
 */

import type { AgentBankDeps } from './types';
import type { EscrowDocument, EscrowSettleResult } from './types';

// Cap on-chain releases per cron tick to bound request runtime: each release
// is a sequential tx + wait(1) on the gas-only EOA, which shares one nonce
// sequence. Past-timeout escrows beyond the cap are picked up next tick. We
// log when the cap truncates a run (no silent cap).
const MAX_ONCHAIN_RELEASES_PER_RUN = 25;

// Same rationale for the pool refund keeper (P4-02): each refundPool is a
// sequential tx + wait(1) on the gas-only EOA's single nonce. Expired pools beyond
// the cap are picked up next tick; the cap is logged when it truncates a run.
const MAX_ONCHAIN_POOL_REFUNDS_PER_RUN = 25;
import type { PoolDocument } from './types';
import type { PromiseDocument } from './types';
import type { BondDocument, BondClaimDocument } from './types';
import type { AgentWalletDocument } from '../agent-wallet/types';
import { generateSchedulerPE as generatePE } from './pe-utils';
import { enqueueAgentBankEvent } from './event-outbox';
import { invalidateHandshakes } from '../rail/invalidation';
import { creditEscrowStatsOnce, claimCompletionEmission } from './escrow';
import { settleLinkedJobsForEscrow, settlementReceipt } from './job-settlement';
import { bondPoolAddressForChain, chainIdForChain, observeBondClaimSettlement } from './bonds';
import {
  readOnchainBondStatus,
  recoverEvmBondAbandoned,
  recoverEvmClaimExpired,
} from '../onchain/tx-verifier';
import {
  evaluateInstitutionTransition,
  type ReceiptEvidence,
} from './institution-state-machine';

// ---------------------------------------------------------------------------
// 1. Auto-release funded escrows past autoReleaseAt
// ---------------------------------------------------------------------------

export async function processAutoReleases(deps: AgentBankDeps): Promise<number> {
  const now = Date.now();
  const snapshot = await deps.db.collection('escrows')
    .where('status', '==', 'funded')
    .where('auto_release_at', '<=', now)
    .limit(500) // #10: increased batch size from 100 to 500
    .get();

  if (snapshot.empty) return 0;

  // WS1: perform the REAL on-chain release before flipping Firestore. The
  // gas-only EOA shares one nonce sequence, so releases run sequentially;
  // only escrows whose funds actually moved on-chain (or already had) are
  // marked 'completed' — the rest stay 'funded' for the next tick. This
  // replaces the prior behavior that blindly flipped status to 'completed'
  // while the contract kept the funds locked.
  if (!deps.escrowChain) {
    console.error(
      `[Scheduler] ${snapshot.size} escrow(s) past auto-release but escrowChain is not wired; ` +
        'leaving them funded (NOT marking completed) to avoid claiming an unreleased payout.',
    );
    return 0;
  }

  // Loop 1: perform the REAL on-chain release per escrow (sequential; the gas-EOA
  // shares one nonce). Collect only escrows whose funds actually moved on-chain
  // (or already had). Pass-3 #17: we do NOT flip Firestore status → 'completed'
  // here anymore — the flip is folded into the ATOMIC credit (loop 2), so a crash
  // before the credit leaves the escrow 'funded' and the next tick re-settles
  // (already_released) + retries the credit, instead of stranding it 'completed'
  // with the credit permanently suppressed (it would no longer match this
  // status=='funded' query).
  const escrows: {
    doc: FirebaseFirestore.QueryDocumentSnapshot;
    data: EscrowDocument;
    settle: EscrowSettleResult;
  }[] = [];
  let attempted = 0;
  for (const doc of snapshot.docs) {
    const escrow = doc.data() as EscrowDocument;
    if (attempted >= MAX_ONCHAIN_RELEASES_PER_RUN) {
      console.warn(
        `[Scheduler] Auto-release cap (${MAX_ONCHAIN_RELEASES_PER_RUN}) reached; ` +
          `${snapshot.size - attempted} past-timeout escrow(s) deferred to the next tick.`,
      );
      break;
    }
    attempted++;
    let settle: EscrowSettleResult;
    try {
      settle = await deps.escrowChain.settle(escrow);
    } catch (err) {
      console.error(`[Scheduler] Auto-release settle threw for escrow ${escrow.escrow_id}:`, err);
      continue;
    }
    if (settle.status !== 'released' && settle.status !== 'already_released') {
      console.warn(
        `[Scheduler] Escrow ${escrow.escrow_id} NOT released on-chain (${settle.status}` +
          `${settle.reason ? `: ${settle.reason}` : ''}); left funded for retry.`,
      );
      continue;
    }
    escrows.push({ doc, data: escrow, settle });
    console.log(
      `[Scheduler] Escrow ${escrow.escrow_id} on-chain ${settle.status}` +
        `${settle.txHash ? ` (tx ${settle.txHash})` : ''}`,
    );
  }

  if (escrows.length === 0) return 0;

  // WP7: advance any linked agent-to-agent /v1/jobs board docs AND Commons
  // human-job docs through the ONE receipt-gated settlement path
  // (evaluateInstitutionTransition — guarded, idempotent by the settlement tx
  // hash, fail-closed: no receipt hash ⇒ the job stays un-advanced for the
  // next tick rather than recording an evidence-free economic transition).
  // Best-effort relative to the escrow credit below — the funds already moved
  // on-chain, so a failure here must NOT abort that credit; each settled
  // escrow carries its own release receipt ('released' = the fresh tx,
  // 'already_released' = the recovered on-chain release event's tx).
  for (const { data: escrow, settle } of escrows) {
    await settleLinkedJobsForEscrow(
      deps,
      escrow,
      'completed',
      settlementReceipt(settle.txHash ?? escrow.release_tx_hash),
      now,
    );
  }

  // Collect all unique wallet IDs and batch-read them
  const walletIds = new Set<string>();
  for (const { data } of escrows) {
    walletIds.add(data.depositor_wallet_id);
    walletIds.add(data.recipient_wallet_id);
  }

  const walletMap = await batchReadWallets(deps, walletIds);

  let processed = 0;
  for (const { doc, data: escrow, settle } of escrows) {
    try {
      const currency = escrow.currency ?? 'usdc';
      const autoReleaseMeta = (role: 'depositor' | 'recipient'): Record<string, unknown> => {
        const m: Record<string, unknown> = {
          escrow_id: escrow.escrow_id,
          currency,
          auto_released: true,
          role,
        };
        if (currency === 'pvt') {
          m.amount_pvt = escrow.amount_pvt;
          m.fee_pvt = escrow.fee_pvt;
          if (role === 'recipient') {
            m.net_to_recipient_pvt = escrow.net_to_recipient_pvt;
          }
        } else {
          m.amount_usdc = escrow.amount_usdc;
          m.fee_usdc = escrow.fee_usdc;
          if (role === 'recipient') {
            m.net_to_recipient_usdc = escrow.net_to_recipient_usdc;
          }
        }
        return m;
      };

      // #17: atomic credit + status→completed flip (creditEscrowStatsOnce is the
      // single-winner gate for the MONEY — the first path to set stats_credited wins;
      // a concurrent completeEscrow or overlapping tick gets `false`). A crash before
      // this leaves status='funded' for the next tick to retry (no suppressed credit).
      const credited = await creditEscrowStatsOnce(deps, doc.ref, escrow, now, {
        status: 'completed',
        completed_at: now,
        auto_released: settle.status === 'released',
        ...(settle.txHash ? { release_tx_hash: settle.txHash } : {}),
        ...(settle.onchainId ? { onchain_escrow_id: settle.onchainId } : {}),
      });

      // Pass-3 review: emit the escrow_completed PEs under a SEPARATE atomic
      // single-winner claim (claimCompletionEmission), shared with completeEscrow, so
      // a scheduler-vs-completeEscrow race (or an overlapping tick) can never append
      // DUPLICATE completion PEs. Independent of the credit: if a prior path credited
      // but crashed before emitting, this tick still wins the emission claim + recovers.
      if (await claimCompletionEmission(deps, doc.ref, now)) {
        const emitted: string[] = [];
        const depositor = walletMap.get(escrow.depositor_wallet_id);
        if (depositor) {
          const { peId } = await generatePE(deps, {
            walletId: escrow.depositor_wallet_id,
            agentId: depositor.agent_id,
            actorAddress: depositor.address,
            actionType: 'escrow_completed',
            metadata: autoReleaseMeta('depositor'),
            counterpartyAddress: escrow.recipient_address,
          });
          emitted.push(peId);
        }
        const recipient = walletMap.get(escrow.recipient_wallet_id);
        if (recipient) {
          const { peId } = await generatePE(deps, {
            walletId: escrow.recipient_wallet_id,
            agentId: recipient.agent_id,
            actorAddress: recipient.address,
            actionType: 'escrow_completed',
            metadata: autoReleaseMeta('recipient'),
            counterpartyAddress: escrow.depositor_address,
          });
          emitted.push(peId);
        }
        if (emitted.length > 0) {
          const { FieldValue } = await import('firebase-admin/firestore');
          await doc.ref.update({
            pe_ids: FieldValue.arrayUnion(...emitted),
            completion_pe_ids: emitted,
            updated_at: now,
          });
        }
      }

      if (credited) processed++;
      console.log(`[Scheduler] Auto-released escrow ${escrow.escrow_id} (${currency})`);
    } catch (err) {
      console.error(`[Scheduler] Auto-release PE error for escrow ${escrow.escrow_id}:`, err);
    }
  }

  return processed;
}

// ---------------------------------------------------------------------------
// 2. Mark defaulted promises past deadline
// ---------------------------------------------------------------------------

/**
 * D-430 addendum (Frank 2026-09-11) — RELAY-OBSERVED default sweep, the FIRST of
 * the two default paths (the second is the lender's on-chain-proven `markDefault`
 * via `defaultPromise`). Frank's ruling: BOTH.
 *
 * After a funded promise passes its deadline the relay marks it `defaulted`
 * automatically — no lender action, no on-chain proof — recording
 * `default_proof: 'relay_observed'` so the borrower's reputation snapshot
 * (`promises_defaulted`, counted from this collection's status) reflects it at
 * once and feeds the governance-score floor future lenders read. A lender's
 * verified on-chain `markDefault` event later UPGRADES the row to
 * `onchain_proven` (`defaultPromise`), and — because on chain the promise is still
 * `Funded` and settleable until then — a borrower who genuinely repays on chain
 * can still CURE a relay-observed default through `settlePromise`.
 *
 * This flip carries NO on-chain proof, so it seals NO PE and mints nothing (the
 * status-counted reputation snapshot needs none); the on-chain-proven upgrade is
 * what emits the `promise_defaulted` PE pair. The prior D-430 no-op was replaced
 * because Frank ruled the relay-observed default a legitimate, distinct, weaker
 * signal rather than a "false ding". The cron endpoint + Cloud Scheduler job are
 * unchanged (the D-288 reconcile gate is unaffected).
 */
const MAX_RELAY_OBSERVED_DEFAULTS_PER_RUN = 500;

export async function processDefaults(deps: AgentBankDeps): Promise<number> {
  const now = Date.now();
  const snapshot = await deps.db.collection('promises')
    .where('status', '==', 'funded')
    .where('deadline', '<=', now)
    .limit(MAX_RELAY_OBSERVED_DEFAULTS_PER_RUN)
    .get();

  if (snapshot.empty) return 0;

  let processed = 0;
  for (const doc of snapshot.docs) {
    const promise = doc.data() as PromiseDocument;
    // A funded promise always pinned its on-chain id at fund time. Without one we
    // cannot bind this row to a real on-chain funding — Unknown = Block: skip it,
    // never mark it defaulted. (`defaultPromise` enforces the same guard.)
    if (!promise.onchain_promise_id) continue;

    // Transactional flip funded → defaulted (relay_observed). The re-read inside
    // the tx is the single-writer guard: if a concurrent lender default already
    // proved it (onchain_proven) or the borrower settled it, the tx sees a
    // non-funded status and skips — the stronger/proven outcome always wins.
    let flipped = false;
    try {
      await deps.db.runTransaction(async (tx) => {
        const fresh = await tx.get(doc.ref);
        if (!fresh.exists) return;
        const freshDoc = fresh.data() as PromiseDocument;
        if (freshDoc.status !== 'funded') return;      // already moved
        if (Date.now() < freshDoc.deadline) return;    // deadline defense
        tx.update(doc.ref, {
          status: 'defaulted',
          defaulted_at: now,
          default_proof: 'relay_observed',
          updated_at: now,
        });
        flipped = true;
      });
    } catch (err) {
      console.error(`[Scheduler] Relay-observed default flip threw for promise ${promise.promise_id}:`, err);
      continue;
    }
    if (!flipped) continue;

    // Outbox to BOTH parties: the borrower's reputation is affected; the lender is
    // the counterparty who may follow with an on-chain markDefault to upgrade the
    // proof. `proof: 'relay_observed'` distinguishes it from the proven event the
    // /default route enqueues. A failed enqueue is a missed notification, not a
    // lost default (the status flip already committed) — log and continue.
    const lenderWalletId = promise.lender_wallet_id;
    try {
      await enqueueAgentBankEvent(deps.db, {
        walletId: promise.borrower_wallet_id,
        eventType: 'promise_defaulted',
        transactionAmount: 0,
        entityId: promise.promise_id,
        entityType: 'promise',
        recipients: [promise.borrower_wallet_id],
        ...(lenderWalletId ? { counterparties: { [promise.borrower_wallet_id]: lenderWalletId } } : {}),
        data: { currency: promise.currency ?? 'usdc', proof: 'relay_observed' },
      });
      if (lenderWalletId) {
        await enqueueAgentBankEvent(deps.db, {
          walletId: lenderWalletId,
          eventType: 'promise_defaulted',
          transactionAmount: 0,
          entityId: promise.promise_id,
          entityType: 'promise',
          recipients: [lenderWalletId],
          counterparties: { [lenderWalletId]: promise.borrower_wallet_id },
          data: { currency: promise.currency ?? 'usdc', proof: 'relay_observed' },
        });
      }
    } catch (err) {
      console.error(`[Scheduler] Relay-observed default outbox enqueue failed for promise ${promise.promise_id}:`, err);
    }
    processed++;
  }
  return processed;
}

// ---------------------------------------------------------------------------
// 3. Refund expired pools that didn't reach threshold
// ---------------------------------------------------------------------------

export async function processExpiredPools(deps: AgentBankDeps): Promise<number> {
  const now = Date.now();
  const snapshot = await deps.db.collection('pools')
    .where('status', '==', 'open')
    .where('deadline', '<=', now)
    .limit(500) // #10: increased batch size from 100 to 500
    .get();

  if (snapshot.empty) return 0;

  const pools: { doc: FirebaseFirestore.QueryDocumentSnapshot; data: PoolDocument }[] =
    snapshot.docs.map((doc) => ({ doc, data: doc.data() as PoolDocument }));

  // P4-02: perform the REAL on-chain refundPool before flipping Firestore. The
  // gas-only keeper EOA shares one nonce sequence, so refunds run sequentially;
  // only pools whose funds actually moved on-chain (or were already Refunded) are
  // marked 'refunded' + emit a pool_refunded PE — the rest stay 'open' for the next
  // tick. This replaces the prior behavior that blindly flipped every expired pool
  // to 'refunded' + emitted a pool_refunded PE while the contract kept the funds
  // locked. Pools with zero contributions have nothing on-chain to refund and are
  // flipped directly (no keeper, no PE).
  const walletIdsToRead = new Set<string>();
  for (const { data: pool } of pools) {
    for (const walletId of Object.keys(pool.contributions)) walletIdsToRead.add(walletId);
  }
  const walletMap = await batchReadWallets(deps, walletIdsToRead);

  let processed = 0;
  let onchainAttempts = 0;
  let keeperUnavailableFundedPools = 0;

  for (const { doc, data: pool } of pools) {
    try {
      const hasContributors = Object.keys(pool.contributions).length > 0;

      // Zero-contribution expired pool: no funds on-chain to return. Flip directly
      // (truthful — no PE asserting a refund of funds).
      if (!hasContributors) {
        await doc.ref.update({ status: 'refunded', refunded_at: now, updated_at: now });
        processed++;
        console.log(`[Scheduler] Closed empty expired pool ${pool.pool_id} (no contributions)`);
        continue;
      }

      // Funded (has contributors) → needs the on-chain refund. Fail closed without
      // a keeper: leave the pool 'open', assert nothing.
      if (!deps.poolKeeper?.canSign()) {
        keeperUnavailableFundedPools++;
        continue;
      }

      if (onchainAttempts >= MAX_ONCHAIN_POOL_REFUNDS_PER_RUN) {
        console.warn(
          `[Scheduler] Pool refund cap (${MAX_ONCHAIN_POOL_REFUNDS_PER_RUN}) reached; ` +
            `remaining past-deadline pool(s) deferred to the next tick.`,
        );
        break;
      }
      onchainAttempts++;

      let refund;
      try {
        refund = await deps.poolKeeper.refundExpiredPool(pool);
      } catch (err) {
        console.error(`[Scheduler] Pool refund keeper threw for pool ${pool.pool_id}:`, err);
        continue;
      }

      if (refund.status !== 'refunded' && refund.status !== 'already_refunded') {
        console.warn(
          `[Scheduler] Pool ${pool.pool_id} NOT refunded on-chain (${refund.status}` +
            `${refund.reason ? `: ${refund.reason}` : ''}); left open for retry.`,
        );
        continue;
      }

      // Refund CONFIRMED on-chain (this tick, or already Refunded). Flip Firestore +
      // emit a truthful, currency-aware pool_refunded PE per contributor. Flipping the
      // status removes the pool from this query, so the PEs are emitted at most once.
      await doc.ref.update({
        status: 'refunded',
        refunded_at: now,
        ...(refund.txHash ? { refund_tx_hash: refund.txHash } : {}),
        updated_at: now,
      });

      // Emit ONLY for contributors the keeper confirmed on-chain as real members of
      // this pool's contributorList (whom refundPool actually paid). A Firestore-only
      // "contributor" (e.g. a bare transfer that was never a real on-chain contribute)
      // is not in the set, so no PE ever asserts a refund that didn't happen for them.
      const refundedWalletIds = new Set(refund.confirmedContributorWalletIds ?? []);
      const refundCurrency = pool.currency ?? 'usdc';
      for (const [walletId, contribution] of Object.entries(pool.contributions)) {
        if (!refundedWalletIds.has(walletId)) continue;
        const wallet = walletMap.get(walletId);
        if (!wallet) continue;

        const metadata: Record<string, unknown> = {
          pool_id: pool.pool_id,
          currency: refundCurrency,
          reason: 'deadline_expired',
          onchain_refund_confirmed: true,
          // Present only when the keeper performed the refund this tick (fresh-PE
          // provenance — part of this envelope's hashed content, never mutates a
          // sealed PE).
          ...(refund.txHash ? { refund_tx_hash: refund.txHash } : {}),
        };
        if (refundCurrency === 'pvt') {
          metadata.refunded_pvt = contribution.amount_pvt ?? '0';
        } else {
          metadata.refunded_usdc = contribution.amount_usdc;
        }

        await generatePE(deps, {
          walletId,
          agentId: wallet.agent_id,
          actorAddress: wallet.address,
          actionType: 'pool_refunded',
          metadata,
        });

        // D-416: notify the refunded contributor so they learn the pool expired
        // and their contribution returned, without polling. notify-only.
        await enqueueAgentBankEvent(deps.db, {
          walletId,
          eventType: 'pool_refunded',
          transactionAmount: 0,
          entityId: pool.pool_id,
          entityType: 'pool',
          recipients: [walletId],
          data: { currency: refundCurrency, reason: 'deadline_expired', ...(refund.txHash ? { refund_tx_hash: refund.txHash } : {}) },
          notifyOnly: true,
        }).catch((err) => console.error('[Scheduler] pool_refunded event enqueue failed:', err));
      }

      processed++;
      console.log(
        `[Scheduler] Refunded expired pool ${pool.pool_id} on-chain (${refund.status}` +
          `${refund.txHash ? ` tx ${refund.txHash}` : ''})`,
      );
    } catch (err) {
      console.error(`[Scheduler] Pool refund error for pool ${pool.pool_id}:`, err);
    }
  }

  if (keeperUnavailableFundedPools > 0) {
    console.error(
      `[Scheduler] ${keeperUnavailableFundedPools} expired funded pool(s) past deadline but poolKeeper is not ` +
        'configured (POOL_KEEPER_KEY unset); leaving them open (NOT marking refunded) to avoid claiming an ' +
        'unperformed refund.',
    );
  }

  return processed;
}

// =============================================================================
// SHARED HELPER: Batch wallet reads (#5 fix - eliminates N+1 pattern)
// =============================================================================

async function batchReadWallets(
  deps: AgentBankDeps,
  walletIds: Set<string>,
): Promise<Map<string, AgentWalletDocument>> {
  const result = new Map<string, AgentWalletDocument>();
  if (walletIds.size === 0) return result;

  // Firestore getAll supports up to 500 document references
  const refs = Array.from(walletIds).map((id) =>
    deps.db.collection('agent_wallets').doc(id),
  );

  // Process in chunks of 500 (Firestore getAll limit)
  for (let i = 0; i < refs.length; i += 500) {
    const chunk = refs.slice(i, i + 500);
    const docs = await deps.db.getAll(...chunk);
    for (const doc of docs) {
      if (doc.exists) {
        result.set(doc.id, doc.data() as AgentWalletDocument);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 5. Process expired bond renewals (daily)
// ---------------------------------------------------------------------------

// The deployed ProvianBondPool's `renewalGracePeriod` is 30 days (WP13 baseline literal,
// ProvianBondPool.sol; no setter, no scheduled override — read on Base 2026-10-22:
// renewalGracePeriod() = 2592000). The relay used 14 days (the pre-WP13 literal) and so
// expired a bond 16 days before the contract's own grace ended.
export const BOND_GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function processBondRenewals(deps: AgentBankDeps): Promise<number> {
  const now = Date.now();

  // Find active bonds whose renewal_deadline has passed
  const snapshot = await deps.db.collection('bonds')
    .where('status', '==', 'active')
    .where('renewal_deadline', '<=', now)
    .limit(500)
    .get();

  if (snapshot.empty) return 0;

  // Collect wallet IDs for batch read
  const walletIds = new Set<string>();
  const bonds: { ref: FirebaseFirestore.DocumentReference; data: BondDocument }[] = [];
  for (const doc of snapshot.docs) {
    const bond = doc.data() as BondDocument;
    walletIds.add(bond.agent_wallet_id);
    bonds.push({ ref: doc.ref, data: bond });
  }

  const walletMap = await batchReadWallets(deps, walletIds);

  let processed = 0;
  for (const { ref, data: bond } of bonds) {
    try {
      const pastGrace = now > bond.renewal_deadline + BOND_GRACE_PERIOD_MS;

      if (pastGrace) {
        // Past grace period - mark as expired, autonomy drops to Level 1.
        // WP8: active→expired is the machine's RECORD-ONLY edge (an off-chain
        // autonomy-privilege drop; the on-chain bond stays Active and no value
        // moves — no receipt exists or is needed). System path: no acting
        // agent, killSwitchActive=false (D-011 doctrine). Evaluated inside a
        // transaction on the FRESH status so a concurrent late renewal
        // (expired→active) or withdrawal cannot be clobbered.
        let flipped = false;
        await deps.db.runTransaction(async (txn) => {
          const fresh = await txn.get(ref);
          if (!fresh.exists) return;
          const fb = fresh.data() as BondDocument;
          if (fb.status !== 'active') return; // renewed/withdrawn concurrently — no-op
          if (now <= fb.renewal_deadline + BOND_GRACE_PERIOD_MS) return; // deadline moved (renewal landed)

          const decision = evaluateInstitutionTransition({
            kind: 'bond',
            from: fb.status,
            to: 'expired',
            killSwitchActive: false,
          });
          if (!decision.allowed) return; // fail closed: unmodeled edge records nothing

          txn.update(ref, {
            status: 'expired',
            updated_at: now,
          });
          flipped = true;
        });

        if (flipped) {
          // Part C2 (rail handshake invalidation): a bond the presenter's
          // handshakes may have relied on EXPIRED — a discrete adverse
          // presenter-side event. Close its live rail handshakes so the next
          // commitment re-presents. Best-effort, post-commit.
          try {
            await invalidateHandshakes(deps.db, bond.agent_wallet_id, 'bond_expired', now, {
              eventId: bond.bond_id,
            });
          } catch { /* advisory-only */ }
          const wallet = walletMap.get(bond.agent_wallet_id);
          if (wallet) {
            await generatePE(deps, {
              walletId: bond.agent_wallet_id,
              agentId: wallet.agent_id,
              actorAddress: wallet.address,
              // WP8: truthful PE type — this is the EXPIRY record (autonomy
              // drop), not the abandonment burn. 'bond_abandonment_processed'
              // stays reserved for the actual on-chain burn mirror below.
              actionType: 'bond_expired_processed',
              metadata: {
                bond_id: bond.bond_id,
                reason: 'renewal_grace_period_expired',
                renewal_deadline: bond.renewal_deadline,
              },
            });
          }
        }
      }
      // Within grace period: just a warning - the agent gets notified via webhook
      // but no state change yet

      processed++;
    } catch (err) {
      console.error(`[Scheduler] Bond renewal processing error for ${bond.bond_id}:`, err);
    }
  }

  return processed;
}

// ---------------------------------------------------------------------------
// 6. Process abandoned bonds (weekly)
// ---------------------------------------------------------------------------

// Mirrors the deployed ProvianBondPool's effective `abandonmentPeriod`: 365 days (read on Base
// 2026-10-23: abandonmentPeriod() = 31536000, activeAbandonmentPeriod() = (false, 0), no epoch
// scheduled). The relay's cutoff is therefore the chain's own: renewal deadline + 30d grace +
// 365d = +395d. (The relay literal was the pre-WP13 180d until the 2026-10-23 close-out; an
// attempt before +395d is refused on-chain as `not_yet_eligible` and asserts nothing.)
export const BOND_ABANDONMENT_PERIOD_MS = 365 * 24 * 60 * 60 * 1000; // 365 days

export async function processAbandonedBonds(deps: AgentBankDeps): Promise<number> {
  const now = Date.now();
  // #24: align the off-chain abandonment window to the on-chain one. The contract's
  // processAbandonment reverts until renewalDeadline + renewalGracePeriod (30d) +
  // abandonmentPeriod (365d on the deployed pool) = +395d (ProvianBondPool.processAbandonment).
  // The relay's cutoff is the same grace + abandonment (30d + 365d = +395d); the burn PE
  // and status flip still wait for the chain to confirm the burn (below). The old cutoff used
  // only the abandonment period, so the scheduler marked bonds 'abandoned' (and emitted a
  // "burned" PE) before the chain would even permit the burn.
  const abandonmentCutoff = now - (BOND_GRACE_PERIOD_MS + BOND_ABANDONMENT_PERIOD_MS);

  // Find expired bonds to try for abandonment (no renewal for 395+ days past deadline)
  const snapshot = await deps.db.collection('bonds')
    .where('status', '==', 'expired')
    .where('renewal_deadline', '<=', abandonmentCutoff)
    .limit(100)
    .get();

  if (snapshot.empty) return 0;

  const walletIds = new Set<string>();
  const bonds: { ref: FirebaseFirestore.DocumentReference; data: BondDocument }[] = [];
  for (const doc of snapshot.docs) {
    const bond = doc.data() as BondDocument;
    walletIds.add(bond.agent_wallet_id);
    bonds.push({ ref: doc.ref, data: bond });
  }

  const walletMap = await batchReadWallets(deps, walletIds);

  let processed = 0;
  for (const { ref, data: bond } of bonds) {
    try {
      // #24: do NOT assert a burn the protocol has not performed. Confirm the chain
      // actually shows the bond Abandoned (the burn happened) before flipping
      // Firestore status + emitting the burn PE. Fail closed: an unconfirmable read
      // asserts nothing.
      const bondPoolAddress = bondPoolAddressForChain(bond.chain);
      if (!bondPoolAddress) {
        console.warn(`[Scheduler] No BondPool address for chain ${bond.chain}; skipping abandonment for ${bond.bond_id}`);
        continue;
      }

      const onchain = await readOnchainBondStatus({
        chainId: chainIdForChain(bond.chain),
        bondPoolAddress,
        agent: bond.agent_address,
      });

      if (!onchain.ok) {
        // Cannot confirm the on-chain state → assert nothing, leave 'expired'.
        console.warn(
          `[Scheduler] Abandonment status unconfirmed for ${bond.bond_id} (${onchain.reason}); ` +
          `leaving status 'expired', no PE emitted.`,
        );
        continue;
      }

      // burnTxHash is set only when WE perform the burn this tick (vs. a bond that
      // was already Abandoned on-chain by a prior run / another caller).
      let burnTxHash: string | undefined;

      if (onchain.status === 'active') {
        // Eligible by time, still holding collateral on-chain → perform the burn via
        // the gas-only keeper EOA ([CONFIG] BOND_KEEPER_KEY). The keeper closes the
        // WS2 gap where eligible bonds sat indefinitely because nothing called
        // ProvianBondPool.processAbandonment.
        if (!deps.bondKeeper?.canSign()) {
          // No keeper configured/funded → cannot burn. Assert nothing (truthful),
          // leave 'expired' for a later tick once the keeper is provisioned.
          console.warn(
            `[Scheduler] Bond ${bond.bond_id} past +395d (on-chain active) but no bond keeper ` +
            `configured (BOND_KEEPER_KEY unset); cannot burn, no PE emitted this tick.`,
          );
          continue;
        }
        const result = await deps.bondKeeper.processAbandonment(bond);
        if (result.status === 'burned') {
          burnTxHash = result.txHash;
        } else if (result.status === 'already_burned') {
          // Raced — another caller burned it between our read and our send. Truthful
          // to assert the burn (it happened), just not by us this tick.
          burnTxHash = undefined;
        } else {
          // not_yet_eligible (on-chain clock skew), not_active, unconfigured, failed
          // → do NOT assert a burn. Idempotent: the next tick retries.
          console.warn(
            `[Scheduler] Keeper did not burn ${bond.bond_id} (${result.status}${result.reason ? `: ${result.reason}` : ''}); ` +
            `leaving status 'expired', no PE emitted.`,
          );
          continue;
        }
      } else if (onchain.status !== 'abandoned') {
        // withdrawn / none — nothing to burn.
        console.warn(
          `[Scheduler] Bond ${bond.bond_id} on-chain status='${onchain.status}'; nothing to abandon, no PE emitted.`,
        );
        continue;
      }
      // else: onchain.status === 'abandoned' (already burned) → recover the
      // receipt below and record it truthfully (no keeper call needed).

      // WP8: expired→abandoned is an ECONOMIC machine edge — it may fire only
      // behind a receipt anchor. Keeper-burned this tick: the keeper's own
      // mined tx is the relay's gateway outcome (the same trust root the
      // escrow release path flips on). Already burned by another caller: the
      // BondAbandoned log is recovered at the Base finality floor. If no
      // receipt can be anchored, assert nothing — the bond stays 'expired'
      // for a later tick (fail closed, never a hashless economic record).
      let receipt: ReceiptEvidence | null = null;
      if (burnTxHash) {
        receipt = { ok: true, txHash: burnTxHash };
      } else {
        const recovered = await recoverEvmBondAbandoned({
          chainId: chainIdForChain(bond.chain),
          bondPoolAddress,
          agent: bond.agent_address,
          fromBlock: bond.post_block_number ?? 0,
        });
        if (recovered.ok && recovered.txHash) {
          receipt = { ok: true, txHash: recovered.txHash, confirmations: recovered.confirmations };
        } else {
          console.warn(
            `[Scheduler] Bond ${bond.bond_id} shows Abandoned on-chain but the BondAbandoned ` +
            `receipt could not be recovered (${recovered.reason}); leaving 'expired', no PE emitted.`,
          );
          continue;
        }
      }

      // Burn CONFIRMED on-chain with a receipt anchor. Flip transactionally on
      // the FRESH status (machine-gated), so the PE is emitted at most once
      // and a concurrent tick cannot double-record.
      let flipped = false;
      let settledTxHash: string | undefined;
      await deps.db.runTransaction(async (txn) => {
        const fresh = await txn.get(ref);
        if (!fresh.exists) return;
        const fb = fresh.data() as BondDocument;
        if (fb.status !== 'expired') return; // already recorded / reinstated — no-op

        const decision = evaluateInstitutionTransition({
          kind: 'bond',
          from: fb.status,
          to: 'abandoned',
          receipt,
          killSwitchActive: false, // system mirror of an on-chain fact (D-011)
        });
        if (!decision.allowed) return; // fail closed
        settledTxHash = decision.economic ? decision.txHash : undefined;

        txn.update(ref, {
          status: 'abandoned',
          ...(settledTxHash ? { abandonment_tx_hash: settledTxHash } : {}),
          updated_at: now,
        });
        flipped = true;
      });
      if (!flipped) continue;

      // Part C2 (rail handshake invalidation): the bond was ABANDONED (on-chain
      // burn mirror) — a discrete adverse presenter-side event. Close its live
      // rail handshakes so the next commitment re-presents. Best-effort, post-commit.
      try {
        await invalidateHandshakes(deps.db, bond.agent_wallet_id, 'bond_abandoned', now, {
          eventId: bond.bond_id,
        });
      } catch { /* advisory-only */ }

      const wallet = walletMap.get(bond.agent_wallet_id);
      if (wallet) {
        await generatePE(deps, {
          walletId: bond.agent_wallet_id,
          agentId: wallet.agent_id,
          actorAddress: wallet.address,
          actionType: 'bond_abandonment_processed',
          metadata: {
            bond_id: bond.bond_id,
            reason: 'abandonment_period_expired',
            amount_pvt: bond.amount_pvt,
            onchain_burn_confirmed: true,
            // WP8: the receipt anchor — the keeper's burn tx this tick, or the
            // recovered BondAbandoned settlement tx. Legitimate provenance
            // content of this FRESH PE (metadata is part of the hashed
            // canonical content in generatePE) — it sets this new envelope's
            // hash, never mutates a sealed one, so the prev_hash chain is intact.
            ...(settledTxHash ? { burn_tx_hash: settledTxHash } : {}),
          },
        });
      }

      processed++;
    } catch (err) {
      console.error(`[Scheduler] Abandoned bond processing error for ${bond.bond_id}:`, err);
    }
  }

  return processed;
}

// ---------------------------------------------------------------------------
// 7. Expire stale bond claims (Pass-3 #3, daily)
// ---------------------------------------------------------------------------

// Matches ProvianBondPool.CLAIM_RESOLUTION_TIMEOUT (60 days). A claim still Filed
// past this window was never adjudicated (no Court panel ever formed), so the
// respondent's collateral is frozen indefinitely by pendingClaims > 0. The
// on-chain expireStaleClaim() is the permissionless liveness escape; this tick
// drives it and mirrors the pendingClaims decrement off the ClaimExpired log.
const CLAIM_RESOLUTION_TIMEOUT_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

export async function processStaleClaims(deps: AgentBankDeps): Promise<number> {
  const now = Date.now();
  // `created_at` is the backend filing timestamp; the on-chain filedAt is the
  // authority. If our calc is fractionally ahead (clock skew) the keeper reports
  // not_yet_expired and we leave the claim 'filed' for a later tick.
  const cutoff = now - CLAIM_RESOLUTION_TIMEOUT_MS;

  const snapshot = await deps.db.collection('bond_claims')
    .where('status', '==', 'filed')
    .where('created_at', '<=', cutoff)
    .limit(100)
    .get();

  if (snapshot.empty) return 0;

  const walletIds = new Set<string>();
  const claims: { ref: FirebaseFirestore.DocumentReference; data: BondClaimDocument }[] = [];
  for (const doc of snapshot.docs) {
    const claim = doc.data() as BondClaimDocument;
    // Attribute the expiry PE to the respondent (bond owner) — their pending_claims
    // decrements and their bond becomes withdrawable again.
    walletIds.add(claim.respondent_wallet_id);
    claims.push({ ref: doc.ref, data: claim });
  }

  const walletMap = await batchReadWallets(deps, walletIds);

  let processed = 0;
  for (const { ref, data: claim } of claims) {
    try {
      const bondPoolAddress = bondPoolAddressForChain(claim.chain);
      if (!bondPoolAddress) {
        console.warn(`[Scheduler] No BondPool address for chain ${claim.chain}; skipping stale claim ${claim.claim_id}`);
        continue;
      }

      // Fail closed: with no funded keeper we cannot drive the on-chain timeout, so
      // assert nothing — the claim stays 'filed' until BOND_KEEPER_KEY is provisioned.
      if (!deps.bondKeeper?.canSign()) {
        console.warn(
          `[Scheduler] Stale claim ${claim.claim_id} past 60d but no bond keeper configured ` +
          `(BOND_KEEPER_KEY unset); cannot expire on-chain, no state change this tick.`,
        );
        continue;
      }

      const result = await deps.bondKeeper.expireStaleClaim(claim);

      // WP8: filed→expired is an ECONOMIC machine edge — it may fire only
      // behind a receipt anchor. Keeper-expired this tick: the keeper's own
      // mined, log-matched tx is the relay's gateway outcome. Already expired
      // by another permissionless caller: recover the ClaimExpired log at the
      // Base finality floor. A Court dismissal has NO ClaimExpired log, so the
      // recovery fails closed there (that mirror is the Court path, not ours).
      let expireTxHash: string | undefined;
      if (result.status === 'expired') {
        expireTxHash = result.txHash;
      } else if (result.status === 'already_expired') {
        if (!claim.onchain_claim_id) {
          console.warn(
            `[Scheduler] Stale claim ${claim.claim_id} already resolved on-chain but has no ` +
            'onchain_claim_id to recover a receipt for; leaving status \'filed\'.',
          );
          continue;
        }
        const recovered = await recoverEvmClaimExpired({
          chainId: chainIdForChain(claim.chain),
          bondPoolAddress,
          onchainClaimId: claim.onchain_claim_id,
          expectedAgent: claim.respondent_address,
          fromBlock: claim.filing_block_number ?? 0,
        });
        if (recovered.ok && recovered.txHash) {
          expireTxHash = recovered.txHash;
        } else {
          console.warn(
            `[Scheduler] Stale claim ${claim.claim_id} dismissed on-chain but no ClaimExpired ` +
            `receipt recovered (${recovered.reason}); leaving status 'filed', no PE emitted.`,
          );
          continue;
        }
      } else {
        // not_yet_expired (clock skew) / already_slashed (a real Court slash — do NOT
        // relabel as expired) / not_found / unconfigured / failed → assert nothing.
        // Idempotent: the next tick retries (or the slash-mirror path handles upheld).
        console.warn(
          `[Scheduler] Keeper did not expire claim ${claim.claim_id} ` +
          `(${result.status}${result.reason ? `: ${result.reason}` : ''}); leaving status 'filed', no PE emitted.`,
        );
        continue;
      }
      const expireReceipt: ReceiptEvidence = { ok: true, txHash: expireTxHash };

      // ClaimExpired CONFIRMED on-chain (this tick, or already expired by another
      // caller). Flip the claim to terminal 'expired' and decrement the bond's
      // pending_claims ATOMICALLY, machine-gated on the FRESH status so a
      // concurrent tick can't double-decrement.
      const bondRef = deps.db.collection('bonds').doc(claim.bond_id);
      let mirrored = false;
      await deps.db.runTransaction(async (txn) => {
        // Reads first (Firestore requires all reads before any write — the
        // pre-WP8 shape read the bond doc after the claim write, which the
        // Admin SDK rejects at runtime).
        const freshClaim = await txn.get(ref);
        const freshBond = await txn.get(bondRef);
        if (!freshClaim.exists) return;
        const fc = freshClaim.data() as BondClaimDocument;
        if (fc.status !== 'filed') return; // already resolved by another path — idempotent no-op

        const decision = evaluateInstitutionTransition({
          kind: 'bond_claim',
          from: fc.status,
          to: 'expired',
          receipt: expireReceipt,
          killSwitchActive: false, // system mirror of an on-chain fact (D-011)
        });
        if (!decision.allowed) return; // fail closed

        txn.update(ref, {
          status: 'expired',
          fee_outcome: 'burned', // on-chain expireStaleClaim burns the filing fee
          onchain_settlement: 'confirmed',
          resolution_summary: 'Claim expired: no Court panel formed within 60 days (permissionless timeout).',
          resolution_tx_hash: decision.economic ? decision.txHash : expireTxHash,
          resolved_at: now,
          updated_at: now,
        });

        if (freshBond.exists) {
          const fb = freshBond.data() as BondDocument;
          txn.update(bondRef, {
            pending_claims: Math.max(0, fb.pending_claims - 1),
            updated_at: now,
          });
        }
        mirrored = true;
      });

      if (!mirrored) continue; // claim was resolved concurrently — no PE, no double count

      const wallet = walletMap.get(claim.respondent_wallet_id);
      if (wallet) {
        await generatePE(deps, {
          walletId: claim.respondent_wallet_id,
          agentId: wallet.agent_id,
          actorAddress: wallet.address,
          actionType: 'bond_claim_expired_processed',
          metadata: {
            claim_id: claim.claim_id,
            bond_id: claim.bond_id,
            claimant_wallet_id: claim.claimant_wallet_id,
            reason: 'claim_resolution_timeout',
            filed_at: claim.created_at,
            onchain_expiry_confirmed: true,
            // Present only when the keeper expired it this tick (fresh-PE provenance,
            // part of this envelope's hashed content — never mutates a sealed PE).
            ...(expireTxHash ? { expire_tx_hash: expireTxHash } : {}),
          },
        });
      }

      processed++;
    } catch (err) {
      console.error(`[Scheduler] Stale claim expiration error for ${claim.claim_id}:`, err);
    }
  }

  return processed;
}

// ---------------------------------------------------------------------------
// 8. WP9: mirror on-chain Court settlements of filed bond claims
// ---------------------------------------------------------------------------

/**
 * For every backend claim still 'filed', check whether the on-chain Court has
 * already settled it (a 2-of-3 panel slash via castBondClaimVote, a Dismiss
 * majority / 1-1-1 deadlock, or the permissionless finalizeBondClaim) and — if
 * a Base-final BondSlashed/ClaimDismissed receipt is recoverable from the
 * BondPool's logs (bounded from the filing block) — drive the receipt-gated
 * resolveBondClaim bridge with it. This closes the WP8 gap where a Court
 * dismissal or slash observed by nobody left the backend claim 'filed'
 * forever ('a Court dismissal … deliberately unrecoverable here' — it is now
 * recoverable HERE, on the Court-settlement path where it belongs).
 *
 * Fail-closed by construction: a claim with no recoverable Base-final
 * settlement is left 'filed' for a later tick (the expected common case — the
 * observation throws its not-found ValidationError, swallowed per claim); the
 * verdict is always the EVENT's, never asserted; the flip is idempotent by
 * resolution tx hash. System path: no acting wallet (D-011 — a settlement
 * mirror of an on-chain fact). The backend never signs or drives a slash.
 */
export async function processFiledClaimCourtSettlements(deps: AgentBankDeps): Promise<number> {
  const snapshot = await deps.db.collection('bond_claims')
    .where('status', '==', 'filed')
    .limit(100)
    .get();
  if (snapshot.empty) return 0;

  let mirrored = 0;
  for (const doc of snapshot.docs) {
    const claim = doc.data() as BondClaimDocument;
    // Legacy claims without the on-chain binding cannot be receipt-observed;
    // the stale-claims expiry path is their only exit. Skip quietly.
    if (!claim.onchain_claim_id) continue;
    try {
      const resolved = await observeBondClaimSettlement(deps, { claimId: claim.claim_id });
      if (resolved.status !== 'filed') {
        mirrored++;
        console.log(
          `[Scheduler] Mirrored on-chain Court settlement for claim ${claim.claim_id}: ` +
          `${resolved.status} (tx ${resolved.resolution_tx_hash}).`,
        );
      }
    } catch {
      // No Base-final settlement recovered (or a transient RPC failure) — the
      // claim stays 'filed'; the next tick retries. Deliberately quiet: this
      // is the steady state for every claim whose panel has not resolved yet.
    }
  }
  return mirrored;
}
