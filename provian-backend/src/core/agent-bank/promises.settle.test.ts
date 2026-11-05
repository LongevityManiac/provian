/**
 * settlePromise - corroboration emits with a REAL target hash (Pass-2 #5).
 *
 * The HIGH finding's third primary economic flow. escrow (escrow.completeJob.test.ts)
 * and jobs (jobs.deliver.test.ts) both had dedicated emit-site coverage; settlePromise
 * did not, so a promise-specific wiring regression (wrong target source, or a
 * re-introduced hardcoded empty hash) could slip through uncaught. This mirrors the
 * escrow sibling: assert the emit site resolves the promise_created PE hash and
 * forwards it (never ''), attributes the signal to the 'system' attestor (NOT the
 * settling borrower, which would be self-corroboration), and skips ONLY a
 * genuinely-unresolvable target — never suppresses a valid signal (Invariant #8).
 */

import { settlePromise } from './promises';
import { emitBackendCorroboration, resolveTargetPeHash } from '../corroboration/CorroborationManager';
import type { AgentBankDeps, PromiseDocument } from './types';
import { ValidationError } from './errors';

const mockEmitCorroboration = emitBackendCorroboration as jest.Mock;
const mockResolveTargetPeHash = resolveTargetPeHash as jest.Mock;

/** Flush the fire-and-forget corroboration IIFE scheduled by settlePromise. */
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const mockGeneratePE = jest.fn().mockResolvedValue({
  peId: 'pe_mock',
  peHash: 'hash_mock',
  prevHash: 'prev_mock',
});

jest.mock('./pe-utils', () => ({
  generatePE: (...args: unknown[]) => mockGeneratePE(...args),
  generateSchedulerPE: (...args: unknown[]) => mockGeneratePE(...args),
}));

const mockUpdateWalletStats = jest.fn().mockResolvedValue(undefined);

jest.mock('./wallet-stats', () => ({
  updateWalletStats: (...args: unknown[]) => mockUpdateWalletStats(...args),
}));

// settlePromise verifies the borrower's on-chain repayment before flipping status.
// Make it pass so execution reaches the corroboration emit. raised that bar
// from a bare ERC-20 Transfer to the contract's own PromiseSettled event, so the
// stub returns the canonical log identity the real verifier now returns; the
// verifier's own refusal arms are covered in `tx-verifier.promise.test.ts`.
jest.mock('../onchain/tx-verifier', () => ({
  ...jest.requireActual('../onchain/tx-verifier'),
  verifyEvmPromiseSettlement: jest.fn().mockResolvedValue({
    ok: true,
    blockNumber: 123,
    logIndex: 4,
    onchainPromiseId: `0x${'ab'.repeat(32)}`,
  }),
}));

// resolvePromiseContractAddress() resolves a contract address from chain config /
// env; in a unit test that env isn't set, so override the address source (keep
// assertSupportedAgentBankChain real so 'base' still validates) and let the real
// requireAddressOrThrow pass the address through.
jest.mock('./chain-registry', () => ({
  ...jest.requireActual('./chain-registry'),
  promiseUsdcAddressForChain: () => '0x1111111111111111111111111111111111111111',
}));

jest.mock('../corroboration/CorroborationManager', () => ({
  emitBackendCorroboration: jest.fn(),
  // Pass-2 #5: settlePromise now resolves the REAL target PE hash before
  // emitting. Return a non-empty hash so the emit fires.
  resolveTargetPeHash: jest.fn().mockResolvedValue('hash_promise_created'),
}));

const basePromise: PromiseDocument = {
  promise_id: 'promise_test',
  status: 'funded',
  borrower_wallet_id: 'wallet_borrower',
  lender_wallet_id: 'wallet_lender',
  borrower_address: '0xborrower',
  lender_address: '0xlender',
  currency: 'usdc',
  chain: 'base',
  repay_usdc: 100,
  net_to_lender_usdc: 99.5,
  fee_usdc: 0.5,
  pe_ids: ['pe_promise_created'], // First PE is always promise_created.
} as unknown as PromiseDocument;

function makeDeps(promise: PromiseDocument = basePromise): { deps: AgentBankDeps; promiseRef: { update: jest.Mock } } {
  const promiseRef = {
    get: jest.fn().mockResolvedValue({ exists: true, data: () => promise }),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const promisesCollection = { doc: jest.fn().mockReturnValue(promiseRef) };

  const walletRef = (id: string) => ({
    get: jest.fn().mockResolvedValue({
      exists: true,
      data: () => ({
        id,
        agent_id: id === 'wallet_borrower' ? 'agent_borrower' : 'agent_lender',
        address: id === 'wallet_borrower' ? '0xborrower' : '0xlender',
      }),
    }),
  });
  const agentWalletsCollection = { doc: jest.fn().mockImplementation(walletRef) };

  const db = {
    collection: jest.fn().mockImplementation((name: string) => {
      if (name === 'promises') return promisesCollection;
      if (name === 'agent_wallets') return agentWalletsCollection;
      throw new Error(`Unexpected collection lookup: ${name}`);
    }),
    // settlePromise now flips status inside a transaction so the
    // sweep's relay-observed flip and a lender's on-chain proof can't race the
    // settle. The fake dispatches tx.get/tx.update straight to the ref's own mocks.
    runTransaction: jest.fn(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        get: (ref: { get: () => Promise<unknown> }) => ref.get(),
        update: (ref: { update: (patch: unknown) => unknown }, patch: unknown) => ref.update(patch),
        set: jest.fn(),
        create: jest.fn(),
      };
      return fn(tx);
    }),
  };

  return {
    deps: { db, projectId: 'test', region: 'test', signerKey: '0xkey' } as unknown as AgentBankDeps,
    promiseRef,
  };
}

beforeEach(() => {
  mockGeneratePE.mockClear();
  mockUpdateWalletStats.mockClear();
  mockEmitCorroboration.mockClear();
  mockResolveTargetPeHash.mockClear();
  mockResolveTargetPeHash.mockResolvedValue('hash_promise_created');
});

describe('settlePromise - corroboration emits with a REAL target hash (Pass-2 #5)', () => {
  it('resolves the promise_created PE hash and passes it (never the empty string), attributed to system', async () => {
    const { deps } = makeDeps();

    await settlePromise(deps, 'promise_test', 'wallet_borrower', '0xsettletx');
    await flushMicrotasks();

    // The emit site fetched the real hash for the FIRST pe_id (promise_created).
    expect(mockResolveTargetPeHash).toHaveBeenCalledWith(deps, 'pe_promise_created');
    // ...and forwarded it. Pre-fix this was '', which the manager falsy-guard
    // rejected, so promise_fulfillment never fired. The borrower settles, so the
    // signal is attributed to 'system' (the relay that verified the on-chain
    // settlement), never the caller — caller attribution would be self-corroboration.
    expect(mockEmitCorroboration).toHaveBeenCalledTimes(1);
    expect(mockEmitCorroboration).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({
        targetPeId: 'pe_promise_created',
        targetPeHash: 'hash_promise_created',
        signalType: 'promise_fulfillment',
        corroboratingParty: 'system',
      }),
    );
    const emitArg = mockEmitCorroboration.mock.calls[0][1] as { targetPeHash: string };
    expect(emitArg.targetPeHash).not.toBe('');
  });

  it('skips the signal (no suppression of a valid one) when the target hash is genuinely missing', async () => {
    const { deps } = makeDeps();
    mockResolveTargetPeHash.mockResolvedValue(''); // target/hash genuinely absent

    await settlePromise(deps, 'promise_test', 'wallet_borrower', '0xsettletx');
    await flushMicrotasks();

    expect(mockResolveTargetPeHash).toHaveBeenCalledWith(deps, 'pe_promise_created');
    expect(mockEmitCorroboration).not.toHaveBeenCalled();
  });
});

describe('settlePromise - cure of a relay-observed default ', () => {
  // The relay auto-marks a funded promise `defaulted (relay_observed)` at its
  // deadline, but on chain it stays Funded and settleable. A borrower who actually
  // repays on chain must not be stranded as a defaulter: a VERIFIED on-chain
  // PromiseSettled CURES the unproven relay guess (→ settled). An on-chain-PROVEN
  // default is terminal and can never be settled. The pair is mutually non-vacuous.
  const relayObservedDefault = {
    ...basePromise,
    status: 'defaulted',
    default_proof: 'relay_observed',
    defaulted_at: Date.now() - 1000,
    onchain_promise_id: `0x${'ab'.repeat(32)}`,
  } as unknown as PromiseDocument;

  const provenDefault = {
    ...basePromise,
    status: 'defaulted',
    default_proof: 'onchain_proven',
    defaulted_at: Date.now() - 1000,
    default_tx_hash: `0x${'d'.repeat(64)}`,
    onchain_promise_id: `0x${'ab'.repeat(32)}`,
  } as unknown as PromiseDocument;

  it('CURES a relay-observed default: verified on-chain settlement flips it to settled', async () => {
    const { deps, promiseRef } = makeDeps(relayObservedDefault);

    const result = await settlePromise(deps, 'promise_test', 'wallet_borrower', '0xsettletx');

    expect(result.status).toBe('settled');
    // The status flip ran (transactionally) and set settled.
    expect(promiseRef.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'settled', settle_tx_hash: '0xsettletx' }),
    );
    // Both parties get a promise_settled PE — the cure is a full settlement.
    expect(mockGeneratePE).toHaveBeenCalledTimes(2);
  });

  it('RED — an on-chain-PROVEN default is terminal and CANNOT be settled', async () => {
    const { deps, promiseRef } = makeDeps(provenDefault);

    await expect(settlePromise(deps, 'promise_test', 'wallet_borrower', '0xsettletx'))
      .rejects.toBeInstanceOf(ValidationError);
    // Refused before the flip: no settle write, no PE.
    expect(promiseRef.update).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });
});
