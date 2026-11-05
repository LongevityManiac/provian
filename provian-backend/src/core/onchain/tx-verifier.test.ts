/**
 * tx-verifier tests - verifyEvmTxFrom (Fix F1).
 *
 * The agent-wallet swap/record handler previously called verifyEvmContractCall
 * with the wallet as BOTH expectedContract and expectedFrom, then accepted
 * `tx_to_mismatch` as ok. Because verifyEvmContractCall checks `to` BEFORE
 * `from`, accepting tx_to_mismatch silently discarded the sender check - any
 * successful Base tx could be claimed as the wallet's swap. verifyEvmTxFrom
 * verifies the sender directly so the sender check is load-bearing.
 */

import { ethers } from 'ethers';
import {
  verifyEvmTxFrom,
  verifyTransfer,
  verifyEvmNativeTransfer,
  verifyEvmBondPosted,
  verifyEvmBondRenewed,
  verifyEvmBondWithdrawn,
  verifyOnchainEscrowFunding,
  parseEscrowFundedEvents,
  decodeEscrowStructPrefix,
} from './tx-verifier';

const mockGetTransactionReceipt = jest.fn();
const mockGetTransaction = jest.fn();
const mockCall = jest.fn();
let mockExactConfirmations = 12;

jest.mock('./economic-finality', () => ({
  verifyBaseEconomicTransactionFinality: jest.fn(async () => ({
    evidence: {
      blockNumber: 100,
      blockHash: `0x${'b'.repeat(64)}`,
      confirmations: mockExactConfirmations,
    },
  })),
}));

// Verifier reads route through the quorum-2 getVerifierProvider (NOT the quorum-1
// getChainProvider used for general reads). The mock provider stands in for the
// FallbackProvider; a rejected read here simulates quorum-2 failing closed
// (single-provider outage or the two endpoints disagreeing).
jest.mock('./rpc-provider', () => ({
  getVerifierProvider: jest.fn(() => ({
    getTransactionReceipt: (...args: unknown[]) => mockGetTransactionReceipt(...args),
    getTransaction: (...args: unknown[]) => mockGetTransaction(...args),
    call: (...args: unknown[]) => mockCall(...args),
  })),
}));

const VALID_HASH = '0x' + 'a'.repeat(64);
const WALLET = '0x1111111111111111111111111111111111111111';
const ROUTER = '0x2222222222222222222222222222222222222222';

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    status: 1,
    from: WALLET,
    to: ROUTER, // a DEX router, NOT the wallet - the realistic swap shape
    blockNumber: 100,
    confirmations: async () => 12,
    ...overrides,
  };
}

describe('verifyEvmTxFrom (Fix F1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExactConfirmations = 12;
  });

  it('accepts a tx sent FROM the expected wallet even when `to` is a third-party router', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt());
    const r = await verifyEvmTxFrom({ chainId: 8453, txHash: VALID_HASH, expectedFrom: WALLET });
    expect(r.ok).toBe(true);
  });

  it('rejects a tx NOT sent from the expected wallet (the check the old ordering discarded)', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt({ from: ROUTER }));
    const r = await verifyEvmTxFrom({ chainId: 8453, txHash: VALID_HASH, expectedFrom: WALLET });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('tx_from_mismatch');
  });

  it('rejects a failed (reverted) tx', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt({ status: 0 }));
    const r = await verifyEvmTxFrom({ chainId: 8453, txHash: VALID_HASH, expectedFrom: WALLET });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('tx_failed');
  });

  it('requires at least 12 Base confirmations even when a caller asks for fewer', async () => {
    mockExactConfirmations = 11;
    mockGetTransactionReceipt.mockResolvedValue(receipt());
    const r = await verifyEvmTxFrom({
      chainId: 8453,
      txHash: VALID_HASH,
      expectedFrom: WALLET,
      minConfirmations: 1,
    });
    expect(r).toMatchObject({ ok: false });
    expect(r.reason).toMatch(/^insufficient_confirmations: 11\/12$/);
    expect(r.confirmations).toBe(11);
  });

  it('rejects a tx that does not exist', async () => {
    mockGetTransactionReceipt.mockResolvedValue(null);
    const r = await verifyEvmTxFrom({ chainId: 8453, txHash: VALID_HASH, expectedFrom: WALLET });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('tx_not_found');
  });

  it('rejects a malformed tx hash without hitting the provider', async () => {
    const r = await verifyEvmTxFrom({ chainId: 8453, txHash: '0xnothex', expectedFrom: WALLET });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_tx_hash_format');
    expect(mockGetTransactionReceipt).not.toHaveBeenCalled();
  });
});

describe('verifier fails closed when the quorum-2 read cannot be satisfied', () => {
  beforeEach(() => jest.clearAllMocks());

  // ethers' quorum-2 FallbackProvider throws "failed to meet quorum" when only one
  // endpoint answers (single-provider outage) or the two endpoints disagree (e.g. a
  // forged receipt from a compromised primary). Every verifier surfaces that as a
  // fail-closed `ok:false` with an rpc_error reason — NEVER a verified result.
  const quorumError = () =>
    mockGetTransactionReceipt.mockRejectedValue(new Error('failed to meet quorum'));

  it('verifyEvmTxFrom fails closed (no false verification) when quorum is not met', async () => {
    quorumError();
    const r = await verifyEvmTxFrom({ chainId: 8453, txHash: VALID_HASH, expectedFrom: WALLET });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^rpc_error:/);
  });

  it('verifyTransfer (native) fails closed when quorum is not met', async () => {
    mockGetTransaction.mockRejectedValue(new Error('failed to meet quorum'));
    mockGetTransactionReceipt.mockRejectedValue(new Error('failed to meet quorum'));
    const r = await verifyEvmNativeTransfer({
      chainId: 8453,
      txHash: VALID_HASH,
      expectedFrom: WALLET,
      expectedTo: ROUTER,
      expectedAmountWei: 1n,
    });
    expect(r.ok).toBe(false);
  });

  it('verifyEvmBondPosted fails closed when quorum is not met', async () => {
    quorumError();
    const r = await verifyEvmBondPosted({
      chainId: 8453,
      txHash: VALID_HASH,
      bondPoolAddress: ROUTER,
      expectedAgent: WALLET,
      expectedAutonomyLevel: 2,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^rpc_error:/);
  });
});

describe('verifyTransfer dispatch — USDT (slice 1b)', () => {
  beforeEach(() => jest.clearAllMocks());

  const USDT_BASE = '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2';
  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const addrTopic = (a: string) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

  function usdtReceipt(from: string, to: string, atomic: bigint) {
    return receipt({
      logs: [
        {
          address: USDT_BASE,
          topics: [TRANSFER_TOPIC, addrTopic(from), addrTopic(to)],
          data: '0x' + atomic.toString(16),
        },
      ],
    });
  }

  it('verifies a USDT transfer from+to+amount via verifyTransfer(currency: usdt)', async () => {
    mockGetTransactionReceipt.mockResolvedValue(usdtReceipt(WALLET, ROUTER, 1_000_000n)); // 1 USDT
    const r = await verifyTransfer({
      chain: 'base',
      txHash: VALID_HASH,
      expectedFrom: WALLET,
      expectedTo: ROUTER,
      currency: 'usdt',
      expectedAmountUsdt: 1,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects when the on-chain USDT amount does not match', async () => {
    mockGetTransactionReceipt.mockResolvedValue(usdtReceipt(WALLET, ROUTER, 2_000_000n)); // 2 USDT on-chain
    const r = await verifyTransfer({
      chain: 'base', txHash: VALID_HASH, expectedFrom: WALLET, expectedTo: ROUTER,
      currency: 'usdt', expectedAmountUsdt: 1, // expected 1
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_matching_transfer_log');
  });

  it('requires expectedAmountUsdt for the usdt branch', async () => {
    const r = await verifyTransfer({
      chain: 'base', txHash: VALID_HASH, expectedFrom: WALLET, expectedTo: ROUTER, currency: 'usdt',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('missing_expected_amount_usdt');
  });
});

describe('verifyEvmNativeTransfer (FIX B - native value + recipient)', () => {
  beforeEach(() => jest.clearAllMocks());

  const TO = '0x3333333333333333333333333333333333333333';
  const ONE_FINNEY = 10n ** 15n; // 0.001 ETH in wei

  function nativeTx(overrides: Record<string, unknown> = {}) {
    return { from: WALLET, to: TO, value: ONE_FINNEY, blockNumber: 100, ...overrides };
  }
  const call = () =>
    verifyEvmNativeTransfer({
      chainId: 8453, txHash: VALID_HASH, expectedFrom: WALLET, expectedTo: TO, expectedAmountWei: ONE_FINNEY,
    });

  it('accepts a native send matching sender + recipient + value', async () => {
    mockGetTransaction.mockResolvedValue(nativeTx());
    mockGetTransactionReceipt.mockResolvedValue(receipt());
    expect((await call()).ok).toBe(true);
  });

  it('rejects a recipient mismatch (value+recipient are now checked, not just sender)', async () => {
    mockGetTransaction.mockResolvedValue(nativeTx({ to: ROUTER }));
    mockGetTransactionReceipt.mockResolvedValue(receipt());
    expect(await call()).toMatchObject({ ok: false, reason: 'native_recipient_mismatch' });
  });

  it('rejects a value mismatch', async () => {
    mockGetTransaction.mockResolvedValue(nativeTx({ value: ONE_FINNEY * 2n }));
    mockGetTransactionReceipt.mockResolvedValue(receipt());
    expect(await call()).toMatchObject({ ok: false, reason: 'native_value_mismatch' });
  });

  it('rejects a sender mismatch', async () => {
    mockGetTransaction.mockResolvedValue(nativeTx({ from: ROUTER }));
    mockGetTransactionReceipt.mockResolvedValue(receipt());
    expect(await call()).toMatchObject({ ok: false, reason: 'tx_from_mismatch' });
  });

  it('rejects a reverted tx even when the tx fields match', async () => {
    mockGetTransaction.mockResolvedValue(nativeTx());
    mockGetTransactionReceipt.mockResolvedValue(receipt({ status: 0 }));
    expect(await call()).toMatchObject({ ok: false, reason: 'tx_failed' });
  });

  it('rejects a contract-creation tx (tx.to === null)', async () => {
    mockGetTransaction.mockResolvedValue(nativeTx({ to: null }));
    mockGetTransactionReceipt.mockResolvedValue(receipt());
    expect(await call()).toMatchObject({ ok: false, reason: 'tx_to_is_contract_creation' });
  });

  it('rejects when the tx is not found', async () => {
    mockGetTransaction.mockResolvedValue(null);
    mockGetTransactionReceipt.mockResolvedValue(null);
    expect(await call()).toMatchObject({ ok: false, reason: 'tx_not_found' });
  });
});

describe('verifyEvmBondPosted / verifyEvmBondRenewed (FIX C - bond event decode)', () => {
  beforeEach(() => jest.clearAllMocks());

  const POOL = '0x6150Bc5345A7845F608984c1C72ea69245B929E3'; // Base BondPool (Pass-3 cascade, live)
  const AGENT = WALLET;
  const OTHER = ROUTER;
  const bondIface = new ethers.Interface([
    'event BondPosted(address indexed agent, uint256 totalDeposit, uint256 lockedAmount, uint8 autonomyLevel)',
    'event BondRenewed(address indexed agent, uint256 newDeadline)',
    'event BondWithdrawn(address indexed agent, uint256 returnedAmount)',
  ]);
  function postedLog(agent: string, level: number, address: string = POOL) {
    const { data, topics } = bondIface.encodeEventLog('BondPosted', [agent, 1030n, 1000n, level]);
    return { address, topics, data };
  }
  function renewedLog(agent: string, address: string = POOL) {
    const { data, topics } = bondIface.encodeEventLog('BondRenewed', [agent, 1893456000n]);
    return { address, topics, data };
  }
  function withdrawnLog(agent: string, address: string = POOL) {
    const { data, topics } = bondIface.encodeEventLog('BondWithdrawn', [agent, 1000n]);
    return { address, topics, data };
  }
  const posted = (agent: string, level: 2 | 3) =>
    verifyEvmBondPosted({ chainId: 8453, txHash: VALID_HASH, bondPoolAddress: POOL, expectedAgent: agent, expectedAutonomyLevel: level });
  const renewed = (agent: string) =>
    verifyEvmBondRenewed({ chainId: 8453, txHash: VALID_HASH, bondPoolAddress: POOL, expectedAgent: agent });
  const withdrawn = (agent: string) =>
    verifyEvmBondWithdrawn({ chainId: 8453, txHash: VALID_HASH, bondPoolAddress: POOL, expectedAgent: agent });

  it('BondPosted: accepts when the event agent + level match', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt({ logs: [postedLog(AGENT, 2)] }));
    expect((await posted(AGENT, 2)).ok).toBe(true);
  });

  it('BondPosted: rejects a wrong sender (different agent in the event)', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt({ logs: [postedLog(OTHER, 2)] }));
    expect(await posted(AGENT, 2)).toMatchObject({ ok: false, reason: 'bond_agent_mismatch' });
  });

  it('BondPosted: rejects a wrong level', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt({ logs: [postedLog(AGENT, 3)] }));
    expect(await posted(AGENT, 2)).toMatchObject({ ok: false, reason: 'bond_level_mismatch' });
  });

  it('BondPosted: rejects when no BondPosted event is present (tx touched the pool but posted nothing)', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt({ logs: [renewedLog(AGENT)] }));
    expect(await posted(AGENT, 2)).toMatchObject({ ok: false, reason: 'bond_posted_event_not_found' });
  });

  it('BondPosted: ignores a BondPosted emitted by a DIFFERENT contract address', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt({ logs: [postedLog(AGENT, 2, OTHER)] }));
    expect(await posted(AGENT, 2)).toMatchObject({ ok: false, reason: 'bond_posted_event_not_found' });
  });

  it('BondPosted: rejects a reverted tx', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt({ status: 0, logs: [postedLog(AGENT, 2)] }));
    expect(await posted(AGENT, 2)).toMatchObject({ ok: false, reason: 'tx_failed' });
  });

  // WS5: lockedAmount must meet the server-required bond (postBond honors a
  // caller-supplied trustDiscountBps, so an under-collateralized bond must fail).
  function postedLogLocked(agent: string, level: number, locked: bigint) {
    const { data, topics } = bondIface.encodeEventLog('BondPosted', [agent, locked + 30n, locked, level]);
    return { address: POOL, topics, data };
  }
  it('BondPosted: accepts when lockedAmount meets the required minimum (WS5)', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt({ logs: [postedLogLocked(AGENT, 2, 1000n)] }));
    const r = await verifyEvmBondPosted({
      chainId: 8453, txHash: VALID_HASH, bondPoolAddress: POOL,
      expectedAgent: AGENT, expectedAutonomyLevel: 2, expectedMinLockedAmount: 1000n,
    });
    expect(r.ok).toBe(true);
  });
  it('BondPosted: rejects an under-collateralized bond (lockedAmount < required) (WS5)', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt({ logs: [postedLogLocked(AGENT, 2, 500n)] }));
    const r = await verifyEvmBondPosted({
      chainId: 8453, txHash: VALID_HASH, bondPoolAddress: POOL,
      expectedAgent: AGENT, expectedAutonomyLevel: 2, expectedMinLockedAmount: 1000n,
    });
    expect(r).toMatchObject({ ok: false, reason: 'bond_locked_amount_below_required' });
  });

  // #26 boundary proof: the REAL on-chain lockedAmount for getRequiredBond(2,500)
  // after the contract's deposit gross-up + floored fees is 712.5e18 + 1 wei
  // (R=712500000000000000000; td=⌈R·10000/9700⌉; locked=td−⌊0.02td⌋−⌊0.01td⌋=R+1).
  // The new atomic floor (712.5e18) ACCEPTS it; the old whole-PVT-ceil floor
  // (713e18) would REJECT the very same legitimately-collateralized bond.
  const REAL_LOCK_500BPS = 712_500_000_000_000_000_001n; // R + 1 wei (gross-up dust)
  it('BondPosted: NEW atomic floor accepts the real on-chain lock the OLD ceil floor rejected (#26)', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt({ logs: [postedLogLocked(AGENT, 2, REAL_LOCK_500BPS)] }));
    const ok = await verifyEvmBondPosted({
      chainId: 8453, txHash: VALID_HASH, bondPoolAddress: POOL,
      expectedAgent: AGENT, expectedAutonomyLevel: 2,
      expectedMinLockedAmount: 712_500_000_000_000_000_000n, // new atomic floor (= getRequiredBond(2,500))
    });
    expect(ok.ok).toBe(true);

    mockGetTransactionReceipt.mockResolvedValue(receipt({ logs: [postedLogLocked(AGENT, 2, REAL_LOCK_500BPS)] }));
    const rejected = await verifyEvmBondPosted({
      chainId: 8453, txHash: VALID_HASH, bondPoolAddress: POOL,
      expectedAgent: AGENT, expectedAutonomyLevel: 2,
      expectedMinLockedAmount: 713_000_000_000_000_000_000n, // old whole-PVT ceil floor
    });
    expect(rejected).toMatchObject({ ok: false, reason: 'bond_locked_amount_below_required' });
  });

  it('BondRenewed: accepts when the event agent matches', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt({ logs: [renewedLog(AGENT)] }));
    expect((await renewed(AGENT)).ok).toBe(true);
  });

  it('BondRenewed: rejects a wrong sender', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt({ logs: [renewedLog(OTHER)] }));
    expect(await renewed(AGENT)).toMatchObject({ ok: false, reason: 'bond_agent_mismatch' });
  });

  it('BondRenewed: rejects when no BondRenewed event is present', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt({ logs: [postedLog(AGENT, 2)] }));
    expect(await renewed(AGENT)).toMatchObject({ ok: false, reason: 'bond_renewed_event_not_found' });
  });

  // #25: the verifier must RECOVER the event's newDeadline (renewalPeriod is
  // governance-mutable on-chain), not discard it. renewedLog encodes 1893456000.
  it('BondRenewed: returns the on-chain newDeadline (unix seconds) on a match (#25)', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt({ logs: [renewedLog(AGENT)] }));
    const r = await renewed(AGENT);
    expect(r.ok).toBe(true);
    expect(r.newDeadlineSeconds).toBe(1893456000);
  });

  it('BondRenewed: does NOT surface a deadline when the sender mismatches (#25)', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt({ logs: [renewedLog(OTHER)] }));
    const r = await renewed(AGENT);
    expect(r.ok).toBe(false);
    expect(r.newDeadlineSeconds).toBeUndefined();
  });

  it('BondWithdrawn: accepts when the event agent matches', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt({ logs: [withdrawnLog(AGENT)] }));
    expect((await withdrawn(AGENT)).ok).toBe(true);
  });

  it('BondWithdrawn: rejects a wrong sender', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt({ logs: [withdrawnLog(OTHER)] }));
    expect(await withdrawn(AGENT)).toMatchObject({ ok: false, reason: 'bond_agent_mismatch' });
  });

  it('BondWithdrawn: rejects when no BondWithdrawn event is present (tx touched the pool but withdrew nothing)', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt({ logs: [renewedLog(AGENT)] }));
    expect(await withdrawn(AGENT)).toMatchObject({ ok: false, reason: 'bond_withdrawn_event_not_found' });
  });
});

// =============================================================================
// Escrow struct + funding-event helpers (Pass-2 WS3 #2/#11/#36)
// =============================================================================

const ESCROW = '0x4444444444444444444444444444444444444444';
const RECIPIENT = '0x5555555555555555555555555555555555555555';
const SELF = '0x6666666666666666666666666666666666666666'; // depositor-as-recipient (the #2 attack)

const escrowIface = new ethers.Interface([
  'event EscrowFunded(bytes32 indexed escrowId, uint256 amount)',
  'event EscrowFundedPVT(bytes32 indexed escrowId, uint256 amount, uint256 feeBurned)',
]);
const coder = ethers.AbiCoder.defaultAbiCoder();
const ID_A = '0x' + '11'.repeat(32);
const ID_B = '0x' + '22'.repeat(32);

function fundedLog(escrowId: string, amount: bigint, address: string = ESCROW) {
  const { data, topics } = escrowIface.encodeEventLog('EscrowFunded', [escrowId, amount]);
  return { address, topics, data };
}
function fundedPvtLog(escrowId: string, amount: bigint, address: string = ESCROW) {
  const { data, topics } = escrowIface.encodeEventLog('EscrowFundedPVT', [escrowId, amount, 0n]);
  return { address, topics, data };
}

// Encode the V4 escrows(bytes32) public-getter return (8 words). decodeEscrowStructPrefix
// reads words 0..5, which are byte-identical to the V3 layout.
function structReturn(opts: {
  depositor?: string;
  recipient: string;
  amount: bigint;
  autoReleaseAt?: bigint;
  status?: number;
}): string {
  return coder.encode(
    ['address', 'address', 'uint256', 'uint256', 'uint256', 'uint8', 'uint8', 'bool'],
    [
      opts.depositor ?? SELF,
      opts.recipient,
      opts.amount,
      (opts.amount * 5n) / 1000n, // fee
      opts.autoReleaseAt ?? 1_700_000_000n,
      opts.status ?? 1, // Funded
      0, // Currency.USDC
      false, // feePaidInPVT
    ],
  );
}

describe('parseEscrowFundedEvents / decodeEscrowStructPrefix (pure)', () => {
  it('parses EscrowFunded + EscrowFundedPVT amounts, ignoring logs from other contracts', () => {
    const events = parseEscrowFundedEvents(
      [
        fundedLog(ID_A, 1_000_000n),
        fundedPvtLog(ID_B, 5n * 10n ** 18n),
        fundedLog('0x' + '33'.repeat(32), 9n, ROUTER), // different contract → ignored
      ],
      ESCROW,
    );
    expect(events).toEqual([
      { escrowId: ID_A.toLowerCase(), amountAtomic: 1_000_000n },
      { escrowId: ID_B.toLowerCase(), amountAtomic: 5n * 10n ** 18n },
    ]);
  });

  it('decodes the version-agnostic struct prefix (recipient/amount/autoReleaseAt/status)', () => {
    const raw = structReturn({ recipient: RECIPIENT, amount: 1_000_000n, autoReleaseAt: 1_800_000_000n, status: 1 });
    const s = decodeEscrowStructPrefix(raw);
    expect(s).not.toBeNull();
    expect(s!.recipient).toBe(RECIPIENT.toLowerCase());
    expect(s!.amountAtomic).toBe(1_000_000n);
    expect(s!.autoReleaseAtSeconds).toBe(1_800_000_000n);
    expect(s!.status).toBe(1);
  });

  it('returns null on a too-short eth_call return (fail-closed)', () => {
    expect(decodeEscrowStructPrefix('0x' + '00'.repeat(32))).toBeNull(); // 1 word, need 6
    expect(decodeEscrowStructPrefix('0x')).toBeNull();
  });
});

describe('verifyOnchainEscrowFunding (Pass-2 WS3 #2/#11/#36)', () => {
  beforeEach(() => jest.clearAllMocks());

  const baseCall = () =>
    verifyOnchainEscrowFunding({
      chain: 'base',
      fundTxHash: VALID_HASH,
      escrowContractAddress: ESCROW,
      expectedRecipient: RECIPIENT,
      currency: 'usdc',
      expectedAmountUsdc: 1, // 1 USDC == 1_000_000 atomic
    });

  it('accepts when the on-chain struct recipient + amount match, returning id + autoReleaseAt', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt({ logs: [fundedLog(ID_A, 1_000_000n)] }));
    mockCall.mockResolvedValue(
      structReturn({ recipient: RECIPIENT, amount: 1_000_000n, autoReleaseAt: 1_750_000_000n }),
    );
    const r = await baseCall();
    expect(r.ok).toBe(true);
    expect(r.onchainEscrowId).toBe(ID_A.toLowerCase());
    expect(r.recipient).toBe(RECIPIENT.toLowerCase());
    expect(r.autoReleaseAtSeconds).toBe(1_750_000_000n);
  });

  // #2: depositor funded an escrow whose on-chain recipient is THEMSELVES.
  it('rejects when the on-chain struct pays someone other than the Firestore recipient (#2)', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt({ logs: [fundedLog(ID_A, 1_000_000n)] }));
    mockCall.mockResolvedValue(structReturn({ recipient: SELF, amount: 1_000_000n }));
    const r = await baseCall();
    expect(r).toMatchObject({ ok: false, reason: 'escrow_recipient_mismatch' });
  });

  it('rejects when no funding event matches the expected amount (#36)', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt({ logs: [fundedLog(ID_A, 999n)] }));
    const r = await baseCall();
    expect(r).toMatchObject({ ok: false, reason: 'escrow_funded_amount_mismatch' });
    expect(mockCall).not.toHaveBeenCalled(); // no struct read when amount never matches
  });

  it('rejects when the contract emitted no funding event at all', async () => {
    mockGetTransactionReceipt.mockResolvedValue(receipt({ logs: [] }));
    const r = await baseCall();
    expect(r).toMatchObject({ ok: false, reason: 'escrow_funded_event_not_found' });
  });

  // #36: a tx funding TWO escrows must resolve by amount, not position. The
  // positionally-first event (wrong amount, pays the depositor) must be skipped
  // in favor of the amount-matching one that pays the worker.
  it('selects the amount-matching funding event, not the positionally-first one (#36)', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt({
        logs: [
          fundedLog(ID_A, 500_000n), // wrong amount, first
          fundedLog(ID_B, 1_000_000n), // right amount, second
        ],
      }),
    );
    mockCall.mockImplementation((req: { data: string }) => {
      // req.data = selector(10) + 64-hex escrowId; route the struct by id.
      const idHex = req.data.slice(10);
      if (idHex === ID_B.replace(/^0x/, '')) {
        return Promise.resolve(structReturn({ recipient: RECIPIENT, amount: 1_000_000n }));
      }
      return Promise.resolve(structReturn({ recipient: SELF, amount: 500_000n }));
    });
    const r = await baseCall();
    expect(r.ok).toBe(true);
    expect(r.onchainEscrowId).toBe(ID_B.toLowerCase());
  });

  // #36: among events sharing the expected amount, pick the one whose struct
  // recipient matches — the other (same amount, pays depositor) must be skipped.
  it('among same-amount events, selects the one whose struct recipient matches (#36/#2)', async () => {
    mockGetTransactionReceipt.mockResolvedValue(
      receipt({
        logs: [
          fundedLog(ID_A, 1_000_000n), // same amount, pays depositor
          fundedLog(ID_B, 1_000_000n), // same amount, pays worker
        ],
      }),
    );
    mockCall.mockImplementation((req: { data: string }) => {
      const idHex = req.data.slice(10);
      if (idHex === ID_B.replace(/^0x/, '')) {
        return Promise.resolve(structReturn({ recipient: RECIPIENT, amount: 1_000_000n }));
      }
      return Promise.resolve(structReturn({ recipient: SELF, amount: 1_000_000n }));
    });
    const r = await baseCall();
    expect(r.ok).toBe(true);
    expect(r.onchainEscrowId).toBe(ID_B.toLowerCase());
  });

  it('fails closed (rpc_error) when the verifier receipt read cannot meet quorum', async () => {
    mockGetTransactionReceipt.mockRejectedValue(new Error('failed to meet quorum'));
    const r = await baseCall();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^rpc_error:/);
  });

  it('rejects a malformed tx hash without hitting the provider', async () => {
    const r = await verifyOnchainEscrowFunding({
      chain: 'base',
      fundTxHash: '0xnothex',
      escrowContractAddress: ESCROW,
      expectedRecipient: RECIPIENT,
      currency: 'usdc',
      expectedAmountUsdc: 1,
    });
    expect(r).toMatchObject({ ok: false, reason: 'invalid_tx_hash_format' });
    expect(mockGetTransactionReceipt).not.toHaveBeenCalled();
  });

  it('verifies a PVT-principal funding by wei amount', async () => {
    const wei = 5n * 10n ** 18n;
    mockGetTransactionReceipt.mockResolvedValue(receipt({ logs: [fundedPvtLog(ID_A, wei)] }));
    mockCall.mockResolvedValue(structReturn({ recipient: RECIPIENT, amount: wei }));
    const r = await verifyOnchainEscrowFunding({
      chain: 'base',
      fundTxHash: VALID_HASH,
      escrowContractAddress: ESCROW,
      expectedRecipient: RECIPIENT,
      currency: 'pvt',
      expectedAmountPvtWei: wei,
    });
    expect(r.ok).toBe(true);
    expect(r.onchainEscrowId).toBe(ID_A.toLowerCase());
  });
});
