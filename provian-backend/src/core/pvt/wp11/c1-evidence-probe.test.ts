/**
 * the C1 evidence comparator can FAIL (negative controls for
 * `scripts/wp11-c1-evidence-probe.ts`).
 *
 * The probe's live run is only evidence because the comparator underneath it
 * reports drift; a comparator observed only against the confirming world would
 * pass identically if it were hard-wired. Each control below perturbs ONE
 * field of a faithful observation and asserts the mismatch is reported by
 * name. The faithful observation is built FROM the pinned tables (no copied
 * ids), so table changes flow through.
 */
import { describe, expect, it } from '@jest/globals';
import { C1_SCOPE_EVIDENCE } from './cutover-scope-exclusions';
import { DOCUMENT_MINT_BINDINGS } from './legacy-mint-contract-registry';
import {
  compareC1Evidence,
  type C1LiveObservation,
} from '../../../../scripts/wp11-c1-evidence-probe';

/** A faithful observation for one pinned document, derived from the tables. */
function faithfulObservation(documentId: string): C1LiveObservation {
  const evidence = C1_SCOPE_EVIDENCE.find((row) => row.document_id === documentId);
  const binding = DOCUMENT_MINT_BINDINGS.find((row) => row.document_id === documentId);
  if (evidence === undefined || binding === undefined) throw new Error('not a pinned document');
  return {
    document_id: documentId,
    receipt_status_ok: true,
    receipt_to: binding.mint_contract_address,
    receipt_block: binding.mint_block,
    receipt_log_emitters: [binding.mint_contract_address],
    batch_minted: true,
    batch_doc_exists: evidence.kind === 'batch_without_snapshot',
    snapshot_doc_exists: evidence.kind !== 'batch_without_snapshot',
    bound_pe_count: evidence.bound_pe_count,
    wallet_ledger_references: [...evidence.wallet_ledger_references],
  };
}

describe(' · the C1 evidence comparator', () => {
  it('a faithful observation of every pinned document compares clean (5 documents, none skipped)', () => {
    let compared = 0;
    for (const binding of DOCUMENT_MINT_BINDINGS) {
      expect(compareC1Evidence(faithfulObservation(binding.document_id))).toEqual([]);
      compared += 1;
    }
    expect(compared).toBe(5);
  });

  it('NEGATIVE CONTROLS — each perturbed field is reported by name', () => {
    const documentId = DOCUMENT_MINT_BINDINGS[0].document_id;
    const cases: ReadonlyArray<{
      readonly patch: Partial<C1LiveObservation>;
      readonly field: string;
    }> = [
      { patch: { receipt_status_ok: false }, field: 'receipt.status' },
      { patch: { receipt_to: `0x${'1'.repeat(40)}` }, field: 'receipt.to' },
      { patch: { receipt_block: 1 }, field: 'receipt.block' },
      { patch: { receipt_log_emitters: [] }, field: 'receipt.log_emitter' },
      { patch: { batch_minted: false }, field: 'chain.batch_minted' },
      { patch: { batch_doc_exists: false }, field: 'firestore.batch_doc_exists' },
      { patch: { snapshot_doc_exists: true }, field: 'firestore.snapshot_doc_exists' },
      { patch: { bound_pe_count: 99 }, field: 'firestore.bound_pe_count' },
      { patch: { wallet_ledger_references: ['ledger_x'] }, field: 'firestore.wallet_ledger_references' },
    ];
    for (const { patch, field } of cases) {
      const mismatches = compareC1Evidence({ ...faithfulObservation(documentId), ...patch });
      expect(mismatches.map((m) => m.field)).toContain(field);
    }
  });

  it('a document outside the pinned tables is a finding, never silently clean', () => {
    const outside = compareC1Evidence({
      ...faithfulObservation(DOCUMENT_MINT_BINDINGS[0].document_id),
      document_id: '0xnot_a_pinned_document',
    });
    expect(outside.length).toBe(1);
    expect(outside[0].field).toBe('pinned_tables');
  });
});
