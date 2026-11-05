/**
 * Gas self-refill + revenue sweep (POST /internal/refill, scheduled).
 *
 * Each chain has ONE gas wallet that holds only gas and the USDC fee income that lands in it.
 *   1. Below its alarm floor, the wallet swaps fee income (USDC) into native gas — bounded by
 *      `refillMax`, never less than `MIN_SWAP_USDC` (no dust swaps), only from USDC it already holds.
 *      Base: 0x allowance-holder (pinned spender, exact approval, never unlimited). Solana: Jupiter.
 *      Both are the aggregators the relay's swap engine routes through; the relay's proxy routes need
 *      a human's wallet auth, so the facilitator calls the aggregator directly — with NO Provian swap
 *      fee on its own refill (no new fee path) and a price sanity check against the oracle the fee
 *      uses (Chainlink / Pyth): a route returning < 95% of fair value is refused.
 *   2. Only once gas is at/above the floor, USDC above `buffer` sweeps to Provian's revenue wallet.
 *      The sweep never takes the USDC balance below the buffer.
 */
import { decodeFunctionData, encodeFunctionData, getAddress, isAddressEqual, type Hex } from 'viem';
import { getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { erc20Abi } from './base/abi.js';
import type { BaseChain } from './base/chain.js';
import type { SolanaChain } from './solana/chain.js';
import {
  BASE_REVENUE_WALLET,
  BASE_USDC,
  SOLANA_REVENUE_WALLET,
  SOLANA_USDC_MINT,
  SOLANA_WSOL_MINT,
  ZEROX_ALLOWANCE_HOLDER,
  ZEROX_NATIVE_ETH,
} from './constants.js';
import type { FetchLike } from './presentation.js';

/** $1: below this the refill does not swap (it would spend more on gas than it buys). The default
 *  of `RefillPolicy.minSwap`; an operator may set it per chain (`FACILITATOR_<CHAIN>_MIN_SWAP_USDC`)
 *  to prove a refill without ~300 settlements of fee income — never below 1 atomic unit. */
export const MIN_SWAP_USDC = 1_000_000n;
/** A route must return at least 95% of oracle fair value. */
export const MIN_FAIR_VALUE_BPS = 9_500n;

const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const ALLOWED_SOLANA_SWAP_PROGRAMS = new Set([
  JUPITER_PROGRAM,
  'ComputeBudget111111111111111111111111111111',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
]);

export interface RefillPolicy {
  readonly gasFloor: bigint;
  readonly usdcBuffer: bigint;
  readonly refillMax: bigint;
  /** Smallest swap (USDC atomic); defaults to MIN_SWAP_USDC. A value below 1 is treated as the default. */
  readonly minSwap?: bigint;
}

export interface RefillReport {
  readonly chain: 'base' | 'solana';
  readonly gas_before: string;
  readonly usdc_before: string;
  readonly swapped_usdc: string;
  readonly swap_tx: string | null;
  readonly swept_usdc: string;
  readonly sweep_tx: string | null;
  readonly skipped: string[];
  readonly error: string | null;
}

/** Pure decision: how much to swap and how much to sweep, given balances (all bigint). */
export function planRefill(gas: bigint, usdc: bigint, policy: RefillPolicy): { swap: bigint; sweepAfterSwap: boolean } {
  if (gas >= policy.gasFloor) return { swap: 0n, sweepAfterSwap: true };
  const available = usdc < policy.refillMax ? usdc : policy.refillMax;
  const minSwap = policy.minSwap !== undefined && policy.minSwap >= 1n ? policy.minSwap : MIN_SWAP_USDC;
  if (available < minSwap) return { swap: 0n, sweepAfterSwap: false };
  return { swap: available, sweepAfterSwap: true };
}

export function planSweep(usdc: bigint, buffer: bigint): bigint {
  return usdc > buffer ? usdc - buffer : 0n;
}

// ── Base ──────────────────────────────────────────────────────────────────────────────────────

interface ZeroXQuote {
  readonly transaction?: { readonly to?: string; readonly data?: string; readonly value?: string };
  readonly buyAmount?: string;
  readonly minBuyAmount?: string;
  readonly buyToken?: string;
  readonly sellToken?: string;
  readonly sellAmount?: string;
}

export function validateZeroXQuote(q: ZeroXQuote, sellAmount: bigint, fairWei: bigint): { to: `0x${string}`; data: Hex; minBuy: bigint } {
  const tx = q.transaction;
  if (!tx || typeof tx.to !== 'string' || typeof tx.data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(tx.data)) throw new Error('0x quote has no transaction');
  if (!isAddressEqual(getAddress(tx.to), ZEROX_ALLOWANCE_HOLDER)) throw new Error('0x transaction target is not the allowance holder');
  if (tx.value !== undefined && tx.value !== '0') throw new Error('0x transaction carries value');
  if (typeof q.buyToken === 'string' && !isAddressEqual(getAddress(q.buyToken), ZEROX_NATIVE_ETH)) throw new Error('0x quote buys the wrong token');
  if (typeof q.sellToken === 'string' && !isAddressEqual(getAddress(q.sellToken), BASE_USDC)) throw new Error('0x quote sells the wrong token');
  if (q.sellAmount !== undefined && q.sellAmount !== sellAmount.toString()) throw new Error('0x quote sells the wrong amount');
  if (typeof q.minBuyAmount !== 'string' || !/^\d+$/.test(q.minBuyAmount)) throw new Error('0x quote has no minimum');
  const minBuy = BigInt(q.minBuyAmount);
  if (minBuy * 10_000n < fairWei * MIN_FAIR_VALUE_BPS) throw new Error('0x route is below fair value');
  return { to: getAddress(tx.to), data: tx.data as Hex, minBuy };
}

/** How long a refill waits for the RPC's latest state to show a just-confirmed approval. */
export const APPROVAL_VISIBLE_TIMEOUT_MS = 30_000;
const APPROVAL_POLL_MS = 1_000;

export async function refillBase(args: {
  chain: BaseChain;
  policy: RefillPolicy;
  zeroxApiKey: string | null;
  fetch: FetchLike;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<RefillReport> {
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const { chain, policy } = args;
  const skipped: string[] = [];
  const op = chain.operator;
  const [gas, usdc] = await Promise.all([chain.nativeBalance(op), chain.balanceOf(BASE_USDC, op)]);
  const plan = planRefill(gas, usdc, policy);
  let swapTx: string | null = null;
  let swapped = 0n;
  let error: string | null = null;
  if (plan.swap > 0n) {
    try {
      if (!args.zeroxApiKey) throw new Error('ZEROX_API_KEY unset');
      const price = await chain.ethUsd();
      // fair wei for `swap` USDC: usdc / 1e6 / (answer / 10^dec) × 1e18
      const fairWei = (plan.swap * 10n ** BigInt(12 + price.decimals)) / price.answer;
      const q = new URLSearchParams({
        chainId: '8453',
        sellToken: BASE_USDC,
        buyToken: ZEROX_NATIVE_ETH,
        sellAmount: plan.swap.toString(),
        taker: op,
        slippageBps: '100',
      });
      const res = await args.fetch(`https://api.0x.org/swap/allowance-holder/quote?${q.toString()}`, {
        headers: { '0x-api-key': args.zeroxApiKey, '0x-version': 'v2' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`0x quote failed (${res.status})`);
      const quote = validateZeroXQuote((await res.json()) as ZeroXQuote, plan.swap, fairWei);
      // Exact approval of the pinned allowance holder for this swap only — never unlimited.
      const allowance = await chain.allowance(BASE_USDC, op, ZEROX_ALLOWANCE_HOLDER);
      if (allowance < plan.swap) {
        const approveHash = await chain.sendRaw(
          BASE_USDC,
          encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ZEROX_ALLOWANCE_HOLDER, plan.swap] }),
          0n,
        );
        const r = await chain.waitReceipt(approveHash, 60_000);
        if (r.status !== 'success') throw new Error('approve reverted');
        // Base pre-confirms a receipt before the block lands, and the swap's gas estimate reads
        // `latest` send the swap only once `latest` shows the approval (live run: the swap
        // estimate ran against the pre-approval state and the swap was never sent).
        let visible = false;
        for (let waited = 0; waited <= APPROVAL_VISIBLE_TIMEOUT_MS; waited += APPROVAL_POLL_MS) {
          if ((await chain.allowance(BASE_USDC, op, ZEROX_ALLOWANCE_HOLDER)) >= plan.swap) {
            visible = true;
            break;
          }
          await sleep(APPROVAL_POLL_MS);
        }
        if (!visible) throw new Error('approval not visible on the RPC; swap not sent');
      }
      const hash = await chain.sendRaw(quote.to, quote.data, 0n);
      const r = await chain.waitReceipt(hash, 60_000);
      if (r.status !== 'success') throw new Error('swap reverted');
      swapTx = hash;
      swapped = plan.swap;
    } catch (err) {
      error = err instanceof Error ? err.message.slice(0, 200) : 'refill failed';
    }
  } else if (gas < policy.gasFloor) {
    skipped.push('gas below floor but USDC fee income below the minimum swap');
  }

  let swept = 0n;
  let sweepTx: string | null = null;
  const gasNow = swapTx ? await chain.nativeBalance(op) : gas;
  if (gasNow >= policy.gasFloor) {
    const usdcNow = await chain.balanceOf(BASE_USDC, op);
    const amount = planSweep(usdcNow, policy.usdcBuffer);
    if (amount > 0n) {
      try {
        const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [BASE_REVENUE_WALLET as `0x${string}`, amount] });
        // Defence in depth: the encoded call names the pinned revenue wallet and nothing else.
        const decoded = decodeFunctionData({ abi: erc20Abi, data });
        if (decoded.functionName !== 'transfer' || !isAddressEqual(decoded.args[0], BASE_REVENUE_WALLET as `0x${string}`)) throw new Error('sweep target');
        const hash = await chain.sendRaw(BASE_USDC, data, 0n);
        const r = await chain.waitReceipt(hash, 60_000);
        if (r.status !== 'success') throw new Error('sweep reverted');
        sweepTx = hash;
        swept = amount;
      } catch (err) {
        error = error ?? (err instanceof Error ? err.message.slice(0, 200) : 'sweep failed');
      }
    }
  } else {
    skipped.push('sweep held: gas still below floor');
  }
  return {
    chain: 'base',
    gas_before: gas.toString(),
    usdc_before: usdc.toString(),
    swapped_usdc: swapped.toString(),
    swap_tx: swapTx,
    swept_usdc: swept.toString(),
    sweep_tx: sweepTx,
    skipped,
    error,
  };
}

// ── Solana ────────────────────────────────────────────────────────────────────────────────────

interface JupiterQuote {
  readonly inputMint?: string;
  readonly outputMint?: string;
  readonly inAmount?: string;
  readonly otherAmountThreshold?: string;
}

/** A Jupiter swap transaction is signed by the gas wallet: refuse anything but a plain swap it pays for. */
export function validateJupiterTransaction(base64: string, wallet: string): void {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const statics = compiled.staticAccounts.map((a) => a.toString());
  if (statics[0] !== wallet) throw new Error('Jupiter transaction fee payer is not the gas wallet');
  if (compiled.header.numSignerAccounts !== 1) throw new Error('Jupiter transaction needs another signer');
  for (const ix of compiled.instructions) {
    const program = statics[ix.programAddressIndex];
    if (!program || !ALLOWED_SOLANA_SWAP_PROGRAMS.has(program)) throw new Error(`Jupiter transaction calls a program outside the swap allowlist`);
  }
}

export function validateJupiterQuote(q: JupiterQuote, amount: bigint, fairLamports: bigint): void {
  if (q.inputMint !== SOLANA_USDC_MINT || q.outputMint !== SOLANA_WSOL_MINT) throw new Error('Jupiter quote is for the wrong pair');
  if (q.inAmount !== amount.toString()) throw new Error('Jupiter quote sells the wrong amount');
  if (typeof q.otherAmountThreshold !== 'string' || !/^\d+$/.test(q.otherAmountThreshold)) throw new Error('Jupiter quote has no minimum');
  if (BigInt(q.otherAmountThreshold) * 10_000n < fairLamports * MIN_FAIR_VALUE_BPS) throw new Error('Jupiter route is below fair value');
}

export async function refillSolana(args: {
  chain: SolanaChain;
  policy: RefillPolicy;
  jupiterApiKey: string | null;
  priceMaxAgeSeconds: number;
  fetch: FetchLike;
}): Promise<RefillReport> {
  const { chain, policy } = args;
  const skipped: string[] = [];
  const wallet = chain.feePayer;
  const [gas, usdc] = await Promise.all([chain.lamports(wallet), chain.tokenBalance(wallet, SOLANA_USDC_MINT)]);
  const plan = planRefill(gas, usdc, policy);
  let swapTx: string | null = null;
  let swapped = 0n;
  let error: string | null = null;
  if (plan.swap > 0n) {
    try {
      const price = await chain.solUsd(args.priceMaxAgeSeconds);
      // fair lamports for `swap` USDC: usdc / 1e6 / (price × 10^expo) × 1e9 = usdc × 10^(3 − expo) / price
      const fairLamports = (plan.swap * 10n ** BigInt(3 - price.expo)) / price.price;
      const base = args.jupiterApiKey ? 'https://api.jup.ag/swap/v1' : 'https://lite-api.jup.ag/swap/v1';
      const headers: Record<string, string> = args.jupiterApiKey ? { 'x-api-key': args.jupiterApiKey } : {};
      const q = new URLSearchParams({ inputMint: SOLANA_USDC_MINT, outputMint: SOLANA_WSOL_MINT, amount: plan.swap.toString(), slippageBps: '100' });
      const qRes = await args.fetch(`${base}/quote?${q.toString()}`, { headers, signal: AbortSignal.timeout(20_000) });
      if (!qRes.ok) throw new Error(`Jupiter quote failed (${qRes.status})`);
      const quote = (await qRes.json()) as JupiterQuote;
      validateJupiterQuote(quote, plan.swap, fairLamports);
      const sRes = await args.fetch(`${base}/swap`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ quoteResponse: quote, userPublicKey: wallet, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!sRes.ok) throw new Error(`Jupiter swap failed (${sRes.status})`);
      const swap = (await sRes.json()) as { swapTransaction?: unknown };
      if (typeof swap.swapTransaction !== 'string') throw new Error('Jupiter returned no transaction');
      validateJupiterTransaction(swap.swapTransaction, wallet);
      const sig = await chain.signAndSendOwn(swap.swapTransaction);
      if ((await chain.confirm(sig)) !== 'confirmed') throw new Error('swap failed on chain');
      swapTx = sig;
      swapped = plan.swap;
    } catch (err) {
      error = err instanceof Error ? err.message.slice(0, 200) : 'refill failed';
    }
  } else if (gas < policy.gasFloor) {
    skipped.push('gas below floor but USDC fee income below the minimum swap');
  }

  let swept = 0n;
  let sweepTx: string | null = null;
  const gasNow = swapTx ? await chain.lamports(wallet) : gas;
  if (gasNow >= policy.gasFloor) {
    const usdcNow = await chain.tokenBalance(wallet, SOLANA_USDC_MINT);
    const amount = planSweep(usdcNow, policy.usdcBuffer);
    if (amount > 0n) {
      try {
        if (!(await chain.ataExists(SOLANA_REVENUE_WALLET, SOLANA_USDC_MINT))) throw new Error('revenue wallet has no USDC account');
        const sig = await chain.sendUsdc(SOLANA_REVENUE_WALLET, amount);
        if ((await chain.confirm(sig)) !== 'confirmed') throw new Error('sweep failed on chain');
        sweepTx = sig;
        swept = amount;
      } catch (err) {
        error = error ?? (err instanceof Error ? err.message.slice(0, 200) : 'sweep failed');
      }
    }
  } else {
    skipped.push('sweep held: gas still below floor');
  }
  return {
    chain: 'solana',
    gas_before: gas.toString(),
    usdc_before: usdc.toString(),
    swapped_usdc: swapped.toString(),
    swap_tx: swapTx,
    swept_usdc: swept.toString(),
    sweep_tx: sweepTx,
    skipped,
    error,
  };
}
