import { guardedFetch } from './guarded-fetch';
/**
 * Bond origination calldata + helpers (slice 2), built on the slice-1
 * evm-signer. Pure encoders + address pins + the deposit gross-up math, kept
 * separate from CommonsInstitutions so the calldata is byte-exact unit-testable.
 *
 * The on-chain flow (orchestrated by CommonsInstitutions.postBond/renewBond/topUpBond):
 * postBond = approve(BondPool, totalDeposit) on PVT -> BondPool.postBond(level, discountBps)
 * renewBond = BondPool.renewBond() (no approve; cost deducted from locked bond)
 * topUpBond = approve(BondPool, amount) on PVT -> BondPool.topUpBond(amount)
 * (bond lifecycle shortfall restore: NO burn, NO fee — 100% becomes slashable
 * collateral, bounded on-chain by the level's undiscounted base lock)
 *
 * SLICE-2 SCOPE: Base only - the chain whose BondPool is bound to the live PVT9
 * successor kernel on-chain (; its protocolBurn authority derives from that
 * kernel, so it will not revert). Arbitrum/Optimism BondPools exist but were not
 * precondition-checked here.
 */
import { encodeFunctionData, createPublicClient, http, type Hex, type Transport } from 'viem';
import { EvmSignerError } from './evm-signer';
import { VIEM_CHAINS, type SupportedChain } from './evm-allowlist';
import { resolveBondPoolAddress } from './contract-addresses';

/**
 * Live BondPool addresses, resolved from the single source of truth in
 * `contract-addresses.ts` (env override → `base-pvt9-institutions.json` default)
 * NOT a local literal. Base = the BondPool (`0x6b09E9C7…`; the `0xC7D699da…` is retired),
 * bound to the PVT9 successor kernel on-chain; the retired BondPool
 * (`0x6150Bc53…`) and the older PVTv8-cascade BondPool (`0x2BDa41B6…`) are retired
 * and never resolved.
 */
// resolved on first ACCESS, never at import — an eager resolve read the
// deployment artifact at module load and crashed the bootstrap bundle (which the
// act verbs now pull this module into) on every box without that file.
export const BOND_POOL_ADDRESSES: Partial<Record<SupportedChain, `0x${string}`>> = Object.defineProperty(
  {} as Partial<Record<SupportedChain, `0x${string}`>>,
  'base',
  { enumerable: true, get: () => resolveBondPoolAddress('base') },
);

export function bondPoolAddressForChain(chain: SupportedChain): `0x${string}` {
  const addr = resolveBondPoolAddress(chain);
  if (!addr) {
    throw new EvmSignerError(
      `BondPool is not configured for chain '${chain}' in this SDK slice (Base only). ` +
        `Arb/Op bonds require their own on-chain protocol-contract precondition check first.`,
      'BOND_POOL_UNCONFIGURED',
    );
  }
  return addr;
}

const ERC20_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

const POST_BOND_ABI = [
  {
    type: 'function',
    name: 'postBond',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'autonomyLevel', type: 'uint8' },
      { name: 'trustDiscountBps', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const RENEW_BOND_ABI = [
  { type: 'function', name: 'renewBond', stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const;

const TOP_UP_BOND_ABI = [
  {
    type: 'function',
    name: 'topUpBond',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
] as const;

/** ERC-20 approve(spender, amount) calldata (selector 0x095ea7b3). */
export function encodeApprove(spender: string, amount: bigint): Hex {
  if (amount < 0n) throw new EvmSignerError('approve amount must be non-negative', 'INVALID_AMOUNT');
  return encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args: [spender as `0x${string}`, amount] });
}

/** BondPool.postBond(uint8 autonomyLevel, uint256 trustDiscountBps) calldata. */
export function encodePostBond(autonomyLevel: 2 | 3, trustDiscountBps: number): Hex {
  if (autonomyLevel !== 2 && autonomyLevel !== 3) {
    throw new EvmSignerError('autonomyLevel must be 2 or 3', 'INVALID_AUTONOMY_LEVEL');
  }
  if (!Number.isInteger(trustDiscountBps) || trustDiscountBps < 0 || trustDiscountBps > 5000) {
    throw new EvmSignerError('trustDiscountBps must be an integer in 0..5000', 'INVALID_TRUST_DISCOUNT');
  }
  return encodeFunctionData({
    abi: POST_BOND_ABI,
    functionName: 'postBond',
    args: [autonomyLevel, BigInt(trustDiscountBps)],
  });
}

/** BondPool.renewBond() calldata (no args). */
export function encodeRenewBond(): Hex {
  return encodeFunctionData({ abi: RENEW_BOND_ABI, functionName: 'renewBond', args: [] });
}

/**
 * BondPool.topUpBond(uint256 amount) calldata. `amount` is atomic PVT;
 * 100% of it becomes slashable collateral (no burn/fee gross-up needed —
 * unlike postBond, approve exactly `amount`).
 */
export function encodeTopUpBond(amountWei: bigint): Hex {
  if (amountWei <= 0n) throw new EvmSignerError('top-up amount must be positive', 'INVALID_AMOUNT');
  return encodeFunctionData({ abi: TOP_UP_BOND_ABI, functionName: 'topUpBond', args: [amountWei] });
}

/**
 * Gross up a locked-bond amount to the deposit the agent must approve/transfer:
 * 2% burn + 1% fee leave 97% locked, so deposit = ceil(requiredBond * 10000 / 9700).
 * Mirrors ProvianBondPool.postBond exactly. Rounding UP guarantees the approve
 * covers the contract's independently-derived totalDeposit.
 */
export function grossUpTotalDeposit(requiredBondWei: bigint): bigint {
  if (requiredBondWei < 0n) throw new EvmSignerError('requiredBondWei must be non-negative', 'INVALID_AMOUNT');
  return (requiredBondWei * 10000n + 9699n) / 9700n;
}

/**
 * Required bond in atomic units from a whole-PVT base and a discount, rounded
 * UP (the contract floors), so the approve never under-covers.
 * requiredBondWei = ceil(basePvt * 1e18 * (10000 - discount) / 10000).
 */
export function requiredBondWei(basePvtWhole: number, trustDiscountBps: number): bigint {
  const baseWei = BigInt(basePvtWhole) * 10n ** 18n;
  const capped = BigInt(Math.min(Math.max(Math.trunc(trustDiscountBps), 0), 5000));
  return (baseWei * (10000n - capped) + 9999n) / 10000n;
}

/**
 * Wait for a broadcast tx to confirm (used between approve and postBond) and
 * return its MINED status. A tx can mine and still REVERT (viem resolves the
 * receipt normally for a reverted-but-mined tx); callers MUST inspect the
 * returned status - e.g. a reverted approve means the allowance was never set,
 * so broadcasting postBond next would be a guaranteed transferFrom revert
 * (audit Pass-3 #20). Returns 'success' | 'reverted'.
 */
export async function waitForReceipt(opts: {
  chain: SupportedChain;
  hash: Hex;
  transport?: Transport;
  rpcUrl?: string;
  confirmations?: number;
}): Promise<'success' | 'reverted'> {
  const transport = opts.transport ?? (opts.rpcUrl ? http(opts.rpcUrl, { fetchFn: guardedFetch }) : undefined);
  if (!transport) {
    throw new EvmSignerError('rpcUrl or transport is required to wait for a receipt', 'NO_TRANSPORT');
  }
  const client = createPublicClient({ chain: VIEM_CHAINS[opts.chain], transport });
  const receipt = await client.waitForTransactionReceipt({ hash: opts.hash, confirmations: opts.confirmations ?? 1 });
  return receipt.status;
}
