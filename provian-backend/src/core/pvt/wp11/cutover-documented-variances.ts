/**
 * the reconciliation stops fouling on a healthy system (the operator,
 * 2026-10-01: "fix those four so they don't continue to foul, whatever the
 * tactic is").
 *
 * Every gated relay deploy used to print four FAILs (C1, C6, C8, C12) that were
 * not failures of the system: two ACCEPTED variances, one retired
 * operator stub, and one check whose premise expired at the first mint.
 * A check that is always red teaches the operator to read past red, which is
 * the worst thing a gate can teach. This module holds the EVIDENCE for the
 * first three, pinned exactly, so each reports a distinct non-failing status
 * ONLY while the observed state equals the evidenced state. Any other state —
 * a sixth unexplained C1 document, a moved C6 delta, a second stub, an edited
 * stub — is a real failure and still fails. (C12 is reframed in place, in
 * `cutover-reconciliation.ts`.)
 *
 * NOTHING here writes, mints, settles, or grants authority. Frozen data plus
 * pure judgments.
 */

import type { C6DowngradeVerdict } from './c6-downgrade-evidence';
import { C1_SCOPE_EVIDENCE } from './cutover-scope-exclusions';

// ─── C1: the five evidenced pre-snapshot-era documents ──────

/**
 * The row shape the C1 evidence judgments run over. Deliberately WIDER than
 * `C1ScopeEvidence` (whose literal types pin `excluded: false`): a guard whose
 * violating case is unconstructible is a guard that cannot fail, so the suites
 * feed deliberately non-probative rows while production binds the real table.
 */
export interface C1EvidenceRowLike {
  readonly document_id: string;
  readonly kind: string;
  readonly chain_reader_probative: boolean;
  readonly batch_minted_on_correct_contract: boolean;
  readonly recorded_mint_tx_hash: string | null;
  readonly excluded: boolean;
}

/** The pinned C1 populations, derived from the ONE evidence table (no copy). */
export function expectedC1Populations(
  rows: readonly C1EvidenceRowLike[] = C1_SCOPE_EVIDENCE,
): {
  readonly missingSnapshot: readonly string[];
  readonly orphans: readonly string[];
} {
  return {
    missingSnapshot: rows
      .filter((row) => row.kind === 'batch_without_snapshot')
      .map((row) => row.document_id)
      .sort(),
    orphans: rows
      .filter((row) => row.kind === 'orphan_snapshot')
      .map((row) => row.document_id)
      .sort(),
  };
}

/** Every evidence row must itself be probative, or the pin proves nothing. */
export function evidencePinsProbative(
  rows: readonly C1EvidenceRowLike[] = C1_SCOPE_EVIDENCE,
): boolean {
  return rows.length > 0 && rows.every((row) =>
    row.chain_reader_probative === true
    && row.batch_minted_on_correct_contract === true
    && typeof row.recorded_mint_tx_hash === 'string'
    && /^0x[0-9a-f]{64}$/.test(row.recorded_mint_tx_hash)
    && row.excluded === false);
}

function sortedEqual(a: readonly string[], b: readonly string[]): boolean {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((value, index) => value === y[index]);
}

export type VarianceVerdict = 'pass' | 'documented_variance' | 'fail';

/**
 * C1 verdict. `pass` when the graph is complete; `documented_variance` when the
 * ONLY incompleteness is EXACTLY the evidenced five (real mints on retired
 * contracts, confirmed on chain, never allowlistable) and the evidence table is
 * itself probative; `fail` otherwise. A batch marked minted with no durable
 * transaction is a phantom-mint signal and is never a variance.
 */
export function judgeC1(
  populations: {
    readonly missingSnapshot: readonly string[];
    readonly markedWithoutTx: readonly string[];
    readonly orphans: readonly string[];
  },
  rows: readonly C1EvidenceRowLike[] = C1_SCOPE_EVIDENCE,
): VarianceVerdict {
  if (populations.markedWithoutTx.length > 0) return 'fail';
  if (populations.missingSnapshot.length === 0 && populations.orphans.length === 0) return 'pass';
  if (!evidencePinsProbative(rows)) return 'fail';
  const expected = expectedC1Populations(rows);
  return sortedEqual(populations.missingSnapshot, expected.missingSnapshot)
    && sortedEqual(populations.orphans, expected.orphans)
    ? 'documented_variance'
    : 'fail';
}

// ─── C6: the legacy Genesis pool/ledger variance (downgrade,) ──

/**
 * The one evidenced C6 variance: the wallet-ledger total exceeds the pool
 * counter by 0.0002010601167 PVT. Its cause is the deleted launch-cleanup
 * script that decremented `pool_minted_pvt` with no ledger write (;
 * removed the script and `judgeC6Downgrade` re-derives both proofs on
 * every run). Pinned as the DELTA, not the two totals, because every surviving
 * writer moves pool and ledger together by the same amount
 * (`genesis-pool-counter.ts`), which preserves the delta and nothing else.
 *
 * The tolerance absorbs IEEE-754 noise only: both totals are JS doubles near
 * 425, whose spacing is ~5.7e-14, so a same-amount move of both can shift the
 * computed delta by ~1e-13. One nano-PVT is a million times that noise and
 * billions of times smaller than the smallest Genesis grant (25 PVT), so any
 * real divergence fails.
 */
export const C6_DOCUMENTED_VARIANCE = {
  ledger_minus_pool_pvt: 0.0002010601167,
  tolerance_pvt: 1e-9,
  observed: {
    pool_minted_pvt: 424.74464478098866,
    wallet_ledger_issued_total_pvt: 424.74484584110536,
    wallet_ledger_count: 6,
  },
  record: ' (C6 downgrade, documented variance); (pinned so a healthy relay deploy prints no failure)',
} as const;

/**
 * C6 verdict. `pass` when pool and ledger agree exactly (or both are absent);
 * `documented_variance` only when the downgrade's two proofs hold AND the
 * observed delta is the evidenced one; `fail` otherwise.
 */
export function judgeC6(
  pool: number | null,
  ledgerTotal: number,
  ledgerCount: number,
  downgrade: C6DowngradeVerdict | null | undefined,
  pinned: { readonly ledger_minus_pool_pvt: number; readonly tolerance_pvt: number }
    = C6_DOCUMENTED_VARIANCE,
): VarianceVerdict {
  if (pool === null && ledgerCount === 0) return 'pass';
  if (pool !== null && pool === ledgerTotal) return 'pass';
  if (pool === null || !Number.isFinite(pool) || !Number.isFinite(ledgerTotal)) return 'fail';
  if (downgrade?.downgrade_eligible !== true) return 'fail';
  const delta = ledgerTotal - pool;
  return Math.abs(delta - pinned.ledger_minus_pool_pvt) <= pinned.tolerance_pvt
    ? 'documented_variance'
    : 'fail';
}

// ─── C8: the retired operator stub in the Genesis outbox ────────────

/**
 * A Genesis-outbox document that is NOT a qualification, a grant, or a
 * reservation, retired with a record. It is matched by exact id AND exact
 * content: one more field, one changed value, or the same content under
 * another id is an unknown-schema row and fails C8.
 */
export interface RetiredBacklogStub {
  readonly collection: string;
  readonly document_id: string;
  /** The document's complete content, field for field. */
  readonly exact_content: Readonly<Record<string, string | number>>;
  readonly record: string;
}

export const RETIRED_GENESIS_BACKLOG_STUBS: readonly RetiredBacklogStub[] = [
  {
    collection: 'genesis_qualification_outbox_v2',
    document_id: 'gq_82347a6c29768df39457cf77b09',
    exact_content: {
      status: 'denied',
      denial_reason: 'operator_revoked_dud_device',
      updated_at_ms: 1787674436924,
    },
    record: '. Written 2026-08-25T16:13:56Z by the WS6 operator cleanup that denied the '
      + 'superseded "my-computer" device registration (dev_b9c32770…). The update was keyed on a '
      + 'TRUNCATED id, so it created this 3-field document instead of updating the real '
      + 'qualification gq_82347a6c…dffc6120a (which it then updated correctly 49 s later). It has '
      + 'no schema, wallet, act, amount, or reservation; the Genesis inlet reads only '
      + "status == 'complete', so it never admitted anything. Retired here in place (the operator: no "
      + 'physical deletion of Genesis records).',
  },
];

/** True iff `(collection, id, row)` is exactly a retired stub. */
export function isRetiredBacklogStub(
  collection: string,
  documentId: string,
  row: Readonly<Record<string, unknown>>,
  stubs: readonly RetiredBacklogStub[] = RETIRED_GENESIS_BACKLOG_STUBS,
): boolean {
  const stub = stubs.find((s) => s.collection === collection && s.document_id === documentId);
  if (stub === undefined) return false;
  const expectedKeys = Object.keys(stub.exact_content).sort();
  const actualKeys = Object.keys(row).sort();
  if (!sortedEqual(expectedKeys, actualKeys)) return false;
  return expectedKeys.every((key) => row[key] === stub.exact_content[key]);
}
