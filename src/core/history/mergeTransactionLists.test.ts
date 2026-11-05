import { describe, it, expect } from 'vitest';
import { mergeTransactionLists } from './mergeTransactionLists';
import type { Transaction } from './TransactionHistoryService';

const row = (over: Partial<Transaction>): Transaction => ({
    id: 'Base-0xaa', hash: '0xaa', type: 'sent', status: 'confirmed', chain: 'Base', from: '0xme', to: '0xyou',
    amount: '1', symbol: 'USDC', timestamp: 1, ...over,
});

describe('mergeTransactionLists (2026-10-17)', () => {
    it('RED: a locally inserted send yields to the indexed row for the same transfer', () => {
        const local = row({ id: 'local-1', hash: '0xAA', timestamp: 5 });
        const indexed = row({ id: 'Base-0xaa-u1', hash: '0xaa', timestamp: 4 });
        const merged = mergeTransactionLists([local], [indexed]);
        expect(merged.map((t) => t.id)).toEqual(['Base-0xaa-u1']);
    });

    it('keeps a local row whose transfer the indexer has not returned, and distinct indexed rows that share a hash', () => {
        const local = row({ id: 'local-2', hash: '0xbb' });
        const approve = row({ id: 'Base-0xcc-approve-3', hash: '0xcc', type: 'approve' });
        const transfer = row({ id: 'Base-0xcc-u9', hash: '0xcc' });
        const merged = mergeTransactionLists([local, approve], [transfer]);
        expect(merged.map((t) => t.id).sort()).toEqual(['Base-0xcc-approve-3', 'Base-0xcc-u9', 'local-2']);
    });

    it('the same hash on ANOTHER chain is a different transfer', () => {
        const local = row({ id: 'local-3', hash: '0xdd', chain: 'Arbitrum' });
        const indexed = row({ id: 'Base-0xdd', hash: '0xdd', chain: 'Base' });
        expect(mergeTransactionLists([local], [indexed]).map((t) => t.id).sort()).toEqual(['Base-0xdd', 'local-3']);
    });

    it('incoming rows replace cached rows by id', () => {
        const stale = row({ id: 'Base-0xee', hash: '0xee', status: 'pending' });
        const fresh = row({ id: 'Base-0xee', hash: '0xee', status: 'confirmed' });
        expect(mergeTransactionLists([stale], [fresh])).toEqual([fresh]);
    });
});
