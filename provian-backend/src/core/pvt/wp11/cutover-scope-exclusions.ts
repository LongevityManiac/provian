/**
 * Per-document C1 scope evidence for the legacy-to-current kernel cut line.
 *
 * An artifact can be excluded only when all three proofs hold: its own contract
 * reports no batch mint (or it has no digest), no wallet ledger entry references
 * it, and no pool_minted_pvt contribution derives from it. A date or legacy
 * schema alone cannot establish that no value attaches.
 *
 * Every recorded item here has a successful mint receipt and batchMinted=true
 * on its own receipt-resolved legacy contract. All remain in scope. The empty
 * exclusion set is enforced by deriveScopeExclusions; a real mint cannot be
 * allowlisted. Queries against a different token's contract are not probative.
 * This module is a read-only evidence table and membership test.
 */

import { deriveScopeExclusions } from './cutover-hard-stops';

/** Which C1 population an item belongs to. */
export type C1ItemKind = 'batch_without_snapshot' | 'orphan_snapshot';

/** Whether an orphan snapshot's batch doc was DELETED or NEVER CREATED. */
export type OrphanBatchOrigin = 'deleted' | 'never_created' | 'undetermined';

export interface C1ScopeEvidence {
  /** Exact Firestore document id (the batch id / snapshot id). */
  readonly document_id: string;
  readonly kind: C1ItemKind;
  /**
   * (a) `batchMinted(bytes32)` on the CURRENT PVTv8 token, read live
   * 2026-07-24. `false` here is NOT probative — PVTv8 has never minted
   * anything, so it answers `false` about every digest ever created.
   */
  readonly batch_minted_on_pvtv8: boolean;
  /**
   * The PVT contract this document was actually minted against, resolved by
   * from the document's OWN mint-transaction receipt (`to` plus the log
   * emitter) — never from a field the document asserts about itself.
   */
  readonly minted_against_contract: string;
  /** `batchMinted(document_id)` asked of `minted_against_contract`. */
  readonly batch_minted_on_correct_contract: boolean;
  /** True once the reader's answer is about THIS document's contract. */
  readonly chain_reader_probative: boolean;
  /** (b) Wallet-ledger docs referencing this id. Empty = conjunct (b) holds. */
  readonly wallet_ledger_references: readonly string[];
  /** (c) Whether any `pool_minted_pvt` contribution derives from this id. */
  readonly pool_minted_contribution: boolean;
  /** The mint transaction recorded on the document itself, if any. */
  readonly recorded_mint_tx_hash: string | null;
  /** `pe_history` docs bound to this id via `mint_batch_id`. */
  readonly bound_pe_count: number;
  /** For orphan snapshots only; `undetermined` where it cannot be established. */
  readonly orphan_batch_origin: OrphanBatchOrigin;
  /** Verdict. `false` ⇒ the item is NOT excluded and C1 keeps failing on it. */
  readonly excluded: false;
  readonly rationale: string;
}

/**
 * The five C1 items, with the evidence gathered 2026-07-24 against live
 * Firestore and live Base mainnet. Every `excluded` is `false` — the type
 * itself forbids anything else, so widening the allowlist cannot be done by
 * flipping a boolean; it requires a reviewed change to this shape.
 */
export const C1_SCOPE_EVIDENCE: readonly C1ScopeEvidence[] = [
  {
    document_id: '0x1b730f3bb48e84a9ff9fdbb97522b57ff962685a3cf8e3a3a2ebc29bb8edafa0',
    kind: 'batch_without_snapshot',
    batch_minted_on_pvtv8: false,
    minted_against_contract: '0x87B2d38dAf0fE335BB6e1Bb030647667D2c63598',
    batch_minted_on_correct_contract: true,
    chain_reader_probative: true,
    wallet_ledger_references: [],
    pool_minted_contribution: false,
    recorded_mint_tx_hash: '0xcace2eb492f4409628e9d26424ab75fcc38090e88cf79f18b767c5e13cea1042',
    bound_pe_count: 30,
    orphan_batch_origin: 'undetermined',
    excluded: false,
    rationale: 'FAILS (a) ON DIRECT EVIDENCE: mint tx 0xcace2eb4… succeeded on Base at block 45553349 against PVTv4 0x87B2d38d…, and batchMinted returns TRUE there. That contract\'s live totalSupply is 27400000000000000000 — exactly the 27.4 PVT this batch records, and its entire supply. 30 pe_history docs are bound at mint_status=\"minted\". Value attached and persists on chain; not out of scope.',
  },
  {
    document_id: '0xc1ffc74839443070247b0e37c4518ddaa1f4f02e77b4d275a4889ef953e26683',
    kind: 'batch_without_snapshot',
    batch_minted_on_pvtv8: false,
    minted_against_contract: '0xE99B2EEB3da013376ee779c0e0e6c759BBb51fb4',
    batch_minted_on_correct_contract: true,
    chain_reader_probative: true,
    wallet_ledger_references: [],
    pool_minted_contribution: false,
    recorded_mint_tx_hash: '0x4c06566c8b7d8e31b34c14b8792deb6d1a13a32b3bd165117cf6b49f6c2f86e1',
    bound_pe_count: 0,
    orphan_batch_origin: 'undetermined',
    excluded: false,
    rationale: 'FAILS (a) ON DIRECT EVIDENCE: mint tx 0x4c06566c… succeeded on Base at block 44394882 against PVTv3 0xE99B2EEB…, and batchMinted returns TRUE there. That contract\'s live totalSupply is 33200000000000000000 — exactly the 33.2 PVT this batch records across 7 contributors. Its 35 pe_ids no longer resolve to pe_history docs, which makes the graph LESS complete, not more inert.',
  },
  {
    document_id: '0x4669b38dd862d86b6768edbfd141c18a4c07a3d8fec1fa4345725cbbcb5df778',
    kind: 'orphan_snapshot',
    batch_minted_on_pvtv8: false,
    minted_against_contract: '0x23D126600BA4f606240b5F60dB4B27BD0f8EC2aD',
    batch_minted_on_correct_contract: true,
    chain_reader_probative: true,
    wallet_ledger_references: [],
    pool_minted_contribution: false,
    recorded_mint_tx_hash: '0x07d89705e2f145c5318030b8ec1c50ad7078a30134d0240e3d8e3cf623632ad1',
    bound_pe_count: 1,
    orphan_batch_origin: 'undetermined',
    excluded: false,
    rationale: 'FAILS (a) ON DIRECT EVIDENCE: mint tx 0x07d89705… succeeded on Base at block 47367738 against PVTv4 0x23D1266… (base-chunk-ii), and batchMinted returns TRUE there. status=\"anchored\" with both a mint tx and an anchor tx; pe_history/pe_a9997284 is bound at mint_status=\"minted\" with estimatedPVT=10. Origin of the missing batch doc remains UNDETERMINED — no cleanup marker and no surviving trace distinguishes deleted from never-written — but that is now the ONLY open question about it, and it does not bear on scope.',
  },
  {
    document_id: '0x4b953d26337b235a9a86fea056bb4e09b9df1d74d2d0dbeea60e0ed97f513177',
    kind: 'orphan_snapshot',
    batch_minted_on_pvtv8: false,
    minted_against_contract: '0x23D126600BA4f606240b5F60dB4B27BD0f8EC2aD',
    batch_minted_on_correct_contract: true,
    chain_reader_probative: true,
    wallet_ledger_references: [],
    pool_minted_contribution: false,
    recorded_mint_tx_hash: '0x704a8aca08ecdff04fb7622399c0fa3932f32340734c6fc7b3a1d1139d9c89d6',
    bound_pe_count: 0,
    orphan_batch_origin: 'deleted',
    excluded: false,
    rationale: 'FAILS (a) ON DIRECT EVIDENCE: mint tx 0x704a8aca… succeeded on Base at block 45777056 against PVTv4 0x23D1266…, and batchMinted returns TRUE there. status=\"minted_anchor_pending\". Origin DELETED, with a mechanism: the doc carries cleanup_marker=\"chunk_ii_e2e_test_mint_partial_anchor\". A cleanup that removed the batch doc did not un-mint the PVT.',
  },
  {
    document_id: '0xace10848e897fd3cda142143d75742164a4d5340e26a7a506bef38a83b6dd056',
    kind: 'orphan_snapshot',
    batch_minted_on_pvtv8: false,
    minted_against_contract: '0x23D126600BA4f606240b5F60dB4B27BD0f8EC2aD',
    batch_minted_on_correct_contract: true,
    chain_reader_probative: true,
    wallet_ledger_references: [],
    pool_minted_contribution: false,
    recorded_mint_tx_hash: '0x833ff00a6239405e107eda60d18edb11a32cca172af97ada05b17809c0e7f33f',
    bound_pe_count: 0,
    orphan_batch_origin: 'undetermined',
    excluded: false,
    rationale: 'FAILS (a) ON DIRECT EVIDENCE: mint tx 0x833ff00a… succeeded on Base at block 45777091 against PVTv4 0x23D1266…, and batchMinted returns TRUE there — 35 blocks after its sibling 0x4b953d26…, in the same session. That sibling carries a cleanup marker and this one does not, so DELETED is likely but not established; recorded UNDETERMINED rather than assumed.',
  },
];

/**
 * Document ids ruled OUT OF SCOPE at the cut line.
 *
 * derived through `deriveScopeExclusions`, which ENFORCES the
 * hard stop rather than trusting the table. `excluded: true` is a REQUEST here,
 * not a decision — a row carrying a real mint (a recorded mint tx, a true
 * on-chain `batchMinted`, or any bound PE) is REFUSED and named in
 * `REFUSED_SCOPE_EXCLUSIONS`. Before this, the only thing standing between the
 * allowlist and a real mint was the `excluded: false` literal type, which any
 * edit widening the type would have removed silently.
 *
 * As of 2026-07-24 this set is EMPTY and nothing is refused, because no row
 * asks to be excluded.
 */
const SCOPE_DERIVATION = deriveScopeExclusions(C1_SCOPE_EVIDENCE);

export const SCOPE_EXCLUSIONS: ReadonlySet<string> = SCOPE_DERIVATION.exclusions;

/**
 * Ids that asked for exclusion while carrying a real mint, and were refused.
 * Surfaced by name: a silently dropped violation is the same failure as an
 * honoured one.
 */
export const REFUSED_SCOPE_EXCLUSIONS: readonly string[] = SCOPE_DERIVATION.refused;

/** True iff `documentId` carries a recorded, evidenced out-of-scope ruling. */
export function isScopeExcluded(documentId: string): boolean {
  return SCOPE_EXCLUSIONS.has(documentId);
}
