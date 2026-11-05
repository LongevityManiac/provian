/**
 * an escrow the migration left on the predecessor EscrowV4 is serviced there: its document
 * pins `escrow_contract_address`, and every read / settle / keeper path resolves through
 * `resolveEscrowContractForDocument`. Only the configured escrow or the recorded predecessor is
 * honored; each RED case below admits if its guard is removed.
 */
import { resolveEscrowContractForDocument } from './escrow';
import { PREDECESSOR_ESCROW_V4_BASE } from './pvt-principal-config';
import deployment from '../../../../contracts/deployments/base-pvt9-institutions.json';

const SUCCESSOR_ESCROW = deployment.contracts.escrowV4.address;

describe(' resolveEscrowContractForDocument', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.ENABLE_PVT_PRINCIPAL = 'true';
    process.env.ESCROW_CONTRACT_ADDRESS_BASE = SUCCESSOR_ESCROW;
  });
  afterAll(() => { process.env = saved; });

  const doc = (over: Record<string, unknown> = {}) => ({
    escrow_id: 'esc_1', currency: 'usdc' as const, chain: 'base', ...over,
  });

  it('binds the predecessor constant to the deployment record', () => {
    expect(PREDECESSOR_ESCROW_V4_BASE.toLowerCase()).toBe(deployment.predecessor.contracts.escrowV4.toLowerCase());
    expect(PREDECESSOR_ESCROW_V4_BASE.toLowerCase()).not.toBe(SUCCESSOR_ESCROW.toLowerCase());
  });

  it('an unpinned escrow resolves to the configured (successor) escrow, USDC and PVT', () => {
    expect(resolveEscrowContractForDocument(doc())).toBe(SUCCESSOR_ESCROW);
    expect(resolveEscrowContractForDocument(doc({ currency: 'pvt' })).toLowerCase()).toBe(SUCCESSOR_ESCROW.toLowerCase());
  });

  it('an escrow pinned to the predecessor resolves there (case-insensitive)', () => {
    expect(resolveEscrowContractForDocument(doc({ escrow_contract_address: PREDECESSOR_ESCROW_V4_BASE.toLowerCase() })))
      .toBe(PREDECESSOR_ESCROW_V4_BASE);
  });

  it('a pin equal to the configured escrow resolves to it', () => {
    expect(resolveEscrowContractForDocument(doc({ escrow_contract_address: SUCCESSOR_ESCROW.toUpperCase().replace('0X', '0x') })))
      .toBe(SUCCESSOR_ESCROW);
  });

  it('RED: a pin to any other address refuses — a document can never steer a release', () => {
    expect(() => resolveEscrowContractForDocument(doc({ escrow_contract_address: '0x000000000000000000000000000000000000dEaD' })))
      .toThrow(/pinned to an unrecognized escrow contract/);
  });

  it('RED: the predecessor pin is honored on Base only', () => {
    process.env.ESCROW_CONTRACT_ADDRESS_ARBITRUM = '0x73934580ecFD8Bf1F689f73205A2E681fEAa54AF';
    expect(() => resolveEscrowContractForDocument(doc({ chain: 'arbitrum', escrow_contract_address: PREDECESSOR_ESCROW_V4_BASE })))
      .toThrow(/pinned to an unrecognized escrow contract/);
  });

  it('RED: a non-string pin refuses (Unknown = Block)', () => {
    expect(() => resolveEscrowContractForDocument(doc({ escrow_contract_address: null as unknown as string })))
      .toThrow(/pinned to an unrecognized escrow contract/);
  });
});
