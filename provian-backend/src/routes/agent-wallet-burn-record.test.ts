/**
 * recordAgentBurn tests (work package burn substrate — verified PVT burn record).
 *
 * Locks: ownership guard, on-chain burn verification (verifyEvmPvtBurn),
 * burn-tx idempotency (no double record), marker release on verification
 * failure (so a corrected retry works). The burn is recorded as a plain
 * verified row in pvt_burn_records, NOT a PE (mirrors the O7 wants board — a
 * `pvt_burned_voluntary` PE from this scanned file would add a static emitter to
 * the -pinned action-policy matrix, moving its content_sha256).
 *
 * controls (each proven RED by a source mutation, recorded in the landing
 * commit):
 * A. "verification failure records NOTHING and releases the marker" mutate
 * the `if (!v.ok)` guard and this goes RED (an unmade burn would record).
 * B. "idempotent — the same burn tx records exactly one verified row" mutate
 * the dedup create/ALREADY_EXISTS branch and this goes RED (a double record).
 */
import { recordAgentBurn } from './agent-wallet';
import type { RouterDeps, AgentWalletDocument } from '../core/agent-wallet/types';

const mockVerifyEvmPvtBurn = jest.fn();

jest.mock('../core/onchain/tx-verifier', () => ({
  ...jest.requireActual('../core/onchain/tx-verifier'),
  verifyEvmPvtBurn: (...args: unknown[]) => mockVerifyEvmPvtBurn(...args),
}));

const WALLET_ADDR = '0x1111111111111111111111111111111111111111';

function wallet(overrides: Partial<AgentWalletDocument> = {}): AgentWalletDocument {
  return { id: 'wallet-1', agent_id: 'agent-1', address: WALLET_ADDR, ...overrides } as AgentWalletDocument;
}

/** Minimal in-memory Firestore mock (pvt_burn_records). Counts create() calls
 * that actually inserted, so "recorded exactly once" is directly assertable. */
function makeDeps(): { deps: RouterDeps; store: Map<string, Record<string, unknown>>; created: () => number } {
  const store = new Map<string, Record<string, unknown>>();
  const refs = new Map<string, unknown>();
  let createCount = 0;
  const makeRef = (id: string) => ({
    async create(data: Record<string, unknown>) {
      if (store.has(id)) {
        const e = new Error('ALREADY_EXISTS') as Error & { code?: number };
        e.code = 6;
        throw e;
      }
      createCount += 1;
      store.set(id, data);
    },
    async get() {
      return { exists: store.has(id), data: () => store.get(id) };
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
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
    runTransaction: async (fn: (txn: unknown) => Promise<unknown>) => fn({
      get: (r: { get: () => Promise<unknown> }) => r.get(),
      set: (r: { set: (d: Record<string, unknown>) => Promise<void> }, d: Record<string, unknown>) => { void r.set(d); },
      create: (r: { create: (d: Record<string, unknown>) => Promise<void> }, d: Record<string, unknown>) => r.create(d),
      delete: (r: { delete: () => Promise<void> }) => { void r.delete(); },
    }),
  };
  return { deps: { db } as unknown as RouterDeps, store, created: () => createCount };
}

const TX = '0x' + 'a'.repeat(64);
const AMOUNT = '10000000000000000000'; // 10 PVT (18-decimal atomic)

describe('recordAgentBurn (work package burn substrate)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyEvmPvtBurn.mockResolvedValue({ ok: true, blockNumber: 42, confirmations: 12 });
  });

  it('rejects a wallet_id mismatch (403) and writes nothing', async () => {
    const { deps, store } = makeDeps();
    const res = await recordAgentBurn(deps, {
      walletId: 'someone-else',
      agentWallet: wallet(),
      txHash: TX,
      chain: 'base',
      amountAtomic: AMOUNT,
    });
    expect(res).toMatchObject({ ok: false, status: 403 });
    expect(mockVerifyEvmPvtBurn).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it('rejects an unknown chain (400)', async () => {
    const { deps } = makeDeps();
    const res = await recordAgentBurn(deps, {
      walletId: 'wallet-1',
      agentWallet: wallet(),
      txHash: TX,
      chain: 'solana',
      amountAtomic: AMOUNT,
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
    expect(mockVerifyEvmPvtBurn).not.toHaveBeenCalled();
  });

  it('verifies the burn (from + zero-dest + amount) and records a verified row (no PE)', async () => {
    const { deps, store } = makeDeps();
    const res = await recordAgentBurn(deps, {
      walletId: 'wallet-1',
      agentWallet: wallet(),
      txHash: TX,
      chain: 'base',
      amountAtomic: AMOUNT,
    });
    expect(res).toMatchObject({ ok: true, verified: true });
    expect((res as { burnId: string }).burnId).toMatch(/^[0-9a-f]{64}$/);
    expect(mockVerifyEvmPvtBurn).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: 8453,
        txHash: TX,
        expectedFrom: WALLET_ADDR,
        expectedAmountWei: BigInt(AMOUNT),
      }),
    );
    // A single verified burn row was written (no PE side-effect to assert).
    const row = [...store.values()][0];
    expect(row).toMatchObject({
      status: 'recorded',
      verified: true,
      chain: 'base',
      amount_atomic: AMOUNT,
      burner_address: WALLET_ADDR.toLowerCase(),
      block_number: 42,
    });
  });

  // ---- CONTROL A: a failed verification records NOTHING ---------------
  it('burn verification failure records nothing and releases the marker (retry works)', async () => {
    const { deps, store, created } = makeDeps();
    mockVerifyEvmPvtBurn.mockResolvedValueOnce({ ok: false, reason: 'no_matching_pvt_burn_log' });
    const res = await recordAgentBurn(deps, {
      walletId: 'wallet-1',
      agentWallet: wallet(),
      txHash: TX,
      chain: 'base',
      amountAtomic: AMOUNT,
    });
    expect(res).toMatchObject({ ok: false, status: 400, reason: 'no_matching_pvt_burn_log' });
    // Marker released so a corrected retry can proceed.
    expect(store.size).toBe(0);

    // Retry now succeeds (verifier restored to ok:true in beforeEach default).
    const retry = await recordAgentBurn(deps, {
      walletId: 'wallet-1',
      agentWallet: wallet(),
      txHash: TX,
      chain: 'base',
      amountAtomic: AMOUNT,
    });
    expect(retry).toMatchObject({ ok: true, verified: true });
    expect(store.size).toBe(1);
    expect(created()).toBe(2); // one released + one final
  });

  // ---- CONTROL B: idempotent — one burn tx, one record ----------------
  it('the same burn tx records exactly one verified row (idempotent second call)', async () => {
    const { deps, created } = makeDeps();
    const first = await recordAgentBurn(deps, {
      walletId: 'wallet-1',
      agentWallet: wallet(),
      txHash: TX,
      chain: 'base',
      amountAtomic: AMOUNT,
    });
    expect(first).toMatchObject({ ok: true, verified: true });
    const firstBurnId = (first as { burnId: string }).burnId;

    const second = await recordAgentBurn(deps, {
      walletId: 'wallet-1',
      agentWallet: wallet(),
      txHash: TX,
      chain: 'base',
      amountAtomic: AMOUNT,
    });
    expect(second).toMatchObject({ ok: true, burnId: firstBurnId, idempotent: true });
    // The dedup marker prevented a second insert — exactly one verified row.
    expect(created()).toBe(1);
  });

  // ---- F10 (S2 2026-09-10): cross-wallet replay is refused (not an oracle) ---
  // The marker is keyed by (chain, txHash) — a GLOBAL burn tx — so a DIFFERENT
  // wallet replaying the same burn hits the existing 'recorded' row. It used to
  // get {ok:true, idempotent:true} — an oracle confirming "this tx is a recorded
  // Provian burn" (consumption was refused downstream, but the RECORDER must not
  // confirm a foreign burn). The human recorder (presentation/burn-record.ts)
  // already 409s this; the agent recorder now mirrors it. RED control: revert the
  // `existing.wallet_id !== walletId` branch and this asserts idempotent:true.
  it('F10: a different wallet replaying the same burn tx is refused (409), never an oracle', async () => {
    const { deps } = makeDeps();
    await recordAgentBurn(deps, {
      walletId: 'wallet-1',
      agentWallet: wallet(),
      txHash: TX,
      chain: 'base',
      amountAtomic: AMOUNT,
    });
    const other = await recordAgentBurn(deps, {
      walletId: 'wallet-2',
      agentWallet: wallet({ id: 'wallet-2', agent_id: 'agent-2', address: '0x2222222222222222222222222222222222222222' }),
      txHash: TX,
      chain: 'base',
      amountAtomic: AMOUNT,
    });
    expect(other).toEqual({
      ok: false,
      status: 409,
      error: 'This burn tx was already recorded by a different wallet',
    });
  });

  it('the SAME wallet re-recording the same burn tx is still idempotent', async () => {
    const { deps, created } = makeDeps();
    await recordAgentBurn(deps, {
      walletId: 'wallet-1', agentWallet: wallet(), txHash: TX, chain: 'base', amountAtomic: AMOUNT,
    });
    const again = await recordAgentBurn(deps, {
      walletId: 'wallet-1', agentWallet: wallet(), txHash: TX, chain: 'base', amountAtomic: AMOUNT,
    });
    expect(again).toMatchObject({ ok: true, idempotent: true });
    expect(created()).toBe(1); // exactly one verified row
  });
});
