/**
 * Acceptance: the inbound funding leg is DECOUPLED from Genesis. It emits a
 * standard `receive` PE via generatePE (the shared mint path) - never
 * payGenesisBounty - carrying counterparty identity while amount stays solely
 * in provenance metadata, and
 * routes to the correct identity (agent vs human) unchanged.
 */

import { jest } from '@jest/globals';

const generatePE = jest.fn(
  async (_deps: unknown, _params: Record<string, unknown>) => ({ peId: 'pe_x', peHash: 'h', prevHash: 'p' }),
);
jest.mock('../agent-bank/pe-utils', () => ({ generatePE }));

import crypto from 'crypto';
import { buildBaseInboundDeps } from './inbound-usdc-watcher';
import type { AgentBankDeps } from '../agent-bank/types';

const deps = { db: {}, peBuffer: {}, recordPEAccrual: async () => {} } as unknown as AgentBankDeps;

// The emit now seals canonicalLogIdentity (F-A6 /), whose builder rejects
// non-64-hex fixtures exactly as production tx hashes never are — give the
// fixtures a real-shape hash (mirrors the outbound watcher test).
const txh = (label: string): string =>
  `0x${crypto.createHash('sha256').update(label, 'utf8').digest('hex')}`;

describe('inbound funding is decoupled from Genesis', () => {
  beforeEach(() => generatePE.mockClear());

  it('emits a standard `receive` PE without forwarding amount into economics', async () => {
    const inbound = buildBaseInboundDeps(deps);
    const res = await inbound.emitFundingPE(
      { walletId: 'w1', agentId: 'agent1', address: '0xabc', createdAtMs: 0, eligibilityStartBlock: 0 },
      {
        txHash: txh('t'),
        logIndex: 0,
        blockNumber: 10,
        fromAddress: '0xsender',
        amountUsd: 7.5,
        amountAtomic: '7500000',
        observedAtMs: 1_000,
      },
      { asset: 'USDC', verified: true, finality_confirmations: 12 },
    );
    expect(generatePE).toHaveBeenCalledTimes(1);
    const arg = generatePE.mock.calls[0][1] as Record<string, unknown>;
    expect(arg.actionType).toBe('receive');
    expect(arg.mintValueUsd).toBeUndefined();
    expect(arg.counterpartyAddress).toBe('0xsender');
    expect(arg.walletId).toBe('w1');
    expect(arg.agentId).toBe('agent1');
    // No Genesis stamp: not a fixed-PVT grant, so the weight framework prices it.
    expect(arg.fixedEstimatedPVT).toBeUndefined();
    expect(arg.isGenesisGrant).toBeUndefined();
    // No genesis bounty on the permanent path.
    expect(res.bountyPvt).toBe(0);
  });

  it('routes a human deposit to the human ledger (agentId = user_id), still standard `receive`', async () => {
    const inbound = buildBaseInboundDeps(deps);
    await inbound.emitFundingPE(
      { walletId: 'humanWalletDoc', agentId: 'humanUser1', address: '0xh', createdAtMs: 0, eligibilityStartBlock: 0, ownerType: 'human' },
      {
        txHash: txh('t2'),
        logIndex: 1,
        blockNumber: 11,
        fromAddress: '0xsender2',
        amountUsd: 3,
        amountAtomic: '3000000',
        observedAtMs: 2_000,
      },
      { verified: true, finality_confirmations: 12 },
    );
    const arg = generatePE.mock.calls[0][1] as Record<string, unknown>;
    expect(arg.actionType).toBe('receive'); // identity-neutral honest label, not agent_wallet_funded
    expect(arg.agentId).toBe('humanUser1'); // accrual keys on the human ledger
  });

  it('stamps external-proven provenance for a proven external address', async () => {
    const inbound = buildBaseInboundDeps(deps);
    await inbound.emitFundingPE(
      {
        walletId: 'w1',
        agentId: 'agent1',
        address: '0xproven',
        createdAtMs: 0,
        eligibilityStartBlock: 500,
        isExternalProven: true,
        provenAtBlock: 500,
      },
      {
        txHash: txh('t3'),
        logIndex: 2,
        blockNumber: 600,
        fromAddress: '0xsender3',
        amountUsd: 12,
        amountAtomic: '12000000',
        observedAtMs: 3_000,
      },
      { verified: true, finality_confirmations: 12 },
    );
    const arg = generatePE.mock.calls[0][1] as { metadata: Record<string, unknown> };
    expect(arg.metadata.external_proven).toBe(true);
    expect(arg.metadata.proven_at_block).toBe(500);
    expect(arg.metadata.activity_mapped).toBe(true);
  });
});
