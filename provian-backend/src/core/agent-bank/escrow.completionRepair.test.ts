/**
 * completeEscrow repair branch + creditEscrowStatsOnce — Pass-3 #17.
 *
 * #17: completeEscrow / processAutoReleases set stats_credited=true BEFORE the
 *   credit + escrow_completed PEs. A crash between the claim and the credit left
 *   the escrow 'completed' with the credit permanently suppressed (the durable
 *   marker short-circuited every retry). Fix: (a) the credit + stats_credited
 *   marker are now ATOMIC (creditEscrowStatsOnce), and (b) completeEscrow gained a
 *   repair branch that, on a 'completed' escrow whose credit/PEs never ran,
 *   re-runs only the missing side-effects instead of throwing "expected funded".
 *
 * Uses the in-memory Firestore fake so doc state persists across calls (real
 * transaction semantics: buffered writes, rollback on throw).
 */

import { completeEscrow, creditEscrowStatsOnce } from './escrow';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import type { AgentBankDeps, EscrowDocument } from './types';

let peCounter = 0;
const mockGeneratePE = jest.fn(async (..._a: unknown[]) => ({ peId: `pe_${++peCounter}`, peHash: 'h', prevHash: 'p' }));
jest.mock('./pe-utils', () => ({
  generatePE: (...a: unknown[]) => mockGeneratePE(...a),
  generateSchedulerPE: (...a: unknown[]) => mockGeneratePE(...a),
}));
jest.mock('../corroboration/CorroborationManager', () => ({
  emitBackendCorroboration: jest.fn(),
  resolveTargetPeHash: jest.fn().mockResolvedValue('h'),
}));
jest.mock('../onchain/tx-verifier', () => ({
  verifyTransfer: jest.fn(),
  verifyOnchainEscrowFunding: jest.fn(),
}));

function escrow(overrides: Partial<EscrowDocument> = {}): EscrowDocument {
  return {
    escrow_id: 'esc1',
    depositor_wallet_id: 'wd',
    recipient_wallet_id: 'wr',
    depositor_address: '0xwd',
    recipient_address: '0xwr',
    currency: 'usdc',
    amount_usdc: 100,
    fee_usdc: 0.5,
    net_to_recipient_usdc: 99.5,
    description: 'd',
    deliverables: 'dl',
    chain: 'base',
    deadline: 0,
    auto_release_at: 0,
    status: 'completed',
    pe_ids: ['pe_created'],
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as unknown as EscrowDocument;
}

function seed(store: Map<string, Record<string, unknown>>, esc: EscrowDocument): void {
  store.set('escrows/esc1', { ...(esc as unknown as Record<string, unknown>) });
  store.set('agent_wallets/wd', { agent_id: 'ad', address: '0xwd', pe_count: 5, economic_activity_usd: 10 });
  store.set('agent_wallets/wr', { agent_id: 'ar', address: '0xwr', pe_count: 3, economic_activity_usd: 20 });
}

beforeEach(() => {
  peCounter = 0;
  mockGeneratePE.mockClear();
});

describe('completeEscrow - #17 repair branch (completed escrow, credit never ran)', () => {
  it('repairs a completed escrow missing both markers: emits PEs + credits + sets stats_credited', async () => {
    const fs = createFakeFirestore();
    seed(fs.store, escrow({ status: 'completed' })); // no completion_pe_ids, no stats_credited
    const deps = { db: fs } as unknown as AgentBankDeps;

    const result = await completeEscrow(deps, 'esc1', 'wd');

    expect(result.status).toBe('completed');
    expect(mockGeneratePE).toHaveBeenCalledTimes(2); // both escrow_completed PEs
    const escDoc = fs.store.get('escrows/esc1')!;
    expect(escDoc.stats_credited).toBe(true);
    expect((escDoc.completion_pe_ids as string[]).length).toBe(2);
  });

  it('force-emits the missing PEs on repair when the credit already happened but PEs were lost (#17)', async () => {
    // Crash-after-credit-before-PE: escrow is completed + stats_credited=true, but
    // completion_pe_ids never landed. The repair must RE-EMIT the PEs (forceEmit)
    // even though creditEscrowStatsOnce reports the credit already done.
    const fs = createFakeFirestore();
    seed(fs.store, escrow({ status: 'completed', stats_credited: true }));
    const deps = { db: fs } as unknown as AgentBankDeps;

    await completeEscrow(deps, 'esc1', 'wd');

    expect(mockGeneratePE).toHaveBeenCalledTimes(2);
    expect((fs.store.get('escrows/esc1')!.completion_pe_ids as string[]).length).toBe(2);
  });

  it('credits WITHOUT re-emitting PEs when the completed escrow already has completion_pe_ids (#17)', async () => {
    const fs = createFakeFirestore();
    seed(fs.store, escrow({ status: 'completed', completion_pe_ids: ['peA', 'peB'] })); // stats_credited absent
    const deps = { db: fs } as unknown as AgentBankDeps;

    await completeEscrow(deps, 'esc1', 'wd');

    // Idempotent: PEs already emitted → not duplicated; the credit still runs.
    expect(mockGeneratePE).not.toHaveBeenCalled();
    expect(fs.store.get('escrows/esc1')!.stats_credited).toBe(true);
  });

  it('is a no-op when the completed escrow is fully settled (both markers set)', async () => {
    const fs = createFakeFirestore();
    seed(fs.store, escrow({ status: 'completed', completion_pe_ids: ['peA', 'peB'], stats_credited: true }));
    const deps = { db: fs } as unknown as AgentBankDeps;

    const result = await completeEscrow(deps, 'esc1', 'wd');

    expect(result.status).toBe('completed');
    expect(mockGeneratePE).not.toHaveBeenCalled();
    // Wallet stats untouched (no double-credit).
    expect(fs.store.get('agent_wallets/wd')!.pe_count).toBe(5);
  });

  it('rejects a repair from a non-depositor caller', async () => {
    const fs = createFakeFirestore();
    seed(fs.store, escrow({ status: 'completed' }));
    const deps = { db: fs } as unknown as AgentBankDeps;

    await expect(completeEscrow(deps, 'esc1', 'someone_else')).rejects.toThrow(/Only the depositor/);
  });
});

describe('creditEscrowStatsOnce - atomic, idempotent, currency-routed', () => {
  type DocRef = Parameters<typeof creditEscrowStatsOnce>[1];

  it('credits PVT activity as summed BigInt strings for both parties + marks the escrow', async () => {
    const fs = createFakeFirestore();
    const esc = escrow({
      currency: 'pvt',
      amount_pvt: '100000000000000000000', // 100 PVT (depositor)
      net_to_recipient_pvt: '99500000000000000000', // 99.5 PVT (recipient)
    });
    seed(fs.store, esc);
    fs.store.set('agent_wallets/wd', { economic_activity_pvt: '1000000000000000000' }); // 1 PVT
    fs.store.set('agent_wallets/wr', { economic_activity_pvt: '0' });
    const deps = { db: fs } as unknown as AgentBankDeps;

    const credited = await creditEscrowStatsOnce(deps, fs.collection('escrows').doc('esc1') as unknown as DocRef, esc, Date.now());

    expect(credited).toBe(true);
    expect(fs.store.get('agent_wallets/wd')!.economic_activity_pvt).toBe(
      (1000000000000000000n + 100000000000000000000n).toString(),
    );
    expect(fs.store.get('agent_wallets/wr')!.economic_activity_pvt).toBe('99500000000000000000');
    expect(fs.store.get('escrows/esc1')!.stats_credited).toBe(true);
  });

  it('is idempotent: a second call does not double-credit', async () => {
    const fs = createFakeFirestore();
    const esc = escrow({
      currency: 'pvt',
      amount_pvt: '100000000000000000000',
      net_to_recipient_pvt: '99500000000000000000',
    });
    seed(fs.store, esc);
    fs.store.set('agent_wallets/wd', { economic_activity_pvt: '0' });
    fs.store.set('agent_wallets/wr', { economic_activity_pvt: '0' });
    const deps = { db: fs } as unknown as AgentBankDeps;
    const ref = fs.collection('escrows').doc('esc1') as unknown as DocRef;

    expect(await creditEscrowStatsOnce(deps, ref, esc, Date.now())).toBe(true);
    const afterFirst = fs.store.get('agent_wallets/wd')!.economic_activity_pvt;
    // Second call sees stats_credited set → no-op.
    expect(await creditEscrowStatsOnce(deps, ref, esc, Date.now())).toBe(false);
    expect(fs.store.get('agent_wallets/wd')!.economic_activity_pvt).toBe(afterFirst);
  });

  it('routes USDC credits to economic_activity_usd (not economic_activity_pvt)', async () => {
    const fs = createFakeFirestore();
    const esc = escrow({ currency: 'usdc', amount_usdc: 100, net_to_recipient_usdc: 99.5 });
    seed(fs.store, esc);
    const deps = { db: fs } as unknown as AgentBankDeps;

    await creditEscrowStatsOnce(deps, fs.collection('escrows').doc('esc1') as unknown as DocRef, esc, Date.now());

    const wd = fs.store.get('agent_wallets/wd')!;
    expect('economic_activity_usd' in wd).toBe(true);
    expect('economic_activity_pvt' in wd).toBe(false);
    expect(fs.store.get('escrows/esc1')!.stats_credited).toBe(true);
  });

  it('folds an extraUpdate (scheduler status flip) into the same atomic credit', async () => {
    const fs = createFakeFirestore();
    const esc = escrow({ status: 'funded', currency: 'usdc', amount_usdc: 100, net_to_recipient_usdc: 99.5 });
    seed(fs.store, esc);
    const deps = { db: fs } as unknown as AgentBankDeps;

    await creditEscrowStatsOnce(deps, fs.collection('escrows').doc('esc1') as unknown as DocRef, esc, Date.now(), {
      status: 'completed',
      auto_released: true,
    });

    const escDoc = fs.store.get('escrows/esc1')!;
    expect(escDoc.stats_credited).toBe(true);
    expect(escDoc.status).toBe('completed');
    expect(escDoc.auto_released).toBe(true);
  });
});
