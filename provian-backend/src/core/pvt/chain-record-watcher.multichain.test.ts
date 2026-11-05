/**
 * The chain-record lane on Arbitrum One and OP Mainnet, and cross-chain swaps
 * on every chain: the same rule as Base, read from each chain's own facts.
 * Every guard is shown failing on its violating input beside the passing case.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import {
  CHAIN_RECORD_OBSERVATIONS_COLLECTION,
  chainRecordEnqueue,
  chainRecordObservationId,
  chainRecordPeId,
  chainRecordProfileFor,
  deriveChainRecordAct,
  runChainRecordWatcherCycle,
  type ChainRecordWatcherDeps,
} from './chain-record-watcher';
import { LIFI_TRANSFER_STARTED_TOPIC } from './wallet-exchange';
import {
  ARBITRUM_CHAIN_RECORD_PROFILE,
  LIFI_DIAMOND,
  MULTICHAIN_COMMERCE_CUT_LINE_MS,
  OPTIMISM_CHAIN_RECORD_PROFILE,
} from './chain-record-chains';
import {
  BASE_USDC_ADDRESS,
  ERC20_TRANSFER_TOPIC,
  hashBaseTransactionEvidence,
  type BaseTransactionEvidence,
  type CanonicalEconomicLog,
  type ChainTransactionEvidence,
  type EvmTransactionEvidence,
} from '../onchain/economic-discovery';
import {
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  createNativeWalletRegistrationFence,
  nativeWalletAddressIndexId,
} from './native-wallet-registration';

const WALLET = '0xa11ce00000000000000000000000000000000001';
const STRANGER = '0x5000000000000000000000000000000000000005';
const ROUTER = '0x9000000000000000000000000000000000000009';
const ARB_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const ARB_TOKEN = '0x912ce59144191c1204e64559fe8253a0e49e6548';
const OP_WETH = '0x4200000000000000000000000000000000000006';
const OP_OP = '0x4200000000000000000000000000000000000042';
const JUNK = '0x7777777777777777777777777777777777777777';
const ZEROX = '0x0000000000001ff3684f28c67538d4d072c22734';
const TX = `0x${'cd'.repeat(32)}`;
const BLOCK = 300_000_000;
const AFTER = MULTICHAIN_COMMERCE_CUT_LINE_MS + 60_000;

const topic = (a: string) => `0x${a.toLowerCase().slice(2).padStart(64, '0')}`;
/** The Diamond's own record that a cross-chain transfer started in this transaction. */
function bridgeStartedLog(logIndex: number, emitter: string = LIFI_DIAMOND): CanonicalEconomicLog {
  return {
    address: emitter,
    topics: [LIFI_TRANSFER_STARTED_TOPIC],
    data: '0x',
    blockNumber: BLOCK,
    blockHash: `0x${'bb'.repeat(32)}`,
    transactionHash: TX,
    transactionIndex: 0,
    logIndex,
    removed: false,
  };
}
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

function evmEvidence(chainId: 42161 | 10, over: Partial<Omit<EvmTransactionEvidence, 'evidenceHash'>> = {}): EvmTransactionEvidence {
  const body: Omit<EvmTransactionEvidence, 'evidenceHash'> = {
    schemaVersion: 'evm-transaction-evidence/v1',
    chainId,
    transactionHash: TX,
    blockNumber: BLOCK,
    blockHash: `0x${'bb'.repeat(32)}`,
    blockTimestampMs: AFTER,
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
  return { ...body, evidenceHash: hashBaseTransactionEvidence(body) };
}

function baseEvidence(over: Partial<Omit<BaseTransactionEvidence, 'evidenceHash'>> = {}): BaseTransactionEvidence {
  const body: Omit<BaseTransactionEvidence, 'evidenceHash'> = {
    schemaVersion: 'base-transaction-evidence/v1',
    chainId: 8453,
    transactionHash: TX,
    blockNumber: BLOCK,
    blockHash: `0x${'bb'.repeat(32)}`,
    blockTimestampMs: AFTER,
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
  return { ...body, evidenceHash: hashBaseTransactionEvidence(body) };
}

describe('chain profiles', () => {
  it('Base, Arbitrum One and OP Mainnet resolve; any other chain id is refused', () => {
    expect(chainRecordProfileFor(8453).chain).toBe('base');
    expect(chainRecordProfileFor(42161)).toBe(ARBITRUM_CHAIN_RECORD_PROFILE);
    expect(chainRecordProfileFor(10)).toBe(OPTIMISM_CHAIN_RECORD_PROFILE);
    expect(() => chainRecordProfileFor(1)).toThrow('chain_record_chain_unsupported:1');
  });
  it('USDC is an ordinary asset off Base and stays the USDC watchers\' lane on Base', () => {
    expect(ARBITRUM_CHAIN_RECORD_PROFILE.assets[ARB_USDC]).toBe('USDC');
    expect(ARBITRUM_CHAIN_RECORD_PROFILE.otherLaneToken).toBeNull();
    expect(chainRecordProfileFor(8453).otherLaneToken).toBe(BASE_USDC_ADDRESS);
    expect(chainRecordProfileFor(8453).assets[BASE_USDC_ADDRESS]).toBeUndefined();
  });
  it('the PE id and observation id are chain-scoped, and Base keeps its ids', () => {
    expect(chainRecordPeId(TX, 'send', 42161)).not.toBe(chainRecordPeId(TX, 'send', 10));
    expect(chainRecordPeId(TX, 'send')).toBe(chainRecordPeId(TX, 'send', 8453));
    expect(chainRecordObservationId(TX, 'w1', 42161)).not.toBe(chainRecordObservationId(TX, 'w1'));
  });
});

describe('deriveChainRecordAct on Arbitrum One and OP Mainnet', () => {
  it('a plain native ETH send on Arbitrum is a send to tx.to, keyed on the transaction', () => {
    const d = deriveChainRecordAct(evmEvidence(42161), WALLET);
    expect(d).toMatchObject({ status: 'act', act: { actionType: 'send', counterpartyAddress: STRANGER, canonicalEventId: TX, leg: 'native' } });
    expect(d.usdcWitnessPeIds).toEqual([]);
  });

  it('a USDC send on Arbitrum is this lane\'s send (no USDC watcher there), keyed chainId:tx:log', () => {
    const d = deriveChainRecordAct(evmEvidence(42161, {
      toAddress: ARB_USDC, valueWei: '0', inputEmpty: false,
      logs: [transferLog(ARB_USDC, WALLET, STRANGER, 5_000_000n, 3)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'act', act: { actionType: 'send', assetSymbol: 'USDC', canonicalEventId: `42161:${TX}:3` } });
  });

  it('RED: the same shape on a token the wallet does not hold is no act (Unknown = Block)', () => {
    const d = deriveChainRecordAct(evmEvidence(42161, {
      toAddress: JUNK, valueWei: '0', inputEmpty: false,
      logs: [transferLog(JUNK, WALLET, STRANGER, 5n, 3)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'no_act', reason: 'no_qualifying_leg' });
  });

  it('a receive of ARB on Arbitrum from someone else is a receive', () => {
    const d = deriveChainRecordAct(evmEvidence(42161, {
      fromAddress: STRANGER, toAddress: ARB_TOKEN, valueWei: '0', inputEmpty: false,
      logs: [transferLog(ARB_TOKEN, STRANGER, WALLET, 7n, 1)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'act', act: { actionType: 'receive', counterpartyAddress: STRANGER, assetSymbol: 'ARB' } });
  });

  it('RED: a receive from the zero address (a mint) is no act', () => {
    const d = deriveChainRecordAct(evmEvidence(42161, {
      fromAddress: STRANGER, toAddress: ARB_TOKEN, valueWei: '0', inputEmpty: false,
      logs: [transferLog(ARB_TOKEN, `0x${'0'.repeat(40)}`, WALLET, 7n, 1)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'no_act', reason: 'no_qualifying_receive' });
  });

  it('an OP → WETH exchange through 0x on Optimism is a swap keyed on the transaction', () => {
    const d = deriveChainRecordAct(evmEvidence(10, {
      toAddress: ZEROX, valueWei: '0', inputEmpty: false,
      logs: [transferLog(OP_OP, WALLET, ROUTER, 10n, 0), transferLog(OP_WETH, ROUTER, WALLET, 3n, 1)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'act', act: { actionType: 'swap', assetSymbol: 'OP', canonicalEventId: TX } });
  });

  it('RED: the same call to an unknown contract is not a swap (and not a send of the wrong leg)', () => {
    const d = deriveChainRecordAct(evmEvidence(10, {
      toAddress: JUNK, valueWei: '0', inputEmpty: false,
      logs: [transferLog(OP_OP, WALLET, ROUTER, 10n, 0), transferLog(OP_WETH, ROUTER, WALLET, 3n, 1)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'act', act: { actionType: 'send', counterpartyAddress: ROUTER } });
  });

  it('a call into Provian\'s escrow on Arbitrum is the institution\'s act, never this lane\'s', () => {
    const d = deriveChainRecordAct(evmEvidence(42161, {
      toAddress: '0x73934580ecfd8bf1f689f73205a2e681feaa54af', valueWei: '0', inputEmpty: false,
      logs: [transferLog(ARB_USDC, WALLET, '0x73934580ecfd8bf1f689f73205a2e681feaa54af', 5n, 0)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'no_act', reason: 'institution_transaction' });
  });
});

describe('cross-chain swaps through the LI.FI Diamond', () => {
  it('Base: the wallet\'s native leg into the Diamond, with the Diamond\'s transfer-started event, is a swap', () => {
    const d = deriveChainRecordAct(baseEvidence({ toAddress: LIFI_DIAMOND, valueWei: '5000', inputEmpty: false, logs: [bridgeStartedLog(0)] }), WALLET);
    expect(d).toMatchObject({ status: 'act', act: { actionType: 'swap', leg: 'native', counterpartyAddress: LIFI_DIAMOND } });
  });

  it('Arbitrum: a USDC leg into the Diamond with the event is a swap keyed on the transaction', () => {
    const d = deriveChainRecordAct(evmEvidence(42161, {
      toAddress: LIFI_DIAMOND, valueWei: '0', inputEmpty: false,
      logs: [transferLog(ARB_USDC, WALLET, LIFI_DIAMOND, 9n, 2), bridgeStartedLog(3)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'act', act: { actionType: 'swap', assetSymbol: 'USDC', canonicalEventId: TX } });
  });

  it('RED (review): a Diamond call with value but no transfer-started event and no exchange is no act', () => {
    const d = deriveChainRecordAct(evmEvidence(42161, { toAddress: LIFI_DIAMOND, valueWei: '1', inputEmpty: false }), WALLET);
    expect(d.status).toBe('no_act');
  });

  it('RED (review): USDC through the Diamond for a junk token is no act, as it is through a router', () => {
    const d = deriveChainRecordAct(evmEvidence(42161, {
      toAddress: LIFI_DIAMOND, valueWei: '0', inputEmpty: false,
      logs: [transferLog(ARB_USDC, WALLET, LIFI_DIAMOND, 9n, 2), transferLog(JUNK, ROUTER, WALLET, 9n, 3)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'no_act', reason: 'swap_without_exchange' });
  });

  it('RED: a transfer-started event from another contract is not the Diamond\'s record', () => {
    const d = deriveChainRecordAct(evmEvidence(42161, { toAddress: LIFI_DIAMOND, valueWei: '1', inputEmpty: false, logs: [bridgeStartedLog(0, JUNK)] }), WALLET);
    expect(d.status).toBe('no_act');
  });

  it('a same-chain exchange through the Diamond (USDC → ARB) is a swap by the ordinary rule', () => {
    const d = deriveChainRecordAct(evmEvidence(42161, {
      toAddress: LIFI_DIAMOND, valueWei: '0', inputEmpty: false,
      logs: [transferLog(ARB_USDC, WALLET, LIFI_DIAMOND, 9n, 2), transferLog(ARB_TOKEN, ROUTER, WALLET, 4n, 3)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'act', act: { actionType: 'swap', assetSymbol: 'USDC' } });
  });

  it('Base: a USDC bridge stays the USDC watchers\' lane here', () => {
    const d = deriveChainRecordAct(baseEvidence({
      toAddress: LIFI_DIAMOND, valueWei: '0', inputEmpty: false,
      logs: [transferLog(BASE_USDC_ADDRESS, WALLET, LIFI_DIAMOND, 9n, 2), bridgeStartedLog(3)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'no_act', reason: 'usdc_leg_is_usdc_watcher_lane' });
  });

  it('RED: a bridge transaction mined before the landing is not a swap (no repricing backward)', () => {
    const d = deriveChainRecordAct(baseEvidence({
      toAddress: LIFI_DIAMOND, valueWei: '5000', inputEmpty: false, blockTimestampMs: MULTICHAIN_COMMERCE_CUT_LINE_MS - 1, logs: [bridgeStartedLog(0)],
    }), WALLET);
    expect(d.status).toBe('no_act');
  });

  it('RED: a bridge with the event that moves no known asset is no act', () => {
    const d = deriveChainRecordAct(evmEvidence(42161, {
      toAddress: LIFI_DIAMOND, valueWei: '0', inputEmpty: false,
      logs: [transferLog(JUNK, WALLET, LIFI_DIAMOND, 9n, 2), bridgeStartedLog(3)],
    }), WALLET);
    expect(d).toMatchObject({ status: 'no_act', reason: 'bridge_without_known_leg' });
  });

  it('RED: a bridge transaction the wallet did not sign is never its swap', () => {
    const d = deriveChainRecordAct(evmEvidence(42161, { fromAddress: STRANGER, toAddress: LIFI_DIAMOND, valueWei: '5000', inputEmpty: false, logs: [bridgeStartedLog(0)] }), WALLET);
    expect(d.status).toBe('no_act');
  });
});

describe('the observation cycle on another chain', () => {
  let db: FakeFirestore;
  let verify: jest.Mock<(tx: string, chainId?: number) => Promise<ChainTransactionEvidence>>;
  let emit: jest.Mock<ChainRecordWatcherDeps['emitActPE']>;
  let fenceMs: jest.Mock<(block: number) => Promise<number>>;
  let now: number;
  const FENCE_BLOCK = 50_000_000;

  beforeEach(() => {
    db = createFakeFirestore();
    now = AFTER + 3_600_000;
    verify = jest.fn(async (_tx: string, chainId?: number) => evmEvidence((chainId ?? 42161) as 42161 | 10));
    emit = jest.fn(async (_w, act, ev) => ({ peId: chainRecordPeId(act.canonicalEventId, act.actionType, ev.chainId) }));
    fenceMs = jest.fn(async () => AFTER - 86_400_000);
    db.store.set('agent_wallets/w1', {
      id: 'w1', agent_id: 'agent1', address: WALLET, platform: 'claude',
      native_watcher_registration: createNativeWalletRegistrationFence(FENCE_BLOCK - 1),
    });
    db.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(WALLET)}`, {
      schema_version: 'native-wallet-address-index/v1', chain_id: 8453, address: WALLET,
      wallet_id: 'w1', owner_type: 'agent', owner_id: 'agent1', created_at_ms: 1,
    });
  });
  const deps = (): ChainRecordWatcherDeps => ({
    db: db as unknown as Firestore, verifyTransaction: verify, emitActPE: emit, now: () => now,
    readBaseBlockTimestampMs: fenceMs,
  });
  async function enqueue(chainId: number): Promise<string> {
    const e = chainRecordEnqueue(db as unknown as Firestore, { txHash: TX, walletId: 'w1', source: 'transfer_record', chainId });
    await db.runTransaction(async (txn) => { await e.read(txn as never); e.write(txn as never, 'pe_rec'); });
    const path = `${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(TX, 'w1', chainId)}`;
    db.store.set(path, { ...(db.store.get(path) as object), requested_at_ms: now, next_attempt_at_ms: now });
    return path;
  }

  it('GREEN: an Arbitrum send is verified on Arbitrum and emitted once', async () => {
    const path = await enqueue(42161);
    const r = await runChainRecordWatcherCycle(deps());
    expect(r.emitted).toBe(1);
    expect(verify).toHaveBeenCalledWith(TX, 42161);
    expect(fenceMs).toHaveBeenCalledWith(FENCE_BLOCK);
    expect(db.store.get(path)).toMatchObject({ status: 'complete', chain_id: 42161 });
  });

  it('RED: a transaction mined before the wallet\'s registration fence time is refused', async () => {
    fenceMs.mockResolvedValue(AFTER + 1);
    const path = await enqueue(42161);
    await runChainRecordWatcherCycle(deps());
    expect(db.store.get(path)).toMatchObject({ status: 'refused', outcome: { reason: 'before_wallet_fence' } });
    expect(emit).not.toHaveBeenCalled();
  });

  it('RED: a transaction mined before the multichain landing is refused', async () => {
    verify.mockResolvedValue(evmEvidence(42161, { blockTimestampMs: MULTICHAIN_COMMERCE_CUT_LINE_MS - 1 }));
    const path = await enqueue(42161);
    await runChainRecordWatcherCycle(deps());
    expect(db.store.get(path)).toMatchObject({ status: 'refused', outcome: { reason: 'before_landing' } });
  });

  it('RED: evidence for a different chain than the observation names is refused', async () => {
    verify.mockResolvedValue(evmEvidence(10));
    const path = await enqueue(42161);
    await runChainRecordWatcherCycle(deps());
    expect(db.store.get(path)).toMatchObject({ status: 'refused', outcome: { reason: 'evidence_chain_mismatch' } });
  });

  it('a fence-time read that fails waits; it never guesses', async () => {
    fenceMs.mockRejectedValue(new Error('economic_discovery_rpc_disagreement:block_timestamp'));
    const path = await enqueue(10);
    const r = await runChainRecordWatcherCycle(deps());
    expect(r.waiting).toBe(1);
    expect(db.store.get(path)).toMatchObject({ status: 'pending' });
  });

  it('RED (review): an address proven by a contract signature is refused off Base', async () => {
    const e = chainRecordEnqueue(db as unknown as Firestore, { txHash: TX, walletId: 'proven:x', source: 'multichain_scan', chainId: 42161 });
    await db.runTransaction(async (txn) => { await e.read(txn as never); e.write(txn as never, 'pe'); });
    const path = `${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(TX, 'proven:x', 42161)}`;
    db.store.set(path, { ...(db.store.get(path) as object), requested_at_ms: now, next_attempt_at_ms: now });
    const proven = (proofMethod: 'eip191_eoa' | 'eip1271_contract') => async () => ({
      walletId: 'w1', agentId: 'agent1', address: WALLET, eligibilityStartBlock: FENCE_BLOCK,
      ownerType: 'agent' as const, addressKind: 'proven' as const, proofMethod,
    });
    await runChainRecordWatcherCycle({ ...deps(), resolveWallet: proven('eip1271_contract') });
    expect(db.store.get(path)).toMatchObject({ status: 'refused', outcome: { reason: 'contract_proof_is_base_only' } });
    // GREEN pair: the same observation for an EOA-proven address emits.
    db.store.set(path, { ...(db.store.get(path) as object), status: 'pending', next_attempt_at_ms: now, outcome: null });
    const r = await runChainRecordWatcherCycle({ ...deps(), resolveWallet: proven('eip191_eoa') });
    expect(r.emitted).toBe(1);
  });

  it('RED: an observation naming an unsupported chain cannot be queued', () => {
    expect(() => {
      const e = chainRecordEnqueue(db as unknown as Firestore, { txHash: TX, walletId: 'w1', source: 'transfer_record', chainId: 1 });
      e.write({ set: () => undefined } as never, 'pe');
    }).not.toThrow(); // write is a no-op until the read ran
    return expect(db.runTransaction(async (txn) => {
      const e = chainRecordEnqueue(db as unknown as Firestore, { txHash: TX, walletId: 'w1', source: 'transfer_record', chainId: 1 });
      await e.read(txn as never);
      e.write(txn as never, 'pe');
    })).rejects.toThrow('chain_record_chain_unsupported:1');
  });
});
