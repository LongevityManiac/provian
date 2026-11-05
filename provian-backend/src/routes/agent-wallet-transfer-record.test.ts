/**
 * recordAgentTransferPE tests (slice 1b - verified raw transfer PE).
 *
 * Locks: ownership guard, ERC-20 amount verification (verifyTransfer), native
 * value+recipient verification (verifyEvmNativeTransfer - FIX B), tx_hash
 * idempotency (no double PE), and marker release on verification failure (so a
 * corrected retry works).
 */
import { recordAgentTransferPE } from './agent-wallet';
import type { RouterDeps, AgentWalletDocument } from '../core/agent-wallet/types';

const mockVerifyEvmNativeTransfer = jest.fn();
const mockVerifyTransfer = jest.fn();
const mockGeneratePE = jest.fn();

jest.mock('../core/onchain/tx-verifier', () => ({
  ...jest.requireActual('../core/onchain/tx-verifier'),
  verifyEvmNativeTransfer: (...args: unknown[]) => mockVerifyEvmNativeTransfer(...args),
  verifyTransfer: (...args: unknown[]) => mockVerifyTransfer(...args),
}));
jest.mock('../core/agent-bank/pe-utils', () => ({
  ...jest.requireActual('../core/agent-bank/pe-utils'),
  generatePE: (...args: unknown[]) => mockGeneratePE(...args),
}));

const WALLET_ADDR = '0x1111111111111111111111111111111111111111';
const RECIPIENT = '0x2222222222222222222222222222222222222222';

function wallet(overrides: Partial<AgentWalletDocument> = {}): AgentWalletDocument {
  return { id: 'wallet-1', agent_id: 'agent-1', address: WALLET_ADDR, ...overrides } as AgentWalletDocument;
}

/** Minimal in-memory Firestore marker mock (agent_tx_records). */
function makeDeps(opts: { updateFailures?: number } = {}): { deps: RouterDeps; store: Map<string, Record<string, unknown>> } {
  const store = new Map<string, Record<string, unknown>>();
  const refs = new Map<string, unknown>();
  let updateFailures = opts.updateFailures ?? 0;
  const makeRef = (id: string) => ({
    async create(data: Record<string, unknown>) {
      if (store.has(id)) {
        const e = new Error('ALREADY_EXISTS') as Error & { code?: number };
        e.code = 6;
        throw e;
      }
      store.set(id, data);
    },
    async get() {
      return { exists: store.has(id), data: () => store.get(id) };
    },
    async update(patch: Record<string, unknown>) {
      if (updateFailures > 0) {
        updateFailures -= 1;
        throw new Error('firestore transient update failure');
      }
      store.set(id, { ...(store.get(id) ?? {}), ...patch });
    },
    // Synchronous set (merge) — models the marker stamp that generatePEAtomic's
    // atomicEntityWrite performs inside the PE transaction (#21). Independent of
    // `updateFailures`, which only breaks the (now-removed) post-mint update().
    set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      store.set(id, opts?.merge ? { ...(store.get(id) ?? {}), ...data } : data);
    },
    async delete() {
      store.delete(id);
    },
  });
  const db = {
    collection: (_c: string) => ({
      doc: (id: string) => {
        if (!refs.has(id)) refs.set(id, makeRef(id));
        return refs.get(id);
      },
    }),
  };
  return { deps: { db } as unknown as RouterDeps, store };
}

const TX = '0x' + 'a'.repeat(64);

describe('recordAgentTransferPE (slice 1b)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyEvmNativeTransfer.mockResolvedValue({ ok: true, blockNumber: 1, confirmations: 3 });
    mockVerifyTransfer.mockResolvedValue({ ok: true, blockNumber: 1, confirmations: 3 });
    // generatePEAtomic is mocked, but it must still run the caller's
    // atomicEntityWrite co-write (the marker stamp, #21) so the fake marker is
    // stamped exactly as the real in-transaction write would. The fake txn.set
    // delegates to the target ref's synchronous set().
    mockGeneratePE.mockImplementation(
      async (
        _deps: unknown,
        params: { atomicEntityWrite?: (txn: unknown, peId: string) => void },
      ) => {
        if (typeof params.atomicEntityWrite === 'function') {
          const fakeTxn = {
            set: (
              ref: { set: (d: Record<string, unknown>, o?: { merge?: boolean }) => void },
              d: Record<string, unknown>,
              o?: { merge?: boolean },
            ) => ref.set(d, o),
          };
          params.atomicEntityWrite(fakeTxn, 'pe_xfer');
        }
        return { peId: 'pe_xfer', peHash: 'h', prevHash: 'p' };
      },
    );
  });

  it('rejects a wallet_id mismatch (403) and writes nothing', async () => {
    const { deps, store } = makeDeps();
    const res = await recordAgentTransferPE(deps, {
      walletId: 'someone-else',
      agentWallet: wallet(),
      txHash: TX,
      chain: 'base',
      currency: 'usdc',
      to: RECIPIENT,
      amountAtomic: '1000000',
    });
    expect(res).toMatchObject({ ok: false, status: 403 });
    expect(mockGeneratePE).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it('verifies ERC-20 from+to+amount and records a verified agent_token_transfer PE', async () => {
    const { deps } = makeDeps();
    const res = await recordAgentTransferPE(deps, {
      walletId: 'wallet-1',
      agentWallet: wallet(),
      txHash: TX,
      chain: 'base',
      currency: 'usdc',
      to: RECIPIENT,
      amountAtomic: '1000000', // 1 USDC
    });
    expect(res).toEqual({ ok: true, peId: 'pe_xfer', verified: true });
    expect(mockVerifyTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: 'base',
        txHash: TX,
        expectedFrom: WALLET_ADDR,
        expectedTo: RECIPIENT,
        currency: 'usdc',
        expectedAmountUsdc: 1,
      }),
    );
    const [, peParams] = mockGeneratePE.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(peParams).toMatchObject({ actionType: 'agent_token_transfer' });
    expect(peParams.metadata).toMatchObject({
      currency: 'usdc',
      verified: true,
      value_verified: true,
      recipient_verified: true,
      tx_hash: TX,
    });
  });

  it('routes pvt to expectedAmountPvtWei (atomic bigint)', async () => {
    const { deps } = makeDeps();
    await recordAgentTransferPE(deps, {
      walletId: 'wallet-1', agentWallet: wallet(), txHash: TX, chain: 'base',
      currency: 'pvt', to: RECIPIENT, amountAtomic: '5000000000000000000',
    });
    expect(mockVerifyTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'pvt', expectedAmountPvtWei: 5_000_000_000_000_000_000n }),
    );
  });

  it('native: verifies value+recipient (FIX B) and records a fully-verified PE', async () => {
    const { deps } = makeDeps();
    const res = await recordAgentTransferPE(deps, {
      walletId: 'wallet-1', agentWallet: wallet(), txHash: TX, chain: 'base',
      currency: 'native', to: RECIPIENT, amountAtomic: '10000000000000000',
    });
    expect(res).toEqual({ ok: true, peId: 'pe_xfer', verified: true });
    expect(mockVerifyEvmNativeTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: 8453, txHash: TX, expectedFrom: WALLET_ADDR, expectedTo: RECIPIENT,
        expectedAmountWei: 10_000_000_000_000_000n,
      }),
    );
    expect(mockVerifyTransfer).not.toHaveBeenCalled();
    const [, peParams] = mockGeneratePE.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(peParams).toMatchObject({ actionType: 'agent_native_transfer' });
    expect(peParams.metadata).toMatchObject({ verified: true, value_verified: true, recipient_verified: true, sender_verified: true });
  });

  it('native: a value/recipient mismatch fails closed (400) and releases the marker', async () => {
    const { deps, store } = makeDeps();
    mockVerifyEvmNativeTransfer.mockResolvedValueOnce({ ok: false, reason: 'native_value_mismatch' });
    const res = await recordAgentTransferPE(deps, {
      walletId: 'wallet-1', agentWallet: wallet(), txHash: TX, chain: 'base',
      currency: 'native', to: RECIPIENT, amountAtomic: '10000000000000000',
    });
    expect(res).toMatchObject({ ok: false, status: 400, reason: 'native_value_mismatch' });
    expect(mockGeneratePE).not.toHaveBeenCalled();
    expect(store.size).toBe(0); // marker released
  });

  it('is idempotent by tx_hash: a repeat call returns the original pe_id, no second PE', async () => {
    const { deps } = makeDeps();
    const base = { walletId: 'wallet-1', agentWallet: wallet(), txHash: TX, chain: 'base', currency: 'usdc' as const, to: RECIPIENT, amountAtomic: '1000000' };
    const first = await recordAgentTransferPE(deps, base);
    const second = await recordAgentTransferPE(deps, base);
    expect(first).toEqual({ ok: true, peId: 'pe_xfer', verified: true });
    expect(second).toEqual({ ok: true, peId: 'pe_xfer', verified: true, idempotent: true });
    expect(mockGeneratePE).toHaveBeenCalledTimes(1); // not twice
  });

  it('releases the marker on verification failure so a corrected retry can proceed', async () => {
    const { deps, store } = makeDeps();
    mockVerifyTransfer.mockResolvedValueOnce({ ok: false, reason: 'no_matching_transfer_log' });
    const fail = await recordAgentTransferPE(deps, {
      walletId: 'wallet-1', agentWallet: wallet(), txHash: TX, chain: 'base', currency: 'usdc', to: RECIPIENT, amountAtomic: '1000000',
    });
    expect(fail).toMatchObject({ ok: false, status: 400, reason: 'no_matching_transfer_log' });
    expect(store.size).toBe(0); // marker released
    // retry now succeeds and mints exactly one PE
    const ok = await recordAgentTransferPE(deps, {
      walletId: 'wallet-1', agentWallet: wallet(), txHash: TX, chain: 'base', currency: 'usdc', to: RECIPIENT, amountAtomic: '1000000',
    });
    expect(ok).toMatchObject({ ok: true, verified: true });
    expect(mockGeneratePE).toHaveBeenCalledTimes(1);
  });

  it('#21: stamps the marker atomically with the PE, so a retry is idempotent even when Firestore update() is unavailable', async () => {
    // OLD design: pe_id was written via a SEPARATE post-mint markerRef.update().
    // Two transient update failures (the in-try update AND the best-effort catch
    // re-stamp) left the marker stuck 'pending' with no pe_id, so a retry got a
    // PERMANENT 409 despite the PE existing. The fix stamps the marker INSIDE the
    // PE transaction (atomicEntityWrite → set), so a broken update() cannot strand
    // the pe_id. updateFailures:99 would have poisoned the old path forever.
    const { deps, store } = makeDeps({ updateFailures: 99 });
    const base = { walletId: 'wallet-1', agentWallet: wallet(), txHash: TX, chain: 'base', currency: 'usdc' as const, to: RECIPIENT, amountAtomic: '1000000' };
    const first = await recordAgentTransferPE(deps, base);
    expect(first).toEqual({ ok: true, peId: 'pe_xfer', verified: true });
    // The single stored doc is the marker; it carries the stamped pe_id/status.
    const marker = [...store.values()][0];
    expect(marker).toMatchObject({ status: 'recorded', pe_id: 'pe_xfer', verified: true });
    // A retry recovers the pe_id idempotently (no permanent 409, no second mint).
    const second = await recordAgentTransferPE(deps, base);
    expect(second).toMatchObject({ ok: true, peId: 'pe_xfer', idempotent: true });
    expect(mockGeneratePE).toHaveBeenCalledTimes(1);
  });

  it('#21: releases the marker when generatePEAtomic throws (pre-commit), so a corrected retry can proceed', async () => {
    const { deps, store } = makeDeps();
    mockGeneratePE.mockRejectedValueOnce(new Error('chain-tip contention'));
    const base = { walletId: 'wallet-1', agentWallet: wallet(), txHash: TX, chain: 'base', currency: 'usdc' as const, to: RECIPIENT, amountAtomic: '1000000' };
    await expect(recordAgentTransferPE(deps, base)).rejects.toThrow('chain-tip contention');
    expect(store.size).toBe(0); // marker released — no stuck 'pending'
    // Retry now records exactly one PE.
    const ok = await recordAgentTransferPE(deps, base);
    expect(ok).toMatchObject({ ok: true, peId: 'pe_xfer', verified: true });
    expect(mockGeneratePE).toHaveBeenCalledTimes(2);
  });

  it('#21: does NOT release the marker when the PE txn committed but a POST-commit step throws (returns the durable pe_id, no re-mint)', async () => {
    // The atomic marker stamp commits inside the PE transaction; THEN a
    // post-commit step (e.g. peBuffer.enqueue during shutdown) throws. Deleting
    // the marker here would let a retry mint a SECOND PE — so the catch must
    // re-read, see the committed pe_id, and return it idempotently.
    const { deps, store } = makeDeps();
    mockGeneratePE.mockImplementationOnce(
      async (
        _deps: unknown,
        params: { atomicEntityWrite?: (txn: unknown, peId: string) => void },
      ) => {
        if (typeof params.atomicEntityWrite === 'function') {
          const fakeTxn = {
            set: (
              ref: { set: (d: Record<string, unknown>, o?: { merge?: boolean }) => void },
              d: Record<string, unknown>,
              o?: { merge?: boolean },
            ) => ref.set(d, o),
          };
          params.atomicEntityWrite(fakeTxn, 'pe_xfer'); // stamp commits...
        }
        throw new Error('post-commit enqueue failure (draining)'); // ...then a post-commit throw
      },
    );
    const base = { walletId: 'wallet-1', agentWallet: wallet(), txHash: TX, chain: 'base', currency: 'usdc' as const, to: RECIPIENT, amountAtomic: '1000000' };
    const res = await recordAgentTransferPE(deps, base);
    expect(res).toMatchObject({ ok: true, peId: 'pe_xfer' });
    expect(store.size).toBe(1); // marker survived (not deleted)
    expect([...store.values()][0]).toMatchObject({ status: 'recorded', pe_id: 'pe_xfer' });
  });

  it('rejects an unknown chain (400)', async () => {
    const { deps } = makeDeps();
    const res = await recordAgentTransferPE(deps, {
      walletId: 'wallet-1', agentWallet: wallet(), txHash: TX, chain: 'solana', currency: 'usdc', to: RECIPIENT, amountAtomic: '1000000',
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });
});

// the record PE itself stays record_only (no awaitAccrual / durable
// intake: first-party-financial-self-report-record-only.test.ts), and a Base
// record queues its tx for the chain-record lane INSIDE the PE transaction.
describe('recordAgentTransferPE → chain-record lane ', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyEvmNativeTransfer.mockResolvedValue({ ok: true, blockNumber: 1, confirmations: 3 });
  });
  /** Run the caller's precondition + co-write the way the real tip transaction does. */
  function runTransactionally(existing: boolean) {
    mockGeneratePE.mockImplementationOnce(async (_deps: unknown, params: {
      atomicEntityPrecondition?: (txn: unknown, ctx: unknown) => Promise<void>;
      atomicEntityWrite?: (txn: unknown, peId: string) => void;
    }) => {
      const txn = {
        get: async () => ({ exists: existing }),
        set: (ref: { set: (d: Record<string, unknown>, o?: { merge?: boolean }) => void },
          d: Record<string, unknown>, o?: { merge?: boolean }) => ref.set(d, o),
      };
      await params.atomicEntityPrecondition?.(txn, { prevHash: 'p' });
      params.atomicEntityWrite?.(txn, 'pe_xfer');
      return { peId: 'pe_xfer', peHash: 'h', prevHash: 'p' };
    });
  }
  const obsId = (chainId = 8453) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { chainRecordObservationId } = require('../core/pvt/chain-record-watcher');
    return chainRecordObservationId(TX, 'wallet-1', chainId) as string;
  };

  it('a Base transfer queues its tx (pending, pointing at the record PE)', async () => {
    const { deps, store } = makeDeps();
    runTransactionally(false);
    await recordAgentTransferPE(deps, {
      walletId: 'wallet-1', agentWallet: wallet(), txHash: TX, chain: 'base',
      currency: 'native', to: RECIPIENT, amountAtomic: '1',
    });
    const [, peParams] = mockGeneratePE.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(peParams.awaitAccrual).toBeUndefined();
    expect(peParams.durableViaOrdinaryIntake).toBeUndefined();
    expect(store.get(obsId())).toMatchObject({
      status: 'pending', tx_hash: TX, wallet_id: 'wallet-1', source: 'transfer_record', record_pe_id: 'pe_xfer',
    });
  });

  it('an Arbitrum transfer queues an Arbitrum-scoped observation, never a Base one', async () => {
    const { deps, store } = makeDeps();
    runTransactionally(false);
    await recordAgentTransferPE(deps, {
      walletId: 'wallet-1', agentWallet: wallet(), txHash: TX, chain: 'arbitrum',
      currency: 'native', to: RECIPIENT, amountAtomic: '1',
    });
    expect(store.get(obsId(42161))).toMatchObject({ status: 'pending', chain_id: 42161, source: 'transfer_record' });
    expect(store.has(obsId())).toBe(false);
  });

  it('RED: an observation that already exists is never overwritten', async () => {
    const { deps, store } = makeDeps();
    runTransactionally(true);
    await recordAgentTransferPE(deps, {
      walletId: 'wallet-1', agentWallet: wallet(), txHash: TX, chain: 'base',
      currency: 'native', to: RECIPIENT, amountAtomic: '1',
    });
    expect(store.has(obsId())).toBe(false);
  });
});
