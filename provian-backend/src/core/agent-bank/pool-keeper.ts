import { CanonicalWallet } from '../onchain/canonical-wallet';
/**
 * Agent Bank - On-chain pool refund keeper (P4-02 closure).
 *
 * A capital pool that expires WITHOUT reaching its threshold must return every
 * contributor's on-chain funds. The on-chain `ProvianPool.refundPool(bytes32)` is
 * PERMISSIONLESS once the pool is Open past its deadline ("Anyone can refund an
 * Open pool past its deadline"), and pushes each contributor's balance back (with
 * a pull-refund fallback for a reverting recipient). Until this module existed,
 * NOTHING in the backend ever called it: the expiry scheduler flipped Firestore
 * status → 'refunded' and emitted a `pool_refunded` PE asserting `refunded_usdc`
 * while the contract kept the funds locked. Pools were the one Agent Bank money
 * state-machine left with an escrowChain/bondKeeper-style keeper — this module is
 * that keeper, so a pool the backend records as 'refunded' corresponds to funds
 * that actually moved on-chain.
 *
 * The keeper EOA is a dedicated, GAS-ONLY key (POOL_KEEPER_KEY) with no
 * minter/admin/treasury/founder role. Gate B (assertPoolKeeperIdentity) refuses to
 * start if it collides with a privileged key — a keeper key with mint or admin
 * authority would be a severe blast-radius escalation. It is intentionally NOT the
 * Provian bootstrap admin wallet (admin==executor==guardian on the live PVTv8 stack): refundPool
 * is permissionless, so the keeper stays unprivileged.
 *
 * Idempotency: refundPool is permissionless, so another caller (or a prior run) may
 * refund the pool between the scheduler's read and our send. We send and, on revert,
 * re-read the on-chain status to classify (already Refunded vs. deadline-not-reached
 * vs. failed). A second call on an already-Refunded pool reverts InvalidStatus → we
 * return `already_refunded`, never erroring the scheduler run.
 */

import { ethers } from 'ethers';
import { getChainProvider, type ChainName } from '../onchain/rpc-provider';
import {
  recoverPoolIdFromContributionTx,
  readOnchainPoolStatus,
  poolRefundedEventMatches,
  POOL_STATUS_OPEN,
  POOL_STATUS_REFUNDED,
} from '../onchain/tx-verifier';
import { resolvePoolContractAddress } from './pools';
import { chainIdForName, assertSupportedAgentBankChain, type AgentBankChain } from './chain-registry';
import type { Currency, PoolDocument, PoolKeeperGateway, PoolRefundResult } from './types';
import { FORBIDDEN_KEEPER_IDENTITIES, keeperForbiddenSignerEntries } from '../config/live-value-recipients';

// Minimal ABI for the keeper's single write. Only `refundPool(bytes32)` is called;
// it is byte-identical across ProvianPoolV2 (USDC) and ProvianPoolV3 (USDC+PVT), so
// the keeper works for either currency's contract. The PoolRefunded events are
// confirmed via the shared tx-verifier helper (single-sourced event ABI).
const POOL_KEEPER_ABI = ['function refundPool(bytes32 poolId) external'] as const;

/**
 * Gate B: refuse to use a keeper key that is the PVT minter, the deployer/treasury,
 * the Foundation Safe, or Provian’s bootstrap admin wallet. Throws (fail-closed at
 * construction) on collision. Mirrors bond-keeper's assertBondKeeperIdentity.
 */
export function assertPoolKeeperIdentity(keeperAddress: string): void {
  const norm = (a: string | undefined): string => (a ?? '').toLowerCase();
  const keeper = norm(keeperAddress);

  const forbidden = new Map<string, string>();

  // PVT minter — authoritative: derive from the live key if present.
  if (process.env.PVT_MINTER_KEY) {
    try {
      forbidden.set(norm(new ethers.Wallet(process.env.PVT_MINTER_KEY).address), 'PVT minter (PVT_MINTER_KEY)');
    } catch {
      /* malformed minter key is a separate problem; the identity guard skips it */
    }
  }
  // Treasury key identity (KEEPER_FORBIDDEN_SIGNER_ADDRESS, or its former name).
  for (const [addr, reason] of keeperForbiddenSignerEntries()) {
    forbidden.set(addr, reason);
  }
  // Foundation Safe.
  if (process.env.FOUNDATION_TREASURY_ADDRESS) {
    forbidden.set(norm(process.env.FOUNDATION_TREASURY_ADDRESS), 'Foundation Safe (FOUNDATION_TREASURY_ADDRESS)');
  }
  // Founder admin EOA (admin==executor==guardian on the live PVTv8 stack).
  // covers BOTH the exposed legacy EOA and the Provian treasury. One env var cannot name
  // two addresses, so KEEPER_FORBIDDEN_SIGNER_ADDRESS alone left whichever one it did not name uncovered.
  for (const [addr, reason] of FORBIDDEN_KEEPER_IDENTITIES) {
    forbidden.set(addr, reason);
  }

  const hit = forbidden.get(keeper);
  if (hit) {
    throw new Error(
      `[pool-keeper] GATE B FAILED: POOL_KEEPER_KEY resolves to ${keeperAddress}, which is the ${hit}. ` +
        'The pool refund keeper EOA must be a dedicated gas-only key with no minter/admin/treasury role. Refusing to start.',
    );
  }
}

class RealPoolKeeperGateway implements PoolKeeperGateway {
  private readonly keeperKey: string | undefined;
  private readonly signerByChain = new Map<ChainName, ethers.Wallet>();

  constructor() {
    this.keeperKey = process.env.POOL_KEEPER_KEY;
    if (this.keeperKey) {
      // Gate B — fail closed at construction if the key has any privileged identity.
      const addr = new ethers.Wallet(this.keeperKey).address;
      assertPoolKeeperIdentity(addr);
      console.log(`[pool-keeper] gas-only refund signer configured: ${addr}`);
    } else {
      console.warn(
        '[pool-keeper] POOL_KEEPER_KEY not set — backend cannot refund expired pools on-chain. ' +
          'Expired under-threshold pools stay status="open" (no refund asserted) until the key is provisioned.',
      );
    }
  }

  canSign(): boolean {
    return !!this.keeperKey;
  }

  private signerFor(chain: ChainName): ethers.Wallet {
    let s = this.signerByChain.get(chain);
    if (!s) {
      s = new CanonicalWallet(this.keeperKey as string, getChainProvider(chain));
      this.signerByChain.set(chain, s);
    }
    return s;
  }

  /**
   * Recover the on-chain bytes32 poolId shared by this pool's contributions AND
   * the set of contributors CONFIRMED on-chain as real contributors of it.
   *
   * Every contribution stored a `tx_hash`; a REAL on-chain `contribute(poolId, …)`
   * emits `PoolContribution(bytes32 indexed poolId, address indexed contributor, …)`,
   * from which we recover the poolId. A Firestore "contribution" that was actually a
   * bare `usdc.transfer(poolContract, …)` — funds moved into the contract but never
   * credited to `contributions[poolId]` / `contributorList` on-chain — has NO
   * PoolContribution event, so its recovery returns null. `refundPool` pays only
   * `contributorList`, so ONLY the contributors whose tx recovers THIS poolId are
   * actually refunded on-chain; those are the ones the caller may truthfully emit a
   * pool_refunded PE for. The first non-null recovery establishes the pool's
   * onchainPoolId. Returns null when NO contribution recovers (caller →
   * `unrecoverable_id`; never refunds a poolId it cannot pin).
   */
  private async recoverPoolIdAndConfirm(
    chainId: number,
    poolContractAddress: string,
    pool: PoolDocument,
  ): Promise<{ onchainPoolId: string; confirmedWalletIds: string[] } | null> {
    const recovered = new Map<string, string | null>();
    let onchainPoolId: string | null = null;
    for (const [walletId, contribution] of Object.entries(pool.contributions)) {
      let poolId: string | null = null;
      if (contribution.tx_hash) {
        poolId = await recoverPoolIdFromContributionTx({
          chainId,
          poolContractAddress,
          txHash: contribution.tx_hash,
          expectedContributor: contribution.address,
        });
      }
      recovered.set(walletId, poolId);
      if (poolId && !onchainPoolId) onchainPoolId = poolId;
    }
    if (!onchainPoolId) return null;
    const confirmedWalletIds: string[] = [];
    for (const [walletId, poolId] of recovered) {
      if (poolId === onchainPoolId) confirmedWalletIds.push(walletId);
    }
    return { onchainPoolId, confirmedWalletIds };
  }

  async refundExpiredPool(pool: PoolDocument): Promise<PoolRefundResult> {
    if (!this.canSign()) return { status: 'unconfigured' };

    if (Object.keys(pool.contributions).length === 0) {
      return { status: 'no_contributors' };
    }

    const currency: Currency = pool.currency ?? 'usdc';
    let chain: AgentBankChain;
    try {
      assertSupportedAgentBankChain(pool.chain);
      chain = pool.chain as AgentBankChain;
    } catch (err) {
      return { status: 'failed', reason: `unsupported_chain: ${(err as Error).message}` };
    }

    let contractAddress: string;
    try {
      contractAddress = resolvePoolContractAddress(currency, chain);
    } catch (err) {
      return { status: 'failed', reason: `pool_contract_unconfigured: ${(err as Error).message}` };
    }

    const chainId = chainIdForName(chain);

    const recovered = await this.recoverPoolIdAndConfirm(chainId, contractAddress, pool);
    if (!recovered) return { status: 'unrecoverable_id' };
    const { onchainPoolId, confirmedWalletIds } = recovered;

    // Read current on-chain status. Refuse to broadcast against a pool that is not
    // Open (Funded reached threshold on-chain; Executed/Cancelled/Refunded are
    // terminal) — the permissionless refund only applies to an Open past-deadline
    // pool. Fail-closed on an unreadable status.
    let status: number | null;
    try {
      status = await readOnchainPoolStatus({ chainId, poolContractAddress: contractAddress, onchainPoolId });
    } catch (err) {
      return { status: 'failed', onchainPoolId, reason: `read_status_rpc_error: ${(err as Error).message}` };
    }
    if (status === null) return { status: 'failed', onchainPoolId, reason: 'pool_status_unreadable' };
    if (status === POOL_STATUS_REFUNDED) {
      return { status: 'already_refunded', onchainPoolId, confirmedContributorWalletIds: confirmedWalletIds };
    }
    if (status !== POOL_STATUS_OPEN) {
      return { status: 'not_refundable', onchainPoolId, reason: `onchain_status_${status}` };
    }

    // Open on-chain. Drive the permissionless refund via the gas-only EOA.
    try {
      const c = new ethers.Contract(contractAddress, POOL_KEEPER_ABI, this.signerFor(chain as ChainName));
      const tx = await c.refundPool(onchainPoolId);
      const receipt = await tx.wait(1);
      if (!receipt || receipt.status !== 1) {
        return { status: 'failed', onchainPoolId, reason: 'refund_tx_reverted' };
      }
      // Confirm off the PoolRefunded/PoolRefundedPVT log — never assert a refund the
      // chain didn't emit.
      if (poolRefundedEventMatches(receipt.logs, contractAddress, onchainPoolId)) {
        return {
          status: 'refunded',
          txHash: receipt.hash ?? tx.hash,
          onchainPoolId,
          confirmedContributorWalletIds: confirmedWalletIds,
        };
      }
      return { status: 'failed', onchainPoolId, reason: 'pool_refunded_event_not_found' };
    } catch (err) {
      // Idempotency: refundPool is permissionless, so a concurrent caller may have
      // refunded it (reverts InvalidStatus), or our deadline calc is ahead of the
      // chain's (reverts DeadlineNotReached). Re-read to classify rather than
      // erroring the scheduler run.
      try {
        const reread = await readOnchainPoolStatus({ chainId, poolContractAddress: contractAddress, onchainPoolId });
        if (reread === POOL_STATUS_REFUNDED) {
          return { status: 'already_refunded', onchainPoolId, confirmedContributorWalletIds: confirmedWalletIds };
        }
        if (reread === POOL_STATUS_OPEN) {
          return { status: 'not_yet_expired', onchainPoolId, reason: `revert_still_open: ${(err as Error).message}` };
        }
      } catch {
        /* fall through to failed */
      }
      return { status: 'failed', onchainPoolId, reason: `refund_failed: ${(err as Error).message}` };
    }
  }
}

/**
 * Construct the production keeper. Reads POOL_KEEPER_KEY; enforces Gate B at
 * construction. Always returns a gateway; `canSign()` reflects whether the gas-EOA
 * is available.
 */
export function createPoolKeeperGateway(): PoolKeeperGateway {
  return new RealPoolKeeperGateway();
}
