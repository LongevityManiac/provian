/**
 * Fee arithmetic (the operator: "Fee = actual gas + $0.0003, no free tier"). Pure bigint, always rounded UP,
 * so the fee never under-covers the gas it pays for.
 */
import { FEE_MARGIN_USDC_ATOMIC } from './constants.js';

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('ceilDiv by non-positive');
  if (a <= 0n) return 0n;
  return (a + b - 1n) / b;
}

/**
 * Wei of gas → USDC atomic (6 dp) at a Chainlink ETH/USD answer with `decimals` decimals, rounded up.
 * usdc = wei / 1e18 × answer / 10^decimals × 1e6.
 */
export function usdcAtomicFromWei(wei: bigint, answer: bigint, decimals: number): bigint {
  if (answer <= 0n) throw new Error('non-positive price');
  return ceilDiv(wei * answer, 10n ** BigInt(12 + decimals));
}

/**
 * Lamports → USDC atomic at a Pyth price `price × 10^expo` USD/SOL, rounded up.
 * usdc = lamports / 1e9 × price × 10^expo × 1e6 = lamports × price × 10^(expo − 3).
 */
export function usdcAtomicFromLamports(lamports: bigint, price: bigint, expo: number): bigint {
  if (price <= 0n) throw new Error('non-positive price');
  const shift = expo - 3;
  if (shift >= 0) return lamports * price * 10n ** BigInt(shift);
  return ceilDiv(lamports * price, 10n ** BigInt(-shift));
}

/** Gas cost in USDC plus the $0.0003 margin. */
export function withMargin(gasUsdcAtomic: bigint): bigint {
  return gasUsdcAtomic + FEE_MARGIN_USDC_ATOMIC;
}
