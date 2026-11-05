/**
 * agent-promise DEFAULT (lender-initiated, on-chain-proven) and CANCEL
 * (borrower-initiated, while open + unfunded).
 *
 * `verifyEvmPromiseDefault` and the chain-address resolver are peripheral seams
 * (exhaustively covered in tx-verifier.promise.test.ts), mocked to controllable
 * verdicts so this suite exercises the business logic: status gating, the deadline
 * guard, party authorization, and the on-chain-proof requirement. Every RED
 * control is paired with the happy path it inverts (non-vacuity).
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import type { AgentBankDeps, PromiseDocument } from './types';
import { ValidationError, ForbiddenError } from './errors';

const mockGeneratePE = jest.fn(async () => ({ peId: 'pe_mock', peHash: 'h', prevHash: 'p' }));
jest.mock('./pe-utils', () => ({
  generatePE: (...args: unknown[]) => (mockGeneratePE as (...a: unknown[]) => unknown)(...args),
  generateSchedulerPE: (...args: unknown[]) => (mockGeneratePE as (...a: unknown[]) => unknown)(...args),
}));

const mockVerifyDefault = jest.fn(async () => ({ ok: true, blockNumber: 100, logIndex: 2, onchainPromiseId: `0x${'ab'.repeat(32)}` }));
jest.mock('../onchain/tx-verifier', () => ({
  ...(jest.requireActual('../onchain/tx-verifier') as object),
  verifyEvmPromiseDefault: (...args: unknown[]) => (mockVerifyDefault as (...a: unknown[]) => unknown)(...args),
}));

jest.mock('./chain-registry', () => ({
  ...(jest.requireActual('./chain-registry') as object),
  promiseUsdcAddressForChain: () => '0x1111111111111111111111111111111111111111',
}));

// eslint-disable-next-line import/first
import { defaultPromise, cancelPromise } from './promises';

const ONCHAIN_ID = `0x${'ab'.repeat(32)}`;

function fundedPromise(over: Partial<PromiseDocument> = {}): PromiseDocument {
  return {
    promise_id: 'promise_test',
    borrower_wallet_id: 'wallet_borrower',
    lender_wallet_id: 'wallet_lender',
    borrower_address: '0xborrower',
    lender_address: '0xlender',
    currency: 'usdc',
    chain: 'base',
    principal_usdc: 50,
    repay_usdc: 52.5,
    fee_usdc: 0.13,
    net_to_lender_usdc: 52.37,
    purpose: 'test',
    deadline: Date.now() - 60_000, // past due
    status: 'funded',
    onchain_promise_id: ONCHAIN_ID,
    borrower_snapshot: {} as PromiseDocument['borrower_snapshot'],
    pe_ids: ['pe_created'],
    created_at: Date.now() - 100_000,
    updated_at: Date.now() - 100_000,
    ...over,
  } as PromiseDocument;
}

let fs: FakeFirestore;
function makeDeps(promise: PromiseDocument): AgentBankDeps {
  fs = createFakeFirestore();
  fs.store.set('promises/promise_test', promise as unknown as Record<string, unknown>);
  fs.store.set('agent_wallets/wallet_borrower', { id: 'wallet_borrower', agent_id: 'agent_b', address: '0xborrower' });
  fs.store.set('agent_wallets/wallet_lender', { id: 'wallet_lender', agent_id: 'agent_l', address: '0xlender' });
  return { db: fs } as unknown as AgentBankDeps;
}

function stored(): PromiseDocument {
  return fs.store.get('promises/promise_test') as unknown as PromiseDocument;
}

beforeEach(() => {
  mockGeneratePE.mockClear();
  mockVerifyDefault.mockClear();
  mockVerifyDefault.mockResolvedValue({ ok: true, blockNumber: 100, logIndex: 2, onchainPromiseId: ONCHAIN_ID });
});

describe('defaultPromise — lender-initiated, on-chain-proven', () => {
  it('flips a past-due funded promise to defaulted after verifying the on-chain event', async () => {
    const deps = makeDeps(fundedPromise());
    const result = await defaultPromise(deps, 'promise_test', 'wallet_lender', `0x${'d'.repeat(64)}`);
    expect(result.status).toBe('defaulted');
    expect(stored().status).toBe('defaulted');
    expect(stored().default_tx_hash).toBe(`0x${'d'.repeat(64)}`);
    expect(mockVerifyDefault).toHaveBeenCalledTimes(1);
    // Both parties get a promise_defaulted PE.
    expect(mockGeneratePE).toHaveBeenCalledTimes(2);
  });

  it('the default is ONE adverse event, on the borrower — the lender\'s row of it is a record', async () => {
    const { deriveCompositionSignals, countsAsAdverse, ADVERSE_STANDING_TYPES } =
      jest.requireActual('../pvt/actor-stats') as typeof import('../pvt/actor-stats');
    const deps = makeDeps(fundedPromise());
    await defaultPromise(deps, 'promise_test', 'wallet_lender', `0x${'d'.repeat(64)}`);
    const sealed = (mockGeneratePE.mock.calls as unknown as Array<[unknown, { walletId: string; actionType: string; metadata: Record<string, unknown> }]>)
      .map(([, p]) => ({ wallet: p.walletId, type: p.actionType, adverse: countsAsAdverse(p.actionType, deriveCompositionSignals(p.metadata, null)) }));
    expect(sealed).toHaveLength(2);
    // RED: by type alone (the pre- rule) BOTH rows are adverse.
    expect(sealed.filter((r) => ADVERSE_STANDING_TYPES.has(r.type))).toHaveLength(2);
    expect(sealed.filter((r) => r.adverse).map((r) => r.wallet)).toEqual([fundedPromise().borrower_wallet_id]);
  });

  it('RED — a promise cannot default BEFORE its deadline', async () => {
    const deps = makeDeps(fundedPromise({ deadline: Date.now() + 60_000 })); // not yet due
    await expect(defaultPromise(deps, 'promise_test', 'wallet_lender', `0x${'d'.repeat(64)}`))
      .rejects.toBeInstanceOf(ValidationError);
    expect(stored().status).toBe('funded'); // unchanged
    expect(mockVerifyDefault).not.toHaveBeenCalled(); // refused before touching the chain
  });

  it('RED — only the LENDER may default (borrower cannot)', async () => {
    const deps = makeDeps(fundedPromise());
    await expect(defaultPromise(deps, 'promise_test', 'wallet_borrower', `0x${'d'.repeat(64)}`))
      .rejects.toBeInstanceOf(ForbiddenError);
    expect(stored().status).toBe('funded');
  });

  it('RED — an OPEN (unfunded) promise cannot default', async () => {
    const deps = makeDeps(fundedPromise({ status: 'open', lender_wallet_id: undefined, lender_address: undefined }));
    await expect(defaultPromise(deps, 'promise_test', 'wallet_lender', `0x${'d'.repeat(64)}`))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it('RED — an unverifiable on-chain default is refused', async () => {
    mockVerifyDefault.mockResolvedValue({ ok: false, reason: 'promise_defaulted_event_not_found' } as never);
    const deps = makeDeps(fundedPromise());
    await expect(defaultPromise(deps, 'promise_test', 'wallet_lender', `0x${'d'.repeat(64)}`))
      .rejects.toBeInstanceOf(ValidationError);
    expect(stored().status).toBe('funded');
  });

  // addendum — the DUAL default path. The relay sweep can
  // pre-mark a funded promise `defaulted (relay_observed)`; a lender's verified
  // markDefault then UPGRADES the same row to `onchain_proven`, never regressing it.
  it('UPGRADES a relay-observed default to onchain_proven (preserves defaulted_at, stamps default_proven_at, emits PEs)', async () => {
    const observedAt = Date.now() - 30_000;
    const deps = makeDeps(fundedPromise({
      status: 'defaulted',
      default_proof: 'relay_observed',
      defaulted_at: observedAt,
    }));
    const result = await defaultPromise(deps, 'promise_test', 'wallet_lender', `0x${'d'.repeat(64)}`);
    expect(result.status).toBe('defaulted');
    expect(result.default_proof).toBe('onchain_proven');
    expect(stored().default_proof).toBe('onchain_proven');
    // The observation time NEVER moves later on proof; the proof time is stamped separately.
    expect(stored().defaulted_at).toBe(observedAt);
    expect(stored().default_proven_at).toBeGreaterThan(0);
    expect(stored().default_tx_hash).toBe(`0x${'d'.repeat(64)}`);
    // The proof is what verifies on chain and seals the PE pair (the relay-observed
    // flip sealed none), so exactly one pair is emitted here.
    expect(mockVerifyDefault).toHaveBeenCalledTimes(1);
    expect(mockGeneratePE).toHaveBeenCalledTimes(2);
  });

  it('RED — a default on an ALREADY-PROVEN promise is idempotent: no re-verify, no new PE, never regresses', async () => {
    const provenAt = Date.now() - 10_000;
    const deps = makeDeps(fundedPromise({
      status: 'defaulted',
      default_proof: 'onchain_proven',
      defaulted_at: provenAt,
      default_tx_hash: `0x${'e'.repeat(64)}`,
    }));
    const result = await defaultPromise(deps, 'promise_test', 'wallet_lender', `0x${'d'.repeat(64)}`);
    expect(result.status).toBe('defaulted');
    expect(result.default_proof).toBe('onchain_proven');
    // Terminal + never-regress: the stored proof and its ORIGINAL tx are untouched
    // by the second call (its 0xdddd… tx never overwrote the 0xeeee… of record).
    expect(stored().default_proof).toBe('onchain_proven');
    expect(stored().default_tx_hash).toBe(`0x${'e'.repeat(64)}`);
    expect(stored().defaulted_at).toBe(provenAt);
    // Short-circuited at the top: no chain re-verify, no second PE pair (non-vacuous
    // against the happy path above, which DOES verify once + emit twice).
    expect(mockVerifyDefault).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('RED — sweep-vs-upgrade race: funded initial read, sweep flips to relay_observed DURING verify → return still carries defaulted_at (no spurious 500)', async () => {
    // The exact TOCTOU this dual path introduces: the lender's /default reads the
    // promise as `funded` (no defaulted_at), then WHILE the on-chain verify RPC is in
    // flight the hourly sweep commits funded → defaulted(relay_observed) with a
    // defaulted_at the initial read never saw. The transaction re-reads relay_observed
    // and correctly UPGRADES to onchain_proven — but the RETURN must reflect the
    // persisted row, or `new Date(promise.defaulted_at!)` in the route throws a 500 on
    // a call that succeeded. Simulate the concurrent flip inside the verify mock.
    const observedAt = Date.now() - 5_000;
    const deps = makeDeps(fundedPromise()); // status funded, NO defaulted_at
    mockVerifyDefault.mockImplementation(async () => {
      const cur = fs.store.get('promises/promise_test') as Record<string, unknown>;
      fs.store.set('promises/promise_test', {
        ...cur,
        status: 'defaulted',
        default_proof: 'relay_observed',
        defaulted_at: observedAt,
      });
      return { ok: true, blockNumber: 100, logIndex: 2, onchainPromiseId: ONCHAIN_ID } as never;
    });

    const result = await defaultPromise(deps, 'promise_test', 'wallet_lender', `0x${'d'.repeat(64)}`);

    // The upgrade succeeded and the returned object reflects the PERSISTED row —
    // NOT the stale `funded` initial read (which lacked defaulted_at).
    expect(result.status).toBe('defaulted');
    expect(result.default_proof).toBe('onchain_proven');
    expect(result.defaulted_at).toBe(observedAt);        // buggy code returned undefined here
    expect(result.default_proven_at).toBeGreaterThan(0);
    expect(result.default_tx_hash).toBe(`0x${'d'.repeat(64)}`);
    // The route calls new Date(promise.defaulted_at!).toISOString(); it must not throw.
    expect(() => new Date(result.defaulted_at!).toISOString()).not.toThrow();
    // State is correct + PEs emitted exactly once.
    expect(stored().default_proof).toBe('onchain_proven');
    expect(stored().defaulted_at).toBe(observedAt);
    expect(mockGeneratePE).toHaveBeenCalledTimes(2);
  });
});

describe('cancelPromise — borrower-initiated, open + unfunded', () => {
  it('cancels an open promise by its borrower', async () => {
    const deps = makeDeps(fundedPromise({ status: 'open', lender_wallet_id: undefined, lender_address: undefined }));
    const result = await cancelPromise(deps, 'promise_test', 'wallet_borrower');
    expect(result.status).toBe('cancelled');
    expect(stored().status).toBe('cancelled');
    expect(stored().cancelled_at).toBeGreaterThan(0);
    // Cancelling an unfunded offer seals no PE (no value moved; the created PE
    // already recorded the offer) — it would also trip the frozen action matrix.
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('RED — a FUNDED promise cannot be cancelled', async () => {
    const deps = makeDeps(fundedPromise()); // status funded
    await expect(cancelPromise(deps, 'promise_test', 'wallet_borrower'))
      .rejects.toBeInstanceOf(ValidationError);
    expect(stored().status).toBe('funded');
  });

  it('RED — only the BORROWER may cancel (a stranger cannot)', async () => {
    const deps = makeDeps(fundedPromise({ status: 'open', lender_wallet_id: undefined, lender_address: undefined }));
    await expect(cancelPromise(deps, 'promise_test', 'wallet_lender'))
      .rejects.toBeInstanceOf(ForbiddenError);
    expect(stored().status).toBe('open');
  });
});
