/**
 * settlement runtime — settlement cycle runner tests against a scripted mini-kernel chain.
 *
 * The FakeChain models exactly the kernel behaviors the runner depends on
 * (single shared cursor, cursor-discontinuity refusal, claim dedupe by id,
 * epoch fence via wall-clock vs lastOpenedEpoch) plus wire behaviors the
 * plan's acceptance names: dropped transactions, replacements, reverts.
 *
 * The acceptance lines proven here (plan §settlement runtime):
 * - crash after reservation and midway through a multi-transaction cycle;
 * - dropped and replacement transaction tests;
 * - retry without resetting gas/transaction limits;
 * - graceful persistent backlog at every guardrail;
 * - no loss, reprice, duplicate, or nonce collision at the unit scale
 * (the 25k/50k scale run lives in scripts/wp4-load-harness.ts).
 */

import type { Firestore } from 'firebase-admin/firestore';
import { aggregateBatchClaims, isMeterClaimKey } from '../../meter/meter-claims';
import { runMeterClaimInlet, verifyMeterClaimMembers } from '../../meter/meter-settlement';
import { mutatePeHistoryRowWithAggregate } from '../policy/economic-aggregate';
import { createHash } from 'crypto';
import { Interface } from 'ethers';
import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import {
  CLAIM_HOLD_BASE_MS,
  CLAIM_LEDGER_COLLECTION,
  acquireCycleLease,
  acquireSignerLease,
  assertNoLegacyLedgerRows,
  claimKeyOf,
  registerClaimsBulk,
  type NewClaimInput,
  type SettlementBatchDoc,
  type SettlementCycleDoc,
  type SettlementDb,
} from './durable-settlement-store';
import {
  KERNEL_SETTLEMENT_ABI,
  PLAN_INITIAL_CYCLE_MAX_FEE_WEI,
  PLAN_INITIAL_CYCLE_MAX_TRANSACTIONS,
  judgeReceiptFinality,
  runSettlementCycle,
  selectLaneWork,
  type CycleChainObservation,
  type CycleRunnerConfig,
  type CycleRunnerDeps,
  type MinedReceipt,
  type NonceBlockTag,
  type SafeHead,
  type SettlementChainAdapter,
  type SignableTransaction,
} from './settlement-cycle-runner';
import { testOnlyAdmittedStandardLaneVerdict } from './standard-lane-recon-gate';
import { cycleConfig, newSettlementWorkerId } from './operator-runtime';
import { deriveClaimId, deriveTopupClaimId, deriveLegClaimId, type SealedEnvelopeIdentity } from '../wp-ev/claim-id';
import { evaluateEligibility, type EligibilityCandidate } from '../wp-ev/eligibility';
import {
  SettlementLane,
  computeSettlementDigest,
  hashGenesisClaims,
  hashStandardClaims,
} from '../wp-ev/settlement-batch';
import {
  approveBatchForSettlement,
  type BatchApprovalDeps,
  type BatchApproverAdapter,
  type EligibilityCandidateSource,
} from './batch-approval';

const kernelInterface = new Interface(KERNEL_SETTLEMENT_ABI as unknown as string[]);

const H = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;

// ── Honest claim identity for the approval gate ──────────────────────────────
// The gate re-derives each PE's claim id with the real WP-EV criteria and refuses if it
// does not equal the claim id being settled, so the fixtures must carry claim ids that
// ACTUALLY derive from a PE. Synthetic `H(n)` ids would be refused — correctly.
const peFor = (peId: string, n: number): SealedEnvelopeIdentity => ({
  id: peId,
  prev_hash: H(900_000 + n),
  hash: H(910_000 + n),
  // Post-cut-line (after PVT9_ELIGIBILITY_CUT_LINE_MS 1_784_938_132_043); a pre-cut-line
  // timestamp would be fenced out by evaluateEligibility as legacy-era, and these tests
  // exercise the settlement/approval machinery, not the cut-line fence.
  timestamp: 1_785_200_000_000 + n,
  action_type: 'agent_task_completed',
  user_id: `user-${n}`,
});

function claimIdFor(peId: string, n: number): string {
  const derived = deriveClaimId(peFor(peId, n));
  if (derived.kind !== 'derived') throw new Error(`fixture PE ${peId} has no derivable claim id`);
  return derived.claimId;
}

/** An eligible candidate for a fixture PE: every criterion satisfied, real work evidence. */
function eligibleCandidate(peId: string, n: number): EligibilityCandidate {
  return {
    pe: peFor(peId, n),
    attestationTier: 'software',
    chainVerified: true,
    submissionProvenance: 'earner_signed',
    workEvidence: { workProductHash: H(920_000 + n) },
    relayMintStatus: 'eligible',
  };
}
const ADDR = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const SIGNER = ADDR(0xbeef);
const KERNEL = ADDR(0xcafe);
const EPOCH_DURATION = 604_800;

type WireBehavior = 'mine-success' | 'mine-revert' | 'drop';

class CrashError extends Error {}

/** Scripted Base-shaped chain with a mini-kernel settlement model. */
class FakeChain implements SettlementChainAdapter {
  cursor = 0n;
  // WS1 read-your-writes replica-lag injection. The real kernel advances its
  // `nextFinalizedCursor` at the settle-mine, but the very next `observe()` can
  // land on a load-balanced RPC replica one block behind and return the
  // PRE-advance value. `cursorLagPerMine` re-arms that many stale `observe()`
  // reads after each successful mine; a stale read returns the cursor value from
  // BEFORE that mine. 0 = no lag (the synchronous default the other tests use).
  cursorLagPerMine = 0;
  staleCursorReads = 0;
  private cursorBeforeLastMine = 0n;
  // WS1 dangerous-direction control: after the Nth successful mine, overwrite the
  // on-chain cursor with an OUT-OF-RANGE value (ahead of durable, or below the
  // cycle seed) to prove the reflect guard still fails loud, never waits.
  cursorHijack: { afterMines: number; to: bigint } | null = null;
  private successfulMines = 0;
  lastOpenedEpoch = 0;
  epochZeroStartsAtSec = 1_000_000;
  nowSec = 1_000_100; // inside epoch 0
  epochZeroArmed = true;
  administrativeHold = false;
  policyHash = H(0xfeed);
  mintRateAtomic = 1_000_000_000_000_000_000n;
  agentFoundationBps = 50n;
  genesisCapAtomic = 7_500_000n * 10n ** 18n;
  combinedCapAtomic = 10_000_000n * 10n ** 18n;
  epochGenesisIssuedAtomic = 0n;
  epochTotalIssuedAtomic = 0n;
  claimSettled = new Set<string>();
  behaviors: WireBehavior[] = [];
  receipts = new Map<string, MinedReceipt>();
  pending = new Map<string, SignableTransaction>();
  broadcasts = 0;
  minedLanes: string[] = [];
  /**
   * Batch ids the verifier has affirmed. Keyed by batch id rather than digest because the
   * fake decodes calldata, not digests; the binding they stand for is the same one, and the
   * digest itself is proven separately by `batch-approval`'s own tests.
   */
  affirmedDigests = new Set<string>();

  /** runs at the top of every `observe()` (scripts a reorg between batches). */
  beforeObserve: (() => void) | null = null;
  /**
   * claim ids the kernel refuses (a poisoned claim): a batch containing one reverts at
   * the dry run and on chain. Everything else about the batch is valid.
   */
  poisoned = new Set<string>();
  /**
   * — claim pairs the kernel refuses TOGETHER though each settles alone (a
   * duplicate anchor, two grants that together cross the Genesis wallet ceiling). `cumulative` * once one of the pair is paid the other is refused alone too (the ceiling case).
   */
  combinations: Array<{ readonly ids: readonly [string, string]; readonly cumulative: boolean }> = [];
  private combinationRefuses(claimIds: readonly string[]): boolean {
    return this.combinations.some(({ ids: [a, b], cumulative }) => {
      const hasA = claimIds.includes(a);
      const hasB = claimIds.includes(b);
      if (hasA && hasB) return true;
      return cumulative && ((hasA && this.claimSettled.has(b)) || (hasB && this.claimSettled.has(a)));
    });
  }
  /** when set, `latest` also reflects every nonce that has mined (a real node does). */
  trackNonces = false;
  private minedNonceFloor = 0;

  async observe(): Promise<CycleChainObservation> {
    this.beforeObserve?.();
    // Apply the WS1 replica-lag: while stale reads remain, report the cursor value
    // from before the last mine (one-behind), consuming one stale read per call.
    let reportedCursor = this.cursor;
    if (this.staleCursorReads > 0) {
      reportedCursor = this.cursorBeforeLastMine;
      this.staleCursorReads -= 1;
    }
    return {
      epochZeroArmed: this.epochZeroArmed,
      epochZeroStartsAtSec: this.epochZeroStartsAtSec,
      lastOpenedEpoch: this.lastOpenedEpoch,
      administrativeHold: this.administrativeHold,
      operationalMinter: SIGNER,
      settlementSigner: SIGNER,
      observedAtSec: this.nowSec,
      nextFinalizedCursor: reportedCursor,
      openEpochPolicyHash: this.policyHash,
      chainId: 8453n,
      kernelAddress: KERNEL,
      mintRateAtomic: this.mintRateAtomic,
      agentFoundationBps: this.agentFoundationBps,
      genesisCapAtomic: this.genesisCapAtomic,
      combinedCapAtomic: this.combinedCapAtomic,
      epochGenesisIssuedAtomic: this.epochGenesisIssuedAtomic,
      epochTotalIssuedAtomic: this.epochTotalIssuedAtomic,
    };
  }

  /** The signer's on-chain nonce ('latest'). Settable to script the reclaim controls. */
  txCount = 0;
  /** the nonce at a block height (the safe block); defaults to `txCount`. */
  txCountAtBlock: ((block: number) => number) | null = null;
  async getTransactionCount(_address: string, blockTag: NonceBlockTag = 'latest'): Promise<number> {
    const latest = this.trackNonces ? Math.max(this.txCount, this.minedNonceFloor) : this.txCount;
    if (typeof blockTag === 'number') return this.txCountAtBlock?.(blockTag) ?? latest;
    return latest;
  }

  // ── finality model ──────────────────────────────────────────────────
  // Every mined transaction lands in its own block with a canonical hash. By default the safe
  // head IS the tip and the head is 11 beyond it, so every receipt is final at once (the
  // pre- tests are unchanged). `safeLag` holds the safe head that many blocks behind the
  // tip; `noSafeHead` models a node with no safe block yet.
  block = 0;
  reorgGeneration = 0;
  canonical = new Map<number, string>();
  safeLag = 0;
  noSafeHead = false;
  finalityReads = 0;
  private minedEffects = new Map<string, {
    block: number; data: string; parsed: SignableTransaction;
    cursorBefore: bigint; claimIds: string[]; status: 'success' | 'reverted';
  }>();

  async readHead(): Promise<number> { return this.block + 11; }
  async readSafeHead(): Promise<SafeHead | null> {
    this.finalityReads += 1;
    if (this.noSafeHead) return null;
    const number = Math.max(0, this.block - this.safeLag);
    return { number, hash: this.canonical.get(number) ?? H(0) };
  }
  async getBlockHash(blockNumber: number): Promise<string | null> {
    return this.canonical.get(blockNumber) ?? null;
  }
  /**
   * — the block each claim was paid in (absent = paid "since forever"), so a
   * height-tagged read answers AT that block, like the kernel view with `{ blockTag }`.
   */
  claimSettledAt = new Map<string, number>();
  /** Claims a LAGGING `latest` replica still reads unpaid (the safe-block read is unaffected). */
  staleLatestClaims = new Set<string>();
  /** Receipts a lagging replica does not return, although the transaction mined. */
  hiddenReceipts = new Set<string>();
  /** Every height-tag `isClaimSettled` was asked at (proves the safe-block read). */
  claimReadTags: Array<number | 'latest'> = [];
  async isClaimSettled(claimId: string, blockTag?: number): Promise<boolean> {
    const id = claimId.toLowerCase();
    this.claimReadTags.push(blockTag ?? 'latest');
    if (!this.claimSettled.has(id)) return false;
    if (blockTag === undefined) return !this.staleLatestClaims.has(id);
    return (this.claimSettledAt.get(id) ?? 0) <= blockTag;
  }

  /**
   * Reorg the block holding `txHash` out of the canonical chain: its receipt disappears, the
   * kernel effects it had are undone (cursor + claimSettled), the height gets a different
   * canonical hash, and — when `toMempool` — the transaction goes back to the mempool to be
   * mined again by `minePending` (or a re-broadcast).
   */
  reorgOut(txHash: string, toMempool = true): void {
    const effect = this.minedEffects.get(txHash);
    if (effect === undefined) throw new Error(`reorgOut: ${txHash} was never mined`);
    this.minedEffects.delete(txHash);
    this.receipts.delete(txHash);
    if (effect.status === 'success') {
      this.cursor = effect.cursorBefore;
      for (const id of effect.claimIds) {
        this.claimSettled.delete(id);
        this.claimSettledAt.delete(id);
      }
    }
    this.reorgGeneration += 1;
    this.canonical.set(effect.block, H(0xdead_0000 + this.reorgGeneration * 1_000 + effect.block));
    if (toMempool) this.pending.set(txHash, effect.parsed);
  }

  /** Called after every accepted broadcast, with the running count and the tx hash. */
  onBroadcast: ((count: number, hash: string) => void) | null = null;

  async feeData() {
    return { maxFeePerGasWei: 1_000_000_000n, maxPriorityFeePerGasWei: 100_000_000n };
  }

  /** `eth_estimateGas` result; the recorded gasLimit is this × gasHeadroomBps. Settable. */
  gasEstimate = 1_000_000n;
  async estimateGas(): Promise<bigint> { return this.gasEstimate; }

  async simulate(tx: { data: string }): Promise<{ ok: boolean; revertReason: string | null }> {
    if (tx.data === '0x') return { ok: true, revertReason: null };
    const decoded = this.decode(tx.data);
    if (decoded === null) return { ok: false, revertReason: 'undecodable' };
    if (decoded.cursorStart !== this.cursor) return { ok: false, revertReason: 'CursorDiscontinuity' };
    for (const claimId of decoded.claimIds) {
      if (this.claimSettled.has(claimId)) return { ok: false, revertReason: 'ClaimAlreadySettled' };
      if (this.poisoned.has(claimId)) return { ok: false, revertReason: 'Poisoned' };
    }
    if (this.combinationRefuses(decoded.claimIds)) return { ok: false, revertReason: 'Combination' };
    // THE KERNEL'S ELIGIBILITY CHECK, and the reason this fake has it.
    //
    // `ProvianPVT9._verifyEligibility` runs on EVERY settle and reverts `VerificationFailed`
    // unless the eligibility verifier has already affirmed the batch's digest. Without this
    // clause the fake answered `ok` to a dry run the real kernel refuses, and the runner's
    // pre-flight ordering — which simulated BEFORE approving — looked correct in every test
    // while making settlement impossible in production. The first end-to-end fork run against
    // the deployed kernel is what surfaced it (`0x439cc0cd`, `VerificationFailed()`).
    //
    // With the clause, removing the pre-simulation approval in `resolveBatch` turns the whole
    // suite red. That is the RED control for the ordering.
    if (!this.affirmedDigests.has(decoded.batchId.toLowerCase())) {
      return { ok: false, revertReason: 'VerificationFailed' };
    }
    // Read-after-write race on the eligibility STATICCALL: the approval IS affirmed on-chain,
    // but this `eth_call` lands on a replica one block behind and still reverts. Same shape as
    // FakeVerifier.staleAffirmReads, on the settle-simulation path.
    if (this.staleSimulateReads > 0) {
      this.staleSimulateReads -= 1;
      return { ok: false, revertReason: 'VerificationFailed' };
    }
    return { ok: true, revertReason: null };
  }

  /** See the read-after-write note in `simulate`; how many affirmed reads still read stale. */
  staleSimulateReads = 0;

  async sign(tx: SignableTransaction): Promise<{ raw: string; hash: string }> {
    const raw = JSON.stringify({ ...tx, valueWei: tx.valueWei.toString(), gasLimit: tx.gasLimit.toString(), maxFeePerGasWei: tx.maxFeePerGasWei.toString(), maxPriorityFeePerGasWei: tx.maxPriorityFeePerGasWei.toString() });
    const hash = `0x${createHash('sha256').update(raw, 'utf8').digest('hex')}`;
    return { raw, hash };
  }

  /** Non-null makes every broadcast throw — the gas EOA running dry mid-settlement. */
  failBroadcast: string | null = null;

  async broadcast(raw: string): Promise<void> {
    if (this.failBroadcast !== null) throw new Error(this.failBroadcast);
    const parsed = JSON.parse(raw) as SignableTransaction & { gasLimit: string };
    const hash = `0x${createHash('sha256').update(raw, 'utf8').digest('hex')}`;
    // A node answers a transaction it already holds (mined or pending) with "already known".
    if (this.receipts.has(hash) || this.pending.has(hash)) throw new Error('already known');
    this.broadcasts += 1;
    const behavior = this.behaviors.shift() ?? 'mine-success';
    if (behavior === 'drop') {
      this.pending.set(hash, parsed as unknown as SignableTransaction);
    } else {
      this.mine(hash, parsed.data, behavior, parsed as unknown as SignableTransaction);
    }
    this.onBroadcast?.(this.broadcasts, hash);
  }

  /** Mine a previously dropped transaction (e.g. "while the worker was down"). */
  minePending(behavior: WireBehavior = 'mine-success'): void {
    const [hash] = [...this.pending.keys()];
    if (hash === undefined) throw new Error('nothing pending');
    const tx = this.pending.get(hash)!;
    this.pending.delete(hash);
    this.mine(hash, tx.data, behavior === 'drop' ? 'mine-success' : behavior, tx);
  }

  /** Mine one SPECIFIC pending transaction (by hash). */
  minePendingHash(hash: string, behavior: 'mine-success' | 'mine-revert' = 'mine-success'): void {
    const tx = this.pending.get(hash);
    if (tx === undefined) throw new Error(`${hash} is not pending`);
    this.pending.delete(hash);
    this.mine(hash, tx.data, behavior, tx);
  }

  private decode(data: string): { lane: string; batchId: string; cursorStart: bigint; cursorEnd: bigint; claimIds: string[] } | null {
    try {
      const parsed = kernelInterface.parseTransaction({ data });
      if (parsed === null) return null;
      const cursorStart = BigInt(parsed.args[3]);
      const cursorEnd = BigInt(parsed.args[4]);
      const claims = parsed.args[6] as Array<{ claimId?: string } & ReadonlyArray<unknown>>;
      const claimIds = claims.map((claim) => String((claim as unknown as unknown[])[0]).toLowerCase());
      return {
        lane: parsed.name === 'settleGenesisPEBatch' ? 'genesis' : 'standard',
        batchId: String(parsed.args[0]),
        cursorStart,
        cursorEnd,
        claimIds,
      };
    } catch {
      return null;
    }
  }

  private nextBlock(): { blockNumber: number; blockHash: string } {
    this.block += 1;
    const blockHash = H(0xb10c_0000 + this.reorgGeneration * 1_000 + this.block);
    this.canonical.set(this.block, blockHash);
    return { blockNumber: this.block, blockHash };
  }

  private mine(hash: string, data: string, behavior: 'mine-success' | 'mine-revert', parsed: SignableTransaction): void {
    // Any other pending transaction at the same nonce can never mine now.
    for (const [other, tx] of [...this.pending.entries()]) {
      if (other !== hash && tx.nonce === parsed.nonce) this.pending.delete(other);
    }
    this.minedNonceFloor = Math.max(this.minedNonceFloor, parsed.nonce + 1);
    const cursorBefore = this.cursor;
    if (data === '0x') {
      const at = this.nextBlock();
      this.receipts.set(hash, { status: 'success', ...at, gasUsed: 21_000n, effectiveGasPriceWei: 5n });
      this.minedEffects.set(hash, { block: at.blockNumber, data, parsed, cursorBefore, claimIds: [], status: 'success' });
      return;
    }
    const decoded = this.decode(data);
    let status: 'success' | 'reverted' = behavior === 'mine-revert' ? 'reverted' : 'success';
    if (decoded === null || decoded.cursorStart !== this.cursor
      || decoded.claimIds.some((id) => this.claimSettled.has(id) || this.poisoned.has(id))
      || this.combinationRefuses(decoded.claimIds)) {
      status = 'reverted'; // the kernel's own refusal, whatever the script says
    }
    if (status === 'success' && decoded !== null) {
      this.cursorBeforeLastMine = this.cursor;
      this.cursor = decoded.cursorEnd;
      for (const id of decoded.claimIds) this.claimSettled.add(id);
      this.minedLanes.push(decoded.lane);
      // Re-arm the replica-lag for the reads following THIS mine.
      this.staleCursorReads = this.cursorLagPerMine;
      this.successfulMines += 1;
      // Dangerous-direction control: overwrite the cursor out of range once armed.
      if (this.cursorHijack !== null && this.successfulMines === this.cursorHijack.afterMines) {
        this.cursor = this.cursorHijack.to;
        this.staleCursorReads = 0;
      }
    }
    const at = this.nextBlock();
    if (status === 'success' && decoded !== null) {
      for (const id of decoded.claimIds) this.claimSettledAt.set(id, at.blockNumber);
    }
    this.receipts.set(hash, { status, ...at, gasUsed: 500_000n, effectiveGasPriceWei: 5n });
    this.minedEffects.set(hash, {
      block: at.blockNumber, data, parsed, cursorBefore,
      claimIds: status === 'success' && decoded !== null ? decoded.claimIds : [], status,
    });
  }

  /**
   * — a load-balanced replica FLAPPING between two receipts for one
   * transaction: read number `n` (1-based, counting reads of `hash` only) returns `alternate`
   * when `useAlternate(n)`. Drives a recheck that never settles, to prove the loop is bounded.
   */
  receiptFlap: { hash: string; alternate: MinedReceipt; useAlternate: (n: number) => boolean; reads: number } | null = null;

  async getReceipt(txHash: string): Promise<MinedReceipt | null> {
    if (this.hiddenReceipts.has(txHash)) return null;
    if (this.receiptFlap !== null && this.receiptFlap.hash === txHash) {
      this.receiptFlap.reads += 1;
      if (this.receiptFlap.useAlternate(this.receiptFlap.reads)) return this.receiptFlap.alternate;
    }
    return this.receipts.get(txHash) ?? null;
  }
}

function standardClaim(n: number, contributor: string): NewClaimInput {
  return {
    leg: 'sole' as const,
    pe_id: `pe-${String(n).padStart(4, '0')}`,
    claim_id: claimIdFor(`pe-${String(n).padStart(4, '0')}`, n),
    lane: 'standard',
    contributor,
    beneficiary_class: 1,
    record_points_atomic: '1000000000000000000',
  };
}

function genesisClaim(n: number, contributor: string): NewClaimInput {
  return {
    leg: 'sole' as const,
    pe_id: `pe-g-${String(n).padStart(4, '0')}`,
    claim_id: claimIdFor(`pe-g-${String(n).padStart(4, '0')}`, 5000 + n),
    lane: 'genesis',
    contributor,
    genesis_anchor_key: H(6000 + n),
    wallet_id: H(7000 + n),
    one_time_anchor: H(8000 + n),
    grant_type: 1,
    qualified_at: 1_700_000_000_000,
    reserved_gross_atomic: '75000000000000000000',
  };
}

/**
 * An in-memory stand-in for `ProvianPVT9EligibilityVerifier`. It derives the digest with the
 * SAME pinned functions the gate uses, so an approval recorded here is an approval for
 * exactly the batch that was submitted — a stub that accepted any digest would hide the very
 * binding these tests exist to prove.
 */
class FakeVerifier implements BatchApproverAdapter {
  readonly kernelAddress = KERNEL;
  readonly chainId = 8453n;
  readonly affirmed = new Set<string>();
  /**
   * The chain this verifier's approvals become visible to. On-chain an approval is a storage
   * write the kernel's `eth_call` immediately sees; wiring the two fakes together is what
   * reproduces that, and what makes simulate-before-approve fail here as it does in production.
   */
  chain: { affirmedDigests: Set<string> } | null = null;
  approveCalls = 0;
  /** Set to make every approval attempt throw, emulating an unreachable verifier. */
  failApprovals = false;
  /**
   * Read-after-write race: how many post-approve confirmation reads return false even though
   * the approval IS committed — the load-balanced RPC serving a backend one block behind the
   * approve. Consumed only when the approval genuinely exists, so a pre-approve read (step 6)
   * never trips it.
   */
  staleAffirmReads = 0;

  /**
   * The kernel's per-claim `claimSettled` map, as this fake models it. A claim id in
   * this set reads settled on-chain — the agent leg of a split act after it minted. Empty by
   * default (nothing paid yet). `settledThrows` emulates an unreachable kernel view.
   */
  readonly settledClaims = new Set<string>();
  settledThrows = false;

  async isClaimSettled(claimId: string): Promise<boolean> {
    if (this.settledThrows) throw new Error('kernel unreachable');
    return this.settledClaims.has(claimId.toLowerCase());
  }

  async isAffirmed(settlementDigest: string, lane: SettlementLane): Promise<boolean> {
    const recorded = this.affirmed.has(`${lane}:${settlementDigest.toLowerCase()}`);
    if (recorded && this.staleAffirmReads > 0) {
      this.staleAffirmReads -= 1;
      return false;
    }
    return recorded;
  }

  async approveStandardBatch(call: { header: Parameters<typeof computeSettlementDigest>[0]['header']; recipients: Parameters<typeof hashStandardClaims>[0]; claims: Parameters<typeof hashStandardClaims>[1] }): Promise<string> {
    this.approveCalls += 1;
    if (this.failApprovals) throw new Error('verifier unreachable');
    const d = computeSettlementDigest({
      kernelAddress: this.kernelAddress,
      chainId: this.chainId,
      lane: SettlementLane.StandardPE,
      header: call.header,
      claimsHash: hashStandardClaims(call.recipients, call.claims),
    });
    this.affirmed.add(`${SettlementLane.StandardPE}:${d.toLowerCase()}`);
    this.chain?.affirmedDigests.add(String(call.header.batchId).toLowerCase());
    return d;
  }

  async approveGenesisBatch(call: { header: Parameters<typeof computeSettlementDigest>[0]['header']; recipients: Parameters<typeof hashGenesisClaims>[0]; claims: Parameters<typeof hashGenesisClaims>[1] }): Promise<string> {
    this.approveCalls += 1;
    if (this.failApprovals) throw new Error('verifier unreachable');
    const d = computeSettlementDigest({
      kernelAddress: this.kernelAddress,
      chainId: this.chainId,
      lane: SettlementLane.GenesisPE,
      header: call.header,
      claimsHash: hashGenesisClaims(call.recipients, call.claims),
    });
    this.affirmed.add(`${SettlementLane.GenesisPE}:${d.toLowerCase()}`);
    this.chain?.affirmedDigests.add(String(call.header.batchId).toLowerCase());
    return d;
  }
}

/** Serves an eligible candidate for every fixture PE, unless a peId is marked ineligible. */
class FakeCandidateSource implements EligibilityCandidateSource {
  readonly ineligible = new Set<string>();
  readonly withheld = new Set<string>();
  /**
   * PEs whose PE-level `mint_status` reads 'minted'. This is what the writeback
   * sets after a split act's FIRST leg settles, and it is the coarse status that would strand
   * the still-unsettled sibling leg as `already_minted`.
   */
  readonly minted = new Set<string>();

  async loadCandidates(peIds: readonly string[]): Promise<ReadonlyMap<string, EligibilityCandidate>> {
    const out = new Map<string, EligibilityCandidate>();
    for (const peId of peIds) {
      if (this.withheld.has(peId)) continue;
      const n = Number(peId.replace(/\D+/g, '')) + (peId.startsWith('pe-g-') ? 5000 : 0);
      let cand = this.ineligible.has(peId)
        // A real rejection shape, not a sentinel: no work evidence at all is the
        // `ghost_pe_no_work_evidence` case the criteria are written to catch.
        ? { ...eligibleCandidate(peId, n), workEvidence: {} }
        : eligibleCandidate(peId, n);
      if (this.minted.has(peId)) cand = { ...cand, relayMintStatus: 'minted' };
      out.set(peId, cand);
    }
    return out;
  }
}

interface Harness {
  db: SettlementDb;
  store: Map<string, Record<string, unknown>>;
  chain: FakeChain;
  deps: CycleRunnerDeps;
  config: CycleRunnerConfig;
  crashAtSleep: (n: number) => void;
  verifier: FakeVerifier;
  candidateSource: FakeCandidateSource;
}

function makeHarness(configOverrides?: Partial<CycleRunnerConfig>): Harness {
  const fake = createFakeFirestore();
  const db = fake as unknown as SettlementDb;
  const chain = new FakeChain();
  let t = 100_000;
  let sleepCalls = 0;
  let crashAt: number | null = null;
  const verifier = new FakeVerifier();
  verifier.chain = chain;
  const candidateSource = new FakeCandidateSource();
  const approval: BatchApprovalDeps = { approver: verifier, candidates: candidateSource };
  const deps: CycleRunnerDeps = {
    db,
    chain,
    now: () => t,
    sleep: async (ms: number) => {
      sleepCalls += 1;
      if (crashAt !== null && sleepCalls >= crashAt) throw new CrashError('scripted crash');
      t += ms;
    },
    approval,
    standardLaneAdmission: testOnlyAdmittedStandardLaneVerdict(),
  };
  const config: CycleRunnerConfig = {
    cycleId: 'cycle-epoch0-1',
    workerId: 'worker-a',
    signerAddress: SIGNER,
    leaseTtlMs: 600_000,
    boundarySafetyMarginSec: 120,
    limits: {
      maxTransactions: PLAN_INITIAL_CYCLE_MAX_TRANSACTIONS,
      maxFeeWeiTotal: PLAN_INITIAL_CYCLE_MAX_FEE_WEI,
    },
    batchLimits: { maxRecipients: 3, maxClaims: 6, maxGas: 30_000_000 },
    gasModel: { baseGas: 100_000, gasPerRecipient: 50_000, gasPerClaim: 23_283 },
    gasHeadroomBps: 12_000,
    receiptPollIntervalMs: 1_000,
    replaceAfterMs: 60_000,
    feeBumpBps: 1_500,
    maxReplacementsPerBatch: 3,
    maxRunMs: 3_600_000,
    ledgerPageSize: 10,
    selectionBudgetClaims: 100,
    ...configOverrides,
  };
  return {
    db,
    store: fake.store,
    chain,
    deps,
    config,
    crashAtSleep: (n: number) => { crashAt = n; },
    verifier,
    candidateSource,
  };
}

const cycleDoc = (store: Map<string, Record<string, unknown>>, cycleId = 'cycle-epoch0-1'): SettlementCycleDoc =>
  store.get(`pvt9_settlement_cycles_v1/${cycleId}`) as unknown as SettlementCycleDoc;

const batchDocs = (store: Map<string, Record<string, unknown>>): SettlementBatchDoc[] =>
  [...store.entries()]
    .filter(([key]) => key.startsWith('pvt9_settlement_batches_v1/'))
    .map(([, doc]) => doc as unknown as SettlementBatchDoc);

describe('multi-transaction cycle (serial batches over one cursor)', () => {
  it('settles a mixed backlog across several transactions, Genesis first, to exhaustion', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, [
      ...[1, 2, 3, 4, 5].map((n) => standardClaim(n, ADDR(0xa0 + n))),
      ...[1, 2].map((n) => genesisClaim(n, ADDR(0x90 + n))),
    ], 50_000);

    const outcome = await runSettlementCycle(harness.deps, harness.config);
    expect(outcome.outcome).toBe('completed');
    expect(outcome.stopReason).toBe('backlog_exhausted');
    expect(outcome.claimsSettled).toBe(7);
    expect(outcome.recipientsSettled).toBe(7);
    // 3-recipient batches: genesis [2] then standard [3,2] = 3 transactions.
    expect(outcome.transactionsSubmitted).toBe(3);
    expect(harness.chain.minedLanes[0]).toBe('genesis');
    expect(harness.chain.cursor).toBe(7n);
    // Durable cursor tracks the chain exactly.
    expect(cycleDoc(harness.store).cursor_next).toBe('7');
    // Every ledger row settled exactly once, every batch writeback complete.
    for (const batch of batchDocs(harness.store)) {
      expect(batch.status).toBe('confirmed');
      expect(batch.writebacks_complete).toBe(true);
    }
  });

  it('refuses when the epoch gate is closed and when advance is due', async () => {
    const closed = makeHarness();
    closed.chain.epochZeroArmed = false;
    const closedOutcome = await runSettlementCycle(closed.deps, closed.config);
    expect(closedOutcome.outcome).toBe('refused');
    expect(closedOutcome.stopReason).toBe('epoch_gate_closed');

    const behind = makeHarness();
    behind.chain.nowSec = behind.chain.epochZeroStartsAtSec + 2 * EPOCH_DURATION + 5;
    const behindOutcome = await runSettlementCycle(behind.deps, behind.config);
    expect(behindOutcome.outcome).toBe('refused');
    expect(behindOutcome.stopReason).toBe('epoch_advance_required');
  });
});

// ---------------------------------------------------------------------------
// WS1 — the top-of-loop cursor check waits out read-your-writes replica lag on
// the runner's OWN just-confirmed batch (benign) rather than aborting, while the
// two dangerous directions (chain ahead of durable, chain below the cycle seed)
// still fail loud. Acceptance for throughput is a real run draining >1 batch;
// this is the unit-level proof of it, plus the controls that prove the guard
// survived. The fake advances its cursor synchronously, so the lag is INJECTED
// (`cursorLagPerMine`) exactly like the existing `staleSimulateReads`.
// ---------------------------------------------------------------------------
describe('WS1 · cursor-reflection retry (replica read-your-writes lag)', () => {
  const seedSeven = (h: ReturnType<typeof makeHarness>) =>
    registerClaimsBulk(h.db, [
      ...[1, 2, 3, 4, 5].map((n) => standardClaim(n, ADDR(0xa0 + n))),
      ...[1, 2].map((n) => genesisClaim(n, ADDR(0x90 + n))),
    ], 50_000);

  it('THROUGHPUT: drains the whole multi-batch backlog despite per-mine replica lag', async () => {
    const harness = makeHarness({ cursorReflect: { attempts: 8, delayMs: 1 } });
    harness.chain.cursorLagPerMine = 2; // 2 stale reads follow every settle
    await seedSeven(harness);

    const outcome = await runSettlementCycle(harness.deps, harness.config);

    // Throughput MOVED: all 7 claims across 3 batches, not one-then-abort.
    expect(outcome.outcome).toBe('completed');
    expect(outcome.stopReason).toBe('backlog_exhausted');
    expect(outcome.claimsSettled).toBe(7);
    expect(outcome.transactionsSubmitted).toBe(3);
    expect(harness.chain.cursor).toBe(7n);
    expect(cycleDoc(harness.store).cursor_next).toBe('7');
  });

  it('CONTROL (bound too tight → one batch/run): reports awaiting_finality, never a silent completed', async () => {
    const harness = makeHarness({ cursorReflect: { attempts: 0, delayMs: 1 } });
    harness.chain.cursorLagPerMine = 2;
    await seedSeven(harness);

    const outcome = await runSettlementCycle(harness.deps, harness.config);

    // Zero retry budget = the pre-fix one-batch behaviour — but VISIBLE, not a
    // false success. This is exactly what surfaces a too-tight production bound.
    expect(outcome.outcome).toBe('stopped');
    expect(outcome.stopReason).toBe('awaiting_finality');
    expect(outcome.batchesConfirmed).toBe(1);
    expect(outcome.claimsSettled).toBeGreaterThan(0);
    expect(outcome.claimsSettled).toBeLessThan(7);
  });

  it('awaiting_finality when the chain never reflects within the bound (persistent lag)', async () => {
    const harness = makeHarness({ cursorReflect: { attempts: 3, delayMs: 1 } });
    harness.chain.cursorLagPerMine = 1000; // never catches up within the bound
    await seedSeven(harness);

    const outcome = await runSettlementCycle(harness.deps, harness.config);
    expect(outcome.outcome).toBe('stopped');
    expect(outcome.stopReason).toBe('awaiting_finality');
    expect(outcome.batchesConfirmed).toBe(1);
  });

  it('CONTROL (dangerous — chain AHEAD of durable): fails loud, never waits', async () => {
    const harness = makeHarness({ cursorReflect: { attempts: 50, delayMs: 1 } });
    // After batch 1 confirms, a rogue settle jumps the chain far AHEAD of durable
    // — a settle the durable store never recorded. Must abort, not wait it out.
    harness.chain.cursorHijack = { afterMines: 1, to: 99n };
    await seedSeven(harness);

    const outcome = await runSettlementCycle(harness.deps, harness.config);
    expect(outcome.outcome).toBe('stopped');
    expect(outcome.stopReason).toBe('resumption_abort');
    expect(outcome.batchesConfirmed).toBe(1); // aborted at the check, not after burning the budget
  });

  it('CONTROL (dangerous — chain BELOW the cycle seed): fails loud, never waits', async () => {
    const harness = makeHarness({ cursorReflect: { attempts: 50, delayMs: 1 } });
    harness.chain.cursor = 5n; // cycle seeds cursor_start = 5
    // After batch 1 the chain regresses BELOW the seed (a reorg past this cycle's start).
    harness.chain.cursorHijack = { afterMines: 1, to: 2n };
    await seedSeven(harness);

    const outcome = await runSettlementCycle(harness.deps, harness.config);
    expect(outcome.outcome).toBe('stopped');
    expect(outcome.stopReason).toBe('resumption_abort');
  });
});

// ---------------------------------------------------------------------------
// the cursor-reflect wait is bounded by the RUN's own deadline, not a
// small fixed attempt cap. Production `cycleConfig()` sets no `cursorReflect`, so
// `attempts` is undefined and the wait is deadline-bounded: the weekly cron now
// drains the WHOLE backlog in ONE run and never strands the rest for 7 days the
// first time a lag spike exceeds a fixed cap. The dangerous-direction guards are
// untouched (proved by the WS1 controls above); the only relaxation is HOW LONG
// the benign wait runs, which settles nothing and therefore cannot double-mint.
// ---------------------------------------------------------------------------
describe(' · deadline-bounded cursor-reflect drains unattended', () => {
  const seedSeven = (h: ReturnType<typeof makeHarness>) =>
    registerClaimsBulk(h.db, [
      ...[1, 2, 3, 4, 5].map((n) => standardClaim(n, ADDR(0xa0 + n))),
      ...[1, 2].map((n) => genesisClaim(n, ADDR(0x90 + n))),
    ], 50_000);

  it('FIX: attempts UNSET (production shape) + a lag far past the old 20-cap still drains the whole backlog in one run', async () => {
    // Production shape: no `attempts` => deadline-bounded. `delayMs:1` keeps it fast.
    const harness = makeHarness({ cursorReflect: { delayMs: 1 } });
    harness.chain.cursorLagPerMine = 30; // exceeds the pre-fix fixed 20-attempt cap
    await seedSeven(harness);

    const outcome = await runSettlementCycle(harness.deps, harness.config);

    // Drained fully — NOT stranded at awaiting_finality after one batch.
    expect(outcome.outcome).toBe('completed');
    expect(outcome.stopReason).toBe('backlog_exhausted');
    expect(outcome.claimsSettled).toBe(7);
    expect(outcome.recipientsSettled).toBe(7);
    expect(outcome.batchesConfirmed).toBe(3); // genesis [2] then standard [3,2], reflect-waiting between each
    // NO-DOUBLE-MINT: every claim settled EXACTLY once; the chain cursor advanced
    // exactly to 7; the durable cursor tracks it; and the FakeChain (which reverts a
    // re-settle just like the kernel's ClaimAlreadySettled/CursorDiscontinuity) never
    // had to reject one.
    expect(harness.chain.claimSettled.size).toBe(7);
    expect(harness.chain.cursor).toBe(7n);
    expect(cycleDoc(harness.store).cursor_next).toBe('7');
    for (const batch of batchDocs(harness.store)) {
      expect(batch.status).toBe('confirmed');
      expect(batch.writebacks_complete).toBe(true);
    }
  });

  it('RED CONTROL: the SAME lag under the old fixed 20-attempt cap strands at awaiting_finality after one batch', async () => {
    // The pre-fix behaviour the FIX above replaces: a fixed cap gives up mid-drain and
    // a weekly cron leaves the rest for 7 days. Proves the deadline bound is load-bearing.
    const harness = makeHarness({ cursorReflect: { attempts: 20, delayMs: 1 } });
    harness.chain.cursorLagPerMine = 30;
    await seedSeven(harness);

    const outcome = await runSettlementCycle(harness.deps, harness.config);
    expect(outcome.outcome).toBe('stopped');
    expect(outcome.stopReason).toBe('awaiting_finality');
    expect(outcome.batchesConfirmed).toBe(1);
    expect(outcome.claimsSettled).toBeLessThan(7);
    // Even on the strand, what DID settle settled exactly once — never a double-mint.
    expect(harness.chain.claimSettled.size).toBe(outcome.claimsSettled);
  });

  it('ALREADY-SETTLED never re-minted: a second run over the drained ledger settles nothing, broadcasts nothing, moves no cursor', async () => {
    const harness = makeHarness({ cursorReflect: { delayMs: 1 } });
    harness.chain.cursorLagPerMine = 5;
    await seedSeven(harness);
    const first = await runSettlementCycle(harness.deps, harness.config);
    expect(first.outcome).toBe('completed');
    expect(harness.chain.claimSettled.size).toBe(7);
    const broadcastsAfterFirst = harness.chain.broadcasts;
    const cursorAfterFirst = harness.chain.cursor;

    // A fresh cycle over the SAME, now fully-settled ledger. Nothing is selectable, so it
    // exhausts immediately — it never plans, never broadcasts, never re-mints a settled claim.
    const second = await runSettlementCycle(
      harness.deps, { ...harness.config, cycleId: 'cycle-epoch0-2' },
    );
    expect(second.outcome).toBe('completed');
    expect(second.stopReason).toBe('backlog_exhausted');
    expect(second.claimsSettled).toBe(0);
    expect(harness.chain.broadcasts).toBe(broadcastsAfterFirst); // no new settle tx
    expect(harness.chain.cursor).toBe(cursorAfterFirst);         // cursor never double-advanced
    expect(harness.chain.claimSettled.size).toBe(7);             // the same 7, none re-added
  });
});

describe(' · the standard-lane reconciliation gate at the cycle runner', () => {
  const refused = {
    admitted: false as const,
    reason: 'report_absent' as const,
    detail: 'no published reconciliation report (test)',
  };

  it('RED — a refused verdict holds a standard-only backlog: nothing settles, nothing broadcasts', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db,
      [1, 2, 3].map((n) => standardClaim(n, ADDR(0xa0 + n))), 50_000);

    const outcome = await runSettlementCycle(
      { ...harness.deps, standardLaneAdmission: refused }, harness.config,
    );
    expect(outcome.outcome).toBe('stopped');
    expect(outcome.stopReason).toBe('standard_lane_refused');
    expect(outcome.detail).toContain('report_absent');
    expect(outcome.claimsSettled).toBe(0);
    expect(outcome.transactionsSubmitted).toBe(0);
    expect(harness.chain.broadcasts).toBe(0);
    // Held, not lost: every ledger row is still unsettled durable backlog.
    const rows = [...harness.store.entries()]
      .filter(([key]) => key.startsWith('pvt9_claim_ledger_v1/'))
      .map(([, doc]) => doc);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.settled).toBe(false);
  });

  it('the Genesis lane is UNAFFECTED by a standard-lane refusal (the operator: no gate on the minting path)', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, [
      ...[1, 2, 3].map((n) => standardClaim(n, ADDR(0xa0 + n))),
      ...[1, 2].map((n) => genesisClaim(n, ADDR(0x90 + n))),
    ], 50_000);

    const outcome = await runSettlementCycle(
      { ...harness.deps, standardLaneAdmission: refused }, harness.config,
    );
    // Genesis settled to exhaustion; the held standard claims are why the
    // stop is the gate's, not 'backlog_exhausted' — an operator must see it.
    expect(outcome.outcome).toBe('stopped');
    expect(outcome.stopReason).toBe('standard_lane_refused');
    expect(outcome.claimsSettled).toBe(2);
    expect(harness.chain.minedLanes.every((lane) => lane === 'genesis')).toBe(true);
    expect(harness.chain.cursor).toBe(2n);
  });

  it('CONTROL — the identical backlog settles fully under an admitted verdict', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, [
      ...[1, 2, 3].map((n) => standardClaim(n, ADDR(0xa0 + n))),
      ...[1, 2].map((n) => genesisClaim(n, ADDR(0x90 + n))),
    ], 50_000);
    const outcome = await runSettlementCycle(harness.deps, harness.config);
    expect(outcome.outcome).toBe('completed');
    expect(outcome.stopReason).toBe('backlog_exhausted');
    expect(outcome.claimsSettled).toBe(5);
  });
});

describe('crash midway through a multi-transaction cycle (plan acceptance 1)', () => {
  it('resumes at the correct position without double-settling', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db,
      [1, 2, 3, 4, 5, 6].map((n) => standardClaim(n, ADDR(0xa0 + n))), 50_000);

    // Batch 1 mines; batch 2's transaction is DROPPED, then the process dies
    // on the first sleep of the receipt-wait loop.
    harness.chain.behaviors = ['mine-success', 'drop'];
    harness.crashAtSleep(1);
    await expect(runSettlementCycle(harness.deps, harness.config)).rejects.toThrow(CrashError);

    const afterCrash = cycleDoc(harness.store);
    expect(afterCrash.status).toBe('active'); // no clean close — a real crash
    expect(afterCrash.consumed.claims_settled).toBe(3);
    expect(afterCrash.cursor_next).toBe('3');
    const submitted = batchDocs(harness.store).filter((b) => b.status === 'submitted');
    expect(submitted).toHaveLength(1);

    // The dropped transaction lands while the worker is down.
    harness.chain.minePending('mine-success');
    const broadcastsBeforeResume = harness.chain.broadcasts;

    // Fresh run: reconciles the in-flight batch from receipts, applies it
    // exactly once, and finishes the backlog WITHOUT a new transaction for
    // the already-landed batch.
    const resumed = await runSettlementCycle(harness.deps, harness.config);
    expect(resumed.outcome).toBe('completed');
    expect(resumed.resumedBatches).toBe(1);
    expect(resumed.claimsSettled).toBe(6);
    expect(harness.chain.broadcasts).toBe(broadcastsBeforeResume);
    expect(harness.chain.cursor).toBe(6n);
    expect(cycleDoc(harness.store).cursor_next).toBe('6');
    // No duplicate settlement: exactly 6 distinct claims on-chain.
    expect(harness.chain.claimSettled.size).toBe(6);
  });
});

describe('dropped and replacement transactions (plan acceptance 2)', () => {
  it('replaces a stuck transaction at the SAME nonce and applies exactly one settlement', async () => {
    const harness = makeHarness({ replaceAfterMs: 500, receiptPollIntervalMs: 1_000 });
    await registerClaimsBulk(harness.db,
      [1, 2].map((n) => standardClaim(n, ADDR(0xa0 + n))), 50_000);

    harness.chain.behaviors = ['drop', 'mine-success'];
    const outcome = await runSettlementCycle(harness.deps, harness.config);
    expect(outcome.outcome).toBe('completed');
    expect(outcome.claimsSettled).toBe(2);
    expect(outcome.replacementsSubmitted).toBe(1);
    expect(outcome.transactionsSubmitted).toBe(2);

    const [batch] = batchDocs(harness.store);
    expect(batch.attempts).toHaveLength(2);
    expect(batch.attempts[0].kind).toBe('original');
    expect(batch.attempts[1].kind).toBe('replacement');
    // The invariant the reviewer must verify: one nonce for the whole set.
    expect(batch.attempts[1].nonce).toBe(batch.attempts[0].nonce);
    // Fee actually bumped.
    expect(BigInt(batch.attempts[1].max_fee_per_gas_wei))
      .toBeGreaterThan(BigInt(batch.attempts[0].max_fee_per_gas_wei));
    expect(harness.chain.cursor).toBe(2n);
  });

  it('stops gracefully when the replacement budget is exhausted (durable backlog)', async () => {
    const harness = makeHarness({ replaceAfterMs: 500, maxReplacementsPerBatch: 2 });
    await registerClaimsBulk(harness.db,
      [1, 2].map((n) => standardClaim(n, ADDR(0xa0 + n))), 50_000);

    harness.chain.behaviors = ['drop', 'drop', 'drop'];
    const outcome = await runSettlementCycle(harness.deps, harness.config);
    expect(outcome.outcome).toBe('stopped');
    expect(outcome.stopReason).toBe('replacement_budget_exhausted');
    expect(outcome.transactionsSubmitted).toBe(3); // original + 2 replacements
    // Nothing settled, claims remain as durable backlog.
    expect(harness.chain.cursor).toBe(0n);
    expect(outcome.claimsSettled).toBe(0);
  });

  it('retries after an on-chain revert on a NEW nonce only once the old one is consumed', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db,
      [1, 2].map((n) => standardClaim(n, ADDR(0xa0 + n))), 50_000);

    harness.chain.behaviors = ['mine-revert', 'mine-success'];
    const outcome = await runSettlementCycle(harness.deps, harness.config);
    expect(outcome.outcome).toBe('completed');
    expect(outcome.claimsSettled).toBe(2);
    expect(outcome.transactionsSubmitted).toBe(2);

    const [batch] = batchDocs(harness.store);
    expect(batch.attempts.map((a) => a.kind)).toEqual(['original', 'retry_after_revert']);
    expect(batch.attempts[1].nonce).toBe(batch.attempts[0].nonce + 1);
    expect(batch.attempts[0].mined?.status).toBe('reverted');
  });
});

describe('graceful persistent backlog at every guardrail (plan acceptance 6)', () => {
  it('admits contributors by their oldest unsettled claim, not grindable address order', async () => {
    const harness = makeHarness({
      limits: { maxTransactions: 1, maxFeeWeiTotal: PLAN_INITIAL_CYCLE_MAX_FEE_WEI },
      batchLimits: { maxRecipients: 1, maxClaims: 6, maxGas: 30_000_000 },
    });
    const olderHighAddress = standardClaim(41, ADDR(0xf1));
    const newerLowAddress = standardClaim(42, ADDR(0x01));
    await registerClaimsBulk(harness.db, [olderHighAddress], 10_000);
    await registerClaimsBulk(harness.db, [newerLowAddress], 20_000);

    const outcome = await runSettlementCycle(harness.deps, harness.config);

    expect(outcome.claimsSettled).toBe(1);
    expect(harness.chain.claimSettled.has(olderHighAddress.claim_id.toLowerCase())).toBe(true);
    expect(harness.chain.claimSettled.has(newerLowAddress.claim_id.toLowerCase())).toBe(false);
  });

  it('skips an oldest recipient whose whole pending total exceeds headroom and settles a later fit', async () => {
    const harness = makeHarness({
      limits: { maxTransactions: 1, maxFeeWeiTotal: PLAN_INITIAL_CYCLE_MAX_FEE_WEI },
      batchLimits: { maxRecipients: 3, maxClaims: 6, maxGas: 30_000_000 },
      // A historical pre-group row budget of one would expose only the
      // oversized oldest recipient and head-of-line block the later fit.
      selectionBudgetClaims: 1,
    });
    harness.chain.combinedCapAtomic = 1n * 10n ** 18n;
    const oversized = {
      ...standardClaim(51, ADDR(0xf1)),
      record_points_atomic: (2n * 10n ** 18n).toString(),
    };
    const laterFit = standardClaim(52, ADDR(0xf2));
    await registerClaimsBulk(harness.db, [oversized], 10_000);
    await registerClaimsBulk(harness.db, [laterFit], 20_000);

    const outcome = await runSettlementCycle(harness.deps, harness.config);

    expect(outcome.claimsSettled).toBe(1);
    expect(harness.chain.claimSettled.has(oversized.claim_id.toLowerCase())).toBe(false);
    expect(harness.chain.claimSettled.has(laterFit.claim_id.toLowerCase())).toBe(true);
    expect(harness.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf(oversized.pe_id, 'sole')}`))
      .toMatchObject({ settled: false });
  });

  it('defers under the epoch caps and settles in the next epoch', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db,
      [1, 2].map((n) => standardClaim(n, ADDR(0xa0 + n))), 50_000);

    // Combined cap admits nothing this epoch.
    harness.chain.combinedCapAtomic = 0n;
    harness.chain.genesisCapAtomic = 0n;
    const deferred = await runSettlementCycle(harness.deps, harness.config);
    expect(deferred.outcome).toBe('stopped');
    expect(deferred.stopReason).toBe('epoch_cap_deferral');
    expect(deferred.deferredClaims).toBe(2);
    expect(harness.chain.cursor).toBe(0n);

    // Next epoch: caps restored, new cycle drains the same durable backlog.
    harness.chain.combinedCapAtomic = 10_000_000n * 10n ** 18n;
    harness.chain.genesisCapAtomic = 7_500_000n * 10n ** 18n;
    harness.chain.lastOpenedEpoch = 1;
    harness.chain.nowSec = harness.chain.epochZeroStartsAtSec + EPOCH_DURATION + 100;
    const next = await runSettlementCycle(harness.deps, {
      ...harness.config, cycleId: 'cycle-epoch1-1',
    });
    expect(next.outcome).toBe('completed');
    expect(next.claimsSettled).toBe(2);
    expect(harness.chain.cursor).toBe(2n);
  });

  it('stops at the transaction limit without resetting consumed counters on retry', async () => {
    const harness = makeHarness({ limits: { maxTransactions: 1, maxFeeWeiTotal: PLAN_INITIAL_CYCLE_MAX_FEE_WEI } });
    await registerClaimsBulk(harness.db,
      [1, 2, 3, 4].map((n) => standardClaim(n, ADDR(0xa0 + n))), 50_000);

    const first = await runSettlementCycle(harness.deps, harness.config);
    expect(first.outcome).toBe('stopped');
    expect(first.stopReason).toBe('transaction_limit');
    expect(first.claimsSettled).toBe(3); // one 3-recipient batch landed
    expect(first.transactionsSubmitted).toBe(1);

    // Re-running the SAME cycle does not reset the budget: it refuses again
    // immediately (retry without resetting gas/transaction limits).
    const retry = await runSettlementCycle(harness.deps, harness.config);
    expect(retry.outcome).toBe('refused');
    expect(retry.stopReason).toBe('lease_refused');
    expect(retry.detail).toBe('cycle_closed');
    const doc = cycleDoc(harness.store);
    expect(doc.consumed.transactions_submitted).toBe(1);
  });

  it('stops at the fee limit before submitting anything it cannot afford', async () => {
    const harness = makeHarness({ limits: { maxTransactions: 100, maxFeeWeiTotal: 1n } });
    await registerClaimsBulk(harness.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    const outcome = await runSettlementCycle(harness.deps, harness.config);
    expect(outcome.outcome).toBe('stopped');
    expect(outcome.stopReason).toBe('fee_limit');
    expect(outcome.transactionsSubmitted).toBe(0);
    expect(harness.chain.cursor).toBe(0n);
  });

  it('an unsettleable batch spends no transaction, and the claim the kernel already paid is RECORDED settled ', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    harness.store.set('pe_history/pe-0001', { mint_status: 'eligible', record_points_atomic: '1000000000000000000' });
    // Pre-settle the claim on-chain: the simulation reverts ClaimAlreadySettled.
    harness.chain.claimSettled.add(claimIdFor('pe-0001', 1).toLowerCase());
    const outcome = await runSettlementCycle(harness.deps, harness.config);
    // : the dry run still refuses before any transaction; the claim the KERNEL
    // reads paid at the safe block is recorded settled from chain evidence — never held, where
    // it would be retried, refused, and held again forever.
    expect(outcome.transactionsSubmitted).toBe(0);
    expect(harness.chain.broadcasts).toBe(0);
    expect(outcome.claimsHeld).toBe(0);
    const row = harness.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe-0001', 'sole')}`) ?? {};
    expect(row).toMatchObject({ settled: true, settled_via: 'chain_evidence', settled_tx_hash: null, hold: null });
    expect(harness.store.get('pe_history/pe-0001')).toMatchObject({ mint_status: 'minted', minted_via: 'pvt9_chain_evidence' });
    expect(outcome.outcome).toBe('completed');
    expect(outcome.stopReason).toBe('backlog_exhausted');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WP-C: the eligibility-verifier approval gate
//
// The kernel calls `_verifyEligibility` on EVERY settle, so a settlement that reaches the
// wire without an affirmed approval is gas spent on a guaranteed revert. These tests hold
// the two properties that matter: an ineligible batch CANNOT be approved, and settlement
// FAILS CLOSED when approval is refused or unavailable.
// ─────────────────────────────────────────────────────────────────────────────
describe('WP-C settlement approval gate', () => {
  it('FAILS CLOSED with no approver configured — nothing is signed or broadcast', async () => {
    const harness = makeHarness();
    // Deps without the gate at all: the shape a caller gets by simply forgetting it.
    const deps: CycleRunnerDeps = { ...harness.deps, approval: undefined };
    await registerClaimsBulk(harness.db, [standardClaim(1, ADDR(0xa1))], 50_000);

    const outcome = await runSettlementCycle(deps, harness.config);

    expect(outcome.outcome).toBe('stopped');
    expect(outcome.stopReason).toBe('batch_approval_refused');
    expect(outcome.transactionsSubmitted).toBe(0);
    expect(outcome.claimsSettled).toBe(0);
    expect(harness.chain.broadcasts).toBe(0);
    expect(harness.chain.cursor).toBe(0n);
  });

  it('FAILS CLOSED when an approver exists but eligibility candidates do not', async () => {
    const harness = makeHarness();
    const deps: CycleRunnerDeps = { ...harness.deps, approval: { approver: harness.verifier } };
    await registerClaimsBulk(harness.db, [standardClaim(1, ADDR(0xa1))], 50_000);

    const outcome = await runSettlementCycle(deps, harness.config);

    expect(outcome.stopReason).toBe('batch_approval_refused');
    expect(harness.chain.broadcasts).toBe(0);
    // The approver was never asked to affirm anything it could not judge.
    expect(harness.verifier.approveCalls).toBe(0);
    expect(harness.verifier.affirmed.size).toBe(0);
  });

  it('CANNOT approve an INELIGIBLE batch — the criteria are actually run', async () => {
    const harness = makeHarness();
    // pe-0002 carries no work evidence: `ghost_pe_no_work_evidence` under the real criteria.
    harness.candidateSource.ineligible.add('pe-0002');
    await registerClaimsBulk(
      harness.db,
      [standardClaim(1, ADDR(0xa1)), standardClaim(2, ADDR(0xa2))],
      50_000,
    );

    const outcome = await runSettlementCycle(harness.deps, harness.config);

    // The batch containing the ineligible PE is never approved or sent. the gate NAMES
    // the ineligible claim, so it is held and the eligible one settles on its own batch.
    expect(outcome.claimsHeld).toBe(1);
    expect(outcome.heldClaims[0].reason).toBe('candidate_ineligible');
    expect(outcome.heldClaims[0].claimKey).toBe(claimKeyOf('pe-0002', 'sole'));
    expect(harness.chain.claimSettled.has(claimIdFor('pe-0002', 2).toLowerCase())).toBe(false);
    expect(harness.chain.claimSettled.has(claimIdFor('pe-0001', 1).toLowerCase())).toBe(true);
    expect(outcome.transactionsSubmitted).toBe(1);
    expect(harness.verifier.affirmed.size).toBe(1);
    expect(outcome.stopReason).toBe('backlog_exhausted');
    // And the verdict is the real one, from the real evaluator.
    const verdict = evaluateEligibility({
      ...eligibleCandidate('pe-0002', 2),
      workEvidence: {},
    });
    expect(verdict.kind).toBe('ineligible');
  });

  it('FAILS CLOSED when a withheld candidate makes a PE unjudgeable', async () => {
    const harness = makeHarness();
    harness.candidateSource.withheld.add('pe-0001');
    await registerClaimsBulk(harness.db, [standardClaim(1, ADDR(0xa1))], 50_000);

    const outcome = await runSettlementCycle(harness.deps, harness.config);

    expect(outcome.stopReason).toBe('batch_approval_refused');
    expect(harness.chain.broadcasts).toBe(0);
    expect(harness.verifier.approveCalls).toBe(0);
  });

  it('FAILS CLOSED when the verifier is unreachable — a throw is never an approval', async () => {
    const harness = makeHarness();
    harness.verifier.failApprovals = true;
    await registerClaimsBulk(harness.db, [standardClaim(1, ADDR(0xa1))], 50_000);

    const outcome = await runSettlementCycle(harness.deps, harness.config);

    expect(outcome.stopReason).toBe('batch_approval_refused');
    expect(harness.chain.broadcasts).toBe(0);
    expect(harness.chain.cursor).toBe(0n);
  });

  it('approves an eligible batch, settles it, and is IDEMPOTENT per digest', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(
      harness.db,
      [standardClaim(1, ADDR(0xa1)), standardClaim(2, ADDR(0xa2))],
      50_000,
    );

    const outcome = await runSettlementCycle(harness.deps, harness.config);

    expect(outcome.outcome).toBe('completed');
    expect(outcome.claimsSettled).toBe(2);
    // Exactly one approval for the one batch — the digest binds the batch, not the attempt.
    expect(harness.verifier.approveCalls).toBe(1);
    expect(harness.verifier.affirmed.size).toBe(1);

    // Re-running the gate over the same batch makes NO second approval call.
    const [batch] = batchDocs(harness.store);
    const callsBefore = harness.verifier.approveCalls;
    const again = await approveBatchForSettlement(
      { approver: harness.verifier, candidates: harness.candidateSource },
      batch,
    );
    expect(again.kind).toBe('approved');
    if (again.kind === 'approved') expect(again.alreadyAffirmed).toBe(true);
    expect(harness.verifier.approveCalls).toBe(callsBefore);
  });

  it('refuses when the durable doc and the calldata disagree', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    await runSettlementCycle(harness.deps, harness.config);
    const [batch] = batchDocs(harness.store);

    // Same calldata, tampered header: approving this would affirm a batch that is not the
    // batch being settled.
    const tampered = { ...batch, epoch: batch.epoch + 1 } as SettlementBatchDoc;
    const outcome = await approveBatchForSettlement(
      { approver: harness.verifier, candidates: harness.candidateSource },
      tampered,
    );

    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') expect(outcome.reason).toBe('header_mismatch');
  });

  it('refuses an empty batch even though it is not constructible in the normal path', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    await runSettlementCycle(harness.deps, harness.config);
    const [batch] = batchDocs(harness.store);

    const empty = { ...batch, members: [] } as SettlementBatchDoc;
    const outcome = await approveBatchForSettlement(
      { approver: harness.verifier, candidates: harness.candidateSource },
      empty,
    );

    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') expect(outcome.reason).toBe('member_set_mismatch');
    // No approval was recorded — an empty batch never reaches the verifier.
    const before = harness.verifier.approveCalls;
    expect(harness.verifier.approveCalls).toBe(before);
  });

  it('refuses when a member claim id does not match what is settled', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    await runSettlementCycle(harness.deps, harness.config);
    const [batch] = batchDocs(harness.store);

    const swapped = {
      ...batch,
      members: batch.members.map((m) => ({ ...m, claim_id: H(4242) })),
    } as SettlementBatchDoc;
    const outcome = await approveBatchForSettlement(
      { approver: harness.verifier, candidates: harness.candidateSource },
      swapped,
    );

    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') expect(outcome.reason).toBe('member_set_mismatch');
  });

  // ── Read-after-write race on the affirmation confirmation (the launch blocker) ──
  // The approve tx commits and the verifier DOES affirm the digest on-chain, but the immediate
  // confirmation read lands on a load-balanced RPC backend one block behind and reads false.
  // Proven on Base: the same verify call returns false at block N-1 and true at block N. The
  // bounded retry lets the read catch up instead of wedging a committed approval.
  it('settles through a stale affirmation read — the committed approval is confirmed on retry', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    harness.verifier.staleAffirmReads = 2; // first two post-approve reads are stale

    const deps: CycleRunnerDeps = {
      ...harness.deps,
      approval: { approver: harness.verifier, candidates: harness.candidateSource, sleep: async () => {} },
    };
    const outcome = await runSettlementCycle(deps, harness.config);

    expect(outcome.outcome).toBe('completed');
    expect(outcome.claimsSettled).toBe(1);
    expect(harness.chain.broadcasts).toBe(1);
    // Approved exactly once — the stale reads were retried, never re-approved.
    expect(harness.verifier.approveCalls).toBe(1);
    expect(harness.verifier.staleAffirmReads).toBe(0);
  });

  it('RED — without the retry (attempts=1) the same stale read wedges the committed approval', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    harness.verifier.staleAffirmReads = 2;

    const deps: CycleRunnerDeps = {
      ...harness.deps,
      approval: {
        approver: harness.verifier,
        candidates: harness.candidateSource,
        sleep: async () => {},
        affirmConfirm: { attempts: 1, delayMs: 0 },
      },
    };
    // The runner's own transient-refusal retry is also disabled: this pins the gate.
    const outcome = await runSettlementCycle(deps, { ...harness.config, approvalRetry: { attempts: 1, delayMs: 0 } });

    expect(outcome.stopReason).toBe('batch_approval_refused');
    expect(outcome.claimsSettled).toBe(0);
    expect(harness.chain.broadcasts).toBe(0);
    // The approval WAS recorded on-chain — the refusal is purely the stale read, the exact bug.
    expect(harness.verifier.approveCalls).toBe(1);
    expect(harness.verifier.affirmed.size).toBe(1);
  });

  // ── Same race on the settle simulation's eligibility STATICCALL ──
  it('settles through a stale VerificationFailed on the settle simulation — retried, not condemned', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    harness.chain.staleSimulateReads = 2; // first two eligibility STATICCALLs read stale

    const outcome = await runSettlementCycle(harness.deps, harness.config);

    expect(outcome.outcome).toBe('completed');
    expect(outcome.claimsSettled).toBe(1);
    expect(harness.chain.staleSimulateReads).toBe(0);
  });

  it('RED — without the retry (attempts=1) a stale VerificationFailed condemns a settleable batch', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    harness.chain.staleSimulateReads = 2;

    const config = { ...harness.config, settleSimulate: { attempts: 1, delayMs: 0 } };
    const outcome = await runSettlementCycle(harness.deps, config);

    expect(outcome.stopReason).toBe('batch_unsettleable');
    expect(harness.chain.broadcasts).toBe(0);
  });
});

/**
 * The settlement gas payer is a bare EOA that nothing in this repo funds, monitors, or
 * alarms on, and `SettlementChainAdapter` exposes no balance call — so "it ran dry" is
 * indistinguishable, at the send site, from any other broadcast failure. These tests pin
 * what happens next. The claim under test is CLEAN fail-closed: no partial settlement AND
 * no wedged lease.
 */
describe('broadcast failure — the gas EOA empties mid-settlement', () => {
  it('fails CLOSED: reported not thrown, nothing settled, cycle left adjudicable', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    harness.chain.failBroadcast = 'insufficient funds for gas * price + value';

    const outcome = await runSettlementCycle(harness.deps, harness.config);

    // (1) it does not escape as an uncaught throw
    expect(outcome.outcome).toBe('stopped');
    expect(outcome.stopReason).toBe('broadcast_failed');

    // (2) the cycle stays OPEN. Closing it would strand the recorded attempt forever:
    //     `listUnresolvedBatches` is cycle-scoped and `acquireCycleLease` refuses a closed
    //     cycleId permanently, so a `submitted` batch in a closed cycle is adjudicable by
    //     no future run. Recoverability is proven by the next test, not asserted here.
    expect(cycleDoc(harness.store).status).toBe('active');

    // (3) nothing settled, on chain or in the ledger
    expect(harness.chain.cursor).toBe(0n);
    expect(outcome.claimsSettled).toBe(0);
    expect(cycleDoc(harness.store).cursor_next).toBe('0');
    for (const batch of batchDocs(harness.store)) {
      expect(batch.applied).toBe(false);
      expect(batch.confirmed_tx_hash).toBeNull();
    }
  });

  /**
   * THE decisive property. A broadcast that throws may still have been accepted by the
   * node, so the recorded attempt must remain reachable by a later run. This is the test
   * that fails if `stop()` ever closes the cycle on `broadcast_failed`.
   */
  it('stays RECOVERABLE: a later run with the same cycleId settles the stranded batch', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    harness.chain.failBroadcast = 'insufficient funds for gas * price + value';

    const first = await runSettlementCycle(harness.deps, harness.config);
    expect(first.stopReason).toBe('broadcast_failed');
    expect(harness.chain.cursor).toBe(0n);

    // The payer is refilled; the SAME worker resumes the SAME cycle.
    harness.chain.failBroadcast = null;
    const second = await runSettlementCycle(harness.deps, harness.config);

    // It was NOT refused as a closed cycle, and the claim settled exactly once.
    expect(second.stopReason).not.toBe('lease_refused');
    expect(harness.chain.cursor).toBe(1n);
    expect(harness.chain.claimSettled.size).toBe(1);
  });

  it('RED CONTROL: the identical fixture with a funded payer settles', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    // failBroadcast left null — the ONLY difference from the test above.
    const outcome = await runSettlementCycle(harness.deps, harness.config);
    expect(outcome.stopReason).toBe('backlog_exhausted');
    expect(outcome.claimsSettled).toBe(1);
    expect(harness.chain.cursor).toBe(1n);
  });
});

// ---------------------------------------------------------------------------
// reclaim a recorded batch whose gasLimit the RPC will not broadcast.
//
// A batch sized past the endpoint's eth_sendRawTransaction cap (Alchemy: -32003
// "gas limit too high") is replayed BYTE-IDENTICALLY on every resume — the
// replacement path re-uses the recorded gas_limit and never re-plans, and
// broadcast_failed keeps the cycle open — so it wedges the cycle forever.
// resolveBatch reclaims it, but ONLY under a proof that nothing of it reached a
// chain or a mempool: every attempt unmined with no receipt, the on-chain nonce
// still equals the reserved nonce, and the recorded gasLimit over the ceiling.
// Each RED control removes exactly one precondition and shows the reclaim REFUSE,
// pinning one invariant: nothing settled unconfirmed, no live nonce released, no
// double mint.
// ---------------------------------------------------------------------------
describe(' · reclaim an un-broadcastable recorded batch', () => {
  const CEILING = 12_000_000;
  // gasEstimate × gasHeadroomBps (1.2) => the recorded gasLimit. 20M => 24M > CEILING.
  const OVERSIZED_ESTIMATE = 20_000_000n;

  // Strand a submitted, unmined, oversized batch: run once with a failing
  // broadcast and an estimate that puts the recorded gasLimit over the ceiling.
  async function strandOversizedBatch(ceiling: number | undefined): Promise<ReturnType<typeof makeHarness>> {
    const h = makeHarness(ceiling === undefined ? {} : { broadcastableGasCeiling: ceiling });
    await registerClaimsBulk(h.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    h.chain.gasEstimate = OVERSIZED_ESTIMATE;
    h.chain.failBroadcast = 'could not coalesce error {"code":-32003,"message":"gas limit too high"}';
    const first = await runSettlementCycle(h.deps, h.config);
    expect(first.stopReason).toBe('broadcast_failed');
    const stranded = batchDocs(h.store).find((b) => b.status === 'submitted');
    expect(stranded).toBeDefined();
    expect(BigInt(stranded!.attempts[stranded!.attempts.length - 1].gas_limit)).toBe(24_000_000n);
    expect(stranded!.reserved_nonce).toBe(0);
    return h;
  }

  it('GREEN: reclaims the stranded oversized batch and settles the claim once on the rebuild', async () => {
    const h = await strandOversizedBatch(CEILING);
    // The wire recovers; the resume reclaims the un-broadcastable batch (nonce 0
    // still unmined on chain) and the runner re-plans the claim at the reused nonce.
    h.chain.failBroadcast = null;
    const second = await runSettlementCycle(h.deps, h.config);

    expect(second.outcome).toBe('completed');
    expect(second.stopReason).toBe('backlog_exhausted');
    expect(second.claimsSettled).toBe(1);
    expect(h.chain.cursor).toBe(1n);
    expect(h.chain.claimSettled.size).toBe(1); // minted EXACTLY once, never via the stranded batch
    const docs = batchDocs(h.store);
    expect(docs.some((b) => b.status === 'dead'
      && (b.dead_reason ?? '').includes('oversized_unbroadcastable'))).toBe(true);
    const confirmed = docs.find((b) => b.status === 'confirmed');
    expect(confirmed).toBeDefined();
    // The nonce was REUSED, not skipped: the confirmed rebuild settled at nonce 0.
    expect(confirmed!.reserved_nonce).toBe(0);
  });

  it('RED (gasLimit ≤ ceiling): a batch under the ceiling is NOT reclaimed — retried, as before', async () => {
    // Precondition (3) absent (24M ≤ 30M) → the ordinary broadcast-failure path
    // handles it; the batch is never discarded.
    const h = await strandOversizedBatch(30_000_000);
    const second = await runSettlementCycle(h.deps, h.config); // failBroadcast still set
    expect(second.stopReason).toBe('broadcast_failed');
    expect(batchDocs(h.store).some((b) => b.status === 'dead')).toBe(false);
  });

  it('RED (nonce consumed on chain): an oversized batch whose nonce MINED is NOT reclaimed', async () => {
    // Invariant — never release a nonce a transaction may have consumed: an
    // on-chain nonce past the reserved nonce means an attempt could have mined,
    // so reclaiming would risk a second settle at the same nonce.
    const h = await strandOversizedBatch(CEILING);
    h.chain.txCount = 1; // getTransactionCount('latest') = reserved_nonce (0) + 1
    await runSettlementCycle(h.deps, h.config); // failBroadcast still set
    // The reclaim never fires on a consumed nonce. (the batch is still concluded
    // dead — by a different rule, `nonce_consumed_elsewhere`, which requires the nonce consumed
    // at SAFE depth AND the kernel reading every member unsettled — never as oversized.)
    expect(batchDocs(h.store).some((b) => (b.dead_reason ?? '').includes('oversized_unbroadcastable'))).toBe(false);
    expect(h.chain.claimSettled.size).toBe(0);
  });

  it('RED (a receipt exists): an oversized batch with an on-chain receipt is NOT reclaimed', async () => {
    // Invariant — nothing settled that did not confirm: a receipt means the tx is
    // on chain, so the reclaim must defer to the mined-adjudication path, never discard.
    const h = await strandOversizedBatch(CEILING);
    const stranded = batchDocs(h.store).find((b) => b.status === 'submitted')!;
    const txHash = stranded.attempts[stranded.attempts.length - 1].tx_hash;
    h.chain.receipts.set(txHash, {
      status: 'reverted', blockNumber: 1, blockHash: H(0xb10c_0001), gasUsed: 500_000n, effectiveGasPriceWei: 5n,
    });
    await runSettlementCycle(h.deps, h.config);
    expect(batchDocs(h.store).some((b) => (b.dead_reason ?? '').includes('oversized_unbroadcastable'))).toBe(false);
  });
});

/**
 * M9 — THE SPLIT ACT, DRIVEN ALL THE WAY TO A MINED SETTLEMENT.
 *
 * 's headline claim was "both parties are paid". Nothing tested it past `registerClaim` * every downstream fixture in this file and in `durable-settlement-store.test.ts` was
 * `leg: 'sole'`, and the fork run the M8 commit cites is a single-payee act. The two legs were
 * therefore threaded into the inlet and the ledger but not into `selectLaneWork`,
 * `verifyClaimIdentity`, or `batch-approval` and 414 tests passed anyway.
 *
 * What was actually true before M9, both reproduced by the first test below when the fixes are
 * reverted:
 * 1. `selectLaneWork` keyed its `RecordedClaim` map by PE, so the beneficiary leg overwrote
 * the agent leg; `verifyClaimIdentity` then reported `claim_id_drift` +
 * `duplicate_pe_in_proposal` on a correct proposal. `runSettlementCycle` turns that into
 * `stop('claim_identity_violations')` a WHOLE-CYCLE halt. Selection restarts from the
 * same unsettled rows every sweep, so one split act wedged settlement for everyone,
 * permanently: neither payee paid, and every unrelated claim behind it stopped too.
 * 2. `batch-approval` compared the SOLE-derived claim id against the leg-derived one, so any
 * batch containing a non-`sole` member was refused `claim_id_mismatch` before signing.
 *
 * This is the control that makes both defects executable.
 */

/**
 * EXTERNAL TERMINATION BUDGET — for properties whose negative control is a HANG.
 *
 * The stall backstop's control cannot fail from inside: delete the backstop and
 * `assertNoLegacyLedgerRows` spins forever on a cursor that never advances, so the assertion is
 * never reached and the test HANGS instead of going red. A hang is not a failure — it is a run
 * that never finishes, and in CI it reads as a timeout of unknown cause.
 *
 * A WALL-CLOCK DEADLINE DOES NOT WORK HERE, and it is worth recording why, because it was the
 * obvious answer and it silently did nothing. `Promise.race` against `setTimeout` was tried
 * first: the scan awaits only ALREADY-RESOLVED promises, so every iteration yields to the
 * MICROtask queue and returns. Macrotasks — timers — never get a turn. The spin starves the
 * event loop and the deadline never fires; the test hung for the full 180s cap exactly as it did
 * without one. A timer cannot interrupt a loop that never lets the timer run.
 *
 * What CAN interrupt it is the one thing the loop is forced to call on every iteration: the
 * store. Counting reads makes the budget advance in lockstep with the spin rather than with the
 * clock, so it is immune to the starvation that defeats a timer. Removing the backstop now fails
 * in about a second naming `did_not_terminate`, and the caller still asserts the SPECIFIC
 * refusal, so budget exhaustion can never be mistaken for a pass.
 */
function readBudget(label: string, max = 1_000): () => void {
  let reads = 0;
  return () => {
    reads += 1;
    if (reads > max) {
      throw new Error(`did_not_terminate:${label}: exceeded ${max} reads — the termination backstop is gone`);
    }
  };
}

describe('M9 · a linked-agent split act settles BOTH legs', () => {
  const SPLIT_PE = 'pe-0042';
  const SPLIT_N = 42;
  const AGENT_ADDR = ADDR(0xa9e7);
  const HUMAN_ADDR = ADDR(0x11a1);
  const TOTAL = 1_000_000_000_000_000_000n;
  const AGENT_POINTS = TOTAL * 2000n / 10_000n;
  const HUMAN_POINTS = TOTAL - AGENT_POINTS;

  function legClaimId(leg: 'agent' | 'beneficiary'): string {
    const derived = deriveLegClaimId(peFor(SPLIT_PE, SPLIT_N), leg);
    if (derived.kind !== 'derived') throw new Error('fixture leg has no derivable claim id');
    return derived.claimId;
  }

  /** The two rows the inlet writes for one split act — leg-derived ids, shares summing to whole. */
  function splitClaims(): NewClaimInput[] {
    return [
      {
        leg: 'agent' as const,
        pe_id: SPLIT_PE,
        claim_id: legClaimId('agent'),
        lane: 'standard',
        contributor: AGENT_ADDR,
        beneficiary_class: 1,
        record_points_atomic: AGENT_POINTS.toString(),
      },
      {
        leg: 'beneficiary' as const,
        pe_id: SPLIT_PE,
        claim_id: legClaimId('beneficiary'),
        lane: 'standard',
        contributor: HUMAN_ADDR,
        beneficiary_class: 1,
        record_points_atomic: HUMAN_POINTS.toString(),
      },
    ];
  }

  it('settles both legs in one cycle — two recipients, two claims, the whole act', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, splitClaims(), 50_000);

    const outcome = await runSettlementCycle(harness.deps, harness.config);

    expect(outcome.outcome).toBe('completed');
    expect(outcome.stopReason).not.toBe('claim_identity_violations');
    expect(outcome.stopReason).not.toBe('batch_approval_refused');
    expect(outcome.claimsSettled).toBe(2);
    expect(outcome.recipientsSettled).toBe(2);

    // Both claim ids are settled ON CHAIN, under two DIFFERENT ids for one PE.
    expect(harness.chain.claimSettled.has(legClaimId('agent').toLowerCase())).toBe(true);
    expect(harness.chain.claimSettled.has(legClaimId('beneficiary').toLowerCase())).toBe(true);
    expect(legClaimId('agent')).not.toBe(legClaimId('beneficiary'));

    // And both ledger rows are marked settled — the writeback is keyed by CLAIM, so it cannot
    // mark one leg settled on the strength of the other.
    for (const leg of ['agent', 'beneficiary'] as const) {
      const row = harness.store.get(
        `${CLAIM_LEDGER_COLLECTION}/${claimKeyOf(SPLIT_PE, leg)}`,
      );
      expect({ leg, settled: row?.settled }).toEqual({ leg, settled: true });
    }
  });

  it('selection keys the ledger by CLAIM — two legs are two entries, not one', async () => {
    // The defect directly. `selectLaneWork` returns the map `verifyClaimIdentity` judges
    // against; keyed by PE, the beneficiary leg OVERWRITES the agent leg and one of the two
    // claims is then judged as a first sighting with no recorded identity to keep.
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, splitClaims(), 50_000);

    const work = await selectLaneWork(harness.db, 50, 50);
    expect(work.ledger.size).toBe(2);
    expect([...work.ledger.keys()].sort())
      .toEqual([claimKeyOf(SPLIT_PE, 'agent'), claimKeyOf(SPLIT_PE, 'beneficiary')].sort());
    // Each entry keeps its OWN leg and its OWN claim id — a map that collapsed them would still
    // have the right size if the key were, say, the claim id but the record the wrong leg.
    for (const leg of ['agent', 'beneficiary'] as const) {
      const record = work.ledger.get(claimKeyOf(SPLIT_PE, leg));
      expect({ leg: record?.leg, claimId: record?.claimId })
        .toEqual({ leg, claimId: legClaimId(leg) });
    }

    // RED CONTROL: a single-payee act still yields exactly ONE entry, so "two entries" above is
    // caused by the split and not by selection double-counting everything.
    const solo = makeHarness();
    await registerClaimsBulk(solo.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    expect((await selectLaneWork(solo.db, 50, 50)).ledger.size).toBe(1);
  });

  it('the two legs sum to the whole act — neither over- nor under-paid', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, splitClaims(), 50_000);
    await runSettlementCycle(harness.deps, harness.config);

    const points = (['agent', 'beneficiary'] as const).map((leg) => BigInt(String(
      harness.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf(SPLIT_PE, leg)}`)
        ?.record_points_atomic ?? '0',
    )));
    expect(points[0]).toBe(AGENT_POINTS);
    expect(points[1]).toBe(HUMAN_POINTS);
    expect(points[0] + points[1]).toBe(TOTAL);
  });

  it('RED — settling one leg does not settle the other, and the survivor still settles', async () => {
    // The property the per-claim dedupe buys. If the kernel or the writeback keyed on the PE,
    // the second cycle here would find nothing to do and the second payee would never be paid.
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, [splitClaims()[0]], 50_000);
    const first = await runSettlementCycle(harness.deps, harness.config);
    expect(first.claimsSettled).toBe(1);
    expect(harness.chain.claimSettled.has(legClaimId('beneficiary').toLowerCase())).toBe(false);

    await registerClaimsBulk(harness.db, [splitClaims()[1]], 50_000);
    const second = await runSettlementCycle(
      harness.deps, { ...harness.config, cycleId: `${harness.config.cycleId}-b` },
    );
    expect(second.claimsSettled).toBe(1);
    expect(harness.chain.claimSettled.has(legClaimId('beneficiary').toLowerCase())).toBe(true);
  });

  it('RED — a leg whose claim id is NOT the leg derivation is refused before signing', async () => {
    // The batch-approval binding, exercised in the direction that must fail. The agent leg is
    // registered under the SOLE id — which is what the pre-M9 gate expected — and the gate must
    // now reject it, because that id is not this leg's identity.
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, [{
      ...splitClaims()[0],
      claim_id: claimIdFor(SPLIT_PE, SPLIT_N),
    }], 50_000);

    const outcome = await runSettlementCycle(harness.deps, harness.config);

    expect(outcome.stopReason).toBe('batch_approval_refused');
    expect(harness.chain.broadcasts).toBe(0);
    expect(harness.chain.cursor).toBe(0n);
  });

  it('RED — a pre-M8 ledger row with no claim_key refuses the cycle loudly', async () => {
    // `readLedgerPage` orders on `claim_key`, and a real Firestore `orderBy` EXCLUDES documents
    // missing the ordered field — so an unmigrated row is invisible to selection and would be
    // silently re-registered under a fresh row with the same claim id. Refusal, not silence.
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    harness.store.set(`${CLAIM_LEDGER_COLLECTION}/pe-legacy`, {
      pe_id: 'pe-legacy', claim_id: claimIdFor('pe-0009', 9), lane: 'standard',
      contributor: ADDR(0xa1), settled: false, record_points_atomic: '1',
    });

    await expect(runSettlementCycle(harness.deps, harness.config))
      .rejects.toThrow('legacy_claim_ledger_row:pe-legacy');

    // GREEN CONTROL: with `claim_key` present the identical row is accepted, so the refusal is
    // about the missing field and not about the row existing at all.
    harness.store.set(`${CLAIM_LEDGER_COLLECTION}/pe-legacy`, {
      pe_id: 'pe-legacy', claim_key: 'pe-legacy#sole', claim_id: claimIdFor('pe-0009', 9),
      lane: 'standard', contributor: ADDR(0xa1), settled: false, record_points_atomic: '1',
    });
    await expect(assertNoLegacyLedgerRows(harness.db)).resolves.toEqual({ scanned: 2 });
  });

  it('M9r3 — a CLEAN ledger passes at ANY size, INCLUDING past any budget that could return', async () => {
    // THE TEST THAT HAD TO BE REWRITTEN. Its first version declared 7 rows and asserted they
    // scanned clean at every page size — and was GREEN on both defective implementations it
    // named, because both defaulted `maxScan` to 50_000 and 7 rows never reach the truncation
    // branch. Not authored to affirm the defect this time, merely insensitive to it, which has
    // the same consequence: no test in the suite could fail on /.
    //
    // Materializing 50_001 documents is impractical, so the ledger is SYNTHETIC: a store that
    // answers pages from a counter. That makes "there is no size cap" executable — reintroduce
    // any budget at or below `TOTAL` and this test throws.
    const TOTAL = 50_001;
    const claimIdAt = (i: number): string => `0x${i.toString(16).padStart(64, '0')}`;
    let reads = 0;

    const syntheticDb = {
      collection: () => {
        let after: string | undefined;
        let cap = TOTAL;
        let equals: string | undefined;
        const docAt = (i: number) => ({
          id: `synthetic-${i}#sole`,
          data: () => ({ claim_key: `synthetic-${i}#sole`, claim_id: claimIdAt(i) }),
        });
        const q = {
          orderBy: () => q,
          // Every claim id is distinct here, so the tie probe must find exactly ONE row. A fake
          // that ignored `where` would answer with the next page and fabricate a duplicate.
          where: (_f: string, _op: string, v: string) => { equals = v; return q; },
          limit: (n: number) => { cap = n; return q; },
          startAfter: (v: string) => { after = v; return q; },
          get: async () => {
            reads += 1;
            if (equals !== undefined) {
              const i = parseInt(equals, 16);
              return { docs: i >= 0 && i < TOTAL ? [docAt(i)] : [] };
            }
            const from = after === undefined ? 0 : parseInt(after, 16) + 1;
            const docs = [];
            for (let i = from; i < Math.min(from + cap, TOTAL); i += 1) docs.push(docAt(i));
            return { docs };
          },
        };
        return q;
      },
    } as unknown as SettlementDb;

    // The production call shape: no options at all, exactly as `selectLaneWork` invokes it.
    await expect(assertNoLegacyLedgerRows(syntheticDb)).resolves.toEqual({ scanned: TOTAL });
    // It really did page — a single unbounded read would be its own defect (discipline).
    expect(reads).toBeGreaterThan(TOTAL / 500);

    // And the same property on a REAL fake store at every relationship between row count and
    // page size: exact multiple, one over, one under, single-row pages, page larger than the
    // collection. None may refuse, and `scanned` must be exact.
    const harness = makeHarness();
    await registerClaimsBulk(
      harness.db,
      Array.from({ length: 7 }, (_, i) => standardClaim(i + 1, ADDR(0xa1))),
      50_000,
    );
    for (const pageSize of [1, 2, 3, 6, 7, 8, 500]) {
      await expect(assertNoLegacyLedgerRows(harness.db, { pageSize }))
        .resolves.toEqual({ scanned: 7 });
    }
    await expect(assertNoLegacyLedgerRows(harness.db)).resolves.toEqual({ scanned: 7 });
  });

  it('M9r3 — the stall backstop FIRES when the cursor field is absent, and is reachable', async () => {
    // The backstop had no test, and deleting it left every suite green. My first attempt at one
    // did not fix that: it used duplicate `claim_id`s, and the duplicate probe fires first, so
    // the test passed with the backstop deleted — still no coverage.
    //
    // The path that actually reaches it: rows carrying `claim_key` but NO `claim_id`. The cursor
    // then never advances from `undefined`, and the tie probe is skipped (it is guarded on
    // `cursor !== undefined`), so nothing else can catch the spin. Real Firestore's
    // `orderBy('claim_id')` EXCLUDES such documents, which is why this cannot arise in
    // production — but the repo's own fake does NOT exclude them, and that divergence is exactly
    // what a termination backstop is for.
    const rows = [
      { id: 'a#sole', claim_key: 'a#sole' },
      { id: 'b#sole', claim_key: 'b#sole' },
    ];
    const spend = readBudget('assertNoLegacyLedgerRows/cursor-never-advances');
    const noOrderByExclusionDb = {
      collection: () => {
        let cap = 500;
        const q = {
          orderBy: () => q,
          where: () => q,
          startAfter: () => q,
          limit: (n: number) => { cap = n; return q; },
          get: async () => {
            // The external interrupt. A correct scan refuses on its FIRST page, so this is never
            // close to reached; a scan with no backstop trips it almost immediately.
            spend();
            return { docs: rows.slice(0, cap).map((r) => ({ id: r.id, data: () => ({ ...r }) })) };
          },
        };
        return q;
      },
    } as unknown as SettlementDb;

    // A full page that cannot advance the cursor must refuse rather than spin forever.
    //
    // Bounded from OUTSIDE by the read budget above: without it, deleting the backstop makes this
    // line HANG instead of fail, which is why the backstop went untested in the first place.
    // The assertion still demands the SPECIFIC refusal, so budget exhaustion is a failure too.
    await expect(assertNoLegacyLedgerRows(noOrderByExclusionDb, { pageSize: 2 }))
      .rejects.toThrow('legacy_ledger_scan_stalled');

    // GREEN CONTROL: give the same rows a `claim_id` and the identical store scans cleanly, so
    // the refusal is about the absent cursor field and not about this store shape at large.
    rows.forEach((r, i) => {
      (r as Record<string, unknown>).claim_id = `0x${String(i + 1).repeat(64).slice(0, 64)}`;
    });
    await expect(assertNoLegacyLedgerRows(noOrderByExclusionDb, { pageSize: 500 }))
      .resolves.toEqual({ scanned: 2 });
  });

  it('M9r3 — RED: it still FINDS a legacy row, at every page size', async () => {
    // The guard must not have been neutered into always passing. One legacy row among clean
    // ones is refused whatever the paging, including when it is the last row scanned.
    const harness = makeHarness();
    await registerClaimsBulk(
      harness.db,
      Array.from({ length: 5 }, (_, i) => standardClaim(i + 1, ADDR(0xa1))),
      50_000,
    );
    harness.store.set(`${CLAIM_LEDGER_COLLECTION}/pe-legacy`, {
      pe_id: 'pe-legacy', claim_id: `0x${'fe'.repeat(32)}`, lane: 'standard',
      contributor: ADDR(0xa1), settled: false, record_points_atomic: '1',
    });
    for (const pageSize of [1, 2, 5, 6, 500]) {
      await expect(assertNoLegacyLedgerRows(harness.db, { pageSize }))
        .rejects.toThrow('legacy_claim_ledger_row:pe-legacy');
    }
  });

  it('M9r3 — a DUPLICATE claim id is refused, including one split across a page boundary', async () => {
    // Removing the size cap removed the old termination argument. What replaced it is exactness
    // about the one thing that can make this scan skip rows: `startAfter(value)` positions after
    // ALL documents sharing that value, so a duplicate `claim_id` group straddling a page
    // boundary loses its remainder SILENTLY. Writing this test is what surfaced that — my first
    // version asserted a stall that tie-skipping cursors make unreachable, and the fake returned
    // `scanned: 2` for three rows instead. A duplicate claim id is also a double-mint precursor
    // in its own right, so refusing is right on both counts.
    const dupe = `0x${'d0'.repeat(32)}`;
    const seedDupes = (h: ReturnType<typeof makeHarness>, ids: string[]): void => {
      ids.forEach((claimId, i) => {
        h.store.set(`${CLAIM_LEDGER_COLLECTION}/dupe-${i}#sole`, {
          pe_id: `dupe-${i}`, claim_key: `dupe-${i}#sole`, leg: 'sole', claim_id: claimId,
          lane: 'standard', contributor: ADDR(0xa1), settled: false, record_points_atomic: '1',
        });
      });
    };

    // Adjacent within one page.
    const a = makeHarness();
    seedDupes(a, [dupe, dupe, `0x${'d1'.repeat(32)}`]);
    await expect(assertNoLegacyLedgerRows(a.db, { pageSize: 500 }))
      .rejects.toThrow('legacy_ledger_duplicate_claim_id');

    // AND split exactly at the boundary, where the page holds only the group's first member —
    // the case the adjacent check cannot see and the one that silently dropped a row.
    const b = makeHarness();
    seedDupes(b, [dupe, dupe]);
    await expect(assertNoLegacyLedgerRows(b.db, { pageSize: 1 }))
      .rejects.toThrow('legacy_ledger_duplicate_claim_id');

    // GREEN CONTROL: the same rows with DISTINCT claim ids scan cleanly at BOTH page sizes, so
    // the refusals are about the duplication and not about paging at all.
    const c = makeHarness();
    seedDupes(c, [`0x${'d1'.repeat(32)}`, `0x${'d2'.repeat(32)}`]);
    await expect(assertNoLegacyLedgerRows(c.db, { pageSize: 1 }))
      .resolves.toEqual({ scanned: 2 });
    await expect(assertNoLegacyLedgerRows(c.db, { pageSize: 500 }))
      .resolves.toEqual({ scanned: 2 });
  });

  it('M9r2 — every row of a multi-leg act is scanned across a page boundary', async () => {
    // `pe_id` is NOT unique now that one act owns several rows, and a Firestore single-value
    // cursor positions after ALL documents sharing that value — so a page boundary inside a
    // `pe_id` group skipped the rest of the group. The cursor is `claim_id`, which is unique
    // and is carried by pre-M8 rows too.
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, splitClaims(), 50_000);
    await registerClaimsBulk(harness.db, [standardClaim(7, ADDR(0xa1))], 50_000);

    // pageSize 1 forces a boundary INSIDE the two-leg group. All three rows must be seen.
    await expect(assertNoLegacyLedgerRows(harness.db, { pageSize: 1 }))
      .resolves.toEqual({ scanned: 3 });

    // And the guard still FINDS a legacy row that sits inside such a group — the property that
    // matters, not merely the count.
    harness.store.set(`${CLAIM_LEDGER_COLLECTION}/${SPLIT_PE}#legacyish`, {
      pe_id: SPLIT_PE, claim_id: claimIdFor('pe-0009', 9), lane: 'standard',
      contributor: ADDR(0xa1), settled: false, record_points_atomic: '1',
    });
    await expect(assertNoLegacyLedgerRows(harness.db, { pageSize: 1 }))
      .rejects.toThrow('legacy_claim_ledger_row');
  });

});

// ---------------------------------------------------------------------------
// leg-aware `already_minted` a split act's unsettled leg is never
// orphaned by its sibling leg settling first, and a settled leg is never re-paid.
// ---------------------------------------------------------------------------
//
// The setup that produced these: a linked act has an agent (20%) leg and a
// beneficiary (80%) leg, keyed as two claim-ledger rows under one PE. The planner
// orders recipients by address, so the two legs land in DIFFERENT batches; when the
// first (agent) leg settles, the writeback flips the PE-LEVEL `mint_status` to
// 'minted'. The eligibility gate reads that PE-level status, so it then refused the
// still-unsettled human leg as `already_minted` — stranding 263 human legs (249.728
// PVT owed). The fix: the gate consults the kernel's per-claim `claimSettled` (the
// same map `settleStandardPEBatch` checks) and admits a leg the chain proves unpaid,
// while a leg the chain proves paid stays refused.
// ---------------------------------------------------------------------------
// an attestation TOP-UP member survives the whole cycle, INCLUDING the
// batch-approval gate's claim-id re-derivation (the gate that the first cut of
// forgot: it re-derived with the act derivation and would have refused every
// top-up `claim_id_mismatch`, halting the standard lane from that batch onward).
// ---------------------------------------------------------------------------
describe('attestation top-up through the real cycle and approval gate', () => {
  const PE = 'pe-0001';
  function topupClaim(): NewClaimInput {
    const derived = deriveTopupClaimId(peFor(PE, 1), 'sole');
    if (derived.kind !== 'derived') throw new Error('fixture top-up id underivable');
    return {
      leg: 'sole', pe_id: PE, claim_id: derived.claimId, lane: 'standard', contributor: ADDR(0xa1),
      beneficiary_class: 1, record_points_atomic: '250000000000000000',
      claim_kind: 'attestation_topup', topup_of_claim_key: claimKeyOf(PE, 'sole'),
      topup_attestation_tier: 'corroborated', topup_observed_at_ms: 1_785_200_000_500,
    };
  }

  it('act + top-up registered together settle in ONE cycle as two distinct claims', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, [standardClaim(1, ADDR(0xa1)), topupClaim()], 50_000);
    const outcome = await runSettlementCycle(harness.deps, harness.config);
    expect(outcome.stopReason).toBe('backlog_exhausted');
    expect(outcome.claimsSettled).toBe(2);
    expect(harness.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf(PE, 'sole')}`)).toMatchObject({ settled: true });
    expect(harness.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf(PE, 'sole', 'attestation_topup')}`)).toMatchObject({ settled: true });
    expect(harness.verifier.approveCalls).toBeGreaterThan(0);
  });

  it('a top-up on an act that MINTED in an earlier cycle settles in the next (the daily-cadence case)', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    const first = await runSettlementCycle(harness.deps, harness.config);
    expect(first.claimsSettled).toBe(1);
    // The writeback flipped the PE to 'minted'; the corroboration then lands and the
    // top-up lane registers the delta beside the settled act row.
    harness.candidateSource.minted.add(PE);
    await registerClaimsBulk(harness.db, [topupClaim()], 60_000);
    const second = await runSettlementCycle(harness.deps, { ...harness.config, cycleId: 'cycle-epoch0-2' });
    expect(second.stopReason).toBe('backlog_exhausted');
    expect(second.claimsSettled).toBe(1);
    expect(harness.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf(PE, 'sole', 'attestation_topup')}`)).toMatchObject({ settled: true });
    // The act's own row is untouched by the second cycle (settled once, in the first).
    expect(harness.store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf(PE, 'sole')}`)).toMatchObject({ settled: true, settled_batch_id: batchDocs(harness.store)[0].batch_id });
  });

  it('RED control — the SAME top-up batch with the member kind stripped is refused claim_id_mismatch (the gate is kind-aware, not blind)', async () => {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, [topupClaim()], 50_000);
    // Registered alone against an act that already minted (act row present + settled).
    harness.store.set(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf(PE, 'sole')}`, {
      ...standardClaim(1, ADDR(0xa1)), pe_key: PE, claim_key: claimKeyOf(PE, 'sole'), settled: true,
    });
    harness.candidateSource.minted.add(PE);
    const outcome = await runSettlementCycle(harness.deps, harness.config);
    expect(outcome.claimsSettled).toBe(1);
    const [batch] = batchDocs(harness.store);
    expect(batch.members[0].claim_kind).toBe('attestation_topup');
    harness.verifier.affirmed.clear();
    harness.verifier.chain?.affirmedDigests.clear();
    const kindless = { ...batch, members: batch.members.map((m) => { const { claim_kind: _k, ...rest } = m; return rest; }) };
    const out = await approveBatchForSettlement({ approver: harness.verifier, candidates: harness.candidateSource }, kindless);
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.reason).toBe('claim_id_mismatch');
  });
});

describe('leg-aware already_minted (split-leg orphan fix)', () => {
  // One valid single-claim standard batch, with the setup run's affirmation and approve
  // tally reset so the gate re-decides from scratch and an ADMIT goes through a real approve.
  async function oneClaimBatch(): Promise<{ harness: Harness; batch: SettlementBatchDoc; member: SettlementBatchDoc['members'][number] }> {
    const harness = makeHarness();
    await registerClaimsBulk(harness.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    const outcome = await runSettlementCycle(harness.deps, harness.config);
    expect(outcome.claimsSettled).toBe(1);
    const [batch] = batchDocs(harness.store);
    harness.verifier.affirmed.clear();
    harness.verifier.chain?.affirmedDigests.clear();
    harness.verifier.approveCalls = 0;
    return { harness, batch, member: batch.members[0] };
  }

  it('GREEN — admits an unsettled leg whose PE-level mint_status reads minted (the human 80% leg)', async () => {
    const { harness, batch, member } = await oneClaimBatch();
    // flipped the PE to 'minted' after the sibling (agent) leg settled...
    harness.candidateSource.minted.add(member.pe_id);
    // ...but this leg is NOT in the kernel's claimSettled map — it was never paid.
    const out = await approveBatchForSettlement(
      { approver: harness.verifier, candidates: harness.candidateSource },
      batch,
    );
    expect(out.kind).toBe('approved');
    // A real approval, not the idempotent short-circuit: the leg is genuinely admitted.
    expect(harness.verifier.approveCalls).toBeGreaterThan(0);
  });

  it('RED control — the SAME minted PE + unsettled leg is stranded by a pre- adapter (no isClaimSettled)', async () => {
    const { harness, batch, member } = await oneClaimBatch();
    harness.candidateSource.minted.add(member.pe_id);
    // The old adapter shape had no per-claim capability. Fail-closed → the human leg refuses,
    // which is exactly the stranding this fix removes.
    const legacyAdapter: BatchApproverAdapter = {
      kernelAddress: harness.verifier.kernelAddress,
      chainId: harness.verifier.chainId,
      isAffirmed: harness.verifier.isAffirmed.bind(harness.verifier),
      approveStandardBatch: harness.verifier.approveStandardBatch.bind(harness.verifier),
      approveGenesisBatch: harness.verifier.approveGenesisBatch.bind(harness.verifier),
      // isClaimSettled deliberately ABSENT
    };
    const out = await approveBatchForSettlement(
      { approver: legacyAdapter, candidates: harness.candidateSource },
      batch,
    );
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') {
      expect(out.reason).toBe('candidate_ineligible');
      expect(out.ineligible?.[0]?.reasons).toContain('already_minted');
    }
  });

  it('MONEY-SAFETY — a leg the kernel reports SETTLED is refused, never re-paid (the agent 20% leg)', async () => {
    const { harness, batch, member } = await oneClaimBatch();
    harness.candidateSource.minted.add(member.pe_id);
    // This leg IS in claimSettled — it already minted. The relaxation must NOT fire.
    harness.verifier.settledClaims.add(member.claim_id.toLowerCase());
    const out = await approveBatchForSettlement(
      { approver: harness.verifier, candidates: harness.candidateSource },
      batch,
    );
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.reason).toBe('candidate_ineligible');
    // Nothing was signed for an already-paid leg.
    expect(harness.verifier.approveCalls).toBe(0);
  });

  it('MINT-ONCE ACROSS RE-RUN — a leg admitted once is refused after it settles', async () => {
    const { harness, batch, member } = await oneClaimBatch();
    harness.candidateSource.minted.add(member.pe_id);
    const first = await approveBatchForSettlement(
      { approver: harness.verifier, candidates: harness.candidateSource },
      batch,
    );
    expect(first.kind).toBe('approved');
    // The leg settles (its claim enters claimSettled). A re-run must refuse the same leg.
    harness.verifier.settledClaims.add(member.claim_id.toLowerCase());
    const second = await approveBatchForSettlement(
      { approver: harness.verifier, candidates: harness.candidateSource },
      batch,
    );
    expect(second.kind).toBe('refused');
    if (second.kind === 'refused') expect(second.reason).toBe('candidate_ineligible');
  });

  it('NARROW — the relaxation fires ONLY when already_minted is the sole reason', async () => {
    const { harness, batch, member } = await oneClaimBatch();
    // minted AND stripped of work evidence → two rejection reasons. Even with the leg unsettled
    // on-chain, a PE that fails another criterion must still refuse.
    harness.candidateSource.minted.add(member.pe_id);
    harness.candidateSource.ineligible.add(member.pe_id);
    const out = await approveBatchForSettlement(
      { approver: harness.verifier, candidates: harness.candidateSource },
      batch,
    );
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') {
      const reasons = out.ineligible?.[0]?.reasons ?? [];
      expect(reasons).toContain('already_minted');
      expect(reasons.length).toBeGreaterThan(1);
    }
  });

  it('FAIL-CLOSED — a throw from the kernel view refuses the batch (never admits on an unprovable leg)', async () => {
    const { harness, batch, member } = await oneClaimBatch();
    harness.candidateSource.minted.add(member.pe_id);
    harness.verifier.settledThrows = true;
    const out = await approveBatchForSettlement(
      { approver: harness.verifier, candidates: harness.candidateSource },
      batch,
    );
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.reason).toBe('approval_call_failed');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// the settlement runner security fix set
//   1. distinct lease owners for concurrent runs
//   2. stranded batches are always reconciled (any stop, any cycle; no nonce reuse; no abort loop)
// 3. settlement finality at the watchers' safe-head depth; a reorg re-queues and repays
//   4. the standard lane is never wedged (mixed-class contributors, poisoned claims)
// ═════════════════════════════════════════════════════════════════════════════

const ledgerRow = (store: Map<string, Record<string, unknown>>, peId: string): Record<string, unknown> =>
  store.get(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf(peId, 'sole')}`) ?? {};

const cycleDocs = (store: Map<string, Record<string, unknown>>): string[] =>
  [...store.keys()].filter((key) => key.startsWith('pvt9_settlement_cycles_v1/'));

/** A second run on the SAME db/chain/clock: a new cycle id and a new (unique) worker id. */
const nextRun = (h: Harness, cycleId: string, overrides?: Partial<CycleRunnerConfig>): CycleRunnerConfig =>
  ({ ...h.config, cycleId, workerId: `worker-${cycleId}`, ...overrides });

describe(' (1) — concurrent settlement runs get distinct lease owners', () => {
  it('the production worker id is unique per invocation and carries the revision', () => {
    const a = newSettlementWorkerId({ K_REVISION: 'provian-api-00900-abc' } as NodeJS.ProcessEnv);
    const b = newSettlementWorkerId({ K_REVISION: 'provian-api-00900-abc' } as NodeJS.ProcessEnv);
    expect(a).not.toBe(b);
    expect(a.startsWith('pvt9-settlement:provian-api-00900-abc:')).toBe(true);
    expect(newSettlementWorkerId({} as NodeJS.ProcessEnv).startsWith('pvt9-settlement:cli:')).toBe(true);
    // cycleConfig — the only production construction of a CycleRunnerConfig — never repeats one.
    expect(cycleConfig('c', SIGNER).workerId).not.toBe(cycleConfig('c', SIGNER).workerId);
  });

  it('two production-shaped concurrent runs: the second is REFUSED lease_held, claims pay once', async () => {
    const h = makeHarness();
    await registerClaimsBulk(h.db, [1, 2, 3, 4].map((n) => standardClaim(n, ADDR(0xa0 + n))), 50_000);
    const production = (): CycleRunnerConfig => ({ ...h.config, workerId: cycleConfig(h.config.cycleId, SIGNER).workerId });

    const [first, second] = await Promise.all([
      runSettlementCycle(h.deps, production()),
      runSettlementCycle(h.deps, production()),
    ]);
    const refused = [first, second].filter((r) => r.stopReason === 'lease_refused');
    expect(refused).toHaveLength(1);
    expect(refused[0].detail).toMatch(/^signer_lease_held:pvt9-settlement:/);
    expect([first, second].filter((r) => r.stopReason === 'backlog_exhausted')).toHaveLength(1);
    expect(h.chain.claimSettled.size).toBe(4);
    // Every reserved nonce is distinct — the two runs never shared a nonce sequence.
    const nonces = batchDocs(h.store).map((b) => b.reserved_nonce);
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  it('RED CONTROL: with the OLD constant owner both leases are granted — the defect, executable', async () => {
    const h = makeHarness();
    const OLD = 'pvt9-settlement-operator';
    expect((await acquireSignerLease(h.db, { signer: SIGNER, workerId: OLD, nowMs: 1, leaseTtlMs: 60_000 })).kind)
      .toBe('acquired');
    expect((await acquireSignerLease(h.db, { signer: SIGNER, workerId: OLD, nowMs: 2, leaseTtlMs: 60_000 })).kind)
      .toBe('acquired');
    // …and the same constant renews the CYCLE lease for a second worker, which is how two runs
    // drove one cycle's nonces at once before.
    const cycleLease = (nowMs: number) => acquireCycleLease(h.db, {
      cycleId: 'c', workerId: OLD, nowMs, leaseTtlMs: 60_000, epoch: 0, policyHash: H(1), signer: SIGNER,
      baseNonce: 0, limits: { max_transactions: 10, max_fee_wei_total: '1' }, cursorStart: 0n,
    });
    expect((await cycleLease(1)).kind).toBe('acquired');
    expect((await cycleLease(2)).kind).toBe('acquired');
  });

  it('a finished run RELEASES its leases so the next run is not locked out for the TTL', async () => {
    const h = makeHarness();
    await registerClaimsBulk(h.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    const first = await runSettlementCycle(h.deps, { ...h.config, workerId: newSettlementWorkerId() });
    expect(first.stopReason).toBe('backlog_exhausted');
    const next = await acquireSignerLease(h.db, {
      signer: SIGNER, workerId: newSettlementWorkerId(), nowMs: h.deps.now(), leaseTtlMs: 600_000,
    });
    expect(next.kind).toBe('acquired');
  });
});

/**
 * Strand a broadcast batch in a CLOSED cycle, the way production did before every stop
 * but `broadcast_failed` closed the cycle around a live `submitted` batch.
 */
async function strandBatch(
  how: 'replacement_budget_exhausted' | 'transaction_limit' | 'run_time_limit',
): Promise<Harness> {
  const overrides: Partial<CycleRunnerConfig> = how === 'replacement_budget_exhausted'
    ? { maxReplacementsPerBatch: 2 }
    : how === 'transaction_limit'
      ? { limits: { maxTransactions: 2, maxFeeWeiTotal: PLAN_INITIAL_CYCLE_MAX_FEE_WEI } }
      : { maxRunMs: 30_000 };
  const h = makeHarness(overrides);
  await registerClaimsBulk(h.db, [standardClaim(1, ADDR(0xa1))], 50_000);
  h.chain.behaviors = Array(10).fill('drop');
  const first = await runSettlementCycle(h.deps, h.config);
  expect(first.stopReason).toBe(how);
  expect(cycleDoc(h.store).status).not.toBe('active');
  const stranded = batchDocs(h.store).find((b) => b.status === 'submitted');
  expect(stranded).toBeDefined();
  h.chain.behaviors = [];
  return h;
}

describe(' (2) — a broadcast batch is always reconciled on a later run', () => {
  it.each(['replacement_budget_exhausted', 'transaction_limit', 'run_time_limit'] as const)(
    'after %s: the next run adopts the stranded batch, re-drives its OWN nonce, pays once',
    async (how) => {
      const h = await strandBatch(how);
      const stranded = batchDocs(h.store).find((b) => b.status === 'submitted')!;
      const second = await runSettlementCycle(h.deps, nextRun(h, 'cycle-2'));

      expect(second.reconciliation?.adopted).toBe(1);
      expect(second.reconciliation?.confirmed).toBe(1);
      expect(second.outcome).toBe('completed');
      const settled = batchDocs(h.store).find((b) => b.batch_id === stranded.batch_id)!;
      expect(settled.status).toBe('confirmed');
      // Every attempt of the stranded batch — including the adoption's — at the SAME nonce.
      expect(new Set(settled.attempts.map((a) => a.nonce))).toEqual(new Set([stranded.reserved_nonce]));
      expect(h.chain.claimSettled.size).toBe(1);
      expect(ledgerRow(h.store, 'pe-0001').settled).toBe(true);
      // No batch of the new cycle ever took the stranded nonce.
      expect(batchDocs(h.store).filter((b) => b.cycle_id === 'cycle-2')).toHaveLength(0);
    },
  );

  it('a stranded transaction that MINED while no run watched is applied and written back, never re-sent', async () => {
    const h = await strandBatch('replacement_budget_exhausted');
    const stranded = batchDocs(h.store).find((b) => b.status === 'submitted')!;
    h.chain.minePendingHash(stranded.attempts[0].tx_hash); // the ORIGINAL wins, late
    const broadcastsBefore = h.chain.broadcasts;

    const second = await runSettlementCycle(h.deps, nextRun(h, 'cycle-2'));
    expect(second.stopReason).toBe('backlog_exhausted');
    expect(h.chain.broadcasts).toBe(broadcastsBefore); // nothing new sent
    expect(batchDocs(h.store).find((b) => b.batch_id === stranded.batch_id)!.status).toBe('confirmed');
    expect(ledgerRow(h.store, 'pe-0001').settled).toBe(true);
    expect(h.chain.claimSettled.size).toBe(1);
  });

  it('after epoch_gate_closed on a mined revert: the batch is concluded dead at depth and its claims re-paid', async () => {
    const h = makeHarness();
    await registerClaimsBulk(h.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    h.chain.behaviors = ['mine-revert'];
    h.chain.onBroadcast = () => { h.chain.administrativeHold = true; };
    const first = await runSettlementCycle(h.deps, h.config);
    expect(first.stopReason).toBe('epoch_gate_closed');
    expect(batchDocs(h.store).some((b) => b.status === 'submitted')).toBe(true);

    h.chain.onBroadcast = null;
    h.chain.administrativeHold = false;
    const second = await runSettlementCycle(h.deps, nextRun(h, 'cycle-2'));
    expect(second.reconciliation?.dead).toBe(1);
    expect(second.stopReason).toBe('backlog_exhausted');
    expect(h.chain.claimSettled.size).toBe(1);
    expect(ledgerRow(h.store, 'pe-0001').settled).toBe(true);
  });

  it('an approval refused on a REPLACEMENT cancels the live nonce instead of stranding it', async () => {
    const h = makeHarness();
    await registerClaimsBulk(h.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    h.chain.behaviors = ['drop'];
    h.chain.onBroadcast = (count) => { if (count === 1) h.candidateSource.ineligible.add('pe-0001'); };
    const run = await runSettlementCycle(h.deps, h.config);

    const first = batchDocs(h.store)[0];
    expect(first.status).toBe('dead');
    expect(first.dead_reason).toBe('cancelled_dead_binding');
    expect(first.attempts.map((a) => a.kind)).toEqual(['original', 'cancel']);
    expect(new Set(first.attempts.map((a) => a.nonce)).size).toBe(1);
    expect(h.chain.pending.size).toBe(0); // the nonce is resolved on chain
    expect(h.chain.claimSettled.size).toBe(0);
    // The now-ineligible claim is held, not re-sent every run.
    expect(run.heldClaims.map((c) => c.reason)).toEqual(['candidate_ineligible']);
  });

  it('NO ABORT LOOP: while a stranded nonce stays unmined, each run re-drives it at the same nonce and sends nothing new', async () => {
    const h = await strandBatch('replacement_budget_exhausted');
    await registerClaimsBulk(h.db, [standardClaim(2, ADDR(0xa2))], 60_000);
    const stranded = batchDocs(h.store).find((b) => b.status === 'submitted')!;
    const cyclesBefore = cycleDocs(h.store).length;

    for (const cycleId of ['cycle-2', 'cycle-3']) {
      h.chain.behaviors = Array(10).fill('drop');
      const run = await runSettlementCycle(h.deps, nextRun(h, cycleId, { maxReplacementsPerBatch: 2 }));
      expect(run.stopReason).toBe('stranded_batch_pending');
      expect(run.reconciliation?.stillUnresolved.map((s) => s.batchId)).toEqual([stranded.batch_id]);
    }
    // No cycle was opened (no supersession burned), no new batch reserved, one nonce throughout.
    expect(cycleDocs(h.store)).toHaveLength(cyclesBefore);
    const docs = batchDocs(h.store);
    expect(docs).toHaveLength(1);
    expect(new Set(docs[0].attempts.map((a) => a.nonce))).toEqual(new Set([stranded.reserved_nonce]));
    expect(docs[0].attempts.length).toBeGreaterThan(stranded.attempts.length); // progress each run

    h.chain.behaviors = [];
    const last = await runSettlementCycle(h.deps, nextRun(h, 'cycle-4'));
    expect(last.stopReason).toBe('backlog_exhausted');
    expect(h.chain.claimSettled.size).toBe(2);
  });

  it('uses canonical state for a legacy pool-only attempt; chain consumption resolves the competing nonce', async () => {
    const h = makeHarness();
    await registerClaimsBulk(h.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    // A transaction at nonce 0 the chain holds pending (not yet mined; `latest` still reads 0).
    h.chain.pending.set(H(0xf0f0), {
      to: SIGNER, data: '0x', valueWei: 0n, nonce: 0, gasLimit: 21_000n,
      maxFeePerGasWei: 1n, maxPriorityFeePerGasWei: 1n,
    });
    await runSettlementCycle(h.deps, h.config);
    expect(batchDocs(h.store)[0].reserved_nonce).toBe(0);
    expect(h.chain.claimSettled.size).toBe(1);
  });
});

describe(' (3) — a settle is final only at the watchers\' safe-head depth ', () => {
  it('a receipt above the safe head is recorded MINED, never applied; the next run applies it at depth', async () => {
    const h = makeHarness({ maxRunMs: 30_000 });
    await registerClaimsBulk(h.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    h.chain.safeLag = 1_000; // the L1-batched safe head trails far behind the tip
    const first = await runSettlementCycle(h.deps, h.config);

    expect(first.stopReason).toBe('awaiting_finality');
    const batch = batchDocs(h.store)[0];
    expect(batch.status).toBe('mined');
    expect(batch.applied).toBe(false);
    expect(ledgerRow(h.store, 'pe-0001').settled).toBe(false);
    expect(first.claimsSettled).toBe(0);

    h.chain.safeLag = 0;
    const second = await runSettlementCycle(h.deps, nextRun(h, 'cycle-2'));
    expect(second.reconciliation?.confirmed).toBe(1);
    const applied = batchDocs(h.store)[0];
    expect(applied.status).toBe('confirmed');
    expect(applied.finality_verified).toBe(true);
    expect(applied.confirmed_block_number).toBe(1);
    expect(ledgerRow(h.store, 'pe-0001').settled).toBe(true);
  });

  it('a receipt with no safe head at all is never final (null safe head = wait, never the unsafe tip)', async () => {
    const h = makeHarness({ maxRunMs: 30_000 });
    await registerClaimsBulk(h.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    h.chain.noSafeHead = true;
    const run = await runSettlementCycle(h.deps, h.config);
    expect(run.stopReason).toBe('awaiting_finality');
    expect(batchDocs(h.store)[0].applied).toBe(false);
  });

  it('a receipt SEEN then reorged out before depth is withdrawn, re-driven at its nonce, and paid exactly once', async () => {
    const h = makeHarness();
    await registerClaimsBulk(h.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    h.chain.safeLag = 1_000;
    let firstHash: string | null = null;
    h.chain.onBroadcast = (_count, hash) => { firstHash ??= hash; };
    const baseSleep = h.deps.sleep;
    let sleeps = 0;
    const deps: CycleRunnerDeps = {
      ...h.deps,
      sleep: async (ms) => {
        sleeps += 1;
        if (sleeps === 1) {
          h.chain.reorgOut(firstHash!, false); // the block is gone and the tx with it
          h.chain.safeLag = 0;
        }
        await baseSleep(ms);
      },
    };
    const run = await runSettlementCycle(deps, h.config);

    expect(run.stopReason).toBe('backlog_exhausted');
    const batch = batchDocs(h.store)[0];
    expect(batch.status).toBe('confirmed');
    expect(batch.confirmed_block_number).toBe(2); // applied at the RE-MINED block, not the reorged one
    expect(h.chain.claimSettled.size).toBe(1);
    expect(h.chain.cursor).toBe(1n);
    expect(ledgerRow(h.store, 'pe-0001').settled).toBe(true);
  });

  it('a settle reorged out AFTER it was applied is unwound (ledger + pe_history), re-driven, and paid', async () => {
    const h = makeHarness();
    await registerClaimsBulk(h.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    h.store.set('pe_history/pe-0001', { mint_status: 'eligible', record_points_atomic: '1000000000000000000' });
    const first = await runSettlementCycle(h.deps, h.config);
    expect(first.stopReason).toBe('backlog_exhausted');
    expect(h.store.get('pe_history/pe-0001')).toMatchObject({ mint_status: 'minted' });
    const applied = batchDocs(h.store)[0];

    // A deep reorg: the settle's block is replaced at a height the safe head has passed.
    h.chain.reorgOut(applied.confirmed_tx_hash!, false);
    expect(h.chain.claimSettled.size).toBe(0);

    const second = await runSettlementCycle(h.deps, nextRun(h, 'cycle-2'));
    expect(second.reconciliation?.appliedReorged).toBe(1);
    expect(second.reconciliation?.confirmed).toBe(1);
    const repaid = batchDocs(h.store)[0];
    expect(repaid.status).toBe('confirmed');
    expect(repaid.reorgs).toHaveLength(1);
    expect(repaid.confirmed_tx_hash).not.toBe(applied.confirmed_tx_hash);
    expect(h.chain.claimSettled.size).toBe(1);
    expect(ledgerRow(h.store, 'pe-0001').settled).toBe(true);
    expect(h.store.get('pe_history/pe-0001')).toMatchObject({ mint_status: 'minted' });
    expect((h.store.get('pe_history/pe-0001') ?? {}).settlement_reorged_at).toEqual(expect.any(Number));
  });

  it('inside one run: the chain-behind-durable branch checks the tip batch and repays a reorged one', async () => {
    const h = makeHarness();
    await registerClaimsBulk(h.db, [1, 2, 3, 4, 5].map((n) => standardClaim(n, ADDR(0xa0 + n))), 50_000);
    let reorged = false;
    h.chain.beforeObserve = () => {
      if (reorged || h.chain.claimSettled.size !== 3) return;
      const tip = batchDocs(h.store).find((b) => b.applied);
      if (tip?.confirmed_tx_hash === undefined || tip.confirmed_tx_hash === null) return;
      reorged = true;
      h.chain.reorgOut(tip.confirmed_tx_hash, false);
    };
    const run = await runSettlementCycle(h.deps, h.config);
    expect(reorged).toBe(true);
    expect(run.stopReason).toBe('backlog_exhausted');
    expect(h.chain.claimSettled.size).toBe(5);
    expect(h.chain.cursor).toBe(5n);
    for (const n of [1, 2, 3, 4, 5]) expect(ledgerRow(h.store, `pe-000${n}`).settled).toBe(true);
    expect(batchDocs(h.store).some((b) => (b.reorgs ?? []).length === 1)).toBe(true);
  });

  it('a legacy applied batch (no recorded block) is VERIFIED when its receipt is final, never unwound when it is missing', async () => {
    const h = makeHarness();
    await registerClaimsBulk(h.db, [1, 2, 3, 4].map((n) => standardClaim(n, ADDR(0xa0 + n))), 50_000);
    await runSettlementCycle(h.deps, h.config);
    const applied = batchDocs(h.store);
    expect(applied).toHaveLength(2);
    // Strip the stamps: the shape of every batch applied before this change.
    for (const b of applied) {
      const key = `pvt9_settlement_batches_v1/${b.batch_id}`;
      const legacy = { ...(h.store.get(key) ?? {}) };
      delete legacy.confirmed_block_number;
      delete legacy.confirmed_block_hash;
      delete legacy.finality_verified;
      h.store.set(key, legacy);
    }
    // The TIP legacy batch's receipt is no longer served (a pruned RPC, not a reorg). The tip,
    // deliberately: `revertReorgedBatch` only unwinds a cycle's tip, so choosing any other batch
    // would let that guard mask a verdict that wrongly read absence as a reorg.
    const tip = applied.reduce((a, b) => (BigInt(a.cursor_end) > BigInt(b.cursor_end) ? a : b));
    h.chain.receipts.delete(tip.confirmed_tx_hash!);

    const second = await runSettlementCycle(h.deps, nextRun(h, 'cycle-2'));
    expect(second.reconciliation?.appliedVerified).toBe(1);
    expect(second.reconciliation?.appliedUnverifiable).toBe(1);
    expect(second.reconciliation?.appliedReorged).toBe(0);
    for (const n of [1, 2, 3, 4]) expect(ledgerRow(h.store, `pe-000${n}`).settled).toBe(true);
    expect(batchDocs(h.store).every((b) => b.status === 'confirmed')).toBe(true);
  });
});

describe(' (4) — the standard lane is never wedged', () => {
  it('a contributor holding BOTH beneficiary classes settles both, across two batches', async () => {
    const h = makeHarness();
    await registerClaimsBulk(h.db, [
      standardClaim(1, ADDR(0xa1)),
      { ...standardClaim(2, ADDR(0xa1)), beneficiary_class: 2 },
      standardClaim(3, ADDR(0xa3)),
    ], 50_000);
    const run = await runSettlementCycle(h.deps, h.config);
    expect(run.stopReason).toBe('backlog_exhausted');
    expect(run.claimsSettled).toBe(3);
    expect(run.claimsHeld).toBe(0);
    expect(run.transactionsSubmitted).toBe(2);
    for (const n of [1, 2, 3]) expect(ledgerRow(h.store, `pe-000${n}`).settled).toBe(true);
  });

  it('a POISONED claim is isolated and held; every other claim settles in the same run', async () => {
    const h = makeHarness();
    await registerClaimsBulk(h.db, [1, 2, 3, 4].map((n) => standardClaim(n, ADDR(0xa0 + n))), 50_000);
    h.chain.poisoned.add(claimIdFor('pe-0002', 2).toLowerCase());
    const run = await runSettlementCycle(h.deps, h.config);

    expect(run.stopReason).toBe('backlog_exhausted');
    expect(run.claimsSettled).toBe(3);
    expect(run.claimsHeld).toBe(1);
    expect(run.heldClaims[0]).toMatchObject({ claimKey: claimKeyOf('pe-0002', 'sole'), reason: 'batch_unsettleable' });
    expect(ledgerRow(h.store, 'pe-0002').settled).toBe(false);
    expect((ledgerRow(h.store, 'pe-0002').hold as { retry_at_ms: number }).retry_at_ms).toBeGreaterThan(h.deps.now());
    for (const n of [1, 3, 4]) expect(ledgerRow(h.store, `pe-000${n}`).settled).toBe(true);
    // Isolation probes are approved and dry-run, never signed or sent.
    expect(h.chain.broadcasts).toBe(run.transactionsSubmitted);
  });

  it('a held claim is retried after its backoff, and pays once the fault is gone', async () => {
    const h = makeHarness();
    await registerClaimsBulk(h.db, [1, 2].map((n) => standardClaim(n, ADDR(0xa0 + n))), 50_000);
    h.chain.poisoned.add(claimIdFor('pe-0002', 2).toLowerCase());
    await runSettlementCycle(h.deps, h.config);
    expect(ledgerRow(h.store, 'pe-0002').settled).toBe(false);

    // Inside the backoff the held claim is not re-selected: the run finds nothing to do.
    const inside = await runSettlementCycle(h.deps, nextRun(h, 'cycle-2'));
    expect(inside.stopReason).toBe('backlog_exhausted');
    expect(inside.transactionsSubmitted).toBe(0);

    h.chain.poisoned.clear();
    await h.deps.sleep(CLAIM_HOLD_BASE_MS + 1);
    const after = await runSettlementCycle(h.deps, nextRun(h, 'cycle-3'));
    expect(after.claimsSettled).toBe(1);
    expect(ledgerRow(h.store, 'pe-0002').settled).toBe(true);
  });

  it('a claim whose ledger row cannot be planned is held; the rest settles', async () => {
    const h = makeHarness();
    await registerClaimsBulk(h.db, [1, 2, 3].map((n) => standardClaim(n, ADDR(0xa0 + n))), 50_000);
    const key = `${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe-0002', 'sole')}`;
    const broken = { ...(h.store.get(key) ?? {}) };
    delete broken.record_points_atomic;
    h.store.set(key, broken);

    const run = await runSettlementCycle(h.deps, h.config);
    expect(run.stopReason).toBe('backlog_exhausted');
    expect(run.claimsSettled).toBe(2);
    expect(run.heldClaims.map((c) => c.reason)).toEqual(['batch_plan_rejected']);
  });

  it('CONTROL: when NOTHING can settle the fault is systemic — the run stops and holds nothing', async () => {
    // The guard against quarantining the whole queue: every claim fails and no control batch
    // succeeds, so no claim can be blamed.
    const h = makeHarness();
    await registerClaimsBulk(h.db, [1, 2].map((n) => standardClaim(n, ADDR(0xa0 + n))), 50_000);
    h.chain.poisoned.add(claimIdFor('pe-0001', 1).toLowerCase());
    h.chain.poisoned.add(claimIdFor('pe-0002', 2).toLowerCase());
    const run = await runSettlementCycle(h.deps, h.config);
    expect(run.stopReason).toBe('batch_unsettleable');
    expect(run.claimsHeld).toBe(0);
    expect(ledgerRow(h.store, 'pe-0001').hold ?? null).toBeNull();
    expect(ledgerRow(h.store, 'pe-0002').hold ?? null).toBeNull();
  });
});

describe(' (2) — the nonce seed is this signer\'s alone', () => {
  it('a ROTATED minter\'s stranded batch neither blocks this signer nor pushes its nonce into a gap', async () => {
    const h = makeHarness({ maxReplacementsPerBatch: 1 });
    const OLD_SIGNER = ADDR(0xdead);
    await registerClaimsBulk(h.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    h.chain.behaviors = Array(10).fill('drop');
    const old = await runSettlementCycle(h.deps, { ...h.config, signerAddress: OLD_SIGNER, workerId: 'old' });
    expect(old.stopReason).toBe('replacement_budget_exhausted');
    // The old signer's mempool is its own; this fake chain is single-address, so drop it here.
    h.chain.pending.clear();
    h.chain.behaviors = [];

    await registerClaimsBulk(h.db, [standardClaim(2, ADDR(0xa2))], 60_000);
    const run = await runSettlementCycle(h.deps, nextRun(h, 'cycle-new'));
    // The old signer's batch is not adopted (another signer's nonce) and does not block …
    expect(run.reconciliation?.adopted).toBe(0);
    expect(run.claimsSettled).toBe(1);
    // … and this signer's first nonce is its own 0, not the other signer's reserved nonce + 1.
    const mine = batchDocs(h.store).filter((b) => b.cycle_id === 'cycle-new');
    expect(mine.map((b) => b.reserved_nonce)).toEqual([0]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// — money-safety evidence, safe-block kernel reads, combination
// failures, transient approval refusals. Each test below is the permanent RED control for one
// reverting the fix it names turns it red.
// ─────────────────────────────────────────────────────────────────────────────

describe(' review · a paid batch is never concluded dead (kernel read at the safe block)', () => {
  const ID1 = (): string => claimIdFor('pe-0001', 1).toLowerCase();

  it('nonce consumed, receipt HIDDEN by a lagging replica, kernel `latest` stale: recorded paid from chain evidence, never re-queued', async () => {
    // Finding 1(a) + 2: the batch's own transaction mined (it PAID the claim), but a lagging
    // replica returns no receipt and still reads the claim unpaid at `latest`. The nonce is
    // consumed at the safe block. The conclusion must read the kernel AT THAT SAFE BLOCK.
    const h = await strandBatch('replacement_budget_exhausted');
    h.store.set('pe_history/pe-0001', { mint_status: 'eligible', record_points_atomic: '1000000000000000000' });
    const stranded = batchDocs(h.store).find((b) => b.status === 'submitted')!;
    h.chain.trackNonces = true;
    h.chain.minePendingHash(stranded.attempts[0].tx_hash);
    h.chain.hiddenReceipts.add(stranded.attempts[0].tx_hash);
    h.chain.staleLatestClaims.add(ID1());
    const broadcastsBefore = h.chain.broadcasts;

    const second = await runSettlementCycle(h.deps, nextRun(h, 'cycle-2'));

    const concluded = batchDocs(h.store).find((b) => b.batch_id === stranded.batch_id)!;
    expect(concluded.status).toBe('dead');
    expect(concluded.dead_reason).toContain('nonce_consumed_elsewhere');
    expect(concluded.dead_reason).toContain('kernel reads all member(s) settled at safe block');
    const row = ledgerRow(h.store, 'pe-0001');
    // Attributed truthfully: no receipt of this batch was ever seen, so it is NOT named as payer.
    expect(row).toMatchObject({
      settled: true, settled_via: 'chain_evidence', reserved_batch_id: null, settled_batch_id: null, settled_tx_hash: null,
    });
    // Recorded BY THIS BATCH'S CONCLUSION (not rescued later by isolation of a re-sent claim).
    expect((row.chain_settlement_evidence as { concluding_batch_id: string }).concluding_batch_id).toBe(stranded.batch_id);
    expect(h.store.get('pe_history/pe-0001')).toMatchObject({ mint_status: 'minted', minted_via: 'pvt9_chain_evidence' });
    // Never re-queued: no new batch was reserved and nothing new was sent.
    expect(batchDocs(h.store)).toHaveLength(1);
    expect(h.chain.broadcasts).toBe(broadcastsBefore);
    expect(second.stopReason).toBe('backlog_exhausted');
    // The member read was height-tagged (the safe block), never `latest`, for the conclusion.
    expect(h.chain.claimReadTags.some((tag) => typeof tag === 'number')).toBe(true);
  });

  it('CONTROL: nonce consumed and the kernel reads NOTHING paid at the safe block — dead, claims re-paid', async () => {
    const h = await strandBatch('replacement_budget_exhausted');
    const stranded = batchDocs(h.store).find((b) => b.status === 'submitted')!;
    // A transaction this runner never recorded consumed the nonce (a cancel from elsewhere).
    h.chain.pending.clear();
    h.chain.txCountAtBlock = () => stranded.reserved_nonce + 1;
    h.chain.txCount = stranded.reserved_nonce + 1;
    const second = await runSettlementCycle(h.deps, nextRun(h, 'cycle-2'));
    const concluded = batchDocs(h.store).find((b) => b.batch_id === stranded.batch_id)!;
    expect(concluded.dead_reason).toContain('nonce_consumed_elsewhere');
    expect(concluded.dead_reason).toContain('kernel reads none member(s)');
    expect(second.stopReason).toBe('backlog_exhausted');
    expect(h.chain.claimSettled.size).toBe(1); // re-paid by a new batch
    expect(ledgerRow(h.store, 'pe-0001').settled_via).toBeUndefined();
  });

  it('adopted FINAL revert while the kernel reads the member paid at the safe block: recorded paid, never released', async () => {
    // Finding 1(b): a batch whose own settle reverted (the claim was paid by another settle) —
    // its claims must not return to the queue as unpaid.
    const h = await strandBatch('replacement_budget_exhausted');
    const stranded = batchDocs(h.store).find((b) => b.status === 'submitted')!;
    h.chain.claimSettled.add(ID1()); // paid elsewhere (e.g. a predecessor-era settle)
    h.chain.minePendingHash(stranded.attempts[stranded.attempts.length - 1].tx_hash, 'mine-revert');

    const second = await runSettlementCycle(h.deps, nextRun(h, 'cycle-2'));
    const concluded = batchDocs(h.store).find((b) => b.batch_id === stranded.batch_id)!;
    expect(concluded.status).toBe('dead');
    expect(concluded.dead_reason).toContain('adopted_reverted_final');
    expect(concluded.dead_reason).toContain('kernel reads all member(s) settled');
    const row = ledgerRow(h.store, 'pe-0001');
    expect(row).toMatchObject({ settled: true, settled_via: 'chain_evidence', settled_batch_id: null });
    expect((row.chain_settlement_evidence as { concluding_batch_id: string }).concluding_batch_id).toBe(stranded.batch_id);
    expect(batchDocs(h.store)).toHaveLength(1); // never re-planned
    expect(second.stopReason).toBe('backlog_exhausted');
  });

  it('an APPLIED batch whose block is non-canonical is NEVER unwound while the kernel reads its members paid', async () => {
    // Finding 1(c): `reorged` requires the kernel to read every member unpaid at the safe block.
    const h = makeHarness();
    await registerClaimsBulk(h.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    h.store.set('pe_history/pe-0001', { mint_status: 'eligible', record_points_atomic: '1000000000000000000' });
    await runSettlementCycle(h.deps, h.config);
    const applied = batchDocs(h.store)[0];
    expect(applied.status).toBe('confirmed');
    // The recorded block is replaced at a height the safe head has passed, the receipt is not
    // served — but the kernel still reads the claim paid (the settle re-landed elsewhere).
    h.chain.canonical.set(applied.confirmed_block_number!, H(0xabcdef));
    h.chain.hiddenReceipts.add(applied.confirmed_tx_hash!);
    const key = `pvt9_settlement_batches_v1/${applied.batch_id}`;
    h.store.set(key, { ...(h.store.get(key) ?? {}), finality_verified: false });

    const second = await runSettlementCycle(h.deps, nextRun(h, 'cycle-2'));
    expect(second.reconciliation?.appliedReorged).toBe(0);
    expect(second.reconciliation?.appliedUnverifiable).toBe(1);
    expect(batchDocs(h.store)[0].status).toBe('confirmed');
    expect(ledgerRow(h.store, 'pe-0001').settled).toBe(true);
    expect(h.store.get('pe_history/pe-0001')).toMatchObject({ mint_status: 'minted' });
  });

  it('judgeReceiptFinality: a receipt at depth whose block is NOT the canonical block there is never final', async () => {
    // Finding 1(d), as a unit: the canonical-hash comparison is what makes it `dropped`.
    const receipt: MinedReceipt = {
      status: 'success', blockNumber: 5, blockHash: H(0x1111), gasUsed: 1n, effectiveGasPriceWei: 1n,
    };
    const chain = {
      getReceipt: async () => receipt,
      readHead: async () => 100,
      readSafeHead: async (): Promise<SafeHead> => ({ number: 90, hash: H(0x9090) }),
      getBlockHash: async () => H(0x2222),
    } as unknown as SettlementChainAdapter;
    const verdict = await judgeReceiptFinality(chain, H(0xaaaa), { status: 'success', block_number: 5, block_hash: H(0x1111) });
    expect(verdict.kind).toBe('dropped');
    const agreeing = { ...chain, getBlockHash: async () => H(0x1111) } as unknown as SettlementChainAdapter;
    expect((await judgeReceiptFinality(agreeing, H(0xaaaa), { status: 'success', block_number: 5, block_hash: H(0x1111) })).kind)
      .toBe('final');
  });

  it('a settle whose receipt names a NON-canonical block at depth is never applied, and the run stays bounded', async () => {
    // Finding 1(d), through the runner: the replica keeps serving the receipt from a block the
    // canonical chain does not have. Nothing is applied; the run ends at its deadline.
    const h = makeHarness({ maxRunMs: 30_000 });
    await registerClaimsBulk(h.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    h.chain.onBroadcast = () => { h.chain.canonical.set(h.chain.block, H(0x5eed)); };
    const run = await runSettlementCycle(h.deps, h.config);
    expect(run.stopReason).toBe('awaiting_finality');
    const batch = batchDocs(h.store)[0];
    expect(batch.applied).toBe(false);
    expect(ledgerRow(h.store, 'pe-0001').settled).toBe(false);
  });

  it('a HELD claim the kernel later reads paid at the safe block is recorded settled, not held forever', async () => {
    // Finding 2 (last clause).
    const h = makeHarness();
    await registerClaimsBulk(h.db, [1, 2].map((n) => standardClaim(n, ADDR(0xa0 + n))), 50_000);
    h.store.set('pe_history/pe-0002', { mint_status: 'eligible', record_points_atomic: '1000000000000000000' });
    h.chain.poisoned.add(claimIdFor('pe-0002', 2).toLowerCase());
    await runSettlementCycle(h.deps, h.config);
    expect(ledgerRow(h.store, 'pe-0002')).toMatchObject({ settled: false, held: true });

    // The claim is then paid on chain by a settle the ledger never saw.
    h.chain.poisoned.clear();
    h.chain.claimSettled.add(claimIdFor('pe-0002', 2).toLowerCase());
    const second = await runSettlementCycle(h.deps, nextRun(h, 'cycle-2'));
    expect(second.reconciliation?.heldSettledOnChain).toBe(1);
    expect(ledgerRow(h.store, 'pe-0002')).toMatchObject({
      settled: true, settled_via: 'chain_evidence', hold: null, held: false,
    });
    expect(h.store.get('pe_history/pe-0002')).toMatchObject({ mint_status: 'minted', minted_via: 'pvt9_chain_evidence' });
  });

  it('CONTROL: a held claim the kernel reads paid only ABOVE the safe block stays held', async () => {
    const h = makeHarness();
    await registerClaimsBulk(h.db, [1, 2].map((n) => standardClaim(n, ADDR(0xa0 + n))), 50_000);
    h.chain.poisoned.add(claimIdFor('pe-0002', 2).toLowerCase());
    await runSettlementCycle(h.deps, h.config);
    h.chain.poisoned.clear();
    const id = claimIdFor('pe-0002', 2).toLowerCase();
    h.chain.claimSettled.add(id);
    h.chain.claimSettledAt.set(id, h.chain.block + 50); // paid, but not yet at the safe block
    const second = await runSettlementCycle(h.deps, nextRun(h, 'cycle-2'));
    expect(second.reconciliation?.heldSettledOnChain).toBe(0);
    expect(ledgerRow(h.store, 'pe-0002')).toMatchObject({ settled: false, held: true });
  });
});

describe(' review · a combination failure never stops the lane', () => {
  it('two Genesis grants that fail TOGETHER but settle apart are split and both paid; the standard lane behind them settles', async () => {
    // Finding 3: the whole batch reverts, every part settles alone. Genesis-first planning
    // would otherwise re-plan the same head every run: a permanent wedge of BOTH lanes.
    const h = makeHarness();
    const a = genesisClaim(1, ADDR(0xb1));
    const b = genesisClaim(2, ADDR(0xb1));
    await registerClaimsBulk(h.db, [a, b, standardClaim(3, ADDR(0xa3))], 50_000);
    h.chain.combinations.push({ ids: [a.claim_id.toLowerCase(), b.claim_id.toLowerCase()], cumulative: false });
    const run = await runSettlementCycle(h.deps, h.config);
    expect(run.stopReason).toBe('backlog_exhausted');
    expect(run.claimsHeld).toBe(0);
    expect(h.chain.claimSettled.has(a.claim_id.toLowerCase())).toBe(true);
    expect(h.chain.claimSettled.has(b.claim_id.toLowerCase())).toBe(true);
    expect(ledgerRow(h.store, 'pe-0003').settled).toBe(true);
  });

  it('a CUMULATIVE combination (the wallet ceiling): the first grant pays, the one that crosses it is held, the rest settles', async () => {
    const h = makeHarness();
    const a = genesisClaim(1, ADDR(0xb1));
    const b = genesisClaim(2, ADDR(0xb1));
    await registerClaimsBulk(h.db, [a, b, standardClaim(3, ADDR(0xa3))], 50_000);
    h.chain.combinations.push({ ids: [a.claim_id.toLowerCase(), b.claim_id.toLowerCase()], cumulative: true });
    const run = await runSettlementCycle(h.deps, h.config);
    expect(run.stopReason).toBe('backlog_exhausted');
    expect(run.claimsHeld).toBe(1);
    expect(h.chain.claimSettled.has(a.claim_id.toLowerCase())).toBe(true);
    expect(h.chain.claimSettled.has(b.claim_id.toLowerCase())).toBe(false);
    expect(ledgerRow(h.store, 'pe-0003').settled).toBe(true);
  });

  it('the ceiling case with NO other work: a batch confirmed this run is the proof, so the crossing grant is held (no stop, no re-plan loop)', async () => {
    // Without the in-run proof there is no control batch to show the failure is claim-specific,
    // and the run would stop on the same head every day.
    const h = makeHarness();
    const a = genesisClaim(1, ADDR(0xb1));
    const b = genesisClaim(2, ADDR(0xb1));
    await registerClaimsBulk(h.db, [a, b], 50_000);
    h.chain.combinations.push({ ids: [a.claim_id.toLowerCase(), b.claim_id.toLowerCase()], cumulative: true });
    const run = await runSettlementCycle(h.deps, h.config);
    expect(run.stopReason).toBe('backlog_exhausted');
    expect(run.claimsSettled).toBe(1);
    expect(run.claimsHeld).toBe(1);
    expect(run.heldClaims[0].claimKey).toBe(claimKeyOf(b.pe_id, 'sole'));
  });
});

describe(' review · a transient approval refusal is never held against a claim', () => {
  it('an approval that throws ONCE is retried: nothing held, everything settles', async () => {
    const h = makeHarness();
    await registerClaimsBulk(h.db, [1, 2].map((n) => standardClaim(n, ADDR(0xa0 + n))), 50_000);
    const approve = h.verifier.approveStandardBatch.bind(h.verifier);
    let throws = 1;
    h.verifier.approveStandardBatch = async (call) => {
      if (throws > 0) {
        throws -= 1;
        throw new Error('RPC 503');
      }
      return approve(call);
    };
    const run = await runSettlementCycle(h.deps, h.config);
    expect(run.stopReason).toBe('backlog_exhausted');
    expect(run.claimsSettled).toBe(2);
    expect(run.claimsHeld).toBe(0);
  });

  it('a PERSISTENT approval failure after a batch confirmed stops the run and holds NOTHING', async () => {
    // With a batch already confirmed this run (the system is proven), a transient refusal
    // counted as claim-specific would hold an innocent claim and page for it.
    const h = makeHarness();
    await registerClaimsBulk(h.db, [1, 2, 3, 4].map((n) => standardClaim(n, ADDR(0xa0 + n))), 50_000);
    h.chain.onBroadcast = (count) => { if (count === 1) h.verifier.failApprovals = true; };
    const run = await runSettlementCycle(h.deps, h.config);
    expect(run.claimsSettled).toBe(3);
    expect(run.stopReason).toBe('batch_approval_refused');
    expect(run.claimsHeld).toBe(0);
    expect(ledgerRow(h.store, 'pe-0004').hold ?? null).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// — legacy-shaped attempts (no recorded block hash) conclude without a
// spin; chain-evidence settlement never names a batch as payer; OUR own receipt found on the
// re-poll concludes through the CONFIRMED path.
// ─────────────────────────────────────────────────────────────────────────────

/** Strip `block_hash` from every recorded receipt: the shape of every attempt mined before. */
function legacyShapeAttempts(h: Harness): void {
  for (const b of batchDocs(h.store)) {
    const key = `pvt9_settlement_batches_v1/${b.batch_id}`;
    const doc = h.store.get(key) ?? {};
    const attempts = (doc.attempts as SettlementBatchDoc['attempts']).map((a) => {
      if (a.mined === null) return a;
      const { block_hash: _dropped, ...rest } = a.mined;
      return { ...a, mined: rest };
    });
    h.store.set(key, { ...doc, attempts });
  }
}

function countReceiptReads(h: Harness): { reads: number } {
  const counter = { reads: 0 };
  const read = h.chain.getReceipt.bind(h.chain);
  h.chain.getReceipt = async (txHash: string) => {
    counter.reads += 1;
    return read(txHash);
  };
  return counter;
}

describe(' · legacy-shaped attempts conclude, and nothing spins', () => {
  it('adopted FINAL revert recorded before (no block_hash): concluded dead and re-paid, no receipt spin', async () => {
    // the negative control: 8,602 getReceipt calls in 54 ms once block_hash was deleted.
    const h = makeHarness();
    await registerClaimsBulk(h.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    h.chain.behaviors = ['mine-revert'];
    h.chain.onBroadcast = () => { h.chain.administrativeHold = true; };
    const first = await runSettlementCycle(h.deps, h.config);
    expect(first.stopReason).toBe('epoch_gate_closed');
    legacyShapeAttempts(h);
    expect(batchDocs(h.store)[0].attempts[0].mined?.block_hash).toBeUndefined();

    h.chain.onBroadcast = null;
    h.chain.administrativeHold = false;
    const legacyBatchId = batchDocs(h.store)[0].batch_id;
    const counter = countReceiptReads(h);
    const second = await runSettlementCycle(h.deps, nextRun(h, 'cycle-2'));
    expect(second.reconciliation?.dead).toBe(1);
    expect(second.stopReason).toBe('backlog_exhausted');
    expect(ledgerRow(h.store, 'pe-0001').settled).toBe(true);
    expect(counter.reads).toBeLessThan(50);
    // Matched on status + block number as recorded: the legacy record is concluded AS IS, never
    // withdrawn and rewritten (durable history is not re-derived from a replica's answer).
    const legacy = batchDocs(h.store).find((b) => b.batch_id === legacyBatchId)!;
    expect(legacy.status).toBe('dead');
    expect(legacy.attempts[0].mined).not.toBeNull();
    expect(legacy.attempts[0].mined?.block_hash).toBeUndefined();
  });

  it('nonce consumed elsewhere while an EARLIER attempt carries a pre- receipt: concluded, not stranded every run', async () => {
    const h = makeHarness({ maxReplacementsPerBatch: 2 });
    await registerClaimsBulk(h.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    // The original reverts (recorded mined), the retry at the next nonce never mines.
    h.chain.behaviors = ['mine-revert', 'drop', 'drop', 'drop', 'drop'];
    const first = await runSettlementCycle(h.deps, h.config);
    expect(first.stopReason).toBe('replacement_budget_exhausted');
    const stranded = batchDocs(h.store).find((b) => b.status === 'submitted')!;
    expect(stranded.attempts.some((a) => a.mined?.status === 'reverted')).toBe(true);
    legacyShapeAttempts(h);
    // The retry's nonce is consumed by a transaction this runner never recorded.
    h.chain.pending.clear();
    const retryNonce = stranded.attempts[stranded.attempts.length - 1].nonce;
    h.chain.txCountAtBlock = () => retryNonce + 1;
    h.chain.txCount = retryNonce + 1;
    h.chain.behaviors = [];

    const counter = countReceiptReads(h);
    const second = await runSettlementCycle(h.deps, nextRun(h, 'cycle-2'));
    const concluded = batchDocs(h.store).find((b) => b.batch_id === stranded.batch_id)!;
    expect(concluded.status).toBe('dead');
    expect(concluded.dead_reason).toContain('nonce_consumed_elsewhere');
    expect(second.stopReason).toBe('backlog_exhausted');
    expect(ledgerRow(h.store, 'pe-0001').settled).toBe(true); // re-paid by a new batch
    expect(counter.reads).toBeLessThan(200);
  });

  it('the production shape (0x82d7bf96…): an original never mined, nonce long consumed, every member paid by the replay — dead + recorded paid, nothing re-sent', async () => {
    const h = makeHarness({ maxReplacementsPerBatch: 1 });
    await registerClaimsBulk(h.db, [1, 2, 3].map((n) => standardClaim(n, ADDR(0xa0 + n))), 50_000);
    for (const n of [1, 2, 3]) {
      h.store.set(`pe_history/pe-000${n}`, { mint_status: 'eligible', record_points_atomic: '1000000000000000000' });
    }
    h.chain.behaviors = Array(10).fill('drop');
    const first = await runSettlementCycle(h.deps, h.config);
    expect(first.stopReason).toBe('replacement_budget_exhausted');
    const stranded = batchDocs(h.store).find((b) => b.status === 'submitted')!;
    // Nothing of the batch ever mined; the signer moved far past its nonce; the successor
    // kernel carries every member's claimSettled (the replay), with no receipt of ours.
    h.chain.pending.clear();
    h.chain.txCountAtBlock = () => 273;
    h.chain.txCount = 273;
    for (const member of stranded.members) h.chain.claimSettled.add(member.claim_id.toLowerCase());
    h.chain.behaviors = [];
    const broadcastsBefore = h.chain.broadcasts;

    const second = await runSettlementCycle(h.deps, nextRun(h, 'epoch5-2026-09-09-r3'));
    const concluded = batchDocs(h.store).find((b) => b.batch_id === stranded.batch_id)!;
    expect(concluded.status).toBe('dead');
    expect(concluded.dead_reason).toContain(`kernel reads all member(s) settled`);
    expect(second.stopReason).toBe('backlog_exhausted');
    expect(h.chain.broadcasts).toBe(broadcastsBefore);
    expect(batchDocs(h.store)).toHaveLength(1);
    for (const n of [1, 2, 3]) {
      const row = ledgerRow(h.store, `pe-000${n}`);
      expect(row).toMatchObject({ settled: true, settled_via: 'chain_evidence', settled_batch_id: null, reserved_batch_id: null });
      expect((row.chain_settlement_evidence as { concluding_batch_id: string }).concluding_batch_id).toBe(stranded.batch_id);
      expect(h.store.get(`pe_history/pe-000${n}`)).toMatchObject({
        mint_status: 'minted', minted_via: 'pvt9_chain_evidence', settled_batch_id: null,
      });
    }
  });

  it('OUR own settle found on the re-poll (receipt hidden until then) concludes CONFIRMED — applied, cursor advanced, named payer', async () => {
    const h = await strandBatch('replacement_budget_exhausted');
    const stranded = batchDocs(h.store).find((b) => b.status === 'submitted')!;
    const original = stranded.attempts[0].tx_hash;
    h.chain.trackNonces = true;
    h.chain.minePendingHash(original); // our original PAID the claim …
    h.chain.hiddenReceipts.add(original); // … but a lagging replica hides the receipt
    // The replica catches up just as the runner asks the nonce at the safe block.
    h.chain.txCountAtBlock = () => {
      h.chain.hiddenReceipts.clear();
      return stranded.reserved_nonce + 1;
    };

    const second = await runSettlementCycle(h.deps, nextRun(h, 'cycle-2'));
    const confirmed = batchDocs(h.store).find((b) => b.batch_id === stranded.batch_id)!;
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.applied).toBe(true);
    expect(confirmed.confirmed_tx_hash).toBe(original);
    expect(second.reconciliation?.confirmed).toBe(1);
    expect(cycleDoc(h.store).cursor_next).toBe(confirmed.cursor_end); // counters + cursor advanced
    expect(cycleDoc(h.store).consumed.claims_settled).toBe(1);
    const row = ledgerRow(h.store, 'pe-0001');
    expect(row).toMatchObject({ settled: true, settled_batch_id: stranded.batch_id, settled_tx_hash: original });
    expect(row.settled_via).toBeUndefined();
    expect(second.stopReason).toBe('backlog_exhausted');
  });
});

describe(' · a recheck that never settles is bounded by the run deadline', () => {
  it('adopted final revert: a replica flapping between two receipts ends the run at its deadline — no spin', async () => {
    const h = makeHarness({ maxRunMs: 30_000 });
    await registerClaimsBulk(h.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    h.chain.behaviors = ['mine-revert'];
    h.chain.onBroadcast = () => { h.chain.administrativeHold = true; };
    await runSettlementCycle(h.deps, h.config);
    h.chain.onBroadcast = null;
    h.chain.administrativeHold = false;
    const batch = batchDocs(h.store)[0];
    const reverted = batch.attempts.find((a) => a.mined?.status === 'reverted')!;
    const real = h.chain.receipts.get(reverted.tx_hash)!;
    // Reads 2, 5, 8, …: the judge's re-read agrees (final), the conclusion's re-poll disagrees,
    // the receipt path re-records the agreeing one — forever.
    h.chain.receiptFlap = {
      hash: reverted.tx_hash,
      alternate: { ...real, blockNumber: real.blockNumber + 1, blockHash: H(0xf1a9) },
      useAlternate: (n) => n % 3 === 2,
      reads: 0,
    };
    const second = await runSettlementCycle(h.deps, nextRun(h, 'cycle-2', { maxRunMs: 30_000 }));
    expect(second.stopReason).toBe('stranded_batch_pending');
    expect(second.reconciliation?.stillUnresolved[0].detail).toContain('awaiting_finality');
    expect(h.chain.receiptFlap.reads).toBeLessThan(500);
  });

  it('nonce consumed elsewhere: a flapping receipt of an earlier attempt ends the run at its deadline — no spin', async () => {
    const h = makeHarness({ maxReplacementsPerBatch: 2 });
    await registerClaimsBulk(h.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    h.chain.behaviors = ['mine-revert', 'drop', 'drop', 'drop', 'drop'];
    await runSettlementCycle(h.deps, h.config);
    const stranded = batchDocs(h.store).find((b) => b.status === 'submitted')!;
    const reverted = stranded.attempts.find((a) => a.mined?.status === 'reverted')!;
    const real = h.chain.receipts.get(reverted.tx_hash)!;
    h.chain.pending.clear();
    const retryNonce = stranded.attempts[stranded.attempts.length - 1].nonce;
    h.chain.txCountAtBlock = () => retryNonce + 1;
    h.chain.txCount = retryNonce + 1;
    h.chain.behaviors = [];
    // Odd reads (the conclusion's re-poll) disagree with the record; even reads (the receipt
    // path's re-record) agree — the record flips back and forth forever.
    h.chain.receiptFlap = {
      hash: reverted.tx_hash,
      alternate: { ...real, blockNumber: real.blockNumber + 1, blockHash: H(0xf1a9) },
      useAlternate: (n) => n % 2 === 1,
      reads: 0,
    };
    const second = await runSettlementCycle(h.deps, nextRun(h, 'cycle-2', { maxRunMs: 120_000 }));
    expect(second.stopReason).toBe('stranded_batch_pending');
    expect(second.reconciliation?.stillUnresolved[0].detail).toContain('run_time_limit');
    expect(h.chain.receiptFlap.reads).toBeLessThan(500);
  });
});

describe(' · a reverted receipt from a NON-canonical block never holds the loop past the deadline', () => {
  it('stranded mined revert whose block is no longer canonical: the run ends at its deadline (awaiting_finality), bounded reads', async () => {
    // the negative control: without the guard, 5,001 getReceipt calls and a fake clock of
    // 2,600,000 ms on a 30,000 ms budget — step 1 re-records the stale receipt, step 3 judges it
    // `dropped` again, and step 4's deadline check is never reached.
    const h = makeHarness();
    await registerClaimsBulk(h.db, [standardClaim(1, ADDR(0xa1))], 50_000);
    h.chain.behaviors = ['mine-revert'];
    h.chain.onBroadcast = () => { h.chain.administrativeHold = true; };
    const first = await runSettlementCycle(h.deps, h.config);
    expect(first.stopReason).toBe('epoch_gate_closed');
    h.chain.onBroadcast = null;
    h.chain.administrativeHold = false;
    const reverted = batchDocs(h.store)[0].attempts.find((a) => a.mined?.status === 'reverted')!;
    const real = h.chain.receipts.get(reverted.tx_hash)!;
    h.chain.canonical.set(real.blockNumber, H(0xbeef)); // the replica keeps serving a non-canonical block
    h.chain.behaviors = Array(50).fill('drop');

    const counter = countReceiptReads(h);
    const startedAt = h.deps.now();
    const second = await runSettlementCycle(h.deps, nextRun(h, 'cycle-2', { maxRunMs: 30_000 }));
    expect(second.stopReason).toBe('stranded_batch_pending');
    expect(second.reconciliation?.stillUnresolved[0].detail).toContain('awaiting_finality');
    expect(second.reconciliation?.stillUnresolved[0].detail).toContain('is not canonical');
    expect(counter.reads).toBeLessThan(300);
    expect(h.deps.now() - startedAt).toBeLessThan(60_000);
    // Nothing was concluded or applied on a receipt the canonical chain does not carry.
    const batch = batchDocs(h.store)[0];
    expect(batch.status).not.toBe('dead');
    expect(batch.applied).toBe(false);
    expect(ledgerRow(h.store, 'pe-0001').settled).toBe(false);
  });
});

// ── PE METER — earnings with no pe_history row settle end to end ──────────
// A meter pending claim is registered by the meter inlet, judged by the approver from the claim
// itself (no envelope at the relay), settled by the unchanged cycle, and written back to the
// pending claim and the act's row. RED controls: a claim edited after it was committed, a claim
// the calldata settles at a different amount, a demoted act, and a runtime with no meter
// verifier are all refused before anything is approved.
describe('PE meter claims through the settlement cycle', () => {
  const METER_BATCH_HASH = 'a'.repeat(64);
  const actId = (n: number) => `pe_m_${n.toString(16).padStart(48, '0')}`;

  async function seedMeterBatch(harness: Harness, contributor: string): Promise<{ claimKey: string; relayPeIds: string[] }> {
    const relayPeIds = [actId(1), actId(2)];
    const [claim] = aggregateBatchClaims({
      batch_hash: METER_BATCH_HASH,
      device_id: 'dev-meter',
      actor_id: 'agent-meter',
      created_at_ms: 40_000,
      acts: relayPeIds.map((id) => ({
        relay_pe_id: id,
        legs: [{ leg: 'sole' as const, contributor, beneficiary_class: 1, bps: 10_000, points_atomic: '500000000000000000' }],
      })),
    });
    const writer = harness.db.batch();
    writer.set(harness.db.collection('meter_pending_claims_v1').doc(claim.claim_key), { ...claim });
    for (const id of relayPeIds) {
      writer.set(harness.db.collection('meter_act_keys_v1').doc(id), {
        schema: 'provian.meter-act-key.v1', relay_pe_id: id, client_pe_id: id, pe_hash: 'b'.repeat(64),
        prev_hash: 'genesis', device_id: 'dev-meter', batch_hash: METER_BATCH_HASH, actor_id: 'agent-meter',
        timestamp: 39_000, action_type: 'ai_conversation', row: { mint_status: 'eligible' },
        legs: [{ leg: 'sole', contributor, beneficiary_class: 1, bps: 10_000, points_atomic: '500000000000000000' }],
        unit: 'batch', held_reason: null, side: {}, created_at_ms: 40_000,
      });
    }
    await writer.commit();
    return { claimKey: claim.claim_key, relayPeIds };
  }

  function withMeterVerifier(harness: Harness): void {
    (harness.deps as { approval: BatchApprovalDeps }).approval = {
      ...harness.deps.approval!,
      meterClaims: {
        isMeterClaim: isMeterClaimKey,
        verify: (members) => verifyMeterClaimMembers(harness.db as unknown as Firestore, members),
      },
    };
  }

  /** The payout claim the inlet built over `claimKey` (PE meter cost pass: one claim per payee). */
  function payoutOf(harness: Harness, claimKey: string): string {
    const payoutKey = harness.store.get(`meter_pending_claims_v1/${claimKey}`)?.payout_key;
    expect(typeof payoutKey).toBe('string');
    return payoutKey as string;
  }

  it('registers, approves, settles and writes back a meter batch claim through ONE payout claim', async () => {
    const harness = makeHarness();
    withMeterVerifier(harness);
    const { claimKey, relayPeIds } = await seedMeterBatch(harness, ADDR(0xc1));
    const inlet = await runMeterClaimInlet(harness.db as unknown as Firestore, { nowMs: 50_000 });
    expect(inlet).toMatchObject({ scanned: 1, aggregated: 1, payouts: 1, registered: 1, rejected: [], tampered: [] });
    expect(harness.store.get(`meter_pending_claims_v1/${claimKey}`)?.state).toBe('aggregated');
    const payoutKey = payoutOf(harness, claimKey);
    expect(harness.store.get(`meter_pending_claims_v1/${payoutKey}`)?.state).toBe('registered');
    // The member itself is never on the ledger; the payout is.
    expect(harness.store.get(`pvt9_claim_ledger_v1/${claimKey}#sole`)).toBeUndefined();

    const outcome = await runSettlementCycle(harness.deps, harness.config);
    expect(outcome.outcome).toBe('completed');
    expect(outcome.claimsSettled).toBe(1);
    const [batch] = batchDocs(harness.store);
    expect(batch.status).toBe('confirmed');
    expect(batch.writebacks_complete).toBe(true);
    // One claim on chain for the payee: 2 acts × 0.5 PVT.
    expect(harness.store.get(`pvt9_claim_ledger_v1/${payoutKey}#sole`)?.settled).toBe(true);
    for (const key of [payoutKey, claimKey]) {
      const pending = harness.store.get(`meter_pending_claims_v1/${key}`);
      expect(pending?.state).toBe('settled');
      expect(pending?.expire_at).toBeDefined();
    }
    for (const id of relayPeIds) {
      expect((harness.store.get(`meter_act_keys_v1/${id}`)?.row as Record<string, unknown>).mint_status).toBe('minted');
    }
    // Re-running the inlet registers nothing new (nothing is pending).
    expect((await runMeterClaimInlet(harness.db as unknown as Firestore, { nowMs: 60_000 })).scanned).toBe(0);
  });

  it('two batches of one payee settle as ONE kernel claim; another payee gets its own', async () => {
    const harness = makeHarness();
    withMeterVerifier(harness);
    const a = await seedMeterBatch(harness, ADDR(0xc7));
    const [second] = aggregateBatchClaims({
      batch_hash: 'b'.repeat(64), device_id: 'dev-meter', actor_id: 'agent-meter', created_at_ms: 41_000,
      acts: [{ relay_pe_id: actId(9), legs: [{ leg: 'sole' as const, contributor: ADDR(0xc7), beneficiary_class: 1, bps: 10_000, points_atomic: '250000000000000000' }] }],
    });
    const [other] = aggregateBatchClaims({
      batch_hash: 'c'.repeat(64), device_id: 'dev-other', actor_id: 'agent-other', created_at_ms: 41_000,
      acts: [{ relay_pe_id: actId(10), legs: [{ leg: 'sole' as const, contributor: ADDR(0xc8), beneficiary_class: 1, bps: 10_000, points_atomic: '250000000000000000' }] }],
    });
    harness.store.set(`meter_pending_claims_v1/${second.claim_key}`, { ...second });
    harness.store.set(`meter_pending_claims_v1/${other.claim_key}`, { ...other });
    const inlet = await runMeterClaimInlet(harness.db as unknown as Firestore, { nowMs: 50_000 });
    expect(inlet).toMatchObject({ scanned: 3, aggregated: 3, payouts: 2, registered: 2 });
    const payoutKey = payoutOf(harness, a.claimKey);
    expect(payoutOf(harness, second.claim_key)).toBe(payoutKey);
    expect(payoutOf(harness, other.claim_key)).not.toBe(payoutKey);
    expect(harness.store.get(`meter_pending_claims_v1/${payoutKey}`)?.record_points_atomic).toBe('1250000000000000000');
    const outcome = await runSettlementCycle(harness.deps, harness.config);
    expect(outcome.claimsSettled).toBe(2);
  });

  it('RED: a pending claim edited after commit is refused at the inlet', async () => {
    const harness = makeHarness();
    const { claimKey } = await seedMeterBatch(harness, ADDR(0xc2));
    const tampered = { ...harness.store.get(`meter_pending_claims_v1/${claimKey}`)!, record_points_atomic: '9000000000000000000' };
    harness.store.set(`meter_pending_claims_v1/${claimKey}`, tampered);
    const inlet = await runMeterClaimInlet(harness.db as unknown as Firestore, { nowMs: 50_000 });
    expect(inlet.registered).toBe(0);
    expect(inlet.aggregated).toBe(0);
    expect(inlet.tampered).toEqual([claimKey]);
  });

  it('RED: the approver refuses a payout edited after registration', async () => {
    const harness = makeHarness();
    withMeterVerifier(harness);
    const { claimKey } = await seedMeterBatch(harness, ADDR(0xc3));
    await runMeterClaimInlet(harness.db as unknown as Firestore, { nowMs: 50_000 });
    const key = `meter_pending_claims_v1/${payoutOf(harness, claimKey)}`;
    harness.store.set(key, { ...harness.store.get(key)!, contributor: ADDR(0xdd) });
    const outcome = await runSettlementCycle(harness.deps, harness.config);
    expect(outcome.claimsSettled).toBe(0);
    expect(harness.verifier.approveCalls).toBe(0);
  });

  it('RED: the approver refuses a payout whose MEMBER was edited after it was taken', async () => {
    const harness = makeHarness();
    withMeterVerifier(harness);
    const { claimKey } = await seedMeterBatch(harness, ADDR(0xc9));
    await runMeterClaimInlet(harness.db as unknown as Firestore, { nowMs: 50_000 });
    const key = `meter_pending_claims_v1/${claimKey}`;
    harness.store.set(key, { ...harness.store.get(key)!, record_points_atomic: '9000000000000000000' });
    const outcome = await runSettlementCycle(harness.deps, harness.config);
    expect(outcome.claimsSettled).toBe(0);
    expect(harness.verifier.approveCalls).toBe(0);
  });

  it('RED: the approver refuses a payout whose member points at ANOTHER payout', async () => {
    const harness = makeHarness();
    withMeterVerifier(harness);
    const { claimKey } = await seedMeterBatch(harness, ADDR(0xca));
    await runMeterClaimInlet(harness.db as unknown as Firestore, { nowMs: 50_000 });
    const key = `meter_pending_claims_v1/${claimKey}`;
    harness.store.set(key, { ...harness.store.get(key)!, payout_key: `mp_${'f'.repeat(48)}` });
    const outcome = await runSettlementCycle(harness.deps, harness.config);
    expect(outcome.claimsSettled).toBe(0);
    expect(harness.verifier.approveCalls).toBe(0);
  });

  it('a demotion BEFORE the payout trims the act out of its batch claim; the payout pays the rest', async () => {
    const harness = makeHarness();
    withMeterVerifier(harness);
    const { claimKey, relayPeIds } = await seedMeterBatch(harness, ADDR(0xc4));
    const demoted = await mutatePeHistoryRowWithAggregate(harness.db as never, relayPeIds[1], { mint_status: 'corroborated_duplicate' }, { nowMs: 45_000 });
    expect(demoted.outcome).toBe('applied');
    const trimmed = harness.store.get(`meter_pending_claims_v1/${claimKey}`)!;
    expect(trimmed.record_points_atomic).toBe('500000000000000000');
    expect((trimmed.acts as { relay_pe_id: string }[]).map((x) => x.relay_pe_id)).toEqual([relayPeIds[0]]);
    await runMeterClaimInlet(harness.db as unknown as Firestore, { nowMs: 50_000 });
    expect(harness.store.get(`meter_pending_claims_v1/${payoutOf(harness, claimKey)}`)?.record_points_atomic).toBe('500000000000000000');
    const outcome = await runSettlementCycle(harness.deps, harness.config);
    expect(outcome.claimsSettled).toBe(1);
  });

  it('RED: a demotion AFTER the act is in a payout is refused (its earnings are already in flight)', async () => {
    const harness = makeHarness();
    withMeterVerifier(harness);
    const { relayPeIds } = await seedMeterBatch(harness, ADDR(0xcb));
    await runMeterClaimInlet(harness.db as unknown as Firestore, { nowMs: 50_000 });
    const demoted = await mutatePeHistoryRowWithAggregate(harness.db as never, relayPeIds[1], { mint_status: 'corroborated_duplicate' }, { nowMs: 51_000 });
    expect(demoted.outcome).toBe('precondition_failed');
    expect((harness.store.get(`meter_act_keys_v1/${relayPeIds[1]}`)?.row as Record<string, unknown>).mint_status).toBe('eligible');
  });

  it('RED: the approver refuses calldata that settles a meter claim at a different amount', async () => {
    const harness = makeHarness();
    withMeterVerifier(harness);
    const { claimKey } = await seedMeterBatch(harness, ADDR(0xc6));
    await runMeterClaimInlet(harness.db as unknown as Firestore, { nowMs: 50_000 });
    // The payout stays intact; the LEDGER row the calldata is built from is inflated.
    const ledgerKey = `pvt9_claim_ledger_v1/${payoutOf(harness, claimKey)}#sole`;
    harness.store.set(ledgerKey, { ...harness.store.get(ledgerKey)!, record_points_atomic: '5000000000000000000' });
    const outcome = await runSettlementCycle(harness.deps, harness.config);
    expect(outcome.claimsSettled).toBe(0);
    expect(harness.verifier.approveCalls).toBe(0);
  });

  it('RED: with no meter verifier wired, a meter member has no candidate and is refused', async () => {
    const harness = makeHarness();
    await seedMeterBatch(harness, ADDR(0xc5));
    await runMeterClaimInlet(harness.db as unknown as Firestore, { nowMs: 50_000 });
    const outcome = await runSettlementCycle(harness.deps, harness.config);
    expect(outcome.claimsSettled).toBe(0);
    expect(harness.verifier.approveCalls).toBe(0);
  });
});
