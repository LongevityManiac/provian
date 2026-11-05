import { chainAddressesToStore, validateReportedChainAddresses } from './chain-addresses';

// A real derived pair: EVM address + a real base58 Solana address.
const EVM = '0x21be870c4ba85746267678a5538be9b1d2540625';
const SOL = '7EqQdEULxWcraVx3mXe9vc6XQh5cPz8drDPzY3zjJa7e'; // valid base58, 43 chars

describe('validateReportedChainAddresses', () => {
  it('accepts a valid solana + no evm, pins the canonical evm (lowercased)', () => {
    const out = validateReportedChainAddresses({ solana: SOL }, EVM);
    expect(out).toEqual({ evm: EVM.toLowerCase(), solana: SOL });
  });

  it('accepts a matching evm echo (case-insensitive) and pins the canonical evm', () => {
    const out = validateReportedChainAddresses({ evm: EVM.toUpperCase(), solana: SOL }, EVM);
    expect(out).toEqual({ evm: EVM.toLowerCase(), solana: SOL });
  });

  // RED NEGATIVE CONTROLS — each must return null (a wrong value must NOT store).
  it('RED: refuses a mismatched evm echo (never stores a client-asserted evm)', () => {
    const wrongEvm = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    expect(validateReportedChainAddresses({ evm: wrongEvm, solana: SOL }, EVM)).toBeNull();
  });

  it('RED: refuses a malformed solana (contains base58-illegal chars 0/O/I/l)', () => {
    expect(validateReportedChainAddresses({ solana: '0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl' }, EVM)).toBeNull();
  });

  it('RED: refuses a solana that is too short / too long to be a 32-byte pubkey', () => {
    expect(validateReportedChainAddresses({ solana: 'abc' }, EVM)).toBeNull();
    expect(validateReportedChainAddresses({ solana: SOL + SOL }, EVM)).toBeNull();
  });

  it('RED: returns null when there is nothing to store (absent / non-object / no solana)', () => {
    expect(validateReportedChainAddresses(null, EVM)).toBeNull();
    expect(validateReportedChainAddresses(undefined, EVM)).toBeNull();
    expect(validateReportedChainAddresses({}, EVM)).toBeNull();
    expect(validateReportedChainAddresses({ evm: EVM }, EVM)).toBeNull();
    expect(validateReportedChainAddresses({ solana: 12345 as unknown as string }, EVM)).toBeNull();
  });
});

/**
 *. After a key rotation the stored `evm` is the BIRTH address the rotation-lineage check
 * reads. RED CONTROL RECORD (pre-fix route): the route stored the validated bundle, i.e. the
 * CURRENT address — the overwrite that made Atlas's beneficiary link unverifiable.
 */
describe('chainAddressesToStore', () => {
  const BIRTH = `0x${'b'.repeat(40)}`;
  const CURRENT = `0x${'c'.repeat(40)}`;
  const SOL = '4Jxy9nbNxjsNnwrEyGePnXkVrGJWmPQKeLccL3zuR2K2';
  const validated = { evm: CURRENT, solana: SOL };

  it('an unrotated wallet stores the validated bundle (current IS birth)', () => {
    expect(chainAddressesToStore(validated, { evm: CURRENT, solana: 'old' }, 0)).toEqual(validated);
  });

  it('a rotated wallet keeps its stored birth evm and refreshes only solana', () => {
    const next = chainAddressesToStore(validated, { evm: BIRTH, solana: 'old' }, 2);
    expect(next).toEqual({ evm: BIRTH, solana: SOL });
    expect(next.evm).not.toBe(CURRENT); // RED: the pre-fix route wrote CURRENT here
  });

  it('a rotated wallet with no stored evm never gains the current address as its birth', () => {
    expect(chainAddressesToStore(validated, null, 1)).toEqual({ solana: SOL });
    expect(chainAddressesToStore(validated, { solana: 'old' }, 1)).toEqual({ solana: SOL });
  });
});
