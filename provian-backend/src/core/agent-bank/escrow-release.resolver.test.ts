/**
 * WHO resolved an escrow dispute is read from the chain: the Court's own `Verdict` in the
 * resolving transaction, emitted by the escrow contract's registered Court. Standing counts a lost
 * HIRE dispute only when the escrow admin or the timeout refund decided it; a Court decision is
 * counted by its verdict. A relay document is never the witness.
 */
import { ethers } from 'ethers';
import { createEscrowChainGateway, receiptCarriesCourtVerdict } from './escrow-release';
import type { EscrowDocument } from './types';

const ESCROW = '0x4444444444444444444444444444444444444444';
const COURT = '0x7777777777777777777777777777777777777777';
const IMPOSTOR = '0x8888888888888888888888888888888888888888';
const ID = '0x' + '11'.repeat(32);
const OTHER_ID = '0x' + '22'.repeat(32);
const TX = '0x' + 'cd'.repeat(32);

const mockCall = jest.fn();
const mockGetLogs = jest.fn();
const mockGetTransactionReceipt = jest.fn();
jest.mock('../onchain/rpc-provider', () => ({
  getChainProvider: jest.fn(() => ({
    call: (...a: unknown[]) => mockCall(...a),
    getLogs: (...a: unknown[]) => mockGetLogs(...a),
    getTransactionReceipt: (...a: unknown[]) => mockGetTransactionReceipt(...a),
  })),
  getVerifierProvider: jest.fn(() => ({})),
}));
jest.mock('./escrow', () => ({
  resolveEscrowContractAddress: () => ESCROW,
  resolveEscrowContractForDocument: () => ESCROW,
}));

const iface = new ethers.Interface([
  'event EscrowResolved(bytes32 indexed escrowId, bool releaseToRecipient)',
  'event Verdict(bytes32 indexed escrowId, bool releaseToRecipient, uint8 votesForRelease, uint8 votesForRefund)',
  'function courtContract() view returns (address)',
]);
const coder = ethers.AbiCoder.defaultAbiCoder();
const RESOLVED = 4;
const escrowStruct = coder.encode(
  ['address', 'address', 'uint256', 'uint256', 'uint256', 'uint8', 'uint8', 'bool'],
  [ESCROW, ESCROW, 1_000_000n, 5_000n, 9_999_999_999n, RESOLVED, 0, false],
);
const resolvedLog = (() => {
  const { data, topics } = iface.encodeEventLog('EscrowResolved', [ID, false]);
  return { address: ESCROW, topics, data, transactionHash: TX };
})();
const verdictLog = (address: string, id: string = ID) => {
  const { data, topics } = iface.encodeEventLog('Verdict', [id, false, 1, 2]);
  return { address, topics, data };
};

const escrow = { escrow_id: 'esc1', chain: 'base', currency: 'usdc', status: 'disputed', onchain_escrow_id: ID, fund_block_number: 1 } as unknown as EscrowDocument;

function chain(opts: { court?: string; receiptLogs?: unknown[] | null; courtReadFails?: boolean }): void {
  const courtSelector = iface.getFunction('courtContract')!.selector;
  mockCall.mockImplementation((req: { data: string }) => {
    if (req.data.startsWith(courtSelector)) {
      if (opts.courtReadFails) return Promise.reject(new Error('rpc down'));
      return Promise.resolve(coder.encode(['address'], [opts.court ?? COURT]));
    }
    return Promise.resolve(escrowStruct);
  });
  mockGetLogs.mockResolvedValue([resolvedLog]);
  mockGetTransactionReceipt.mockResolvedValue(opts.receiptLogs === null ? null : { status: 1, logs: opts.receiptLogs ?? [resolvedLog] });
}

describe('settleDispute observe path — who resolved it', () => {
  beforeEach(() => { jest.clearAllMocks(); delete process.env.ESCROW_RELEASE_KEY; });

  it('admin or timeout (no Court verdict in the transaction) → resolvedByCourt false', async () => {
    chain({});
    expect(await createEscrowChainGateway().settleDispute(escrow, false)).toMatchObject({
      status: 'already_resolved', txHash: TX, resolvedReleaseToRecipient: false, resolvedByCourt: false,
    });
  });

  it("the Court's Verdict rides the resolving transaction → resolvedByCourt true", async () => {
    chain({ receiptLogs: [verdictLog(COURT), resolvedLog] });
    expect(await createEscrowChainGateway().settleDispute(escrow, false)).toMatchObject({ status: 'already_resolved', resolvedByCourt: true });
  });

  it('a look-alike Verdict from another contract, or for another escrow, is not the Court deciding this one', async () => {
    chain({ receiptLogs: [verdictLog(IMPOSTOR), verdictLog(COURT, OTHER_ID), resolvedLog] });
    expect(await createEscrowChainGateway().settleDispute(escrow, false)).toMatchObject({ resolvedByCourt: false });
  });

  it('no Court registered on the escrow contract → never "by Court"', async () => {
    chain({ court: ethers.ZeroAddress, receiptLogs: [verdictLog(ethers.ZeroAddress), resolvedLog] });
    expect(await createEscrowChainGateway().settleDispute(escrow, false)).toMatchObject({ resolvedByCourt: false });
  });

  it('an unreadable resolver fails closed — nothing is recorded on a guess', async () => {
    chain({ receiptLogs: null });
    expect(await createEscrowChainGateway().settleDispute(escrow, false)).toMatchObject({ status: 'failed', reason: 'resolved_resolver_unrecoverable' });
    chain({ courtReadFails: true });
    expect(await createEscrowChainGateway().settleDispute(escrow, false)).toMatchObject({ status: 'failed', reason: 'resolved_resolver_unrecoverable' });
  });

  it('pure rule', () => {
    expect(receiptCarriesCourtVerdict([verdictLog(COURT)], COURT, ID)).toBe(true);
    expect(receiptCarriesCourtVerdict([verdictLog(COURT)], COURT.toUpperCase().replace('0X', '0x'), ID)).toBe(true);
    expect(receiptCarriesCourtVerdict([resolvedLog], COURT, ID)).toBe(false);
    expect(receiptCarriesCourtVerdict([verdictLog(COURT)], 'not-an-address', ID)).toBe(false);
  });
});
