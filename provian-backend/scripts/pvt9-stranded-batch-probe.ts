/**
 * the STRANDED-BATCH PROBE. READ-ONLY: it writes nothing to Firestore and sends
 * nothing to any chain (no signer is constructed; every chain call is a view or a receipt read).
 *
 * npx tsx scripts/pvt9-stranded-batch-probe.ts # signer = kernel operationalMinter()
 * npx tsx scripts/pvt9-stranded-batch-probe.ts --signer 0x… # probe another signer
 * npx tsx scripts/pvt9-stranded-batch-probe.ts --out probe.json # also write the JSON report
 * npx tsx scripts/pvt9-stranded-batch-probe.ts --applied-sample 50
 *
 * Needs the production read environment: Firestore admin credentials (ADC) for the relay's
 * project, `BASE_RPC_URL`, and the quorum-read RPC env the settlement runtime uses
 * (`readAgreedBaseHead` / `readAgreedBaseSafeHead` / `readAgreedBaseBlockHash`).
 *
 * What it answers, before the runner is deployed: on its FIRST run, the cross-cycle
 * reconciler adopts EVERY non-terminal batch (`reserved` / `submitted` / `mined`) of the signer
 * in ANY cycle, and the applied-batch finality sweep examines applied batches that were never
 * finality-stamped (every batch applied before). For each unresolved batch this prints
 * its attempts and their nonces, each receipt's status and its verdict at the safe depth
 * (the production `judgeReceiptFinality`), the signer's nonce at `latest` / the safe
 * block, the kernel's `claimSettled` for every member AT the safe block, and the action the
 * reconciler will take — including whether the batch will BLOCK new sends
 * (`stranded_batch_pending`) and whether any member will be recorded settled from chain
 * evidence. For the newest applied batches it runs the production `verifyAppliedBatch` and flags
 * anything it would UNWIND (it should be none; any such line needs a look before deploying).
 */

import { writeFileSync } from 'node:fs';
import admin from 'firebase-admin';
import { Contract, JsonRpcProvider } from 'ethers';
import { resolvePvt9Target } from '../src/core/pvt/wp4/operator-runtime';
import { KERNEL_CLAIM_SETTLED_ABI, KERNEL_OBSERVATION_ABI } from '../src/core/pvt/wp4/settlement-chain-adapter';
import {
  readAgreedBaseBlockHash,
  readAgreedBaseHead,
  readAgreedBaseSafeHead,
} from '../src/core/onchain/economic-discovery';
import {
  judgeReceiptFinality,
  memberSettlement,
  recordedReceiptMatches,
  verifyAppliedBatch,
  APPLIED_FINALITY_SWEEP_BATCHES_PER_RUN,
  HELD_CLAIM_RECHECK_PER_RUN,
  type MinedReceipt,
  type SettlementFinalityReader,
} from '../src/core/pvt/wp4/settlement-cycle-runner';
import {
  CLAIM_LEDGER_COLLECTION,
  SETTLEMENT_BATCHES_COLLECTION,
  SETTLEMENT_BATCH_SCHEMA,
  SETTLEMENT_CYCLES_COLLECTION,
  UNRESOLVED_BATCH_STATUSES,
  type SettlementBatchDoc,
  type SettlementCycleDoc,
} from '../src/core/pvt/wp4/durable-settlement-store';
import { scriptDb } from './lib/script-db';

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && typeof process.argv[index + 1] === 'string' ? process.argv[index + 1] : null;
}

interface AttemptReport {
  readonly nonce: number;
  readonly kind: string;
  readonly tx_hash: string;
  readonly recorded_mined: string | null;
  /** Whether the recorded receipt still matches the live one (the runner's own rule, legacy-aware). */
  readonly recorded_matches_live: boolean | null;
  readonly legacy_record_no_block_hash: boolean;
  readonly receipt_now: { status: string; block: number; hash: string } | null;
  readonly finality: 'final' | 'pending' | 'dropped' | 'no_receipt' | 'unreadable';
  readonly finality_detail: string | null;
}

interface BatchReport {
  readonly batch_id: string;
  readonly cycle_id: string;
  readonly cycle_status: string | null;
  readonly cycle_lease_live: boolean;
  readonly lane: string;
  readonly status: string;
  readonly reserved_nonce: number;
  readonly cursor: string;
  readonly claim_count: number;
  readonly attempts: readonly AttemptReport[];
  readonly nonce: {
    readonly latest: number | null;
    readonly pending: number | null;
    readonly at_safe: number | null;
    readonly live_nonce: number | null;
    readonly consumed_at_safe: boolean | null;
  };
  readonly members: {
    readonly total: number;
    readonly settled_at_safe: number | null;
    readonly unsettled_at_safe: number | null;
    readonly settled_claim_ids: readonly string[];
    readonly read_error: string | null;
  };
  readonly predicted_action: string;
  readonly blocks_new_sends: boolean;
  /** True when a human should look before deploying (a stop, or an unexpected shape). */
  readonly attention: boolean;
}

async function main(): Promise<void> {
  const out = arg('--out');
  const appliedSample = Number(arg('--applied-sample') ?? APPLIED_FINALITY_SWEEP_BATCHES_PER_RUN);
  if (admin.apps.length === 0) admin.initializeApp();
  const db = scriptDb();
  const target = resolvePvt9Target();
  const provider = new JsonRpcProvider(target.rpcUrl, Number(target.chainId), { staticNetwork: true });
  const kernel = new Contract(target.kernelAddress, KERNEL_OBSERVATION_ABI as unknown as string[], provider);
  const claimView = new Contract(target.kernelAddress, KERNEL_CLAIM_SETTLED_ABI as unknown as string[], provider);

  const signer = (arg('--signer') ?? String(await kernel.operationalMinter())).toLowerCase();

  // The exact production verdicts run over this READ-ONLY port — no signer exists here.
  const reader: SettlementFinalityReader = {
    async getReceipt(txHash: string): Promise<MinedReceipt | null> {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt === null) return null;
      return {
        status: receipt.status === 1 ? 'success' : 'reverted',
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash.toLowerCase(),
        gasUsed: receipt.gasUsed,
        effectiveGasPriceWei: receipt.gasPrice,
      };
    },
    readHead: () => readAgreedBaseHead(),
    readSafeHead: () => readAgreedBaseSafeHead(),
    getBlockHash: (blockNumber: number) => readAgreedBaseBlockHash(blockNumber),
    async isClaimSettled(claimId: string, blockTag?: number): Promise<boolean> {
      return Boolean(blockTag === undefined
        ? await claimView.claimSettled(claimId)
        : await claimView.claimSettled(claimId, { blockTag }));
    },
  };

  const safe = await readAgreedBaseSafeHead();
  const head = await readAgreedBaseHead();
  const safeBlock = safe === null ? null : safe.number;
  const kernelCursor = BigInt(await kernel.nextFinalizedCursor());
  const latestNonce = await provider.getTransactionCount(signer, 'latest');
  // Mempool nonce is unavailable; absence is never inferred from canonical history.
  const pendingNonce = null;
  const safeNonce = safeBlock === null ? null : await provider.getTransactionCount(signer, safeBlock);

  // ── Every non-terminal batch, any cycle.
  const cycles = new Map<string, SettlementCycleDoc | null>();
  const cycleOf = async (cycleId: string): Promise<SettlementCycleDoc | null> => {
    if (!cycles.has(cycleId)) {
      const snap = await db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(cycleId).get();
      cycles.set(cycleId, snap.exists ? (snap.data() as unknown as SettlementCycleDoc) : null);
    }
    return cycles.get(cycleId) ?? null;
  };
  const unresolved: SettlementBatchDoc[] = [];
  for (const status of UNRESOLVED_BATCH_STATUSES) {
    const snap = await db.collection(SETTLEMENT_BATCHES_COLLECTION).where('status', '==', status).get();
    for (const doc of snap.docs) {
      const data = doc.data();
      if (data.schema_version === SETTLEMENT_BATCH_SCHEMA) unresolved.push(data as unknown as SettlementBatchDoc);
    }
  }

  const batches: BatchReport[] = [];
  let otherSigners = 0;
  for (const batch of unresolved.sort((a, b) => a.reserved_nonce - b.reserved_nonce)) {
    const cycle = await cycleOf(batch.cycle_id);
    if (cycle === null || cycle.signer.toLowerCase() !== signer) {
      otherSigners += 1;
      continue;
    }
    const leaseLive = cycle.status === 'active' && cycle.lease.expires_at_ms > Date.now();

    const attempts: AttemptReport[] = [];
    for (const attempt of batch.attempts) {
      let receipt: MinedReceipt | null = null;
      let finality: AttemptReport['finality'] = 'no_receipt';
      let detail: string | null = null;
      try {
        receipt = await reader.getReceipt(attempt.tx_hash);
        if (receipt !== null) {
          const verdict = await judgeReceiptFinality(reader, attempt.tx_hash, {
            status: receipt.status, block_number: receipt.blockNumber, block_hash: receipt.blockHash,
          });
          finality = verdict.kind;
          detail = verdict.kind === 'final' ? null : verdict.detail;
        }
      } catch (error) {
        finality = 'unreadable';
        detail = String(error);
      }
      attempts.push({
        nonce: attempt.nonce,
        kind: attempt.kind,
        tx_hash: attempt.tx_hash,
        recorded_mined: attempt.mined === null ? null : attempt.mined.status,
        // The runner matches a recorded receipt with `recordedReceiptMatches` (status + block,
        // and the hash only when one was recorded — pre- attempts have none). A record that
        // does not match is withdrawn and the LIVE receipt re-recorded, so the prediction below,
        // which is made from the live receipts, is the outcome the runner reaches.
        recorded_matches_live: attempt.mined === null || receipt === null
          ? null
          : recordedReceiptMatches(attempt.mined, receipt),
        legacy_record_no_block_hash: attempt.mined !== null && (attempt.mined.block_hash ?? '') === '',
        receipt_now: receipt === null ? null : { status: receipt.status, block: receipt.blockNumber, hash: receipt.blockHash },
        finality,
        finality_detail: detail,
      });
    }

    const liveNonce = batch.attempts.length > 0 ? batch.attempts[batch.attempts.length - 1].nonce : null;
    const consumed = liveNonce === null || safeNonce === null ? null : safeNonce > liveNonce;
    const settlement = safeBlock === null
      ? { kind: 'unknown' as const, detail: 'no safe block' }
      : await memberSettlement(reader, batch.members, safeBlock);
    const settledIds = settlement.kind === 'read' ? settlement.settled.map((m) => m.claim_id) : [];

    // ── The reconciler's action, mirroring `resolveBatch` in adopted mode.
    let action: string;
    let blocks = true;
    let attention = false;
    const successFinal = attempts.find((a) => a.receipt_now?.status === 'success' && a.finality === 'final');
    const successAny = attempts.find((a) => a.receipt_now?.status === 'success');
    const liveRevert = attempts.find((a) => a.nonce === liveNonce && a.receipt_now?.status === 'reverted');
    const conclusion = (why: string): string => {
      if (settlement.kind !== 'read') {
        attention = true;
        return `STOP resumption_abort (${why}; ${settlement.detail}) — blocks new sends until readable`;
      }
      blocks = false;
      return settlement.settled.length === 0
        ? `dead (${why}); ${batch.members.length} claim(s) return to the queue`
        : `dead (${why}); ${settlement.settled.length}/${batch.members.length} claim(s) RECORDED SETTLED FROM CHAIN `
          + `EVIDENCE at safe block ${safeBlock}, the rest return to the queue`;
    };
    if (leaseLive) {
      action = 'skipped this run: its cycle lease is held by a live worker';
    } else if (batch.attempts.length === 0) {
      action = 'dead (adopted_never_broadcast); claims return to the queue';
      blocks = false;
    } else if (successFinal !== undefined) {
      if (successFinal.kind === 'cancel') {
        action = 'dead (cancelled_dead_binding): the cancel is final';
      } else {
        action = 'APPLY: the settle is final — confirmed and written back (ledger + pe_history)';
      }
      blocks = false;
    } else if (successAny !== undefined) {
      action = `WAIT: a success receipt is not yet final (${successAny.finality}: ${successAny.finality_detail ?? ''}) `
        + '— stranded_batch_pending until it is (or is re-driven if dropped)';
    } else if (liveRevert !== undefined && liveRevert.finality === 'final') {
      action = conclusion('adopted_reverted_final');
    } else if (liveRevert !== undefined) {
      action = `WAIT: the live nonce's revert is not yet final (${liveRevert.finality})`;
    } else if (consumed === true) {
      action = conclusion('nonce_consumed_elsewhere');
    } else if (consumed === null) {
      action = 'WAIT: no safe block — nothing is concluded';
      attention = true;
    } else {
      action = 'RE-DRIVE at the same nonce (re-broadcast, replace, or cancel); stranded_batch_pending while unmined';
    }

    batches.push({
      batch_id: batch.batch_id,
      cycle_id: batch.cycle_id,
      cycle_status: cycle.status,
      cycle_lease_live: leaseLive,
      lane: batch.lane,
      status: batch.status,
      reserved_nonce: batch.reserved_nonce,
      cursor: `${batch.cursor_start}..${batch.cursor_end}`,
      claim_count: batch.claim_count,
      attempts,
      nonce: {
        latest: latestNonce, pending: pendingNonce, at_safe: safeNonce, live_nonce: liveNonce, consumed_at_safe: consumed,
      },
      members: {
        total: batch.members.length,
        settled_at_safe: settlement.kind === 'read' ? settlement.settled.length : null,
        unsettled_at_safe: settlement.kind === 'read' ? settlement.unsettled.length : null,
        settled_claim_ids: settledIds.slice(0, 20),
        read_error: settlement.kind === 'read' ? null : settlement.detail,
      },
      predicted_action: action,
      blocks_new_sends: blocks,
      attention,
    });
  }

  // ── Held claims the reconciler will re-ask the kernel about.
  const heldSnap = await db.collection(CLAIM_LEDGER_COLLECTION)
    .where('held', '==', true).where('settled', '==', false).limit(HELD_CLAIM_RECHECK_PER_RUN).get();
  let heldPaidAtSafe = 0;
  for (const doc of heldSnap.docs) {
    const claimId = String(doc.data().claim_id);
    if (safeBlock !== null && await reader.isClaimSettled(claimId, safeBlock)) heldPaidAtSafe += 1;
  }

  // ── The applied-batch finality sweep's first pass (production `verifyAppliedBatch`).
  const signerCycles = await db.collection(SETTLEMENT_CYCLES_COLLECTION).where('signer', '==', signer).get();
  const sweepCandidates: SettlementBatchDoc[] = [];
  for (const cycleDoc of signerCycles.docs) {
    const snap = await db.collection(SETTLEMENT_BATCHES_COLLECTION)
      .where('cycle_id', '==', String(cycleDoc.data().cycle_id)).get();
    for (const doc of snap.docs) {
      const batch = doc.data() as unknown as SettlementBatchDoc;
      if (batch.schema_version !== SETTLEMENT_BATCH_SCHEMA || !batch.applied || batch.status !== 'confirmed') continue;
      const uncovered = BigInt(batch.cursor_end) > kernelCursor;
      if (batch.finality_verified !== true || uncovered) sweepCandidates.push(batch);
    }
  }
  sweepCandidates.sort((a, b) => (BigInt(a.cursor_end) > BigInt(b.cursor_end) ? -1 : 1));
  const sweep: Array<{ batch_id: string; cursor_end: string; verdict: string; detail: string | null }> = [];
  for (const batch of sweepCandidates.slice(0, appliedSample)) {
    const verdict = await verifyAppliedBatch(reader, batch);
    sweep.push({
      batch_id: batch.batch_id,
      cursor_end: batch.cursor_end,
      verdict: verdict.kind === 'reorged' ? 'WOULD_UNWIND' : verdict.kind,
      detail: verdict.kind === 'canonical' ? null : verdict.detail,
    });
  }

  const report = {
    probe: 'pvt9-stranded-batch-probe',
    read_only: true,
    observed_at: new Date().toISOString(),
    kernel: target.kernelAddress,
    signer,
    chain: { head, safe_block: safeBlock, kernel_next_finalized_cursor: kernelCursor.toString() },
    signer_nonce: { latest: latestNonce, pending: pendingNonce, at_safe: safeNonce },
    unresolved_batches: {
      this_signer: batches.length,
      other_signers_ignored: otherSigners,
      will_block_new_sends: batches.filter((b) => b.blocks_new_sends).length,
      need_attention: batches.filter((b) => b.attention).length,
      will_record_chain_evidence: batches.filter((b) => b.predicted_action.includes('CHAIN EVIDENCE')).length,
      batches,
    },
    held_claims: {
      listed: heldSnap.size,
      paid_at_safe_will_record_settled: heldPaidAtSafe,
    },
    applied_finality_sweep: {
      candidates: sweepCandidates.length,
      sampled_newest: sweep.length,
      would_unwind: sweep.filter((s) => s.verdict === 'WOULD_UNWIND').length,
      unverifiable: sweep.filter((s) => s.verdict === 'unknown').length,
      pending: sweep.filter((s) => s.verdict === 'pending').length,
      sample: sweep,
    },
  };
  const json = JSON.stringify(report, null, 2);
  if (out !== null) writeFileSync(out, `${json}\n`);
  console.log(json);
  console.error(
    `[stranded-batch-probe] signer=${signer} unresolved=${batches.length} `
    + `block_new_sends=${report.unresolved_batches.will_block_new_sends} `
    + `attention=${report.unresolved_batches.need_attention} `
    + `chain_evidence=${report.unresolved_batches.will_record_chain_evidence} `
    + `held_paid=${heldPaidAtSafe} sweep_candidates=${sweepCandidates.length} `
    + `would_unwind=${report.applied_finality_sweep.would_unwind}`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}
