import type { Firestore } from 'firebase-admin/firestore';

export const PAYEE_SETTLEMENT_CLOCK_COLLECTION = 'pvt9_payee_settlement_clocks_v1';
export const STANDARD_INTERVAL_ENV = 'PVT9_STANDARD_SETTLEMENT_INTERVAL_DAYS';
const DAY_MS = 86_400_000;

export function standardSettlementIntervalDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[STANDARD_INTERVAL_ENV] ?? '30';
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))
    || !Number.isSafeInteger(Number(raw) * DAY_MS)) throw new Error('standard_settlement_interval_invalid');
  return Number(raw);
}

/** Due dates use UTC calendar days. A run takes one due snapshot per payee. All its due claims may drain in that same run. */
export function payeeSettlementDue(db: Firestore, days: number, nowMs: number): (address: string) => Promise<boolean> {
  if (!Number.isSafeInteger(days) || days < 1 || !Number.isSafeInteger(days * DAY_MS)) throw new Error('standard_settlement_interval_invalid');
  const memo = new Map<string, Promise<boolean>>();
  return address => {
    const payee = address.toLowerCase();
    if (!memo.has(payee)) memo.set(payee, (async () => {
      const clock = await db.collection(PAYEE_SETTLEMENT_CLOCK_COLLECTION).doc(payee).get();
      let last: unknown = clock.data()?.last_settled_at_ms;
      if (!clock.exists) {
        // Compatibility only: existing ledger rows keep their original lifetime; no backfill.
        const history = await db.collection('pvt9_claim_ledger_v1').where('contributor', '==', payee)
          .where('lane', '==', 'standard').where('settled', '==', true).orderBy('settled_at', 'desc').limit(1).get();
        last = history.docs[0]?.data().settled_at ?? null;
      }
      if (last === null) return true;
      if (!Number.isSafeInteger(last) || Number(last) < 0) throw new Error('payee_settlement_clock_invalid');
      return Math.floor(nowMs / DAY_MS) >= Math.floor(Number(last) / DAY_MS) + days;
    })());
    return memo.get(payee)!;
  };
}
