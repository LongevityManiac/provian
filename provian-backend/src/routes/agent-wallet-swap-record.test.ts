/**
 * recordAgentSwapPE tests (Fix F1 + F37 idempotency).
 *
 * The POST /:wallet_id/swap/record handler previously (a) had NO ownership
 * check (it re-fetched the wallet by path param, so a forged swap PE could be
 * attributed to ANY wallet_id), (b) accepted `tx_to_mismatch` from
 * verifyEvmContractCall - which discards the sender check because `to` is
 * evaluated before `from` - and (c) wrote the PE directly to pe_history,
 * bypassing the atomic hash-chain helper. Fix F1 closed (a)-(c).
 *
 * F37 (S2 2026-09-10): swap/record also had NO tx_hash idempotency, unlike its
 * transfer/record and burn/record siblings — so ONE real base tx could be
 * replayed into thousands of agent_token_swap PEs, each a fresh pe_id that
 * increments pe_count (inflating the bond trust discount, governance score and
 * leaderboard rank). These tests lock the fixed behaviour, including the RED
 * replay control (same tx_hash twice → one PE, one pe_id).
 */

import { recordAgentSwapPE } from './agent-wallet';
import type { RouterDeps, AgentWalletDocument } from '../core/agent-wallet/types';

const mockVerifyEvmTxFrom = jest.fn();
const mockGeneratePE = jest.fn();

jest.mock('../core/onchain/tx-verifier', () => ({
  ...jest.requireActual('../core/onchain/tx-verifier'),
  verifyEvmTxFrom: (...args: unknown[]) => mockVerifyEvmTxFrom(...args),
}));
jest.mock('../core/agent-bank/pe-utils', () => ({
  ...jest.requireActual('../core/agent-bank/pe-utils'),
  generatePE: (...args: unknown[]) => mockGeneratePE(...args),
}));

const WALLET_ADDR = '0x1111111111111111111111111111111111111111';

function wallet(overrides: Partial<AgentWalletDocument> = {}): AgentWalletDocument {
  return {
    id: 'wallet-1',
    agent_id: 'agent-1',
    address: WALLET_ADDR,
    ...overrides,
  } as AgentWalletDocument;
}

const baseParams = {
  walletId: 'wallet-1',
  txHash: '0x' + 'a'.repeat(64),
  fromToken: 'usdc',
  toToken: 'weth',
  fromAmount: '100',
  toAmount: '0.03',
  feeAmount: '0.1',
};

/**
 * In-memory `swap_record_claims` store so the F37 idempotency marker
 * (.create → ALREADY_EXISTS on replay → .get) is exercised end to end. A
 * duplicate .create throws Firestore's ALREADY_EXISTS (code 6). The mock
 * generatePE below runs the atomicEntityWrite callback so the pe_id is stamped
 * onto the marker inside the (simulated) PE transaction, exactly as production.
 */
function makeDeps(): { deps: RouterDeps; store: Map<string, Record<string, unknown>> } {
  const store = new Map<string, Record<string, unknown>>();
  const docRef = (id: string) => ({
    async create(data: Record<string, unknown>) {
      if (store.has(id)) {
        throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
      }
      store.set(id, { ...data });
    },
    async get() {
      return { exists: store.has(id), data: () => store.get(id) };
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      store.set(id, opts?.merge ? { ...(store.get(id) ?? {}), ...data } : { ...data });
    },
    async delete() {
      store.delete(id);
    },
  });
  const db = {
    collection: (name: string) => {
      if (name !== 'swap_record_claims' && name !== 'chain_record_observations') {
        throw new Error(`Unexpected collection: ${name}`);
      }
      return { doc: (id: string) => docRef(id) };
    },
  };
  return { deps: { db } as unknown as RouterDeps, store };
}

describe('recordAgentSwapPE (Fix F1 + F37)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyEvmTxFrom.mockResolvedValue({ ok: true, blockNumber: 1, confirmations: 5 });
    // Simulate the atomic PE helper: run the caller's atomicEntityWrite so the
    // marker gets its pe_id stamped inside the (mocked) PE transaction.
    mockGeneratePE.mockImplementation(async (_deps: unknown, params: Record<string, unknown>) => {
      const peId = 'pe_123';
      const write = params.atomicEntityWrite as
        | ((txn: { set: (ref: { set: (d: unknown, o?: unknown) => void }, d: unknown, o?: unknown) => void }, peId: string) => void)
        | undefined;
      if (write) {
        const txn = { set: (ref: { set: (d: unknown, o?: unknown) => void }, d: unknown, o?: unknown) => ref.set(d, o) };
        write(txn, peId);
      }
      return { peId, peHash: 'h', prevHash: 'p' };
    });
  });

  it('rejects a wallet_id that does not match the authenticated wallet (403) and writes no PE', async () => {
    const { deps } = makeDeps();
    const result = await recordAgentSwapPE(deps, {
      ...baseParams,
      walletId: 'someone-elses-wallet',
      agentWallet: wallet(),
    });
    expect(result).toEqual({ ok: false, status: 403, error: 'Access denied - wallet_id mismatch' });
    expect(mockVerifyEvmTxFrom).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('rejects when there is no authenticated wallet (403)', async () => {
    const { deps } = makeDeps();
    const result = await recordAgentSwapPE(deps, { ...baseParams, agentWallet: undefined });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 403 });
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('verifies the tx sender against the wallet address', async () => {
    const { deps } = makeDeps();
    await recordAgentSwapPE(deps, { ...baseParams, agentWallet: wallet() });
    expect(mockVerifyEvmTxFrom).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 8453, txHash: baseParams.txHash, expectedFrom: WALLET_ADDR }),
    );
  });

  it('rejects when the tx was NOT sent from the wallet (400), writes no PE, and releases the marker', async () => {
    mockVerifyEvmTxFrom.mockResolvedValue({ ok: false, reason: 'tx_from_mismatch' });
    const { deps, store } = makeDeps();
    const result = await recordAgentSwapPE(deps, { ...baseParams, agentWallet: wallet() });
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'On-chain swap verification failed',
      reason: 'tx_from_mismatch',
    });
    expect(mockGeneratePE).not.toHaveBeenCalled();
    // Marker released so a corrected retry can proceed.
    expect(store.size).toBe(0);
  });

  it('records the swap via the atomic PE helper on the happy path', async () => {
    const { deps } = makeDeps();
    const result = await recordAgentSwapPE(deps, { ...baseParams, agentWallet: wallet() });
    expect(result).toEqual({ ok: true, peId: 'pe_123' });
    expect(mockGeneratePE).toHaveBeenCalledTimes(1);

    const [, peParams] = mockGeneratePE.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(peParams).toMatchObject({
      walletId: 'wallet-1',
      agentId: 'agent-1',
      actorAddress: WALLET_ADDR,
      actionType: 'agent_token_swap',
    });
    expect(peParams.metadata).toMatchObject({
      from_token: 'USDC', // upper-cased
      to_token: 'WETH',
      from_amount: '100',
      to_amount: '0.03',
      fee_amount: '0.1',
      tx_hash: baseParams.txHash,
      chain: 'base',
      amounts_verified: false, // caller-asserted amounts are flagged unverified
    });
  });

  // RED control (F37): replaying the SAME tx_hash must yield ONE PE and return
  // the original pe_id idempotently — never a second agent_token_swap PE.
  it('is idempotent on tx_hash replay: same tx twice → one PE, original pe_id returned', async () => {
    const { deps } = makeDeps();
    const first = await recordAgentSwapPE(deps, { ...baseParams, agentWallet: wallet() });
    const second = await recordAgentSwapPE(deps, { ...baseParams, agentWallet: wallet() });

    expect(first).toEqual({ ok: true, peId: 'pe_123' });
    expect(second).toEqual({ ok: true, peId: 'pe_123', idempotent: true });
    // The whole point: exactly ONE PE was sealed across two calls.
    expect(mockGeneratePE).toHaveBeenCalledTimes(1);
  });
});

// the swap record PE stays record_only; the tx is queued for the
// chain-record lane INSIDE the PE transaction, which re-reads it from the chain.
describe('recordAgentSwapPE → chain-record lane ', () => {
  it('queues the tx (pending) through the PE transaction\'s precondition + co-write', async () => {
    const { deps, store } = makeDeps();
    mockGeneratePE.mockImplementationOnce(async (_deps: unknown, params: Record<string, unknown>) => {
      const txn = {
        get: async () => ({ exists: false }),
        set: (ref: { set: (d: unknown, o?: unknown) => void }, d: unknown, o?: unknown) => ref.set(d, o),
      };
      await (params.atomicEntityPrecondition as (t: unknown, c: unknown) => Promise<void>)(txn, { prevHash: 'p' });
      (params.atomicEntityWrite as (t: unknown, id: string) => void)(txn, 'pe_123');
      expect(params.awaitAccrual).toBeUndefined();
      return { peId: 'pe_123', peHash: 'h', prevHash: 'p' };
    });
    await recordAgentSwapPE(deps, { ...baseParams, agentWallet: wallet() });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { chainRecordObservationId } = require('../core/pvt/chain-record-watcher');
    expect(store.get(chainRecordObservationId(baseParams.txHash, 'wallet-1'))).toMatchObject({
      status: 'pending', source: 'swap_record', record_pe_id: 'pe_123',
    });
  });
});
