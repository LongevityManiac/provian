/**
 * PE METER — a settled meter claim's ledger row outlives every path that could re-register or
 * re-plan the same claim (`ledger-retention.ts`). Each window reads the LIVE constant it bounds, so
 * changing any lifetime so that the inequality breaks turns this suite red.
 */
import { readFileSync } from 'fs';
import * as path from 'path';
import { Timestamp } from 'firebase-admin/firestore';
import {
  FIRESTORE_TTL_DELETION_LAG_MS,
  SETTLED_METER_LEDGER_ROW_LIFETIME_MS,
  ledgerRetentionViolations,
  meterLedgerRetentionWindows,
  settledLedgerRowExpiry,
  unsettledLedgerRowExpiry,
} from './ledger-retention';
import { DAY_MS, METER_KEY_LIFETIME_MS } from './meter-store';
import { meterBatchClaimKey } from './meter-claims';
import { CLAIM_LEDGER_COLLECTION } from '../pvt/wp4/durable-settlement-store';

describe('settled meter ledger rows — retention inequality', () => {
  it('the lifetime outlasts every re-registration / re-plan window plus the TTL deletion lag', () => {
    const windows = meterLedgerRetentionWindows();
    expect(windows.length).toBeGreaterThanOrEqual(6);
    expect(ledgerRetentionViolations(SETTLED_METER_LEDGER_ROW_LIFETIME_MS, windows)).toEqual([]);
  });

  it('RED: a lifetime equal to the act-key lifetime (31 d) violates it', () => {
    expect(ledgerRetentionViolations(METER_KEY_LIFETIME_MS, meterLedgerRetentionWindows()).length).toBeGreaterThan(0);
  });

  it('RED: lengthening a window past the lifetime (e.g. 60-day act keys) violates it', () => {
    const windows = meterLedgerRetentionWindows().map((w) => (w.name.startsWith('act key')
      ? { ...w, endAfterSettlementMs: 60 * DAY_MS }
      : w));
    expect(ledgerRetentionViolations(SETTLED_METER_LEDGER_ROW_LIFETIME_MS, windows)).toEqual([
      expect.stringContaining('act key'),
    ]);
  });

  it('RED: the TTL deletion lag is part of the bound (a lifetime that only clears the windows fails)', () => {
    const latest = Math.max(...meterLedgerRetentionWindows().map((w) => w.endAfterSettlementMs));
    expect(ledgerRetentionViolations(latest + 1, meterLedgerRetentionWindows()).length).toBeGreaterThan(0);
    expect(ledgerRetentionViolations(latest + FIRESTORE_TTL_DELETION_LAG_MS + 1, meterLedgerRetentionWindows())).toEqual([]);
  });

  it('RED: an empty window list is never a pass', () => {
    expect(ledgerRetentionViolations(SETTLED_METER_LEDGER_ROW_LIFETIME_MS, [])).toEqual(['no windows evaluated']);
  });

  it('only a meter claim key gets an expiry; legacy and Genesis rows never do', () => {
    const key = meterBatchClaimKey({ batch_hash: 'ab'.repeat(32), leg: 'sole', contributor: '0x' + '1'.repeat(40), beneficiary_class: 0 });
    const exp = settledLedgerRowExpiry(key, 1_000);
    expect(exp.expire_at).toBeInstanceOf(Timestamp);
    expect(exp.expire_at!.toMillis()).toBe(1_000 + SETTLED_METER_LEDGER_ROW_LIFETIME_MS);
    expect(unsettledLedgerRowExpiry(key)).toEqual({ expire_at: null });
    expect(settledLedgerRowExpiry('pe_0123456789abcdef', 1_000)).toEqual({});
    expect(unsettledLedgerRowExpiry('pe_0123456789abcdef')).toEqual({});
  });

  it('the ledger TTL policy is declared on expire_at', () => {
    const cfg = JSON.parse(readFileSync(path.join(__dirname, '../../../firestore.indexes.json'), 'utf8')) as {
      fieldOverrides: { collectionGroup: string; fieldPath: string; ttl?: boolean }[];
    };
    expect(cfg.fieldOverrides.find((f) => f.collectionGroup === CLAIM_LEDGER_COLLECTION && f.fieldPath === 'expire_at')?.ttl).toBe(true);
  });
});
