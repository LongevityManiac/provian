/**
 * Witness report → the relay (the operator: "Every settlement is a relay-witnessed PE for buyer and seller").
 *
 * After a CONFIRMED settlement the facilitator tells the relay where to look:
 * POST {relay}/v1/internal/x402/facilitator-settlement Authorization: Bearer <FACILITATOR_RELAY_SECRET>
 * { chain, tx_hash, buyer, seller, asset, amount, fee, scheme }
 * The relay re-verifies the transaction on chain itself (the facilitator's word is a pointer, never
 * evidence) and records the buyer's `x402_payment` and the seller's `receive` through its own
 * relay-authored path under the existing pricing and mint-once rules.
 *
 * A report that does not land stays `witness_status: 'pending'` on the settlement record and is
 * retried by POST /internal/witness-retry; it never blocks or undoes the settlement.
 */
import type { FetchLike } from './presentation.js';
import type { FacilitatorStore, SettlementRecord } from './store.js';

export interface WitnessReport {
  readonly chain: 'base' | 'solana';
  readonly tx_hash: string;
  readonly buyer: string;
  readonly seller: string;
  readonly asset: string;
  readonly amount: string;
  readonly fee: string;
  readonly scheme: 'eip3009' | 'permit2' | 'svm_exact';
}

/**
 * `reported`: any 2xx (the relay answers 202 while the transaction is not yet final and owns that
 * retry itself). `refused`: 400/409/422 — final. `retry`: anything else (network, 5xx, 401/503).
 */
export type WitnessOutcome = 'reported' | 'refused' | 'retry';
export type WitnessReporter = (report: WitnessReport) => Promise<WitnessOutcome>;

export function createWitnessReporter(relayUrl: string, secret: string | null, fetchImpl: FetchLike): WitnessReporter {
  return async (report) => {
    if (!secret) return 'retry';
    try {
      const res = await fetchImpl(`${relayUrl}/v1/internal/x402/facilitator-settlement`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return 'reported';
      if (res.status === 400 || res.status === 409 || res.status === 422) return 'refused';
      return 'retry';
    } catch {
      return 'retry';
    }
  };
}

export function reportOf(s: SettlementRecord): WitnessReport | null {
  if (!s.tx_hash) return null;
  return {
    chain: s.chain,
    tx_hash: s.tx_hash,
    buyer: s.buyer,
    seller: s.seller,
    asset: s.asset,
    amount: s.amount,
    fee: s.fee,
    scheme: s.scheme,
  };
}

/** Report one confirmed settlement and record the outcome on its record. */
export async function deliverWitness(store: FacilitatorStore, reporter: WitnessReporter, s: SettlementRecord): Promise<boolean> {
  const report = reportOf(s);
  if (!report) return false;
  const outcome = await reporter(report);
  await store.updateSettlement(s.key, {
    witness_status: outcome === 'retry' ? 'pending' : outcome,
    witness_attempts: s.witness_attempts + 1,
  });
  return outcome === 'reported';
}

export async function retryPendingWitness(store: FacilitatorStore, reporter: WitnessReporter, limit = 50): Promise<{ attempted: number; reported: number }> {
  const pending = await store.listPendingWitness(limit);
  let reported = 0;
  for (const s of pending) {
    if (await deliverWitness(store, reporter, s)) reported += 1;
  }
  return { attempted: pending.length, reported };
}
