/**
 * escrow-release on-chain id recovery (Pass-2 WS3 #36).
 *
 * recoverOnchainIdFromFundTx used to return the FIRST EscrowFunded event in the
 * funding tx. A tx can fund MORE THAN ONE escrow, so the positionally-first
 * event could resolve to a different escrow than the one being settled (e.g. one
 * that pays the depositor). The fix selects the EscrowFunded event whose amount
 * AND on-chain struct recipient match the settling escrow.
 *
 * recoverOnchainIdFromFundTx is module-private, so we exercise it through
 * settle(): a funded, pre-timeout legacy escrow (no persisted onchain_escrow_id)
 * runs recovery, then reads status, then returns pending_pre_timeout carrying the
 * recovered onchainId — which proves WHICH event was selected.
 */

import { ethers } from 'ethers';
import { createEscrowChainGateway } from './escrow-release';
import type { EscrowDocument } from './types';

const ESCROW = '0x4444444444444444444444444444444444444444';
const RECIPIENT = '0x5555555555555555555555555555555555555555';
const SELF = '0x6666666666666666666666666666666666666666'; // depositor-as-recipient (the attack)
const ID_A = '0x' + '11'.repeat(32);
const ID_B = '0x' + '22'.repeat(32);

const mockGetTransactionReceipt = jest.fn();
const mockCall = jest.fn();

jest.mock('../onchain/rpc-provider', () => ({
  getChainProvider: jest.fn(() => ({
    getTransactionReceipt: (...a: unknown[]) => mockGetTransactionReceipt(...a),
    call: (...a: unknown[]) => mockCall(...a),
  })),
  // tx-verifier imports this at module load; never used in this test.
  getVerifierProvider: jest.fn(() => ({})),
}));

jest.mock('./escrow', () => ({
  resolveEscrowContractAddress: () => ESCROW,
  resolveEscrowContractForDocument: () => ESCROW,
}));

const escrowIface = new ethers.Interface([
  'event EscrowFunded(bytes32 indexed escrowId, uint256 amount)',
  'event EscrowFundedPVT(bytes32 indexed escrowId, uint256 amount, uint256 feeBurned)',
]);
const coder = ethers.AbiCoder.defaultAbiCoder();

function fundedLog(escrowId: string, amount: bigint, address: string = ESCROW) {
  const { data, topics } = escrowIface.encodeEventLog('EscrowFunded', [escrowId, amount]);
  return { address, topics, data };
}
function structFor(recipient: string, amount: bigint, status = 1): string {
  return coder.encode(
    ['address', 'address', 'uint256', 'uint256', 'uint256', 'uint8', 'uint8', 'bool'],
    [SELF, recipient, amount, (amount * 5n) / 1000n, 9_999_999_999n, status, 0, false],
  );
}

function legacyEscrow(overrides: Partial<EscrowDocument> = {}): EscrowDocument {
  return {
    escrow_id: 'esc_legacy',
    depositor_wallet_id: 'wallet_dep',
    recipient_wallet_id: 'wallet_rec',
    depositor_address: SELF,
    recipient_address: RECIPIENT,
    currency: 'usdc',
    amount_usdc: 1, // -> 1_000_000 atomic
    fee_usdc: 0.005,
    net_to_recipient_usdc: 0.995,
    description: 'x',
    deliverables: 'y',
    chain: 'base',
    deadline: 0,
    auto_release_at: 9_999_999_999_999, // far future -> pre-timeout
    status: 'funded',
    fund_tx_hash: '0x' + 'a'.repeat(64),
    pe_ids: ['pe_created'],
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as unknown as EscrowDocument;
}

describe('settle() on-chain id recovery selects the matching funding event (#36)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ESCROW_RELEASE_KEY; // gas-only signer not needed for pre-timeout
  });

  it('selects the amount-matching event, not the positionally-first one', async () => {
    mockGetTransactionReceipt.mockResolvedValue({
      status: 1,
      logs: [
        fundedLog(ID_A, 500_000n), // wrong amount, FIRST
        fundedLog(ID_B, 1_000_000n), // right amount, second
      ],
    });
    mockCall.mockImplementation((req: { data: string }) => {
      const idHex = req.data.slice(10);
      if (idHex === ID_B.replace(/^0x/, '')) return Promise.resolve(structFor(RECIPIENT, 1_000_000n));
      return Promise.resolve(structFor(SELF, 500_000n));
    });

    const gw = createEscrowChainGateway();
    const result = await gw.settle(legacyEscrow());

    expect(result.status).toBe('pending_pre_timeout');
    expect(result.onchainId).toBe(ID_B.toLowerCase());
  });

  it('among same-amount events, selects the one whose struct recipient matches the escrow', async () => {
    mockGetTransactionReceipt.mockResolvedValue({
      status: 1,
      logs: [
        fundedLog(ID_A, 1_000_000n), // same amount, pays depositor (SELF)
        fundedLog(ID_B, 1_000_000n), // same amount, pays the worker (RECIPIENT)
      ],
    });
    mockCall.mockImplementation((req: { data: string }) => {
      const idHex = req.data.slice(10);
      if (idHex === ID_B.replace(/^0x/, '')) return Promise.resolve(structFor(RECIPIENT, 1_000_000n));
      return Promise.resolve(structFor(SELF, 1_000_000n));
    });

    const gw = createEscrowChainGateway();
    const result = await gw.settle(legacyEscrow());

    expect(result.status).toBe('pending_pre_timeout');
    expect(result.onchainId).toBe(ID_B.toLowerCase());
  });

  it('returns unrecoverable_id when no funding event matches amount + recipient', async () => {
    mockGetTransactionReceipt.mockResolvedValue({
      status: 1,
      logs: [fundedLog(ID_A, 1_000_000n)], // amount matches but pays the depositor, not the worker
    });
    mockCall.mockResolvedValue(structFor(SELF, 1_000_000n));

    const gw = createEscrowChainGateway();
    const result = await gw.settle(legacyEscrow());

    expect(result.status).toBe('unrecoverable_id');
  });
});
