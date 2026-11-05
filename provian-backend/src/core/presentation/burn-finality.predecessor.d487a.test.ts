/**
 * / a burn on the RETIRED predecessor kernel at or below the migration snapshot block
 * still verifies END TO END: the real `verifyEvmPvtBurn` (the real token set) accepts it at
 * inclusion through `recordFirstPartyBurn`, the row names the kernel (`token_address`), a product
 * consumes it (a featured bid, through `assertBurnRowUsable`), and the finalizer's 12-block check
 * makes it FINAL. One block after the cutoff it is refused at acceptance, and a row the relay
 * accepted there is revoked by the finalizer on the agreed receipt's `no_matching_pvt_burn_log` * positive evidence, never an RPC failure.
 *
 * Only the RPC boundary is mocked (the two-leg inclusion read, the quorum receipt, the exact-finality
 * read). The token set, cutoff, verifier, recorder, consumer and finalizer are production code.
 */
import { ethers } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import {
  getPvtAddressForChain,
  PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK,
} from '../agent-bank/pvt-principal-config';

const mockInclusion = jest.fn();
const mockReceipt = jest.fn();
let mockFinalityBlock = 0;
jest.mock('../onchain/economic-finality', () => ({
  verifyBaseTransactionInclusion: (...args: unknown[]) => mockInclusion(...args),
  verifyBaseEconomicTransactionFinality: jest.fn(async () => ({
    evidence: { blockNumber: mockFinalityBlock, blockHash: `0x${'b'.repeat(64)}`, confirmations: 12 },
  })),
}));
jest.mock('../onchain/rpc-provider', () => ({
  getVerifierProvider: jest.fn(() => ({ getTransactionReceipt: (...args: unknown[]) => mockReceipt(...args) })),
  getOperatorBoundRpcLegs: jest.fn(() => { throw new Error('not used'); }),
}));

import { recordFirstPartyBurn } from './burn-record';
import { finalizeBurn } from './burn-finality';
import { bidFeatured } from '../commons/featured';
import type { AgentBankDeps } from '../agent-bank/types';

process.env.ENABLE_PVT_PRINCIPAL = 'true';

const PREDECESSOR = '0x4bf02d5c9bc4306c38603ef2aa164f2f2273bcd7';
const LIVE = getPvtAddressForChain('base')!;
const BURNER = '0x1111111111111111111111111111111111111111';
const WALLET = 'wallet_aw_pred';
const TX = `0x${'c'.repeat(64)}`;
const AMOUNT = 20n * 10n ** 18n;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topic = (a: string): string => `0x${a.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;

function receiptAt(block: number, token: string) {
  return {
    hash: TX,
    status: 1,
    blockNumber: block,
    blockHash: `0x${'b'.repeat(64)}`,
    logs: [{ address: token, topics: [TRANSFER, topic(BURNER), topic(ethers.ZeroAddress)], data: ethers.toBeHex(AMOUNT, 32) }],
  };
}

function bankDeps(db: ReturnType<typeof createFakeFirestore>): AgentBankDeps {
  return { db, cache: { checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }) }, peBuffer: { enqueue: () => {} }, recordPEAccrual: async () => {} } as unknown as AgentBankDeps;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ENABLE_PVT_PRINCIPAL = 'true';
});

describe('a predecessor burn at/below the cutoff still verifies end to end', () => {
  it('accepted at inclusion (row labelled with the predecessor kernel) → consumed by a product → FINAL', async () => {
    expect(LIVE).not.toBe(PREDECESSOR);
    const block = PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK;
    const fs = createFakeFirestore();
    const db = fs as unknown as Firestore;
    mockInclusion.mockResolvedValue({ receipt: receiptAt(block, PREDECESSOR), blockNumber: block, blockHash: `0x${'b'.repeat(64)}` });

    const recorded = await recordFirstPartyBurn({ db }, {
      walletId: WALLET, address: BURNER, ownerKind: 'agent', ownerId: 'agent_pred', txHash: TX, chain: 'base', amountAtomic: AMOUNT.toString(),
    });
    expect(recorded).toMatchObject({ ok: true, finality: 'provisional' });
    if (!recorded.ok) return;
    const burnId = recorded.burnId;
    expect(fs.store.get(`pvt_burn_records/${burnId}`)).toMatchObject({
      status: 'recorded', verified: true, finality: 'provisional', block_number: block, token_address: PREDECESSOR,
    });

    // A product consumes it through the shared `assertBurnRowUsable` fence.
    fs.store.set('commons_wants/want_pred', { status: 'open', expiry: null });
    const placement = await bidFeatured(bankDeps(fs), {
      board: 'wants', itemId: 'want_pred', burnId,
      actor: { walletId: WALLET, agentId: 'agent_pred', actorAddress: BURNER, isAgent: true },
      assertBiddable: async () => {}, nowMs: Date.now(),
    });
    expect(placement.amount_atomic).toBe(AMOUNT.toString());
    expect(fs.store.get(`burn_consumptions/${burnId}`)).toMatchObject({ product: 'featured_placement', wallet_id: WALLET });

    // The finalizer's 12-block check (default acceptance, real verifier) makes it final.
    mockReceipt.mockResolvedValue(receiptAt(block, PREDECESSOR));
    mockFinalityBlock = block;
    await expect(finalizeBurn({ db }, burnId)).resolves.toBe('final');
    expect(fs.store.get(`pvt_burn_records/${burnId}`)).toMatchObject({ finality: 'final', final_token_address: PREDECESSOR });
    expect(fs.store.has(`commons_featured_placements/${burnId}`)).toBe(true);
  });

  it('RED: one block after the cutoff it is refused at acceptance, and a row accepted there is revoked on the agreed receipt', async () => {
    const block = PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK + 1;
    const fs = createFakeFirestore();
    const db = fs as unknown as Firestore;
    mockInclusion.mockResolvedValue({ receipt: receiptAt(block, PREDECESSOR), blockNumber: block, blockHash: `0x${'b'.repeat(64)}` });
    const refused = await recordFirstPartyBurn({ db }, {
      walletId: WALLET, address: BURNER, ownerKind: 'agent', ownerId: 'agent_pred', txHash: TX, chain: 'base', amountAtomic: AMOUNT.toString(),
    });
    expect(refused).toMatchObject({ ok: false, status: 400, reason: 'no_matching_pvt_burn_log' });

    // The same burn as the relay accepted it (provisional), finalized now.
    const burnId = 'd'.repeat(64);
    fs.store.set(`pvt_burn_records/${burnId}`, {
      tx_hash: TX, chain: 'base', wallet_id: WALLET, owner_kind: 'agent', owner_id: 'agent_pred', burner_address: BURNER,
      amount_atomic: AMOUNT.toString(), status: 'recorded', verified: true, block_number: block,
      included_block_hash: `0x${'b'.repeat(64)}`, recorded_at: Date.now(), accepted_at: Date.now(), finality: 'provisional',
    });
    mockReceipt.mockResolvedValue(receiptAt(block, PREDECESSOR));
    mockFinalityBlock = block;
    await expect(finalizeBurn({ db }, burnId)).resolves.toBe('revoked');
    expect(fs.store.get(`pvt_burn_records/${burnId}`)).toMatchObject({ status: 'revoked', revoke_reason: 'no_matching_pvt_burn_log' });
  });

  it('RED control: the finality READ failing on that predecessor burn (an RPC error) never revokes it', async () => {
    const block = PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK;
    const fs = createFakeFirestore();
    const db = fs as unknown as Firestore;
    const burnId = 'e'.repeat(64);
    fs.store.set(`pvt_burn_records/${burnId}`, {
      tx_hash: TX, chain: 'base', wallet_id: WALLET, owner_kind: 'agent', owner_id: 'agent_pred', burner_address: BURNER,
      amount_atomic: AMOUNT.toString(), status: 'recorded', verified: true, block_number: block,
      included_block_hash: `0x${'b'.repeat(64)}`, recorded_at: 0, accepted_at: 0, finality: 'provisional',
    });
    mockReceipt.mockRejectedValue(new Error('missing response'));
    await expect(finalizeBurn({ db }, burnId)).resolves.toBe('stalled');
    expect(fs.store.get(`pvt_burn_records/${burnId}`)).toMatchObject({ status: 'recorded', finality: 'provisional', finality_stalled: true });
  });
});
