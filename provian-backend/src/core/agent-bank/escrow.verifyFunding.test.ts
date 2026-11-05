/**
 * verifyFunding - concurrent funding race (B-2 audit 2026-05-11).
 *
 * Verifies the status flip happens inside a Firestore transaction so two
 * concurrent fund attempts with the same txHash can't both succeed and
 * double-credit the depositor.
 *
 * Scenarios:
 *  1. The transaction's inner re-read returns status='funded' (because a
 *     concurrent verifier won the race) → ValidationError, no PE emitted.
 *  2. Happy path: first call commits, second call's transaction body throws.
 */

import { verifyFunding } from './escrow';
import type { AgentBankDeps, EscrowDocument } from './types';
import type { GeneratePEParams } from './pe-utils';

/**
 * Bound to production's own field name — `Extract` is `never`, and this line an
 * assignment error, the moment `GeneratePEParams` stops declaring it. See
 * `relay-emitter-durability-fence.test.ts` for why relay emitters must not
 * carry it.
 */
const DURABLE_MARKER: Extract<keyof GeneratePEParams, 'durableViaOrdinaryIntake'> =
  'durableViaOrdinaryIntake';

const mockGeneratePE = jest.fn().mockResolvedValue({
  peId: 'pe_funding',
  peHash: 'hash_funding',
  prevHash: 'prev_funding',
});

jest.mock('./pe-utils', () => ({
  generatePE: (...args: unknown[]) => mockGeneratePE(...args),
}));

const mockUpdateWalletStats = jest.fn().mockResolvedValue(undefined);

jest.mock('./wallet-stats', () => ({
  updateWalletStats: (...args: unknown[]) => mockUpdateWalletStats(...args),
}));

jest.mock('../corroboration/CorroborationManager', () => ({
  emitBackendCorroboration: jest.fn(),
  resolveTargetPeHash: jest.fn().mockResolvedValue('hash_target'),
}));

const mockVerifyTransfer = jest.fn();
const mockVerifyOnchainEscrowFunding = jest.fn();
jest.mock('../onchain/tx-verifier', () => ({
  verifyTransfer: (...args: unknown[]) => mockVerifyTransfer(...args),
  verifyOnchainEscrowFunding: (...args: unknown[]) => mockVerifyOnchainEscrowFunding(...args),
}));

jest.mock('./pvt-principal-config', () => ({
  loadPvtPrincipalConfig: () => ({ enabled: false }),
}));

jest.mock('./chain-registry', () => ({
  assertSupportedAgentBankChain: () => undefined,
  escrowUsdcAddressForChain: () => '0xEscrow',
  escrowV4AddressForChain: () => '0xEscrowV4',
  requireAddressOrThrow: (addr: string) => addr,
}));

const baseEscrow: EscrowDocument = {
  escrow_id: 'escrow_test',
  depositor_wallet_id: 'wallet_depositor',
  recipient_wallet_id: 'wallet_recipient',
  depositor_address: '0xdeposit',
  recipient_address: '0xrecipient',
  description: 'test',
  deliverables: 'agent_payment',
  status: 'created',
  chain: 'base',
  currency: 'usdc',
  amount_usdc: 100,
  fee_usdc: 0.5,
  net_to_recipient_usdc: 99.5,
  deadline: 0,
  auto_release_at: 0,
  created_at: 0,
  updated_at: 0,
  pe_ids: ['pe_escrow_created'],
} as unknown as EscrowDocument;

function makeDeps(opts: {
  initialStatus: EscrowDocument['status'];
  /** Status that the inner-transaction re-read sees. Defaults to initialStatus. */
  txReadStatus?: EscrowDocument['status'];
  /** Fields merged into baseEscrow for both the outer + tx reads. */
  escrowOverrides?: Partial<EscrowDocument>;
  /** When true, the on-chain funding lock already exists (#2 replay). */
  fundLockExists?: boolean;
}): {
  deps: AgentBankDeps;
  escrowRef: { update: jest.Mock };
  txUpdate: jest.Mock;
  txSet: jest.Mock;
} {
  const txReadStatus = opts.txReadStatus ?? opts.initialStatus;
  const overrides = opts.escrowOverrides ?? {};
  const fundLockExists = opts.fundLockExists ?? false;

  const escrowRef = {
    get: jest.fn().mockResolvedValue({
      exists: true,
      data: () => ({ ...baseEscrow, ...overrides, status: opts.initialStatus }),
    }),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const escrowCollection = {
    doc: jest.fn().mockReturnValue(escrowRef),
  };

  // Distinct ref object so the transaction's get() can tell the fund-lock doc
  // apart from the escrow doc by identity.
  const fundLockRef = { __kind: 'fund_lock' };
  const fundLockCollection = {
    doc: jest.fn().mockReturnValue(fundLockRef),
  };

  const agentWalletRef = {
    get: jest.fn().mockResolvedValue({
      exists: true,
      data: () => ({ agent_id: 'agent_test', address: '0xdeposit' }),
    }),
  };
  const agentWalletCollection = {
    doc: jest.fn().mockReturnValue(agentWalletRef),
  };

  const txUpdate = jest.fn();
  const txSet = jest.fn();
  const runTransaction = jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
    const fakeTx = {
      get: jest.fn().mockImplementation((ref: unknown) => {
        if (ref === fundLockRef) return Promise.resolve({ exists: fundLockExists });
        return Promise.resolve({
          exists: true,
          data: () => ({ ...baseEscrow, ...overrides, status: txReadStatus }),
        });
      }),
      set: txSet,
      update: txUpdate,
    };
    await fn(fakeTx);
  });

  const db = {
    collection: jest.fn().mockImplementation((name: string) => {
      if (name === 'escrows') return escrowCollection;
      if (name === 'escrow_fund_locks') return fundLockCollection;
      if (name === 'agent_wallets') return agentWalletCollection;
      return { doc: jest.fn() };
    }),
    runTransaction,
  };

  return {
    deps: { db, cache: {} } as unknown as AgentBankDeps,
    escrowRef,
    txUpdate,
    txSet,
  };
}

describe('verifyFunding - concurrent funding race', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyTransfer.mockResolvedValue({ ok: true, blockNumber: 100 });
    // On-chain struct binding passes by default; recipient matches baseEscrow,
    // autoReleaseAtSeconds=0 keeps the #11 gate satisfied for auto_release_at=0.
    mockVerifyOnchainEscrowFunding.mockResolvedValue({
      ok: true,
      onchainEscrowId: '0x' + 'ab'.repeat(32),
      recipient: '0xrecipient',
      autoReleaseAtSeconds: 0n,
    });
  });

  it('throws when the transaction-internal re-read shows status=funded', async () => {
    // Outer .get() sees 'created' (slipped past), but the inner tx.get()
    // sees 'funded' because a concurrent caller committed first.
    const { deps, txUpdate } = makeDeps({
      initialStatus: 'created',
      txReadStatus: 'funded',
    });

    await expect(verifyFunding(deps, 'escrow_test', '0xtxhash')).rejects.toThrow(/expected created/);

    // The status flip never happened in the transaction, no PE emitted,
    // no wallet stats update.
    expect(txUpdate).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
    expect(mockUpdateWalletStats).not.toHaveBeenCalled();
  });

  it('happy path: emits PE + arrayUnion when transaction-internal status is created', async () => {
    const { deps, escrowRef, txUpdate } = makeDeps({
      initialStatus: 'created',
      txReadStatus: 'created',
    });

    const result = await verifyFunding(deps, 'escrow_test', '0xtxhash');

    // Status flip happened inside the funding transaction (its update is first).
    expect(txUpdate.mock.calls[0][1]).toMatchObject({
      status: 'funded',
      fund_tx_hash: '0xtxhash',
    });
    // escrow_funded PE emitted exactly once (N1: guarded by the funding_pe_id marker).
    expect(mockGeneratePE).toHaveBeenCalledTimes(1);
    // (RATIFIED): the durability marker is WATCHER-ONLY. A durable
    // `escrow_funded` here would be a policy-eligible row on the SAME canonical
    // event the institution funding watcher earns on — the double-mint
    // forbids. Runtime half of the fence in
    // `relay-emitter-durability-fence.test.ts`: that file scans the source, this
    // sees what is actually passed.
    expect(
      Object.prototype.hasOwnProperty.call(
        mockGeneratePE.mock.calls[0][1] as object,
        DURABLE_MARKER,
      ),
    ).toBe(false);
    // pe_ids appended via arrayUnion (not a clobbering write); the funding_pe_id
    // marker is persisted so a retry can skip re-emitting.
    const peIdsUpdateCall = escrowRef.update.mock.calls.find((call: unknown[]) => 'pe_ids' in (call[0] as object));
    expect(peIdsUpdateCall).toBeDefined();
    expect(peIdsUpdateCall![0].pe_ids).toBeDefined();
    expect(peIdsUpdateCall![0].funding_pe_id).toBeDefined();
    // N1: the depositor funding stat is credited + marked ATOMICALLY (in a txn),
    // not via the old standalone updateWalletStats.
    expect(mockUpdateWalletStats).not.toHaveBeenCalled();
    expect(txUpdate.mock.calls.some((c: unknown[]) => (c[1] as { funding_stats_credited?: boolean }).funding_stats_credited === true)).toBe(true);
    expect(result.status).toBe('funded');
  });

  it('rejects fast if the outer pre-check sees a terminal (non-created, non-funded) status', async () => {
    // 'funded' now triggers the N1 repair path (see the dedicated test below), so
    // the fast-reject applies only to genuinely terminal statuses.
    const { deps, txUpdate } = makeDeps({ initialStatus: 'resolved' });

    await expect(verifyFunding(deps, 'escrow_test', '0xtxhash')).rejects.toThrow(/expected created/);

    // Bailed before the on-chain verify or the transaction.
    expect(mockVerifyTransfer).not.toHaveBeenCalled();
    expect(txUpdate).not.toHaveBeenCalled();
  });

  // N1 repair: a prior verifyFunding flipped status → 'funded' (funds locked
  // on-chain) but crashed before the escrow_funded PE + depositor stat. A re-POST
  // /fund must RE-RUN only the missing side-effects (idempotent), not throw.
  it('repairs a funded escrow missing its funding PE + stat instead of throwing (N1)', async () => {
    const { deps, escrowRef, txUpdate } = makeDeps({ initialStatus: 'funded' });

    const result = await verifyFunding(deps, 'escrow_test', '0xtxhash');

    // Did not re-verify on-chain (already funded); re-emitted the escrow_funded PE
    // and credited the funding stat atomically.
    expect(mockVerifyTransfer).not.toHaveBeenCalled();
    expect(mockGeneratePE).toHaveBeenCalledTimes(1);
    expect(escrowRef.update.mock.calls.some((c: unknown[]) => 'funding_pe_id' in (c[0] as object))).toBe(true);
    expect(txUpdate.mock.calls.some((c: unknown[]) => (c[1] as { funding_stats_credited?: boolean }).funding_stats_credited === true)).toBe(true);
    expect(result.status).toBe('funded');
  });

  // N1 repair no-op: a fully-funded escrow (both markers set) re-emits nothing.
  it('is a no-op repair when the funded escrow already has both funding markers (N1)', async () => {
    const { deps } = makeDeps({
      initialStatus: 'funded',
      escrowOverrides: { funding_pe_id: 'pe_funding', funding_stats_credited: true },
    });

    const result = await verifyFunding(deps, 'escrow_test', '0xtxhash');

    expect(mockGeneratePE).not.toHaveBeenCalled();
    expect(result.status).toBe('funded');
  });
});

describe('verifyFunding - on-chain escrow struct binding (Pass-2 WS3 #2/#11)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyTransfer.mockResolvedValue({ ok: true, blockNumber: 100 });
    mockVerifyOnchainEscrowFunding.mockResolvedValue({
      ok: true,
      onchainEscrowId: '0x' + 'ab'.repeat(32),
      recipient: '0xrecipient',
      autoReleaseAtSeconds: 0n,
    });
  });

  // #2: the depositor created the on-chain escrow with recipient=self, funded it
  // (passing the transfer check), but the struct pays someone other than the
  // Firestore recipient. The struct binding must REJECT — otherwise the relay
  // would credit the worker + emit a verified escrow_completed PE for funds that
  // release to the depositor.
  it('rejects funding when the on-chain struct recipient != Firestore recipient (#2)', async () => {
    mockVerifyOnchainEscrowFunding.mockResolvedValue({
      ok: false,
      reason: 'escrow_recipient_mismatch',
    });
    const { deps, txUpdate } = makeDeps({ initialStatus: 'created' });

    await expect(verifyFunding(deps, 'escrow_test', '0xtxhash')).rejects.toThrow(
      /On-chain escrow verification failed: escrow_recipient_mismatch/,
    );

    // No status flip, no PE, no wallet-stats credit on a rejected funding.
    expect(txUpdate).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
    expect(mockUpdateWalletStats).not.toHaveBeenCalled();
  });

  it('rejects funding when the recovered struct amount does not match (#2/#36)', async () => {
    mockVerifyOnchainEscrowFunding.mockResolvedValue({
      ok: false,
      reason: 'escrow_funded_amount_mismatch',
    });
    const { deps, txUpdate } = makeDeps({ initialStatus: 'created' });

    await expect(verifyFunding(deps, 'escrow_test', '0xtxhash')).rejects.toThrow(
      /On-chain escrow verification failed: escrow_funded_amount_mismatch/,
    );
    expect(txUpdate).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  // #11: the depositor set an on-chain autoReleaseAt LATER than the agreed
  // Firestore auto_release_at. Persisting/accepting it would strand the worker:
  // the Firestore gate would elapse first and every release attempt would revert
  // AutoReleaseNotReached. Must reject.
  it('rejects funding when on-chain autoReleaseAt is later than the agreed gate (#11)', async () => {
    mockVerifyOnchainEscrowFunding.mockResolvedValue({
      ok: true,
      onchainEscrowId: '0x' + 'cd'.repeat(32),
      recipient: '0xrecipient',
      // 2_000_000_000s -> 2e12 ms, far beyond the agreed 1_000s gate below.
      autoReleaseAtSeconds: 2_000_000_000n,
    });
    const { deps, txUpdate } = makeDeps({
      initialStatus: 'created',
      escrowOverrides: { auto_release_at: 1_000 },
    });

    await expect(verifyFunding(deps, 'escrow_test', '0xtxhash')).rejects.toThrow(
      /later than the agreed auto_release_at/,
    );
    expect(txUpdate).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  // #11 happy path: an in-bounds on-chain autoReleaseAt is PERSISTED as the gate
  // (the authoritative release time) and the recovered on-chain id is pinned.
  it('persists the on-chain autoReleaseAt + escrow id when within the agreed gate (#11/#2)', async () => {
    const onchainSeconds = 1_700_000_000n; // -> 1.7e12 ms, <= the 2e12 ms gate below
    const onchainId = '0x' + 'ef'.repeat(32);
    mockVerifyOnchainEscrowFunding.mockResolvedValue({
      ok: true,
      onchainEscrowId: onchainId,
      recipient: '0xrecipient',
      autoReleaseAtSeconds: onchainSeconds,
    });
    const { deps, txUpdate } = makeDeps({
      initialStatus: 'created',
      escrowOverrides: { auto_release_at: 2_000_000_000_000 },
    });

    const result = await verifyFunding(deps, 'escrow_test', '0xtxhash');

    // The funding status-flip update is first (the later txUpdate calls are the
    // atomic funding-stat credit — N1).
    expect(txUpdate.mock.calls[0][1]).toMatchObject({
      status: 'funded',
      onchain_escrow_id: onchainId,
      auto_release_at: Number(onchainSeconds * 1000n),
    });
    expect(result.onchain_escrow_id).toBe(onchainId);
    expect(result.auto_release_at).toBe(Number(onchainSeconds * 1000n));
  });

  it('passes the escrow recipient + amount through to the on-chain verifier (#2)', async () => {
    const { deps } = makeDeps({ initialStatus: 'created' });
    await verifyFunding(deps, 'escrow_test', '0xtxhash');

    expect(mockVerifyOnchainEscrowFunding).toHaveBeenCalledTimes(1);
    expect(mockVerifyOnchainEscrowFunding.mock.calls[0][0]).toMatchObject({
      expectedRecipient: '0xrecipient',
      currency: 'usdc',
      expectedAmountUsdc: 100,
      fundTxHash: '0xtxhash',
    });
  });

  // #2 "bind fund_tx_hash uniquely": a single on-chain funding must credit at
  // most one escrow. If the fund lock for this on-chain id already exists, the
  // funding is rejected — no second status flip, no duplicate PE / stats credit.
  it('rejects a replay binding the same on-chain funding to a second escrow (#2)', async () => {
    const { deps, txUpdate } = makeDeps({ initialStatus: 'created', fundLockExists: true });

    await expect(verifyFunding(deps, 'escrow_test', '0xtxhash')).rejects.toThrow(
      /already bound to another escrow/,
    );

    expect(txUpdate).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
    expect(mockUpdateWalletStats).not.toHaveBeenCalled();
  });

  it('writes the fund lock + flips status on a fresh funding (#2)', async () => {
    const { deps, txSet, txUpdate } = makeDeps({ initialStatus: 'created' });

    await verifyFunding(deps, 'escrow_test', '0xtxhash');

    // The lock is created in the SAME transaction as the status flip.
    expect(txSet).toHaveBeenCalledTimes(1);
    expect(txSet.mock.calls[0][1]).toMatchObject({
      escrow_id: 'escrow_test',
      fund_tx_hash: '0xtxhash',
    });
    // The funding status flip is the first tx update (later updates are the
    // atomic funding-stat credit — N1).
    expect(txUpdate.mock.calls[0][1]).toMatchObject({ status: 'funded' });
  });
});
