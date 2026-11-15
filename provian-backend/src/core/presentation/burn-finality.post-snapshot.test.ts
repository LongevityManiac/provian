/**
 * a burn mined on the retired kernel AFTER the migration snapshot is revoked, FINAL or
 * provisional, with every benefit it backs; nothing else is touched.
 *
 * RED controls (each case below admits or revokes wrongly if its guard is removed):
 * - a successor-kernel burn after the cutoff is never revoked;
 * - a predecessor burn AT the cutoff (carried by the snapshot) is never revoked;
 * - a receipt for a different tx, a reverted receipt, or a mismatched amount / burner is never used;
 * - a FINAL predecessor burn after the cutoff IS revoked (the `revokeBurn` refuses finals).
 */
import { ethers } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import {
  BURN_REVOCATIONS_COLLECTION,
  POST_SNAPSHOT_PREDECESSOR_BURN_REASON,
  revokePostSnapshotPredecessorBurn,
} from './burn-finality';
import { assertBurnRowUsable, BURN_REVOKED } from '../commons/burn-consumption';
import { PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK, PREDECESSOR_PVT9_KERNEL_BASE } from '../agent-bank/pvt-principal-config';
import deployment from '../../../../contracts/deployments/base-pvt9-institutions.json';

const B = 'b'.repeat(64);
const TX = `0x${'a'.repeat(64)}`;
const ADDR = '0x1111111111111111111111111111111111111111';
const AMOUNT = 15n * 10n ** 18n;
const CUTOFF = PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK;
const SUCCESSOR_KERNEL = deployment.successorKernel.pvt9Kernel.address;
const T0 = 1_790_000_000_000;
const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const topic = (a: string) => ethers.zeroPadValue(a, 32);

function receipt(over: { token?: string; block?: number; status?: number; hash?: string; from?: string; amount?: bigint } = {}): ethers.TransactionReceipt {
  return {
    hash: over.hash ?? TX,
    status: over.status ?? 1,
    blockNumber: over.block ?? CUTOFF + 40,
    logs: [{
      address: over.token ?? PREDECESSOR_PVT9_KERNEL_BASE,
      topics: [TRANSFER, topic(over.from ?? ADDR), topic(ethers.ZeroAddress)],
      data: ethers.toBeHex(over.amount ?? AMOUNT, 32),
    }],
  } as unknown as ethers.TransactionReceipt;
}

function seed(fs: FakeFirestore, finality: 'final' | 'provisional'): void {
  fs.store.set(`pvt_burn_records/${B}`, {
    tx_hash: TX, chain: 'base', wallet_id: 'wallet_aw_1', owner_kind: 'agent', owner_id: 'agent_1',
    burner_address: ADDR, amount_atomic: AMOUNT.toString(), status: 'recorded', verified: true,
    block_number: CUTOFF + 40, recorded_at: T0, accepted_at: T0, finality,
  });
  fs.store.set(`burn_consumptions/${B}`, { burn_id: B, product: 'presentation', wallet_id: 'wallet_aw_1', ref: 'jti', consumed_at: T0 });
  fs.store.set(`commons_presentations/${B}`, { burn_id: B, wallet_id: 'wallet_aw_1', audience: 'provian:commons', recorded_at: T0 });
}

function deps(fs: FakeFirestore) {
  return { db: fs as unknown as Firestore, now: () => T0 + 60_000 };
}

describe(' revokePostSnapshotPredecessorBurn', () => {
  it('binds the predecessor kernel to the deployment record and the cutoff to the config', () => {
    expect(PREDECESSOR_PVT9_KERNEL_BASE.toLowerCase()).toBe(deployment.predecessor.pvt9Kernel.toLowerCase());
    expect(SUCCESSOR_KERNEL.toLowerCase()).not.toBe(PREDECESSOR_PVT9_KERNEL_BASE.toLowerCase());
  });

  it.each(['final', 'provisional'] as const)('revokes a %s predecessor burn mined after the cutoff, with its benefit', async (finality) => {
    const fs = createFakeFirestore();
    seed(fs, finality);
    await expect(revokePostSnapshotPredecessorBurn(deps(fs), B, receipt(), CUTOFF)).resolves.toBe('revoked');
    const row = fs.store.get(`pvt_burn_records/${B}`) as Record<string, unknown>;
    expect(row.status).toBe('revoked');
    expect(row.revoke_reason).toBe(POST_SNAPSHOT_PREDECESSOR_BURN_REASON);
    expect(row.revoked_predecessor_block).toBe(CUTOFF + 40);
    expect(() => assertBurnRowUsable(row, 'wallet_aw_1', 0n)).toThrow(BURN_REVOKED);
    // The benefit is gone, audited; the consumption marker stays (the burn stays consumed).
    expect(fs.store.has(`commons_presentations/${B}`)).toBe(false);
    expect(fs.store.has(`${BURN_REVOCATIONS_COLLECTION}/${B}/benefits/commons_presentations__${B}`)).toBe(true);
    expect(fs.store.has(`burn_consumptions/${B}`)).toBe(true);
    // Idempotent.
    await expect(revokePostSnapshotPredecessorBurn(deps(fs), B, receipt(), CUTOFF)).resolves.toBe('already_revoked');
  });

  const untouched: Array<[string, ethers.TransactionReceipt]> = [
    ['RED: a successor-kernel burn after the cutoff', receipt({ token: SUCCESSOR_KERNEL })],
    ['RED: a predecessor burn AT the cutoff (carried by the snapshot)', receipt({ block: CUTOFF })],
    ['RED: a receipt for a different tx', receipt({ hash: `0x${'e'.repeat(64)}` })],
    ['RED: a reverted receipt', receipt({ status: 0 })],
    ['RED: a burn log for a different amount', receipt({ amount: AMOUNT - 1n })],
    ['RED: a burn log from a different burner', receipt({ from: '0x2222222222222222222222222222222222222222' })],
  ];
  it.each(untouched)('%s is not applicable and leaves the row and benefit untouched', async (_label, r) => {
    const fs = createFakeFirestore();
    seed(fs, 'final');
    const before = JSON.stringify(fs.store.get(`pvt_burn_records/${B}`));
    await expect(revokePostSnapshotPredecessorBurn(deps(fs), B, r, CUTOFF)).resolves.toBe('not_applicable');
    expect(JSON.stringify(fs.store.get(`pvt_burn_records/${B}`))).toBe(before);
    expect(fs.store.has(`commons_presentations/${B}`)).toBe(true);
  });

  it('a missing row or a non-Base row is not applicable', async () => {
    const fs = createFakeFirestore();
    await expect(revokePostSnapshotPredecessorBurn(deps(fs), B, receipt(), CUTOFF)).resolves.toBe('not_applicable');
    seed(fs, 'final');
    fs.store.set(`pvt_burn_records/${B}`, { ...(fs.store.get(`pvt_burn_records/${B}`) as object), chain: 'arbitrum' });
    await expect(revokePostSnapshotPredecessorBurn(deps(fs), B, receipt(), CUTOFF)).resolves.toBe('not_applicable');
  });

  it('a pending marker (a recording in flight) is never revoked', async () => {
    const fs = createFakeFirestore();
    seed(fs, 'final');
    fs.store.set(`pvt_burn_records/${B}`, { ...(fs.store.get(`pvt_burn_records/${B}`) as object), status: 'pending' });
    await expect(revokePostSnapshotPredecessorBurn(deps(fs), B, receipt(), CUTOFF)).resolves.toBe('not_applicable');
  });
});
