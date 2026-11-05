/**
 * the Firestore write-surface pattern table, ALONE in its own
 * module.
 *
 * WHY IT IS SEPARATE. A table of write-API names necessarily CONTAINS write-API
 * names, so the scan that uses it matches itself. The tempting fixes are both
 * wrong: narrowing the patterns until they stop self-matching narrows them until
 * they stop catching real writes, and exempting the whole guard module exempts
 * the guard from its own rule. Isolating the table is the honest third option —
 * exactly one file is scan-exempt, it is this one, and the exemption is itself
 * asserted by test (`cutover-wp12r3.test.ts`): this module must import nothing,
 * export nothing but the table, and mention no database handle.
 *
 * THE PATTERNS RUN OVER FLATTENED SOURCE (`flattenForScanning`), so `\s*`
 * between tokens spans newlines. That is not cosmetic — the reviewer
 * demonstrated that a line-scoped version of this table missed the repo's
 * DOMINANT write idioms: chained `db.collection(x)\n.doc(y)\n.update({...})`,
 * multi-line object literals, and `ref` bindings on their own line. Every
 * pattern still requires CALL syntax; a bare identifier is not a write.
 */

export interface WriteSurfacePattern {
  readonly name: string;
  readonly re: RegExp;
}

/** The write verbs, as an alternation fragment. */
const VERBS = '(?:set|update|delete|create|add)';

export const FIRESTORE_WRITE_SURFACE_PATTERNS: readonly WriteSurfacePattern[] = [
  {
    name: 'FieldValue mutation',
    re: /\bFieldValue\s*\.\s*(?:increment|serverTimestamp|arrayUnion|arrayRemove|delete)\s*\(/,
  },
  { name: 'runTransaction', re: /\brunTransaction\s*\(/ },
  { name: 'write batch', re: /\bWriteBatch\b|\.\s*batch\s*\(\s*\)/ },
  { name: 'bulkWriter', re: /\bbulkWriter\b/i },
  {
    // `collection(x).doc(y).set(` — including every intervening newline, and
    // any number of chained hops between the ref builder and the verb.
    name: 'write on a doc()/collection() ref',
    re: new RegExp(`\\b(?:doc|collection|collectionGroup)\\s*\\([^;]{0,400}?\\.\\s*${VERBS}\\s*\\(`),
  },
  {
    // Any binding whose name ends in ref/doc/snapshot — CASE-INSENSITIVE,
    // because `ref.set(` (lowercase) is this repo's commonest spelling and the
    // capitalised-only form missed it.
    name: 'write on a *ref / *doc binding',
    re: new RegExp(`\\b\\w*(?:ref|doc|snap|snapshot)\\s*\\.\\s*${VERBS}\\s*\\(`, 'i'),
  },
  {
    // A transaction handle, however it is named.
    name: 'write on a transaction handle',
    re: new RegExp(`\\b(?:txn|tx|transaction|batch|writer)\\s*\\.\\s*${VERBS}\\s*\\(`, 'i'),
  },
  {
    // A money counter assigned INSIDE AN OPEN WRITE CALL — the last line of
    // defence for a corrective write whose receiver this table does not know.
    // The write verb's parenthesis must still be open when the assignment
    // appears, so an interface declaration or a read-model object carrying the
    // same field is not a write and does not trip it.
    name: 'money counter assigned inside a write call',
    re: new RegExp(
      `\\b${VERBS}\\s*\\([^;]{0,400}?\\b(?:pool_minted_pvt|issued_pvt|total_pvt_minted)\\s*:`,
    ),
  },
];
