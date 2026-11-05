/**
 * PE METER — the ledger audit runs in full once, then only over rows registered since its
 * watermark. RED controls: a duplicate claim id and a key-less (legacy) row registered after the
 * watermark are both caught on the INCREMENTAL pass, and the incremental pass reads only the new
 * rows (a pass over an unchanged ledger scans just the overlap window).
 */
import { describe, expect, it } from '@jest/globals';
import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import {
  auditLedgerSinceWatermark,
  CLAIM_LEDGER_COLLECTION,
  LEDGER_AUDIT_COLLECTION,
  LEDGER_AUDIT_DOC,
  LEDGER_AUDIT_OVERLAP_MS,
  registerClaim,
  type NewClaimInput,
  type SettlementDb,
} from './durable-settlement-store';

const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const ADDR = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const T0 = 1_790_000_000_000;
const claim = (n: number, claimId = H(n)): NewClaimInput => ({
  leg: 'sole', pe_id: `pe-${n}`, claim_id: claimId, lane: 'standard',
  contributor: ADDR(0xa1), beneficiary_class: 1, record_points_atomic: '1000000000000000000',
});

describe('auditLedgerSinceWatermark', () => {
  it('audits in full once, then only rows registered since the watermark', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    for (let n = 1; n <= 5; n += 1) await registerClaim(db, claim(n), T0 + n);
    const first = await auditLedgerSinceWatermark(db, T0 + 100);
    expect(first).toEqual({ mode: 'full', scanned: 5 });
    const state = (await db.collection(LEDGER_AUDIT_COLLECTION).doc(LEDGER_AUDIT_DOC).get()).data();
    expect(state?.watermark_created_at).toBe(T0 + 5 - LEDGER_AUDIT_OVERLAP_MS);

    // Much later: 3 new rows. The incremental pass reads those (the old rows are outside the overlap).
    const LATER = T0 + 24 * 3_600_000;
    for (let n = 6; n <= 8; n += 1) await registerClaim(db, claim(n), LATER + n);
    // The first incremental pass still covers the overlap window of the full audit (5 rows) + 3 new.
    expect(await auditLedgerSinceWatermark(db, LATER + 100)).toEqual({ mode: 'incremental', scanned: 8 });
    // Nothing new: only the rows inside the trailing overlap are re-read.
    expect(await auditLedgerSinceWatermark(db, LATER + 200)).toEqual({ mode: 'incremental', scanned: 3 });
  });

  it('RED: a duplicate claim id registered after the watermark is caught incrementally', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await registerClaim(db, claim(1), T0);
    await auditLedgerSinceWatermark(db, T0 + 1);
    const LATER = T0 + 24 * 3_600_000;
    // A second PE whose claim id collides with the first (a different claim key, same claim id).
    await registerClaim(db, claim(2, H(1)), LATER);
    await expect(auditLedgerSinceWatermark(db, LATER + 1)).rejects.toThrow(`legacy_ledger_duplicate_claim_id:${H(1)}`);
  });

  it('RED: a key-less row registered after the watermark is caught incrementally', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await registerClaim(db, claim(1), T0);
    await auditLedgerSinceWatermark(db, T0 + 1);
    const LATER = T0 + 24 * 3_600_000;
    const batch = db.batch();
    batch.set(db.collection(CLAIM_LEDGER_COLLECTION).doc('legacy-row'), { claim_id: H(9), created_at: LATER });
    await batch.commit();
    await expect(auditLedgerSinceWatermark(db, LATER + 1)).rejects.toThrow('legacy_claim_ledger_row:legacy-row');
  });

  describe('within one run (the run\'s audited set)', () => {
    const seeded = async (): Promise<{ db: SettlementDb; LATER: number }> => {
      const db = createFakeFirestore() as unknown as SettlementDb;
      await registerClaim(db, claim(1), T0);
      await auditLedgerSinceWatermark(db, T0 + 1);
      const LATER = T0 + 24 * 3_600_000;
      for (let n = 2; n <= 4; n += 1) await registerClaim(db, claim(n), LATER + n);
      return { db, LATER };
    };

    it('a re-selection re-reads the overlap but does not re-query rows it already cleared', async () => {
      const { db, LATER } = await seeded();
      const audited = new Set<string>();
      const first = await auditLedgerSinceWatermark(db, LATER + 10, { audited });
      expect(first.twinChecks).toBe(first.scanned);
      expect(first.scanned).toBeGreaterThan(0);
      const second = await auditLedgerSinceWatermark(db, LATER + 20, { audited });
      expect(second.scanned).toBeGreaterThan(0);
      expect(second.twinChecks).toBe(0);
    });

    it('RED: without the set every pass re-queries every scanned row', async () => {
      const { db, LATER } = await seeded();
      const fresh = new Set<string>();
      await auditLedgerSinceWatermark(db, LATER + 10, { audited: fresh });
      const again = await auditLedgerSinceWatermark(db, LATER + 20, { audited: new Set<string>() });
      expect(again.twinChecks).toBe(again.scanned);
      expect(again.scanned).toBeGreaterThan(0);
    });

    it('RED: a twin registered mid-run of a row already cleared is still caught', async () => {
      const { db, LATER } = await seeded();
      const audited = new Set<string>();
      await auditLedgerSinceWatermark(db, LATER + 10, { audited });
      expect(audited.size).toBeGreaterThan(0);
      // A new row colliding with a row this run already cleared (pe-3's claim id).
      await registerClaim(db, claim(9, H(3)), LATER + 15);
      await expect(auditLedgerSinceWatermark(db, LATER + 20, { audited }))
        .rejects.toThrow(`legacy_ledger_duplicate_claim_id:${H(3)}`);
    });
  });
});
