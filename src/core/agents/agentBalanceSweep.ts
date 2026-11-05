import { ActionWallet } from '../security/ActionWallet';
import { assertBiometricAction, type BiometricAction } from '../security/biometricAction';
/**
 * agentBalanceSweep — move a re-keyed agent's earned PVT from its RETIRED address
 * to the fresh one, from inside the app (the in-app rekey path).
 *
 * WHY THIS EXISTS. A re-key cuts the agent's IDENTITY to a new address but does
 * NOT move on-chain funds; the retired address keeps its PVT and, once the old key
 * is discarded, that balance is stranded forever (stranded 508 PVT,
 * 26.47 PVT). The in-app rekey (agentRekey.ts) normally never HOLDS the old key —
 * but when the old key was escrowed to THIS phone, it can be recovered and used to
 * sign one last transfer to the new address. This module is that transfer, app-side
 * (ethers v6, mirroring the SDK's sweep.ts semantics).
 *
 * GAS. A pure-earner address holds PVT but no ETH, so it cannot pay to move
 * anything. the standing rule: the in-app path PRE-FUNDS the gas from the human's OWN
 * Base wallet (biometric-gated, via TransactionService.sendETH), but only after the
 * human confirms. Without a confirm callback, or if the human skips, the balance is
 * reported as stranded (exact amount + address) — never silently lost.
 *
 * FAIL-CLOSED, NEVER FUND-LOSING. The rekey identity cut has ALREADY succeeded by
 * the time this runs and must stand; a sweep failure can never undo it. So every
 * on-chain error is caught and returned as a structured AgentSweepResult — the one
 * outcome it must never produce is a false "all clear" an unknown balance (a read
 * that failed) is `sweep_failed`, never `nothing_to_sweep`.
 *
 * KEY HANDLING. The recovered old key is a parameter, confined to this call, and is
 * never returned to the screen. Only PVT9, only to the new address.
 */

import { ethers } from 'ethers';

/** PVT is an 18-decimal ERC-20 on Base. */
const PVT_DECIMALS = 18;
const BASE_CHAIN_ID = 8453;
/** Send 2× the estimated gas cost when pre-funding, so a fee bump can't strand it. */
const PREFUND_BUFFER_NUM = 2n;
const PREFUND_BUFFER_DEN = 1n;
/** Fallback gas limit for an ERC-20 transfer when estimation reverts (no-ETH case). */
const FALLBACK_TRANSFER_GAS = 90_000n;

/** What the screen renders the confirm prompt from. Carries no key material. */
export interface GasPrefundInfo {
  /** PVT to recover, atomic units (18 dp). */
  pvtAtomic: string;
  /** PVT to recover, human units (e.g. "5.0"). */
  pvtDisplay: string;
  /** Estimated gas to pull from the human's wallet, in ETH (e.g. "0.00012"). */
  gasEthEstimate: string;
}

/** Resolves true to pre-fund gas from the human's wallet, false to skip. */
export type GasPrefundConfirm = (info: GasPrefundInfo) => Promise<boolean>;

export interface AgentPvtSweepInput {
  /** The retired address's private key hex (recovered from escrow). Never surfaced. */
  oldKeyHex: string;
  /** Destination (the freshly re-keyed address). */
  newAddress: string;
  /** Human confirm gate for pre-funding gas. Omit ⇒ no funding (report only). */
  confirmGasPrefund?: GasPrefundConfirm;
}

export type AgentSweepResult =
  | {
      status: 'swept';
      oldAddress: string;
      newAddress: string;
      amountAtomic: string;
      amountDisplay: string;
      txHash: string;
      explorerUrl: string;
    }
  | { status: 'nothing_to_sweep'; oldAddress: string }
  | { status: 'insufficient_gas'; oldAddress: string; strandedAtomic: string; strandedDisplay: string }
  | { status: 'sweep_failed'; oldAddress: string; strandedAtomic: string; error: string }
  /** Set by the rekey layer when there is no escrow / old key to sweep with. */
  | { status: 'no_old_key' };

/** On-chain primitives, injectable so the orchestrator is unit-testable without RPC. */
export interface AgentSweepDeps {
  deriveAddress(oldKeyHex: string): string;
  readPvtBalanceAtomic(oldAddress: string): Promise<bigint>;
  readNativeWei(oldAddress: string): Promise<bigint>;
  estimateGasCostWei(oldAddress: string, newAddress: string, amountAtomic: bigint): Promise<bigint>;
  prefundGasFromHuman(oldAddress: string, amountWei: bigint): Promise<void>;
  broadcastSweep(oldKeyHex: string, newAddress: string, amountAtomic: bigint): Promise<{ txHash: string; explorerUrl: string }>;
}

function formatPvt(atomic: bigint): string {
  return ethers.formatUnits(atomic, PVT_DECIMALS);
}

/** Whether a caught error looks like the node refusing the tx for lack of gas funds. */
function looksLikeInsufficientFunds(message: string): boolean {
  return /insufficient funds|gas required exceeds|max fee per gas less than|not enough funds/i.test(message);
}

function strandedGas(oldAddress: string, balance: bigint): AgentSweepResult {
  return { status: 'insufficient_gas', oldAddress, strandedAtomic: balance.toString(), strandedDisplay: formatPvt(balance) };
}

/**
 * Sweep the full PVT balance of the retired address to the new one. Fail-closed:
 * returns an AgentSweepResult for every outcome and never throws for an on-chain
 * condition, so the (already-completed) rekey identity cut is never undone.
 *
 * Decision order:
 *   1. read PVT balance at the old address — a failed read is `sweep_failed`/unknown
 *      (never a false `nothing_to_sweep`);
 *   2. zero balance → `nothing_to_sweep`;
 *   3. estimate gas + read the old address's native ETH; if it cannot pay, either
 *      pre-fund from the human's wallet (on confirm) or report `insufficient_gas`
 *      with the exact stranded amount;
 *   4. sign `transfer(newAddress, fullBalance)` with the OLD key and wait for the
 *      receipt — a revert / late insufficient-funds error is classified, not
 *      mistaken for success.
 */
export async function runAgentPvtSweep(
  input: AgentPvtSweepInput,
  providedDeps: AgentSweepDeps | undefined = undefined, biometricAction?: BiometricAction,
): Promise<AgentSweepResult> {
  const deps = providedDeps ?? defaultAgentSweepDeps(biometricAction);
  let oldAddress: string;
  try {
    oldAddress = deps.deriveAddress(input.oldKeyHex);
  } catch {
    return { status: 'sweep_failed', oldAddress: '', strandedAtomic: 'unknown', error: 'the recovered key is not a valid private key' };
  }

  let balance: bigint;
  try {
    balance = await deps.readPvtBalanceAtomic(oldAddress);
  } catch {
    // Unknown balance is reported as failed — NEVER a false "nothing to sweep".
    return { status: 'sweep_failed', oldAddress, strandedAtomic: 'unknown', error: 'could not read the old address balance' };
  }

  if (balance <= 0n) {
    return { status: 'nothing_to_sweep', oldAddress };
  }

  let gasCostWei: bigint;
  try {
    gasCostWei = await deps.estimateGasCostWei(oldAddress, input.newAddress, balance);
  } catch {
    return { status: 'sweep_failed', oldAddress, strandedAtomic: balance.toString(), error: 'could not estimate the sweep gas' };
  }

  let nativeWei: bigint;
  try {
    nativeWei = await deps.readNativeWei(oldAddress);
  } catch {
    return { status: 'sweep_failed', oldAddress, strandedAtomic: balance.toString(), error: 'could not read the old address ETH' };
  }

  if (nativeWei < gasCostWei) {
    if (!input.confirmGasPrefund) {
      return strandedGas(oldAddress, balance);
    }
    let confirmed = false;
    try {
      confirmed = await input.confirmGasPrefund({
        pvtAtomic: balance.toString(),
        pvtDisplay: formatPvt(balance),
        gasEthEstimate: ethers.formatEther(gasCostWei),
      });
    } catch {
      confirmed = false;
    }
    if (!confirmed) {
      return strandedGas(oldAddress, balance);
    }
    try {
      await deps.prefundGasFromHuman(oldAddress, (gasCostWei * PREFUND_BUFFER_NUM) / PREFUND_BUFFER_DEN);
    } catch {
      // The human's own funding tx failed (declined biometric / no ETH / revert).
      return { status: 'sweep_failed', oldAddress, strandedAtomic: balance.toString(), error: 'could not send gas from your wallet' };
    }
    try {
      nativeWei = await deps.readNativeWei(oldAddress);
    } catch {
      /* keep the prior read; the broadcast will still fail-close if it is short */
    }
    if (nativeWei < gasCostWei) {
      return strandedGas(oldAddress, balance);
    }
  }

  try {
    const { txHash, explorerUrl } = await deps.broadcastSweep(input.oldKeyHex, input.newAddress, balance);
    return {
      status: 'swept',
      oldAddress,
      newAddress: input.newAddress,
      amountAtomic: balance.toString(),
      amountDisplay: formatPvt(balance),
      txHash,
      explorerUrl,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (looksLikeInsufficientFunds(message)) {
      return strandedGas(oldAddress, balance);
    }
    return { status: 'sweep_failed', oldAddress, strandedAtomic: balance.toString(), error: 'the transfer did not go through' };
  }
}

/** Public entry used by the in-app rekey flow (agentRekey.ts). */
export function sweepAgentPvt(input: AgentPvtSweepInput, biometricAction?: BiometricAction): Promise<AgentSweepResult> {
  return runAgentPvtSweep(input, undefined, biometricAction);
}

// ---------------------------------------------------------------------------
// Default (production) deps — real ethers/RPC, PVT9 on Base, human-funded gas.
// The wallet/config modules are lazily imported so this module's unit test (which
// injects deps) never pulls in the heavy SeedManager/biometric chain.
// ---------------------------------------------------------------------------

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

async function pvtContext(): Promise<{
  tokenAddress: string;
  provider: ethers.JsonRpcProvider;
  explorerBase: string;
}> {
  const { PVT9_TOKEN, ALL_CHAINS } = await import('../chains/evm/config');
  const svc = (await import('../wallet/TransactionService')).default;
  const provider = svc.providerFor(PVT9_TOKEN.chainId);
  const chain = ALL_CHAINS.find((c) => c.chainId === PVT9_TOKEN.chainId);
  return { tokenAddress: PVT9_TOKEN.address, provider, explorerBase: chain?.explorerUrl ?? '' };
}

function normalizeKey(oldKeyHex: string): string {
  return oldKeyHex.startsWith('0x') ? oldKeyHex : `0x${oldKeyHex}`;
}

export function defaultAgentSweepDeps(biometricAction?: BiometricAction): AgentSweepDeps {
  return {
    deriveAddress(oldKeyHex) {
      return new ethers.Wallet(normalizeKey(oldKeyHex)).address;
    },
    async readPvtBalanceAtomic(oldAddress) {
      const { tokenAddress, provider } = await pvtContext();
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
      return BigInt(await token.balanceOf(oldAddress));
    },
    async readNativeWei(oldAddress) {
      const { provider } = await pvtContext();
      return BigInt(await provider.getBalance(oldAddress));
    },
    async estimateGasCostWei(oldAddress, newAddress, amount) {
      const { tokenAddress, provider } = await pvtContext();
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
      let gasLimit: bigint;
      try {
        gasLimit = BigInt(await token.transfer.estimateGas(newAddress, amount, { from: oldAddress }));
      } catch {
        gasLimit = FALLBACK_TRANSFER_GAS;
      }
      const fee = await provider.getFeeData();
      const perGas = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
      return gasLimit * BigInt(perGas);
    },
    async prefundGasFromHuman(oldAddress, amountWei) {
      // The human's OWN Base wallet funds the retired address's gas (biometric-gated
      // inside TransactionService.sendETH). This is the human's money, not the agent's.
      const svc = (await import('../wallet/TransactionService')).default;
      await svc.sendETH({ to: oldAddress, amount: ethers.formatEther(amountWei), chainId: BASE_CHAIN_ID }, biometricAction);
    },
    async broadcastSweep(oldKeyHex, newAddress, amount) {
      const { tokenAddress, provider, explorerBase } = await pvtContext();
      assertBiometricAction(biometricAction);
      const wallet = new ActionWallet(normalizeKey(oldKeyHex), biometricAction, provider);
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
      const tx = await token.transfer(newAddress, amount);
      const receipt = await tx.wait();
      if (!receipt || receipt.status === 0) {
        throw new Error('sweep transfer reverted');
      }
      return { txHash: tx.hash, explorerUrl: explorerBase ? `${explorerBase}/tx/${tx.hash}` : tx.hash };
    },
  };
}
