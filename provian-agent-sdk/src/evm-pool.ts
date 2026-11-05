/**
 * Pool withdrawal calldata + address pins (P4-01 SDK leg), built on the slice-1
 * evm-signer. Pure encoders + address resolution, kept separate from CommonsInstitutions so
 * the calldata is byte-exact unit-testable — exactly mirroring evm-escrow.ts.
 *
 * The CONTRIBUTOR's pool exit path:
 *   CommonsInstitutions.withdrawFromPool -> on-chain ProvianPool.withdrawContribution(bytes32)
 *   -> relay record (POST /v1/pools/:id/withdraw with the tx_hash, which the relay
 *   VERIFIES on-chain before deleting the Firestore contribution / emitting the
 *   pool_withdrawn PE).
 *
 * The contract `withdrawContribution(bytes32 poolId)` is `msg.sender`-bound — only
 * the contributor's OWN key can pull their funds while the pool is Open — so unlike
 * the permissionless expiry refund, NO backend keeper can do it. This is the
 * agent-signed half: the contributor broadcasts with its own EOA, then records.
 *
 * SCOPE: the live PoolV3 is on Base (serves USDC + PVT pools). Arbitrum/Optimism
 * fail closed until a pool is deployed + env-wired there.
 */
import { encodeFunctionData, getAddress, type Hex } from 'viem';
import { EvmSignerError } from './evm-signer';
import type { SupportedChain } from './evm-allowlist';
import { resolvePoolAddress } from './contract-addresses';
import { BYTES32_PATTERN } from './evm-escrow';

/**
 * Live capital-pool contract addresses, resolved from the single source of truth
 * in `contract-addresses.ts` (env override → deployment-JSON default) — NOT local
 * literals. Base = the PoolV3 (`0xb355C79a…`, bound to the kernel; it replaced the PoolV3
 * `0x68d557e0…`, and the `0x8C981b15…` is retired); the superseded
 * Pass-3 PoolV3 and the older cascade pool are retired and never resolved.
 * Arbitrum/Optimism are undefined until deployed there.
 */
export const POOL_ADDRESSES: Record<SupportedChain, `0x${string}` | undefined> = {
  base: resolvePoolAddress('base'),
  arbitrum: resolvePoolAddress('arbitrum'),
  optimism: resolvePoolAddress('optimism'),
};

/**
 * Resolve the pool contract address for a chain. Throws an EvmSignerError if the
 * chain is unconfigured — the SDK fails closed rather than broadcast a withdrawal
 * to an unknown target. Returns the canonical checksummed form so equality +
 * allowlist checks match.
 */
export function poolAddressForChain(chain: SupportedChain): `0x${string}` {
  const addr = POOL_ADDRESSES[chain];
  if (!addr) {
    throw new EvmSignerError(
      `Pool contract is not configured for chain '${chain}' (the live capital pool is on Base only this slice)`,
      'POOL_UNCONFIGURED',
    );
  }
  return getAddress(addr);
}

const WITHDRAW_CONTRIBUTION_ABI = [
  {
    type: 'function',
    name: 'withdrawContribution',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [],
  },
] as const;

/**
 * ProvianPool.withdrawContribution(bytes32 poolId) calldata. Pure; exported so
 * callers and tests can assert the exact bytes. `onchainPoolId` is the bytes32 id
 * the creator used at on-chain createPool (the same id the contributor's on-chain
 * `contribute` targeted).
 */
export function encodeWithdrawContribution(onchainPoolId: string): Hex {
  if (!BYTES32_PATTERN.test(onchainPoolId)) {
    throw new EvmSignerError(
      'onchainPoolId must be a 0x-prefixed 32-byte hex string (bytes32)',
      'INVALID_POOL_ID',
    );
  }
  return encodeFunctionData({
    abi: WITHDRAW_CONTRIBUTION_ABI,
    functionName: 'withdrawContribution',
    args: [onchainPoolId.toLowerCase() as Hex],
  });
}
