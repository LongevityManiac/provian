/**
 * the chain-record lane: act derivation, the cross-lane mint-once gate,
 * and the observation cycle. The money outcome (what the emitted act SEALS
 * through the real fences) is proven in `chain-record-watcher.acceptance.test.ts`.
 *
 * Every guard here ships with its violating input : each `no_act` /
 * `refused` / `wait` case is the RED side of an adjacent GREEN case that differs
 * in exactly the variable the guard reads.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import type { Firestore } from 'firebase-admin/firestore';
import {
  CHAIN_RECORD_EXCLUDED_COUNTERPARTIES,
  CHAIN_RECORD_MINT_CUT_LINE_MS,
  CHAIN_RECORD_OBSERVATION_HORIZON_MS,
  CHAIN_RECORD_OBSERVATIONS_COLLECTION,
  ZEROX_ALLOWANCE_HOLDER_BASE,
  chainRecordEnqueue,
  chainRecordObservationId,
  chainRecordPeId,
  buildChainRecordWatcherDeps,
  deriveChainRecordAct,
  readUsdcWitnessVerdict,
  reopenParkedChainRecordObservations,
  runChainRecordWatcherCycle,
  type ChainRecordWatcherDeps,
} from './chain-record-watcher';
import {
  BASE_USDC_ADDRESS,
  ERC20_TRANSFER_TOPIC,
  hashBaseTransactionEvidence,
  type BaseInternalEthEvidence,
  type BaseTransactionEvidence,
  type CanonicalEconomicLog,
  type InternalEthFrame,
} from '../onchain/economic-discovery';
import { buildChainRecordInboundScanDeps } from './chain-record-inbound-scan';
import type { AgentBankDeps } from '../agent-bank/types';
import { outboundUsdcPeId } from './outbound-usdc-watcher';
import { inboundUsdcPeId } from './inbound-usdc-watcher';
import { INSTITUTION_ADDRESSES } from './institution-funding-watcher';
import {
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  createNativeWalletRegistrationFence,
  nativeWalletAddressIndexId,
} from './native-wallet-registration';

const WALLET = '0xa11ce00000000000000000000000000000000001';
const STRANGER = '0x5000000000000000000000000000000000000005';
const POOL = '0x9000000000000000000000000000000000000009';
const WETH = '0x4200000000000000000000000000000000000006';
const USDT = '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2';
const PVT = '0x8811441914381143b9408c5c32247367f86f173a';
const JUNK_TOKEN = '0x7777777777777777777777777777777777777777';
const UNISWAP_ROUTER = '0x2626664c2603336e57b271c5c0b26f421741e481';
const TX = `0x${'ab'.repeat(32)}`;
const BLOCK = 60_000_000;
const AFTER_LANDING = CHAIN_RECORD_MINT_CUT_LINE_MS + 60_000;

const topic = (a: string) => `0x${a.toLowerCase().slice(2).padStart(64, '0')}`;

function transferLog(token: string, from: string, to: string, amount: bigint, logIndex: number): CanonicalEconomicLog {
  return {
    address: token,
    topics: [ERC20_TRANSFER_TOPIC, topic(from), topic(to)],
    data: `0x${amount.toString(16).padStart(64, '0')}`,
    blockNumber: BLOCK,
    blockHash: `0x${'bb'.repeat(32)}`,
    transactionHash: TX,
    transactionIndex: 0,
    logIndex,
    removed: false,
  };
}

function evidence(over: Partial<Omit<BaseTransactionEvidence, 'evidenceHash'>> = {}): BaseTransactionEvidence {
  const base: Omit<BaseTransactionEvidence, 'evidenceHash'> = {
    schemaVersion: 'base-transaction-evidence/v1',
    chainId: 8453,
    transactionHash: TX,
    blockNumber: BLOCK,
    blockHash: `0x${'bb'.repeat(32)}`,
    blockTimestampMs: AFTER_LANDING,
    confirmationFloor: 12,
    providerOperatorIds: ['op-a', 'op-b'],
    fromAddress: WALLET,
    toAddress: STRANGER,
    valueWei: '1000',
    inputEmpty: true,
    transactionSelector: null,
    logs: [],
    ...over,
  };
  return { ...base, evidenceHash: hashBaseTransactionEvidence(base) };
}

describe('the USDC watchers\' deterministic PE ids are unchanged by the extraction ', () => {
  // Literals computed from the pre- inline template, not from the helpers.
  it('outbound', () => {
    expect(outboundUsdcPeId(8453, TX, 3))
      .toBe('pe_outbound_9681f02387b5e45b29fae6bb04be618e34cf62578e25095ad950f373acbdc879');
  });
  it('inbound', () => {
    expect(inboundUsdcPeId(8453, TX.toUpperCase().replace('0X', '0x'), 4))
      .toBe('pe_inbound_c77e27067ad9ff2633a4f52af12052d4eb3b0c3ecc2fd817b5ae67bd986b409b');
  });
});

describe('deriveChainRecordAct — the act comes from the chain alone', () => {
  it('a plain native value transfer → send to tx.to, keyed on the bare tx hash', () => {
    const d = deriveChainRecordAct(evidence(), WALLET);
    expect(d).toMatchObject({
      status: 'act',
      act: { actionType: 'send', counterpartyAddress: STRANGER, canonicalEventId: TX, leg: 'native', amountAtomic: '1000' },
    });
  });

  it('RED: the same value with calldata to a non-router contract is not a send', () => {
    const d = deriveChainRecordAct(evidence({ inputEmpty: false, transactionSelector: '0x12345678' }), WALLET);
    expect(d).toMatchObject({ status: 'no_act', reason: 'no_qualifying_leg' });
  });

  it('a plain native transfer the wallet did not sign is a RECEIVE from its sender, keyed on the tx hash (2026-10-01: ETH receives mint)', () => {
    expect(deriveChainRecordAct(evidence({ fromAddress: STRANGER, toAddress: WALLET }), WALLET)).toMatchObject({
      status: 'act',
      act: { actionType: 'receive', counterpartyAddress: STRANGER, canonicalEventId: TX, leg: 'native', assetSymbol: 'ETH', assetAddress: null, amountAtomic: '1000', logIndex: null },
    });
  });

  it('RED: a transaction the wallet did not sign with NO native value derives no receive', () => {
    expect(deriveChainRecordAct(evidence({ fromAddress: STRANGER, toAddress: WALLET, valueWei: '0' }), WALLET))
      .toMatchObject({ status: 'no_act', reason: 'no_qualifying_receive' });
  });

  it('RED: native value into the wallet WITH calldata is not a plain transfer, so no receive', () => {
    expect(deriveChainRecordAct(evidence({ fromAddress: STRANGER, toAddress: WALLET, inputEmpty: false, transactionSelector: '0x12345678' }), WALLET))
      .toMatchObject({ status: 'no_act', reason: 'no_qualifying_receive' });
  });

  it('RED: native value to SOMEONE ELSE in a transaction the wallet did not sign is not the wallet\'s receive', () => {
    expect(deriveChainRecordAct(evidence({ fromAddress: STRANGER, toAddress: '0x7000000000000000000000000000000000000007' }), WALLET))
      .toMatchObject({ status: 'no_act', reason: 'no_qualifying_receive' });
  });

  it('RED: native value from an excluded counterparty (an institution) is not a receive', () => {
    const institution = [...CHAIN_RECORD_EXCLUDED_COUNTERPARTIES].find((a) => a !== `0x${'0'.repeat(40)}`)!;
    expect(deriveChainRecordAct(evidence({ fromAddress: institution, toAddress: WALLET }), WALLET))
      .toMatchObject({ status: 'no_act', reason: 'no_qualifying_receive' });
  });

  it('RED: a contract creation derives nothing', () => {
    expect(deriveChainRecordAct(evidence({ toAddress: null }), WALLET))
      .toMatchObject({ status: 'no_act', reason: 'contract_creation' });
  });

  it('a PVT or USDT transfer → send to the log recipient, keyed on the log', () => {
    for (const token of [PVT, USDT]) {
      const d = deriveChainRecordAct(evidence({
        toAddress: token, valueWei: '0', inputEmpty: false, transactionSelector: '0xa9059cbb',
        logs: [transferLog(token, WALLET, STRANGER, 5n, 9)],
      }), WALLET);
      expect(d).toMatchObject({
        status: 'act',
        act: { actionType: 'send', counterpartyAddress: STRANGER, canonicalEventId: `8453:${TX}:9`, assetAddress: token, amountAtomic: '5' },
      });
    }
  });

  it('RED: an unknown token never mints (Unknown = Block)', () => {
    const d = deriveChainRecordAct(evidence({
      toAddress: JUNK_TOKEN, valueWei: '0', inputEmpty: false,
      logs: [transferLog(JUNK_TOKEN, WALLET, STRANGER, 5n, 9)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'no_act', reason: 'no_qualifying_leg' });
  });

  it('RED: a USDC transfer is the USDC watcher lane, never this lane\'s act', () => {
    const d = deriveChainRecordAct(evidence({
      toAddress: BASE_USDC_ADDRESS, valueWei: '0', inputEmpty: false,
      logs: [transferLog(BASE_USDC_ADDRESS, WALLET, STRANGER, 5n, 9)],
    }), WALLET);
    expect(d.status).toBe('no_act');
    expect(d.usdcWitnessPeIds).toEqual([outboundUsdcPeId(8453, TX, 9)]);
  });

  it('RED: PVT to a Provian kernel / institution / the zero address is not a send', () => {
    for (const to of [PVT, INSTITUTION_ADDRESSES.escrow, `0x${'0'.repeat(40)}`]) {
      expect(CHAIN_RECORD_EXCLUDED_COUNTERPARTIES.has(to)).toBe(true);
      const d = deriveChainRecordAct(evidence({
        toAddress: PVT, valueWei: '0', inputEmpty: false,
        logs: [transferLog(PVT, WALLET, to, 5n, 9)],
      }), WALLET);
      expect(d).toMatchObject({ status: 'no_act', reason: 'no_qualifying_leg' });
    }
  });

  it('a WETH→USDC swap through 0x → swap keyed on the WETH leg; the USDC proceeds are named for the gate', () => {
    const d = deriveChainRecordAct(evidence({
      toAddress: ZEROX_ALLOWANCE_HOLDER_BASE, valueWei: '0', inputEmpty: false,
      logs: [transferLog(WETH, WALLET, POOL, 7n, 1), transferLog(BASE_USDC_ADDRESS, POOL, WALLET, 9n, 2)],
    }), WALLET);
    expect(d).toMatchObject({
      status: 'act',
      act: { actionType: 'swap', counterpartyAddress: POOL, canonicalEventId: `8453:${TX}:1`, assetSymbol: 'WETH' },
    });
    expect(d.usdcWitnessPeIds).toEqual([inboundUsdcPeId(8453, TX, 2)]);
  });

  it('RED: a USDC→WETH swap\'s outbound leg is USDC → the outbound USDC watcher already witnesses it', () => {
    const d = deriveChainRecordAct(evidence({
      toAddress: ZEROX_ALLOWANCE_HOLDER_BASE, valueWei: '0', inputEmpty: false,
      logs: [transferLog(BASE_USDC_ADDRESS, WALLET, POOL, 9n, 1), transferLog(WETH, POOL, WALLET, 7n, 2)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'no_act', reason: 'usdc_leg_is_usdc_watcher_lane' });
  });

  it('a native-value swap through a Uniswap router that returns PVT → swap keyed on the tx', () => {
    const d = deriveChainRecordAct(evidence({
      toAddress: UNISWAP_ROUTER, inputEmpty: false,
      logs: [transferLog(PVT, POOL, WALLET, 3n, 4)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'act', act: { actionType: 'swap', canonicalEventId: TX, leg: 'native' } });
  });

  it('RED (review r1 #3): a value call to a router that exchanges nothing (refundETH) is not a swap', () => {
    const d = deriveChainRecordAct(evidence({ toAddress: UNISWAP_ROUTER, inputEmpty: false }), WALLET);
    expect(d).toMatchObject({ status: 'no_act', reason: 'swap_without_exchange' });
  });

  it('RED (review r1 #3): wrapping ETH into WETH through a router is not a swap', () => {
    const d = deriveChainRecordAct(evidence({
      toAddress: UNISWAP_ROUTER, inputEmpty: false,
      logs: [transferLog(WETH, POOL, WALLET, 1000n, 4)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'no_act', reason: 'swap_without_exchange' });
  });

  it('RED (review r1 #3): WETH out and WETH back through 0x (a self round trip) is not a swap', () => {
    const d = deriveChainRecordAct(evidence({
      toAddress: ZEROX_ALLOWANCE_HOLDER_BASE, valueWei: '0', inputEmpty: false,
      logs: [transferLog(WETH, WALLET, POOL, 7n, 1), transferLog(WETH, POOL, WALLET, 7n, 2)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'no_act', reason: 'swap_without_exchange' });
  });

  it('RED (review r1 #3): an unknown token received is not an exchange', () => {
    const d = deriveChainRecordAct(evidence({
      toAddress: ZEROX_ALLOWANCE_HOLDER_BASE, valueWei: '0', inputEmpty: false,
      logs: [transferLog(WETH, WALLET, POOL, 7n, 1), transferLog(JUNK_TOKEN, POOL, WALLET, 7n, 2)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'no_act', reason: 'swap_without_exchange' });
  });

  it('RED (review r2): a ZERO-amount inbound Transfer of another asset is not an exchange (router execute TRANSFER(DAI,wallet,0) + SWEEP)', () => {
    const DAI = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb';
    const d = deriveChainRecordAct(evidence({
      toAddress: '0x6ff5693b99212da76ad316178a184ab56d299b43', valueWei: '1', inputEmpty: false,
      logs: [transferLog(DAI, UNISWAP_ROUTER, WALLET, 0n, 1)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'no_act', reason: 'swap_without_exchange' });
    // GREEN twin: the same leg carrying 1 atomic unit is a real (if tiny) exchange.
    const real = deriveChainRecordAct(evidence({
      toAddress: '0x6ff5693b99212da76ad316178a184ab56d299b43', valueWei: '1', inputEmpty: false,
      logs: [transferLog(DAI, UNISWAP_ROUTER, WALLET, 1n, 1)],
    }), WALLET);
    expect(real).toMatchObject({ status: 'act', act: { actionType: 'swap' } });
  });

  it('RED (review r2): a wallet→wallet inbound Transfer (Permit2 pull to itself) is not an exchange', () => {
    const DAI = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb';
    const d = deriveChainRecordAct(evidence({
      toAddress: '0x6ff5693b99212da76ad316178a184ab56d299b43', valueWei: '1', inputEmpty: false,
      logs: [transferLog(DAI, WALLET, WALLET, 5n, 1)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'no_act', reason: 'swap_without_exchange' });
  });

  it('RED (review r2): WETH out and swept back plus a zero-value leg of another asset is not a swap', () => {
    const d = deriveChainRecordAct(evidence({
      toAddress: ZEROX_ALLOWANCE_HOLDER_BASE, valueWei: '0', inputEmpty: false,
      logs: [
        transferLog(WETH, WALLET, POOL, 7n, 1),
        transferLog(WETH, POOL, WALLET, 7n, 2),
        transferLog(USDT, POOL, WALLET, 0n, 3),
      ],
    }), WALLET);
    expect(d).toMatchObject({ status: 'no_act', reason: 'swap_without_exchange' });
  });

  it('RED (review r2): a zero-amount PVT transfer is not a send', () => {
    const d = deriveChainRecordAct(evidence({
      toAddress: PVT, valueWei: '0', inputEmpty: false,
      logs: [transferLog(PVT, WALLET, STRANGER, 0n, 9)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'no_act', reason: 'no_qualifying_leg' });
  });

  it('RED (review r3): a junk Transfer-signature log with empty data is skipped, never parsed', () => {
    const junk = { ...transferLog(JUNK_TOKEN, WALLET, STRANGER, 0n, 1), data: '0x' };
    expect(() => deriveChainRecordAct(evidence({
      toAddress: UNISWAP_ROUTER, valueWei: '1', inputEmpty: false, logs: [junk],
    }), WALLET)).not.toThrow();
    expect(deriveChainRecordAct(evidence({
      toAddress: JUNK_TOKEN, valueWei: '0', inputEmpty: false, logs: [junk],
    }), WALLET)).toMatchObject({ status: 'no_act', reason: 'no_qualifying_leg' });
  });

  it('RED (review r1 #1): a PVT promise funding (tx.to = PromiseV3, PVT lender→borrower) is the institution\'s act', () => {
    const d = deriveChainRecordAct(evidence({
      toAddress: INSTITUTION_ADDRESSES.promise, valueWei: '0', inputEmpty: false,
      logs: [transferLog(PVT, WALLET, STRANGER, 5n, 9)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'no_act', reason: 'institution_transaction' });
    // GREEN twin: the SAME PVT leg sent directly (tx.to = the token) is a send.
    const direct = deriveChainRecordAct(evidence({
      toAddress: PVT, valueWei: '0', inputEmpty: false,
      logs: [transferLog(PVT, WALLET, STRANGER, 5n, 9)],
    }), WALLET);
    expect(direct).toMatchObject({ status: 'act', act: { actionType: 'send' } });
  });

  it('one act per transaction: a batch of PVT sends mints its FIRST leg only', () => {
    const d = deriveChainRecordAct(evidence({
      toAddress: PVT, valueWei: '0', inputEmpty: false,
      logs: [transferLog(PVT, WALLET, STRANGER, 1n, 3), transferLog(PVT, WALLET, POOL, 1n, 4)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'act', act: { canonicalEventId: `8453:${TX}:3` } });
  });
});

describe('readUsdcWitnessVerdict — one transaction mints once across lanes', () => {
  let db: FakeFirestore;
  beforeEach(() => { db = createFakeFirestore(); });
  const put = (id: string, mint_status: string) => db.store.set(`pe_history/${id}`, { mint_status });

  it('no USDC legs → clear', async () => {
    expect(await readUsdcWitnessVerdict(db as unknown as Firestore, [])).toBe('clear');
  });
  it('the USDC witness has not sealed yet → wait', async () => {
    expect(await readUsdcWitnessVerdict(db as unknown as Firestore, ['pe_x'])).toBe('wait');
  });
  it('the USDC witness sealed record_only → clear', async () => {
    put('pe_x', 'record_only');
    expect(await readUsdcWitnessVerdict(db as unknown as Firestore, ['pe_x'])).toBe('clear');
  });
  it('RED: the USDC witness minted → minted', async () => {
    put('pe_x', 'eligible');
    expect(await readUsdcWitnessVerdict(db as unknown as Firestore, ['pe_x'])).toBe('minted');
  });
  it('RED (review r1 latent): a corroborated duplicate means the event minted elsewhere → minted', async () => {
    put('pe_x', 'corroborated_duplicate');
    expect(await readUsdcWitnessVerdict(db as unknown as Firestore, ['pe_x'])).toBe('minted');
  });
  it('RED: a pending or unrecognized status is not clear (Unknown = Block)', async () => {
    for (const s of ['pending_review', 'pending_cache', 'something_new']) {
      put('pe_x', s);
      expect(await readUsdcWitnessVerdict(db as unknown as Firestore, ['pe_x'])).toBe('wait');
    }
  });
});

describe('chainRecordEnqueue — created once, never reset', () => {
  it('writes when absent; a second record of the same tx does not overwrite a processed observation', async () => {
    const db = createFakeFirestore();
    const fs = db as unknown as Firestore;
    const first = chainRecordEnqueue(fs, { txHash: TX, walletId: 'w1', source: 'transfer_record' });
    await db.runTransaction(async (txn) => {
      await first.read(txn as never);
      first.write(txn as never, 'pe_record_1');
    });
    const path = `${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(TX, 'w1')}`;
    expect(db.store.get(path)).toMatchObject({ status: 'pending', record_pe_id: 'pe_record_1', source: 'transfer_record' });
    db.store.set(path, { ...(db.store.get(path) as object), status: 'complete' });
    const second = chainRecordEnqueue(fs, { txHash: TX, walletId: 'w1', source: 'swap_record' });
    await db.runTransaction(async (txn) => {
      await second.read(txn as never);
      second.write(txn as never, 'pe_record_2');
    });
    expect(db.store.get(path)).toMatchObject({ status: 'complete', record_pe_id: 'pe_record_1' });
  });
});

describe('runChainRecordWatcherCycle', () => {
  let db: FakeFirestore;
  let verify: jest.Mock<(tx: string) => Promise<BaseTransactionEvidence>>;
  let emit: jest.Mock<ChainRecordWatcherDeps['emitActPE']>;
  let now: number;

  function seedWallet(over: Record<string, unknown> = {}): void {
    db.store.set('agent_wallets/w1', {
      id: 'w1', agent_id: 'agent1', address: WALLET, platform: 'claude',
      native_watcher_registration: createNativeWalletRegistrationFence(BLOCK - 100),
      ...over,
    });
    db.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(WALLET)}`, {
      schema_version: 'native-wallet-address-index/v1', chain_id: 8453, address: WALLET,
      wallet_id: 'w1', owner_type: 'agent', owner_id: 'agent1', created_at_ms: 1,
    });
  }
  async function enqueue(): Promise<string> {
    const e = chainRecordEnqueue(db as unknown as Firestore, { txHash: TX, walletId: 'w1', source: 'transfer_record' });
    await db.runTransaction(async (txn) => { await e.read(txn as never); e.write(txn as never, 'pe_rec'); });
    const id = chainRecordObservationId(TX, 'w1');
    const path = `${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${id}`;
    db.store.set(path, { ...(db.store.get(path) as object), requested_at_ms: now, next_attempt_at_ms: now });
    return path;
  }
  const deps = (): ChainRecordWatcherDeps => ({
    db: db as unknown as Firestore, verifyTransaction: verify, emitActPE: emit, now: () => now,
  });

  beforeEach(() => {
    db = createFakeFirestore();
    now = AFTER_LANDING + 3_600_000;
    verify = jest.fn(async () => evidence());
    emit = jest.fn(async (_w, act) => ({ peId: chainRecordPeId(act.canonicalEventId, act.actionType) }));
    seedWallet();
  });

  it('GREEN: a final native send is emitted once, and the observation completes', async () => {
    const path = await enqueue();
    const r = await runChainRecordWatcherCycle(deps());
    expect(r).toMatchObject({ emitted: 1, by_type: { send: 1, swap: 0 } });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({ walletId: 'w1', agentId: 'agent1', address: WALLET });
    expect(db.store.get(path)).toMatchObject({
      status: 'complete', outcome: { pe_id: chainRecordPeId(TX), action_type: 'send' },
    });
  });

  it('RED (observed twice): a second cycle over a completed observation emits nothing', async () => {
    await enqueue();
    await runChainRecordWatcherCycle(deps());
    now += 3_600_000;
    const r = await runChainRecordWatcherCycle(deps());
    expect(r.leased).toBe(0);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('a not-yet-final transaction waits, then emits once it is final', async () => {
    const path = await enqueue();
    verify.mockRejectedValueOnce(new Error('economic_evidence_pending:confirmations:3/12'));
    const r1 = await runChainRecordWatcherCycle(deps());
    expect(r1).toMatchObject({ waiting: 1, emitted: 0 });
    expect(db.store.get(path)).toMatchObject({ status: 'pending' });
    now += 3 * 60_000;
    const r2 = await runChainRecordWatcherCycle(deps());
    expect(r2.emitted).toBe(1);
  });

  it('an emit that throws retries under the SAME deterministic PE id', async () => {
    await enqueue();
    emit.mockRejectedValueOnce(new Error('firestore contention'));
    const r1 = await runChainRecordWatcherCycle(deps());
    expect(r1.errors).toBe(1);
    now += 10 * 60_000;
    await runChainRecordWatcherCycle(deps());
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[0][1].canonicalEventId).toBe(emit.mock.calls[1][1].canonicalEventId);
  });

  it('RED: a reverted transaction is refused', async () => {
    const path = await enqueue();
    verify.mockRejectedValueOnce(new Error('economic_evidence_transaction_failed'));
    await runChainRecordWatcherCycle(deps());
    expect(db.store.get(path)).toMatchObject({ status: 'refused', outcome: { reason: 'transaction_failed' } });
    expect(emit).not.toHaveBeenCalled();
  });

  it('RED: a transaction mined before the landing never mints (no repricing backward)', async () => {
    const path = await enqueue();
    verify.mockResolvedValueOnce(evidence({ blockTimestampMs: CHAIN_RECORD_MINT_CUT_LINE_MS - 1 }));
    await runChainRecordWatcherCycle(deps());
    expect(db.store.get(path)).toMatchObject({ status: 'refused', outcome: { reason: 'before_landing' } });
    expect(emit).not.toHaveBeenCalled();
  });

  it('RED: a transaction before the wallet\'s registration fence never mints', async () => {
    const path = await enqueue();
    verify.mockResolvedValueOnce(evidence({ blockNumber: BLOCK - 100 }));
    await runChainRecordWatcherCycle(deps());
    expect(db.store.get(path)).toMatchObject({ status: 'refused', outcome: { reason: 'before_wallet_fence' } });
  });

  it('RED: a transaction signed by another address derives no send (read as a receive; none qualifies)', async () => {
    const path = await enqueue();
    verify.mockResolvedValueOnce(evidence({ fromAddress: STRANGER }));
    await runChainRecordWatcherCycle(deps());
    expect(db.store.get(path)).toMatchObject({ status: 'complete', outcome: { reason: 'no_qualifying_receive' } });
    expect(emit).not.toHaveBeenCalled();
  });

  it('RED: a test wallet never earns', async () => {
    seedWallet({ platform: 'test' });
    const path = await enqueue();
    await runChainRecordWatcherCycle(deps());
    expect(db.store.get(path)).toMatchObject({ status: 'refused', outcome: { reason: 'test_wallet' } });
  });

  it('the cross-lane gate: waits for the USDC witness, emits when it recorded, emits nothing when it minted', async () => {
    const swap = evidence({
      toAddress: ZEROX_ALLOWANCE_HOLDER_BASE, valueWei: '0', inputEmpty: false,
      logs: [transferLog(WETH, WALLET, POOL, 7n, 1), transferLog(BASE_USDC_ADDRESS, POOL, WALLET, 9n, 2)],
    });
    verify.mockResolvedValue(swap);
    const receiveId = inboundUsdcPeId(8453, TX, 2);

    const path = await enqueue();
    expect((await runChainRecordWatcherCycle(deps())).waiting).toBe(1);

    db.store.set(`pe_history/${receiveId}`, { mint_status: 'eligible' });
    now += 3 * 60_000;
    await runChainRecordWatcherCycle(deps());
    expect(db.store.get(path)).toMatchObject({ status: 'complete', outcome: { reason: 'usdc_witness_minted' } });
    expect(emit).not.toHaveBeenCalled();

    db.store.set(path, { ...(db.store.get(path) as object), status: 'pending', next_attempt_at_ms: now });
    db.store.set(`pe_history/${receiveId}`, { mint_status: 'record_only' });
    await runChainRecordWatcherCycle(deps());
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1]).toMatchObject({ actionType: 'swap', canonicalEventId: `8453:${TX}:1` });
  });

  it('RED (review r3): finished and waiting observations never crowd a ready one out of the batch', async () => {
    // 5 waiting (due later) + 5 finished, then ONE ready: batch of 1 must still reach it.
    for (let i = 0; i < 10; i += 1) {
      db.store.set(`${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/obs_00${i}`, {
        schema_version: 'chain-record-observation/v1', chain_id: 8453, tx_hash: `0x${String(i).repeat(64)}`,
        wallet_id: 'w1', source: 'transfer_record', record_pe_id: null, requested_at_ms: now,
        status: i < 5 ? 'pending' : 'complete', attempts: 1,
        next_attempt_at_ms: i < 5 ? now + 60_000 : Number.MAX_SAFE_INTEGER, lease_until_ms: 0,
      });
    }
    await enqueue();
    const r = await runChainRecordWatcherCycle(deps(), { batch: 1 });
    expect(r.emitted).toBe(1);
  });

  it('RED (review r3): an unexpected throw is not retried past the horizon', async () => {
    const path = await enqueue();
    emit.mockRejectedValue(new Error('boom'));
    now += CHAIN_RECORD_OBSERVATION_HORIZON_MS + 1;
    // The chain read must still succeed for the emit to be reached.
    await runChainRecordWatcherCycle(deps());
    expect(db.store.get(path)).toMatchObject({ status: 'refused', next_attempt_at_ms: Number.MAX_SAFE_INTEGER });
  });

  it('an observation that never becomes final closes at the horizon without a mint', async () => {
    const path = await enqueue();
    verify.mockRejectedValue(new Error('economic_evidence_pending:transaction_unavailable'));
    now += CHAIN_RECORD_OBSERVATION_HORIZON_MS + 1;
    await runChainRecordWatcherCycle(deps());
    expect(db.store.get(path)).toMatchObject({ status: 'refused' });
    expect(emit).not.toHaveBeenCalled();
  });

  it('an observation refused at the horizon on a provider disagreement is re-opened and then mints once', async () => {
    const path = await enqueue();
    const requestedAt = now;
    verify.mockRejectedValue(new Error('economic_discovery_rpc_disagreement:transaction'));
    now += CHAIN_RECORD_OBSERVATION_HORIZON_MS + 1;
    await runChainRecordWatcherCycle(deps());
    expect(db.store.get(path)).toMatchObject({
      status: 'refused', outcome: { reason: 'horizon_expired:economic_discovery_rpc_disagreement:transaction' },
    });
    // Dry run names it and changes nothing.
    const dry = await reopenParkedChainRecordObservations(db as unknown as Firestore, { sinceMs: requestedAt, execute: false, now });
    expect(dry.reopened.map((r) => r.status)).toEqual(['refused']);
    expect(db.store.get(path)).toMatchObject({ status: 'refused' });
    const done = await reopenParkedChainRecordObservations(db as unknown as Firestore, { sinceMs: requestedAt, execute: true, now });
    expect(done.reopened).toHaveLength(1);
    expect(db.store.get(path)).toMatchObject({ status: 'pending', reopened_at_ms: now, next_attempt_at_ms: now });
    // The providers agree again: the re-opened observation mints once, inside its fresh horizon.
    verify.mockReset();
    verify.mockImplementation(async () => evidence());
    const r = await runChainRecordWatcherCycle(deps());
    expect(r.emitted).toBe(1);
    expect(db.store.get(path)).toMatchObject({ status: 'complete' });
    // A second re-open finds nothing parked: a completed observation is never touched.
    const again = await reopenParkedChainRecordObservations(db as unknown as Firestore, { sinceMs: requestedAt, execute: true, now });
    expect(again.reopened).toHaveLength(0);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('RED: re-open touches no observation refused for any other reason, nor one requested before the cut', async () => {
    const path = await enqueue();
    verify.mockRejectedValue(new Error('economic_evidence_transaction_failed'));
    await runChainRecordWatcherCycle(deps());
    expect(db.store.get(path)).toMatchObject({ status: 'refused', outcome: { reason: 'transaction_failed' } });
    const r = await reopenParkedChainRecordObservations(db as unknown as Firestore, { sinceMs: 0, execute: true, now });
    expect(r.scanned).toBeGreaterThan(0);
    expect(r.reopened).toHaveLength(0);
    // A disagreement-parked observation requested before `sinceMs` is left alone too.
    db.store.set(path, { ...(db.store.get(path) as object), status: 'pending', last_reason: 'economic_discovery_rpc_disagreement:transaction', outcome: null });
    const late = await reopenParkedChainRecordObservations(db as unknown as Firestore, { sinceMs: now + 1, execute: true, now });
    expect(late.reopened).toHaveLength(0);
    const inRange = await reopenParkedChainRecordObservations(db as unknown as Firestore, { sinceMs: 0, execute: false, now });
    expect(inRange.reopened).toHaveLength(1);
  });
});

describe('2026-10-01 — ETH that arrives INSIDE a transaction (deriveChainRecordAct with the agreed trace)', () => {
  const SMART_WALLET = '0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a';
  const BUNDLER = '0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';
  const viaBundler = () => evidence({ fromAddress: BUNDLER, toAddress: '0x0000000071727de22e5e9d8baf0edac6f37da032', inputEmpty: false });
  const trace = (e: BaseTransactionEvidence, frames: InternalEthFrame[]): BaseInternalEthEvidence => ({
    schemaVersion: 'base-internal-eth-evidence/v1', transactionHash: e.transactionHash, blockNumber: e.blockNumber,
    blockHash: e.blockHash, providerOperatorIds: ['alchemy', 'drpc'], frames, evidenceHash: `0x${'ee'.repeat(32)}`,
  });
  const frame = (from: string, to: string, valueWei = '700', traceAddress: number[] = [0, 0, 0]): InternalEthFrame =>
    ({ traceAddress, kind: 'call', fromAddress: from, toAddress: to, valueWei });

  it('the first ETH movement into the wallet is the receive; the counterparty is the address that sent the ETH', () => {
    const e = viaBundler();
    const d = deriveChainRecordAct(e, WALLET, trace(e, [
      frame(BUNDLER, STRANGER, '1', [0]),
      frame(SMART_WALLET, WALLET, '700', [0, 1]),
      frame(STRANGER, WALLET, '900', [0, 2]),
    ]));
    expect(d).toMatchObject({
      status: 'act',
      act: {
        actionType: 'receive', counterpartyAddress: SMART_WALLET, canonicalEventId: e.transactionHash, peIdKey: `${e.transactionHash}:eth:${WALLET}`,
        leg: 'native', assetSymbol: 'ETH', assetAddress: null, amountAtomic: '700', logIndex: null,
        internal: { traceAddress: [0, 1], providerOperatorIds: ['alchemy', 'drpc'] },
      },
    });
  });

  it('RED: without the trace the same transaction derives no receive (the plain rule alone)', () => {
    expect(deriveChainRecordAct(viaBundler(), WALLET)).toMatchObject({ status: 'no_act', reason: 'no_qualifying_receive' });
  });

  it('RED: an excluded sender, the wallet itself, or ETH to someone else is not a receive', () => {
    const e = viaBundler();
    const excluded = [...CHAIN_RECORD_EXCLUDED_COUNTERPARTIES][0];
    expect(deriveChainRecordAct(e, WALLET, trace(e, [frame(excluded, WALLET), frame(WALLET, WALLET), frame(SMART_WALLET, STRANGER)])))
      .toMatchObject({ status: 'no_act', reason: 'no_qualifying_receive' });
  });

  it('RED: a trace of another transaction or another block is an integrity fault, never a receive', () => {
    const e = viaBundler();
    expect(() => deriveChainRecordAct(e, WALLET, { ...trace(e, [frame(SMART_WALLET, WALLET)]), blockHash: `0x${'cd'.repeat(32)}` }))
      .toThrow('internal_eth_evidence_mismatch');
    expect(() => deriveChainRecordAct(e, WALLET, { ...trace(e, [frame(SMART_WALLET, WALLET)]), transactionHash: `0x${'01'.repeat(32)}` }))
      .toThrow('internal_eth_evidence_mismatch');
  });

  it('a transaction the wallet SIGNED never derives a receive from its trace — its own act (a swap paying out ETH is the swap)', () => {
    const e = evidence({ fromAddress: WALLET, toAddress: STRANGER, inputEmpty: false, transactionSelector: '0x12345678' });
    expect(deriveChainRecordAct(e, WALLET, trace(e, [frame(STRANGER, WALLET)]))).toMatchObject({ status: 'no_act', reason: 'no_qualifying_leg' });
  });

  it('a token receive in the same transaction takes precedence: one transaction, one receive', () => {
    const e = evidence({ fromAddress: BUNDLER, toAddress: USDT, inputEmpty: false, logs: [transferLog(USDT, STRANGER, WALLET, 5n, 3)] });
    expect(deriveChainRecordAct(e, WALLET, trace(e, [frame(SMART_WALLET, WALLET)]))).toMatchObject({
      status: 'act', act: { actionType: 'receive', leg: 'erc20', assetSymbol: 'USDT' },
    });
  });

  it('production deps wire the agreed trace reader (the watcher) and the trace discovery (the scan)', () => {
    const deps = buildChainRecordWatcherDeps({ db: createFakeFirestore() } as unknown as AgentBankDeps);
    expect(typeof deps.readInternalEth).toBe('function');
    const scan = buildChainRecordInboundScanDeps(createFakeFirestore() as unknown as Firestore);
    expect(typeof scan.getInternalTransfers).toBe('function');
  });
});
