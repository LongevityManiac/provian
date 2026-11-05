/**
 * tx-verifier burn tests — verifyEvmPvtBurn (work package burn substrate).
 *
 * verifyEvmPvtBurn is the demand-side counterpart to verifyEvmPvtTransfer: it
 * proves that `expectedFrom` burned exactly `expectedAmountWei` PVT, by matching
 * a `Transfer(expectedFrom, 0x0, amount)` log emitted by the configured PVT
 * token contract. The destination is PINNED to the zero address and is never
 * caller-supplied, so a transfer to any real address — including a self-send
 * back to `expectedFrom` can never pass as a burn. That property is what the
 * work package burn products (name registry, vouch, pledges, subscriptions, standing
 * export) rest on, so it carries an explicit negative control.
 *
 * controls in this file (each proven RED by a source mutation, recorded in
 * the landing commit):
 * 1. "rejects a Transfer to a REAL address as a non-burn" mutate the
 * `zeroToTopic` match (or drop the topics[2] check) and this goes RED.
 * 2. "rejects the wrong burned amount" mutate the `amount !== expected`
 * guard and this goes RED.
 * 3. "fail-closes when PVT-principal is disabled" mutate the null-address
 * early return and this goes RED.
 * 4. the retired predecessor kernel verifies ONLY at or below the migration
 * snapshot block — mutate the `maxBlock` filter and "refuses a predecessor burn one
 * block after the cutoff" goes RED.
 *
 * The token set is the REAL `pvt-principal-config` (enabled through its one env flag),
 * never a test copy, so these tests bind to the addresses and cutoff production reads.
 */

import { ethers } from 'ethers';
import { verifyEvmPvtBurn } from './tx-verifier';
import {
  getAcceptedPvtBurnTokensForChain,
  getPvtAddressForChain,
  PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK,
} from '../agent-bank/pvt-principal-config';

const mockGetTransactionReceipt = jest.fn();
let mockExactConfirmations = 12;
let mockEvidenceBlock = 100;
/** when set, the exact-finality read throws this instead of answering. */
let mockExactError: Error | null = null;

const mockInclusion = jest.fn();
jest.mock('./economic-finality', () => ({
  verifyBaseTransactionInclusion: (...args: unknown[]) => mockInclusion(...args),
  verifyBaseEconomicTransactionFinality: jest.fn(async () => {
    if (mockExactError) throw mockExactError;
    return { evidence: {
      blockNumber: mockEvidenceBlock,
      blockHash: `0x${'b'.repeat(64)}`,
      confirmations: mockExactConfirmations,
    } };
  }),
}));

jest.mock('./rpc-provider', () => ({
  getVerifierProvider: jest.fn(() => ({
    getTransactionReceipt: (...args: unknown[]) => mockGetTransactionReceipt(...args),
  })),
}));

// PVT-principal on, the way production turns it on. Unset = the pre-flip fail-closed state.
process.env.ENABLE_PVT_PRINCIPAL = 'true';

const BASE = 8453;
const VALID_HASH = '0x' + 'a'.repeat(64);
const AGENT = '0x1111111111111111111111111111111111111111';
/** The live (successor) kernel, read from the real config. */
const PVT = getPvtAddressForChain('base')!;
/** The retired kernel. */
const PREDECESSOR = '0x4bf02d5c9bc4306c38603ef2aa164f2f2273bcd7';
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function topic(address: string): string {
  return '0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

/** A receipt whose logs include a PVT burn (Transfer from → 0x0). */
function burnReceipt(
  opts: {
    from?: string;
    to?: string;
    amountWei?: bigint;
    logAddress?: string;
    blockNumber?: number;
  } = {},
) {
  const from = opts.from ?? AGENT;
  const to = opts.to ?? ethers.ZeroAddress;
  const amountWei = opts.amountWei ?? ethers.parseUnits('10', 18);
  const logAddress = opts.logAddress ?? PVT;
  return {
    status: 1,
    blockNumber: opts.blockNumber ?? 100,
    blockHash: `0x${'b'.repeat(64)}`,
    confirmations: async () => 12,
    logs: [
      {
        address: logAddress,
        topics: [TRANSFER_TOPIC, topic(from), topic(to)],
        data: ethers.toBeHex(amountWei, 32),
      },
    ],
  };
}

describe('verifyEvmPvtBurn (work package burn substrate)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExactConfirmations = 12;
    mockEvidenceBlock = 100;
    mockExactError = null;
    process.env.ENABLE_PVT_PRINCIPAL = 'true';
  });

  it('binds to the real token set: the successor live, the predecessor bounded by the snapshot block', () => {
    expect(PVT).toBe('0x8811441914381143b9408c5c32247367f86f173a');
    expect(getAcceptedPvtBurnTokensForChain('base')).toEqual([
      { address: PVT, maxBlock: null },
      { address: PREDECESSOR, maxBlock: PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK },
    ]);
    // Burns only: every other chain has no PVT, and a transfer never sees the predecessor.
    expect(getAcceptedPvtBurnTokensForChain('arbitrum')).toEqual([]);
    expect(getPvtAddressForChain('base')).toBe(PVT);
  });

  it('accepts a genuine PVT burn (Transfer from → 0x0, exact amount, right contract)', async () => {
    mockGetTransactionReceipt.mockResolvedValue(burnReceipt());
    const r = await verifyEvmPvtBurn({
      chainId: BASE,
      txHash: VALID_HASH,
      expectedFrom: AGENT,
      expectedAmountWei: ethers.parseUnits('10', 18),
    });
    expect(r.ok).toBe(true);
    expect(r.confirmations).toBe(12);
  });

  // ---- CONTROL 1: a burn must go to 0x0, never a real address ---------
  it('REJECTS a Transfer to a REAL address as a non-burn (self-send is not a burn)', async () => {
    // Same sender, same amount, same contract — but the destination is a real
    // address (a plain transfer / self-send), NOT the zero address.
    mockGetTransactionReceipt.mockResolvedValue(
      burnReceipt({ to: '0x2222222222222222222222222222222222222222' }),
    );
    const r = await verifyEvmPvtBurn({
      chainId: BASE,
      txHash: VALID_HASH,
      expectedFrom: AGENT,
      expectedAmountWei: ethers.parseUnits('10', 18),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_matching_pvt_burn_log');
  });

  it('also rejects a self-send back to expectedFrom (from == to != 0x0)', async () => {
    mockGetTransactionReceipt.mockResolvedValue(burnReceipt({ to: AGENT }));
    const r = await verifyEvmPvtBurn({
      chainId: BASE,
      txHash: VALID_HASH,
      expectedFrom: AGENT,
      expectedAmountWei: ethers.parseUnits('10', 18),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_matching_pvt_burn_log');
  });

  // ---- CONTROL 2: exact amount --------------------------------------
  it('rejects the wrong burned amount', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      burnReceipt({ amountWei: ethers.parseUnits('9', 18) }),
    );
    const r = await verifyEvmPvtBurn({
      chainId: BASE,
      txHash: VALID_HASH,
      expectedFrom: AGENT,
      expectedAmountWei: ethers.parseUnits('10', 18),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_matching_pvt_burn_log');
  });

  it('rejects a burn log emitted by the WRONG contract (not the PVT token)', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      burnReceipt({ logAddress: '0x9999999999999999999999999999999999999999' }),
    );
    const r = await verifyEvmPvtBurn({
      chainId: BASE,
      txHash: VALID_HASH,
      expectedFrom: AGENT,
      expectedAmountWei: ethers.parseUnits('10', 18),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_matching_pvt_burn_log');
  });

  it('rejects a burn attributed to the wrong sender', async () => {
    mockGetTransactionReceipt.mockResolvedValue(burnReceipt({ from: AGENT }));
    const r = await verifyEvmPvtBurn({
      chainId: BASE,
      txHash: VALID_HASH,
      expectedFrom: '0x3333333333333333333333333333333333333333',
      expectedAmountWei: ethers.parseUnits('10', 18),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_matching_pvt_burn_log');
  });

  // ---- CONTROL 3: fail-closed when PVT-principal is off --------------
  it('fail-closes when PVT-principal is disabled (no configured PVT address)', async () => {
    delete process.env.ENABLE_PVT_PRINCIPAL;
    mockGetTransactionReceipt.mockResolvedValue(burnReceipt());
    const r = await verifyEvmPvtBurn({
      chainId: BASE,
      txHash: VALID_HASH,
      expectedFrom: AGENT,
      expectedAmountWei: ethers.parseUnits('10', 18),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('pvt_principal_disabled_or_unconfigured_chain');
    // Fail-closed BEFORE any RPC read.
    expect(mockGetTransactionReceipt).not.toHaveBeenCalled();
  });

  it('rejects a failed transaction (status !== 1)', async () => {
    mockGetTransactionReceipt.mockResolvedValue(burnReceipt({}));
    mockGetTransactionReceipt.mockResolvedValueOnce({ ...burnReceipt(), status: 0 });
    const r = await verifyEvmPvtBurn({
      chainId: BASE,
      txHash: VALID_HASH,
      expectedFrom: AGENT,
      expectedAmountWei: ethers.parseUnits('10', 18),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('tx_failed');
  });

  it('rejects an unconfirmed transaction (below the Base finality floor)', async () => {
    mockExactConfirmations = 3;
    mockGetTransactionReceipt.mockResolvedValue(burnReceipt());
    const r = await verifyEvmPvtBurn({
      chainId: BASE,
      txHash: VALID_HASH,
      expectedFrom: AGENT,
      expectedAmountWei: ethers.parseUnits('10', 18),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/insufficient_confirmations/);
  });

  describe('an RPC failure while counting confirmations is never "0 confirmations"', () => {
    const params = {
      chainId: BASE,
      txHash: VALID_HASH,
      expectedFrom: AGENT,
      expectedAmountWei: ethers.parseUnits('10', 18),
    };

    it('RED: a leg failure / disagreement in the finality read is surfaced as rpc_error (was insufficient_confirmations: 0/12)', async () => {
      mockGetTransactionReceipt.mockResolvedValue(burnReceipt());
      for (const message of [
        'economic_finality_rpc_disagreement:head',
        'economic_finality_receipt_pending',
        'getaddrinfo ENOTFOUND mainnet.base.org',
        'base_exact_finality_receipt_mismatch',
      ]) {
        mockExactError = new Error(message);
        const r = await verifyEvmPvtBurn(params);
        expect(r.ok).toBe(false); // still refused: nothing that credits a burn loosens
        expect(r.reason).toBe(`rpc_error: ${message}`);
        expect(r.reason).not.toMatch(/insufficient_confirmations/);
      }
    });

    it('the agreed-but-shallow refusal is a real count, still insufficient_confirmations', async () => {
      mockGetTransactionReceipt.mockResolvedValue(burnReceipt());
      mockExactError = new Error('economic_finality_confirmations_pending:5/12');
      const r = await verifyEvmPvtBurn(params);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('insufficient_confirmations: 5/12');
      expect(r.confirmations).toBe(5);
    });
  });

  it('rejects a not-found transaction', async () => {
    mockGetTransactionReceipt.mockResolvedValue(null);
    const r = await verifyEvmPvtBurn({
      chainId: BASE,
      txHash: VALID_HASH,
      expectedFrom: AGENT,
      expectedAmountWei: ethers.parseUnits('10', 18),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('tx_not_found');
  });

  it('rejects malformed inputs (bad hash, bad address, non-positive amount)', async () => {
    const bad = [
      { txHash: '0xnothex', expectedFrom: AGENT, expectedAmountWei: 10n, reason: 'invalid_tx_hash_format' },
      { txHash: VALID_HASH, expectedFrom: 'not-an-address', expectedAmountWei: 10n, reason: 'invalid_address_format' },
      { txHash: VALID_HASH, expectedFrom: AGENT, expectedAmountWei: 0n, reason: 'invalid_expected_amount' },
    ];
    for (const c of bad) {
      const r = await verifyEvmPvtBurn({
        chainId: BASE,
        txHash: c.txHash,
        expectedFrom: c.expectedFrom,
        expectedAmountWei: c.expectedAmountWei,
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe(c.reason);
    }
    expect(mockGetTransactionReceipt).not.toHaveBeenCalled();
  });

  // ---- the retired predecessor kernel, bounded by the migration snapshot --------
  describe(' predecessor burns', () => {
    const params = { chainId: BASE, txHash: VALID_HASH, expectedFrom: AGENT, expectedAmountWei: ethers.parseUnits('10', 18) };

    it('a predecessor burn AT the snapshot block stays verifiable (its PVT was not carried)', async () => {
      mockEvidenceBlock = PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK;
      mockGetTransactionReceipt.mockResolvedValue(burnReceipt({ logAddress: PREDECESSOR, blockNumber: PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK }));
      const r = await verifyEvmPvtBurn(params);
      expect(r.ok).toBe(true);
      // The matched kernel is named, so the burn row can label a predecessor burn.
      expect(r.tokenAddress).toBe(PREDECESSOR);
    });

    it('RED: a predecessor burn one block AFTER the snapshot is refused (its PVT was carried)', async () => {
      mockEvidenceBlock = PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK + 1;
      mockGetTransactionReceipt.mockResolvedValue(burnReceipt({ logAddress: PREDECESSOR, blockNumber: PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK + 1 }));
      const r = await verifyEvmPvtBurn(params);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('no_matching_pvt_burn_log');
    });

    it('RED: the same late predecessor burn is refused at inclusion too', async () => {
      const receipt = burnReceipt({ logAddress: PREDECESSOR, blockNumber: PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK + 1 });
      mockInclusion.mockResolvedValue({ receipt, blockNumber: PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK + 1, blockHash: `0x${'b'.repeat(64)}` });
      const r = await verifyEvmPvtBurn({ ...params, acceptance: 'inclusion' });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('no_matching_pvt_burn_log');
    });

    it('a successor burn verifies at any block, including after the cutoff', async () => {
      mockEvidenceBlock = PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK + 1_000_000;
      mockGetTransactionReceipt.mockResolvedValue(burnReceipt({ logAddress: PVT, blockNumber: PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK + 1_000_000 }));
      expect((await verifyEvmPvtBurn(params)).ok).toBe(true);
    });
  });

  // ---- acceptance at one-block inclusion --------------------
  describe("acceptance: 'inclusion' ", () => {
    const inclusionParams = {
      chainId: BASE,
      txHash: VALID_HASH,
      expectedFrom: AGENT,
      expectedAmountWei: ethers.parseUnits('10', 18),
      acceptance: 'inclusion' as const,
    };

    it('accepts a mined burn from the two-leg inclusion read, at one confirmation, without the finality path', async () => {
      mockInclusion.mockResolvedValue({ receipt: burnReceipt(), blockNumber: 100, blockHash: `0x${'b'.repeat(64)}` });
      mockExactConfirmations = 1; // the finality path would refuse — it must not be asked
      const r = await verifyEvmPvtBurn(inclusionParams);
      expect(r).toEqual({ ok: true, blockNumber: 100, blockHash: `0x${'b'.repeat(64)}`, confirmations: 1, tokenAddress: PVT });
      expect(mockGetTransactionReceipt).not.toHaveBeenCalled();
    });

    it('RED: a pending / mempool / replaced-nonce burn (no receipt on either leg) is refused', async () => {
      mockInclusion.mockRejectedValue(new Error('economic_inclusion_receipt_absent'));
      const r = await verifyEvmPvtBurn(inclusionParams);
      expect(r).toEqual({ ok: false, reason: 'tx_not_found' });
    });

    it('RED: one leg disagreeing (or lagging) is refused, retryable', async () => {
      mockInclusion.mockRejectedValue(new Error('economic_finality_rpc_disagreement:receipt'));
      const r = await verifyEvmPvtBurn(inclusionParams);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/^rpc_error: economic_finality_rpc_disagreement:receipt/);
    });

    it('RED: a reverted burn is refused', async () => {
      mockInclusion.mockRejectedValue(new Error('economic_finality_transaction_failed'));
      expect(await verifyEvmPvtBurn(inclusionParams)).toEqual({ ok: false, reason: 'tx_failed' });
    });

    it('RED: inclusion still demands the exact burn log (a transfer to a real address is refused)', async () => {
      mockInclusion.mockResolvedValue({ receipt: burnReceipt({ to: AGENT }), blockNumber: 100, blockHash: `0x${'b'.repeat(64)}` });
      const r = await verifyEvmPvtBurn(inclusionParams);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('no_matching_pvt_burn_log');
    });

    it('the default acceptance is still 12-block finality (11 confirmations refused)', async () => {
      mockGetTransactionReceipt.mockResolvedValue(burnReceipt());
      mockExactConfirmations = 11;
      const r = await verifyEvmPvtBurn({ ...inclusionParams, acceptance: undefined });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('insufficient_confirmations: 11/12');
      expect(mockInclusion).not.toHaveBeenCalled();
    });
  });
});
