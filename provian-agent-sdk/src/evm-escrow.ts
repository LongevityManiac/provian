import { guardedFetch } from './guarded-fetch';
/**
 * Escrow release calldata + helpers (WS1-SDK), built on the slice-1 evm-signer.
 * Pure encoders + address pins, kept separate from CommonsInstitutions so the calldata is
 * byte-exact unit-testable - exactly mirroring evm-bond.ts.
 *
 * The DEPOSITOR's immediate (pre-timeout) release path:
 * CommonsInstitutions.releaseEscrow -> on-chain ProvianEscrow.releaseEscrow(bytes32) ->
 * relay record (POST /v1/escrow/:id/complete, which now observes the on-chain
 * Completed status before flipping Firestore to 'completed').
 *
 * The contract `releaseEscrow(bytes32 escrowId)` is depositor-only before
 * autoReleaseAt and permissionless after; the backend's gas-only EOA handles the
 * post-timeout auto-release, so this SDK path is for the DEPOSITOR releasing
 * immediately with its OWN key.
 *
 * SCOPE: USDC-principal escrows are configured on Base/Arbitrum/Optimism.
 * PVT-principal escrows are BASE-ONLY (B15,): the institution deployment EscrowV4 serves
 * both currencies there; currency:'pvt' fails closed on Arbitrum/Optimism.
 */
import { createPublicClient, encodeAbiParameters, encodeFunctionData, getAddress, http, keccak256, type Hex, type Transport } from 'viem';
import { EvmSignerError } from './evm-signer';
import { VIEM_CHAINS, type SupportedChain } from './evm-allowlist';
import { BASE_PVT9_ADDRESSES, resolveEscrowUsdcAddress } from './contract-addresses';

/** Currencies an escrow's principal can be denominated in. */
export type EscrowCurrency = 'usdc' | 'pvt';

/**
 * Live USDC-principal escrow contract addresses, resolved from the single source
 * of truth in `contract-addresses.ts` (env override → deployment-JSON default) —
 * NOT local literals. Base = the EscrowV4 (`0x96560fDF…`; the `0xc7380927…` is retired),
 * sourced from `base-pvt9-institutions.json`; the retired escrow
 * (`0x15Ec2365…`) and the older PVTv8-cascade escrow (`0x10e3BdE9…`) are retired
 * and never resolved. Arbitrum / Optimism keep their Chunk-II EscrowV4
 * (`{chain}-chunk-ii.json`), the same address on both via deployer-nonce alignment.
 */
export const ESCROW_USDC_ADDRESSES: Record<SupportedChain, `0x${string}` | undefined> = {
  base: resolveEscrowUsdcAddress('base'),
  arbitrum: resolveEscrowUsdcAddress('arbitrum'),
  optimism: resolveEscrowUsdcAddress('optimism'),
};

/**
 * PVT-principal escrow contract addresses (B15, the O12 unlock).
 *
 * The prior all-undefined table (and its "not deployed yet" throw) went stale
 * when 4b/4d enabled PVT principal on the backend: the institution deployment
 * `ProvianEscrowV4` on Base serves BOTH currencies (`currency:'pvt'` escrows
 * bind the successor PVT9 kernel — boot banner `[PvtPrincipal] ENABLED
 * chains=base(8453)`). Base therefore resolves to the SAME institution deployment escrow the
 * USDC table uses. Arbitrum/Optimism stay undefined — PVT principal is
 * Base-only by the backend's own config, and the SDK fails closed elsewhere
 * (the Bond convention).
 */
export const ESCROW_PVT_ADDRESSES: Record<SupportedChain, `0x${string}` | undefined> = {
  base: BASE_PVT9_ADDRESSES.escrow,
  arbitrum: undefined,
  optimism: undefined,
};

/**
 * Resolve the escrow contract address for a (currency, chain) pair. Throws an
 * EvmSignerError if the chain/currency is unconfigured - the SDK fails closed
 * rather than broadcast a release to an unknown target.
 */
export function escrowAddressForChain(currency: EscrowCurrency, chain: SupportedChain): `0x${string}` {
  const table = currency === 'pvt' ? ESCROW_PVT_ADDRESSES : ESCROW_USDC_ADDRESSES;
  const addr = table[chain];
  if (!addr) {
    if (currency === 'pvt') {
      throw new EvmSignerError(
        `PVT escrow not configured for chain ${chain} (PVT principal is Base-only; use chain 'base' or currency 'usdc')`,
        'ESCROW_UNCONFIGURED',
      );
    }
    throw new EvmSignerError(
      `${currency.toUpperCase()} escrow is not configured for chain '${chain}'`,
      'ESCROW_UNCONFIGURED',
    );
  }
  // Return the canonical checksummed form so equality + allowlist checks match.
  return getAddress(addr);
}

const RELEASE_ESCROW_ABI = [
  {
    type: 'function',
    name: 'releaseEscrow',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'escrowId', type: 'bytes32' }],
    outputs: [],
  },
] as const;

/** Matches a 0x-prefixed 32-byte (bytes32) hex string. */
export const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * ProvianEscrow.releaseEscrow(bytes32 escrowId) calldata (selector 0x... for
 * `releaseEscrow(bytes32)`). Pure; exported so callers and tests can assert the
 * exact bytes. `onchainEscrowId` is the bytes32 id the depositor used at
 * on-chain createEscrow.
 */
export function encodeReleaseEscrow(onchainEscrowId: string): Hex {
  if (!BYTES32_PATTERN.test(onchainEscrowId)) {
    throw new EvmSignerError(
      'onchainEscrowId must be a 0x-prefixed 32-byte hex string (bytes32)',
      'INVALID_ESCROW_ID',
    );
  }
  return encodeFunctionData({
    abi: RELEASE_ESCROW_ABI,
    functionName: 'releaseEscrow',
    args: [onchainEscrowId.toLowerCase() as Hex],
  });
}

// ---------------------------------------------------------------------------
// the Commons hire escrow legs a DEPOSITOR (the job poster) signs with
// its OWN key on ProvianEscrowV4: createEscrow → approve → fundEscrow to fund,
// releaseEscrow to pay (above), disputeEscrow to raise the dispute fallback, and
// the permissionless claimDisputeTimeout once the 30-day dispute window lapses.
// Pure encoders, byte-exact testable; CommonsInstitutions drives the broadcast + relay record.
// ---------------------------------------------------------------------------

/** ProvianEscrowV4 `Currency` enum: USDC = 0, PVT = 1 (the on-chain uint8). */
export const ESCROW_CURRENCY_ENUM: Readonly<Record<EscrowCurrency, 0 | 1>> = { usdc: 0, pvt: 1 };

/** Atomic decimals per escrow currency (USDC 6, PVT 18). */
export const ESCROW_CURRENCY_DECIMALS: Readonly<Record<EscrowCurrency, number>> = { usdc: 6, pvt: 18 };

const ESCROW_V4_HIRE_ABI = [
  {
    type: 'function',
    name: 'createEscrow',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'escrowId', type: 'bytes32' },
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'autoReleaseAt', type: 'uint256' },
      { name: 'currencyType', type: 'uint8' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'fundEscrow',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'escrowId', type: 'bytes32' },
      { name: 'payFeeInPVT', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'disputeEscrow',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'escrowId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'claimDisputeTimeout',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'escrowId', type: 'bytes32' }],
    outputs: [],
  },
] as const;

function assertBytes32(onchainEscrowId: string): Hex {
  if (!BYTES32_PATTERN.test(onchainEscrowId)) {
    throw new EvmSignerError(
      'onchainEscrowId must be a 0x-prefixed 32-byte hex string (bytes32)',
      'INVALID_ESCROW_ID',
    );
  }
  return onchainEscrowId.toLowerCase() as Hex;
}

/**
 * ProvianEscrowV4.createEscrow(bytes32, address, uint256, uint256, uint8) calldata.
 * `autoReleaseAtSec` is UNIX SECONDS (the relay hands milliseconds; convert with
 * floor(ms/1000) so the on-chain value never exceeds the relay's agreed deadline).
 */
export function encodeCreateEscrow(params: {
  onchainEscrowId: string;
  recipient: string;
  amountAtomic: bigint;
  autoReleaseAtSec: bigint;
  currency: EscrowCurrency;
}): Hex {
  const id = assertBytes32(params.onchainEscrowId);
  if (params.amountAtomic <= 0n) {
    throw new EvmSignerError('escrow amount must be greater than zero', 'INVALID_AMOUNT');
  }
  if (params.autoReleaseAtSec <= 0n) {
    throw new EvmSignerError('autoReleaseAt must be a positive unix-seconds timestamp', 'INVALID_DEADLINE');
  }
  if (params.currency !== 'usdc' && params.currency !== 'pvt') {
    throw new EvmSignerError(`unsupported escrow currency: ${String(params.currency)}`, 'INVALID_CURRENCY');
  }
  return encodeFunctionData({
    abi: ESCROW_V4_HIRE_ABI,
    functionName: 'createEscrow',
    args: [
      id,
      getAddress(params.recipient),
      params.amountAtomic,
      params.autoReleaseAtSec,
      ESCROW_CURRENCY_ENUM[params.currency],
    ],
  });
}

/**
 * ProvianEscrowV4.fundEscrow(bytes32, bool) calldata. `payFeeInPVT` is ALWAYS false:
 * the contract refuses the retired USDC discount and a PVT-principal escrow burns its
 * fee intrinsically, so `true` would only ever revert.
 */
export function encodeFundEscrow(onchainEscrowId: string): Hex {
  return encodeFunctionData({
    abi: ESCROW_V4_HIRE_ABI,
    functionName: 'fundEscrow',
    args: [assertBytes32(onchainEscrowId), false],
  });
}

/** ProvianEscrowV4.disputeEscrow(bytes32) calldata (depositor-only, Funded, before autoReleaseAt). */
export function encodeDisputeEscrow(onchainEscrowId: string): Hex {
  return encodeFunctionData({
    abi: ESCROW_V4_HIRE_ABI,
    functionName: 'disputeEscrow',
    args: [assertBytes32(onchainEscrowId)],
  });
}

/** ProvianEscrowV4.claimDisputeTimeout(bytes32) calldata (permissionless; refunds the depositor after the dispute deadline). */
export function encodeClaimDisputeTimeout(onchainEscrowId: string): Hex {
  return encodeFunctionData({
    abi: ESCROW_V4_HIRE_ABI,
    functionName: 'claimDisputeTimeout',
    args: [assertBytes32(onchainEscrowId)],
  });
}

/**
 * USD float → USDC atomic units (6 decimals). Byte-identical to the relay's
 * `usdcToAtomic` (provian-backend/src/core/onchain/tx-verifier.ts), which the
 * funding verifier uses to pick the matching EscrowFunded event — so the amount the
 * depositor escrows can never disagree with the amount the relay expects.
 */
export function usdcToAtomic(amountUsdc: number): bigint {
  if (typeof amountUsdc !== 'number' || !Number.isFinite(amountUsdc) || amountUsdc < 0) {
    throw new EvmSignerError('USDC amount must be a non-negative finite number', 'INVALID_AMOUNT');
  }
  const fixed = amountUsdc.toFixed(6);
  const [whole, frac = ''] = fixed.split('.');
  const padded = (frac + '0'.repeat(6)).slice(0, 6);
  return BigInt(whole) * 10n ** 6n + BigInt(padded);
}

/** ProvianEscrowV4 `escrows(bytes32)` — the public struct getter (Status: 0 Created, 1 Funded, …). */
const ESCROW_V4_READ_ABI = [
  {
    type: 'function',
    name: 'escrows',
    stateMutability: 'view',
    inputs: [{ name: 'escrowId', type: 'bytes32' }],
    outputs: [
      { name: 'depositor', type: 'address' },
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'fee', type: 'uint256' },
      { name: 'autoReleaseAt', type: 'uint256' },
      { name: 'status', type: 'uint8' },
      { name: 'currency', type: 'uint8' },
      { name: 'feePaidInPVT', type: 'bool' },
    ],
  },
] as const;

export interface OnchainHireEscrow {
  depositor: `0x${string}`;
  recipient: `0x${string}`;
  amount: bigint;
  autoReleaseAt: bigint;
  status: number;
  currency: number;
}

/** Read one ProvianEscrowV4 escrow struct (a never-created id reads as the zero struct). */
export async function readOnchainHireEscrow(opts: {
  chain: SupportedChain;
  escrowAddress: string;
  onchainEscrowId: string;
  transport?: Transport;
  rpcUrl?: string;
}): Promise<OnchainHireEscrow> {
  const transport = opts.transport ?? (opts.rpcUrl ? http(opts.rpcUrl, { fetchFn: guardedFetch }) : undefined);
  if (!transport) throw new EvmSignerError('rpcUrl or transport is required to read an escrow', 'NO_TRANSPORT');
  const client = createPublicClient({ chain: VIEM_CHAINS[opts.chain], transport });
  const [depositor, recipient, amount, , autoReleaseAt, status, currency] = await client.readContract({
    address: getAddress(opts.escrowAddress),
    abi: ESCROW_V4_READ_ABI,
    functionName: 'escrows',
    args: [assertBytes32(opts.onchainEscrowId)],
  });
  return { depositor, recipient, amount, autoReleaseAt, status: Number(status), currency: Number(currency) };
}

/**
 * The on-chain escrow id for a Commons hire: keccak256(abi.encode("provian.commons.hire-escrow.v1",
 * depositor, relayEscrowId)). Deterministic per (depositor, hire), so every funding attempt for one
 * hire targets ONE on-chain escrow and the contract's EscrowAlreadyExists refuses a second.
 */
export function deriveHireOnchainEscrowId(depositor: string, relayEscrowId: string): Hex {
  if (typeof relayEscrowId !== 'string' || relayEscrowId.length === 0) {
    throw new EvmSignerError('relay escrow id is required to derive the on-chain escrow id', 'INVALID_ESCROW_ID');
  }
  return keccak256(encodeAbiParameters(
    [{ type: 'string' }, { type: 'address' }, { type: 'string' }],
    ['provian.commons.hire-escrow.v1', getAddress(depositor), relayEscrowId],
  ));
}

/** A fresh random bytes32 escrow id (the contract reverts a reused id, so each attempt draws a new one). */
export function randomOnchainEscrowId(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}` as Hex;
}
