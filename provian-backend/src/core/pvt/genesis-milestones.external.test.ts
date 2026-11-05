/**
 * External-address forward outbound milestone scanner (Unit 3).
 *
 * Proves the no-retro fence at the query level: rewards are a function ONLY of
 * (current_nonce - baseline_nonce); the scanner never reads a block at/below the
 * fence, so pre-proof history (absorbed into baseline) can never reward. Also
 * covers parity (first_tx + sustained), exactly-once, shared-marker no-double-dip
 * with the native scanners, and lazy baseline establishment.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import {
  scanExternalOutboundMilestones,
  type ExternalOutboundScanDeps,
  type ExternalOutboundTarget,
} from './genesis-milestones';

const FIRSTTX_COLLECTION = 'genesis_wallet_firsttx';
const SUSTAINED_COLLECTION = 'genesis_wallet_sustained';

function target(overrides: Partial<ExternalOutboundTarget> = {}): ExternalOutboundTarget {
  return {
    walletId: 'wallet_aw_a', // agent's native wallet id (shared ledger + marker key)
    agentId: 'agent_a',
    address: '0xexternal',
    provenAtMs: 1_000,
    baselineNonce: 500, // heavy pre-proof history
    ...overrides,
  };
}

interface PaidCall {
  address: string;
  walletId: string;
  eventType: 'agent_first_transaction' | 'agent_sustained_activity';
}

function makeDeps(
  fake: FakeFirestore,
  targets: ExternalOutboundTarget[],
  opts: { nonces: Record<string, number>; threshold?: number; payThrows?: boolean },
): { deps: ExternalOutboundScanDeps; paid: PaidCall[]; persisted: Array<{ address: string; nonce: number }> } {
  const paid: PaidCall[] = [];
  const persisted: Array<{ address: string; nonce: number }> = [];
  const deps: ExternalOutboundScanDeps = {
    db: fake as unknown as Firestore,
    listTargets: async () => targets,
    getCurrentNonce: async (address) => opts.nonces[address] ?? 0,
    persistBaseline: async (address, nonce) => { persisted.push({ address, nonce }); return nonce; },
    loadSustainedTxThreshold: async () => opts.threshold ?? 20,
    payMilestone: async (t, eventType) => {
      if (opts.payThrows) throw new Error('payout boom');
      paid.push({ address: t.address, walletId: t.walletId, eventType });
      return { bountyPvt: eventType === 'agent_first_transaction' ? 100 : 500 };
    },
    now: () => 5_000,
  };
  return { deps, paid, persisted };
}

describe('scanExternalOutboundMilestones - no-retro fence', () => {
  it('rewards NOTHING when current nonce == baseline (all pre-proof history)', async () => {
    const fake = createFakeFirestore();
    const { deps, paid } = makeDeps(fake, [target({ baselineNonce: 500 })], { nonces: { '0xexternal': 500 } });
    const report = await scanExternalOutboundMilestones(deps);
    expect(report.not_yet).toBe(1);
    expect(report.first_tx_emitted).toBe(0);
    expect(report.sustained_emitted).toBe(0);
    expect(paid).toHaveLength(0);
  });

  it('rewards NOTHING when current nonce < baseline (cannot go negative)', async () => {
    const fake = createFakeFirestore();
    const { deps, paid } = makeDeps(fake, [target({ baselineNonce: 500 })], { nonces: { '0xexternal': 499 } });
    const report = await scanExternalOutboundMilestones(deps);
    expect(report.not_yet).toBe(1);
    expect(paid).toHaveLength(0);
  });

  it('emits first_tx on the FIRST post-proof outbound tx (delta 1)', async () => {
    const fake = createFakeFirestore();
    const { deps, paid } = makeDeps(fake, [target({ baselineNonce: 500 })], { nonces: { '0xexternal': 501 } });
    const report = await scanExternalOutboundMilestones(deps);
    expect(report.first_tx_emitted).toBe(1);
    expect(report.bounty_pvt_granted).toBe(100);
    expect(paid).toEqual([{ address: '0xexternal', walletId: 'wallet_aw_a', eventType: 'agent_first_transaction' }]);
    // Marker keyed by the agent's NATIVE walletId.
    expect(fake.store.get(`${FIRSTTX_COLLECTION}/wallet_aw_a`)).toBeTruthy();
  });
});

describe('scanExternalOutboundMilestones - parity + exactly-once', () => {
  it('emits BOTH first_tx and sustained when delta >= threshold', async () => {
    const fake = createFakeFirestore();
    const { deps, paid } = makeDeps(fake, [target({ baselineNonce: 500 })], { nonces: { '0xexternal': 520 }, threshold: 20 });
    const report = await scanExternalOutboundMilestones(deps);
    expect(report.first_tx_emitted).toBe(1);
    expect(report.sustained_emitted).toBe(1);
    expect(paid.map((p) => p.eventType).sort()).toEqual(['agent_first_transaction', 'agent_sustained_activity']);
  });

  it('emits first_tx but NOT sustained when delta < threshold', async () => {
    const fake = createFakeFirestore();
    const { deps, paid } = makeDeps(fake, [target({ baselineNonce: 500 })], { nonces: { '0xexternal': 505 }, threshold: 20 });
    const report = await scanExternalOutboundMilestones(deps);
    expect(report.first_tx_emitted).toBe(1);
    expect(report.sustained_emitted).toBe(0);
    expect(paid).toHaveLength(1);
  });

  it('is exactly-once: a second scan does not re-pay', async () => {
    const fake = createFakeFirestore();
    const { deps, paid } = makeDeps(fake, [target({ baselineNonce: 500 })], { nonces: { '0xexternal': 530 }, threshold: 20 });
    await scanExternalOutboundMilestones(deps);
    const report2 = await scanExternalOutboundMilestones(deps);
    expect(report2.first_tx_emitted).toBe(0);
    expect(report2.sustained_emitted).toBe(0);
    expect(report2.already_marked).toBeGreaterThanOrEqual(1);
    expect(paid).toHaveLength(2); // only the first scan paid (first_tx + sustained)
  });

  it('releases the marker on payout failure so a later run retries', async () => {
    const fake = createFakeFirestore();
    const { deps } = makeDeps(fake, [target({ baselineNonce: 500 })], { nonces: { '0xexternal': 501 }, payThrows: true });
    const report = await scanExternalOutboundMilestones(deps);
    expect(report.errors).toBeGreaterThanOrEqual(1);
    expect(report.first_tx_emitted).toBe(0);
    // Marker was released (deleted) so a retry can re-claim.
    expect(fake.store.get(`${FIRSTTX_COLLECTION}/wallet_aw_a`)).toBeUndefined();
  });
});

describe('scanExternalOutboundMilestones - shared marker no-double-dip with native', () => {
  it('skips first_tx if the native scanner already claimed the marker', async () => {
    const fake = createFakeFirestore();
    // Native first_tx already earned for this agent's wallet.
    await (fake as unknown as Firestore).collection(FIRSTTX_COLLECTION).doc('wallet_aw_a').create({ wallet_id: 'wallet_aw_a' });
    const { deps, paid } = makeDeps(fake, [target({ baselineNonce: 500 })], { nonces: { '0xexternal': 530 }, threshold: 20 });
    const report = await scanExternalOutboundMilestones(deps);
    // first_tx is skipped (already), sustained still available.
    expect(paid.some((p) => p.eventType === 'agent_first_transaction')).toBe(false);
    expect(report.first_tx_emitted).toBe(0);
    expect(report.sustained_emitted).toBe(1);
  });
});

describe('scanExternalOutboundMilestones - legacy records require reproof', () => {
  it('does not establish a missing baseline from latest state or reward it', async () => {
    const fake = createFakeFirestore();
    const { deps, paid, persisted } = makeDeps(fake, [target({ baselineNonce: null })], { nonces: { '0xexternal': 777 } });
    const report = await scanExternalOutboundMilestones(deps);
    expect(report.baselines_established).toBe(0);
    expect(report.errors).toBe(1);
    expect(persisted).toEqual([]);
    expect(report.first_tx_emitted).toBe(0);
    expect(paid).toHaveLength(0);
  });

  it('rewards forward only after reproof supplied an exact baseline', async () => {
    const fake = createFakeFirestore();
    // Baseline now established at 777; a later tx pushes nonce to 778.
    const { deps, paid } = makeDeps(fake, [target({ baselineNonce: 777 })], { nonces: { '0xexternal': 778 } });
    const report = await scanExternalOutboundMilestones(deps);
    expect(report.first_tx_emitted).toBe(1);
    expect(paid).toHaveLength(1);
  });
});
