/**
 * the chain-record lane serves humans and non-USDC receives on one rule.
 * Derivation, the per-act cut lines, human wallet resolution, the untrusted-
 * pointer horizon and the retry back-off. The money outcome is proven in
 * `chain-record-watcher.d504.acceptance.test.ts`.
 *
 * Each RED case is the violating input beside a GREEN case that differs in the
 * one variable the guard reads.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import { transactionEvidence, transferLog, TEST_BLOCK } from './__test-helpers__/base-transaction-evidence';
import { BASE_USDC_ADDRESS, type BaseTransactionEvidence } from '../onchain/economic-discovery';
import {
  CHAIN_RECORD_MINT_CUT_LINE_MS,
  CHAIN_RECORD_NOT_FOUND_HORIZON_MS,
  CHAIN_RECORD_OBSERVATIONS_COLLECTION,
  PVT9_MIGRATION_DISTRIBUTOR_BASE,
  chainRecordEnqueue,
  chainRecordObservationId,
  chainRecordPeId,
  deriveChainRecordAct,
  enqueueChainRecordObservation,
  resolveChainRecordWallet,
  runChainRecordWatcherCycle,
  type ChainRecordWatcherDeps,
} from './chain-record-watcher';
import { VERIFIED_COMMERCE_CUT_LINE_MS, LIVE_PVT9_TOKEN, ZEROX_ALLOWANCE_HOLDER_BASE } from './wallet-exchange';
import { INSTITUTION_ADDRESSES } from './institution-funding-watcher';
import { inboundUsdcPeId } from './inbound-usdc-watcher';
import {
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  createNativeWalletRegistrationFence,
  nativeWalletAddressIndexId,
} from './native-wallet-registration';

const WALLET = '0xa11ce00000000000000000000000000000000001';
const STRANGER = '0x5000000000000000000000000000000000000005';
const SETTLER = '0x5e77100000000000000000000000000000000005';
const DAI = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb';
const WETH = '0x4200000000000000000000000000000000000006';
const JUNK = '0x7777777777777777777777777777777777777777';
const ZERO = `0x${'0'.repeat(40)}`;
const TX = `0x${'ef'.repeat(32)}`;
const AFTER = VERIFIED_COMMERCE_CUT_LINE_MS + 60_000;

function ev(over: Partial<Omit<BaseTransactionEvidence, 'evidenceHash'>> = {}): BaseTransactionEvidence {
  return transactionEvidence({
    transactionHash: TX,
    fromAddress: STRANGER,
    toAddress: DAI,
    blockTimestampMs: AFTER,
    logs: [transferLog(TX, DAI, STRANGER, WALLET, 10n ** 18n, 4)],
    ...over,
  });
}

describe('the cut lines are ordered: (agents) before (humans, receives, USDC label)', () => {
  it(' lands after ', () => {
    expect(VERIFIED_COMMERCE_CUT_LINE_MS).toBeGreaterThan(CHAIN_RECORD_MINT_CUT_LINE_MS);
  });
});

describe('deriveChainRecordAct — the RECEIVE of a known non-USDC asset ', () => {
  it('GREEN: a stranger\'s DAI transfer to the wallet → receive from that stranger, log-keyed', () => {
    expect(deriveChainRecordAct(ev(), WALLET)).toMatchObject({
      status: 'act',
      act: {
        actionType: 'receive', counterpartyAddress: STRANGER, canonicalEventId: `8453:${TX}:4`,
        leg: 'erc20', assetSymbol: 'DAI', assetAddress: DAI, amountAtomic: (10n ** 18n).toString(), logIndex: 4,
      },
    });
  });

  it('GREEN: PVT and WETH receives qualify too', () => {
    for (const token of [LIVE_PVT9_TOKEN as string, WETH]) {
      const d = deriveChainRecordAct(ev({ logs: [transferLog(TX, token, STRANGER, WALLET, 5n, 1)] }), WALLET);
      expect(d).toMatchObject({ status: 'act', act: { actionType: 'receive', assetAddress: token } });
    }
  });

  it('RED: PVT from the zero address (a settlement / Genesis mint) is no receive', () => {
    const d = deriveChainRecordAct(ev({ logs: [transferLog(TX, LIVE_PVT9_TOKEN as string, ZERO, WALLET, 5n, 1)] }), WALLET);
    expect(d).toMatchObject({ status: 'no_act', reason: 'no_qualifying_receive' });
  });

  it('RED: a migration-distributor payout is no receive', () => {
    const d = deriveChainRecordAct(ev({
      logs: [transferLog(TX, LIVE_PVT9_TOKEN as string, PVT9_MIGRATION_DISTRIBUTOR_BASE, WALLET, 5n, 1)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'no_act', reason: 'no_qualifying_receive' });
  });

  it('RED: a USDC deposit is the inbound USDC watcher\'s, and its PE id is read by the gate', () => {
    const d = deriveChainRecordAct(ev({ logs: [transferLog(TX, BASE_USDC_ADDRESS, STRANGER, WALLET, 5n, 2)] }), WALLET);
    expect(d).toEqual({ status: 'no_act', reason: 'no_qualifying_receive', usdcWitnessPeIds: [inboundUsdcPeId(8453, TX, 2)] });
  });

  it('RED: an unknown token, a zero amount, or a self-transfer is no receive', () => {
    for (const log of [
      transferLog(TX, JUNK, STRANGER, WALLET, 5n, 1),
      transferLog(TX, DAI, STRANGER, WALLET, 0n, 1),
      transferLog(TX, DAI, WALLET, WALLET, 5n, 1),
    ]) {
      expect(deriveChainRecordAct(ev({ logs: [log] }), WALLET)).toMatchObject({ status: 'no_act', reason: 'no_qualifying_receive' });
    }
  });

  it('RED: a payout from a call into an institution is the institution watcher\'s', () => {
    const escrow = Object.values(INSTITUTION_ADDRESSES)[0];
    const d = deriveChainRecordAct(ev({ toAddress: escrow, logs: [transferLog(TX, DAI, escrow, WALLET, 5n, 1)] }), WALLET);
    expect(d).toMatchObject({ status: 'no_act', reason: 'institution_transaction' });
  });

  it('RED: the wallet\'s OWN transaction never derives a receive (what it got there is its own act)', () => {
    const claim = ev({ fromAddress: WALLET, toAddress: JUNK, logs: [transferLog(TX, DAI, JUNK, WALLET, 5n, 1)] });
    expect(deriveChainRecordAct(claim, WALLET)).toMatchObject({ status: 'no_act', reason: 'no_qualifying_leg' });
  });

  it('a receive alongside a USDC deposit in one transaction carries that deposit\'s PE id for the gate', () => {
    const d = deriveChainRecordAct(ev({
      logs: [transferLog(TX, BASE_USDC_ADDRESS, STRANGER, WALLET, 5n, 1), transferLog(TX, DAI, STRANGER, WALLET, 5n, 2)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'act', usdcWitnessPeIds: [inboundUsdcPeId(8453, TX, 1)] });
  });
});

describe('deriveChainRecordAct — a swap is keyed on its transaction from the landing', () => {
  const swap = (ts: number) => ev({
    fromAddress: WALLET,
    toAddress: ZEROX_ALLOWANCE_HOLDER_BASE,
    blockTimestampMs: ts,
    logs: [transferLog(TX, WETH, WALLET, SETTLER, 5n, 3), transferLog(TX, DAI, SETTLER, WALLET, 9n, 4)],
  });
  it('GREEN: at the landing the token-carried swap is keyed on the bare tx hash', () => {
    expect(deriveChainRecordAct(swap(VERIFIED_COMMERCE_CUT_LINE_MS), WALLET))
      .toMatchObject({ status: 'act', act: { actionType: 'swap', canonicalEventId: TX, logIndex: 3 } });
  });
  it('RED: before it, \'s log key is kept (a retry of an older observation derives the same PE)', () => {
    expect(deriveChainRecordAct(swap(VERIFIED_COMMERCE_CUT_LINE_MS - 1), WALLET))
      .toMatchObject({ status: 'act', act: { actionType: 'swap', canonicalEventId: `8453:${TX}:3` } });
  });
});

// ---------------------------------------------------------------------------

function seedHuman(db: FakeFirestore, over: Record<string, unknown> = {}, indexOver: Record<string, unknown> = {}): void {
  db.store.set('wallets/hw1', {
    id: 'hw1', user_id: 'user1', address: WALLET,
    native_watcher_registration: createNativeWalletRegistrationFence(TEST_BLOCK - 100),
    ...over,
  });
  db.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(WALLET)}`, {
    schema_version: 'native-wallet-address-index/v1', chain_id: 8453, address: WALLET,
    wallet_id: 'hw1', owner_type: 'human', owner_id: 'user1', created_at_ms: 1,
    ...indexOver,
  });
}

describe('resolveChainRecordWallet — a human wallet ', () => {
  let db: FakeFirestore;
  beforeEach(() => { db = createFakeFirestore(); });

  it('GREEN: resolves to the human, its user_id as the accrual identity', async () => {
    seedHuman(db);
    await expect(resolveChainRecordWallet(db as unknown as Firestore, 'hw1', 'human')).resolves.toEqual({
      walletId: 'hw1', agentId: 'user1', address: WALLET, eligibilityStartBlock: TEST_BLOCK - 99, ownerType: 'human',
    });
  });

  it('RED: an index naming an agent, another wallet, or another user is refused', async () => {
    for (const indexOver of [{ owner_type: 'agent' }, { wallet_id: 'hw2' }, { owner_id: 'user2' }]) {
      seedHuman(db, {}, indexOver);
      await expect(resolveChainRecordWallet(db as unknown as Firestore, 'hw1', 'human'))
        .rejects.toThrow(/chain_record_wallet_index_mismatch|native/);
    }
  });

  it('RED: a missing wallet doc throws; a test wallet earns nothing', async () => {
    await expect(resolveChainRecordWallet(db as unknown as Firestore, 'hw1', 'human')).rejects.toThrow('chain_record_wallet_missing');
    seedHuman(db, { platform: 'test' });
    await expect(resolveChainRecordWallet(db as unknown as Firestore, 'hw1', 'human')).resolves.toBeNull();
  });

  it('RED: a human wallet id resolved as an agent is not found (owner type is part of the identity)', async () => {
    seedHuman(db);
    await expect(resolveChainRecordWallet(db as unknown as Firestore, 'hw1', 'agent')).rejects.toThrow('chain_record_wallet_missing');
  });
});

describe('enqueueChainRecordObservation — the scan queues once, never resets', () => {
  it('creates when absent, reports false and leaves a processed observation alone when present', async () => {
    const db = createFakeFirestore();
    const fs = db as unknown as Firestore;
    await expect(enqueueChainRecordObservation(fs, { txHash: TX, walletId: 'hw1', source: 'inbound_scan', ownerType: 'human' }, 7))
      .resolves.toBe(true);
    const path = `${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(TX, 'hw1')}`;
    expect(db.store.get(path)).toMatchObject({ status: 'pending', source: 'inbound_scan', owner_type: 'human', record_pe_id: null });
    db.store.set(path, { ...(db.store.get(path) as object), status: 'complete' });
    await expect(enqueueChainRecordObservation(fs, { txHash: TX, walletId: 'hw1', source: 'inbound_scan', ownerType: 'human' }, 8))
      .resolves.toBe(false);
    expect(db.store.get(path)).toMatchObject({ status: 'complete' });
  });

  it('an agent observation carries no owner_type field (byte-identical to)', async () => {
    const db = createFakeFirestore();
    await enqueueChainRecordObservation(db as unknown as Firestore, { txHash: TX, walletId: 'w1', source: 'inbound_scan' }, 7);
    const doc = db.store.get(`${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(TX, 'w1')}`) as Record<string, unknown>;
    expect('owner_type' in doc).toBe(false);
  });
});

describe('runChainRecordWatcherCycle — humans, receives, the pointer horizon, back-off ', () => {
  let db: FakeFirestore;
  let verify: jest.Mock<(tx: string) => Promise<BaseTransactionEvidence>>;
  let emit: jest.Mock<ChainRecordWatcherDeps['emitActPE']>;
  let now: number;
  const deps = (): ChainRecordWatcherDeps => ({
    db: db as unknown as Firestore, verifyTransaction: verify, emitActPE: emit, now: () => now,
  });
  async function enqueueHuman(source: 'app_send_record' | 'inbound_scan' = 'app_send_record'): Promise<string> {
    if (source === 'inbound_scan') {
      await enqueueChainRecordObservation(db as unknown as Firestore, { txHash: TX, walletId: 'hw1', source, ownerType: 'human' }, now);
    } else {
      const e = chainRecordEnqueue(db as unknown as Firestore, { txHash: TX, walletId: 'hw1', source, ownerType: 'human' });
      await db.runTransaction(async (txn) => { await e.read(txn as never); e.write(txn as never, 'pe_app_send'); });
      const p = `${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(TX, 'hw1')}`;
      db.store.set(p, { ...(db.store.get(p) as object), requested_at_ms: now, next_attempt_at_ms: now });
    }
    return `${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(TX, 'hw1')}`;
  }
  const humanSend = (ts = AFTER) => ev({ fromAddress: WALLET, toAddress: STRANGER, valueWei: '1000', inputEmpty: true, logs: [], blockTimestampMs: ts });

  beforeEach(() => {
    db = createFakeFirestore();
    now = AFTER + 3_600_000;
    verify = jest.fn(async () => humanSend());
    emit = jest.fn(async (_w, act) => ({ peId: chainRecordPeId(act.canonicalEventId, act.actionType) }));
    seedHuman(db);
  });

  it('GREEN: a human\'s app send record → one send emitted for the HUMAN wallet', async () => {
    const path = await enqueueHuman();
    const r = await runChainRecordWatcherCycle(deps());
    expect(r).toMatchObject({ emitted: 1, by_type: { send: 1, swap: 0, receive: 0 } });
    expect(emit.mock.calls[0][0]).toEqual({
      walletId: 'hw1', agentId: 'user1', address: WALLET, eligibilityStartBlock: TEST_BLOCK - 99, ownerType: 'human',
    });
    expect(emit.mock.calls[0][3]).toEqual({ recordPeId: 'pe_app_send', source: 'app_send_record' });
    expect(db.store.get(path)).toMatchObject({ status: 'complete', outcome: { action_type: 'send' } });
  });

  it('RED: the same human send mined before the landing is refused (an agent\'s would mint from)', async () => {
    verify.mockResolvedValue(humanSend(VERIFIED_COMMERCE_CUT_LINE_MS - 1));
    const path = await enqueueHuman();
    await runChainRecordWatcherCycle(deps());
    expect(emit).not.toHaveBeenCalled();
    expect(db.store.get(path)).toMatchObject({ status: 'refused', outcome: { reason: 'before_landing' } });
  });

  it('GREEN: a scanned DAI receive for the human → one receive emitted', async () => {
    verify.mockResolvedValue(ev());
    await enqueueHuman('inbound_scan');
    const r = await runChainRecordWatcherCycle(deps());
    expect(r).toMatchObject({ emitted: 1, by_type: { receive: 1 } });
    expect(emit.mock.calls[0][1]).toMatchObject({ actionType: 'receive', counterpartyAddress: STRANGER });
  });

  it('RED: a receive mined before the landing is refused, even for an agent wallet', async () => {
    db.store.set('agent_wallets/w1', {
      id: 'w1', agent_id: 'agent1', address: SETTLER, platform: 'claude',
      native_watcher_registration: createNativeWalletRegistrationFence(TEST_BLOCK - 100),
    });
    db.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(SETTLER)}`, {
      schema_version: 'native-wallet-address-index/v1', chain_id: 8453, address: SETTLER,
      wallet_id: 'w1', owner_type: 'agent', owner_id: 'agent1', created_at_ms: 1,
    });
    verify.mockResolvedValue(ev({
      blockTimestampMs: VERIFIED_COMMERCE_CUT_LINE_MS - 1,
      logs: [transferLog(TX, DAI, STRANGER, SETTLER, 5n, 1)],
    }));
    await enqueueChainRecordObservation(db as unknown as Firestore, { txHash: TX, walletId: 'w1', source: 'inbound_scan' }, now);
    await runChainRecordWatcherCycle(deps());
    expect(emit).not.toHaveBeenCalled();
    expect(db.store.get(`${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(TX, 'w1')}`))
      .toMatchObject({ status: 'refused', outcome: { reason: 'before_landing' } });
  });

  it('RED: a resolver that answers with the wrong owner type is refused', async () => {
    const path = await enqueueHuman();
    await runChainRecordWatcherCycle({
      ...deps(),
      resolveWallet: async () => ({ walletId: 'hw1', agentId: 'x', address: WALLET, eligibilityStartBlock: 0, ownerType: 'agent' }),
    });
    expect(emit).not.toHaveBeenCalled();
    expect(db.store.get(path)).toMatchObject({ status: 'refused', outcome: { reason: 'wallet_owner_type_mismatch' } });
  });

  it('the untrusted-pointer horizon: an unfindable hash waits for an hour, then is refused', async () => {
    verify.mockRejectedValue(new Error('economic_evidence_pending:transaction_unavailable'));
    const path = await enqueueHuman();
    const first = await runChainRecordWatcherCycle(deps());
    expect(first.waiting).toBe(1);
    expect(db.store.get(path)).toMatchObject({ status: 'pending' });
    now += CHAIN_RECORD_NOT_FOUND_HORIZON_MS + 1;
    db.store.set(path, { ...(db.store.get(path) as object), next_attempt_at_ms: now });
    await runChainRecordWatcherCycle(deps());
    expect(db.store.get(path)).toMatchObject({ status: 'refused', outcome: { reason: 'transaction_not_found' } });
  });

  it('RED: a FOUND but not-yet-final transaction is not refused at the hour (only the 7-day horizon closes it)', async () => {
    verify.mockRejectedValue(new Error('economic_evidence_pending:safe_head:1/2'));
    const path = await enqueueHuman();
    now += CHAIN_RECORD_NOT_FOUND_HORIZON_MS + 1;
    await runChainRecordWatcherCycle(deps());
    expect(db.store.get(path)).toMatchObject({ status: 'pending', last_reason: 'economic_evidence_pending:safe_head:1/2' });
  });

  it('retries back off: 2 minutes, then 4, capped at 30', async () => {
    verify.mockRejectedValue(new Error('economic_evidence_pending:confirmations:3/12'));
    const path = await enqueueHuman();
    await runChainRecordWatcherCycle(deps());
    expect((db.store.get(path) as { next_attempt_at_ms: number }).next_attempt_at_ms).toBe(now + 2 * 60_000);
    now += 2 * 60_000;
    await runChainRecordWatcherCycle(deps());
    expect((db.store.get(path) as { next_attempt_at_ms: number }).next_attempt_at_ms).toBe(now + 4 * 60_000);
    db.store.set(path, { ...(db.store.get(path) as object), attempts: 40, next_attempt_at_ms: now });
    await runChainRecordWatcherCycle(deps());
    expect((db.store.get(path) as { next_attempt_at_ms: number }).next_attempt_at_ms).toBe(now + 30 * 60_000);
  });

  it('RED: an observation with an unknown source is never processed (malformed → skipped)', async () => {
    const path = await enqueueHuman();
    db.store.set(path, { ...(db.store.get(path) as object), source: 'self_report' });
    const r = await runChainRecordWatcherCycle(deps());
    expect(r.leased).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('RED (review r1 defect 2): a wallet that cannot be resolved now is retried, not refused; it emits once it resolves', async () => {
    db.store.delete('wallets/hw1');
    const path = await enqueueHuman();
    const first = await runChainRecordWatcherCycle(deps());
    expect(first.waiting).toBe(1);
    expect(db.store.get(path)).toMatchObject({ status: 'pending', last_reason: 'wallet_unresolvable:chain_record_wallet_missing' });
    seedHuman(db);
    now += 2 * 60_000;
    const second = await runChainRecordWatcherCycle(deps());
    expect(second.emitted).toBe(1);
  });
});
