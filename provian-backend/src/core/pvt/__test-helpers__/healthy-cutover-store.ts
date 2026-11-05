/**
 * Shared healthy cutover fixture and its cut-line constant.
 * Every suite reads the same store so an assertion exercises the common
 * fixture rather than an independently constructed copy.
 */
import { createFakeFirestore } from './fake-firestore';

/** Strictly after every timestamp in the fixture below. */
export const CUT_LINE = 1_800_000_000_000;

export function seedHealthyCutoverStore() {
  const db = createFakeFirestore();
  const s = db.store;
  // Finalized legacy batch: 2 PEs, 2 contributors, exact points.
  s.set('pvt_mint_batches/batch_a', { marked: true, marked_at: 1_700_000_000_000, mint_tx_hash: '0x'.padEnd(66, 'a') });
  s.set('pvt_mint_batch_snapshots/batch_a', {
    batch_id: 'batch_a',
    chain_id: 8453,
    pvt_contract_address: '0x50d6f1ff00000000000000000000000000000001',
    pe_anchor_contract_address: '0x50d6f1ff00000000000000000000000000000002',
    merkle_root: '0x'.padEnd(66, 'b'),
    sorted_pe_ids: ['pe_1', 'pe_2'],
    leaves: [
      { peId: 'pe_1', walletAddress: '0x1111111111111111111111111111111111111111', actionType: 'escrow_created', timestamp: 1_699_999_000_000, basePoints: '1000000000000000000' },
      { peId: 'pe_2', walletAddress: '0x2222222222222222222222222222222222222222', actionType: 'receive', timestamp: 1_699_999_500_000, basePoints: '2000000000000000000' },
    ],
    contributor_addresses: ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'],
    pe_points: ['1000000000000000000', '2000000000000000000'],
    pe_action_types: ['0xaaaa', '0xbbbb'],
    epoch: 3,
  });
  s.set('pvt_mint_claims_v1/claim_a', { schema_version: 'pvt-mint-claim/v1', claim_id: 'claim_a', batch_id: 'batch_a' });
  s.set('pe_daily_anchor_batches/anchor_day_1', {
    batch_id: 'anchor_day_1',
    day: '2026-06-01',
    kind: 'daily',
    status: 'anchored',
    anchor_tx_hash: '0x'.padEnd(66, 'c'),
    merkle_root: '0x'.padEnd(66, 'd'),
    pe_count: 2,
    members: [
      { pe_id: 'pe_1', pe_hash: 'h1', timestamp: 1_699_999_000_000 },
      { pe_id: 'pe_2', pe_hash: 'h2', timestamp: 1_699_999_500_000 },
    ],
  });
  // Legacy Genesis pool ledger reconciles exactly with wallet ledgers.
  s.set('genesis_campaign_state/global', { pool_minted_pvt: 175 });
  s.set('genesis_wallet_ledger/wallet_h', { issued_pvt: 100 });
  s.set('genesis_wallet_ledger/wallet_a', { issued_pvt: 75 });
  // A bonded lock (legacy on-chain custody evidence).
  s.set('bonds/bond_1', { status: 'active', amount_pvt: '5000000000000000000' });
  // PVT9-era Genesis durable backlog (NOT legacy carry, NOT settled here).
  s.set('genesis_qualification_outbox_v2/q_1', {
    schema_version: 'pvt-genesis-qualification/v2',
    status: 'complete',
  });
  s.set('genesis_reservations_v2/r_1', {
    schema_version: 'pvt-genesis-reservation/v2',
    state: 'ready_for_settlement',
    reservation: { reserved_atomic: '75000000000000000000' },
  });
  return db;
}
