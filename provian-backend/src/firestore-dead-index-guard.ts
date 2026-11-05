/**
 * Guard for the two DEAD `pe_history` composite indexes deleted in the
 * close-out — `(minted ASC, timestamp ASC)` and `(userId ASC, minted ASC,
 * timestamp DESC)` and for the retired PVTv8 `minted` boolean they were
 * built on.
 *
 * WHAT WAS PROVEN before deleting them: every query on `minted` in the tree
 * (`scripts/migrate-mint-status.ts`, `scripts/count-pe-data.ts`,
 * `scripts/count-pe-data2.ts`) is a single-field equality with NO `orderBy`,
 * which Firestore serves from the automatic single-field index. No composite
 * index that includes `minted` served any query, so every PE write maintained
 * both for nothing — and both were low-cardinality-led, the H5 sequential-
 * hotspot shape.
 *
 * WHAT THIS GUARD KEEPS TRUE: (1) no query on `minted` ever acquires an
 * `orderBy` (the shape that WOULD need one of the deleted indexes back — and
 * would 500 in production without it, the / class); (2) the declared
 * index file never re-grows a `pe_history` composite index on `minted`. Both
 * checks are pure functions over source text / the parsed index file, so the
 * suite can feed them a deliberately violating input and see it named.
 */

export interface MintedQueryFinding {
  readonly file: string;
  readonly line: number;
  /** The query chain from the `minted` where-clause to its terminal `.get()` / `.count()` / `;`. */
  readonly chain: string;
  readonly ordered: boolean;
}

/** A where-clause naming the `minted` field (single- or double-quoted) — the only shapes a literal query on it can take. */
const MINTED_WHERE = /\.where\(\s*['"]minted['"]/g;
/** The chain ends at the first terminal call, statement end, or a blank line. */
const CHAIN_TERMINATOR = /\.get\(\)|\.count\(\)|;|\n\s*\n/;

/**
 * Every literal query on `minted` in `source`, with whether its chain carries
 * an `orderBy`. Pure over text — bind it to the real tree in the test, and to
 * a planted violation in the control.
 */
export function findMintedQueries(file: string, source: string): MintedQueryFinding[] {
  const findings: MintedQueryFinding[] = [];
  for (const match of source.matchAll(MINTED_WHERE)) {
    const start = match.index ?? 0;
    const rest = source.slice(start);
    const end = rest.search(CHAIN_TERMINATOR);
    const chain = end === -1 ? rest : rest.slice(0, end);
    const line = source.slice(0, start).split('\n').length;
    findings.push({ file, line, chain, ordered: /\.orderBy\(/.test(chain) });
  }
  return findings;
}

export interface DeclaredIndex {
  readonly collectionGroup?: string;
  readonly fields?: ReadonlyArray<{ readonly fieldPath?: string }>;
}

/** Declared `pe_history` composite indexes that include the retired `minted` field. */
export function findMintedPeHistoryIndexes(indexes: readonly DeclaredIndex[]): DeclaredIndex[] {
  return indexes.filter((index) => index.collectionGroup === 'pe_history'
    && (index.fields ?? []).some((field) => field.fieldPath === 'minted'));
}

/**
 * The three LEGACY `mint_status`-led, timestamp-ordered `pe_history` shapes the
 * H5 migration replaced with their `index_shard`-prefixed twins —
 * `(mint_status, timestamp)`, `(mint_status, jurisdiction_context, timestamp)`
 * and `(mint_status, timestamp, peId)`. They were deleted LIVE after the reader
 * cutover (`scripts/backfill-pe-history-index-shard.ts --cutover`,) and
 * removed from the declared file in the same change, because
 * `deploy-firestore-indexes.js` is additive and would otherwise re-create them
 * at the next deploy. `(mint_status, peId)` is NOT legacy — the settlement
 * claim inlet reads it — so the detector keys on a `mint_status`-LED index that
 * also carries `timestamp`, which is exactly the sequential-hotspot shape and
 * matches none of the surviving indexes.
 */
export function findLegacyMintStatusPeHistoryIndexes(indexes: readonly DeclaredIndex[]): DeclaredIndex[] {
  return indexes.filter((index) => {
    if (index.collectionGroup !== 'pe_history') return false;
    const fields = index.fields ?? [];
    return fields[0]?.fieldPath === 'mint_status'
      && fields.some((field) => field.fieldPath === 'timestamp');
  });
}
