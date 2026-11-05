import { CanonicalWallet } from '../onchain/canonical-wallet';
/**
 * Agent Bank - On-chain bond abandonment keeper (Pass-2 WS2 [CONFIG] closure).
 *
 * The on-chain `ProvianBondPool.processAbandonment(address agent)` is
 * PERMISSIONLESS once the abandonment window has elapsed (renewalDeadline +
 * renewalGracePeriod 30d + abandonmentPeriod 365d on the deployed pool = +395d) and burns the entire
 * remaining bond. Until this module existed, NOTHING in the backend ever called
 * it: the WS2 scheduler (#24) correctly refuses to assert a burn the chain has
 * not performed, which left confirmed-eligible bonds sitting indefinitely. This
 * module is the single place that performs the real on-chain burn, so a bond the
 * backend records as 'abandoned' (with a burn PE) corresponds to collateral that
 * actually burned on-chain.
 *
 * The keeper EOA is a dedicated, GAS-ONLY key (BOND_KEEPER_KEY) with no
 * minter/admin/treasury/founder role. Gate B (assertBondKeeperIdentity) refuses
 * to start if it collides with a privileged key — a keeper key with mint or admin
 * authority would be a severe blast-radius escalation. It is intentionally NOT the
 * Provian bootstrap admin wallet (which is admin==executor==guardian on the live PVTv8 stack):
 * processAbandonment needs no privilege, so the keeper stays unprivileged.
 *
 * Idempotency: processAbandonment is permissionless, so another caller (or a
 * prior run) may burn the bond between the scheduler's eligibility read and our
 * send. We do not pre-read; we send and, on revert, re-read the on-chain status
 * to classify (already burned vs. not-yet-eligible vs. failed). A second call on
 * an already-Abandoned bond reverts BondNotActive → we return `already_burned`,
 * never erroring the scheduler run.
 */

import { ethers } from 'ethers';
import { getChainProvider, type ChainName } from '../onchain/rpc-provider';
import { readOnchainBondStatus } from '../onchain/tx-verifier';
import { bondPoolAddressForChain, chainIdForChain } from './bonds';
import { BOND_POOL_ABI } from './types';
import { FORBIDDEN_KEEPER_IDENTITIES, keeperForbiddenSignerEntries } from '../config/live-value-recipients';
import type {
  BondDocument,
  BondClaimDocument,
  BondKeeperGateway,
  BondAbandonmentResult,
  BondClaimExpiryResult,
} from './types';

/**
 * Gate B: refuse to use a keeper key that is the PVT minter, the
 * deployer/treasury, the Foundation Safe, or Provian’s bootstrap admin wallet. Throws
 * (fail-closed at construction) on collision. Mirrors escrow-release's
 * assertReleaseSignerIdentity but with keeper-specific messaging.
 */
export function assertBondKeeperIdentity(keeperAddress: string): void {
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
      `[bond-keeper] GATE B FAILED: BOND_KEEPER_KEY resolves to ${keeperAddress}, which is the ${hit}. ` +
        'The bond abandonment keeper EOA must be a dedicated gas-only key with no minter/admin/treasury role. Refusing to start.',
    );
  }
}

// ProvianBondPool.BondStatus enum: None=0, Active=1, Withdrawn=2, Abandoned=3.
// (readOnchainBondStatus maps these to name strings; we classify the revert path
// by name below.)

class RealBondKeeperGateway implements BondKeeperGateway {
  private readonly keeperKey: string | undefined;
  private readonly signerByChain = new Map<ChainName, ethers.Wallet>();

  constructor() {
    this.keeperKey = process.env.BOND_KEEPER_KEY;
    if (this.keeperKey) {
      // Gate B — fail closed at construction if the key has any privileged identity.
      const addr = new ethers.Wallet(this.keeperKey).address;
      assertBondKeeperIdentity(addr);
      console.log(`[bond-keeper] gas-only abandonment signer configured: ${addr}`);
    } else {
      console.warn(
        '[bond-keeper] BOND_KEEPER_KEY not set — backend cannot burn abandoned bonds on-chain. ' +
          'Eligible bonds stay status="expired" (no burn asserted) until the key is provisioned.',
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

  async processAbandonment(bond: BondDocument): Promise<BondAbandonmentResult> {
    if (!this.canSign()) return { status: 'unconfigured' };

    const bondPoolAddress = bondPoolAddressForChain(bond.chain);
    if (!bondPoolAddress) return { status: 'failed', reason: 'bond_pool_unconfigured' };

    const chain = bond.chain as ChainName;
    const agent = bond.agent_address;

    try {
      const c = new ethers.Contract(bondPoolAddress, BOND_POOL_ABI, this.signerFor(chain));
      const tx = await c.processAbandonment(agent);
      const receipt = await tx.wait(1);
      if (receipt && receipt.status === 1) {
        return { status: 'burned', txHash: receipt.hash ?? tx.hash };
      }
      return { status: 'failed', reason: 'abandonment_tx_reverted' };
    } catch (err) {
      // Idempotency / classification: processAbandonment is permissionless, so a
      // concurrent caller may have burned it (reverts BondNotActive), or the
      // on-chain window isn't reached yet (reverts GracePeriodNotExpired). Re-read
      // the on-chain status to classify rather than erroring the run.
      try {
        const reread = await readOnchainBondStatus({
          chainId: chainIdForChain(bond.chain),
          bondPoolAddress,
          agent,
        });
        if (reread.ok && reread.status === 'abandoned') return { status: 'already_burned' };
        if (reread.ok && reread.status === 'active') {
          return { status: 'not_yet_eligible', reason: `revert_still_active: ${(err as Error).message}` };
        }
        if (reread.ok) return { status: 'not_active', reason: `onchain_status_${reread.status}` };
      } catch {
        /* fall through to failed */
      }
      return { status: 'failed', reason: `abandonment_failed: ${(err as Error).message}` };
    }
  }

  async expireStaleClaim(claim: BondClaimDocument): Promise<BondClaimExpiryResult> {
    if (!this.canSign()) return { status: 'unconfigured' };

    const onchainClaimId = claim.onchain_claim_id;
    if (!onchainClaimId) {
      // Legacy claim never bound to its on-chain bytes32 id → cannot expire on-chain.
      return { status: 'not_found', reason: 'claim has no onchain_claim_id' };
    }

    const bondPoolAddress = bondPoolAddressForChain(claim.chain);
    if (!bondPoolAddress) return { status: 'failed', reason: 'bond_pool_unconfigured' };

    const chain = claim.chain as ChainName;
    const wantClaimId = onchainClaimId.toLowerCase();
    const wantAgent = claim.respondent_address.toLowerCase();
    const iface = new ethers.Interface(BOND_POOL_ABI);

    try {
      const c = new ethers.Contract(bondPoolAddress, BOND_POOL_ABI, this.signerFor(chain));
      const tx = await c.expireStaleClaim(onchainClaimId);
      const receipt = await tx.wait(1);
      if (!receipt || receipt.status !== 1) {
        return { status: 'failed', reason: 'expire_tx_reverted' };
      }

      // Mirror off the ClaimExpired log (same decode pattern as the ClaimDismissed
      // settlement verifier): require the event with a matching claimId + agent
      // before asserting success — never mirror a decrement the chain didn't emit.
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== bondPoolAddress.toLowerCase()) continue;
        let parsed: ethers.LogDescription | null;
        try {
          parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        } catch {
          continue;
        }
        if (parsed?.name !== 'ClaimExpired') continue;
        if (String(parsed.args.claimId).toLowerCase() !== wantClaimId) continue;
        if (String(parsed.args.agent).toLowerCase() !== wantAgent) continue;
        return { status: 'expired', txHash: receipt.hash ?? tx.hash };
      }
      // Mined but no matching ClaimExpired log → fail closed (assert nothing).
      return { status: 'failed', reason: 'claim_expired_event_not_found' };
    } catch (err) {
      // Idempotency: expireStaleClaim is permissionless, so a concurrent caller may
      // have resolved it (reverts ClaimAlreadyResolved), or our 60d Firestore calc is
      // ahead of the chain's filedAt (reverts ClaimNotExpired). Re-read the on-chain
      // claim status to classify rather than erroring the scheduler run.
      try {
        const cc = new ethers.Contract(bondPoolAddress, BOND_POOL_ABI, getChainProvider(chain));
        const onchain = await cc.claims(onchainClaimId);
        // ClaimStatus enum: Filed=0, Upheld=1, Dismissed=2 (ProvianBondPool.sol).
        const status = Number(onchain.status ?? onchain[3]);
        if (status === 2) return { status: 'already_expired', reason: 'onchain_claim_dismissed' };
        if (status === 1) return { status: 'already_slashed', reason: 'onchain_claim_upheld' };
        if (status === 0) {
          return { status: 'not_yet_expired', reason: `revert_still_filed: ${(err as Error).message}` };
        }
      } catch {
        /* fall through to failed */
      }
      return { status: 'failed', reason: `expire_failed: ${(err as Error).message}` };
    }
  }
}

/**
 * Construct the production keeper. Reads BOND_KEEPER_KEY; enforces Gate B at
 * construction. Always returns a gateway; `canSign()` reflects whether the
 * gas-EOA is available.
 */
export function createBondKeeperGateway(): BondKeeperGateway {
  return new RealBondKeeperGateway();
}
