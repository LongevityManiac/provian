/**
 * — the on-demand payout's production wiring: the one-payee settlement adapter,
 * the gas-key nonce lease, and the dependency bundle the routes use. Kept out of `server.ts`.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { OperatorRefusal, runSettlement } from '../pvt/wp4/operator-runtime';
import type { SettlementDb } from '../pvt/wp4/durable-settlement-store';
import { createUsdcChargeRuntime, USDC_CHARGE_PRICE_MAX_AGE_MS } from '../payments/usdc-charge-runtime';
import type { PayoutDeps, PayoutSettleOutcome } from './on-demand-payout';

/** An ETH price older than this is treated as unknown (the payout then waits, never charges). */
export const PAYOUT_PRICE_MAX_AGE_MS = USDC_CHARGE_PRICE_MAX_AGE_MS;

/** Map one scoped settlement run onto the payout's outcome. Pure; tested. */
export function payoutOutcomeOf(result: Awaited<ReturnType<typeof runSettlement>>): PayoutSettleOutcome {
  const s = result.settlement;
  if (s === null) return { kind: 'wait', reason: 'settlement_not_run' };
  if (s.claimsSettled > 0) {
    return {
      kind: 'settled',
      cycleId: s.cycleId,
      claimsSettled: s.claimsSettled,
      batchesConfirmed: s.batchesConfirmed,
      feeWeiSpent: s.feeWeiSpent.toString(10),
    };
  }
  // work a demotion in flight holds is still owed — the paid payout waits for the
  // hold to end, never closes as nothing (whatever state the request was advanced from).
  if ((result.meterInlet?.held ?? 0) > 0) return { kind: 'wait', reason: 'demotion_hold' };
  if (s.outcome === 'completed' && (s.stopReason === null || s.stopReason === 'backlog_exhausted')) {
    return { kind: 'nothing', cycleId: s.cycleId };
  }
  return { kind: 'wait', reason: s.stopReason ?? s.outcome };
}

export async function settleOnePayee(
  db: Firestore,
  payee: string,
  requestId: string,
  log: (message: string) => void,
): Promise<PayoutSettleOutcome> {
  try {
    const result = await runSettlement({
      db: db as unknown as SettlementDb,
      dryRun: false,
      log,
      payee: { address: payee.toLowerCase(), requestId },
    });
    return payoutOutcomeOf(result);
  } catch (error) {
    // Busy signer, unarmed runtime, missing key: the payout waits; the sweep retries.
    if (error instanceof OperatorRefusal) return { kind: 'wait', reason: error.reason };
    throw error;
  }
}

export function createPayoutDeps(params: {
  readonly db: Firestore;
  readonly env: NodeJS.ProcessEnv;
  readonly readEthPrice: () => Promise<{ usd: number; as_of_ms: number } | null>;
  readonly log?: (message: string) => void;
}): PayoutDeps | null {
  // The shared USDC charge runtime (the PE Archive's charges use the same key and the same lease).
  const charge = createUsdcChargeRuntime({ db: params.db, env: params.env, readEthPrice: params.readEthPrice, leasePrefix: 'payout' });
  if (charge === null) return null;
  const { db } = params;
  const log = params.log ?? ((m: string) => console.log(`[payout] ${m}`));
  return {
    db,
    chain: charge.chain,
    now: charge.now,
    sleep: charge.sleep,
    log,
    ethUsd: charge.ethUsd,
    settle: (payee, requestId) => settleOnePayee(db, payee, requestId, log),
    withGasKeyLease: charge.withGasKeyLease,
  };
}
