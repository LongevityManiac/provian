import { guardedFetch } from './guarded-fetch';
/**
 * Balance sweep for the VOLUNTARY key rotation (rotateKey).
 *
 * WHY THIS EXISTS. A key rotation cuts the wallet's IDENTITY to a new address
 * (PE chain + wallet_aw id preserved) but does NOT move on-chain funds: the old
 * address keeps whatever PVT/USDC it holds, and once its key is discarded that
 * balance is stranded forever. Two live re-keys three days apart each stranded
 * an agent's earned PVT this way (508 PVT at the lost original address;
 * 26 PVT at the exposed address). The voluntary rotation path — unlike the
 * in-app lost-key recovery-rekey (agentRekey.ts), which never has the old key —
 * HOLDS the old private key, so it CAN sign one last transfer from the retired
 * address to the new one. This module is that transfer.
 *
 * FAIL-CLOSED, NEVER FUND-LOSING. `rotateKeyAndSweep` runs the identity rotation
 * FIRST and only then sweeps. The sweep can never undo or fail the rotation: it
 * catches every on-chain error and returns a structured SweepResult. The one
 * outcome it must never produce is a false "all clear" an unknown balance
 * (RPC read failed) reports `sweep_failed`, never `nothing_to_sweep`. When the
 * retired address cannot pay gas (no ETH — the common pure-earner case that
 * stranded Atlas), it reports `insufficient_gas` with the exact stranded amount
 * so the operator can fund a little ETH and retry `sweepErc20ToNewKey` rather
 * than silently losing the balance.
 *
 * KEY HANDLING — key-per-call, like evm-signer.ts / x402-signer.ts. The raw old
 * key is a parameter and is never retained. The actual transfer is delegated to
 * evm-signer's `transferToken` (the same allowlist-guarded broadcast path), so
 * only an allowlisted token (PVT/USDC/USDT) can move and only to the new address.
 */
import {
  createPublicClient,
  http,
  getAddress,
  isAddress,
  type Transport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { transferToken, type PEReporter } from './evm-signer';
import {
  getToken,
  isSupportedChain,
  VIEM_CHAINS,
  type SupportedChain,
  type AllowlistedToken,
} from './evm-allowlist';
import { rotateKey, type RotateKeyConfig, type RotateKeyResult } from './wallet';
import { EvmSignerError } from './evm-signer';

/** A public Base RPC used when the caller supplies neither transport nor rpcUrl. */
const DEFAULT_BASE_RPC_URL = 'https://mainnet.base.org';

const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export interface SweepErc20Params {
  /** The retired address's key — used to sign the outbound transfer. Never retained. */
  oldPrivateKey: string;
  /** Destination (the newly-rotated address). Checksummed or lowercase. */
  newAddress: string;
  /** Allowlisted token to sweep. Default 'PVT'. */
  token?: AllowlistedToken;
  /** Chain. Default 'base'. */
  chain?: SupportedChain;
  /** JSON-RPC URL. Defaults to a public Base RPC unless `transport` is supplied. */
  rpcUrl?: string;
  /** Pre-built viem transport (tests inject a mock; overrides rpcUrl). */
  transport?: Transport;
  /** Best-effort PE reporter forwarded to the underlying transfer. */
  reportPE?: PEReporter;
  /** Fee/nonce overrides forwarded to the transfer (advanced callers / tests). */
  nonce?: number;
  gas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export type SweepResult =
  | {
      swept: true;
      token: AllowlistedToken;
      chain: SupportedChain;
      oldAddress: string;
      newAddress: string;
      /** Transferred balance in atomic units, as a decimal string. */
      amountAtomic: string;
      /** eth_sendRawTransaction hash of the sweep transfer. */
      hash: string;
    }
  | {
      swept: false;
      reason: 'nothing_to_sweep';
      token: AllowlistedToken;
      chain: SupportedChain;
      oldAddress: string;
    }
  | {
      swept: false;
      reason: 'insufficient_gas';
      token: AllowlistedToken;
      chain: SupportedChain;
      oldAddress: string;
      /** The balance left behind because the address cannot pay gas. */
      strandedAtomic: string;
      /** The address's native (ETH) balance in wei, as a decimal string. */
      nativeWei: string;
    }
  | {
      swept: false;
      reason: 'sweep_failed';
      token: AllowlistedToken;
      chain: SupportedChain;
      oldAddress: string;
      /** Balance that MAY remain (unknown/failed read is reported, never hidden). */
      strandedAtomic: string | 'unknown';
      /** One-line failure reason (RPC error / revert / bad params). */
      error: string;
    };

function resolveTransport(params: SweepErc20Params): Transport {
  if (params.transport) return params.transport;
  return http(params.rpcUrl ?? DEFAULT_BASE_RPC_URL, { fetchFn: guardedFetch });
}

/** Whether a caught error looks like the node refusing the tx for lack of gas funds. */
function looksLikeInsufficientFunds(message: string): boolean {
  return /insufficient funds|gas required exceeds|max fee per gas less than|not enough funds/i.test(
    message,
  );
}

/**
 * Sweep the full balance of one allowlisted token from the retired (old-key)
 * address to the new address. Fail-closed: returns a SweepResult for every
 * outcome and never throws for an on-chain condition — so a caller that has
 * ALREADY rotated the identity cannot have the rotation undone by a sweep error.
 *
 * Order of decisions:
 *   1. read the token balance at the old address — a failed read is `sweep_failed`
 *      with `strandedAtomic:'unknown'` (never a false `nothing_to_sweep`);
 *   2. zero balance → `nothing_to_sweep`;
 *   3. the old address has zero native ETH → `insufficient_gas` (it cannot pay to
 *      move anything; the balance is reported as stranded, not lost);
 *   4. otherwise sign `transfer(newAddress, fullBalance)` with the OLD key and
 *      wait for the receipt — a revert or a late insufficient-funds error is
 *      caught and classified rather than mistaken for success.
 */
export async function sweepErc20ToNewKey(params: SweepErc20Params): Promise<SweepResult> {
  const token: AllowlistedToken = params.token ?? 'PVT';
  const chain: SupportedChain = params.chain ?? 'base';

  if (!isSupportedChain(chain)) {
    return {
      swept: false,
      reason: 'sweep_failed',
      token,
      chain,
      oldAddress: '',
      strandedAtomic: 'unknown',
      error: `unsupported chain: ${String(chain)}`,
    };
  }
  if (!isAddress(params.newAddress, { strict: false })) {
    return {
      swept: false,
      reason: 'sweep_failed',
      token,
      chain,
      oldAddress: '',
      strandedAtomic: 'unknown',
      error: `invalid destination address: ${params.newAddress}`,
    };
  }

  // Derive the old address from its key (same derivation the signer validates against).
  let oldAddress: string;
  try {
    oldAddress = getAddress(
      privateKeyToAccount(
        (params.oldPrivateKey.startsWith('0x')
          ? params.oldPrivateKey
          : `0x${params.oldPrivateKey}`) as `0x${string}`,
      ).address,
    );
  } catch (err) {
    return {
      swept: false,
      reason: 'sweep_failed',
      token,
      chain,
      oldAddress: '',
      strandedAtomic: 'unknown',
      error: `old key is not a valid secp256k1 private key: ${(err as Error).message}`,
    };
  }

  const tokenInfo = getToken(chain, token);
  const transport = resolveTransport(params);
  const publicClient = createPublicClient({ chain: VIEM_CHAINS[chain], transport });

  // 1. Token balance at the old address. A FAILED read is reported as
  //    sweep_failed/unknown — never a false "nothing to sweep".
  let balance: bigint;
  try {
    balance = (await publicClient.readContract({
      address: tokenInfo.address,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [oldAddress as `0x${string}`],
    })) as bigint;
  } catch (err) {
    return {
      swept: false,
      reason: 'sweep_failed',
      token,
      chain,
      oldAddress,
      strandedAtomic: 'unknown',
      error: `could not read ${token} balance at ${oldAddress}: ${(err as Error).message}`,
    };
  }

  // 2. Nothing there.
  if (balance <= 0n) {
    return { swept: false, reason: 'nothing_to_sweep', token, chain, oldAddress };
  }

  // 3. Gas feasibility. A pure-earner address holds PVT but no ETH; without gas
  //    it cannot move anything. Report the exact stranded amount so the operator
  //    can fund a little ETH and retry — do NOT attempt a doomed broadcast.
  let nativeWei: bigint;
  try {
    nativeWei = await publicClient.getBalance({ address: oldAddress as `0x${string}` });
  } catch (err) {
    return {
      swept: false,
      reason: 'sweep_failed',
      token,
      chain,
      oldAddress,
      strandedAtomic: balance.toString(),
      error: `could not read native balance at ${oldAddress}: ${(err as Error).message}`,
    };
  }
  if (nativeWei <= 0n) {
    return {
      swept: false,
      reason: 'insufficient_gas',
      token,
      chain,
      oldAddress,
      strandedAtomic: balance.toString(),
      nativeWei: nativeWei.toString(),
    };
  }

  // 4. Sign the transfer with the OLD key and WAIT for the receipt so a revert or
  //    a late insufficient-funds error is caught and classified, not counted as a
  //    success. The transfer rides evm-signer's allowlist-guarded path.
  try {
    const result = await transferToken(
      { privateKeyHex: params.oldPrivateKey, address: oldAddress },
      {
        token,
        to: getAddress(params.newAddress),
        amount: balance,
        chain,
        transport: params.transport,
        rpcUrl: params.transport ? undefined : (params.rpcUrl ?? DEFAULT_BASE_RPC_URL),
        reportPE: params.reportPE,
        waitForReceipt: true,
        ...(params.nonce !== undefined ? { nonce: params.nonce } : {}),
        ...(params.gas !== undefined ? { gas: params.gas } : {}),
        ...(params.maxFeePerGas !== undefined ? { maxFeePerGas: params.maxFeePerGas } : {}),
        ...(params.maxPriorityFeePerGas !== undefined
          ? { maxPriorityFeePerGas: params.maxPriorityFeePerGas }
          : {}),
      },
    );
    return {
      swept: true,
      token,
      chain,
      oldAddress,
      newAddress: getAddress(params.newAddress),
      amountAtomic: balance.toString(),
      hash: result.hash,
    };
  } catch (err) {
    const message = err instanceof EvmSignerError ? err.message : (err as Error).message;
    // A late insufficient-funds error (dust ETH < gas) is still a gas problem.
    if (looksLikeInsufficientFunds(message)) {
      return {
        swept: false,
        reason: 'insufficient_gas',
        token,
        chain,
        oldAddress,
        strandedAtomic: balance.toString(),
        nativeWei: nativeWei.toString(),
      };
    }
    return {
      swept: false,
      reason: 'sweep_failed',
      token,
      chain,
      oldAddress,
      strandedAtomic: balance.toString(),
      error: message,
    };
  }
}

export interface RotateKeyAndSweepResult extends RotateKeyResult {
  /** The outcome of sweeping the retired address's balance into the new one. */
  sweep: SweepResult;
}

export interface RotateKeyAndSweepOptions {
  /** Token to sweep. Default 'PVT' (the earned asset). */
  token?: AllowlistedToken;
  /** Chain. Default 'base' (where PVT lives). */
  chain?: SupportedChain;
  /** JSON-RPC URL for the sweep (defaults to a public Base RPC). */
  rpcUrl?: string;
  /** Pre-built viem transport (tests inject a mock; overrides rpcUrl). */
  transport?: Transport;
  /** Best-effort PE reporter for the sweep transfer. */
  reportPE?: PEReporter;
}

/**
 * Rotate the wallet key AND sweep the retired address's balance into the new one,
 * in that order. The rotation runs first and is authoritative — a sweep failure
 * NEVER undoes it (the sweep is fail-closed to a SweepResult). This is the
 * recommended entry for a VOLUNTARY rotation, because it is the only re-key path
 * that holds the old key and can therefore recover the earned balance instead of
 * stranding it. The result always carries both the rotation credentials and the
 * `sweep` outcome; inspect `sweep` and, on `insufficient_gas`, fund the old
 * address and retry `sweepErc20ToNewKey` rather than discarding the old key.
 */
export async function rotateKeyAndSweep(
  config: RotateKeyConfig,
  options: RotateKeyAndSweepOptions = {},
): Promise<RotateKeyAndSweepResult> {
  const rotation = await rotateKey(config);
  const sweep = await sweepErc20ToNewKey({
    oldPrivateKey: config.oldPrivateKey,
    newAddress: rotation.newAddress,
    token: options.token ?? 'PVT',
    chain: options.chain ?? 'base',
    rpcUrl: options.rpcUrl,
    transport: options.transport,
    reportPE: options.reportPE,
  });
  return { ...rotation, sweep };
}
