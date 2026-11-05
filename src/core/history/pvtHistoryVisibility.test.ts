/**
 * (item C1) — a wallet's PVT history is VISIBLE by default.
 *
 * `getTransactions` defaults to `filterVerified: true`, which keeps only transfers whose
 * token contract is on the verified allowlist. Before Base's allowlist held only
 * USDC and WETH, so every PVT row — an earning on the live token, an earning on the
 * retired kernel, and the migration receipt that carried each predecessor
 * balance 1:1 — was dropped from the default history view. A wallet holding real PVT
 * saw no record of where it came from.
 *
 * These tests drive the public `getTransactions` path (cache seeded, network refresh
 * stubbed), so they fail on the old allowlist and pass on the new one. The spam row is
 * the permanent negative control: the verified filter must STILL drop an unknown
 * contract, or "visible" would only mean "the filter stopped filtering".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ProxyConfig pulls the Expo runtime; the cache path under test never reaches the network.
vi.mock('../../services/ProxyConfig', () => ({ default: {} }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import TransactionHistoryService, { type Transaction } from './TransactionHistoryService';
import { PVT9_TOKEN } from '../chains/evm/config';
import { ZERO_ADDRESS } from './pvtMintClassifier';
import * as historicalKernels from './pvtHistoricalKernels';

const { PVT_MIGRATION_DISTRIBUTOR } = historicalKernels;

const SRC = join(__dirname, '..', '..');
const DEPLOYMENT = JSON.parse(
    readFileSync(join(SRC, '..', 'contracts', 'deployments', 'base-pvt9-institutions.json'), 'utf8'),
) as {
    predecessor: { pvt9Kernel: string };
    successorKernel: { migrationDistributor: { address: string }; snapshotBlock: number };
};
/** From the deployment record — never a second literal in app source. */
const RETIRED_KERNEL = DEPLOYMENT.predecessor.pvt9Kernel;
const DISTRIBUTOR = DEPLOYMENT.successorKernel.migrationDistributor.address;
/** The migration snapshot block, from the deployment record. */
const SNAPSHOT_BLOCK = DEPLOYMENT.successorKernel.snapshotBlock;

const WALLET = '0x1111111111111111111111111111111111111111';
const SPAM_CONTRACT = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

function row(id: string, over: Partial<Transaction>): Transaction {
    return {
        id,
        hash: `0x${id.padStart(64, '0')}`,
        type: 'received',
        status: 'confirmed',
        chain: 'Base',
        from: ZERO_ADDRESS,
        to: WALLET,
        amount: '75.00000000',
        symbol: 'PVT',
        timestamp: 1_790_000_000_000 + id.length,
        ...over,
    };
}

const EARNED_LIVE = row('earned-live', { type: 'earned', contractAddress: PVT9_TOKEN.address });
const EARNED_RETIRED = row('earned-retired', { type: 'earned', contractAddress: RETIRED_KERNEL, blockNumber: 49_500_000 });
// The retired kernel's `_transfer` has no hold check: anyone still holding retired PVT can move
// it after the migration. Such a transfer is NOT PVT and must never read as a genuine receive.
const RETIRED_POST_SNAPSHOT = row('retired-post-snapshot', {
    from: '0x2222222222222222222222222222222222222222',
    amount: '500.00000000',
    contractAddress: RETIRED_KERNEL,
    blockNumber: SNAPSHOT_BLOCK + 1,
});
const RETIRED_AT_SNAPSHOT = row('retired-at-snapshot', {
    from: '0x2222222222222222222222222222222222222222',
    contractAddress: RETIRED_KERNEL,
    blockNumber: SNAPSHOT_BLOCK,
});
const RETIRED_NO_BLOCK = row('retired-no-block', { from: '0x2222222222222222222222222222222222222222', contractAddress: RETIRED_KERNEL });
const MIGRATION_RECEIPT = row('migration', { from: DISTRIBUTOR, contractAddress: PVT9_TOKEN.address });
const SPAM = row('spam', { from: '0x2222222222222222222222222222222222222222', symbol: 'PVT', contractAddress: SPAM_CONTRACT });

async function defaultHistory(rows: Transaction[], filterVerified?: boolean): Promise<string[]> {
    vi.spyOn(AsyncStorage, 'getItem').mockImplementation(async (key: string) =>
        key === `transaction_history_${WALLET}` ? JSON.stringify(rows) : null);
    // No network in a unit test: the cache IS the population under test.
    const service = TransactionHistoryService as unknown as { fetchFromChains: () => Promise<void> };
    vi.spyOn(service, 'fetchFromChains').mockResolvedValue(undefined);
    const options = filterVerified === undefined ? {} : { filterVerified };
    const { items } = await TransactionHistoryService.getTransactions(WALLET, options);
    return items.map((tx) => tx.id);
}

describe('PVT rows are visible in the DEFAULT (verified-only) history', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('RED — a PVT earning on the live token is shown by default', async () => {
        expect(await defaultHistory([EARNED_LIVE])).toEqual(['earned-live']);
    });

    it('RED — a PVT earning on the retired kernel is shown by default', async () => {
        expect(await defaultHistory([EARNED_RETIRED])).toEqual(['earned-retired']);
    });

    it('RED — the migration receipt is shown by default', async () => {
        expect(await defaultHistory([MIGRATION_RECEIPT])).toEqual(['migration']);
    });

    it('negative control — an unknown contract calling itself PVT is STILL filtered by default', async () => {
        const all = [EARNED_LIVE, EARNED_RETIRED, MIGRATION_RECEIPT, SPAM];
        const shown = await defaultHistory(all);
        expect(shown).toHaveLength(3);
        expect(shown).not.toContain('spam');
        // …and the population was real: turning the filter off surfaces all four.
        expect(await defaultHistory(all, false)).toHaveLength(4);
    });
});

describe(' review — the retired kernel is verified ONLY up to the migration snapshot', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('the app cutoff IS the deployment record snapshot AND the relay\'s burn cutoff', () => {
        expect(historicalKernels.PREDECESSOR_PVT9_MIGRATION_SNAPSHOT_BLOCK).toBe(SNAPSHOT_BLOCK);
        const relay = readFileSync(join(SRC, '..', 'provian-backend', 'src', 'core', 'agent-bank', 'pvt-principal-config.ts'), 'utf8');
        const m = /export const PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK = ([\d_]+);/.exec(relay);
        expect(m).not.toBeNull();
        expect(Number((m as RegExpExecArray)[1].replace(/_/g, ''))).toBe(SNAPSHOT_BLOCK);
    });

    it('RED — a post-snapshot transfer on the retired kernel stays HIDDEN by default', async () => {
        expect(await defaultHistory([RETIRED_POST_SNAPSHOT])).toEqual([]);
        // …and the population was real: it is only the verified filter that hides it.
        expect(await defaultHistory([RETIRED_POST_SNAPSHOT], false)).toEqual(['retired-post-snapshot']);
    });

    it('RED — a retired-kernel row with no block number fails closed (hidden by default)', async () => {
        expect(await defaultHistory([RETIRED_NO_BLOCK])).toEqual([]);
    });

    it('a retired-kernel transfer AT the snapshot block is pre-migration history (shown)', async () => {
        expect(await defaultHistory([RETIRED_AT_SNAPSHOT])).toEqual(['retired-at-snapshot']);
    });
});

describe('a transfer from the migration distributor reads as a migration receipt', () => {
    type Normalizer = {
        normalizeAlchemyTransfer: (t: Record<string, unknown>, chain: 'Base', user: string) => Transaction;
    };
    const normalize = (from: string, contract: string, to = WALLET, blockNum = '0x1'): Transaction =>
        (TransactionHistoryService as unknown as Normalizer).normalizeAlchemyTransfer({
            hash: '0xabc',
            blockNum,
            from,
            to,
            value: 12.5,
            asset: 'PVT',
            category: 'erc20',
            rawContract: { address: contract.toLowerCase() },
            metadata: { blockTimestamp: '2026-09-26T16:00:00.000Z' },
        }, 'Base', WALLET);

    it('the app constant IS the deployment record\'s distributor', () => {
        expect(PVT_MIGRATION_DISTRIBUTOR.toLowerCase()).toBe(DISTRIBUTOR.toLowerCase());
    });

    it('RED — distributor → wallet on the live PVT token is labelled a migration receipt (and verified)', () => {
        const tx = normalize(DISTRIBUTOR.toLowerCase(), PVT9_TOKEN.address);
        expect(tx.isMigrationReceipt).toBe(true);
        expect(tx.type).toBe('received');
        expect(tx.isVerifiedToken).toBe(true);
    });

    it('negative control — a look-alike token sent from the distributor address is NOT a migration receipt', () => {
        expect(normalize(DISTRIBUTOR, SPAM_CONTRACT).isMigrationReceipt).toBe(false);
    });

    it('negative control — an ordinary PVT transfer from someone else is NOT a migration receipt', () => {
        expect(normalize('0x2222222222222222222222222222222222222222', PVT9_TOKEN.address).isMigrationReceipt).toBe(false);
    });

    it('RED — a post-snapshot retired-kernel transfer normalises UNVERIFIED and is marked retired', () => {
        const tx = normalize('0x2222222222222222222222222222222222222222', RETIRED_KERNEL, WALLET, `0x${(SNAPSHOT_BLOCK + 1).toString(16)}`);
        expect(tx.isVerifiedToken).toBe(false);
        expect(tx.isRetiredPvt).toBe(true);
    });

    it('a pre-snapshot retired-kernel transfer normalises verified and is marked retired (historical)', () => {
        const tx = normalize(ZERO_ADDRESS, RETIRED_KERNEL, WALLET, `0x${SNAPSHOT_BLOCK.toString(16)}`);
        expect(tx.isVerifiedToken).toBe(true);
        expect(tx.isRetiredPvt).toBe(true);
        expect(tx.type).toBe('earned');
    });

    it('a live-token transfer is never marked retired', () => {
        expect(normalize(DISTRIBUTOR, PVT9_TOKEN.address).isRetiredPvt).toBe(false);
    });

    it('negative control — an OUTGOING transfer is never a migration receipt', () => {
        expect(normalize(DISTRIBUTOR, PVT9_TOKEN.address, '0x3333333333333333333333333333333333333333').isMigrationReceipt)
            .toBe(false);
    });
});
