/**
 * fundPromise — the funding bar, end to end (/ Stage 1a).
 *
 * `fundPromise` had NO test coverage before this file, which is how it kept the
 * weakest funding bar of the three institutions long after escrow and pools
 * raised theirs. The real verifier runs here against a faked chain (only the
 * RPC provider and the finality reader are mocked), so these exercise the
 * production predicate rather than a stand-in for it.
 *
 * THE CONTROLLING CASE is `refuses the bare-transfer bypass` the receipt is a
 * genuine `usdc.transfer(borrower, principal)` right token, right sender,
 * right recipient, right amount, 12 confirmations — and it must leave the row
 * `open`. the pre- `verifyTransfer` bar that same receipt flipped
 * the row to `funded` and emitted two `promise_funded` PEs; that reintroduction
 * was run and is recorded in DECISIONS.md.
 */

import { ethers } from 'ethers';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import type { GeneratePEParams } from './pe-utils';

/**
 * Bound to production's own field name — `Extract` is `never`, and this line an
 * assignment error, the moment `GeneratePEParams` stops declaring it. See
 * `relay-emitter-durability-fence.test.ts` for why relay emitters must not
 * carry it.
 */
const DURABLE_MARKER: Extract<keyof GeneratePEParams, 'durableViaOrdinaryIntake'> =
  'durableViaOrdinaryIntake';

const mockGetTransactionReceipt = jest.fn();
const mockCall = jest.fn();
const mockGeneratePE: jest.Mock<Promise<{ peId: string }>, unknown[]> = jest.fn(
  async (): Promise<{ peId: string }> => ({ peId: `pe_${mockGeneratePE.mock.calls.length}` }),
);
const mockUpdateWalletStats = jest.fn(async () => undefined);

jest.mock('../onchain/economic-finality', () => ({
  verifyBaseEconomicTransactionFinality: jest.fn(async () => ({
    evidence: { blockNumber: 100, blockHash: `0x${'b'.repeat(64)}`, confirmations: 12 },
  })),
}));

jest.mock('../onchain/rpc-provider', () => ({
  getVerifierProvider: jest.fn(() => ({
    getTransactionReceipt: (...args: unknown[]) => mockGetTransactionReceipt(...args),
    call: (...args: unknown[]) => mockCall(...args),
  })),
}));

jest.mock('./pe-utils', () => ({
  generatePE: (...args: unknown[]) => mockGeneratePE(...(args as [])),
}));

jest.mock('./wallet-stats', () => ({
  updateWalletStats: (...args: unknown[]) => mockUpdateWalletStats(...(args as [])),
}));

const PROMISE_CONTRACT = '0x' + '7'.repeat(40);
const LENDER = '0x1111111111111111111111111111111111111111';
const BORROWER = '0x2222222222222222222222222222222222222222';
const IMPOSTOR = '0x3333333333333333333333333333333333333333';
const ONCHAIN_ID = '0x' + 'ab'.repeat(32);
const OTHER_ONCHAIN_ID = '0x' + 'cd'.repeat(32);
const TX = '0x' + 'a'.repeat(64);
const TEN_USDC = 10_000_000n;

const IFACE = new ethers.Interface([
  'event PromiseFunded(bytes32 indexed promiseId, address indexed lender, uint256 principal)',
]);
const ERC20 = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function fundedLog(promiseId: string, lender: string, principal: bigint, index: number) {
  const { topics, data } = IFACE.encodeEventLog('PromiseFunded', [promiseId, lender, principal]);
  return { address: PROMISE_CONTRACT, topics, data, index };
}

function transferLog(from: string, to: string, value: bigint, index: number) {
  const { topics, data } = ERC20.encodeEventLog('Transfer', [from, to, value]);
  return { address: USDC_BASE, topics, data, index };
}

function receipt(logs: Array<Record<string, unknown>>) {
  return { status: 1, blockNumber: 100, confirmations: async () => 12, logs };
}

function structReturn(borrower: string, lender: string, principal: bigint): string {
  const word = (h: string) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  return '0x' + word(borrower) + word(lender) + word(principal.toString(16)) + '0'.repeat(64 * 5);
}

function openPromiseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    promise_id: 'p1',
    borrower_wallet_id: 'w_borrower',
    borrower_address: BORROWER,
    currency: 'usdc',
    principal_usdc: 10,
    repay_usdc: 11,
    fee_usdc: 0.0275,
    net_to_lender_usdc: 10.9725,
    purpose: 'test',
    chain: 'base',
    deadline: Date.now() + 86_400_000,
    status: 'open',
    borrower_snapshot: { governance_score: 95 },
    pe_ids: ['pe_create'],
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

async function seedDb(overrides: Record<string, unknown> = {}): Promise<FakeFirestore> {
  const db = createFakeFirestore();
  await db.collection('promises').doc('p1').set(openPromiseRow(overrides));
  await db.collection('agent_wallets').doc('w_borrower').set({
    id: 'w_borrower', address: BORROWER, agent_id: 'a_borrower', governance_score: 95,
  });
  await db.collection('agent_wallets').doc('w_lender').set({
    id: 'w_lender', address: LENDER, agent_id: 'a_lender', governance_score: 95,
  });
  return db;
}

/** Read a doc's data, failing loudly rather than optional-chaining a miss away. */
async function readRow(db: FakeFirestore, collection: string, id: string): Promise<Record<string, unknown>> {
  const snap = await db.collection(collection).doc(id).get();
  const data = snap.data();
  if (!data) throw new Error(`${collection}/${id} not found`);
  return data;
}

async function fund(db: FakeFirestore, promiseId = 'p1', lenderWalletId = 'w_lender'): Promise<unknown> {
  const { fundPromise } = await import('./promises');
  return fundPromise({ db } as never, promiseId, lenderWalletId, TX);
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PROMISE_CONTRACT_ADDRESS_BASE = PROMISE_CONTRACT;
});

afterEach(() => {
  delete process.env.PROMISE_CONTRACT_ADDRESS_BASE;
});

describe('fundPromise — the bare-transfer bypass', () => {
  it('REFUSES the bypass and leaves the row open with no PE emitted', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([transferLog(LENDER, BORROWER, TEN_USDC, 0)]),
    );
    const db = await seedDb();
    await expect(fund(db)).rejects.toThrow(/promise_funded_event_not_found/);

    const row = await readRow(db, 'promises', 'p1');
    expect(row.status).toBe('open');
    expect(row.lender_wallet_id).toBeUndefined();
    expect(mockGeneratePE).not.toHaveBeenCalled();
    expect(mockUpdateWalletStats).not.toHaveBeenCalled();
    expect((await db.collection('promise_fund_locks').get()).size).toBe(0);
  });
});

describe('fundPromise — a real on-chain funding', () => {
  it('flips to funded, pins the canonical log identity, and puts it in both PEs', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([
        transferLog(LENDER, BORROWER, TEN_USDC, 0),
        fundedLog(ONCHAIN_ID, LENDER, TEN_USDC, 1),
      ]),
    );
    mockCall.mockResolvedValue(structReturn(BORROWER, LENDER, TEN_USDC));
    const db = await seedDb();
    const result = (await fund(db)) as Record<string, unknown>;

    expect(result.status).toBe('funded');
    expect(result.onchain_promise_id).toBe(ONCHAIN_ID);
    expect(result.fund_log_index).toBe(1);

    const row = await readRow(db, 'promises', 'p1');
    expect(row.status).toBe('funded');
    expect(row.lender_address).toBe(LENDER);
    expect(row.fund_log_index).toBe(1);
    expect(row.onchain_promise_id).toBe(ONCHAIN_ID);
    expect(row.fund_block_number).toBe(100);

    // Both PEs carry the identity, not just the tx hash.
    expect(mockGeneratePE).toHaveBeenCalledTimes(2);
    for (const call of mockGeneratePE.mock.calls) {
      const arg = (call as unknown as [unknown, Record<string, Record<string, unknown>>])[1];
      expect(arg.actionType).toBe('promise_funded');
      expect(arg.metadata.tx_hash).toBe(TX);
      expect(arg.metadata.log_index).toBe(1);
      expect(arg.metadata.chain).toBe('base');
      expect(arg.metadata.onchain_promise_id).toBe(ONCHAIN_ID);
      // (RATIFIED): the durability marker is WATCHER-ONLY. BOTH promise
      // rows — borrower and lender — must lack it. A durable `promise_funded`
      // here would be a policy-eligible row on the SAME canonical event the
      // institution funding watcher earns on, which is the double-mint
      // forbids; and under the lender's row is precisely the
      // one 1b(iii) will make payable from the watcher's side, so a durable
      // relay twin is the exact collision. Runtime half of the fence in
      // `relay-emitter-durability-fence.test.ts`: that file scans the source,
      // this sees what is actually passed.
      expect(Object.prototype.hasOwnProperty.call(arg, DURABLE_MARKER)).toBe(false);
    }
  });

  it('writes exactly one fund lock keyed on chain + on-chain promise id', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([fundedLog(ONCHAIN_ID, LENDER, TEN_USDC, 0)]),
    );
    mockCall.mockResolvedValue(structReturn(BORROWER, LENDER, TEN_USDC));
    const db = await seedDb();
    await fund(db);
    const lock = await readRow(db, 'promise_fund_locks', `base:${ONCHAIN_ID}`);
    expect(lock).toMatchObject({
      promise_id: 'p1',
      chain: 'base',
      onchain_promise_id: ONCHAIN_ID,
      fund_tx_hash: TX,
      fund_log_index: 0,
    });
  });

  it('refuses to bind ONE on-chain funding to a SECOND promise row', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([fundedLog(ONCHAIN_ID, LENDER, TEN_USDC, 0)]),
    );
    mockCall.mockResolvedValue(structReturn(BORROWER, LENDER, TEN_USDC));
    const db = await seedDb();
    // A second open row for the same borrower/amount — a duplicate claim on one
    // real fund movement would double-credit stats and emit a second PE pair.
    await db.collection('promises').doc('p2').set(openPromiseRow({ promise_id: 'p2' }));
    await fund(db, 'p1');
    await expect(fund(db, 'p2')).rejects.toThrow(/already bound to another promise/);
    expect((await readRow(db, 'promises', 'p2')).status).toBe('open');
  });

  it('refuses a real funding whose on-chain borrower is someone else', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([fundedLog(OTHER_ONCHAIN_ID, LENDER, TEN_USDC, 0)]),
    );
    mockCall.mockResolvedValue(structReturn(IMPOSTOR, LENDER, TEN_USDC));
    const db = await seedDb();
    await expect(fund(db)).rejects.toThrow(/promise_borrower_mismatch/);
    expect((await readRow(db, 'promises', 'p1')).status).toBe('open');
  });
});
