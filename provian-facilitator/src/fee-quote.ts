/**
 * GET /fee-quote — what a settlement costs right now, per chain. Reading is free.
 *
 * Base: the fee is paid by the SELLER (pulled by the settler from the seller's own approval) and is
 * computed at settlement for the exact call; this quote prices a representative settle call so a
 * seller can size its fee approval. Solana: the fee is carried by the BUYER's transaction, so the
 * quote is what the seller puts in `extra.provianFee` (with its signed `quote` token, valid 5 min).
 */
import { encodeFunctionData, type Hex } from 'viem';
import {
  BASE_NETWORK,
  BASE_USDC,
  MAX_FEE_USDC_ATOMIC,
  SOLANA_GAS_WALLET,
  SOLANA_LAMPORTS_PER_SIGNATURE,
  SOLANA_MAX_COMPUTE_UNITS,
  SOLANA_MAX_PRIORITY_MICROLAMPORTS,
  SOLANA_NETWORK,
  SOLANA_QUOTE_TTL_MS,
  SOLANA_USDC_MINT,
} from './constants.js';
import { ceilDiv, usdcAtomicFromLamports, usdcAtomicFromWei, withMargin } from './fee-math.js';
import { settlerAbi } from './base/abi.js';
import type { BaseChain } from './base/chain.js';
import { MAX_PRIORITY_FEE_WEI } from './base/facilitator.js';
import type { SolanaChain } from './solana/chain.js';
import { signQuote } from './solana/quote.js';

/**
 * Settle-call gas measured on a Base fork (e2e.base-fork.test.ts, first payment to a fresh seller,
 * cold storage): EIP-3009 149,054 used, Permit2/PVT 143,816 used; quoted at the facilitator's
 * +10% gas limit so the representative quote bounds what a real settlement is charged.
 */
export const REPRESENTATIVE_GAS = { eip3009: 165_000n, permit2: 160_000n } as const;

function representativeCalldata(kind: 'eip3009' | 'permit2'): Hex {
  const addr = '0x1111111111111111111111111111111111111111' as const;
  const sig = `0x${'ab'.repeat(65)}` as Hex;
  const word = `0x${'cd'.repeat(32)}` as Hex;
  if (kind === 'eip3009') {
    return encodeFunctionData({
      abi: settlerAbi,
      functionName: 'settleWithAuthorization',
      args: [addr, addr, 10n ** 9n, 1n, 2n ** 40n, word, sig, MAX_FEE_USDC_ATOMIC],
    });
  }
  return encodeFunctionData({
    abi: settlerAbi,
    functionName: 'settleWithPermit2',
    args: [{ permitted: { token: addr, amount: 10n ** 24n }, nonce: 2n ** 200n, deadline: 2n ** 40n }, addr, { to: addr, validAfter: 1n }, sig, MAX_FEE_USDC_ATOMIC],
  });
}

export async function quoteBase(chain: BaseChain, kind: 'eip3009' | 'permit2', priceMaxAgeSeconds: number, nowMs: number) {
  const gasLimit = REPRESENTATIVE_GAS[kind];
  const [baseFee, tipRaw, price] = await Promise.all([chain.latestBaseFee(), chain.priorityFee(), chain.ethUsd()]);
  const tip = tipRaw > MAX_PRIORITY_FEE_WEI ? MAX_PRIORITY_FEE_WEI : tipRaw < 1n ? 1n : tipRaw;
  const maxFeePerGas = ceilDiv(baseFee * 125n, 100n) + tip;
  const l1 = await chain.l1Fee(representativeCalldata(kind), gasLimit, maxFeePerGas, tip);
  const nowSec = Math.floor(nowMs / 1000);
  if (price.answer <= 0n || nowSec - price.updatedAt > priceMaxAgeSeconds) throw new Error('ETH/USD price is stale');
  const gasUsdc = usdcAtomicFromWei(gasLimit * maxFeePerGas + l1, price.answer, price.decimals);
  return {
    network: BASE_NETWORK,
    scheme: kind,
    payer: 'seller',
    asset: BASE_USDC,
    fee_atomic: withMargin(gasUsdc).toString(),
    gas_usdc_atomic: gasUsdc.toString(),
    margin_usdc_atomic: '300',
    max_fee_atomic: MAX_FEE_USDC_ATOMIC.toString(),
    gas_limit: gasLimit.toString(),
    max_fee_per_gas_wei: maxFeePerGas.toString(),
    l1_data_fee_wei: l1.toString(),
    eth_usd: { answer: price.answer.toString(), decimals: price.decimals, updated_at: price.updatedAt },
    settler: chain.settler,
    representative: true,
    note: 'The fee is computed for the exact settle call at settlement (gas limit x max fee per gas + L1 data fee, at Chainlink ETH/USD, rounded up, + $0.0003) and pulled from the seller in the same transaction. Approve the settler for at least this much USDC.',
  };
}

export async function quoteSolana(
  chain: SolanaChain,
  args: { computeUnitLimit: bigint; computeUnitPriceMicroLamports: bigint; signatures: number },
  priceMaxAgeSeconds: number,
  quoteSecret: string | null,
  nowMs: number,
) {
  if (args.computeUnitLimit <= 0n || args.computeUnitLimit > SOLANA_MAX_COMPUTE_UNITS) throw new RangeError('compute_unit_limit out of range');
  if (args.computeUnitPriceMicroLamports < 0n || args.computeUnitPriceMicroLamports > SOLANA_MAX_PRIORITY_MICROLAMPORTS) throw new RangeError('compute_unit_price out of range');
  if (!Number.isInteger(args.signatures) || args.signatures < 2 || args.signatures > 4) throw new RangeError('signatures out of range');
  const lamports = SOLANA_LAMPORTS_PER_SIGNATURE * BigInt(args.signatures) + ceilDiv(args.computeUnitLimit * args.computeUnitPriceMicroLamports, 1_000_000n);
  const price = await chain.solUsd(priceMaxAgeSeconds);
  const gasUsdc = usdcAtomicFromLamports(lamports, price.price, price.expo);
  const fee = withMargin(gasUsdc);
  const quote = quoteSecret ? signQuote(quoteSecret, SOLANA_NETWORK, { price: price.price, expo: price.expo, issuedAtMs: nowMs }) : null;
  return {
    network: SOLANA_NETWORK,
    scheme: 'exact',
    payer: 'buyer',
    fee_atomic: fee.toString(),
    gas_usdc_atomic: gasUsdc.toString(),
    margin_usdc_atomic: '300',
    lamports: lamports.toString(),
    signatures: args.signatures,
    compute_unit_limit: args.computeUnitLimit.toString(),
    compute_unit_price_micro_lamports: args.computeUnitPriceMicroLamports.toString(),
    sol_usd: { price: price.price.toString(), expo: price.expo, publish_time: price.publishTime },
    valid_until_ms: nowMs + SOLANA_QUOTE_TTL_MS,
    extra: {
      feePayer: chain.feePayer,
      provianFee: { amount: fee.toString(), payTo: SOLANA_GAS_WALLET, asset: SOLANA_USDC_MINT, ...(quote ? { quote } : {}) },
    },
    note: 'Put `extra` into the 402 requirement. The buyer adds one USDC transferChecked of `provianFee.amount` to the USDC account of `provianFee.payTo` (after the payment transfer). The fee covers the transaction\'s own gas (5,000 lamports per signature + compute-unit limit x price) + $0.0003.',
  };
}
