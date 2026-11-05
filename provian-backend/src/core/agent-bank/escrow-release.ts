import { CanonicalWallet } from '../onchain/canonical-wallet';
/**
 * Agent Bank - On-chain escrow release (WS1).
 *
 * The on-chain ProvianEscrow contract's `releaseEscrow(bytes32 escrowId)` is
 * permissionless once `autoReleaseAt` has elapsed and depositor-only before
 * then. Until this module existed, NOTHING in the backend ever called it:
 * `completeEscrow` and `processAutoReleases` flipped Firestore status +
 * generated PEs + credited wallet stats while the contract kept the funds
 * locked. This module is the single place that performs the real on-chain
 * release, so a "completed" escrow in Firestore corresponds to funds that
 * actually moved on-chain.
 *
 * Two release sources:
 *   1. The DEPOSITOR releases immediately with their OWN key (SDK
 *      `bank.releaseEscrow`), pre- or post-timeout. The backend cannot sign
 *      as the depositor, so it only OBSERVES that on-chain status is
 *      `Completed` and records it.
 *   2. The backend gas-only EOA (`ESCROW_RELEASE_KEY`) calls
 *      `releaseEscrow` permissionlessly AFTER `autoReleaseAt` as the
 *      guaranteed payout fallback (the no-show auto-release path).
 *
 * The release EOA is a dedicated, gas-only key. Gate B (see
 * `assertReleaseSignerIdentity`) refuses to start if it collides with the
 * PVT minter or the deployer/treasury key — a release key with mint or
 * admin authority would be a severe blast-radius escalation.
 *
 * The on-chain `bytes32 escrowId` is chosen by the depositor off-relay at
 * fund time, so the relay does not inherently know it. We recover it from
 * the funding transaction's `EscrowFunded` / `EscrowFundedPVT` event (the
 * funding tx hash is stored as `fund_tx_hash`), which makes this robust and
 * backward-compatible with escrows funded before this module existed.
 */

import { ethers } from 'ethers';
import { getChainProvider, type ChainName } from '../onchain/rpc-provider';
import {
  parseEscrowFundedEvents,
  decodeEscrowStructPrefix,
  usdcToAtomic,
} from '../onchain/tx-verifier';
import { resolveEscrowContractForDocument } from './escrow';
import { ESCROW_ABI } from './types';
import { FORBIDDEN_KEEPER_IDENTITIES, keeperForbiddenSignerEntries } from '../config/live-value-recipients';
import type {
  Currency,
  EscrowChainGateway,
  EscrowDisputeSettleResult,
  EscrowDisputeStateRead,
  EscrowDocument,
  EscrowSettleResult,
} from './types';

// The minimal ESCROW_ABI in types.ts omits the PVT event variants we need to
// recover the on-chain id from either currency's funding event. (On-chain
// STATUS is read version-agnostically via readEscrowStatus below, NOT via the
// public mapping getter - the V3 USDC struct is 7-field and the V4 struct is
// 8-field, so a fixed-shape getter ABI would fail to decode one of them.
// `status` sits at word index 5 in BOTH, so we read that slot directly.)
const ESCROW_RELEASE_ABI = [
  ...ESCROW_ABI,
  // PVT-currency funding/release event variants (USDC variants already in ESCROW_ABI).
  'event EscrowFundedPVT(bytes32 indexed escrowId, uint256 amount, uint256 feeBurned)',
  'event EscrowReleasedPVT(bytes32 indexed escrowId, address indexed recipient, uint256 netAmount, bool autoRelease)',
  // Pass-3 #1: dispute-resolution surface. `resolveDispute` + `EscrowResolved`
  // are already in ESCROW_ABI; add the PVT-resolution event variant and the
  // permissionless refund-only timeout escape (Pass-3 #4 contract leg).
  'event EscrowResolvedPVT(bytes32 indexed escrowId, bool releaseToRecipient)',
  'function claimDisputeTimeout(bytes32 escrowId) external',
  'event EscrowDisputeTimedOut(bytes32 indexed escrowId)',
] as const;

// On-chain Status enum (ProvianEscrowV4.sol): Created=0, Funded=1,
// Completed=2, Disputed=3, Resolved=4, Cancelled=5.
const STATUS_FUNDED = 1;
const STATUS_COMPLETED = 2;
const STATUS_DISPUTED = 3;
const STATUS_RESOLVED = 4;

/**
 * Gate B: refuse to use a release key that is the PVT minter or the
 * deployer/treasury key. Throws (fail-closed at construction) on collision.
 */
export function assertReleaseSignerIdentity(releaseAddress: string): void {
  const norm = (a: string | undefined): string => (a ?? '').toLowerCase();
  const release = norm(releaseAddress);

  const forbidden = new Map<string, string>();

  // Minter — authoritative: derive from the live key if present.
  if (process.env.PVT_MINTER_KEY) {
    try {
      forbidden.set(norm(new ethers.Wallet(process.env.PVT_MINTER_KEY).address), 'PVT minter (PVT_MINTER_KEY)');
    } catch {
      /* malformed minter key is a separate problem; the identity guard just skips it */
    }
  }
  // Treasury key identity (KEEPER_FORBIDDEN_SIGNER_ADDRESS, or its former name).
  for (const [addr, reason] of keeperForbiddenSignerEntries()) {
    forbidden.set(addr, reason);
  }
  // Foundation Safe (treasury recipient / FoundationMembership administrator;
  // not the live Base PVTv8 or Pass-3 admin/economic setter).
  if (process.env.FOUNDATION_TREASURY_ADDRESS) {
    forbidden.set(norm(process.env.FOUNDATION_TREASURY_ADDRESS), 'Foundation Safe (FOUNDATION_TREASURY_ADDRESS)');
  }
  // Known-bad anchors, hardcoded (belt-and-suspenders). this covers BOTH the exposed legacy
  // EOA and the Provian treasury. One env var cannot name two addresses, so relying on
  // KEEPER_FORBIDDEN_SIGNER_ADDRESS alone left whichever one it did not name uncovered.
  for (const [addr, reason] of FORBIDDEN_KEEPER_IDENTITIES) {
    forbidden.set(addr, reason);
  }

  const hit = forbidden.get(release);
  if (hit) {
    throw new Error(
      `[escrow-release] GATE B FAILED: ESCROW_RELEASE_KEY resolves to ${releaseAddress}, which is the ${hit}. ` +
        'The escrow release EOA must be a dedicated gas-only key with no minter/admin/treasury role. Refusing to start.',
    );
  }
}

/**
 * Recover the on-chain `bytes32 escrowId` from a funding transaction's receipt.
 *
 * #36 (Pass-2 WS3): a single tx can fund MORE THAN ONE escrow, so the prior
 * "return the FIRST EscrowFunded event" was unbound — it could resolve to a
 * different escrow than the one being settled (e.g. one that pays the
 * depositor). We instead select the EscrowFunded/EscrowFundedPVT event whose
 * `amount` matches this escrow's principal AND whose on-chain struct recipient
 * matches this escrow's recipient. Returns null when nothing matches (caller
 * treats that as unrecoverable → does NOT release). Uses the shared
 * parse/decode helpers so this stays byte-consistent with the funding verifier.
 */
async function recoverOnchainIdFromFundTx(
  chain: ChainName,
  contractAddress: string,
  fundTxHash: string,
  expectedAmountAtomic: bigint,
  expectedRecipient: string,
): Promise<string | null> {
  const provider = getChainProvider(chain);
  const receipt = await provider.getTransactionReceipt(fundTxHash);
  if (!receipt || receipt.status !== 1) return null;

  const amountMatches = parseEscrowFundedEvents(receipt.logs, contractAddress)
    .filter((e) => e.amountAtomic === expectedAmountAtomic);
  const wantRecipient = expectedRecipient.toLowerCase();
  for (const ev of amountMatches) {
    const data = ESCROWS_SELECTOR + ev.escrowId.replace(/^0x/, '').toLowerCase().padStart(64, '0');
    const raw = await provider.call({ to: contractAddress, data });
    const struct = decodeEscrowStructPrefix(raw);
    if (struct && struct.recipient === wantRecipient && struct.amountAtomic === expectedAmountAtomic) {
      return ev.escrowId; // bytes32 escrowId (indexed), 0x-lowercased
    }
  }
  return null;
}

const ESCROWS_SELECTOR = ethers.id('escrows(bytes32)').slice(0, 10);

/**
 * Read an escrow's on-chain Status enum (0..5) version-agnostically.
 *
 * `status` is the 6th field (word index 5) of the public `escrows` struct in
 * BOTH the V3 USDC layout (7 fields: depositor, recipient, amount, fee,
 * autoReleaseAt, status, feePaidInPVT) and the V4 layout (8 fields: ...status,
 * currency, feePaidInPVT — currency is appended AFTER status). We therefore
 * read word index 5 from the raw eth_call return rather than ABI-decoding the
 * whole tuple, which would throw BAD_DATA on whichever shape the fixed ABI
 * doesn't match. All currently-deployed escrows are 8-field, but this keeps the
 * P0 release path correct if a 7-field V3 USDC escrow is ever deployed.
 * Returns null on a too-short return (caller treats as failed).
 */
async function readEscrowStatus(
  chain: ChainName,
  contractAddress: string,
  onchainId: string,
): Promise<number | null> {
  const provider = getChainProvider(chain);
  const data = ESCROWS_SELECTOR + onchainId.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const raw = await provider.call({ to: contractAddress, data });
  const body = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (body.length < 6 * 64) return null; // not enough words to contain status@5
  return parseInt(body.slice(5 * 64, 6 * 64), 16);
}

const DISPUTE_DEADLINE_SELECTOR = ethers.id('disputeDeadline(bytes32)').slice(0, 10);

/**
 * read `disputeDeadline(escrowId)` (V4 only; unix seconds, 0 when never disputed).
 * Throws on RPC error; returns null on a malformed (too-short) return. A V3 contract has no
 * such getter — the call reverts and the caller fails closed.
 */
async function readDisputeDeadline(
  chain: ChainName,
  contractAddress: string,
  onchainId: string,
): Promise<bigint | null> {
  const provider = getChainProvider(chain);
  const data = DISPUTE_DEADLINE_SELECTOR + onchainId.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const raw = await provider.call({ to: contractAddress, data });
  const body = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (body.length < 64) return null;
  return BigInt('0x' + body.slice(0, 64));
}

// Interface for decoding dispute-resolution events (Pass-3 #1).
const ESCROW_RESOLVE_IFACE = new ethers.Interface(ESCROW_RELEASE_ABI);

/**
 * Confirm a dispute-resolution receipt actually moved THIS escrow to Resolved in
 * the expected direction. Mirrors the bond-keeper's "verify off the emitted
 * event, never assert a state change the chain didn't emit" pattern: require an
 * EscrowResolved / EscrowResolvedPVT log for this escrowId whose
 * releaseToRecipient matches. (claimDisputeTimeout also emits
 * EscrowResolved(id,false) via _settleResolution, so the refund case is covered
 * by the same check.)
 */
function confirmResolvedEvent(
  receipt: ethers.TransactionReceipt,
  contractAddress: string,
  onchainId: string,
  expectedReleaseToRecipient: boolean,
): boolean {
  const wantId = onchainId.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
    let parsed: ethers.LogDescription | null;
    try {
      parsed = ESCROW_RESOLVE_IFACE.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (parsed?.name !== 'EscrowResolved' && parsed?.name !== 'EscrowResolvedPVT') continue;
    const evId = String(parsed.args.escrowId).replace(/^0x/, '').toLowerCase().padStart(64, '0');
    if (evId !== wantId) continue;
    if (Boolean(parsed.args.releaseToRecipient) !== expectedReleaseToRecipient) continue;
    return true;
  }
  return false;
}

/**
 * Recover the ACTUAL on-chain resolution DIRECTION for an already-Resolved escrow
 * from its EscrowResolved / EscrowResolvedPVT log. The direction is stored ONLY in
 * the event, not the escrow struct (readEscrowStatus returns only the Status enum),
 * so the OBSERVE path (already_resolved) must read the log to avoid recording a
 * direction the chain never performed (Pass-3 review finding). Topic-filtered by the
 * indexed escrowId → at most a couple logs; bounded from the funding block. Returns
 * true (released to recipient) / false (refunded to depositor), or null if no
 * resolution event is found (caller fails closed). Throws on RPC error (caller wraps).
 */
async function recoverResolvedDirection(
  chain: ChainName,
  contractAddress: string,
  onchainId: string,
  fromBlock: number,
): Promise<{ releaseToRecipient: boolean; txHash: string } | null> {
  const provider = getChainProvider(chain);
  const idTopic = '0x' + onchainId.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const resolvedTopic = ESCROW_RESOLVE_IFACE.getEvent('EscrowResolved')?.topicHash;
  const resolvedPvtTopic = ESCROW_RESOLVE_IFACE.getEvent('EscrowResolvedPVT')?.topicHash;
  if (!resolvedTopic || !resolvedPvtTopic) return null;
  const logs = await provider.getLogs({
    address: contractAddress,
    topics: [[resolvedTopic, resolvedPvtTopic], idTopic],
    fromBlock: Math.max(0, fromBlock),
    toBlock: 'latest',
  });
  // Most-recent matching resolution wins.
  for (let i = logs.length - 1; i >= 0; i--) {
    let parsed: ethers.LogDescription | null;
    try {
      parsed = ESCROW_RESOLVE_IFACE.parseLog({ topics: [...logs[i].topics], data: logs[i].data });
    } catch {
      continue;
    }
    if (parsed && (parsed.name === 'EscrowResolved' || parsed.name === 'EscrowResolvedPVT')) {
      // linked-job settlement: also surface the settlement TX HASH — the receipt anchor the
      // linked-job settlement path is idempotent by.
      return {
        releaseToRecipient: Boolean(parsed.args.releaseToRecipient),
        txHash: logs[i].transactionHash,
      };
    }
  }
  return null;
}

const COURT_VERDICT_IFACE = new ethers.Interface([
  'event Verdict(bytes32 indexed escrowId, bool releaseToRecipient, uint8 votesForRelease, uint8 votesForRefund)',
  'function courtContract() view returns (address)',
]);

/**
 * Pure: does this resolution transaction carry the Court's own `Verdict` for this escrow? Only a
 * log emitted BY the escrow contract's registered Court counts — a look-alike event from any other
 * contract in the same transaction is ignored.
 */
export function receiptCarriesCourtVerdict(
  logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string> }>,
  courtAddress: string,
  onchainId: string,
): boolean {
  if (!ethers.isAddress(courtAddress) || courtAddress === ethers.ZeroAddress) return false;
  const verdictTopic = COURT_VERDICT_IFACE.getEvent('Verdict')?.topicHash;
  if (!verdictTopic) return false;
  const idTopic = '0x' + onchainId.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  return logs.some((log) => log.address.toLowerCase() === courtAddress.toLowerCase()
    && log.topics[0] === verdictTopic
    && typeof log.topics[1] === 'string' && log.topics[1].toLowerCase() === idTopic);
}

/**
 * WHO resolved an escrow the chain already shows Resolved — the Court (its `Verdict` rides
 * the same transaction) or the escrow admin / the timeout refund. Read from the chain alone: the
 * escrow contract's own `courtContract()` and the resolving transaction's receipt. Throws on any
 * RPC error or a missing receipt (the caller fails closed rather than guess).
 */
async function resolutionDecidedByCourt(
  chain: ChainName,
  contractAddress: string,
  onchainId: string,
  txHash: string,
): Promise<boolean> {
  const provider = getChainProvider(chain);
  const raw = await provider.call({ to: contractAddress, data: COURT_VERDICT_IFACE.encodeFunctionData('courtContract') });
  const [courtAddress] = COURT_VERDICT_IFACE.decodeFunctionResult('courtContract', raw) as unknown as [string];
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error('resolution_receipt_not_found');
  return receiptCarriesCourtVerdict(receipt.logs, courtAddress, onchainId);
}

/**
 * linked-job settlement: recover the RELEASE tx hash for an escrow already Completed on-chain
 * (depositor SDK release or a prior run) from its EscrowReleased /
 * EscrowReleasedPVT log. The observe path (`already_released`) previously
 * carried no tx hash, which left the receipt-gated linked-job settlement with
 * nothing to be idempotent by. Topic-filtered by the indexed escrowId, bounded
 * from the funding block. Best-effort: returns null when no release event is
 * found (the escrow record still completes as before; the job advancement then
 * fails closed and is retried). Throws on RPC error (caller wraps).
 */
async function recoverReleaseTxHash(
  chain: ChainName,
  contractAddress: string,
  onchainId: string,
  fromBlock: number,
): Promise<string | null> {
  const provider = getChainProvider(chain);
  const idTopic = '0x' + onchainId.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const releasedTopic = ESCROW_RESOLVE_IFACE.getEvent('EscrowReleased')?.topicHash;
  const releasedPvtTopic = ESCROW_RESOLVE_IFACE.getEvent('EscrowReleasedPVT')?.topicHash;
  if (!releasedTopic || !releasedPvtTopic) return null;
  const logs = await provider.getLogs({
    address: contractAddress,
    topics: [[releasedTopic, releasedPvtTopic], idTopic],
    fromBlock: Math.max(0, fromBlock),
    toBlock: 'latest',
  });
  // Most-recent matching release wins (there is at most one on-chain).
  return logs.length > 0 ? logs[logs.length - 1].transactionHash : null;
}

class RealEscrowChainGateway implements EscrowChainGateway {
  private readonly releaseKey: string | undefined;
  private readonly signerByChain = new Map<ChainName, ethers.Wallet>();

  constructor() {
    this.releaseKey = process.env.ESCROW_RELEASE_KEY;
    if (this.releaseKey) {
      // Gate B — fail closed at construction if the key has any privileged identity.
      const addr = new ethers.Wallet(this.releaseKey).address;
      assertReleaseSignerIdentity(addr);
      console.log(`[escrow-release] gas-only release signer configured: ${addr}`);
    } else {
      console.warn(
        '[escrow-release] ESCROW_RELEASE_KEY not set — backend cannot auto-release escrows on-chain. ' +
          'Funded escrows past auto-release will remain funded (not falsely completed) until the key is provisioned.',
      );
    }
  }

  canSign(): boolean {
    return !!this.releaseKey;
  }

  private signerFor(chain: ChainName): ethers.Wallet {
    let s = this.signerByChain.get(chain);
    if (!s) {
      s = new CanonicalWallet(this.releaseKey as string, getChainProvider(chain));
      this.signerByChain.set(chain, s);
    }
    return s;
  }

  /**
   * Resolve the escrow contract address + the on-chain bytes32 id (from the
   * stored id, else recovered from the funding tx bound to this escrow's
   * principal + recipient — #36). Shared by settle() and settleDispute(). On
   * success returns the ids; on failure returns the terminal result the caller
   * returns verbatim (`failed` / `unrecoverable_id`), so both statuses stay
   * byte-identical to the pre-refactor settle() behavior.
   */
  private async resolveContractAndOnchainId(
    escrow: EscrowDocument,
  ): Promise<
    | { ok: true; contractAddress: string; onchainId: string }
    | { ok: false; result: { status: 'failed' | 'unrecoverable_id'; reason: string } }
  > {
    const chain = escrow.chain as ChainName;
    const currency: Currency = escrow.currency ?? 'usdc';

    let contractAddress: string;
    try {
      contractAddress = resolveEscrowContractForDocument({ ...escrow, currency });
    } catch (err) {
      return { ok: false, result: { status: 'failed', reason: `contract_unconfigured: ${(err as Error).message}` } };
    }

    // New escrows persist onchain_escrow_id at funding time (verifyFunding), so
    // the recovery path runs only for legacy escrows funded before that change.
    let onchainId = escrow.onchain_escrow_id ?? null;
    if (!onchainId) {
      if (!escrow.fund_tx_hash) return { ok: false, result: { status: 'unrecoverable_id', reason: 'no_fund_tx_hash' } };
      // #36: bind recovery to this escrow's principal + recipient, never the
      // positionally-first funding event in the tx.
      const expectedAmountAtomic =
        currency === 'pvt' ? BigInt(escrow.amount_pvt ?? '0') : usdcToAtomic(escrow.amount_usdc);
      try {
        onchainId = await recoverOnchainIdFromFundTx(
          chain,
          contractAddress,
          escrow.fund_tx_hash,
          expectedAmountAtomic,
          escrow.recipient_address,
        );
      } catch (err) {
        return { ok: false, result: { status: 'failed', reason: `recover_id_rpc_error: ${(err as Error).message}` } };
      }
      if (!onchainId) return { ok: false, result: { status: 'unrecoverable_id', reason: 'no_funding_event_in_tx' } };
    }
    return { ok: true, contractAddress, onchainId };
  }

  async settle(escrow: EscrowDocument): Promise<EscrowSettleResult> {
    const chain = escrow.chain as ChainName;

    const resolved = await this.resolveContractAndOnchainId(escrow);
    if (!resolved.ok) return resolved.result;
    const { contractAddress, onchainId } = resolved;

    // Read current on-chain status (version-agnostic; see readEscrowStatus).
    let status: number | null;
    try {
      status = await readEscrowStatus(chain, contractAddress, onchainId);
    } catch (err) {
      return { status: 'failed', onchainId, reason: `read_status_rpc_error: ${(err as Error).message}` };
    }
    if (status === null) {
      return { status: 'failed', onchainId, reason: 'escrows_return_too_short' };
    }

    if (status === STATUS_COMPLETED) {
      return this.observedReleased(chain, contractAddress, onchainId, escrow.fund_block_number ?? 0);
    }
    if (status !== STATUS_FUNDED) {
      return { status: 'failed', onchainId, reason: `unexpected_onchain_status_${status}` };
    }

    // Funded on-chain. Before auto-release, only the depositor (their own
    // key) can release — the backend must not and cannot.
    if (Date.now() < escrow.auto_release_at) {
      return { status: 'pending_pre_timeout', onchainId };
    }

    // Post auto-release: permissionless. Use the gas-only EOA.
    if (!this.canSign()) return { status: 'unconfigured', onchainId };

    try {
      const c = new ethers.Contract(contractAddress, ESCROW_RELEASE_ABI, this.signerFor(chain));
      const tx = await c.releaseEscrow(onchainId);
      const receipt = await tx.wait(1);
      if (receipt && receipt.status === 1) {
        return { status: 'released', txHash: receipt.hash ?? tx.hash, onchainId };
      }
      return { status: 'failed', onchainId, reason: 'release_tx_reverted' };
    } catch (err) {
      // Idempotency: a concurrent release (depositor SDK or a prior run) may
      // have completed it between our read and our send. Re-read; if it's now
      // Completed, treat as success.
      try {
        const reread = await readEscrowStatus(chain, contractAddress, onchainId);
        if (reread === STATUS_COMPLETED) {
          return this.observedReleased(chain, contractAddress, onchainId, escrow.fund_block_number ?? 0);
        }
      } catch {
        /* fall through to failed */
      }
      return { status: 'failed', onchainId, reason: `release_failed: ${(err as Error).message}` };
    }
  }

  /**
   * linked-job settlement observe-path result for an escrow already Completed on-chain: recover
   * the release tx hash from the EscrowReleased log so the caller has the
   * settlement receipt anchor. Best-effort — an unrecoverable hash still
   * returns `already_released` (the escrow record completes exactly as
   * before); only the receipt-gated linked-job advancement stays pending.
   */
  private async observedReleased(
    chain: ChainName,
    contractAddress: string,
    onchainId: string,
    fromBlock: number,
  ): Promise<EscrowSettleResult> {
    let txHash: string | null;
    try {
      txHash = await recoverReleaseTxHash(chain, contractAddress, onchainId, fromBlock);
    } catch {
      txHash = null;
    }
    return { status: 'already_released', onchainId, ...(txHash ? { txHash } : {}) };
  }

  /**
   * Pass-3 #1: settle a DISPUTED escrow on-chain, then let the caller record it.
   *
   * The prior backend `resolveDispute` / Court `castVote` majority flipped
   * Firestore to 'resolved' + emitted escrow_resolved/court_verdict PEs while the
   * on-chain escrow stayed Disputed forever — the disputed principal was locked
   * with no relay-, admin-, or depositor-callable exit, yet both parties were told
   * they'd been paid. This gateway is the single place the backend drives / observes
   * the REAL on-chain resolution, mirroring settle()'s fail-closed contract: it
   * NEVER flips Firestore; the caller records ONLY on a terminal
   * resolved/already_resolved.
   */
  async settleDispute(
    escrow: EscrowDocument,
    releaseToRecipient: boolean,
  ): Promise<EscrowDisputeSettleResult> {
    const chain = escrow.chain as ChainName;

    const resolved = await this.resolveContractAndOnchainId(escrow);
    if (!resolved.ok) return resolved.result; // 'failed' | 'unrecoverable_id'
    const { contractAddress, onchainId } = resolved;

    let status: number | null;
    try {
      status = await readEscrowStatus(chain, contractAddress, onchainId);
    } catch (err) {
      return { status: 'failed', onchainId, reason: `read_status_rpc_error: ${(err as Error).message}` };
    }
    if (status === null) return { status: 'failed', onchainId, reason: 'escrows_return_too_short' };

    // Already terminally Resolved on-chain (Court on-chain vote, admin, or a prior
    // run / claimDisputeTimeout). Recover the ACTUAL direction from the event so the
    // caller records what the chain paid, not its requested direction.
    if (status === STATUS_RESOLVED) {
      return this.observedResolved(chain, contractAddress, onchainId, escrow.fund_block_number ?? 0);
    }

    // Neither Disputed nor Resolved (e.g. still Funded because no on-chain dispute
    // was ever filed, or Completed/Cancelled). The backend cannot resolve it.
    if (status !== STATUS_DISPUTED) {
      return { status: 'not_disputed_onchain', onchainId, reason: `unexpected_onchain_status_${status}` };
    }

    // Disputed on-chain. Drive the resolution with whatever authority we have.
    if (!this.canSign()) return { status: 'unconfigured', onchainId };

    const c = new ethers.Contract(contractAddress, ESCROW_RELEASE_ABI, this.signerFor(chain));

    // 1) resolveDispute(id, releaseToRecipient) — authoritative for BOTH directions
    //    but onlyAdminOrCourt. On the live founder-EOA-admin stack the gas-only
    //    release EOA is neither, so ethers' eth_estimateGas reverts OnlyAdminOrCourt
    //    and THROWS before broadcasting (no tx, no gas wasted). A deployment that
    //    grants this EOA court/admin authority (or a test double) reaches the
    //    confirmed receipt. The event check binds the recorded direction to what the
    //    chain actually did.
    try {
      const tx = await c.resolveDispute(onchainId, releaseToRecipient);
      const receipt = await tx.wait(1);
      if (receipt && receipt.status === 1 && confirmResolvedEvent(receipt, contractAddress, onchainId, releaseToRecipient)) {
        return { status: 'resolved', txHash: receipt.hash ?? tx.hash, onchainId, resolvedReleaseToRecipient: releaseToRecipient, resolvedByCourt: false };
      }
    } catch {
      /* not authorized / estimate revert / rpc — fall through */
    }

    // 2) Refund-only permissionless escape: claimDisputeTimeout refunds the ORIGINAL
    //    depositor once the on-chain dispute timeout has elapsed. NEVER use it for a
    //    release_to_recipient verdict — it always refunds the depositor, which would
    //    settle the WRONG party.
    if (!releaseToRecipient) {
      try {
        const tx = await c.claimDisputeTimeout(onchainId);
        const receipt = await tx.wait(1);
        if (receipt && receipt.status === 1 && confirmResolvedEvent(receipt, contractAddress, onchainId, false)) {
          return { status: 'resolved', txHash: receipt.hash ?? tx.hash, onchainId, resolvedReleaseToRecipient: false, resolvedByCourt: false };
        }
      } catch {
        /* too early (DisputeTimeoutNotReached) / already resolved / rpc — fall through */
      }
    }

    // 3) Re-read: a concurrent Court on-chain vote / admin / prior run may have
    //    resolved it between our first read and now. Recover the actual direction.
    try {
      const reread = await readEscrowStatus(chain, contractAddress, onchainId);
      if (reread === STATUS_RESOLVED) {
        return await this.observedResolved(chain, contractAddress, onchainId, escrow.fund_block_number ?? 0);
      }
    } catch {
      /* fall through */
    }

    // Still Disputed on-chain and the backend cannot settle this direction
    // (release_to_recipient needs admin/court; a pre-timeout refund needs the same).
    // Fail closed: the caller must NOT record a resolution the chain never performed.
    return { status: 'pending_onchain', onchainId };
  }

  /**
   * READ-ONLY dispute state for the Commons hire dispute surface — the on-chain
   * Status enum and the permissionless-refund deadline. Signs nothing, writes nothing.
   * Fails closed ({ok:false}) on any unresolvable id, RPC error, or malformed return.
   */
  async readDisputeState(escrow: EscrowDocument): Promise<EscrowDisputeStateRead> {
    const chain = escrow.chain as ChainName;
    const resolved = await this.resolveContractAndOnchainId(escrow);
    if (!resolved.ok) return { ok: false, reason: resolved.result.reason };
    const { contractAddress, onchainId } = resolved;
    try {
      const status = await readEscrowStatus(chain, contractAddress, onchainId);
      if (status === null) return { ok: false, reason: 'escrows_return_too_short' };
      const deadline = await readDisputeDeadline(chain, contractAddress, onchainId);
      if (deadline === null) return { ok: false, reason: 'dispute_deadline_return_too_short' };
      return { ok: true, onchainId, status, disputeDeadlineSec: deadline };
    } catch (err) {
      return { ok: false, reason: `read_dispute_state_rpc_error: ${(err as Error).message}` };
    }
  }

  /**
   * Observe-path result for an escrow already Resolved on-chain (by Court/admin/a
   * prior run / claimDisputeTimeout). Recovers the ACTUAL direction from the
   * EscrowResolved log so the caller records what the chain paid — NOT its
   * requested direction, which can diverge. Fails closed if the direction cannot
   * be recovered (RPC error or no event found) rather than let the caller record
   * a possibly-wrong direction.
   */
  private async observedResolved(
    chain: ChainName,
    contractAddress: string,
    onchainId: string,
    fromBlock: number,
  ): Promise<EscrowDisputeSettleResult> {
    let dir: { releaseToRecipient: boolean; txHash: string } | null;
    try {
      dir = await recoverResolvedDirection(chain, contractAddress, onchainId, fromBlock);
    } catch {
      dir = null;
    }
    if (dir === null) {
      return { status: 'failed', onchainId, reason: 'resolved_direction_unrecoverable' };
    }
    // who decided it — the Court or the admin / timeout — is read from the same chain. An
    // unreadable answer fails closed: the caller records nothing until it is known.
    let resolvedByCourt: boolean;
    try {
      resolvedByCourt = await resolutionDecidedByCourt(chain, contractAddress, onchainId, dir.txHash);
    } catch {
      return { status: 'failed', onchainId, reason: 'resolved_resolver_unrecoverable' };
    }
    // linked-job settlement: the recovered log's tx hash rides along — it is the settlement
    // receipt anchor for the linked-job advancement (idempotent by tx hash).
    return {
      status: 'already_resolved',
      onchainId,
      txHash: dir.txHash,
      resolvedReleaseToRecipient: dir.releaseToRecipient,
      resolvedByCourt,
    };
  }
}

/**
 * Construct the production gateway. Reads ESCROW_RELEASE_KEY; enforces
 * Gate B at construction. Always returns a gateway (reads work even without
 * a signer); `canSign()` reflects whether the gas-EOA is available.
 */
export function createEscrowChainGateway(): EscrowChainGateway {
  return new RealEscrowChainGateway();
}
