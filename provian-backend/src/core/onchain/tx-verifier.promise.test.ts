/**
 * tx-verifier — promise funding verification (/ Stage 1a).
 *
 * `verifyEvmPromiseFunding` replaces the bare ERC-20 `Transfer` bar that
 * `fundPromise` used to run. The controlling case, and the reason this file
 * exists, is `THE BARE-TRANSFER BYPASS` below: a receipt carrying ONLY a
 * lender → borrower USDC Transfer — exactly what `usdc.transfer(borrower, n)`
 * produces without ever calling the promise contract — passed the old bar and
 * must be REFUSED by this one.
 *
 * The promise-contract log fixtures are encoded with the SAME event signatures
 * the verifier pins, so a signature drift fails the encode here too
 * (fail-closed). The `promises(bytes32)` struct fixtures are built by word
 * index for BOTH the V2 (8-word) and V3 (9-word) shapes, so the
 * version-agnostic prefix claim is exercised on both rather than asserted.
 */

import { ethers } from 'ethers';
import {
  verifyEvmPromiseFunding,
  verifyEvmPromiseSettlement,
  verifyEvmPromiseDefault,
  parsePromiseFundedEvents,
  parsePromiseSettledEvents,
  parsePromiseDefaultedEvents,
  decodePromiseStructPrefix,
} from './tx-verifier';

const mockGetTransactionReceipt = jest.fn();
const mockCall = jest.fn();

jest.mock('./economic-finality', () => ({
  verifyBaseEconomicTransactionFinality: jest.fn(async () => ({
    evidence: {
      blockNumber: 100,
      blockHash: `0x${'b'.repeat(64)}`,
      confirmations: 12,
    },
  })),
}));

jest.mock('./rpc-provider', () => ({
  getVerifierProvider: jest.fn(() => ({
    getTransactionReceipt: (...args: unknown[]) => mockGetTransactionReceipt(...args),
    call: (...args: unknown[]) => mockCall(...args),
  })),
}));

const PROMISE = '0x' + '7'.repeat(40);
const OTHER_CONTRACT = '0x' + '9'.repeat(40);
const LENDER = '0x1111111111111111111111111111111111111111';
const BORROWER = '0x2222222222222222222222222222222222222222';
const IMPOSTOR = '0x3333333333333333333333333333333333333333';
const PROMISE_ID = '0x' + 'ab'.repeat(32);
const OTHER_PROMISE_ID = '0x' + 'cd'.repeat(32);
const TX = '0x' + 'a'.repeat(64);

// Byte-identical to the ABI the verifier pins.
const IFACE = new ethers.Interface([
  'event PromiseFunded(bytes32 indexed promiseId, address indexed lender, uint256 principal)',
  'event PromiseFundedPVT(bytes32 indexed promiseId, address indexed lender, uint256 principal)',
  'event PromiseSettled(bytes32 indexed promiseId, address indexed lender, uint256 netAmount, uint256 fee)',
  'event PromiseSettledPVT(bytes32 indexed promiseId, address indexed lender, uint256 netAmount, uint256 feeBurned)',
  // default events carry THREE indexed args (promiseId, borrower, lender).
  'event PromiseDefaulted(bytes32 indexed promiseId, address indexed borrower, address indexed lender, uint256 principal)',
  'event PromiseDefaultedPVT(bytes32 indexed promiseId, address indexed borrower, address indexed lender, uint256 principal)',
]);

// The real ERC-20 Transfer the OLD bar accepted. Encoded from the canonical
// signature so this fixture is a genuine Transfer log, not a lookalike.
const ERC20 = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function log(name: string, args: unknown[], address = PROMISE, index = 0) {
  const { topics, data } = IFACE.encodeEventLog(name, args);
  return { address, topics, data, index };
}

function transferLog(from: string, to: string, value: bigint, index = 0) {
  const { topics, data } = ERC20.encodeEventLog('Transfer', [from, to, value]);
  return { address: USDC_BASE, topics, data, index };
}

function receipt(logs: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) {
  return {
    status: 1,
    blockNumber: 100,
    confirmations: async () => 12,
    logs,
    ...overrides,
  };
}

function word(hex: string): string {
  return hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

/** V2 `promises()` return: 8 words, borrower/lender/principal at 0/1/2. */
function promiseStructV2(borrower: string, lender: string, principalAtomic: bigint): string {
  return '0x'
    + word(borrower)
    + word(lender)
    + word(principalAtomic.toString(16))
    + '0'.repeat(64 * 5);
}

/** V3 `promises()` return: 9 words (currency inserted AFTER status, word 7). */
function promiseStructV3(borrower: string, lender: string, principalAtomic: bigint): string {
  return '0x'
    + word(borrower)
    + word(lender)
    + word(principalAtomic.toString(16))
    + '0'.repeat(64 * 6);
}

const TEN_USDC = 10_000_000n; // usdcToAtomic(10)

function fundingParams(overrides: Record<string, unknown> = {}) {
  return {
    chain: 'base' as const,
    fundTxHash: TX,
    promiseContractAddress: PROMISE,
    expectedLender: LENDER,
    expectedBorrower: BORROWER,
    currency: 'usdc' as const,
    expectedAmountUsdc: 10,
    ...overrides,
  };
}

beforeEach(() => jest.clearAllMocks());

describe('THE BARE-TRANSFER BYPASS — the defect this verifier exists to close', () => {
  it('REFUSES a receipt carrying only a real lender → borrower USDC Transfer', async () => {
    // This receipt is precisely what `usdc.transfer(borrower, 10)` produces:
    // the right token, the right sender, the right recipient, the right amount,
    // 12 confirmations, status 1 — and no call to the promise contract at all.
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([transferLog(LENDER, BORROWER, TEN_USDC, 0)]),
    );
    const r = await verifyEvmPromiseFunding(fundingParams());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('promise_funded_event_not_found');
    // And it never even reached the struct read — nothing to read.
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('the SAME bare Transfer would have satisfied a from/to/value check — the control', async () => {
    // Proves the fixture above is a genuine, correctly-addressed Transfer and
    // that the refusal comes from the missing contract event, not from a
    // malformed log. Without this control, "refused" could mean "unparseable".
    const l = transferLog(LENDER, BORROWER, TEN_USDC, 0);
    const parsed = ERC20.parseLog({ topics: [...l.topics], data: l.data });
    expect(parsed?.name).toBe('Transfer');
    expect(String(parsed?.args.from).toLowerCase()).toBe(LENDER.toLowerCase());
    expect(String(parsed?.args.to).toLowerCase()).toBe(BORROWER.toLowerCase());
    expect(BigInt(parsed?.args.value)).toBe(TEN_USDC);
  });

  it('ACCEPTS the same transfer when the promise contract also emitted PromiseFunded', async () => {
    // The positive twin: identical Transfer, plus the contract's own event.
    // This is what a real `fundPromise()` tx looks like — the contract calls
    // transferFrom, THEN emits. Only the second one is evidence.
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([
        transferLog(LENDER, BORROWER, TEN_USDC, 0),
        log('PromiseFunded', [PROMISE_ID, LENDER, TEN_USDC], PROMISE, 1),
      ]),
    );
    mockCall.mockResolvedValue(promiseStructV2(BORROWER, LENDER, TEN_USDC));
    const r = await verifyEvmPromiseFunding(fundingParams());
    expect(r.ok).toBe(true);
    expect(r.onchainPromiseId).toBe(PROMISE_ID);
    expect(r.logIndex).toBe(1);
    expect(r.borrower).toBe(BORROWER.toLowerCase());
  });
});

describe('verifyEvmPromiseFunding — canonical event + struct binding', () => {
  it('confirms a real PVT funding via the PVT event variant', async () => {
    const principalWei = 50n * 10n ** 18n;
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PromiseFundedPVT', [PROMISE_ID, LENDER, principalWei], PROMISE, 3)]),
    );
    mockCall.mockResolvedValue(promiseStructV3(BORROWER, LENDER, principalWei));
    const r = await verifyEvmPromiseFunding(fundingParams({
      currency: 'pvt',
      expectedAmountUsdc: undefined,
      expectedAmountPvtWei: principalWei,
    }));
    expect(r.ok).toBe(true);
    expect(r.logIndex).toBe(3);
  });

  it('refuses the USDC event when the promise is PVT-denominated (variant is not interchangeable)', async () => {
    const principalWei = 50n * 10n ** 18n;
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PromiseFunded', [PROMISE_ID, LENDER, principalWei], PROMISE, 0)]),
    );
    const r = await verifyEvmPromiseFunding(fundingParams({
      currency: 'pvt',
      expectedAmountUsdc: undefined,
      expectedAmountPvtWei: principalWei,
    }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('promise_funded_event_not_found');
  });

  it('refuses a PromiseFunded emitted by a DIFFERENT contract', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PromiseFunded', [PROMISE_ID, LENDER, TEN_USDC], OTHER_CONTRACT, 0)]),
    );
    const r = await verifyEvmPromiseFunding(fundingParams());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('promise_funded_event_not_found');
  });

  it('refuses when the event names a different lender', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PromiseFunded', [PROMISE_ID, IMPOSTOR, TEN_USDC], PROMISE, 0)]),
    );
    const r = await verifyEvmPromiseFunding(fundingParams());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('promise_funded_lender_mismatch');
  });

  it('refuses when the event principal does not match the agreed principal', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PromiseFunded', [PROMISE_ID, LENDER, TEN_USDC - 1n], PROMISE, 0)]),
    );
    const r = await verifyEvmPromiseFunding(fundingParams());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('promise_funded_amount_mismatch');
  });

  it('THE STRUCT BINDING: refuses a real funding of a promise that pays someone else', async () => {
    // The attack the event alone cannot see. The lender genuinely called
    // fundPromise() for the right amount — on THEIR OWN on-chain promise, whose
    // borrower is an accomplice. The event is real; the payee is wrong.
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PromiseFunded', [OTHER_PROMISE_ID, LENDER, TEN_USDC], PROMISE, 0)]),
    );
    mockCall.mockResolvedValue(promiseStructV2(IMPOSTOR, LENDER, TEN_USDC));
    const r = await verifyEvmPromiseFunding(fundingParams());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('promise_borrower_mismatch');
  });

  it('refuses when the struct principal disagrees with the event principal', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PromiseFunded', [PROMISE_ID, LENDER, TEN_USDC], PROMISE, 0)]),
    );
    mockCall.mockResolvedValue(promiseStructV2(BORROWER, LENDER, TEN_USDC + 1n));
    const r = await verifyEvmPromiseFunding(fundingParams());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('promise_borrower_mismatch');
  });

  it('refuses when the struct lender is not the claiming wallet', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PromiseFunded', [PROMISE_ID, LENDER, TEN_USDC], PROMISE, 0)]),
    );
    mockCall.mockResolvedValue(promiseStructV2(BORROWER, IMPOSTOR, TEN_USDC));
    const r = await verifyEvmPromiseFunding(fundingParams());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('promise_borrower_mismatch');
  });

  it('fails closed when the struct read is unreadable', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PromiseFunded', [PROMISE_ID, LENDER, TEN_USDC], PROMISE, 0)]),
    );
    mockCall.mockResolvedValue('0x');
    const r = await verifyEvmPromiseFunding(fundingParams());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('promise_struct_unreadable');
  });

  it('fails closed when the struct eth_call throws', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PromiseFunded', [PROMISE_ID, LENDER, TEN_USDC], PROMISE, 0)]),
    );
    mockCall.mockRejectedValue(new Error('quorum not met'));
    const r = await verifyEvmPromiseFunding(fundingParams());
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('rpc_error');
  });

  it('selects by amount, not positionally, across a multi-funding transaction', async () => {
    // One tx funding three promises. The FIRST event is the wrong amount; a
    // positional reader would bind this row to it.
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([
        log('PromiseFunded', [OTHER_PROMISE_ID, LENDER, TEN_USDC * 3n], PROMISE, 0),
        log('PromiseFunded', [PROMISE_ID, LENDER, TEN_USDC], PROMISE, 1),
      ]),
    );
    mockCall.mockResolvedValue(promiseStructV2(BORROWER, LENDER, TEN_USDC));
    const r = await verifyEvmPromiseFunding(fundingParams());
    expect(r.ok).toBe(true);
    expect(r.onchainPromiseId).toBe(PROMISE_ID);
    expect(r.logIndex).toBe(1);
    // The struct read targeted the amount-matched id, not the first one.
    expect(String(mockCall.mock.calls[0][0].data)).toContain(PROMISE_ID.slice(2));
  });

  it('refuses a self-funded promise by ADDRESS, before any RPC', async () => {
    const r = await verifyEvmPromiseFunding(fundingParams({ expectedBorrower: LENDER }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('promise_self_funding_refused');
    expect(mockGetTransactionReceipt).not.toHaveBeenCalled();
  });

  it('refuses a zero / sub-atomic principal before any RPC', async () => {
    const zero = await verifyEvmPromiseFunding(fundingParams({ expectedAmountUsdc: 0 }));
    expect(zero.ok).toBe(false);
    expect(zero.reason).toBe('invalid_expected_amount');
    // 0.0000001 USDC rounds to 0 atomic units — it must not become "verified".
    const dust = await verifyEvmPromiseFunding(fundingParams({ expectedAmountUsdc: 0.0000001 }));
    expect(dust.ok).toBe(false);
    expect(dust.reason).toBe('invalid_expected_amount');
    expect(mockGetTransactionReceipt).not.toHaveBeenCalled();
  });

  it('refuses a failed transaction and a missing receipt', async () => {
    mockGetTransactionReceipt.mockResolvedValueOnce(
      receipt([log('PromiseFunded', [PROMISE_ID, LENDER, TEN_USDC], PROMISE, 0)], { status: 0 }),
    );
    expect((await verifyEvmPromiseFunding(fundingParams())).reason).toBe('tx_failed');
    mockGetTransactionReceipt.mockResolvedValueOnce(null);
    expect((await verifyEvmPromiseFunding(fundingParams())).reason).toBe('tx_not_found');
  });

  it('refuses below the Base 12-confirmation economic finality floor', async () => {
    const finality = jest.requireMock('./economic-finality');
    finality.verifyBaseEconomicTransactionFinality.mockResolvedValueOnce({
      evidence: { blockNumber: 100, blockHash: `0x${'b'.repeat(64)}`, confirmations: 5 },
    });
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PromiseFunded', [PROMISE_ID, LENDER, TEN_USDC], PROMISE, 0)]),
    );
    const r = await verifyEvmPromiseFunding(fundingParams());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('insufficient_confirmations: 5/12');
  });

  it('refuses a matching event whose log identity is unusable', async () => {
    // A canonical event without an identity is not a canonical event: the
    // emitter and the promotion verifier both key exactly-once on it.
    const l = log('PromiseFunded', [PROMISE_ID, LENDER, TEN_USDC], PROMISE, 0) as Record<string, unknown>;
    delete l.index;
    mockGetTransactionReceipt.mockResolvedValue(receipt([l]));
    const r = await verifyEvmPromiseFunding(fundingParams());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('promise_funded_log_identity_unavailable');
  });

  it('rejects malformed inputs by name before any RPC', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ fundTxHash: '0xdeadbeef' }, 'invalid_tx_hash_format'],
      [{ promiseContractAddress: 'not-an-address' }, 'invalid_contract_address'],
      [{ expectedLender: 'nope' }, 'invalid_lender_address'],
      [{ expectedBorrower: 'nope' }, 'invalid_borrower_address'],
      [{ chain: 'solana' }, 'unknown_chain'],
    ];
    for (const [override, reason] of cases) {
      const r = await verifyEvmPromiseFunding(fundingParams(override) as never);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe(reason);
    }
    expect(mockGetTransactionReceipt).not.toHaveBeenCalled();
  });
});

const ELEVEN_USDC_NET = 10_972_500n; // net-to-lender on a 11 USDC repay, 0.25% fee

function settleParams(overrides: Record<string, unknown> = {}) {
  return {
    chain: 'base' as const,
    settleTxHash: TX,
    promiseContractAddress: PROMISE,
    expectedLender: LENDER,
    currency: 'usdc' as const,
    expectedNetToLenderUsdc: 10.9725,
    ...overrides,
  };
}

describe('verifyEvmPromiseSettlement — the exit leg carries the same bar', () => {
  it('REFUSES a receipt carrying only a real borrower → lender USDC Transfer', async () => {
    // `usdc.transfer(lender, net)`: the promise stays Funded on chain, still
    // defaultable, its fee never paid — and the old bar marked the row settled.
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([transferLog(BORROWER, LENDER, ELEVEN_USDC_NET, 0)]),
    );
    const r = await verifyEvmPromiseSettlement(settleParams());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('promise_settled_event_not_found');
  });

  it('accepts the contract event and returns the canonical log identity', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([
        transferLog(BORROWER, LENDER, ELEVEN_USDC_NET, 0),
        log('PromiseSettled', [PROMISE_ID, LENDER, ELEVEN_USDC_NET, 27_500n], PROMISE, 2),
      ]),
    );
    const r = await verifyEvmPromiseSettlement(settleParams({ expectedOnchainPromiseId: PROMISE_ID }));
    expect(r.ok).toBe(true);
    expect(r.onchainPromiseId).toBe(PROMISE_ID);
    expect(r.logIndex).toBe(2);
  });

  it('THE ID BINDING: refuses a real settlement of a DIFFERENT promise', async () => {
    // Same lender, same net amount, same contract — a different loan. Without
    // the id binding this closes the wrong row and pays a PE for it.
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PromiseSettled', [OTHER_PROMISE_ID, LENDER, ELEVEN_USDC_NET, 27_500n], PROMISE, 0)]),
    );
    const r = await verifyEvmPromiseSettlement(settleParams({ expectedOnchainPromiseId: PROMISE_ID }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('promise_settled_id_mismatch');
  });

  it('accepts an unbound legacy row on lender + amount + contract alone', async () => {
    // Rows funded before pinned the id. Stated rather than silently
    // relaxed: this arm is weaker, and it is reachable only for those rows.
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PromiseSettled', [OTHER_PROMISE_ID, LENDER, ELEVEN_USDC_NET, 27_500n], PROMISE, 0)]),
    );
    const r = await verifyEvmPromiseSettlement(settleParams());
    expect(r.ok).toBe(true);
  });

  it('refuses a wrong lender, a wrong net amount, and a foreign contract by name', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PromiseSettled', [PROMISE_ID, IMPOSTOR, ELEVEN_USDC_NET, 27_500n], PROMISE, 0)]),
    );
    expect((await verifyEvmPromiseSettlement(settleParams())).reason)
      .toBe('promise_settled_lender_mismatch');

    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PromiseSettled', [PROMISE_ID, LENDER, ELEVEN_USDC_NET - 1n, 27_500n], PROMISE, 0)]),
    );
    expect((await verifyEvmPromiseSettlement(settleParams())).reason)
      .toBe('promise_settled_amount_mismatch');

    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PromiseSettled', [PROMISE_ID, LENDER, ELEVEN_USDC_NET, 27_500n], OTHER_CONTRACT, 0)]),
    );
    expect((await verifyEvmPromiseSettlement(settleParams())).reason)
      .toBe('promise_settled_event_not_found');
  });

  it('does not accept the USDC variant for a PVT promise, or vice versa', async () => {
    const netWei = 50n * 10n ** 18n;
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PromiseSettled', [PROMISE_ID, LENDER, netWei, 0n], PROMISE, 0)]),
    );
    const pvt = await verifyEvmPromiseSettlement(settleParams({
      currency: 'pvt', expectedNetToLenderUsdc: undefined, expectedNetToLenderPvtWei: netWei,
    }));
    expect(pvt.reason).toBe('promise_settled_event_not_found');

    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PromiseSettledPVT', [PROMISE_ID, LENDER, netWei, 0n], PROMISE, 0)]),
    );
    const ok = await verifyEvmPromiseSettlement(settleParams({
      currency: 'pvt', expectedNetToLenderUsdc: undefined, expectedNetToLenderPvtWei: netWei,
    }));
    expect(ok.ok).toBe(true);
  });

  it('refuses a zero net amount and a malformed bound id before any RPC', async () => {
    expect((await verifyEvmPromiseSettlement(settleParams({ expectedNetToLenderUsdc: 0 }))).reason)
      .toBe('invalid_expected_amount');
    expect((await verifyEvmPromiseSettlement(settleParams({ expectedOnchainPromiseId: '0xdead' }))).reason)
      .toBe('invalid_onchain_promise_id');
    expect(mockGetTransactionReceipt).not.toHaveBeenCalled();
  });

  it('refuses below the Base 12-confirmation floor', async () => {
    const finality = jest.requireMock('./economic-finality');
    finality.verifyBaseEconomicTransactionFinality.mockResolvedValueOnce({
      evidence: { blockNumber: 100, blockHash: `0x${'b'.repeat(64)}`, confirmations: 3 },
    });
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([log('PromiseSettled', [PROMISE_ID, LENDER, ELEVEN_USDC_NET, 27_500n], PROMISE, 0)]),
    );
    expect((await verifyEvmPromiseSettlement(settleParams())).reason)
      .toBe('insufficient_confirmations: 3/12');
  });
});

describe('pure helpers', () => {
  it('parsePromiseSettledEvents keeps identity and ignores the funding variants', () => {
    const r = parsePromiseSettledEvents(
      [
        log('PromiseFunded', [PROMISE_ID, LENDER, TEN_USDC], PROMISE, 0),
        log('PromiseSettled', [PROMISE_ID, LENDER, ELEVEN_USDC_NET, 27_500n], PROMISE, 5),
      ],
      PROMISE,
      'PromiseSettled',
    );
    expect(r.events).toEqual([{
      promiseId: PROMISE_ID,
      lender: LENDER.toLowerCase(),
      netAmountAtomic: ELEVEN_USDC_NET,
      logIndex: 5,
    }]);
    expect(r.sawEventWithoutIndex).toBe(false);
  });

  it('parsePromiseFundedEvents keeps log identity and reports an index-less event', () => {
    const withIndex = log('PromiseFunded', [PROMISE_ID, LENDER, TEN_USDC], PROMISE, 4);
    const withoutIndex = log('PromiseFunded', [OTHER_PROMISE_ID, LENDER, TEN_USDC], PROMISE, 0) as Record<string, unknown>;
    delete withoutIndex.index;
    const r = parsePromiseFundedEvents(
      [withIndex, withoutIndex as never, transferLog(LENDER, BORROWER, TEN_USDC, 9)],
      PROMISE,
      'PromiseFunded',
    );
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toEqual({
      promiseId: PROMISE_ID,
      lender: LENDER.toLowerCase(),
      principalAtomic: TEN_USDC,
      logIndex: 4,
    });
    expect(r.sawEventWithoutIndex).toBe(true);
  });

  it('decodePromiseStructPrefix reads words 0..2 identically for the V2 and V3 shapes', () => {
    const v2 = decodePromiseStructPrefix(promiseStructV2(BORROWER, LENDER, TEN_USDC));
    const v3 = decodePromiseStructPrefix(promiseStructV3(BORROWER, LENDER, TEN_USDC));
    expect(v2).toEqual({
      borrower: BORROWER.toLowerCase(),
      lender: LENDER.toLowerCase(),
      principalAtomic: TEN_USDC,
    });
    // The version-agnostic claim, exercised rather than asserted in prose.
    expect(v3).toEqual(v2);
  });

  it('decodePromiseStructPrefix returns null on a short or non-hex return', () => {
    expect(decodePromiseStructPrefix('0x')).toBeNull();
    expect(decodePromiseStructPrefix('0x' + '0'.repeat(64 * 2))).toBeNull();
    expect(decodePromiseStructPrefix('0x' + 'zz'.repeat(96))).toBeNull();
  });
});

// ============================================================================
// verifyEvmPromiseDefault (the third leg alongside fund/settle)
// ============================================================================

function defaultLog(name: 'PromiseDefaulted' | 'PromiseDefaultedPVT', args: unknown[], address = PROMISE, index = 0) {
  const { topics, data } = IFACE.encodeEventLog(name, args);
  return { address, topics, data, index };
}

function defaultParams(overrides: Record<string, unknown> = {}) {
  return {
    chain: 'base' as const,
    defaultTxHash: TX,
    promiseContractAddress: PROMISE,
    currency: 'usdc' as const,
    expectedOnchainPromiseId: PROMISE_ID,
    expectedBorrower: BORROWER,
    expectedLender: LENDER,
    ...overrides,
  };
}

describe('verifyEvmPromiseDefault — the contract\'s own PromiseDefaulted event', () => {
  it('accepts a real PromiseDefaulted for this id, borrower and lender', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([defaultLog('PromiseDefaulted', [PROMISE_ID, BORROWER, LENDER, TEN_USDC], PROMISE, 2)]),
    );
    const v = await verifyEvmPromiseDefault(defaultParams());
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.onchainPromiseId).toBe(PROMISE_ID.toLowerCase());
      expect(v.logIndex).toBe(2);
    }
  });

  it('accepts the PVT variant', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([defaultLog('PromiseDefaultedPVT', [PROMISE_ID, BORROWER, LENDER, 5n * 10n ** 18n], PROMISE, 1)]),
    );
    const v = await verifyEvmPromiseDefault(defaultParams({ currency: 'pvt' }));
    expect(v.ok).toBe(true);
  });

  // RED: a default event from ANOTHER contract address is not the promise contract's.
  it('REFUSES a PromiseDefaulted emitted by a different contract', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([defaultLog('PromiseDefaulted', [PROMISE_ID, BORROWER, LENDER, TEN_USDC], OTHER_CONTRACT, 0)]),
    );
    const v = await verifyEvmPromiseDefault(defaultParams());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('promise_defaulted_event_not_found');
  });

  // RED: a default of a DIFFERENT promise id cannot mark this row.
  it('REFUSES when the on-chain promise id does not match', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([defaultLog('PromiseDefaulted', [OTHER_PROMISE_ID, BORROWER, LENDER, TEN_USDC], PROMISE, 0)]),
    );
    const v = await verifyEvmPromiseDefault(defaultParams());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('promise_defaulted_id_mismatch');
  });

  // RED: the parties on the event must match the row's borrower + lender.
  it('REFUSES when the event names a different borrower/lender', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt([defaultLog('PromiseDefaulted', [PROMISE_ID, IMPOSTOR, LENDER, TEN_USDC], PROMISE, 0)]),
    );
    const v = await verifyEvmPromiseDefault(defaultParams());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('promise_defaulted_party_mismatch');
  });

  it('refuses a failed transaction and a missing receipt', async () => {
    mockGetTransactionReceipt.mockResolvedValueOnce(
      receipt([defaultLog('PromiseDefaulted', [PROMISE_ID, BORROWER, LENDER, TEN_USDC], PROMISE, 0)], { status: 0 }),
    );
    expect((await verifyEvmPromiseDefault(defaultParams())).ok).toBe(false);
    mockGetTransactionReceipt.mockResolvedValueOnce(null);
    expect((await verifyEvmPromiseDefault(defaultParams())).ok).toBe(false);
  });

  it('refuses an invalid on-chain promise id argument', async () => {
    const v = await verifyEvmPromiseDefault(defaultParams({ expectedOnchainPromiseId: '0xnothex' }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('invalid_onchain_promise_id');
  });

  it('parsePromiseDefaultedEvents ignores logs from other addresses and keeps the index', () => {
    const good = defaultLog('PromiseDefaulted', [PROMISE_ID, BORROWER, LENDER, TEN_USDC], PROMISE, 4);
    const foreign = defaultLog('PromiseDefaulted', [PROMISE_ID, BORROWER, LENDER, TEN_USDC], OTHER_CONTRACT, 5);
    const { events } = parsePromiseDefaultedEvents([good, foreign], PROMISE, 'PromiseDefaulted');
    expect(events).toHaveLength(1);
    expect(events[0].logIndex).toBe(4);
    expect(events[0].promiseId).toBe(PROMISE_ID.toLowerCase());
    expect(events[0].borrower).toBe(BORROWER.toLowerCase());
    expect(events[0].lender).toBe(LENDER.toLowerCase());
  });
});
