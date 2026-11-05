/**
 * "An RPC error is never evidence that a burn isn't final. A real burn is
 * never revoked because an RPC was down."
 *
 * RED controls (each shown failing on the finalizer — recorded in the landing commit):
 * - rpc_error / no_provider_for_chain / unconfigured chain / unverifiable row / insufficient
 * confirmations, at and past the 30-min deadline → NOT revoked (stalled, benefits kept);
 * - tx_not_found whose accepted block is still canonical → NOT revoked;
 * - tx_not_found on a row with no included_block_hash → NOT revoked;
 * - tx_not_found whose drop proof throws (an RPC failure) → NOT revoked;
 * - tx_not_found with the accepted block replaced at safe depth → revoked;
 * - tx_failed / no_matching_pvt_burn_log agreed → revoked;
 * - a stalled set never starves a fresh burn of its check, and the sweep keeps the
 * `system_status/burn_finality` alarm (raised while stalled, cleared when not).
 * `proveBurnDropped` is driven over fake operator legs: every leg of the proof can fail it.
 */
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import type { Firestore } from 'firebase-admin/firestore';
import {
  BURN_FINALITY_DEADLINE_MS,
  BURN_FINALITY_STATUS_COLLECTION,
  BURN_FINALITY_STATUS_DOCUMENT,
  BURN_NOT_FOUND_REVOKE_AFTER_MS,
  finalizeBurn,
  finalityVerdictRevokes,
  sweepBurnFinality,
} from './burn-finality';
import { proveBurnDropped, type BurnDropProof } from './burn-drop-proof';
import type { EconomicStateRpcLeg } from '../onchain/economic-state';
import type { TxVerificationResult } from '../onchain/tx-verifier';

const B = 'b'.repeat(64);
const TX = `0x${'a'.repeat(64)}`;
const ADDR = '0x1111111111111111111111111111111111111111';
const INCLUDED = `0x${'1'.repeat(64)}`;
const REPLACED = `0x${'2'.repeat(64)}`;
const T0 = 1_790_000_000_000;
const STATUS = `${BURN_FINALITY_STATUS_COLLECTION}/${BURN_FINALITY_STATUS_DOCUMENT}`;

function provisionalRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tx_hash: TX, chain: 'base', wallet_id: 'wallet_aw_1', owner_kind: 'agent', owner_id: 'agent_1',
    burner_address: ADDR, amount_atomic: '15000000000000000000', status: 'recorded', verified: true,
    block_number: 100, included_block_hash: INCLUDED, recorded_at: T0, accepted_at: T0, finality: 'provisional', ...extra,
  };
}

function seed(fs: FakeFirestore, id = B, extra: Record<string, unknown> = {}): void {
  fs.store.set(`pvt_burn_records/${id}`, provisionalRow(extra));
  fs.store.set(`burn_consumptions/${id}`, { burn_id: id, product: 'presentation', wallet_id: 'wallet_aw_1', ref: 'jti', consumed_at: T0 });
  fs.store.set(`commons_presentations/${id}`, { burn_id: id, wallet_id: 'wallet_aw_1', audience: 'provian:commons', recorded_at: T0 });
}

const NOT_DROPPED: BurnDropProof = { dropped: false, reason: 'drop_proof_included_block_canonical' };

function deps(
  fs: FakeFirestore,
  verdict: TxVerificationResult,
  nowMs: number,
  proveDropped: () => Promise<BurnDropProof> = async () => NOT_DROPPED,
) {
  return {
    db: fs as unknown as Firestore,
    now: () => nowMs,
    verify: jest.fn(async () => verdict),
    proveDropped: jest.fn(proveDropped),
  };
}

function expectStanding(fs: FakeFirestore, id = B): void {
  expect(fs.store.get(`pvt_burn_records/${id}`)).toMatchObject({ status: 'recorded', verified: true, finality: 'provisional' });
  expect(fs.store.has(`commons_presentations/${id}`)).toBe(true);
}
function expectRevoked(fs: FakeFirestore, id = B): void {
  expect(fs.store.get(`pvt_burn_records/${id}`)).toMatchObject({ status: 'revoked', verified: false, finality: 'failed' });
  expect(fs.store.has(`commons_presentations/${id}`)).toBe(false);
}

const AT_DEADLINE = T0 + BURN_FINALITY_DEADLINE_MS;
const WEEK_LATER = T0 + 7 * 24 * 3_600_000;

describe('revoke only on positive evidence', () => {
  it.each([
    ['rpc_error: economic_finality_rpc_disagreement:head'],
    ['rpc_error: getaddrinfo ENOTFOUND mainnet.base.org'],
    ['no_provider_for_chain'],
    ['pvt_principal_disabled_or_unconfigured_chain'],
    ['insufficient_confirmations: 0/12'],
    ['insufficient_confirmations: 7/12'],
  ])('RED: %s at and past the deadline → stalled, NOT revoked, benefits kept', async (reason) => {
    const fs = createFakeFirestore();
    seed(fs);
    expect(finalityVerdictRevokes({ ok: false, reason })).toBe(false);
    for (const at of [AT_DEADLINE, WEEK_LATER]) {
      await expect(finalizeBurn(deps(fs, { ok: false, reason }, at), B)).resolves.toBe('stalled');
      expectStanding(fs);
      expect(fs.store.get(`pvt_burn_records/${B}`)).toMatchObject({ finality_stalled: true, finality_stall_reason: reason });
    }
  });

  it('RED: a thrown verifier call (the verifier itself erroring) past the deadline → stalled, NOT revoked', async () => {
    const fs = createFakeFirestore();
    seed(fs);
    const d = { ...deps(fs, { ok: true }, WEEK_LATER), verify: jest.fn(async () => { throw new Error('socket hang up'); }) };
    await expect(finalizeBurn(d, B)).resolves.toBe('stalled');
    expectStanding(fs);
    expect(fs.store.get(`pvt_burn_records/${B}`)?.finality_stall_reason).toBe('rpc_error: socket hang up');
  });

  it('RED: a row the verifier cannot be asked about (burn_row_unverifiable) past the deadline → stalled, NOT revoked', async () => {
    const fs = createFakeFirestore();
    seed(fs, B, { burner_address: 42 });
    await expect(finalizeBurn(deps(fs, { ok: true }, WEEK_LATER), B)).resolves.toBe('stalled');
    expectStanding(fs);
    expect(fs.store.get(`pvt_burn_records/${B}`)?.finality_stall_reason).toBe('burn_row_unverifiable');
  });

  it('RED: tx_not_found while the accepted block is still canonical → NOT revoked (stalled past the deadline)', async () => {
    const fs = createFakeFirestore();
    seed(fs);
    const d = deps(fs, { ok: false, reason: 'tx_not_found' }, WEEK_LATER);
    await expect(finalizeBurn(d, B)).resolves.toBe('stalled');
    expect(d.proveDropped).toHaveBeenCalledTimes(1);
    expectStanding(fs);
    expect(fs.store.get(`pvt_burn_records/${B}`)?.finality_stall_reason).toBe('tx_not_found; drop_proof_included_block_canonical');
  });

  it('RED: tx_not_found on a row with no included_block_hash can never revoke', async () => {
    const fs = createFakeFirestore();
    seed(fs, B, { included_block_hash: null });
    const d = deps(fs, { ok: false, reason: 'tx_not_found' }, WEEK_LATER, async () => ({ dropped: true, safeHeadNumber: 999, canonicalHashAtHeight: REPLACED }));
    await expect(finalizeBurn(d, B)).resolves.toBe('stalled');
    expect(d.proveDropped).not.toHaveBeenCalled();
    expectStanding(fs);
  });

  it('RED: tx_not_found whose drop proof throws (an RPC failure) → NOT revoked', async () => {
    const fs = createFakeFirestore();
    seed(fs);
    const d = deps(fs, { ok: false, reason: 'tx_not_found' }, WEEK_LATER, async () => { throw new Error('burn_drop_proof_rpc_disagreement:height_block'); });
    await expect(finalizeBurn(d, B)).resolves.toBe('stalled');
    expectStanding(fs);
    expect(fs.store.get(`pvt_burn_records/${B}`)?.finality_stall_reason).toMatch(/rpc_error: drop_proof: burn_drop_proof_rpc_disagreement/);
  });

  it('tx_not_found with the accepted block replaced at safe depth → revoked', async () => {
    const fs = createFakeFirestore();
    seed(fs);
    const d = deps(fs, { ok: false, reason: 'tx_not_found' }, T0 + BURN_NOT_FOUND_REVOKE_AFTER_MS, async () => ({ dropped: true, safeHeadNumber: 150, canonicalHashAtHeight: REPLACED }));
    await expect(finalizeBurn(d, B)).resolves.toBe('revoked');
    expectRevoked(fs);
  });

  it.each([['tx_failed'], ['no_matching_pvt_burn_log']])('%s from the agreed receipt → revoked at any age', async (reason) => {
    const fs = createFakeFirestore();
    seed(fs);
    expect(finalityVerdictRevokes({ ok: false, reason })).toBe(true);
    await expect(finalizeBurn(deps(fs, { ok: false, reason }, T0 + 30_000), B)).resolves.toBe('revoked');
    expectRevoked(fs);
  });

  it('a stalled burn that is later disproven is revoked, and its stall bookkeeping leaves with it', async () => {
    const fs = createFakeFirestore();
    seed(fs);
    await finalizeBurn(deps(fs, { ok: false, reason: 'rpc_error: x' }, AT_DEADLINE), B);
    await expect(finalizeBurn(deps(fs, { ok: false, reason: 'tx_failed' }, WEEK_LATER), B)).resolves.toBe('revoked');
    const row = fs.store.get(`pvt_burn_records/${B}`) as Record<string, unknown>;
    expect(row).toMatchObject({ status: 'revoked', finality_stall_cleared_at: WEEK_LATER });
    expect(row).not.toHaveProperty('finality_stalled');
  });
});

describe('the sweep — alarm and no starvation', () => {
  const id = (n: number) => n.toString(16).padStart(64, '0');

  it('raises system_status/burn_finality while a burn is stalled, and clears it once the burn finalizes', async () => {
    const fs = createFakeFirestore();
    seed(fs);
    const counts = await sweepBurnFinality(deps(fs, { ok: false, reason: 'rpc_error: down' }, WEEK_LATER));
    expect(counts).toMatchObject({ stalled: 1, revoked: 0, alarm: true });
    expect(fs.store.get(STATUS)).toMatchObject({
      alarm: true, verdict: 'burn_finality_stalled', stalled_count: 1, oldest_stalled_accepted_at_ms: T0, stalled_burn_ids: [B],
    });
    expectStanding(fs);
    const after = await sweepBurnFinality(deps(fs, { ok: true, blockNumber: 100, confirmations: 12 }, WEEK_LATER + 1));
    expect(after).toMatchObject({ finalized: 1, stalled: 0, alarm: false });
    expect(fs.store.get(STATUS)).toMatchObject({ alarm: false, verdict: 'ok', stalled_count: 0 });
  });

  it('RED control: a pending (inside-deadline) burn never raises the alarm', async () => {
    const fs = createFakeFirestore();
    seed(fs);
    const counts = await sweepBurnFinality(deps(fs, { ok: false, reason: 'rpc_error: down' }, AT_DEADLINE - 1));
    expect(counts).toMatchObject({ pending: 1, stalled: 0, alarm: false });
    expect(fs.store.get(STATUS)).toMatchObject({ alarm: false });
  });

  it('RED: a set of stalled burns larger than the per-pass limit never starves a fresh burn of its check', async () => {
    const fs = createFakeFirestore();
    // Three stalled burns whose ids sort BEFORE the fresh one.
    for (const n of [1, 2, 3]) seed(fs, id(n), { finality_stalled: true, finality_stalled_at: T0, finality_last_checked_at: T0 + n });
    const fresh = 'f'.repeat(64);
    seed(fs, fresh, { accepted_at: WEEK_LATER - 60_000, recorded_at: WEEK_LATER - 60_000 });
    const d = deps(fs, { ok: false, reason: 'rpc_error: down' }, WEEK_LATER);
    const counts = await sweepBurnFinality(d, { limit: 2 });
    // The fresh burn was checked first (pending: inside its deadline), then the least-recently-checked stalled one.
    expect(counts).toMatchObject({ pending: 1, stalled: 3, alarm: true });
    expect(d.verify).toHaveBeenCalledTimes(2);
    expect(fs.store.get(`pvt_burn_records/${fresh}`)).not.toHaveProperty('finality_stalled');
    expect(fs.store.get(`pvt_burn_records/${id(1)}`)?.finality_last_checked_at).toBe(WEEK_LATER);
    expect(fs.store.get(`pvt_burn_records/${id(3)}`)?.finality_last_checked_at).toBe(T0 + 3);
  });
});

describe('proveBurnDropped (both legs, safe depth)', () => {
  interface Chain { safe: number | null; atHeight: string | null; receipt: unknown; tx: unknown }
  function leg(operatorId: string, chain: Chain): EconomicStateRpcLeg {
    return {
      operatorId,
      send: async (method, params) => {
        switch (method) {
          case 'eth_chainId': return '0x2105';
          case 'eth_getBlockByNumber':
            if (params[0] === 'safe') return chain.safe === null ? null : { number: `0x${chain.safe.toString(16)}`, hash: `0x${'5'.repeat(64)}` };
            return chain.atHeight === null ? null : { number: params[0], hash: chain.atHeight };
          case 'eth_getTransactionReceipt': return chain.receipt;
          case 'eth_getTransactionByHash': return chain.tx;
          default: throw new Error(`unexpected ${method}`);
        }
      },
    };
  }
  const input = { txHash: TX, includedBlockNumber: 100, includedBlockHash: INCLUDED };
  const dropped: Chain = { safe: 111, atHeight: REPLACED, receipt: null, tx: null };
  const legs = (a: Chain, b: Chain = a) => ({ rpcLegs: [leg('alchemy', a), leg('base-public', b)] as const });

  it('proves a drop: the accepted block replaced at safe depth, no receipt, the tx unknown on both legs', async () => {
    await expect(proveBurnDropped(input, legs(dropped))).resolves.toEqual({ dropped: true, safeHeadNumber: 111, canonicalHashAtHeight: REPLACED });
  });

  it('RED: each leg of the proof, failed alone, withholds it', async () => {
    await expect(proveBurnDropped(input, legs({ ...dropped, atHeight: INCLUDED }))).resolves.toEqual({ dropped: false, reason: 'drop_proof_included_block_canonical' });
    await expect(proveBurnDropped(input, legs({ ...dropped, safe: 110 }))).resolves.toEqual({ dropped: false, reason: 'drop_proof_not_safe_depth: 11/12' });
    await expect(proveBurnDropped(input, legs({ ...dropped, safe: null }))).resolves.toEqual({ dropped: false, reason: 'drop_proof_no_safe_head' });
    await expect(proveBurnDropped(input, legs(dropped, { ...dropped, receipt: { status: '0x1' } }))).resolves.toEqual({ dropped: false, reason: 'drop_proof_tx_has_receipt' });
    await expect(proveBurnDropped(input, legs(dropped, { ...dropped, tx: { hash: TX } }))).resolves.toEqual({ dropped: false, reason: 'drop_proof_tx_still_known' });
    await expect(proveBurnDropped({ ...input, includedBlockHash: '' }, legs(dropped))).resolves.toEqual({ dropped: false, reason: 'drop_proof_row_incomplete' });
  });

  it('RED: a leg disagreeing on the block at the height, or the same operator twice, is an error — never a proof', async () => {
    await expect(proveBurnDropped(input, legs(dropped, { ...dropped, atHeight: `0x${'3'.repeat(64)}` }))).rejects.toThrow('burn_drop_proof_rpc_disagreement:height_block');
    await expect(proveBurnDropped(input, legs(dropped, { ...dropped, atHeight: null }))).rejects.toThrow('burn_drop_proof_rpc_disagreement:height_block');
    await expect(proveBurnDropped(input, { rpcLegs: [leg('same', dropped), leg('same', dropped)] })).rejects.toThrow('not_independent');
  });
});
