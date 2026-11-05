import type { Transaction } from './TransactionHistoryService';

/** True for a row the app inserted itself after sending, before the indexer returned it. */
export function isLocalTransactionRow(tx: Pick<Transaction, 'id'>): boolean {
    return tx.id.startsWith('local-');
}

/**
 * Merge cached and freshly indexed rows by id, except that a locally inserted row yields to the
 * indexed row for the same (chain, hash): the two described one transfer and were both shown
 * until this (2026-10-17 bug check). Distinct indexed rows that share a hash (an approval and a
 * transfer in one transaction) keep their own ids and are never collapsed.
 */
export function mergeTransactionLists(existing: readonly Transaction[], incoming: readonly Transaction[]): Transaction[] {
    const byId = new Map<string, Transaction>();
    for (const tx of existing) byId.set(tx.id, tx);
    for (const tx of incoming) byId.set(tx.id, tx);
    const indexed = new Set<string>();
    for (const tx of byId.values()) {
        if (!isLocalTransactionRow(tx)) indexed.add(`${tx.chain}:${tx.hash.toLowerCase()}`);
    }
    return Array.from(byId.values()).filter(
        (tx) => !(isLocalTransactionRow(tx) && indexed.has(`${tx.chain}:${tx.hash.toLowerCase()}`)),
    );
}

