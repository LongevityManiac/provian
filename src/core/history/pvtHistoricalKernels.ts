/**
 * PVT kernels whose past MINTS the transaction history still recognises as earnings.
 *
 * The PVT9 kernel was retired by the migration: every balance on it was carried
 * 1:1 to the successor (`PVT9_TOKEN`), it is held, and its minter is revoked. The PVT a wallet
 * EARNED there before the migration is still that wallet's earning history, so an incoming
 * mint from it keeps reading as "earned" rather than an anonymous receive from 0x0000.
 *
 * HISTORY RECOGNITION ONLY. Nothing sends to, reads a balance from, approves, or burns on this
 * address — every live path uses `PVT9_TOKEN`. It is the one file in the app allowed to name a
 * retired PVT address (the `check:wp2` legacy-address audit exempts exactly this path and this
 * address), and `pvtHistoricalKernels.test.ts` pins that it is never the live token.
 */
export const PREDECESSOR_PVT9_KERNEL_FOR_HISTORY = '0x4Bf02d5C9bC4306c38603EF2aA164f2f2273bcd7' as const;

/**
 * the migration snapshot block. The retired kernel is held and its minter revoked, but
 * its `_transfer` has no hold check: anyone still holding retired PVT can move it AFTER the
 * migration. So a transfer on it is this wallet's PVT history only at or before this block;
 * anything later is not PVT and must never read as a genuine receive.
 *
 * It is the relay's `PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK` (provian-backend
 * `core/agent-bank/pvt-principal-config.ts`) and the deployment record's
 * `successorKernel.snapshotBlock`. It is repeated here as a literal because the mobile bundle
 * cannot import backend code (the `genesisWindow.ts` pattern); `pvtHistoryVisibility.test.ts`
 * pins it to BOTH sources so it cannot drift.
 */
export const PREDECESSOR_PVT9_MIGRATION_SNAPSHOT_BLOCK = 51_823_797;

/**
 * True when a transfer on the retired kernel is pre-migration history. FAIL CLOSED: a row with
 * no block number cannot be placed before the snapshot, so it is not history.
 */
export function isPreMigrationPredecessorBlock(blockNumber: number | undefined): boolean {
    return typeof blockNumber === 'number'
        && Number.isFinite(blockNumber)
        && blockNumber <= PREDECESSOR_PVT9_MIGRATION_SNAPSHOT_BLOCK;
}

/**
 * the keyless one-shot migration distributor. It received the replayed predecessor
 * history on the successor kernel and paid every predecessor balance 1:1, so an incoming
 * transfer of the LIVE token (`PVT9_TOKEN`) from this address is that wallet's migration
 * receipt — its old balance carried over — not an ordinary receive. HISTORY LABELLING ONLY:
 * nothing sends to it or reads from it. Pinned to `contracts/deployments/base-pvt9-institutions.json`
 * (`successorKernel.migrationDistributor.address`) by `pvtHistoryVisibility.test.ts`.
 */
export const PVT_MIGRATION_DISTRIBUTOR = '0xf674f1A915862430C9d0Da994f1B9EA5Dd0c71Ed' as const;
