/**
 * The USDC charge path's production wiring, shared by every service fee (the payout's $1, the PE
 * Archive's $5 per GB): the Base chain over the charge gas key, its canonical nonce writer, the ETH
 * price read, and the clock.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { RPC_ENV } from '../pvt/wp4/operator-runtime';
import { createUsdcChargeChain, USDC_CHARGE_GAS_KEY_ENV } from './usdc-charge-chain';
import type { UsdcChargeChain } from './usdc-charge';

/** An ETH price older than this is treated as unknown (a charge then waits, never charges). */
export const USDC_CHARGE_PRICE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface UsdcChargeRuntimeDeps {
  readonly chain: UsdcChargeChain;
  readonly ethUsd: () => Promise<number | null>;
  readonly withGasKeyLease: <T>(fn: () => Promise<T>) => Promise<T | 'lease_busy'>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/** Null while the charge gas key or the Base RPC is not configured (every charge route answers 503). */
export function createUsdcChargeRuntime(params: {
  readonly db: Firestore;
  readonly env: NodeJS.ProcessEnv;
  readonly readEthPrice: () => Promise<{ usd: number; as_of_ms: number } | null>;
  readonly leasePrefix: string;
}): UsdcChargeRuntimeDeps | null {
  const gasKey = params.env[USDC_CHARGE_GAS_KEY_ENV];
  const rpcUrl = params.env[RPC_ENV];
  if (gasKey === undefined || gasKey.trim() === '' || rpcUrl === undefined || rpcUrl.trim() === '') return null;
  const chain = createUsdcChargeChain({ rpcUrl, gasKey: gasKey.trim() });
  const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
  return {
    chain,
    now: () => Date.now(),
    sleep,
    ethUsd: async () => {
      const price = await params.readEthPrice().catch(() => null);
      if (price === null || !(price.usd > 0)) return null;
      if (Date.now() - price.as_of_ms > USDC_CHARGE_PRICE_MAX_AGE_MS) return null;
      return price.usd;
    },
    // CanonicalWallet acquires the shared signer lease while reserving/signing/broadcasting.
    // Taking that same lease here under another owner deadlocks every charge before signing.
    // Payout and Archive use the same canonical wallet journal and remain mutually exclusive.
    withGasKeyLease: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
}
